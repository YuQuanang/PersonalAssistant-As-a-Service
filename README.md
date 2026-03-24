# Personal Assistant-as-a-Service (PAaaS)

An event-driven microservices platform where an AI Orchestrator (powered by **Ollama** running locally) receives natural language requests and delegates tasks to three independent REST microservices.

## Architecture

```
User
 │
 ▼
┌─────────────────────────────────┐
│   Orchestrator  :3000           │  ← AI brain (Ollama / LLaMA 3)
│   POST /api/chat                │
└─────────┬───────────────────────┘
          │  HTTP (tool calls)
    ┌─────┼──────────┬────────────────┐
    ▼     ▼          ▼                ▼
┌───────┐ ┌────────┐ ┌─────────────┐ ┌──────────────┐
│Cal    │ │Task    │ │Email        │ │(future svc)  │
│:3001  │ │:3002   │ │:3003        │ │              │
└───────┘ └────────┘ └─────────────┘ └──────────────┘
```

## Directory Structure

```
PersonalAssistant-As-a-Service/
├── orchestrator/               # AI gateway — Ollama tool-calling agent
│   ├── src/
│   │   ├── index.js            # Express server entry point
│   │   ├── agent.js            # Ollama conversation & tool loop
│   │   ├── tools.js            # Tool definitions + HTTP dispatchers
│   │   └── config.js           # Ports, URLs, timeouts
│   ├── package.json
│   └── .env.example
│
├── services/
│   ├── calendar-service/       # Checks availability & books meetings  :3001
│   │   ├── src/
│   │   │   ├── index.js
│   │   │   └── routes/calendar.js
│   │   └── package.json
│   │
│   ├── task-service/           # Fetches & creates tasks               :3002
│   │   ├── src/
│   │   │   ├── index.js
│   │   │   ├── routes/tasks.js
│   │   └── package.json
│   │
│   └── email-service/          # Fetches emails & generates summaries   :3003
│       ├── src/
│       │   ├── index.js
│       │   └── routes/emails.js
│       └── package.json
│
└── docs/
    └── api-contracts.md        # Full JSON request/response specs
```

## Tech Stack

| Concern        | Choice                          |
|----------------|---------------------------------|
| Runtime        | Node.js (ES Modules)            |
| Framework      | Express 4                       |
| LLM            | Ollama (local) — LLaMA 3        |
| HTTP client    | Axios                           |
| Storage        | Google APIs (Calendar, Tasks, Gmail) |

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- [Ollama](https://ollama.com/) installed and available on your `PATH`

## Running the Full System

### Step 1 — Install dependencies

Run this once from the repo root:

```bash
npm install && npm run install:all
```

### Step 2 — Pull the LLM model

```bash
ollama pull llama3.1
```

> **Swap models:** Edit `orchestrator/.env` (copy from `.env.example`) and set `OLLAMA_MODEL` to any Ollama model that supports tool calling, e.g. `llama3.2` or `mistral`.

### Step 3 — Start Ollama

```bash
ollama serve
```

> Skip this if Ollama is already running as a background daemon.

### Step 4 — Start all four services

From the repo root, run a single command:

```bash
npm start
```

All four services start together in one terminal with color-coded, prefixed logs:

```
[calendar]     Running on http://localhost:3001
[task]         Running on http://localhost:3002
[email]        Running on http://localhost:3003
[orchestrator] Running on http://localhost:3000
[orchestrator] Chat UI → http://localhost:3000
```

> If any service crashes, all others are stopped automatically (`--kill-others-on-fail`).


Example questions to try:

| Question | Tools invoked |
|---|---|
| `"What are my pending tasks?"` | `get_tasks` |
| `"Do I have any free slots on 2026-03-10?"` | `check_calendar_availability` |
| `"Book a meeting called Standup on March 11 at 9am"` | `check_calendar_availability` → `book_meeting` |
| `"Summarise my unread emails"` | `get_emails` → `summarize_email` |
| `"Create a task to review the Q2 roadmap, high priority"` | `create_task` |
| `"What are my tasks AND do I have time tomorrow?"` | `get_tasks` + `check_calendar_availability` (parallel) |

### Configuration

All orchestrator settings can be overridden via environment variables. Copy the example file and edit as needed:

```bash
cp orchestrator/.env.example orchestrator/.env
```

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Orchestrator listen port |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `llama3.1` | Model name (must support tool calling) |
| `OLLAMA_TIMEOUT_MS` | `120000` | Max LLM response wait time (ms) |
| `SERVICE_TIMEOUT_MS` | `5000` | Per-request timeout for microservice calls (ms) |
| `CALENDAR_SERVICE_URL` | `http://localhost:3001` | Calendar service base URL |
| `TASK_SERVICE_URL` | `http://localhost:3002` | Task service base URL |
| `EMAIL_SERVICE_URL` | `http://localhost:3003` | Email service base URL |

Task service behavior can be configured with environment variables:

| Variable | Default | Description |
|---|---|---|
| `GOOGLE_TASKLIST_ID` | `@default` | Google Task List ID used for read/write |

Calendar service behavior can be configured with environment variables:

| Variable | Default | Description |
|---|---|---|
| `GOOGLE_CALENDAR_ID` | `primary` | Google Calendar ID used for availability checks and bookings |
| `CALENDAR_TIMEZONE` | `UTC` | Timezone used when creating calendar events |
| `CALENDAR_WORK_START_HOUR` | `9` | Start hour for hourly availability slots (24-hour) |
| `CALENDAR_WORK_END_HOUR` | `17` | End hour for hourly availability slots (24-hour, exclusive) |

## Smoke Tests

```bash
# Test all three microservices (no Ollama required)
node scripts/smoke-test.js

# Test the orchestrator structure (no Ollama required)
node scripts/orchestrator-test.js
```

## API Contracts

See [docs/api-contracts.md](docs/api-contracts.md) for full request/response payloads for all four services.
Cloud Computing Project
