import fs from "node:fs";
import path from "node:path";
import { getCurrentDateInCalendarOffset, getCurrentTimeInCalendarOffset } from "./utils";

const TEMPLATE: string = fs.readFileSync(
    path.join(import.meta.dirname, "prompt.md"),
    "utf8"
);

const CALENDAR_TIMEZONE_LABEL: string = "GMT+8";

export function buildSystemPrompt(): string {
    return TEMPLATE
        .replace("{{TODAY}}", getCurrentDateInCalendarOffset())
        .replace("{{CURRENT_TIME}}", getCurrentTimeInCalendarOffset())
        .replace(/\{\{CALENDAR_TIMEZONE_LABEL\}\}/g, CALENDAR_TIMEZONE_LABEL);
}
