import express from "express";
import cookieParser from "cookie-parser";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { exec } from "node:child_process";
import { PORT } from "./config.js";
import { runAgent, endSession } from "./agent.js";
import {
  getAuthUrl,
  exchangeCodeForTokens,
  getGoogleProfile,
  parseAuthState,
} from "./auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function buildAuthCookieOptions(req) {
  const isProd = process.env.NODE_ENV === "production";
  const forwardedProto = req.headers["x-forwarded-proto"];
  const isHttps = req.secure || forwardedProto === "https";

  return {
    httpOnly: true,
    secure: isProd ? isHttps : false,
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  };
}

const app = express();
app.use(express.json());
app.use(cookieParser());

// ── Chat UI (static) ──────────────────────────────────────────────────────────
app.use(express.static(join(__dirname, "../public")));

// ── Authentication ────────────────────────────────────────────────────────────

// Redirects the user to Google's consent screen
app.get("/api/auth/google", (req, res) => {
  const selectAccount = req.query.select_account === "1";
  const returnTo =
    typeof req.query.return_to === "string" && req.query.return_to.startsWith("/")
      ? req.query.return_to
      : "/";
  const url = getAuthUrl({ selectAccount, returnTo });
  res.redirect(url);
});

// Shortcut route to always force account chooser
app.get("/api/auth/google/switch", (req, res) => {
  const returnTo =
    typeof req.query.return_to === "string" && req.query.return_to.startsWith("/")
      ? req.query.return_to
      : "/";
  const url = getAuthUrl({ selectAccount: true, returnTo });
  res.redirect(url);
});

// Check if the user has authenticated
app.get("/api/auth/status", (req, res) => {
  res.set("Cache-Control", "no-store");
  const hasToken = !!req.cookies.google_auth_tokens;
  res.json({ authenticated: hasToken });
});

// Returns current signed-in account profile
app.get("/api/auth/profile", async (req, res) => {
  res.set("Cache-Control", "no-store");
  let credentials;
  try {
    if (req.cookies.google_auth_tokens) {
      credentials = JSON.parse(req.cookies.google_auth_tokens);
    }
  } catch {
    return res.status(200).json({ authenticated: false });
  }

  if (!credentials) {
    return res.status(200).json({ authenticated: false });
  }

  try {
    const profile = await getGoogleProfile(credentials);
    return res.status(200).json({ authenticated: true, ...profile });
  } catch (err) {
    console.error("[auth] Profile error:", err.message);
    return res.status(200).json({
      authenticated: true,
      email: null,
      name: null,
      picture: null,
    });
  }
});

// Clear signed-in account from cookie
app.post("/api/auth/logout", (req, res) => {
  const cookieOptions = buildAuthCookieOptions(req);
  res.clearCookie("google_auth_tokens", {
    httpOnly: cookieOptions.httpOnly,
    secure: cookieOptions.secure,
    sameSite: cookieOptions.sameSite,
    path: cookieOptions.path,
  });
  res.status(200).json({ success: true });
});

// Handles the callback from Google after the user grants consent
app.get("/api/auth/google/callback", async (req, res) => {
  const code = req.query.code;
  const { returnTo } = parseAuthState(req.query.state);
  if (!code) {
    return res.status(400).send("No code provided.");
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    const cookieOptions = buildAuthCookieOptions(req);
    
    // Store the tokens securely in a server-only cookie
    res.cookie("google_auth_tokens", JSON.stringify(tokens), cookieOptions);

    res.redirect(returnTo);
  } catch (err) {
    console.error("[auth] Callback error:", err.message);
    res.status(500).send("Authentication failed.");
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({ service: "orchestrator", status: "ok" })
);

// ── POST /api/chat ─────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { message, session_id } = req.body ?? {};

  if (!message || typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({ error: "Missing required field: message." });
  }

  // Get tokens from cookie
  let credentials;
  try {
    if (req.cookies.google_auth_tokens) {
      credentials = JSON.parse(req.cookies.google_auth_tokens);
    }
  } catch (e) {
    console.error("Failed to parse auth cookies");
  }

  try {
    const { session_id: resolvedSessionId, response, tools_used, errors } = await runAgent(
      message.trim(),
      credentials,
      session_id
    );

    const payload = {
      response,
      session_id: resolvedSessionId,
      tools_used,
      suggestions: generateSuggestions(tools_used),
    };

    // Include errors array only when there are actual failures, per the API contract.
    if (errors.length > 0) {
      payload.errors = errors;
    }

    return res.status(200).json(payload);
  } catch (err) {
    // Ollama itself is unreachable.
    if (err.message?.startsWith("LLM unavailable")) {
      return res.status(503).json({
        error: err.message,
        hint: "Make sure Ollama is running: ollama serve",
      });
    }

    console.error("[orchestrator] Unexpected error:", err);
    return res.status(500).json({ error: "An unexpected internal error occurred." });
  }
});

