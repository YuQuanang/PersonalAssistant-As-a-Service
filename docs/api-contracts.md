# PAaaS API Contracts

All services communicate via **JSON over HTTP**. No service shares a database or internal code with another. All bodies use `Content-Type: application/json`.

---

## Port Map

| Service              | Port |
|----------------------|------|
| Orchestrator         | 3000 |
| Calendar Service     | 3001 |
| Task Service         | 3002 |
| Email Service        | 3003 |

---

## 1. Calendar Scheduling Service — `http://localhost:3001`

### `GET /api/availability`

Check available time slots on a given date.

**Query Parameters**

| Param  | Type   | Required | Description              |
|--------|--------|----------|--------------------------|
| `date` | string | Yes      | Target date `YYYY-MM-DD` |

**Success Response `200 OK`**
```json
{
  "date": "2026-03-10",
  "available_slots": [
    { "start": "09:00", "end": "10:00" },
    { "start": "11:00", "end": "12:00" },
    { "start": "14:00", "end": "15:00" }
  ]
}
```

**Error Response `400 Bad Request`** — missing or malformed `date`
```json
{ "error": "Invalid or missing 'date' query parameter. Expected format: YYYY-MM-DD." }
```

---

### `POST /api/meetings`

Book a meeting in an available slot.

**Request Body**
```json
{
  "title": "Sync with Alice",
  "date": "2026-03-10",
  "start": "09:00",
  "end": "10:00",
  "attendees": ["alice@example.com"]
}
```

| Field       | Type            | Required | Description                     |
|-------------|-----------------|----------|---------------------------------|
| `title`     | string          | Yes      | Meeting title                   |
| `date`      | string          | Yes      | Date `YYYY-MM-DD`               |
| `start`     | string          | Yes      | Start time `HH:MM` (24h)        |
| `end`       | string          | Yes      | End time `HH:MM` (24h)          |
| `attendees` | array\<string\> | No       | List of attendee email addresses |

**Success Response `201 Created`**
```json
{
  "id": "mtg_a1b2c3",
  "title": "Sync with Alice",
  "date": "2026-03-10",
  "start": "09:00",
  "end": "10:00",
  "attendees": ["alice@example.com"],
  "status": "confirmed"
}
```

**Error Response `409 Conflict`** — slot already booked
```json
{ "error": "The requested time slot (09:00–10:00) is already booked." }
```

**Error Response `400 Bad Request`** — missing required fields
```json
{ "error": "Missing required fields: title, date, start, end." }
```

---

## 2. Task Management Service — `http://localhost:3002`

### `GET /api/tasks`

Retrieve tasks, optionally filtered by status.

**Query Parameters**

| Param    | Type   | Required | Values                          | Default   |
|----------|--------|----------|---------------------------------|-----------|
| `status` | string | No       | `pending` \| `completed` \| `all` | `pending` |

**Success Response `200 OK`**
```json
{
  "tasks": [
    {
      "id": "task_001",
      "title": "Prepare Q1 report",
      "description": "Compile sales and revenue data for Q1.",
      "due_date": "2026-03-15",
      "priority": "high",
      "status": "pending"
    },
    {
      "id": "task_002",
      "title": "Review PR #42",
      "description": "Review the authentication refactor pull request.",
      "due_date": "2026-03-12",
      "priority": "medium",
      "status": "pending"
    }
  ],
  "total": 2
}
```

---

### `POST /api/tasks`

Create a new task.

**Request Body**
```json
{
  "title": "Schedule dentist appointment",
  "description": "Book appointment for next week.",
  "due_date": "2026-03-16",
  "priority": "low"
}
```

| Field         | Type   | Required | Values                          |
|---------------|--------|----------|---------------------------------|
| `title`       | string | Yes      | Task title                      |
| `description` | string | No       | Additional context              |
| `due_date`    | string | No       | Due date `YYYY-MM-DD`           |
| `priority`    | string | No       | `low` \| `medium` \| `high`     |

