import axios from "axios";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OLLAMA } from "./config.js";
import { TOOL_DEFINITIONS, dispatchTool } from "./tools.js";

const OLLAMA_CHAT_URL = `${OLLAMA.baseUrl}/api/chat`;

// Guard against runaway tool-call loops.
const MAX_TOOL_ITERATIONS = 10;

// Keep only the latest 20 user-assistant interactions per active session.
const MAX_SESSION_INTERACTIONS = 20;
const MAX_SESSION_MESSAGES = MAX_SESSION_INTERACTIONS * 2;

// Expire inactive sessions after 30 minutes to free memory.
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS ?? "1800000", 10);
const sessionStore = new Map();

const LLM_TOOL_DEFINITIONS = TOOL_DEFINITIONS;
const VALID_LLM_TOOL_NAMES = new Set(LLM_TOOL_DEFINITIONS.map((t) => t.function.name));

const CALENDAR_TIMEZONE_LABEL = "GMT+8";
const CALENDAR_OFFSET_MINUTES = 8 * 60;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PROMPT = fs.readFileSync(path.join(__dirname, "prompt.md"), "utf8");


/**
 * Run the Ollama agent loop for a single user turn.
 *
 * @param {string} userMessage
 * @param {object} credentials   Google OAuth token object
 * @param {string} [sessionId]
 * @returns {Promise<{
 *   session_id: string,
 *   response:   string,
 *   tools_used: string[],
 *   errors:     Array<{ service: string, reason: string }>,
 *   suggestions?: string[]
 * }>}
 */
