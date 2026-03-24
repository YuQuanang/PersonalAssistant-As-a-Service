import { Router } from "express";
import { google } from "googleapis";
const VALID_PRIORITIES = new Set(["low", "medium", "high"]);
const VALID_STATUSES = new Set(["pending", "completed", "all"]);

const router = Router();
const GOOGLE_TASKLIST_ID = process.env.GOOGLE_TASKLIST_ID ?? "@default";
const PRIORITY_PREFIX = "PAAS_PRIORITY:";

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

function parseTaskIds(req) {
  const taskIds = req.body?.task_ids;
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    return { ok: false, error: "Missing required field: task_ids (non-empty array)." };
  }

  const sanitized = [...new Set(
    taskIds
      .filter((id) => typeof id === "string")
      .map((id) => id.trim())
      .filter(Boolean)
  )];

  if (sanitized.length === 0) {
    return { ok: false, error: "task_ids must contain at least one valid task ID." };
  }

  return { ok: true, taskIds: sanitized };
}

async function deleteTasksInGoogle(req) {
  const parsed = parseTaskIds(req);
  if (!parsed.ok) {
    return { status: 400, body: { error: parsed.error } };
  }

  const tasksClient = getTasksClient(req);
  const deleted_ids = [];
  const not_found_ids = [];

  for (const taskId of parsed.taskIds) {
    try {
      await tasksClient.tasks.delete({ tasklist: GOOGLE_TASKLIST_ID, task: taskId });
      deleted_ids.push(taskId);
    } catch (err) {
      const status = err?.response?.status;
      if (status === 404) {
        not_found_ids.push(taskId);
        continue;
      }
      throw err;
    }
  }

  return {
    status: 200,
    body: {
      deleted_count: deleted_ids.length,
      deleted_ids,
      not_found_ids,
    },
  };
}


// ── GET /api/tasks?status=pending|completed|all ───────────────────────────────
router.get("/", async (req, res) => {
  const statusFilter = req.query.status ?? "pending";

  if (!VALID_STATUSES.has(statusFilter)) {
    return res.status(400).json({
      error: `Invalid 'status' value. Allowed: pending, completed, all.`,
    });
  }

  try {
    const payload = await getTasksFromGoogle(req, statusFilter);
    return res.status(200).json(payload);
  } catch (err) {
    return sendGoogleError(res, err);
  }
});

// ── POST /api/tasks ───────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const result = await createTaskInGoogle(req);
    return res.status(result.status).json(result.body);
  } catch (err) {
    return sendGoogleError(res, err);
  }
});

// ── DELETE /api/tasks ─────────────────────────────────────────────────────────
router.delete("/", async (req, res) => {
  try {
    const result = await deleteTasksInGoogle(req);
    return res.status(result.status).json(result.body);
  } catch (err) {
    return sendGoogleError(res, err);
  }
});

export default router;
