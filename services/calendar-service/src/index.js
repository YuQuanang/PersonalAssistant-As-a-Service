import express from "express";
import calendarRouter from "./routes/calendar.js";

const app = express();
const PORT = 3001;

app.use(express.json());

// Request logger
app.use((req, res, next) => {
  console.log(`[calendar-service] ${req.method} ${req.url}`);
  next();
});

// Health check
app.get("/health", (_req, res) => res.json({ service: "calendar-service", status: "ok" }));

app.use("/api", calendarRouter);

// 404 catch-all
app.use((_req, res) => res.status(404).json({ error: "Route not found." }));

app.listen(PORT, () => {
  console.log(`[calendar-service] Running on http://localhost:${PORT}`);
});