**Success Response `201 Created`**
```json
{
  "id": "task_003",
  "title": "Schedule dentist appointment",
  "description": "Book appointment for next week.",
  "due_date": "2026-03-16",
  "priority": "low",
  "status": "pending",
  "created_at": "2026-03-09T10:00:00Z"
}
```

**Error Response `400 Bad Request`** — missing `title`
```json
{ "error": "Missing required field: title." }
```

---

## 3. Email Intelligence Service — `http://localhost:3003`

### `GET /api/emails`

Retrieve emails, optionally filtered by read status.

**Query Parameters**

| Param    | Type   | Required | Values              | Default  |
|----------|--------|----------|---------------------|----------|
| `filter` | string | No       | `unread` \| `all`   | `unread` |

**Success Response `200 OK`**
```json
{
  "emails": [
    {
      "id": "email_001",
      "from": "boss@company.com",
      "subject": "Q1 Budget Review",
      "preview": "Hi, please review the attached Q1 budget document and share your feedback...",
      "received_at": "2026-03-09T08:30:00Z",
      "read": false
    },
    {
      "id": "email_002",
      "from": "notifications@github.com",
      "subject": "PR #42 approved",
      "preview": "Your pull request has been approved by 2 reviewers.",
      "received_at": "2026-03-09T09:15:00Z",
      "read": false
    }
  ],
  "total_unread": 2
}
```

---

### `POST /api/emails/summarize`

Request an AI-generated plain-language summary of a specific email.

**Request Body**
```json
{
  "email_id": "email_001"
}
```

| Field      | Type   | Required | Description           |
|------------|--------|----------|-----------------------|
| `email_id` | string | Yes      | ID of the email to summarize |

**Success Response `200 OK`**
```json
{
  "email_id": "email_001",
  "subject": "Q1 Budget Review",
  "from": "boss@company.com",
  "summary": "Your boss is requesting that you review the Q1 budget document and provide feedback. No explicit deadline was mentioned, but the tone implies urgency."
}
```

**Error Response `404 Not Found`** — email ID does not exist
```json
{ "error": "Email with id 'email_999' not found." }
```

**Error Response `400 Bad Request`** — missing `email_id`
```json
{ "error": "Missing required field: email_id." }
```

---

## 4. Orchestrator Service — `http://localhost:3000`

### `POST /api/chat`

Send a natural language message to the AI agent. The orchestrator determines intent, calls the appropriate downstream service(s), and returns a synthesized response.

**Request Body**
```json
{
  "message": "What are my pending tasks and do I have any free time tomorrow?",
  "session_id": "user_session_abc"
}
```

| Field        | Type   | Required | Description                                |
|--------------|--------|----------|--------------------------------------------|
| `message`    | string | Yes      | The user's natural language request        |
| `session_id` | string | No       | Optional session identifier for context    |

**Success Response `200 OK`**
```json
{
  "response": "You have 2 pending tasks: 'Prepare Q1 report' (due Mar 15, high priority) and 'Review PR #42' (due Mar 12, medium priority). Tomorrow (Mar 10) you have three open slots: 9–10 AM, 11 AM–12 PM, and 2–3 PM.",
  "session_id": "user_session_abc",
  "tools_used": ["get_pending_tasks", "check_calendar_availability"]
}
```

**Error Response `502 Bad Gateway`** — a downstream service is unreachable
```json
{
  "response": "I was able to fetch your tasks, but I couldn't reach the Calendar Service right now. Please try again in a moment.",
  "session_id": "user_session_abc",
  "tools_used": ["get_pending_tasks"],
  "errors": [
    { "service": "calendar-service", "reason": "Service unavailable (connect ECONNREFUSED)" }
  ]
}
```

**Error Response `400 Bad Request`** — missing `message`
```json
{ "error": "Missing required field: message." }
```

**Error Response `504 Gateway Timeout`** — downstream service took too long
```json
{
  "response": "The Calendar Service took too long to respond. I wasn't able to check your availability. Your pending tasks are: ...",
  "session_id": "user_session_abc",
  "tools_used": ["get_pending_tasks"],
  "errors": [
    { "service": "calendar-service", "reason": "Request timed out after 5000ms" }
  ]
}
```
