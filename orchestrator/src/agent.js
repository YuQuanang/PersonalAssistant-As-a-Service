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
const taskDraftStore = new Map();
const taskDeleteDraftStore = new Map();
const LLM_BLOCKED_TOOL_NAMES = new Set(["create_task", "delete_tasks"]);
const LLM_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter(
  (t) => !LLM_BLOCKED_TOOL_NAMES.has(t.function.name)
);
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
  const activeTaskDraft = getTaskDraft(resolvedSessionId);
  const activeTaskDeleteDraft = getTaskDeleteDraft(resolvedSessionId);

  const guidedTaskDeleteResponse = await handleGuidedTaskDeletion({
    sessionId: resolvedSessionId,
    userMessage,
    sessionHistory,
    activeDraft: activeTaskDeleteDraft,
    credentials,
  });

  if (guidedTaskDeleteResponse) {
    return guidedTaskDeleteResponse;
  }

  const guidedTaskResponse = await handleGuidedTaskCreation({
    sessionId: resolvedSessionId,
    userMessage,
    sessionHistory,
    activeDraft: activeTaskDraft,
    credentials,
  });

  if (guidedTaskResponse) {
    return guidedTaskResponse;
  }

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
        { model: OLLAMA.model, messages, tools: LLM_TOOL_DEFINITIONS, stream: false },
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

    // No tool calls → either final prose, or an invalid pseudo tool-call plan.
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

    // Loop — Ollama will process tool results and either call more tools or
    // produce a final answer.
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
  taskDraftStore.delete(safeSessionId);
  taskDeleteDraftStore.delete(safeSessionId);
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
    const start_date =
      typeof safeArgs.start_date === "string" && safeArgs.start_date.trim() !== ""
        ? normalizeDate(safeArgs.start_date)
        : TODAY;
    const end_date =
      typeof safeArgs.end_date === "string" && safeArgs.end_date.trim() !== ""
        ? normalizeDate(safeArgs.end_date)
        : "";
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
  if (v === "next week") return addDaysToIsoDate(today, 7);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
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

function resolveServiceName(toolName) {
  if (
    toolName === "list_calendar_events" ||
    toolName === "create_calendar_event" ||
    toolName === "get_calendar_event" ||
    toolName === "delete_calendar_event"
  ) {
    return "calendar-service";
  }
  if (toolName === "get_tasks" || toolName === "create_task" || toolName === "delete_tasks") {
    return "task-service";
  }
  if (toolName === "get_emails" || toolName === "read_email") {
    return "email-service";
  }
  return "unknown-service";
}

