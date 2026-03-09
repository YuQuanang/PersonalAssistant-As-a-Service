import { Router } from "express";
import { tasks, nextTaskId, VALID_PRIORITIES, VALID_STATUSES } from "../data/dummy.js";

const router = Router();

// ── GET /api/tasks?status=pending|completed|all ───────────────────────────────
router.get("/", (req, res) => {
  const statusFilter = req.query.status ?? "pending";

  if (!VALID_STATUSES.has(statusFilter)) {
    return res.status(400).json({
      error: `Invalid 'status' value. Allowed: pending, completed, all.`,
    });
  }

  const filtered =
    statusFilter === "all"
      ? tasks
      : tasks.filter((t) => t.status === statusFilter);

  return res.status(200).json({ tasks: filtered, total: filtered.length });
});

// ── POST /api/tasks ───────────────────────────────────────────────────────────
router.post("/", (req, res) => {
  const { title, description = "", due_date, priority = "medium" } = req.body ?? {};

  if (!title) {
    return res.status(400).json({ error: "Missing required field: title." });
  }

  if (priority && !VALID_PRIORITIES.has(priority)) {
    return res.status(400).json({
      error: `Invalid 'priority' value. Allowed: low, medium, high.`,
    });
  }

  if (due_date && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) {
    return res.status(400).json({
      error: "Invalid 'due_date' format. Expected: YYYY-MM-DD.",
    });
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
  return res.status(201).json(newTask);
});

export default router;
