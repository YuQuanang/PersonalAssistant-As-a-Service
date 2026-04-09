import { google } from "googleapis";

const GOOGLE_TASKLIST_ID = process.env.GOOGLE_TASKLIST_ID ?? "@default";


function getTasksClient(authHeader) {
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

export function mapGoogleTaskToPaaS(task) {
  const dueDate = typeof task.due === "string" ? task.due.slice(0, 10) : null;
  return {
    id: task.id,
    title: task.title ?? "Untitled",
    description: (task.notes ?? "").trim(),
    due_date: dueDate,
    status: task.status === "completed" ? "completed" : "pending",
    created_at: task.updated ?? null,
  };
}

export async function fetchGoogleTasks(authHeader, statusFilter) {
  const tasksClient = getTasksClient(authHeader);
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

export async function createGoogleTask(authHeader, { title, description, due_date }) {
  const tasksClient = getTasksClient(authHeader);
  const { data } = await tasksClient.tasks.insert({
    tasklist: GOOGLE_TASKLIST_ID,
    requestBody: {
      title,
      notes: description ? String(description).trim() : undefined,
      due: due_date ? `${due_date}T00:00:00.000Z` : undefined,
    },
  });

  return mapGoogleTaskToPaaS(data);
}

export async function deleteGoogleTasks(authHeader, taskIds) {
  const tasksClient = getTasksClient(authHeader);
  const deleted_ids = [];
  const not_found_ids = [];

  for (const taskId of taskIds) {
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
    deleted_count: deleted_ids.length,
    deleted_ids,
    not_found_ids,
  };
}

export async function completeGoogleTasks(authHeader, taskIds) {
  const tasksClient = getTasksClient(authHeader);
  const completedTasks = [];
  const not_found_ids = [];

  for (const taskId of taskIds) {
    try {
      const { data } = await tasksClient.tasks.patch({
        tasklist: GOOGLE_TASKLIST_ID,
        task: taskId,
        requestBody: {
          status: "completed",
          completed: new Date().toISOString(),
        },
      });
      completedTasks.push(mapGoogleTaskToPaaS(data));
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
    completed_count: completedTasks.length,
    completed_ids: completedTasks.map((task) => task.id),
    not_found_ids,
    tasks: completedTasks,
  };
}
