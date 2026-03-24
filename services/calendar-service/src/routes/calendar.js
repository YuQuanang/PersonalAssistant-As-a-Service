import { Router } from "express";
import { google } from "googleapis";

const router = Router();
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID ?? "primary";
const CALENDAR_TIMEZONE = process.env.CALENDAR_TIMEZONE ?? "UTC";
const WORK_START_HOUR = Number.parseInt(process.env.CALENDAR_WORK_START_HOUR ?? "9", 10);
const WORK_END_HOUR = Number.parseInt(process.env.CALENDAR_WORK_END_HOUR ?? "17", 10);

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

function toDayRangeUtc(date) {
  const timeMin = `${date}T00:00:00.000Z`;
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  const timeMax = d.toISOString();
  return { timeMin, timeMax };
}

function toSlotIso(date, hour, minute = 0) {
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return `${date}T${hh}:${mm}:00.000Z`;
}

function slotOverlapsBusy(slotStartIso, slotEndIso, busy = []) {
  const slotStart = Date.parse(slotStartIso);
  const slotEnd = Date.parse(slotEndIso);

  return busy.some((b) => {
    const busyStart = Date.parse(b.start);
    const busyEnd = Date.parse(b.end);
    return slotStart < busyEnd && busyStart < slotEnd;
  });
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
  if (err?.response?.status) {
    return res.status(err.response.status).json({
      error: err.response.data?.error?.message ?? "Google Calendar request failed.",
    });
  }
  return res.status(500).json({ error: err?.message ?? "Unknown calendar service error." });
}

// ── GET /api/availability?date=YYYY-MM-DD ────────────────────────────────────
router.get("/availability", async (req, res) => {
  const { date } = req.query;

  if (!isValidDate(date)) {
    return res.status(400).json({
      error: "Invalid or missing 'date' query parameter. Expected format: YYYY-MM-DD.",
    });
  }

  try {
    const calendar = getCalendarClient(req);
    const { timeMin, timeMax } = toDayRangeUtc(date);

    const freeBusy = await calendar.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        timeZone: CALENDAR_TIMEZONE,
        items: [{ id: GOOGLE_CALENDAR_ID }],
      },
    });

    const busy = freeBusy.data.calendars?.[GOOGLE_CALENDAR_ID]?.busy ?? [];
    const available = [];

    for (let hour = WORK_START_HOUR; hour < WORK_END_HOUR; hour++) {
      const startIso = toSlotIso(date, hour, 0);
      const endIso = toSlotIso(date, hour + 1, 0);
      if (!slotOverlapsBusy(startIso, endIso, busy)) {
        available.push({
          start: `${String(hour).padStart(2, "0")}:00`,
          end: `${String(hour + 1).padStart(2, "0")}:00`,
        });
      }
    }

    return res.status(200).json({ date, available_slots: available });
  } catch (err) {
    console.error("[calendar-service] Availability error:", err.message);
    return sendCalendarError(res, err);
  }
});

// ── POST /api/meetings ────────────────────────────────────────────────────────
router.post("/meetings", async (req, res) => {
  const { title, date, start, end, attendees = [] } = req.body ?? {};

  // Validate required fields.
  const missing = ["title", "date", "start", "end"].filter((f) => !req.body?.[f]);
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
    const startDateTime = `${date}T${start}:00`;
    const endDateTime = `${date}T${end}:00`;

    // Defensive conflict check before insert.
    const existing = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      timeMin: new Date(`${date}T${start}:00.000Z`).toISOString(),
      timeMax: new Date(`${date}T${end}:00.000Z`).toISOString(),
      singleEvents: true,
      maxResults: 1,
      orderBy: "startTime",
    });

    if ((existing.data.items?.length ?? 0) > 0) {
      return res.status(409).json({
        error: `The requested time slot (${start}–${end}) is already booked.`,
      });
    }

    const created = await calendar.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      requestBody: {
        summary: title,
        start: { dateTime: startDateTime, timeZone: CALENDAR_TIMEZONE },
        end: { dateTime: endDateTime, timeZone: CALENDAR_TIMEZONE },
        attendees: Array.isArray(attendees)
          ? attendees.filter((a) => typeof a === "string" && a.trim() !== "").map((email) => ({ email }))
          : [],
      },
    });

    return res.status(201).json({
      id: created.data.id,
      title,
      date,
      start,
      end,
      attendees: Array.isArray(attendees) ? attendees : [attendees],
      status: "confirmed",
    });
  } catch (err) {
    if (err?.response?.status === 409) {
      return res.status(409).json({
        error: `The requested time slot (${start}–${end}) is already booked.`,
      });
    }
    console.error("[calendar-service] Book meeting error:", err.message);
    return sendCalendarError(res, err);
  }
});

export default router;