export async function runAgent(userMessage, credentials, sessionId) {
  cleanupExpiredSessions();

  const resolvedSessionId =
    typeof sessionId === "string" && sessionId.trim() !== ""
      ? sessionId.trim()
      : randomUUID();

  const sessionHistory = getSessionMessages(resolvedSessionId);

  const systemPrompt = TEMPLATE_PROMPT
    .replace("{{TODAY}}", getCurrentDateInCalendarOffset())
    .replace("{{CURRENT_TIME}}", getCurrentTimeInCalendarOffset())
    .replace(/\{\{CALENDAR_TIMEZONE_LABEL\}\}/g, CALENDAR_TIMEZONE_LABEL);

  const messages = [
    { role: "system", content: systemPrompt },
    ...sessionHistory, // previous interactions
    { role: "user", content: userMessage },
  ];

  const toolsUsed = [];
  const errors = [];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    // ── Call Ollama ──────────────────────────────────────────────────────────
    let ollamaData;
    try {
      const { data } = await axios.post(
        OLLAMA_CHAT_URL,
        {
          model: OLLAMA.model,
          messages,
          tools: LLM_TOOL_DEFINITIONS,
          stream: false,
          options: {
            temperature: 0.1
          }
        },
        {
          timeout: OLLAMA.timeout
        }
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
    const toolCalls = assistantMessage.tool_calls;

    // Log LLM response
    console.log("[llm] raw response:", JSON.stringify(assistantMessage, null, 2));
    if (toolCalls && toolCalls.length > 0) {
      const names = toolCalls.map((tc) => tc.function.name).join(", ");
      console.log(`[llm] iteration=${iteration} → tool_calls: [${names}]`);
    } else {
      console.log(`[llm] iteration=${iteration} → final text response`);
    }

    // Append the assistant turn (may contain tool_calls) to history so Ollama
    // has full context on the next iteration.
    messages.push(assistantMessage);

    if (!toolCalls || toolCalls.length === 0) {
      const assistantResponseRaw = assistantMessage.content?.trim() ?? "(No response generated)";
      const assistantResponse = assistantResponseRaw;

      const plannedCall = extractPlannedToolCall(assistantResponse);
      if (plannedCall && VALID_LLM_TOOL_NAMES.has(plannedCall.name)) {
        const resolvedArgs = await resolveToolArgs(
          plannedCall.name,
          plannedCall.args,
          credentials,
          toolsUsed,
          errors,
          userMessage
        );
        if (!resolvedArgs) {
          messages.push({
            role: "system",
            content:
              "The previous planned tool call had invalid arguments. If summarizing email, call get_emails first and use a real message id from that result.",
          });
          continue;
        }

        toolsUsed.push(plannedCall.name);
        const result = await dispatchTool(plannedCall.name, resolvedArgs, credentials);

        if (!result.success && result.error) {
          const duplicate = errors.some(
            (e) => e.service === result.error.service && e.reason === result.error.reason
          );
          if (!duplicate) errors.push(result.error);
        }

        messages.push({
          role: "tool",
          content: JSON.stringify(
            result.success
              ? result.data
              : { error: result.error?.reason ?? "Tool execution failed." }
          ),
        });
        continue;
      }

      // Some models occasionally return a textual "I'll call X" plan instead of
      // proper tool_calls. Nudge once and continue the same turn.
      if (looksLikeToolPlanningText(assistantResponse)) {
        messages.push({
          role: "system",
          content:
            "Your previous reply described a tool plan as text. Do not output planned calls as text. Emit structured tool_calls now, or provide the final user answer if no tool is required.",
        });
        continue;
      }

      saveSessionMessages(resolvedSessionId, [
        ...sessionHistory,
        { role: "user", content: userMessage },
        { role: "assistant", content: assistantResponse },
      ]);

      return {
        session_id: resolvedSessionId,
        response: assistantResponse,
        tools_used: toolsUsed,
        errors,
        suggestions: [],
      };
    }

    // ── Execute tool calls concurrently ─────────────────────────────────────
    const results = await Promise.all(
      toolCalls.map(async (tc) => {
        const name = tc.function.name;

        if (!VALID_LLM_TOOL_NAMES.has(name)) {
          return {
            name,
            result: {
              success: false,
              data: null,
              error: {
                service: resolveServiceName(name),
                reason: `Tool '${name}' is not available in direct chat mode.`,
              },
            },
          };
        }

        // Ollama returns arguments as either an object or a JSON string.
        const args =
          typeof tc.function.arguments === "string"
            ? safeParseJSON(tc.function.arguments)
            : (tc.function.arguments ?? {});

        const resolvedArgs = await resolveToolArgs(
          name,
          args,
          credentials,
          toolsUsed,
          errors,
          userMessage
        );
        if (!resolvedArgs) {
          return {
            name,
            result: {
              success: false,
              data: null,
              error: {
                service: resolveServiceName(name),
                reason: "Missing or invalid tool arguments.",
              },
            },
          };
        }

        toolsUsed.push(name);

        const result = await dispatchTool(name, resolvedArgs, credentials);

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
        role: "tool",
        content: JSON.stringify(
          result.success
            ? result.data
            : { error: result.error?.reason ?? "Tool execution failed." }
        ),
      });
    }
    // END OF MAX_ITERATION LOOP
  }

  // Safety fallback if MAX_TOOL_ITERATIONS is somehow exhausted.
  const fallbackResponse =
    "I reached my processing limit while handling your request. Please try a more specific question.";

  saveSessionMessages(resolvedSessionId, [
    ...sessionHistory,
    { role: "user", content: userMessage },
    { role: "assistant", content: fallbackResponse },
  ]);

  return {
    session_id: resolvedSessionId,
    response: fallbackResponse,
    tools_used: toolsUsed,
    errors,
    suggestions: [],
  };
}

export function endSession(sessionId) {
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    return false;
  }
  const safeSessionId = sessionId.trim();
  return sessionStore.delete(safeSessionId);
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function safeParseJSON(str) {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

function looksLikeToolPlanningText(text) {
  if (!text) return false;
  const lower = text.toLowerCase();

  // Heuristics for pseudo function-call output patterns.
  return (
    lower.includes("function call") ||
    lower.includes("i'll call") ||
    lower.includes("i will call") ||
    lower.includes("to answer your question, i need to") ||
    (lower.includes("\"name\"") && lower.includes("\"parameters\""))
  );
}

function extractPlannedToolCall(text) {
  if (!text) return null;

  // Handle the common format:
  // {"name": "tool_name", "parameters": {...}}
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  const parsed = safeParseJSON(jsonMatch[0]);
  if (!parsed || typeof parsed !== "object") return null;

  const name = typeof parsed.name === "string" ? parsed.name : null;
  if (!name) return null;

  const rawParams = parsed.parameters;
  const args =
    rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)
      ? rawParams
      : {};

  return { name, args };
}

async function resolveToolArgs(name, args, credentials, toolsUsed, errors, userMessage = "") {
  const safeArgs = args && typeof args === "object" ? args : {};

  if (name === "list_calendar_events") {
    const rawStart = typeof safeArgs.start_date === "string" ? safeArgs.start_date.trim().toLowerCase() : "";
    const rawEnd   = typeof safeArgs.end_date   === "string" ? safeArgs.end_date.trim().toLowerCase()   : "";

    // Special-case: "next week" → full Mon–Sun range, regardless of what the LLM set for end_date.
    if (rawStart === "next week" || rawEnd === "next week") {
      const { start, end } = getNextWeekRange();
      return { start_date: start, end_date: end };
    }

    const start_date = rawStart !== "" ? normalizeDate(rawStart) : getCurrentDateInCalendarOffset();
    const end_date   = rawEnd   !== "" ? normalizeDate(rawEnd)   : "";
    return start_date ? { start_date, end_date } : null;
  }

  if (name === "create_calendar_event") {
    const title = typeof safeArgs.title === "string" ? safeArgs.title.trim() : "";
    const date = normalizeDate(safeArgs.date);
    const start = normalizeTime(safeArgs.start);
    const end = normalizeTime(safeArgs.end);
    if (!title || !date || !start || !end) return null;

    const description =
      typeof safeArgs.description === "string" ? safeArgs.description.trim() : "";
    const location =
      typeof safeArgs.location === "string" ? safeArgs.location.trim() : "";
    return { title, date, start, end, description, location };
  }

  if (name === "get_calendar_event" || name === "delete_calendar_event") {
    const eventId =
      typeof safeArgs.event_id === "string" ? safeArgs.event_id.trim() : "";
    return looksLikeCalendarEventId(eventId) ? { event_id: eventId } : null;
  }

  if (name === "get_tasks") {
    return { status: normalizeEnum(safeArgs.status, ["pending", "completed", "all"], "pending") };
  }

  if (name === "create_task") {
    const title = typeof safeArgs.title === "string" ? safeArgs.title.trim() : "";
    if (!title) return null;

    const description =
      typeof safeArgs.description === "string" ? safeArgs.description : "";
    const dueDate = normalizeDate(safeArgs.due_date);
    const priority = normalizeEnum(safeArgs.priority, ["low", "medium", "high"], "medium");

    return {
      title,
      description,
      ...(dueDate ? { due_date: dueDate } : {}),
      priority,
    };
  }

  if (name === "delete_tasks") {
    const taskIds = Array.isArray(safeArgs.task_ids)
      ? safeArgs.task_ids
        .filter((id) => typeof id === "string")
        .map((id) => id.trim())
        .filter(Boolean)
      : [];
    return taskIds.length > 0 ? { task_ids: taskIds } : null;
  }

  if (name === "get_emails") {
    return { filter: normalizeEnum(safeArgs.filter, ["unread", "read", "all"], "unread") };
  }

  if (name !== "read_email") {
    return safeArgs;
  }

  const candidateId =
    typeof safeArgs.email_id === "string" ? safeArgs.email_id.trim() : "";

  if (looksLikeEmailMessageId(candidateId)) {
    return { ...safeArgs, email_id: candidateId };
  }

  // Recover gracefully when the model hallucinates/omits an ID:
  // fetch unread emails and resolve either by ordinal index or fallback to first.
  toolsUsed.push("get_emails");
  const listResult = await dispatchTool("get_emails", { filter: "unread" }, credentials);
  if (!listResult.success) {
    if (listResult.error) {
      const duplicate = errors.some(
        (e) => e.service === listResult.error.service && e.reason === listResult.error.reason
      );
      if (!duplicate) errors.push(listResult.error);
    }
    return null;
  }

  const emails = Array.isArray(listResult.data?.emails) ? listResult.data.emails : [];
  if (emails.length === 0) return null;

  const modelIndex = Number.isInteger(safeArgs.email_index)
    ? safeArgs.email_index
    : parseInt(String(safeArgs.email_index ?? ""), 10);
  const requestedFromArgs = Number.isInteger(modelIndex) && modelIndex > 0 ? modelIndex : null;
  const requestedFromText = parseRequestedEmailIndex(userMessage);
  const oneBasedIndex = requestedFromArgs ?? requestedFromText ?? 1;

  const selected = emails[oneBasedIndex - 1] ?? emails[0];
  const selectedId = selected?.id;
  if (typeof selectedId !== "string" || !looksLikeEmailMessageId(selectedId.trim())) {
    return null;
  }

  return { ...safeArgs, email_id: selectedId.trim() };
}

function looksLikeEmailMessageId(id) {
  return typeof id === "string" && /^[a-f0-9]{8,}$/i.test(id);
}

function looksLikeCalendarEventId(id) {
  return typeof id === "string" && /^[^\s/?#]+$/.test(id);
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return allowed.includes(normalized) ? normalized : fallback;
}

function getCurrentDateInCalendarOffset() {
  return shiftDateToCalendarOffset(new Date()).toISOString().slice(0, 10);
}

function getCurrentTimeInCalendarOffset() {
  return shiftDateToCalendarOffset(new Date()).toISOString().slice(11, 16);
}

function shiftDateToCalendarOffset(date) {
  return new Date(date.getTime() + CALENDAR_OFFSET_MINUTES * 60 * 1000);
}

function addDaysToIsoDate(date, days) {
  const base = new Date(`${date}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function normalizeDate(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  const today = getCurrentDateInCalendarOffset();
  if (v === "today") return today;
  if (v === "tomorrow") return addDaysToIsoDate(today, 1);
  if (v === "next week") return getNextWeekRange().start;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/**
 * Returns the ISO dates for the Monday–Sunday of next calendar week (GMT+8).
 */
function getNextWeekRange() {
  const today = shiftDateToCalendarOffset(new Date());
  // 0=Sun,1=Mon,...,6=Sat — shift so Monday=0
  const dayOfWeek = (today.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const daysUntilNextMonday = 7 - dayOfWeek;      // always 1-7
  const todayIso = today.toISOString().slice(0, 10);
  const start = addDaysToIsoDate(todayIso, daysUntilNextMonday);
  const end   = addDaysToIsoDate(start, 6); // next Sunday
  return { start, end };
}

function normalizeTime(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();

  const hhmm24 = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (hhmm24) {
    const hh = hhmm24[1].padStart(2, "0");
    return `${hh}:${hhmm24[2]}`;
  }

  const ampm = raw.match(/^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)$/);
  if (!ampm) return null;

  let hour = parseInt(ampm[1], 10);
  const minute = ampm[2] ?? "00";
  const suffix = ampm[3];

  if (hour < 1 || hour > 12) return null;
  if (suffix === "am") {
    if (hour === 12) hour = 0;
  } else if (hour !== 12) {
    hour += 12;
  }
  return `${String(hour).padStart(2, "0")}:${minute}`;
}


function parseRequestedEmailIndex(text) {
  if (typeof text !== "string") return null;
  const lower = text.toLowerCase();

  const numericOrdinal = lower.match(/\b(\d+)(st|nd|rd|th)\s+email\b/);
  if (numericOrdinal) {
    const n = parseInt(numericOrdinal[1], 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  const wordMap = {
    first: 1,
    second: 2,
    third: 3,
    fourth: 4,
    fifth: 5,
    sixth: 6,
    seventh: 7,
    eighth: 8,
    ninth: 9,
    tenth: 10,
  };

  for (const [word, idx] of Object.entries(wordMap)) {
    if (lower.includes(`${word} email`)) return idx;
  }

  return null;
}

function getSessionMessages(sessionId) {
  const entry = sessionStore.get(sessionId);
  if (!entry) return [];
  entry.updatedAt = Date.now();
  return entry.messages;
}

// Save previous user-assistant messages
function saveSessionMessages(sessionId, messages) {
  const trimmed = messages.slice(-MAX_SESSION_MESSAGES);
  sessionStore.set(sessionId, {
    messages: trimmed,
    updatedAt: Date.now(),
  });
}

// Clear messages that exceed TTL
function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [id, entry] of sessionStore.entries()) {
    if (now - entry.updatedAt > SESSION_TTL_MS) {
      sessionStore.delete(id);
    }
  }
}
