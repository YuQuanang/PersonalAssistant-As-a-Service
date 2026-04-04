import {
  isValidDate,
  isValidTime,
  getCurrentCalendarDate,
  getDateRange,
  buildEventDateTime,
  buildOffsetDateTime,
} from "../utils/dateUtils.js";
import { isValidEventId } from "../utils/validationUtils.js";
import { mapEventResponse } from "../utils/mapper.js";
import { sendCalendarError } from "../utils/errorHandler.js";
import {
  getCalendarClient,
  listEvents,
  checkSlotAvailability,
  insertEvent,
  getEvent,
  deleteEvent,
} from "../services/googleCalendarService.js";

const CALENDAR_TIMEZONE = process.env.CALENDAR_TIMEZONE ?? "Asia/Singapore";
const CALENDAR_TIMEZONE_LABEL = process.env.CALENDAR_TIMEZONE_LABEL ?? "GMT+8";
const LIST_EVENTS_MAX_RESULTS = Number.parseInt(
  process.env.CALENDAR_LIST_MAX_RESULTS ?? "250",
  10
);

export async function handleListEvents(req, res) {
  const requestedDate =
    typeof req.query.startDate === "string" && req.query.startDate.trim() !== ""
      ? req.query.startDate.trim()
      : getCurrentCalendarDate();

  const endDate = typeof req.query.endDate === "string" ? req.query.endDate.trim() : "";

  if (!isValidDate(requestedDate)) {
    return res.status(400).json({
      error: "Invalid 'startDate' query parameter. Expected format: YYYY-MM-DD.",
    });
  }

  if (endDate && !isValidDate(endDate)) {
    return res.status(400).json({
      error: "Invalid 'endDate' query parameter. Expected format: YYYY-MM-DD.",
    });
  }

  try {
    const calendar = getCalendarClient(req.headers.authorization);
    const { timeMin, timeMax } = getDateRange(requestedDate, endDate);

    const data = await listEvents(calendar, {
      timeMin,
      timeMax,
      timeZone: CALENDAR_TIMEZONE,
      maxResults: LIST_EVENTS_MAX_RESULTS,
    });

    const events = Array.isArray(data.items)
      ? data.items.map((event) => mapEventResponse(event))
      : [];

    return res.status(200).json({
      start_date: requestedDate,
      end_date: endDate || requestedDate,
      time_zone: CALENDAR_TIMEZONE_LABEL,
      events,
      total: events.length,
    });
  } catch (err) {
    console.error("[calendar-service] List events error:", err.message);
    return sendCalendarError(res, err);
  }
}

export async function handleCreateEvent(req, res) {
  const { title, date, start, end, description = "", location = "" } = req.body ?? {};

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
    const calendar = getCalendarClient(req.headers.authorization);
    const timeMin = buildOffsetDateTime(date, start);
    const timeMax = buildOffsetDateTime(date, end);

    const isAvailable = await checkSlotAvailability(calendar, {
      timeMin,
      timeMax,
      timeZone: CALENDAR_TIMEZONE,
    });

    if (!isAvailable) {
      return res.status(409).json({
        error: `The requested time slot (${start}-${end}) is already booked.`,
      });
    }

    const requestBody = {
      summary: title,
      description: typeof description === "string" ? description : "",
      ...(typeof location === "string" && location.trim() !== "" ? { location: location.trim() } : {}),
      start: buildEventDateTime(date, start),
      end: buildEventDateTime(date, end),
    };

    const createdData = await insertEvent(calendar, requestBody);

    return res.status(201).json(
      mapEventResponse(createdData, {
        title,
        description,
        location,
        date,
        start,
        end,
        status: "confirmed",
      })
    );
  } catch (err) {
    console.error("[calendar-service] Create event error:", err.message);
    return sendCalendarError(res, err);
  }
}

export async function handleGetEvent(req, res) {
  const { eventId } = req.params;

  if (!isValidEventId(eventId)) {
    return res.status(400).json({
      error: "Invalid or missing 'eventId' path parameter.",
    });
  }

  try {
    const calendar = getCalendarClient(req.headers.authorization);
    const eventData = await getEvent(calendar, {
      eventId,
      timeZone: CALENDAR_TIMEZONE,
    });

    return res.status(200).json(mapEventResponse(eventData));
  } catch (err) {
    console.error("[calendar-service] Get event error:", err.message);
    return sendCalendarError(res, err);
  }
}

export async function handleDeleteEvent(req, res) {
  const { eventIds } = req.body;

  if (!Array.isArray(eventIds) || eventIds.length === 0) {
    return res.status(400).json({
      error: "Invalid request. 'eventIds' must be a non-empty array.",
    });
  }

  try {
    const calendar = getCalendarClient(req.headers.authorization);

    const results = await Promise.allSettled(
      eventIds.map((id) => deleteEvent(calendar, { eventId: id }))
    );

    const successfulIds = results
      .filter((r) => r.status === "fulfilled")
      .map((_, index) => eventIds[index]);

    const failedIds = results
      .filter((r) => r.status === "rejected")
      .map((r, index) => ({ id: eventIds[index], reason: r.reason.message }));

    return res.status(200).json({
      deletedCount: successfulIds.length,
      failedCount: failedIds.length,
      deletedIds: successfulIds,
      failures: failedIds,
      status: failedIds.length === 0 ? "all_cleared" : "partial_success",
    })
  } catch (err) {
    console.error("[calendar-service] Bulk delete error:", err.message);
    return sendCalendarError(res, err);
  }
}
