const CALENDAR_TIMEZONE_OFFSET = process.env.CALENDAR_TIMEZONE_OFFSET ?? "+08:00";
const CALENDAR_TIMEZONE = process.env.CALENDAR_TIMEZONE ?? "Asia/Singapore";

export function isValidDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function isValidTime(value) {
  return typeof value === "string" && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

export function getCurrentCalendarDate() {
  return shiftDateByOffset(new Date()).toISOString().slice(0, 10);
}

export function shiftDateByOffset(date) {
  return new Date(date.getTime() + getCalendarOffsetMinutes() * 60 * 1000);
}

export function getCalendarOffsetMinutes() {
  const match = CALENDAR_TIMEZONE_OFFSET.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match) return 8 * 60;

  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number.parseInt(match[2], 10);
  const minutes = Number.parseInt(match[3], 10);
  return sign * (hours * 60 + minutes);
}

export function addDaysToIsoDate(date, days) {
  const base = new Date(`${date}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

export function buildOffsetDateTime(date, time = "00:00") {
  return `${date}T${time}:00${CALENDAR_TIMEZONE_OFFSET}`;
}

export function buildEventDateTime(date, time) {
  return {
    dateTime: buildOffsetDateTime(date, time),
    timeZone: CALENDAR_TIMEZONE,
  };
}

export function getDateRange(startDate, endDate) {
  const finalEndDate = endDate && isValidDate(endDate) ? endDate : startDate;
  return {
    timeMin: buildOffsetDateTime(startDate, "00:00"),
    timeMax: buildOffsetDateTime(addDaysToIsoDate(finalEndDate, 1), "00:00"),
  };
}

export function getDatePartsInCalendarTimeZone(value) {
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
