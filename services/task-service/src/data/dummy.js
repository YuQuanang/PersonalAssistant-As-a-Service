// In-memory dummy tasks. Mutations persist for the lifetime of the process.

export const tasks = [
  {
    id: "task_001",
    title: "Prepare Q1 report",
    description: "Compile sales and revenue data for Q1.",
    due_date: "2026-03-15",
    priority: "high",
    status: "pending",
    created_at: "2026-03-01T09:00:00Z",
  },
  {
    id: "task_002",
    title: "Review PR #42",
    description: "Review the authentication refactor pull request.",
    due_date: "2026-03-12",
    priority: "medium",
    status: "pending",
    created_at: "2026-03-05T11:30:00Z",
  },
  {
    id: "task_003",
    title: "Update onboarding docs",
    description: "Revise the developer onboarding guide with new tooling steps.",
    due_date: "2026-03-08",
    priority: "low",
    status: "completed",
    created_at: "2026-02-28T08:00:00Z",
  },
];

const VALID_PRIORITIES = new Set(["low", "medium", "high"]);
const VALID_STATUSES = new Set(["pending", "completed", "all"]);

let taskCounter = tasks.length + 1;

export function nextTaskId() {
  return `task_${String(taskCounter++).padStart(3, "0")}`;
}

export { VALID_PRIORITIES, VALID_STATUSES };
