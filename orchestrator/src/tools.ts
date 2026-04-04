import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import axios from "axios";
import { getValidAccessToken } from "./auth";
import { SERVICES, SERVICE_TIMEOUT_MS } from "./config.js";
import { getCurrentDateInCalendarOffset, addDaysToIsoDate } from "./utils.js";


const http = axios.create({ timeout: SERVICE_TIMEOUT_MS });
const EMAIL_TIMEOUT_MS = parseInt(process.env.EMAIL_TOOL_TIMEOUT_MS ?? "15000", 10);

async function getAuthHeaders(credentials: unknown) {
    const token = await getValidAccessToken(credentials);
    return { headers: { Authorization: `Bearer ${token}` } };
}

function getNextWeekRange(): { start: string; end: string } {
    const todayIso = getCurrentDateInCalendarOffset();
    // Shift so Mon=0 … Sun=6
    const dow = (new Date().getUTCDay() + 6) % 7;
    const start = addDaysToIsoDate(todayIso, 7 - dow); // next Monday
    const end = addDaysToIsoDate(start, 6);           // following Sunday
    return { start, end };
}

function normalizeDate(value: string | null | undefined): string | null {
    if (!value) return null;
    const v = value.trim().toLowerCase();
    const today = getCurrentDateInCalendarOffset();
    if (v === "today") return today;
    if (v === "tomorrow") return addDaysToIsoDate(today, 1);
    if (v === "next week") return getNextWeekRange().start;
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

export const listCalendarEventsTool = tool(
    async ({ start_date, end_date }, config: RunnableConfig) => {
        const credentials = config.configurable?.credentials;
        const authConfig = await getAuthHeaders(credentials);
        // Resolve "next week" literal before building params
        let resolvedStart = start_date;
        let resolvedEnd = end_date;
        if (start_date?.toLowerCase() === "next week" || end_date?.toLowerCase() === "next week") {
            const range = getNextWeekRange();
            resolvedStart = range.start;
            resolvedEnd = range.end;
        } else {
            resolvedStart = normalizeDate(start_date) ?? getCurrentDateInCalendarOffset();
            resolvedEnd = normalizeDate(end_date) ?? undefined;
        }
        const params: Record<string, string> = { startDate: resolvedStart };
        if (resolvedEnd) params.endDate = resolvedEnd;
        const { data } = await http.get(`${SERVICES.calendar}/api/events`, { ...authConfig, params });
        return JSON.stringify(data);
    },
    {
        name: "list_calendar_events",
        description: 'List calendar events for a date or range. Pass start_date as the literal "next week" to get next week\'s events.',
        schema: z.object({
            start_date: z.string().optional().describe('YYYY-MM-DD, "today", "tomorrow", or "next week".'),
            end_date: z.string().optional().describe("YYYY-MM-DD end of range."),
        }),
    }
);

export const createCalendarEventTool = tool(
    async ({ title, date, start, end, description = "", location = "" }, config: RunnableConfig) => {
        const credentials = config.configurable?.credentials;
        const authConfig = await getAuthHeaders(credentials);
        const { data } = await http.post(
            `${SERVICES.calendar}/api/events`,
            { title, date, start, end, description, location },
            authConfig
        );
        return JSON.stringify(data);
    },
    {
        name: "create_calendar_event",
        description: "Create a new calendar event.",
        schema: z.object({
            title: z.string().describe("Event title."),
            date: z.string().describe("Event date in YYYY-MM-DD format."),
            start: z.string().describe("Start time in HH:MM (24-hour)."),
            end: z.string().describe("End time in HH:MM (24-hour)."),
            description: z.string().optional().describe("Optional event details."),
            location: z.string().optional().describe("Optional location."),
        }),
    }
);
export const getCalendarEventTool = tool(
    async ({ event_id }, config: RunnableConfig) => {
        const credentials = config.configurable?.credentials;
        const authConfig = await getAuthHeaders(credentials);
        const { data } = await http.get(
            `${SERVICES.calendar}/api/events/${encodeURIComponent(event_id)}`,
            authConfig
        );
        return JSON.stringify(data);
    },
    {
        name: "get_calendar_event",
        description: "Get a calendar event by its event ID.",
        schema: z.object({
            event_id: z.string().describe("The calendar event ID."),
        }),
    }
);
export const deleteCalendarEventTool = tool(
    async ({ event_id }, config: RunnableConfig) => {
        const credentials = config.configurable?.credentials;
        const authConfig = await getAuthHeaders(credentials);
        const { data } = await http.delete(
            `${SERVICES.calendar}/api/events/${encodeURIComponent(event_id)}`,
            authConfig
        );
        return JSON.stringify(data);
    },
    {
        name: "delete_calendar_event",
        description: "Delete a calendar event by its event ID.",
        schema: z.object({
            event_id: z.string().describe("The calendar event ID to delete."),
        }),
    }
);
export const getTasksTool = tool(
    async ({ status = "pending" }, config: RunnableConfig) => {
        const credentials = config.configurable?.credentials;
        const authConfig = await getAuthHeaders(credentials);
        const { data } = await http.get(`${SERVICES.task}/api/tasks`, {
            ...authConfig,
            params: { status },
        });
        return JSON.stringify(data);
    },
    {
        name: "get_tasks",
        description: 'Fetch tasks. Use "pending", "completed", or "all".',
        schema: z.object({
            status: z.enum(["pending", "completed", "all"]).optional()
                .describe('Filter by status. Defaults to "pending".'),
        }),
    }
);
export const createTaskTool = tool(
    async ({ title, description = "", due_date, priority = "medium" }, config: RunnableConfig) => {
        const credentials = config.configurable?.credentials;
        const authConfig = await getAuthHeaders(credentials);
        const { data } = await http.post(
            `${SERVICES.task}/api/tasks`,
            { title, description, due_date, priority },
            authConfig
        );
        return JSON.stringify(data);
    },
    {
        name: "create_task",
        description: "Create a new task.",
        schema: z.object({
            title: z.string().describe("Task title."),
            description: z.string().optional().describe("Optional context."),
            due_date: z.string().optional().describe("Due date in YYYY-MM-DD format."),
            priority: z.enum(["low", "medium", "high"]).optional().describe("Defaults to medium."),
        }),
    }
);
export const deleteTasksTool = tool(
    async ({ task_ids }, config: RunnableConfig) => {
        const credentials = config.configurable?.credentials;
        const authConfig = await getAuthHeaders(credentials);
        const { data } = await http.delete(`${SERVICES.task}/api/tasks`, {
            ...authConfig,
            data: { task_ids },
        });
        return JSON.stringify(data);
    },
    {
        name: "delete_tasks",
        description: "Delete one or more tasks by their task IDs.",
        schema: z.object({
            task_ids: z.array(z.string()).describe("List of task IDs to delete."),
        }),
    }
);
export const getEmailsTool = tool(
    async ({ filter = "unread" }, config: RunnableConfig) => {
        const credentials = config.configurable?.credentials;
        const authConfig = await getAuthHeaders(credentials);
        const { data } = await http.get(`${SERVICES.email}/api/emails`, {
            ...authConfig,
            timeout: EMAIL_TIMEOUT_MS,
            params: { filter },
        });
        return JSON.stringify(data);
    },
    {
        name: "get_emails",
        description: 'Fetch emails. Use "unread", "read", or "all".',
        schema: z.object({
            filter: z.enum(["unread", "read", "all"]).optional()
                .describe('Filter by read status. Defaults to "unread".'),
        }),
    }
);
export const readEmailTool = tool(
    async ({ email_id }, config: RunnableConfig) => {
        const credentials = config.configurable?.credentials;
        const authConfig = await getAuthHeaders(credentials);
        const { data } = await http.get(
            `${SERVICES.email}/api/emails/${encodeURIComponent(email_id)}`,
            { ...authConfig, timeout: EMAIL_TIMEOUT_MS }
        );
        return JSON.stringify(data);
    },
    {
        name: "read_email",
        description: "Fetch the full content of a specific email by its ID (from get_emails).",
        schema: z.object({
            email_id: z.string().describe("The Gmail message ID returned by get_emails."),
        }),
    }
);
// ── Exported array for graph.ts ───────────────────────────────────────────────
export const TOOLS = [
    listCalendarEventsTool,
    createCalendarEventTool,
    getCalendarEventTool,
    deleteCalendarEventTool,
    getTasksTool,
    createTaskTool,
    deleteTasksTool,
    getEmailsTool,
    readEmailTool,
];