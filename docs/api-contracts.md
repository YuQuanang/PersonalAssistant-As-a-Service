# PAaaS API Contracts

All services communicate via **JSON over HTTP**. No service shares a database or internal code with another. All bodies use `Content-Type: application/json`.

Authentication note:
- Calendar, Task, and Email services require a Google OAuth access token in the `Authorization` header.
- Format: `Authorization: Bearer <access_token>`

---

## Port Map

| Service              | Port |
|----------------------|------|
| Orchestrator         | 3000 |
| Calendar Service     | 3001 |
| Task Service         | 3002 |
| Email Service        | 3003 |

---

## 1. Calendar Event Service � `http://localhost:3001`

### `GET /api/events`

List calendar events for a specific date. If `date` is omitted, the service defaults to the current date in `GMT+8`.

**Query Parameters**

| Param  | Type   | Required | Description                         |
|--------|--------|----------|-------------------------------------|
| `date` | string | No       | Target date `YYYY-MM-DD` in `GMT+8` |

**Success Response `200 OK`**
```json
{
  "date": "2026-03-10",
  "time_zone": "GMT+8",
  "events": [
    {
      "id": "6q9j5n8u2h6qj2h1nqf9t5m3e0",
      "title": "Sync with Alice",
      "description": "Weekly project sync",
      "date": "2026-03-10",
      "start": "09:00",
      "end": "10:00",
      "attendees": ["alice@example.com"],
      "status": "confirmed",
      "time_zone": "GMT+8",
      "html_link": "https://calendar.google.com/calendar/event?eid=..."
    }
  ],
  "total": 1
}
```

**Error Response `400 Bad Request`**
```json
{ "error": "Invalid 'date' query parameter. Expected format: YYYY-MM-DD." }
```

---

### `POST /api/events`

Create a calendar event.

**Request Body**
```json
{
  "title": "Sync with Alice",
  "date": "2026-03-10",
  "start": "09:00",
  "end": "10:00",
  "description": "Weekly project sync",
  "attendees": ["alice@example.com"]
}
```

| Field         | Type            | Required | Description                      |
|---------------|-----------------|----------|----------------------------------|
| `title`       | string          | Yes      | Event title                      |
| `date`        | string          | Yes      | Date `YYYY-MM-DD`                |
| `start`       | string          | Yes      | Start time `HH:MM` (24h)         |
| `end`         | string          | Yes      | End time `HH:MM` (24h)           |
| `description` | string          | No       | Additional event details         |
| `attendees`   | array\<string\> | No       | List of attendee email addresses |

**Success Response `201 Created`**
```json
{
  "id": "6q9j5n8u2h6qj2h1nqf9t5m3e0",
  "title": "Sync with Alice",
  "description": "Weekly project sync",
  "date": "2026-03-10",
  "start": "09:00",
  "end": "10:00",
  "attendees": ["alice@example.com"],
  "status": "confirmed",
  "time_zone": "GMT+8",
  "html_link": "https://calendar.google.com/calendar/event?eid=..."
}
```

**Error Response `409 Conflict`** � slot already booked
```json
{ "error": "The requested time slot (09:00-10:00) is already booked." }
```

**Error Response `400 Bad Request`** � missing required fields
```json
{ "error": "Missing required fields: title, date, start, end." }
```

**Error Response `400 Bad Request`** � invalid time format/range
```json
{ "error": "Invalid 'start' or 'end' format. Expected: HH:MM (24-hour)." }
```

```json
{ "error": "Invalid time range. 'end' must be later than 'start'." }
```

---

### `GET /api/events/:eventId`

Retrieve a calendar event by its event ID.

**Path Parameters**

| Param     | Type   | Required | Description              |
|-----------|--------|----------|--------------------------|
| `eventId` | string | Yes      | Google Calendar event ID |

**Success Response `200 OK`**
```json
{
  "id": "6q9j5n8u2h6qj2h1nqf9t5m3e0",
  "title": "Sync with Alice",
  "description": "Weekly project sync",
  "date": "2026-03-10",
  "start": "09:00",
  "end": "10:00",
  "attendees": ["alice@example.com"],
  "status": "confirmed",
  "time_zone": "GMT+8",
  "html_link": "https://calendar.google.com/calendar/event?eid=..."
}
```

**Error Response `400 Bad Request`**
```json
{ "error": "Invalid or missing 'eventId' path parameter." }
```

**Error Response `404 Not Found`**
```json
{ "error": "Calendar event not found." }
```

---

### `DELETE /api/events/:eventId`

Delete a calendar event by its event ID.

**Path Parameters**

| Param     | Type   | Required | Description              |
|-----------|--------|----------|--------------------------|
| `eventId` | string | Yes      | Google Calendar event ID |

**Success Response `200 OK`**
```json
{
  "id": "6q9j5n8u2h6qj2h1nqf9t5m3e0",
  "deleted": true,
  "status": "cancelled",
  "time_zone": "GMT+8"
}
```

**Error Response `400 Bad Request`**
```json
{ "error": "Invalid or missing 'eventId' path parameter." }
```

