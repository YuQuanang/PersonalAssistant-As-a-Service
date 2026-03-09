import dotenv from "dotenv";
dotenv.config();

export const PORT = parseInt(process.env.PORT ?? "3000", 10);

// Per-request timeout (ms) for calls to the downstream microservices.
export const SERVICE_TIMEOUT_MS = parseInt(
  process.env.SERVICE_TIMEOUT_MS ?? "5000",
  10
);

export const SERVICES = {
  calendar: process.env.CALENDAR_SERVICE_URL ?? "http://localhost:3001",
  task:     process.env.TASK_SERVICE_URL     ?? "http://localhost:3002",
  email:    process.env.EMAIL_SERVICE_URL    ?? "http://localhost:3003",
};

export const OLLAMA = {
  baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  // llama3.1 and llama3.2 both support tool calling.
  // Switch to any other Ollama model that supports tools via OLLAMA_MODEL env var.
  model:   process.env.OLLAMA_MODEL    ?? "llama3.1",
  // Generous timeout — local LLM inference can be slow on CPU.
  timeout: parseInt(process.env.OLLAMA_TIMEOUT_MS ?? "120000", 10),
};