// ── POST /api/chat/session/end ───────────────────────────────────────────────
// Clears one in-memory chat session so old context does not consume memory.
app.post("/api/chat/session/end", (req, res) => {
  const { session_id } = req.body ?? {};
  const cleared = endSession(session_id);
  return res.status(200).json({ cleared });
});

// ── GET /api/ollama-status ────────────────────────────────────────────────────
// Returns { ready: true } when Ollama is reachable, { ready: false } otherwise.
app.get("/api/ollama-status", async (_req, res) => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const r = await fetch("http://localhost:11434/api/tags", { signal: controller.signal });
    clearTimeout(timer);
    return res.json({ ready: r.ok });
  } catch {
    return res.json({ ready: false });
  }
});

// ── POST /api/start-ollama ────────────────────────────────────────────────────
// Launches the Ollama macOS app.
// Strategy:
//  1. Kill any stale/zombie Ollama processes (leftover from a previous hard kill).
//     Without this, the new app instance detects a stale socket and silently exits.
//  2. Remove the stale Unix socket Ollama uses for IPC (if present).
//  3. Open the app and, if that fails, fall back to `ollama serve` directly.
app.post("/api/start-ollama", (req, res) => {
  // Respond immediately — the client polls /api/ollama-status separately.
  res.json({ message: "Ollama launch requested." });

  const cleanup =
    "pkill -f '/Applications/Ollama.app' 2>/dev/null; " +
    "rm -f /tmp/ollama*.sock /tmp/.ollama.lock 2>/dev/null; " +
    "sleep 0.5";

  const launch =
    "open /Applications/Ollama.app || " +
    "(/Applications/Ollama.app/Contents/Resources/ollama serve &>/dev/null &)";

  exec(`${cleanup} && ${launch}`, (err) => {
    if (err) console.error("[orchestrator] start-ollama exec error:", err.message);
    else console.log("[orchestrator] Ollama launch command sent.");
  });
});

// ── POST /api/shutdown ────────────────────────────────────────────────────────
// Stops Ollama (works for both manual `ollama serve` and the macOS menu bar app)
// then exits the orchestrator process, which signals concurrently to stop the
// other three services.
app.post("/api/shutdown", (_req, res) => {
  res.json({ message: "Shutting down…" });
  console.log("[orchestrator] Shutdown requested — stopping Ollama and all services.");
  // Two Ollama processes run on macOS:
  //  1. The menu bar GUI app:  /Applications/Ollama.app/Contents/MacOS/Ollama
  //  2. The backend server:    .../Resources/ollama serve
  // We kill both by matching the app bundle path, then fall back to pkill.
  exec(
    "pkill -f '/Applications/Ollama.app' 2>/dev/null; osascript -e 'quit app \"Ollama\"' 2>/dev/null; true",
    () => {
      // Give the HTTP response a moment to flush before exiting.
      setTimeout(() => process.exit(0), 300);
    });
});

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Route not found." }));

// ── Suggestion generator ──────────────────────────────────────────────────────
// Returns context-aware follow-up prompts based on which tools were called.
function generateSuggestions(toolsUsed = []) {
  const used = new Set(toolsUsed);
  const suggestions = new Set();

  if (used.has("get_tasks")) {
    suggestions.add("Create a new task");
    suggestions.add("Show my completed tasks");
    suggestions.add("Do I have free time today?");
  }
  if (used.has("create_task")) {
    suggestions.add("Show all my pending tasks");
    suggestions.add("Check my calendar availability today");
  }
  if (used.has("check_calendar_availability")) {
    suggestions.add("Book a meeting in one of those slots");
    suggestions.add("What are my pending tasks?");
    suggestions.add("Show my unread emails");
  }
  if (used.has("book_meeting")) {
    suggestions.add("Check availability for another day");
    suggestions.add("Show my pending tasks");
  }
  if (used.has("get_emails")) {
    suggestions.add("Summarise the first email");
    suggestions.add("What are my pending tasks?");
    suggestions.add("Do I have any free time today?");
  }
  if (used.has("summarize_email")) {
    suggestions.add("Create a task from this email");
    suggestions.add("Show my other unread emails");
    suggestions.add("Check my calendar availability");
  }

  // Fallback when no tools were used (e.g. small talk / greeting)
  if (suggestions.size === 0) {
    suggestions.add("What are my pending tasks?");
    suggestions.add("Do I have free time today?");
    suggestions.add("Show my unread emails");
  }

  return [...suggestions].slice(0, 3);
}

app.listen(PORT, () => {
  console.log(`[orchestrator] Running on http://localhost:${PORT}`);
  console.log(`[orchestrator] Chat UI        → http://localhost:${PORT}`);
  console.log(`[orchestrator] Chat endpoint  → POST http://localhost:${PORT}/api/chat`);
  console.log(`[orchestrator] LLM backend    → Ollama (${process.env.OLLAMA_MODEL ?? "llama3.1"})`);
});