**Error Response `404 Not Found`**
```json
{ "error": "Calendar event not found." }
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
      "id": "YzA5N2Q2NDU2ZTAzZjMwNQ",
      "title": "Prepare Q1 report",
      "description": "Compile sales and revenue data for Q1.",
      "due_date": "2026-03-15",
      "priority": "high",
      "status": "pending",
      "created_at": "2026-03-09T10:00:00.000Z"
    },
    {
      "id": "YzA5N2Q2NDU2ZTAzZjMwNg",
      "title": "Review PR #42",
      "description": "Review the authentication refactor pull request.",
      "due_date": "2026-03-12",
      "priority": "medium",
      "status": "pending",
      "created_at": "2026-03-09T10:05:00.000Z"
    }
  ],
  "total": 2
}
```

**Error Response `401 Unauthorized`**
```json
{ "error": "Unauthorized. Missing or invalid token." }
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
  "id": "YzA5N2Q2NDU2ZTAzZjMwNw",
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

### `DELETE /api/tasks`

Delete one or more tasks by ID.

**Request Body**
```json
{
  "task_ids": ["YzA5N2Q2NDU2ZTAzZjMwNQ", "YzA5N2Q2NDU2ZTAzZjMwNg"]
}
```

| Field      | Type            | Required | Description                          |
|------------|-----------------|----------|--------------------------------------|
| `task_ids` | array\<string\> | Yes      | Non-empty list of task IDs to delete |

**Success Response `200 OK`**
```json
{
  "deleted_count": 2,
  "deleted_ids": ["YzA5N2Q2NDU2ZTAzZjMwNQ", "YzA5N2Q2NDU2ZTAzZjMwNg"],
  "not_found_ids": []
}
```

**Partial Delete Example `200 OK`**
```json
{
  "deleted_count": 1,
  "deleted_ids": ["YzA5N2Q2NDU2ZTAzZjMwNQ"],
  "not_found_ids": ["unknown_task_id"]
}
```

**Error Response `400 Bad Request`** — invalid payload
```json
{ "error": "Missing required field: task_ids (non-empty array)." }
```

---

## 3. Email Intelligence Service — `http://localhost:3003`

### `GET /api/emails`

Retrieve emails, optionally filtered by read status.

**Query Parameters**

| Param    | Type   | Required | Values                         | Default  |
|----------|--------|----------|--------------------------------|----------|
| `filter` | string | No       | `unread` \| `read` \| `all`   | `unread` |

**Success Response `200 OK`**
```json
{
  "filter": "unread",
  "emails": [
    {
      "id": "1975f6ab2e0c1234",
      "from": "boss@company.com",
      "subject": "Q1 Budget Review",
      "preview": "Hi, please review the attached Q1 budget document and share your feedback..."
    },
    {
      "id": "1975f6ab2e0c5678",
      "from": "notifications@github.com",
      "subject": "PR #42 approved",
      "preview": "Your pull request has been approved by 2 reviewers."
    }
  ],
  "shown_count": 2,
  "total_count": 2,
  "total_unread": 2,
  "total_read": 14,
  "total_all": 16,
  "count_cap": 100
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
  "email_id": "1975f6ab2e0c1234",
  "subject": "Q1 Budget Review",
  "from": "boss@company.com",
  "received_at": "2026-03-09T08:30:00.000Z",
  "date_header": "Mon, 09 Mar 2026 08:30:00 +0000",
  "snippet": "Hi, please review the attached Q1 budget document and share your feedback...",
  "body_char_count": 7842,
  "summary": "Hi team, please review the attached Q1 budget and share feedback by Friday...",
  "body_text": "Hi team, please review the attached Q1 budget and share feedback by Friday..."
}
```

**Error Response `400 Bad Request`** — invalid `email_id`
```json
{ "error": "Invalid email_id. Use an ID returned by GET /api/emails." }
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
  "message": "What are my pending tasks and do I have any events for today?",
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
  "response": "You have 2 pending tasks: 'Prepare Q1 report' (due Mar 15, high priority) and 'Review PR #42' (due Mar 12, medium priority). You have 2 calendar events today in GMT+8: **Standup** from 9:00 AM to 10:00 AM and **Client Call** from 2:00 PM to 2:30 PM.",
  "session_id": "user_session_abc",
  "tools_used": ["get_tasks", "list_calendar_events"],
  "suggestions": [
    "Create a calendar event for today",
    "What are my pending tasks?",
    "Show my unread emails"
  ]
}
```

**Error Response `502 Bad Gateway`** — a downstream service is unreachable
```json
{
  "response": "I was able to fetch your tasks, but I couldn't reach the Calendar Service right now. Please try again in a moment.",
  "session_id": "user_session_abc",
  "tools_used": ["get_tasks"],
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
  "response": "The Calendar Service took too long to respond. I wasn't able to retrieve your calendar events for today. Your pending tasks are: ...",
  "session_id": "user_session_abc",
  "tools_used": ["get_tasks"],
  "errors": [
    { "service": "calendar-service", "reason": "Request timed out after 5000ms" }
  ]
}
```

---

### `POST /api/chat/session/end`

Clear one in-memory conversation session.

**Request Body**
```json
{
  "session_id": "user_session_abc"
}
```

**Success Response `200 OK`**
```json
{
  "cleared": true
}
```




