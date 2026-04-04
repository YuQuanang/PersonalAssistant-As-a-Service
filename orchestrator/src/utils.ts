const CALENDAR_OFFSET_MINUTES: number = 8 * 60;

function shiftToOffset(date: Date): Date {
    return new Date(date.getTime() + CALENDAR_OFFSET_MINUTES * 60 * 1000);
}

export function getCurrentDateInCalendarOffset(): string {
    // returns YYYY-MM-DD
    return shiftToOffset(new Date()).toISOString().slice(0, 10);
}

export function getCurrentTimeInCalendarOffset(): string {
    // returns HH:MM
    return shiftToOffset(new Date()).toISOString().slice(11, 16);
}

export function addDaysToIsoDate(date: string, days: number): string {
    const base = new Date(`${date}T00:00:00.000Z`);
    base.setUTCDate(base.getUTCDate() + days);
    return base.toISOString().slice(0, 10);
}