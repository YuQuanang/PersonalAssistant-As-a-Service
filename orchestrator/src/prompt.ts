import fs from "node:fs";
import path from "node:path";
import { getCurrentDateInCalendarOffset, getCurrentTimeInCalendarOffset, getDayOfWeekInCalendarOffset } from "./utils";

const TEMPLATE: string = fs.readFileSync(
    path.join(import.meta.dirname, "prompt.md"),
    "utf8"
);

const CALENDAR_TIMEZONE_LABEL: string = "GMT+8";

export function buildSystemPrompt(): string {
    return TEMPLATE
        .replace("{{DAY_OF_WEEK}}", getDayOfWeekInCalendarOffset())
        .replace("{{DATE}}", getCurrentDateInCalendarOffset())
        .replace("{{CURRENT_TIME}}", getCurrentTimeInCalendarOffset())
        .replace(/\{\{CALENDAR_TIMEZONE_LABEL\}\}/g, CALENDAR_TIMEZONE_LABEL);
}
