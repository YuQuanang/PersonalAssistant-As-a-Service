import express from "express";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { exec } from "node:child_process";
import { PORT } from "./config.js";
import { runAgent } from "./agent.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// ── Chat UI (static) ──────────────────────────────────────────────────────────
app.use(express.static(join(__dirname, "../public")));

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

  try {
    const { response, tools_used, errors } = await runAgent(
      message.trim(),
      session_id
    );

    const payload = {
      response,
      session_id: session_id ?? null,
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
        hint:  "Make sure Ollama is running: ollama serve",
      });
    }

    console.error("[orchestrator] Unexpected error:", err);
    return res.status(500).json({ error: "An unexpected internal error occurred." });
  }
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
    else      console.log("[orchestrator] Ollama launch command sent.");
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
