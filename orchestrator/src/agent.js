import axios from "axios";
import { OLLAMA } from "./config.js";
import { TOOL_DEFINITIONS, dispatchTool } from "./tools.js";

const OLLAMA_CHAT_URL = `${OLLAMA.baseUrl}/api/chat`;

// Guard against runaway tool-call loops.
const MAX_TOOL_ITERATIONS = 10;

// Today's date injected once so the model always has accurate temporal context.
const TODAY = new Date().toISOString().slice(0, 10);

const SYSTEM_PROMPT = `\
You are a smart, concise personal assistant. Today's date is ${TODAY}.

You have access to three services via tools:
  • Calendar Service — check free slots and book meetings
  • Task Service     — list pending tasks and create new ones
  • Email Service    — list unread emails and summarize specific ones

STRICT RULES:
1. ALWAYS use tools to fetch real data before answering. Never invent dates, task names, email subjects, or time slots.
2. For compound questions (e.g. "show my tasks AND check tomorrow's availability"), call all relevant tools.
3. When booking a meeting, call check_calendar_availability first; only book a slot that appears in the response.
4. If a tool returns an error, tell the user in plain English what you could not retrieve, then share any data you did get.
5. Never expose raw JSON, HTTP status codes, or internal identifiers to the user. Translate everything into friendly prose.
6. Keep answers focused and concise — use bullet points for lists.`;

/**
 * Run the Ollama agent loop for a single user turn.
 *
 * @param {string} userMessage
 * @param {string} [sessionId]
 * @returns {Promise<{
 *   response:   string,
 *   tools_used: string[],
 *   errors:     Array<{ service: string, reason: string }>
 * }>}
 */
export async function runAgent(userMessage, sessionId) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user",   content: userMessage },
  ];

  const toolsUsed = [];
  const errors    = [];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    // ── Call Ollama ──────────────────────────────────────────────────────────
    let ollamaData;
    try {
      const { data } = await axios.post(
        OLLAMA_CHAT_URL,
        { model: OLLAMA.model, messages, tools: TOOL_DEFINITIONS, stream: false },
        { timeout: OLLAMA.timeout }
      );
      ollamaData = data;
    } catch (err) {
      const reason =
        err.code === "ECONNREFUSED"
          ? "Ollama is not running. Start it with: ollama serve"
          : (err.message ?? "Unknown LLM error");
      throw new Error(`LLM unavailable: ${reason}`);
    }

    const assistantMessage = ollamaData.message;

    // Append the assistant turn (may contain tool_calls) to history so Ollama
    // has full context on the next iteration.
    messages.push(assistantMessage);

    const toolCalls = assistantMessage.tool_calls;

    // No tool calls → the model produced its final prose response.
    if (!toolCalls || toolCalls.length === 0) {
      return {
        response:   assistantMessage.content?.trim() ?? "(No response generated)",
        tools_used: toolsUsed,
        errors,
      };
    }

    // ── Execute tool calls concurrently ─────────────────────────────────────
    const results = await Promise.all(
      toolCalls.map(async (tc) => {
        const name = tc.function.name;

        // Ollama returns arguments as either an object or a JSON string.
        const args =
          typeof tc.function.arguments === "string"
            ? safeParseJSON(tc.function.arguments)
            : (tc.function.arguments ?? {});

        toolsUsed.push(name);

        const result = await dispatchTool(name, args);

        if (!result.success && result.error) {
          const duplicate = errors.some(
            (e) => e.service === result.error.service && e.reason === result.error.reason
          );
          if (!duplicate) errors.push(result.error);
        }

        return { name, result };
      })
    );

    // ── Feed results back as tool-role messages ──────────────────────────────
    for (const { result } of results) {
      messages.push({
        role:    "tool",
        content: JSON.stringify(
          result.success
            ? result.data
            : { error: result.error?.reason ?? "Tool execution failed." }
        ),
      });
    }

    // Loop — Ollama will process tool results and either call more tools or
    // produce a final answer.
  }

  // Safety fallback if MAX_TOOL_ITERATIONS is somehow exhausted.
  return {
    response:
      "I reached my processing limit while handling your request. Please try a more specific question.",
    tools_used: toolsUsed,
    errors,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function safeParseJSON(str) {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}
