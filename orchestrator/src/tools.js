import axios from "axios";
import { SERVICES, SERVICE_TIMEOUT_MS } from "./config.js";
import { getValidAccessToken } from "./auth.js";

// ── Tool schemas (Ollama / OpenAI function-calling format) ────────────────────
export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "check_calendar_availability",
      description: "Check available meeting slots on a specific date.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Target date in YYYY-MM-DD format.",
          },
        },
        required: ["date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_meeting",
      description:
        "Book a meeting on the calendar. Always call check_calendar_availability first to confirm the slot is free.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Meeting title." },
          date: { type: "string", description: "Date in YYYY-MM-DD format." },
          start: { type: "string", description: "Start time in HH:MM (24-hour)." },
          end: { type: "string", description: "End time in HH:MM (24-hour)." },
          attendees: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of attendee email addresses.",
          },
        },
        required: ["title", "date", "start", "end"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_tasks",
      description:
        'Fetch tasks. Use status "pending" for incomplete items, "completed" for done items, or "all" for everything.',
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["pending", "completed", "all"],
            description: "Filter by status. Defaults to pending.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_task",
      description: "Create a new task.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Task title (required)." },
          description: { type: "string", description: "Optional additional context." },
          due_date: { type: "string", description: "Optional due date in YYYY-MM-DD format." },
          priority: {
            type: "string",
            enum: ["low", "medium", "high"],
            description: "Task priority. Defaults to medium.",
          },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_tasks",
      description: "Delete one or more tasks by their task IDs.",
      parameters: {
        type: "object",
        properties: {
          task_ids: {
            type: "array",
            items: { type: "string" },
            description: "List of task IDs to delete.",
          },
        },
        required: ["task_ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_emails",
      description:
        'Fetch emails. Use filter "unread" for unread messages, "read" for read messages, or "all" for all emails.',
      parameters: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            enum: ["unread", "read", "all"],
            description: "Filter by read status. Defaults to unread.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "summarize_email",
      description:
        "Get a plain-language summary of a specific email. Prefer a real email_id from get_emails. If user refers by order (e.g. 1st/8th), pass email_index as a 1-based position.",
      parameters: {
        type: "object",
        properties: {
          email_id: {
            type: "string",
            description: "The Gmail message ID of the email to summarize.",
          },
          email_index: {
            type: "integer",
            description: "Optional 1-based position within the latest unread email list (e.g. 1 means first unread email).",
          },
        },
        required: [],
      },
    },
  },
];

/**
 * Helper to build axios config with Authorization header
 */
async function getAuthHeaders(credentials) {
  try {
    const token = await getValidAccessToken(credentials);
    return { headers: { Authorization: `Bearer ${token}` } };
  } catch (err) {
    console.error("[orchestrator] Failed to get valid access token:", err.message);
    throw new Error("Google authentication required. Please visit /api/auth/google");
  }
}

// ── Shared HTTP client ────────────────────────────────────────────────────────
const http = axios.create({ timeout: SERVICE_TIMEOUT_MS });
const EMAIL_TOOL_TIMEOUT_MS = parseInt(process.env.EMAIL_TOOL_TIMEOUT_MS ?? "15000", 10);

/**
 * Execute a named tool against the appropriate downstream service.
 * Never throws — all errors are captured and returned in the result object.
 *
 * @param {string} name  Tool name matching a key in TOOL_DEFINITIONS
 * @param {object} args  Arguments provided by the LLM
 * @param {object} credentials Valid Google auth tokens
 * @returns {Promise<{ success: boolean, data: any, error?: { service: string, reason: string } }>}
 */
export async function dispatchTool(name, args = {}, credentials) {
  try {
    const authConfig = await getAuthHeaders(credentials);

    switch (name) {
      case "check_calendar_availability": {
        const { data } = await http.get(
          `${SERVICES.calendar}/api/availability`,
          { ...authConfig, params: { date: args.date } }
        );
        return { success: true, data };
      }

      case "book_meeting": {
        const { data } = await http.post(`${SERVICES.calendar}/api/meetings`, {
          title: args.title,
          date: args.date,
          start: args.start,
          end: args.end,
          attendees: Array.isArray(args.attendees) ? args.attendees : [],
        }, authConfig);
        return { success: true, data };
      }

      case "get_tasks": {
        const { data } = await http.get(`${SERVICES.task}/api/tasks`, {
          ...authConfig,
          params: { status: args.status ?? "pending" },
        });
        return { success: true, data };
      }

      case "create_task": {
        const { data } = await http.post(`${SERVICES.task}/api/tasks`, {
          title: args.title,
          description: args.description ?? "",
          due_date: args.due_date,
          priority: args.priority ?? "medium",
        }, authConfig);
        return { success: true, data };
      }

      case "delete_tasks": {
        const taskIds = Array.isArray(args.task_ids)
          ? args.task_ids.filter((id) => typeof id === "string" && id.trim() !== "")
          : [];
        const { data } = await http.delete(`${SERVICES.task}/api/tasks`, {
          ...authConfig,
          data: { task_ids: taskIds },
        });
        return { success: true, data };
      }

      case "get_emails": {
        const { data } = await http.get(`${SERVICES.email}/api/emails`, {
          ...authConfig,
          timeout: EMAIL_TOOL_TIMEOUT_MS,
          params: { filter: args.filter ?? "unread" },
        });
        return { success: true, data };
      }

      case "summarize_email": {
        const { data } = await http.post(
          `${SERVICES.email}/api/emails/summarize`,
          { email_id: args.email_id },
          { ...authConfig, timeout: EMAIL_TOOL_TIMEOUT_MS }
        );
        return { success: true, data };
      }

      default:
        return {
          success: false,
          data: null,
          error: { service: "orchestrator", reason: `Unknown tool: "${name}".` },
        };
    }
  } catch (err) {
    const service = resolveServiceName(name);
    const reason = buildErrorReason(err);
    console.error(`[orchestrator] Tool "${name}" failed — ${reason}`);
    return { success: false, data: null, error: { service, reason } };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function resolveServiceName(toolName) {
  if (toolName === "check_calendar_availability" || toolName === "book_meeting") {
    return "calendar-service";
  }
  if (toolName === "get_tasks" || toolName === "create_task") {
    return "task-service";
  }
  if (toolName === "delete_tasks") {
    return "task-service";
  }
  if (toolName === "get_emails" || toolName === "summarize_email") {
    return "email-service";
  }
  return "unknown-service";
}

function buildErrorReason(err) {
  if (err.code === "ECONNREFUSED") {
    return `Service unavailable (connect ECONNREFUSED)`;
  }
  if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
    return `Request timed out after ${SERVICE_TIMEOUT_MS}ms`;
  }
  if (err.response) {
    return `Service returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`;
  }
  return err.message ?? "Unknown error";
}
