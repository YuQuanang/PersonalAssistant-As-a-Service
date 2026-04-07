import { google } from "googleapis";

const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID ?? "primary";

export function getCalendarClient(authHeader) {
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

export async function listEvents(calendar, { timeMin, timeMax, timeZone, maxResults }) {
  const response = await calendar.events.list({
    calendarId: GOOGLE_CALENDAR_ID,
    timeMin,
    timeMax,
    timeZone,
    singleEvents: true,
    showDeleted: false,
    orderBy: "startTime",
    maxResults,
  });
  return response.data;
}

export async function checkSlotAvailability(calendar, { timeMin, timeMax, timeZone, excludeEventId = null }) {
  const existing = await calendar.events.list({
    calendarId: GOOGLE_CALENDAR_ID,
    timeMin,
    timeMax,
    timeZone,
    singleEvents: true,
    showDeleted: false,
    maxResults: 10,
    orderBy: "startTime",
  });

  const items = (existing.data.items ?? []).filter(item => item.id !== excludeEventId);
  return items.length === 0;
}

export async function insertEvent(calendar, requestBody) {
  const created = await calendar.events.insert({
    calendarId: GOOGLE_CALENDAR_ID,
    requestBody,
  });
  return created.data;
}

export async function getEvent(calendar, { eventId, timeZone }) {
  const event = await calendar.events.get({
    calendarId: GOOGLE_CALENDAR_ID,
    eventId,
    timeZone,
  });
  return event.data;
}

export async function deleteEvent(calendar, { eventId }) {
  await calendar.events.delete({
    calendarId: GOOGLE_CALENDAR_ID,
    eventId,
  });
  return true;
}

export async function updateEvent(calendar, eventId, requestBody) {
  const response = await calendar.events.update({
    calendarId: GOOGLE_CALENDAR_ID,
    eventId,
    requestBody,
  });
  return response.data;
}