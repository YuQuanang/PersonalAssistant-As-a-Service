import express from "express";
import tasksRouter from "./routes/tasks.js";

const app = express();
const PORT = 3002;

app.use(express.json());

// Health check
app.get("/health", (_req, res) => res.json({ service: "task-service", status: "ok" }));

app.use((req, res, next) => {
  console.log(`[task-service] ${req.method} ${req.originalUrl}`);
  if (req.method != "GET") {
    console.log(`[task-service] ${JSON.stringify(req.body)}`);
  }
  next();
});

app.use("/api/tasks", tasksRouter);

// 404 catch-all
app.use((_req, res) => res.status(404).json({ error: "Route not found." }));

app.listen(PORT, () => {
  console.log(`[task-service] Running on http://localhost:${PORT}`);
});