async function handleGuidedTaskCreation({
  sessionId,
  userMessage,
  sessionHistory,
  activeDraft,
  credentials,
}) {
  const text = typeof userMessage === "string" ? userMessage.trim() : "";
  if (!text) return null;

  const lower = text.toLowerCase();

  if (!activeDraft && !looksLikeTaskCreationIntent(lower)) {
    return null;
  }

  if (!activeDraft && looksLikeTaskCreationIntent(lower)) {
    const draft = {
      state: "collecting",
      fields: {
        title: "",
        description: "",
        due_date: null,
        priority: "medium",
      },
      nextField: "title",
      lastUpdatedAt: Date.now(),
    };
    setTaskDraft(sessionId, draft);

    const response =
      "Great, I can create that task.\n\n" +
      "Please share the task title first.";

    return buildGuidedReply({
      sessionId,
      sessionHistory,
      userMessage: text,
      response,
      toolsUsed: [],
      errors: [],
      suggestions: [],
    });
  }

  if (!activeDraft) return null;

  if (isCancelText(lower)) {
    clearTaskDraft(sessionId);
    return buildGuidedReply({
      sessionId,
      sessionHistory,
      userMessage: text,
      response: "Task creation cancelled.",
      toolsUsed: [],
      errors: [],
      suggestions: [],
    });
  }

  if (activeDraft.state === "awaiting_approval") {
    if (isDeclineText(lower)) {
      clearTaskDraft(sessionId);
      return buildGuidedReply({
        sessionId,
        sessionHistory,
        userMessage: text,
        response: "Task creation cancelled.",
        toolsUsed: [],
        errors: [],
        suggestions: [],
      });
    }

    if (isPreviousInputText(lower)) {
      const draft = cloneTaskDraft(activeDraft);
      draft.state = "collecting";
      draft.nextField = "priority";
      draft.lastUpdatedAt = Date.now();
      setTaskDraft(sessionId, draft);

      return buildGuidedReply({
        sessionId,
        sessionHistory,
        userMessage: text,
        response:
          "Okay, let's update the priority.\n\n" +
          "What priority should I set: low, medium, or high? You can also reply skip (defaults to medium).",
        toolsUsed: [],
        errors: [],
        suggestions: ["Low", "Medium", "High", "Skip", "Previous Input"],
      });
    }

    if (!isApprovalText(lower)) {
      return buildGuidedReply({
        sessionId,
        sessionHistory,
        userMessage: text,
        response:
          "I have the draft ready. Please reply with approved to create it, or decline to discard it.",
        toolsUsed: [],
        errors: [],
        suggestions: ["Approved", "Decline", "Previous Input"],
      });
    }

    const toolsUsed = [];
    const errors = [];

    const createArgs = buildCreateTaskArgs(activeDraft.fields);
    toolsUsed.push("create_task");
    const created = await dispatchTool("create_task", createArgs, credentials);

    if (!created.success) {
      if (created.error) {
        errors.push(created.error);
      }

      clearTaskDraft(sessionId);
      return buildGuidedReply({
        sessionId,
        sessionHistory,
        userMessage: text,
        response:
          "I could not create the task right now. Please check your Google sign-in and try again.",
        toolsUsed,
        errors,
        suggestions: [],
      });
    }

    toolsUsed.push("get_tasks");
    const pending = await dispatchTool("get_tasks", { status: "pending" }, credentials);

    if (!pending.success) {
      if (pending.error) {
        errors.push(pending.error);
      }

      clearTaskDraft(sessionId);
      return buildGuidedReply({
        sessionId,
        sessionHistory,
        userMessage: text,
        response:
          "Task created. I could not fetch your pending list right now, but the task was successfully submitted.",
        toolsUsed,
        errors,
        suggestions: [],
      });
    }

    const createdTask = created.data ?? {};
    const pendingTasks = Array.isArray(pending.data?.tasks) ? pending.data.tasks : [];
    const response = [
      "Task created successfully:",
      formatTaskPreview(createdTask),
      "",
      `Here are your pending tasks (${pendingTasks.length}):`,
      ...formatPendingTaskList(pendingTasks),
    ].join("\n");

    clearTaskDraft(sessionId);
    return buildGuidedReply({
      sessionId,
      sessionHistory,
      userMessage: text,
      response,
      toolsUsed,
      errors,
      suggestions: [],
    });
  }

  const draft = cloneTaskDraft(activeDraft);
  const next = draft.nextField;

  if (next === "title") {
    const title = text.trim();
    if (!title) {
      return buildGuidedReply({
        sessionId,
        sessionHistory,
        userMessage: text,
        response: "Please provide a non-empty title for the task.",
        toolsUsed: [],
        errors: [],
        suggestions: [],
      });
    }
    draft.fields.title = title;
    draft.nextField = "description";
    draft.lastUpdatedAt = Date.now();
    setTaskDraft(sessionId, draft);

    return buildGuidedReply({
      sessionId,
      sessionHistory,
      userMessage: text,
      response:
        "Got it.\n\nPlease provide a short description. You can also reply skip if you do not want one.",
      toolsUsed: [],
      errors: [],
      suggestions: ["Skip", "Retype Task Title"],
    });
  }

  if (next === "description") {
    if (isRetypeTitleText(lower)) {
      draft.fields.title = "";
      draft.nextField = "title";
      draft.lastUpdatedAt = Date.now();
      setTaskDraft(sessionId, draft);

      return buildGuidedReply({
        sessionId,
        sessionHistory,
        userMessage: text,
        response: "Sure. Please share the task title again.",
        toolsUsed: [],
        errors: [],
        suggestions: [],
      });
    }

    if (isPreviousInputText(lower)) {
      draft.fields.title = "";
      draft.nextField = "title";
      draft.lastUpdatedAt = Date.now();
      setTaskDraft(sessionId, draft);

      return buildGuidedReply({
        sessionId,
        sessionHistory,
        userMessage: text,
        response: "Okay, let's go back. Please share the task title again.",
        toolsUsed: [],
        errors: [],
        suggestions: [],
      });
    }

    draft.fields.description = isSkipText(lower) ? "" : text;
    draft.nextField = "due_date";
    draft.lastUpdatedAt = Date.now();
    setTaskDraft(sessionId, draft);

    return buildGuidedReply({
      sessionId,
      sessionHistory,
      userMessage: text,
      response:
        "Thanks.\n\nWhat is the due date? Use YYYY-MM-DD, or say today/tomorrow/next week, or reply skip.",
      toolsUsed: [],
      errors: [],
      suggestions: ["Today", "Next Week", "Skip", "Previous Input"],
    });
  }

  if (next === "due_date") {
    if (isPreviousInputText(lower)) {
      draft.fields.description = "";
      draft.nextField = "description";
      draft.lastUpdatedAt = Date.now();
      setTaskDraft(sessionId, draft);

      return buildGuidedReply({
        sessionId,
        sessionHistory,
        userMessage: text,
        response:
          "Okay, let's go back.\n\nPlease provide a short description. You can also reply skip if you do not want one.",
        toolsUsed: [],
        errors: [],
        suggestions: ["Skip", "Retype Task Title"],
      });
    }

    if (isSkipText(lower)) {
      draft.fields.due_date = null;
    } else {
      const dueDate = normalizeDate(text);
      if (!dueDate) {
        return buildGuidedReply({
          sessionId,
          sessionHistory,
          userMessage: text,
          response: "Please provide the due date as YYYY-MM-DD, or say today, tomorrow, next week, or skip.",
          toolsUsed: [],
          errors: [],
          suggestions: ["Today", "Next Week", "Skip", "Previous Input"],
        });
      }
      draft.fields.due_date = dueDate;
    }

    draft.nextField = "priority";
    draft.lastUpdatedAt = Date.now();
    setTaskDraft(sessionId, draft);

    return buildGuidedReply({
      sessionId,
      sessionHistory,
      userMessage: text,
      response:
        "Great.\n\nWhat priority should I set: low, medium, or high? You can also reply skip (defaults to medium).",
      toolsUsed: [],
      errors: [],
      suggestions: ["Low", "Medium", "High", "Skip", "Previous Input"],
    });
  }

  if (next === "priority") {
    if (isPreviousInputText(lower)) {
      draft.fields.due_date = null;
      draft.nextField = "due_date";
      draft.lastUpdatedAt = Date.now();
      setTaskDraft(sessionId, draft);

      return buildGuidedReply({
        sessionId,
        sessionHistory,
        userMessage: text,
        response:
          "Okay, let's update the due date.\n\nWhat is the due date? Use YYYY-MM-DD, or say today/tomorrow/next week, or reply skip.",
        toolsUsed: [],
        errors: [],
        suggestions: ["Today", "Next Week", "Skip", "Previous Input"],
      });
    }

    if (isSkipText(lower)) {
      draft.fields.priority = "medium";
    } else {
      const priority = normalizeEnum(text, ["low", "medium", "high"], "");
      if (!priority) {
        return buildGuidedReply({
          sessionId,
          sessionHistory,
          userMessage: text,
          response: "Please choose one priority: low, medium, or high. You can also reply skip.",
          toolsUsed: [],
          errors: [],
          suggestions: ["Low", "Medium", "High", "Skip", "Previous Input"],
        });
      }
      draft.fields.priority = priority;
    }

    draft.state = "awaiting_approval";
    draft.nextField = null;
    draft.lastUpdatedAt = Date.now();
    setTaskDraft(sessionId, draft);

    const response = [
      "Here is the new task to be created:",
      formatTaskPreview(draft.fields),
      "",
      "Reply approved to create it, or decline to discard.",
    ].join("\n");

    return buildGuidedReply({
      sessionId,
      sessionHistory,
      userMessage: text,
      response,
      toolsUsed: [],
      errors: [],
      suggestions: ["Approved", "Decline", "Previous Input"],
    });
  }

  return null;
}

