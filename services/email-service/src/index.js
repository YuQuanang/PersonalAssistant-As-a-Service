import express from "express";
import emailsRouter from "./routes/emails.js";

const app = express();
const PORT = 3003;

app.use(express.json());

// Request logger
app.use((req, res, next) => {
  console.log(`[email-service] ${req.method} ${req.url}`);
  next();
});

// Health check
app.get("/health", (_req, res) => res.json({ service: "email-service", status: "ok" }));

app.use("/api/emails", emailsRouter);

// 404 catch-all
app.use((_req, res) => res.status(404).json({ error: "Route not found." }));

app.listen(PORT, () => {
  console.log(`[email-service] Running on http://localhost:${PORT}`);
});
