import { getDatePartsInCalendarTimeZone } from "./dateUtils.js";

const CALENDAR_TIMEZONE_LABEL = process.env.CALENDAR_TIMEZONE_LABEL ?? "GMT+8";

// Keeping normalizeAttendees around in case legacy events still fetch them
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

export function mapEventResponse(event, fallback = {}) {
  const startDateTime = event?.start?.dateTime ?? null;
  const endDateTime = event?.end?.dateTime ?? null;
  const zonedStart = startDateTime ? getDatePartsInCalendarTimeZone(startDateTime) : null;
  const zonedEnd = endDateTime ? getDatePartsInCalendarTimeZone(endDateTime) : null;

  return {
    id: event?.id ?? fallback.id ?? null,
    event_id: event?.id ?? fallback.id ?? null,
    title: event?.summary ?? fallback.title ?? "",
    description: event?.description ?? fallback.description ?? "",
    location: event?.location ?? fallback.location ?? "",
    date: event?.start?.date ?? zonedStart?.date ?? fallback.date ?? null,
    start: zonedStart?.time ?? fallback.start ?? null,
    end: zonedEnd?.time ?? fallback.end ?? null,
    status: event?.status ?? fallback.status ?? "confirmed",
    time_zone: CALENDAR_TIMEZONE_LABEL,
    html_link: event?.htmlLink ?? null,
  };
}