async function handleGuidedTaskDeletion({
  sessionId,
  userMessage,
  sessionHistory,
  activeDraft,
  credentials,
}) {
  const text = typeof userMessage === "string" ? userMessage.trim() : "";
  if (!text) return null;

  const lower = text.toLowerCase();

  if (!activeDraft && !looksLikeTaskDeleteIntent(lower)) {
    return null;
  }

  if (!activeDraft && looksLikeTaskDeleteIntent(lower)) {
    clearTaskDraft(sessionId);

    const toolsUsed = ["get_tasks"];
    const errors = [];

    const pending = await dispatchTool("get_tasks", { status: "pending" }, credentials);
    if (!pending.success) {
      if (pending.error) errors.push(pending.error);
      return buildGuidedReply({
        sessionId,
        sessionHistory,
        userMessage: text,
        response: "I could not load your pending tasks right now. Please try again shortly.",
        toolsUsed,
        errors,
        suggestions: [],
      });
    }

    const tasks = Array.isArray(pending.data?.tasks) ? pending.data.tasks : [];
    if (tasks.length === 0) {
      return buildGuidedReply({
        sessionId,
        sessionHistory,
        userMessage: text,
        response: "You have no pending tasks to delete right now.",
        toolsUsed,
        errors,
        suggestions: [],
      });
    }

    const draft = {
      state: "awaiting_selection",
      candidates: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        due_date: task.due_date ?? null,
        priority: task.priority ?? "medium",
      })),
      selectedTaskIds: [],
      lastUpdatedAt: Date.now(),
    };
    setTaskDeleteDraft(sessionId, draft);

    const response = [
      "Sure, I can help delete tasks. Please choose which task number(s) to remove:",
      ...formatNumberedTaskChoices(draft.candidates),
      "",
      "Reply with one or more numbers (for example: 1,3).",
    ].join("\n");

    return buildGuidedReply({
      sessionId,
      sessionHistory,
      userMessage: text,
      response,
      toolsUsed,
      errors,
      suggestions: buildTaskSelectionSuggestions(draft.candidates.length),
    });
  }

  if (!activeDraft) return null;

  if (isCancelText(lower) || isDeclineText(lower)) {
    clearTaskDeleteDraft(sessionId);
    return buildGuidedReply({
      sessionId,
      sessionHistory,
      userMessage: text,
      response: "Task deletion cancelled.",
      toolsUsed: [],
      errors: [],
      suggestions: [],
    });
  }

  if (activeDraft.state === "awaiting_selection") {
    const pickedNumbers = parseTaskSelectionNumbers(text, activeDraft.candidates.length);
    if (!pickedNumbers || pickedNumbers.length === 0) {
      const response = [
        "Please choose valid task number(s) from the list:",
        ...formatNumberedTaskChoices(activeDraft.candidates),
        "",
        "Reply with one or more numbers (for example: 1,3), or Cancel.",
      ].join("\n");

      return buildGuidedReply({
        sessionId,
        sessionHistory,
        userMessage: text,
        response,
        toolsUsed: [],
        errors: [],
        suggestions: buildTaskSelectionSuggestions(activeDraft.candidates.length),
      });
    }

    const selectedTaskIds = pickedNumbers.map((n) => activeDraft.candidates[n - 1]?.id).filter(Boolean);
    const selectedTasks = pickedNumbers.map((n) => activeDraft.candidates[n - 1]).filter(Boolean);

    const nextDraft = {
      ...activeDraft,
      state: "awaiting_approval",
      selectedTaskIds,
      lastUpdatedAt: Date.now(),
    };
    setTaskDeleteDraft(sessionId, nextDraft);

    const response = [
      `Please confirm deletion for ${selectedTasks.length} task(s):`,
      ...selectedTasks.map((task) => formatTaskChoice(task)),
      "",
      "Reply Approved to delete, Decline to cancel, or Previous Input to reselect tasks.",
    ].join("\n");

    return buildGuidedReply({
      sessionId,
      sessionHistory,
      userMessage: text,
      response,
      toolsUsed: [],
      errors: [],
      suggestions: ["Approved", "Decline", "Previous Input"],
    });
  }

  if (activeDraft.state === "awaiting_approval") {
    if (isPreviousInputText(lower)) {
      const resetDraft = {
        ...activeDraft,
        state: "awaiting_selection",
        selectedTaskIds: [],
        lastUpdatedAt: Date.now(),
      };
      setTaskDeleteDraft(sessionId, resetDraft);

      const response = [
        "No problem. Please choose the task number(s) to delete:",
        ...formatNumberedTaskChoices(resetDraft.candidates),
        "",
        "Reply with one or more numbers (for example: 1,3).",
      ].join("\n");

      return buildGuidedReply({
        sessionId,
        sessionHistory,
        userMessage: text,
        response,
        toolsUsed: [],
        errors: [],
        suggestions: buildTaskSelectionSuggestions(resetDraft.candidates.length),
      });
    }

    if (!isApprovalText(lower)) {
      return buildGuidedReply({
        sessionId,
        sessionHistory,
        userMessage: text,
        response: "Please reply Approved to proceed, Decline to cancel, or Previous Input to reselect tasks.",
        toolsUsed: [],
        errors: [],
        suggestions: ["Approved", "Decline", "Previous Input"],
      });
    }

    const selectedIds = Array.isArray(activeDraft.selectedTaskIds) ? activeDraft.selectedTaskIds : [];
    if (selectedIds.length === 0) {
      clearTaskDeleteDraft(sessionId);
      return buildGuidedReply({
        sessionId,
        sessionHistory,
        userMessage: text,
        response: "I could not find selected tasks to delete. Please start again.",
        toolsUsed: [],
        errors: [],
        suggestions: [],
      });
    }

    const toolsUsed = ["delete_tasks"];
    const errors = [];
    const deleted = await dispatchTool("delete_tasks", { task_ids: selectedIds }, credentials);

    if (!deleted.success) {
      if (deleted.error) errors.push(deleted.error);
      clearTaskDeleteDraft(sessionId);
      return buildGuidedReply({
        sessionId,
        sessionHistory,
        userMessage: text,
        response: "I could not delete those tasks right now. Please try again shortly.",
        toolsUsed,
        errors,
        suggestions: [],
      });
    }

    toolsUsed.push("get_tasks");
    const pending = await dispatchTool("get_tasks", { status: "pending" }, credentials);
    if (!pending.success) {
      if (pending.error) errors.push(pending.error);
      clearTaskDeleteDraft(sessionId);
      return buildGuidedReply({
        sessionId,
        sessionHistory,
        userMessage: text,
        response: "Tasks deleted. I could not refresh your pending list right now.",
        toolsUsed,
        errors,
        suggestions: [],
      });
    }

    const deletedCount = Number(deleted.data?.deleted_count ?? selectedIds.length);
    const pendingTasks = Array.isArray(pending.data?.tasks) ? pending.data.tasks : [];
    const response = [
      `Done. Deleted ${deletedCount} task(s).`,
      "",
      `Here are your pending tasks (${pendingTasks.length}):`,
      ...formatPendingTaskList(pendingTasks),
    ].join("\n");

    clearTaskDeleteDraft(sessionId);
    return buildGuidedReply({
      sessionId,
      sessionHistory,
      userMessage: text,
      response,
      toolsUsed,
      errors,
      suggestions: [],
    });
  }

  return null;
}

