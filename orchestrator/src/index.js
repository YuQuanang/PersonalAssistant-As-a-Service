import express from "express";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
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
