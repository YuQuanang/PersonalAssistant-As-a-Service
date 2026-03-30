import { Router } from "express";
import { google } from "googleapis";

const router = Router();
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID ?? "primary";
const CALENDAR_TIMEZONE = process.env.CALENDAR_TIMEZONE ?? "Asia/Singapore";
const CALENDAR_TIMEZONE_LABEL = process.env.CALENDAR_TIMEZONE_LABEL ?? "GMT+8";
const CALENDAR_TIMEZONE_OFFSET = process.env.CALENDAR_TIMEZONE_OFFSET ?? "+08:00";
const LIST_EVENTS_MAX_RESULTS = Number.parseInt(
  process.env.CALENDAR_LIST_MAX_RESULTS ?? "250",
  10
);

function getCalendarClient(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    const err = new Error("Missing or invalid Authorization header");
    err.status = 401;
    throw err;
  }

  const token = authHeader.split(" ")[1];
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: token });

  return google.calendar({ version: "v3", auth: oauth2Client });
}

function isValidDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isValidTime(value) {
  return typeof value === "string" && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

function isValidEventId(value) {
  return typeof value === "string" && value.trim() !== "" && !/[/?#\s]/.test(value);
}

function getCurrentCalendarDate() {
  return shiftDateByOffset(new Date()).toISOString().slice(0, 10);
}

function shiftDateByOffset(date) {
  return new Date(date.getTime() + getCalendarOffsetMinutes() * 60 * 1000);
}

function getCalendarOffsetMinutes() {
  const match = CALENDAR_TIMEZONE_OFFSET.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match) return 8 * 60;

  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number.parseInt(match[2], 10);
  const minutes = Number.parseInt(match[3], 10);
  return sign * (hours * 60 + minutes);
}

function addDaysToIsoDate(date, days) {
  const base = new Date(`${date}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function buildOffsetDateTime(date, time = "00:00") {
  return `${date}T${time}:00${CALENDAR_TIMEZONE_OFFSET}`;
}

function buildEventDateTime(date, time) {
  return {
    dateTime: buildOffsetDateTime(date, time),
    timeZone: CALENDAR_TIMEZONE,
  };
}

function getDayRange(date) {
  return {
    timeMin: buildOffsetDateTime(date, "00:00"),
    timeMax: buildOffsetDateTime(addDaysToIsoDate(date, 1), "00:00"),
  };
}

function getDatePartsInCalendarTimeZone(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CALENDAR_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(date);

  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${lookup.year}-${lookup.month}-${lookup.day}`,
    time: `${lookup.hour}:${lookup.minute}`,
  };
}

function normalizeAttendees(attendees, fallback = []) {
  const normalized = Array.isArray(attendees)
    ? attendees
        .map((attendee) => attendee?.email)
        .filter((email) => typeof email === "string" && email.trim() !== "")
    : [];

  if (normalized.length > 0) {
    return normalized;
  }

  return Array.isArray(fallback)
    ? fallback.filter((email) => typeof email === "string" && email.trim() !== "")
    : [];
}

function mapEventResponse(event, fallback = {}) {
  const startDateTime = event?.start?.dateTime ?? null;
  const endDateTime = event?.end?.dateTime ?? null;
  const zonedStart = startDateTime ? getDatePartsInCalendarTimeZone(startDateTime) : null;
  const zonedEnd = endDateTime ? getDatePartsInCalendarTimeZone(endDateTime) : null;

  return {
    id: event?.id ?? fallback.id ?? null,
    title: event?.summary ?? fallback.title ?? "",
    description: event?.description ?? fallback.description ?? "",
    date: event?.start?.date ?? zonedStart?.date ?? fallback.date ?? null,
    start: zonedStart?.time ?? fallback.start ?? null,
    end: zonedEnd?.time ?? fallback.end ?? null,
    attendees: normalizeAttendees(event?.attendees, fallback.attendees),
    status: event?.status ?? fallback.status ?? "confirmed",
    time_zone: CALENDAR_TIMEZONE_LABEL,
    html_link: event?.htmlLink ?? null,
  };
}

function sendCalendarError(res, err) {
  if (err?.status === 401) {
    return res.status(401).json({ error: "Unauthorized. Missing or invalid token." });
  }
  if (err?.response?.status === 401) {
    return res.status(401).json({ error: "Unauthorized. Missing or invalid token." });
  }
  if (err?.response?.status === 403) {
    return res.status(403).json({ error: "Forbidden. Calendar scope or permissions missing." });
  }
  if (err?.response?.status === 404) {
    return res.status(404).json({ error: "Calendar event not found." });
  }
  if (err?.response?.status) {
    return res.status(err.response.status).json({
      error: err.response.data?.error?.message ?? "Google Calendar request failed.",
    });
  }
  return res.status(500).json({ error: err?.message ?? "Unknown calendar service error." });
}

// GET /api/events?date=YYYY-MM-DD
router.get("/events", async (req, res) => {
  const requestedDate =
    typeof req.query.date === "string" && req.query.date.trim() !== ""
      ? req.query.date.trim()
      : getCurrentCalendarDate();

  if (!isValidDate(requestedDate)) {
    return res.status(400).json({
      error: "Invalid 'date' query parameter. Expected format: YYYY-MM-DD.",
    });
  }

  try {
    const calendar = getCalendarClient(req);
    const { timeMin, timeMax } = getDayRange(requestedDate);

    const listed = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      timeMin,
      timeMax,
      timeZone: CALENDAR_TIMEZONE,
      singleEvents: true,
      showDeleted: false,
      orderBy: "startTime",
      maxResults: LIST_EVENTS_MAX_RESULTS,
    });

    const events = Array.isArray(listed.data.items)
      ? listed.data.items.map((event) => mapEventResponse(event))
      : [];

    return res.status(200).json({
      date: requestedDate,
      time_zone: CALENDAR_TIMEZONE_LABEL,
      events,
      total: events.length,
    });
  } catch (err) {
    console.error("[calendar-service] List events error:", err.message);
    return sendCalendarError(res, err);
  }
});

