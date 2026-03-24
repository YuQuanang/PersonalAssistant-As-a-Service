import axios from "axios";
import { randomUUID } from "node:crypto";
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
const VALID_TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((t) => t.function.name));

// Today's date injected once so the model always has accurate temporal context.
const TODAY = new Date().toISOString().slice(0, 10);

const SYSTEM_PROMPT = `\
You are PAaaS, a friendly and helpful personal assistant. Today's date is ${TODAY}.

You have access to three services via tools:
  • Calendar Service — check free slots and book meetings
  • Task Service     — list pending tasks and create new ones
  • Email Service    — list unread emails and summarize specific ones

── RESPONSE STYLE ──────────────────────────────────────────────────────────────
- Write in a warm, conversational tone — like a capable human assistant, not a robot.
- Use clear, natural English. Avoid filler phrases like "Certainly!", "Of course!", or "Sure thing!".
- Format lists with bullet points (•). Use bold (**text**) to highlight key names, dates, or priorities.
- For tasks: always mention the title, due date, and priority.
- For calendar slots: group them naturally (e.g. "You have three open slots: 9–10 AM, 11 AM–12 PM, and 2–3 PM").
- For emails: give a one-sentence human summary per email, not a raw subject line dump.
- For a single-email summarize request: provide a detailed brief with:
  • Sender, subject, and received time
  • 3-6 key points from the email body
  • Any action items requested
  • Any deadlines / dates mentioned
  • A short suggested next step
- End multi-item responses with a brief, helpful follow-up offer (e.g. "Would you like me to book one of those slots?").
- Keep answers focused — no unnecessary padding or repetition.

── STRICT RULES ─────────────────────────────────────────────────────────────────
1. ALWAYS use tools to fetch real data before answering. Never invent dates, task names, email subjects, or time slots.
2. For compound questions (e.g. "show my tasks AND check tomorrow's availability"), call all relevant tools.
3. When booking a meeting, call check_calendar_availability first; only book a slot confirmed as free.
4. If a tool returns an error, clearly tell the user what you could not retrieve, then share any data you did get.
5. Never expose raw JSON, HTTP status codes, or internal IDs (like "email_001") to the user.
6. If the user asks to summarize an email by order (e.g. "first email"), call get_emails first, select the matching item by index, then call summarize_email.
7. Never describe planned tool calls in plain text. If a tool is needed, emit structured tool_calls only.
8. Never invent email IDs. Use only IDs returned by get_emails in the current conversation context.
9. For email counts, use only get_emails totals: total_unread and total_all. Never infer one from the other.
10. When user asks for unread emails, report total_unread and show only the latest 10 unread emails returned in emails.
11. If get_emails fails or times out, do not fabricate any email list or sender names. State that retrieval failed and ask to retry.
12. For summarize_email results, base the summary only on tool fields (subject, from, received_at/date_header, snippet, summary/body_text). Do not invent details.
13. If any email total field says "more than 100", explicitly phrase it as "you have more than 100 [read/unread/all] emails".

`;


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
 *   errors:     Array<{ service: string, reason: string }>
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

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...sessionHistory,
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

    // No tool calls → either final prose, or an invalid pseudo tool-call plan.
    if (!toolCalls || toolCalls.length === 0) {
      const assistantResponse = assistantMessage.content?.trim() ?? "(No response generated)";

      const plannedCall = extractPlannedToolCall(assistantResponse);
      if (plannedCall && VALID_TOOL_NAMES.has(plannedCall.name)) {
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
        response:   assistantResponse,
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
  };
}