function buildGuidedReply({ sessionId, sessionHistory, userMessage, response, toolsUsed, errors, suggestions = [] }) {
  saveSessionMessages(sessionId, [
    ...sessionHistory,
    { role: "user", content: userMessage },
    { role: "assistant", content: response },
  ]);

  return {
    session_id: sessionId,
    response,
    tools_used: toolsUsed,
    errors,
    suggestions,
  };
}



function cloneTaskDraft(draft) {
  return {
    ...draft,
    fields: { ...draft.fields },
  };
}

function setTaskDraft(sessionId, draft) {
  taskDraftStore.set(sessionId, draft);
}

function getTaskDraft(sessionId) {
  return taskDraftStore.get(sessionId) ?? null;
}

function clearTaskDraft(sessionId) {
  taskDraftStore.delete(sessionId);
}

function setTaskDeleteDraft(sessionId, draft) {
  taskDeleteDraftStore.set(sessionId, draft);
}

function getTaskDeleteDraft(sessionId) {
  return taskDeleteDraftStore.get(sessionId) ?? null;
}

function clearTaskDeleteDraft(sessionId) {
  taskDeleteDraftStore.delete(sessionId);
}

function looksLikeTaskCreationIntent(text) {
  if (!text) return false;
  return (
    /\bcreate\b.*\btasks?\b/.test(text) ||
    /\badd\b.*\btasks?\b/.test(text) ||
    /\bnew\b.*\btasks?\b/.test(text) ||
    /\bmake\b.*\btasks?\b/.test(text)
  );
}

