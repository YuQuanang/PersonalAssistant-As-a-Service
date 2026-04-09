# Personal Assistant-as-a-Service (PAaaS)

PAaaS is a local-first assistant platform with a React client, an Ollama-powered orchestrator, and three backend microservices (Calendar, Tasks, Email). The orchestrator converts user requests into tool calls and returns a natural-language response.

## Architecture

```
Browser (React client :5173)
          |
          v
Orchestrator API :3000 (LangGraph + Ollama)
          |
          +--> Calendar Service :3001
          +--> Task Service     :3002
          +--> Email Service    :3003
```

## Project Structure

```
PersonalAssistant-As-a-Service/
├── client/                      # React + Vite frontend
├── orchestrator/                # Auth + chat orchestration + tool calling
│   └── src/
│       ├── index.js             # Express API (auth, chat, session endpoints)
│       ├── graph.ts             # LangGraph agent flow
│       ├── tools.ts             # Tool definitions (calendar/task/email)
│       ├── prompt.md            # System prompt and tool-use rules
│       ├── auth.js              # Google OAuth helpers
│       └── config.js            # Env + service URLs + timeouts
├── services/
│   ├── calendar-service/        # Calendar CRUD operations
│   ├── task-service/            # Task list/create/delete/complete
│   └── email-service/           # Email list and read
└── scripts/                     # Utility scripts
```

## Current Tool Set

- Calendar: list_calendar_events, create_calendar_event, update_calendar_event, delete_calendar_event
- Tasks: get_tasks, create_task, delete_tasks, complete_tasks
- Email: get_emails, read_email

## Prerequisites

- Node.js 18+
- Ollama installed and available in PATH
- Google OAuth app credentials (for sign-in and Google API access)

## Quick Start

1. Install dependencies from repo root:

```bash
npm install
npm run install:all
```

2. Create orchestrator env file:

```bash
cp orchestrator/.env.example orchestrator/.env
```

3. Update required auth settings in orchestrator/.env:

- GOOGLE_CLIENT_ID
- GOOGLE_CLIENT_SECRET
- GOOGLE_REDIRECT_URI (recommended: http://localhost:3000/api/auth/google/callback)

4. Pull and run Ollama model:

```bash
ollama pull llama3.1
ollama serve
```

5. Start full stack (backend + frontend):

```bash
npm start
```

Useful alternatives:

```bash
# backend services only (calendar, task, email, orchestrator)
npm run start:backend

# frontend build
npm run build:client
```

## Runtime Ports

- Client UI: http://localhost:5173
- Orchestrator: http://localhost:3000
- Calendar Service: http://localhost:3001
- Task Service: http://localhost:3002
- Email Service: http://localhost:3003

## API Overview

### Orchestrator (:3000)

- GET /health
- POST /api/chat
- POST /api/chat/session/end
- GET /api/auth/google
- GET /api/auth/google/switch
- GET /api/auth/google/callback
- GET /api/auth/status
- GET /api/auth/profile
- POST /api/auth/logout

### Calendar Service (:3001)

- GET /health
- GET /api/events?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
- POST /api/events
- PUT /api/events/:eventId
- DELETE /api/events  (body: { eventIds: string[] })

### Task Service (:3002)

- GET /health
- GET /api/tasks?status=pending|completed|all
- POST /api/tasks
- DELETE /api/tasks  (body: { task_ids: string[] })
- PATCH /api/tasks/complete  (body: { task_ids: string[] })

### Email Service (:3003)

- GET /health
- GET /api/emails?filter=unread|read|all
- GET /api/emails/:emailId

## Example Prompts

- What are my pending tasks?
- Mark the task "Submit expenses" as complete.
- Do I have any events this week?
- Create a calendar event tomorrow from 14:00 to 15:00 called Team Sync.
- Show my unread emails.
- Summarize the first unread email.

## Configuration

Main orchestrator env vars:

- PORT (default: 3000)
- OLLAMA_BASE_URL (default: http://localhost:11434)
- OLLAMA_MODEL (default in code: llama3.1)
- OLLAMA_TIMEOUT_MS (default: 120000)
- SERVICE_TIMEOUT_MS (default: 5000)
- EMAIL_TOOL_TIMEOUT_MS (default: 15000)
- CALENDAR_SERVICE_URL (default: http://localhost:3001)
- TASK_SERVICE_URL (default: http://localhost:3002)
- EMAIL_SERVICE_URL (default: http://localhost:3003)
- GOOGLE_CLIENT_ID
- GOOGLE_CLIENT_SECRET
- GOOGLE_REDIRECT_URI
- FRONTEND_ORIGIN (optional)
- ALLOWED_FRONTEND_ORIGINS (optional, comma-separated)

Service-specific env vars:

- GOOGLE_CALENDAR_ID (default: primary)
- CALENDAR_TIMEZONE (default: Asia/Singapore)
- CALENDAR_TIMEZONE_OFFSET (default: +08:00)
- CALENDAR_TIMEZONE_LABEL (default: GMT+8)
- CALENDAR_LIST_MAX_RESULTS (default: 250)
- GOOGLE_TASKLIST_ID (default: @default)