export function endSession(sessionId) {
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    return false;
  }
  const safeSessionId = sessionId.trim();
  taskDraftStore.delete(safeSessionId);
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

  if (name === "check_calendar_availability") {
    const date = normalizeDate(safeArgs.date);
    return date ? { date } : null;
  }

  if (name === "book_meeting") {
    const title = typeof safeArgs.title === "string" ? safeArgs.title.trim() : "";
    const date = normalizeDate(safeArgs.date);
    const start = normalizeTime(safeArgs.start);
    const end = normalizeTime(safeArgs.end);
    if (!title || !date || !start || !end) return null;

    const attendees = normalizeAttendees(safeArgs.attendees);
    return { title, date, start, end, attendees };
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

  if (name === "get_emails") {
    return { filter: normalizeEnum(safeArgs.filter, ["unread", "read", "all"], "unread") };
  }

  if (name !== "summarize_email") {
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

function normalizeEnum(value, allowed, fallback) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return allowed.includes(normalized) ? normalized : fallback;
}

function normalizeDate(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "today") return TODAY;
  if (v === "tomorrow") {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }
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

function normalizeAttendees(value) {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .filter((v) => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
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
  if (toolName === "check_calendar_availability" || toolName === "book_meeting") {
    return "calendar-service";
  }
  if (toolName === "get_tasks" || toolName === "create_task") {
    return "task-service";
  }
  if (toolName === "get_emails" || toolName === "summarize_email") {
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
    });
  }

  if (activeDraft.state === "awaiting_approval") {
    if (!isApprovalText(lower)) {
      return buildGuidedReply({
        sessionId,
        sessionHistory,
        userMessage: text,
        response:
          "I have the draft ready. Please reply with approve to create it, or cancel to discard it.",
        toolsUsed: [],
        errors: [],
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
    });
  }

  if (next === "description") {
    draft.fields.description = isSkipText(lower) ? "" : text;
    draft.nextField = "due_date";
    draft.lastUpdatedAt = Date.now();
    setTaskDraft(sessionId, draft);

    return buildGuidedReply({
      sessionId,
      sessionHistory,
      userMessage: text,
      response:
        "Thanks.\n\nWhat is the due date? Use YYYY-MM-DD, or say today/tomorrow, or reply skip.",
      toolsUsed: [],
      errors: [],
    });
  }

  if (next === "due_date") {
    if (isSkipText(lower)) {
      draft.fields.due_date = null;
    } else {
      const dueDate = normalizeDate(text);
      if (!dueDate) {
        return buildGuidedReply({
          sessionId,
          sessionHistory,
          userMessage: text,
          response: "Please provide the due date as YYYY-MM-DD, or say today, tomorrow, or skip.",
          toolsUsed: [],
          errors: [],
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
    });
  }

  if (next === "priority") {
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
      "Reply approve to create it, or cancel to discard.",
    ].join("\n");

    return buildGuidedReply({
      sessionId,
      sessionHistory,
      userMessage: text,
      response,
      toolsUsed: [],
      errors: [],
    });
  }

  return null;
}

function buildGuidedReply({ sessionId, sessionHistory, userMessage, response, toolsUsed, errors }) {
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

function looksLikeTaskCreationIntent(text) {
  if (!text) return false;
  return (
    /\bcreate\b.*\btasks?\b/.test(text) ||
    /\badd\b.*\btasks?\b/.test(text) ||
    /\bnew\b.*\btasks?\b/.test(text) ||
    /\bmake\b.*\btasks?\b/.test(text)
  );
}

function isSkipText(text) {
  if (!text) return false;
  return /^(skip|none|no|n\/a)$/i.test(text.trim());
}

function isCancelText(text) {
  if (!text) return false;
  return /^(cancel|stop|abort|nevermind|never mind)$/i.test(text.trim());
}

function isApprovalText(text) {
  if (!text) return false;
  return /^(approve|yes|confirm|create|proceed|ok)$/i.test(text.trim());
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
  const description = task.description?.trim() ? task.description.trim() : "No description";

  return [
    `• Title: ${task.title ?? "Untitled"}`,
    `• Description: ${description}`,
    `• Due date: ${due}`,
    `• Priority: ${priority}`,
  ].join("\n");
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
    }
  }
}
