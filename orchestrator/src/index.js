import express from "express";
import { PORT } from "./config.js";
import { runAgent } from "./agent.js";

const app = express();
app.use(express.json());

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

app.listen(PORT, () => {
  console.log(`[orchestrator] Running on http://localhost:${PORT}`);
  console.log(`[orchestrator] Chat endpoint → POST http://localhost:${PORT}/api/chat`);
  console.log(`[orchestrator] LLM backend   → Ollama (${process.env.OLLAMA_MODEL ?? "llama3.1"})`);
});
