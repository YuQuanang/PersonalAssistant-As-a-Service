import axios from "axios";
import { SERVICES, SERVICE_TIMEOUT_MS } from "./config.js";

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
          date:  { type: "string", description: "Date in YYYY-MM-DD format." },
          start: { type: "string", description: "Start time in HH:MM (24-hour)." },
          end:   { type: "string", description: "End time in HH:MM (24-hour)." },
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
          title:       { type: "string", description: "Task title (required)." },
          description: { type: "string", description: "Optional additional context." },
          due_date:    { type: "string", description: "Optional due date in YYYY-MM-DD format." },
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
      name: "get_emails",
      description:
        'Fetch emails. Use filter "unread" for unread messages only, or "all" for all emails.',
      parameters: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            enum: ["unread", "all"],
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
        "Get a plain-language summary of a specific email by its ID. First call get_emails to obtain valid IDs.",
      parameters: {
        type: "object",
        properties: {
          email_id: {
            type: "string",
            description: "The ID of the email to summarize (e.g. email_001).",
          },
        },
        required: ["email_id"],
      },
    },
  },
];

// ── Shared HTTP client ────────────────────────────────────────────────────────
const http = axios.create({ timeout: SERVICE_TIMEOUT_MS });

/**
 * Execute a named tool against the appropriate downstream service.
 * Never throws — all errors are captured and returned in the result object.
 *
 * @param {string} name  Tool name matching a key in TOOL_DEFINITIONS
 * @param {object} args  Arguments provided by the LLM
 * @returns {Promise<{ success: boolean, data: any, error?: { service: string, reason: string } }>}
 */
export async function dispatchTool(name, args = {}) {
  try {
    switch (name) {
      case "check_calendar_availability": {
        const { data } = await http.get(
          `${SERVICES.calendar}/api/availability`,
          { params: { date: args.date } }
        );
        return { success: true, data };
      }

      case "book_meeting": {
        const { data } = await http.post(`${SERVICES.calendar}/api/meetings`, {
          title:     args.title,
          date:      args.date,
          start:     args.start,
          end:       args.end,
          attendees: Array.isArray(args.attendees) ? args.attendees : [],
        });
        return { success: true, data };
      }

      case "get_tasks": {
        const { data } = await http.get(`${SERVICES.task}/api/tasks`, {
          params: { status: args.status ?? "pending" },
        });
        return { success: true, data };
      }

      case "create_task": {
        const { data } = await http.post(`${SERVICES.task}/api/tasks`, {
          title:       args.title,
          description: args.description ?? "",
          due_date:    args.due_date,
          priority:    args.priority ?? "medium",
        });
        return { success: true, data };
      }

      case "get_emails": {
        const { data } = await http.get(`${SERVICES.email}/api/emails`, {
          params: { filter: args.filter ?? "unread" },
        });
        return { success: true, data };
      }

      case "summarize_email": {
        const { data } = await http.post(
          `${SERVICES.email}/api/emails/summarize`,
          { email_id: args.email_id }
        );
        return { success: true, data };
      }

      default:
        return {
          success: false,
          data:    null,
          error:   { service: "orchestrator", reason: `Unknown tool: "${name}".` },
        };
    }
  } catch (err) {
    const service = resolveServiceName(name);
    const reason  = buildErrorReason(err);
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