function looksLikeTaskDeleteIntent(text) {
  if (!text) return false;
  return (
    /\bdelete\b.*\btasks?\b/.test(text) ||
    /\bremove\b.*\btasks?\b/.test(text) ||
    /\bclear\b.*\btasks?\b/.test(text)
  );
}

function parseTaskSelectionNumbers(text, max) {
  if (typeof text !== "string" || !Number.isInteger(max) || max <= 0) return null;
  const matches = text.match(/\d+/g);
  if (!matches || matches.length === 0) return null;

  const numbers = [...new Set(matches.map((m) => parseInt(m, 10)))].filter(
    (n) => Number.isInteger(n) && n >= 1 && n <= max
  );

  return numbers.length > 0 ? numbers : null;
}

function isSkipText(text) {
  if (!text) return false;
  return /^(skip|none|no|n\/a)$/i.test(text.trim());
}

function isCancelText(text) {
  if (!text) return false;
  return /^(cancel|stop|abort|nevermind|never mind)$/i.test(text.trim());
}

function isDeclineText(text) {
  if (!text) return false;
  return /^(decline|declined|reject|rejected|nope|discard)$/i.test(text.trim());
}

function isPreviousInputText(text) {
  if (!text) return false;
  return /^(previous input|previous|back|go back|edit previous)$/i.test(text.trim());
}