// POST /api/events
router.post("/events", async (req, res) => {
  const { title, date, start, end, description = "", attendees = [] } = req.body ?? {};

  const missing = ["title", "date", "start", "end"].filter((field) => !req.body?.[field]);
  if (missing.length > 0) {
    return res.status(400).json({
      error: `Missing required fields: ${missing.join(", ")}.`,
    });
  }

  if (!isValidDate(date)) {
    return res.status(400).json({
      error: "Invalid 'date' format. Expected: YYYY-MM-DD.",
    });
  }

  if (!isValidTime(start) || !isValidTime(end)) {
    return res.status(400).json({
      error: "Invalid 'start' or 'end' format. Expected: HH:MM (24-hour).",
    });
  }

  if (start >= end) {
    return res.status(400).json({
      error: "Invalid time range. 'end' must be later than 'start'.",
    });
  }

  try {
    const calendar = getCalendarClient(req);
    const timeMin = buildOffsetDateTime(date, start);
    const timeMax = buildOffsetDateTime(date, end);

    const existing = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      timeMin,
      timeMax,
      timeZone: CALENDAR_TIMEZONE,
      singleEvents: true,
      showDeleted: false,
      maxResults: 1,
      orderBy: "startTime",
    });

    if ((existing.data.items?.length ?? 0) > 0) {
      return res.status(409).json({
        error: `The requested time slot (${start}-${end}) is already booked.`,
      });
    }

    const created = await calendar.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      requestBody: {
        summary: title,
        description: typeof description === "string" ? description : "",
        start: buildEventDateTime(date, start),
        end: buildEventDateTime(date, end),
        attendees: Array.isArray(attendees)
          ? attendees
              .filter((email) => typeof email === "string" && email.trim() !== "")
              .map((email) => ({ email }))
          : [],
      },
    });

    return res.status(201).json(
      mapEventResponse(created.data, {
        title,
        description,
        date,
        start,
        end,
        attendees,
        status: "confirmed",
      })
    );
  } catch (err) {
    console.error("[calendar-service] Create event error:", err.message);
    return sendCalendarError(res, err);
  }
});

// GET /api/events/:eventId
router.get("/events/:eventId", async (req, res) => {
  const { eventId } = req.params;

  if (!isValidEventId(eventId)) {
    return res.status(400).json({
      error: "Invalid or missing 'eventId' path parameter.",
    });
  }

  try {
    const calendar = getCalendarClient(req);
    const event = await calendar.events.get({
      calendarId: GOOGLE_CALENDAR_ID,
      eventId,
      timeZone: CALENDAR_TIMEZONE,
    });

    return res.status(200).json(mapEventResponse(event.data));
  } catch (err) {
    console.error("[calendar-service] Get event error:", err.message);
    return sendCalendarError(res, err);
  }
});

// DELETE /api/events/:eventId
router.delete("/events/:eventId", async (req, res) => {
  const { eventId } = req.params;

  if (!isValidEventId(eventId)) {
    return res.status(400).json({
      error: "Invalid or missing 'eventId' path parameter.",
    });
  }

  try {
    const calendar = getCalendarClient(req);

    await calendar.events.delete({
      calendarId: GOOGLE_CALENDAR_ID,
      eventId,
    });

    return res.status(200).json({
      id: eventId,
      deleted: true,
      status: "cancelled",
      time_zone: CALENDAR_TIMEZONE_LABEL,
    });
  } catch (err) {
    console.error("[calendar-service] Delete event error:", err.message);
    return sendCalendarError(res, err);
  }
});

export default router;
