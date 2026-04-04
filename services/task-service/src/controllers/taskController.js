import { fetchGoogleTasks, createGoogleTask, deleteGoogleTasks } from "../services/googleTaskService.js";

const VALID_STATUSES = new Set(["pending", "completed", "all"]);

function sendError(res, err) {
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

export async function handleGetTasks(req, res) {
  const statusFilter = req.query.status ?? "pending";

  if (!VALID_STATUSES.has(statusFilter)) {
    return res.status(400).json({
      error: `Invalid 'status' value. Allowed: pending, completed, all.`,
    });
  }

  try {
    const payload = await fetchGoogleTasks(req.headers.authorization, statusFilter);
    return res.status(200).json(payload);
  } catch (err) {
    return sendError(res, err);
  }
}

export async function handleCreateTask(req, res) {
  const { title, description = "", due_date } = req.body ?? {};

  if (!title) {
    return res.status(400).json({ error: "Missing required field: title." });
  }

  if (due_date && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) {
    return res.status(400).json({ error: "Invalid 'due_date' format. Expected: YYYY-MM-DD." });
  }

  try {
    const body = await createGoogleTask(req.headers.authorization, { title, description, due_date });
    return res.status(201).json(body);
  } catch (err) {
    return sendError(res, err);
  }
}

function parseTaskIds(reqBody) {
  const taskIds = reqBody?.task_ids;
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

export async function handleDeleteTasks(req, res) {
  const parsed = parseTaskIds(req.body);
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }

  try {
    const body = await deleteGoogleTasks(req.headers.authorization, parsed.taskIds);
    return res.status(200).json(body);
  } catch (err) {
    return sendError(res, err);
  }
}