function isRetypeTitleText(text) {
  if (!text) return false;
  return /^(retype task title|retype title|edit title|change title)$/i.test(text.trim());
}

function isApprovalText(text) {
  if (!text) return false;
  return /^(approved|approve|yes|confirm|create|proceed|ok)$/i.test(text.trim());
}

function buildCreateTaskArgs(fields) {
  const payload = {
    title: fields.title,
    description: fields.description ?? "",
    priority: fields.priority ?? "medium",
  };
  if (fields.due_date) {
    payload.due_date = fields.due_date;
  }
  return payload;
}

function formatTaskPreview(task) {
  const due = task.due_date ?? "No due date";
  const priority = task.priority ?? "medium";
  const description = task.description?.trim() ? task.description.trim() : "";

  const lines = [
    `• Title: ${task.title ?? "Untitled"}`,
    `• Due date: ${due}`,
    `• Priority: ${priority}`,
  ];

  if (description) {
    lines.splice(1, 0, `• Description: ${description}`);
  }

  return lines.join("\n");
}



function formatTaskChoice(task) {
  const due = task?.due_date ?? "no due date";
  const priority = task?.priority ?? "medium";
  return `• ${task?.title ?? "Untitled"} (due: ${due}, priority: ${priority})`;
}

function formatNumberedTaskChoices(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return ["• No tasks available."];
  }
  return tasks.map((task, idx) => {
    const due = task?.due_date ?? "no due date";
    const priority = task?.priority ?? "medium";
    return `${idx + 1}. ${task?.title ?? "Untitled"} (due: ${due}, priority: ${priority})`;
  });
}

function buildTaskSelectionSuggestions(taskCount) {
  const count = Number.isInteger(taskCount) ? taskCount : 0;
  const suggestions = [];
  for (let i = 1; i <= Math.min(3, count); i++) {
    suggestions.push(String(i));
  }
  if (count >= 2) {
    suggestions.push("1,2");
  }
  suggestions.push("Cancel");
  return suggestions;
}

function formatPendingTaskList(tasks) {
  if (!tasks.length) {
    return ["• No pending tasks."];
  }

  return tasks.map((task) => {
    const due = task.due_date ?? "no due date";
    const priority = task.priority ?? "medium";
    return `• ${task.title ?? "Untitled"} (due: ${due}, priority: ${priority})`;
  });
}

function getSessionMessages(sessionId) {
  const entry = sessionStore.get(sessionId);
  if (!entry) return [];
  entry.updatedAt = Date.now();
  return entry.messages;
}

function saveSessionMessages(sessionId, messages) {
  const trimmed = messages.slice(-MAX_SESSION_MESSAGES);
  sessionStore.set(sessionId, {
    messages: trimmed,
    updatedAt: Date.now(),
  });
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [id, entry] of sessionStore.entries()) {
    if (now - entry.updatedAt > SESSION_TTL_MS) {
      sessionStore.delete(id);
      taskDraftStore.delete(id);
      taskDeleteDraftStore.delete(id);
    }
  }
}
