import { Router } from "express";
import { google } from "googleapis";
import { tasks, nextTaskId, VALID_PRIORITIES, VALID_STATUSES } from "../data/dummy.js";

const router = Router();
const TASKS_SOURCE = (process.env.TASKS_SOURCE ?? "google").toLowerCase();
const TASKS_FALLBACK_TO_DUMMY = /^(1|true|yes)$/i.test(
  process.env.TASKS_FALLBACK_TO_DUMMY ?? "true"
);
const GOOGLE_TASKLIST_ID = process.env.GOOGLE_TASKLIST_ID ?? "@default";
const PRIORITY_PREFIX = "PAAS_PRIORITY:";

function isUsingGoogleTasks() {
  return TASKS_SOURCE === "google";
}

function getTasksClient(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    const err = new Error("Missing or invalid Authorization header");
    err.status = 401;
    throw err;
  }

  const token = authHeader.split(" ")[1];
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: token });

  return google.tasks({ version: "v1", auth: oauth2Client });
}

function splitPriorityAndDescription(notes = "") {
  if (!notes || typeof notes !== "string") {
    return { priority: "medium", description: "" };
  }

  const firstLine = notes.split("\n", 1)[0].trim();
  if (!firstLine.startsWith(PRIORITY_PREFIX)) {
    return { priority: "medium", description: notes.trim() };
  }

  const rawPriority = firstLine.slice(PRIORITY_PREFIX.length).trim().toLowerCase();
  const priority = VALID_PRIORITIES.has(rawPriority) ? rawPriority : "medium";
  const description = notes.slice(firstLine.length).trim();
  return { priority, description };
}

function buildGoogleNotes({ description = "", priority = "medium" }) {
  const cleanDescription = String(description).trim();
  return cleanDescription
    ? `${PRIORITY_PREFIX}${priority}\n\n${cleanDescription}`
    : `${PRIORITY_PREFIX}${priority}`;
}

function mapGoogleTaskToPaaS(task) {
  const { priority, description } = splitPriorityAndDescription(task.notes ?? "");
  const dueDate = typeof task.due === "string" ? task.due.slice(0, 10) : null;
  return {
    id: task.id,
    title: task.title ?? "Untitled",
    description,
    due_date: dueDate,
    priority,
    status: task.status === "completed" ? "completed" : "pending",
    created_at: task.updated ?? null,
  };
}

function shouldFallbackToDummy(err) {
  if (!TASKS_FALLBACK_TO_DUMMY) return false;
  if (err?.status === 401 || err?.status === 403) return true;

  const httpStatus = err?.response?.status;
  if (httpStatus === 401 || httpStatus === 403) return true;

  const code = err?.code;
  return code === "ECONNREFUSED" || code === "ECONNABORTED" || code === "ETIMEDOUT";
}

function sendGoogleError(res, err) {
  if (err?.status) {
    return res.status(err.status).json({ error: err.message });
  }

  if (err?.response?.status) {
    return res.status(err.response.status).json({
      error: err.response.data?.error?.message ?? "Google Tasks request failed.",
    });
  }

  return res.status(500).json({ error: err?.message ?? "Unknown task service error." });
}

async function getTasksFromGoogle(req, statusFilter) {
  const tasksClient = getTasksClient(req);
  const { data } = await tasksClient.tasks.list({
    tasklist: GOOGLE_TASKLIST_ID,
    showCompleted: statusFilter !== "pending",
    showHidden: true,
    maxResults: 100,
  });

  const googleTasks = data.items ?? [];
  const mapped = googleTasks.map(mapGoogleTaskToPaaS);

  const filtered =
    statusFilter === "all"
      ? mapped
      : mapped.filter((task) => task.status === statusFilter);

  return { tasks: filtered, total: filtered.length };
}

async function createTaskInGoogle(req) {
  const { title, description = "", due_date, priority = "medium" } = req.body ?? {};

  if (!title) {
    return { status: 400, body: { error: "Missing required field: title." } };
  }

  if (priority && !VALID_PRIORITIES.has(priority)) {
    return {
      status: 400,
      body: { error: `Invalid 'priority' value. Allowed: low, medium, high.` },
    };
  }

  if (due_date && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) {
    return {
      status: 400,
      body: { error: "Invalid 'due_date' format. Expected: YYYY-MM-DD." },
    };
  }

  const tasksClient = getTasksClient(req);
  const { data } = await tasksClient.tasks.insert({
    tasklist: GOOGLE_TASKLIST_ID,
    requestBody: {
      title,
      notes: buildGoogleNotes({ description, priority }),
      due: due_date ? `${due_date}T00:00:00.000Z` : undefined,
    },
  });

  return { status: 201, body: mapGoogleTaskToPaaS(data) };
}

function getTasksFromDummy(statusFilter) {
  const filtered =
    statusFilter === "all"
      ? tasks
      : tasks.filter((t) => t.status === statusFilter);

  return { tasks: filtered, total: filtered.length };
}

function createTaskInDummy(req) {
  const { title, description = "", due_date, priority = "medium" } = req.body ?? {};

  if (!title) {
    return { status: 400, body: { error: "Missing required field: title." } };
  }

  if (priority && !VALID_PRIORITIES.has(priority)) {
    return {
      status: 400,
      body: { error: `Invalid 'priority' value. Allowed: low, medium, high.` },
    };
  }

  if (due_date && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) {
    return {
      status: 400,
      body: { error: "Invalid 'due_date' format. Expected: YYYY-MM-DD." },
    };
  }

  const newTask = {
    id: nextTaskId(),
    title,
    description,
    due_date: due_date ?? null,
    priority,
    status: "pending",
    created_at: new Date().toISOString(),
  };

  tasks.push(newTask);
  return { status: 201, body: newTask };
}

// ── GET /api/tasks?status=pending|completed|all ───────────────────────────────
router.get("/", async (req, res) => {
  const statusFilter = req.query.status ?? "pending";

  if (!VALID_STATUSES.has(statusFilter)) {
    return res.status(400).json({
      error: `Invalid 'status' value. Allowed: pending, completed, all.`,
    });
  }

  if (!isUsingGoogleTasks()) {
    return res.status(200).json(getTasksFromDummy(statusFilter));
  }

  try {
    const payload = await getTasksFromGoogle(req, statusFilter);
    return res.status(200).json(payload);
  } catch (err) {
    if (shouldFallbackToDummy(err)) {
      return res.status(200).json(getTasksFromDummy(statusFilter));
    }
    return sendGoogleError(res, err);
  }
});

// ── POST /api/tasks ───────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  if (!isUsingGoogleTasks()) {
    const result = createTaskInDummy(req);
    return res.status(result.status).json(result.body);
  }

  try {
    const result = await createTaskInGoogle(req);
    return res.status(result.status).json(result.body);
  } catch (err) {
    if (shouldFallbackToDummy(err)) {
      const result = createTaskInDummy(req);
      return res.status(result.status).json(result.body);
    }
    return sendGoogleError(res, err);
  }
});

export default router;
