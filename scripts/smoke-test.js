#!/usr/bin/env node
// Quick smoke test — starts all three services, hits every endpoint, then shuts them down.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = "/Users/angyuquan/Documents/PersonalAssistant-As-a-Service";

function startService(path) {
  const proc = spawn("node", [`${BASE}/${path}`], { stdio: "pipe" });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  return proc;
}

async function get(url) {
  const r = await fetch(url);
  return { status: r.status, body: await r.json() };
}

async function post(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

function pass(label, ok) {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) process.exitCode = 1;
}

const procs = [
  startService("services/calendar-service/src/index.js"),
  startService("services/task-service/src/index.js"),
  startService("services/email-service/src/index.js"),
];

await sleep(1000); // wait for ports to bind

try {
  // ── Health checks ──────────────────────────────────────────────────────────
  let r = await get("http://localhost:3001/health");
  pass("calendar health 200", r.status === 200);

  r = await get("http://localhost:3002/health");
  pass("task health 200", r.status === 200);

  r = await get("http://localhost:3003/health");
  pass("email health 200", r.status === 200);

  // ── Calendar ───────────────────────────────────────────────────────────────
  r = await get("http://localhost:3001/api/availability?date=2026-03-10");
  pass("GET availability 200", r.status === 200);
  pass("availability has slots", r.body.available_slots?.length > 0);

  r = await get("http://localhost:3001/api/availability");
  pass("GET availability missing date → 400", r.status === 400);

  r = await post("http://localhost:3001/api/meetings", {
    title: "Sync", date: "2026-03-10", start: "09:00", end: "10:00",
  });
  pass("POST meeting 201", r.status === 201);
  pass("meeting has id", typeof r.body.id === "string");

  r = await post("http://localhost:3001/api/meetings", {
    title: "Duplicate", date: "2026-03-10", start: "09:00", end: "10:00",
  });
  pass("POST duplicate meeting → 409", r.status === 409);

  r = await post("http://localhost:3001/api/meetings", { date: "2026-03-10", start: "09:00", end: "10:00" });
  pass("POST meeting missing title → 400", r.status === 400);

  // ── Tasks ──────────────────────────────────────────────────────────────────
  r = await get("http://localhost:3002/api/tasks");
  pass("GET tasks 200", r.status === 200);
  pass("tasks has pending items", r.body.tasks?.length > 0);

  r = await post("http://localhost:3002/api/tasks", { title: "Smoke task", priority: "low" });
  pass("POST task 201", r.status === 201);
  pass("task has id", typeof r.body.id === "string");

  r = await post("http://localhost:3002/api/tasks", {});
  pass("POST task missing title → 400", r.status === 400);

  // ── Emails ─────────────────────────────────────────────────────────────────
  r = await get("http://localhost:3003/api/emails");
  pass("GET emails 200", r.status === 200);
  pass("emails has unread items", r.body.emails?.length > 0);

  r = await post("http://localhost:3003/api/emails/summarize", { email_id: "email_001" });
  pass("POST summarize 200", r.status === 200);
  pass("summary has text", typeof r.body.summary === "string");

  r = await post("http://localhost:3003/api/emails/summarize", { email_id: "email_999" });
  pass("POST summarize unknown id → 404", r.status === 404);

  r = await post("http://localhost:3003/api/emails/summarize", {});
  pass("POST summarize missing email_id → 400", r.status === 400);

  console.log("\nAll smoke tests finished.");
} finally {
  procs.forEach((p) => p.kill());
}
