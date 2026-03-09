// In-memory dummy data for the Calendar Service.
// All mutations (bookings) are kept here at runtime; data resets on restart.

export const allSlots = {
  "2026-03-09": [
    { start: "10:00", end: "11:00" },
    { start: "14:00", end: "15:00" },
  ],
  "2026-03-10": [
    { start: "09:00", end: "10:00" },
    { start: "11:00", end: "12:00" },
    { start: "14:00", end: "15:00" },
  ],
  "2026-03-11": [
    { start: "09:00", end: "10:00" },
    { start: "13:00", end: "14:00" },
  ],
  "2026-03-12": [
    { start: "10:00", end: "11:00" },
    { start: "15:00", end: "16:00" },
  ],
};

// Tracks booked slots as a Set of "date|start|end" strings for O(1) lookup.
export const bookedSlots = new Set();

// Confirmed meetings list (grows at runtime).
export const meetings = [];

let meetingCounter = 1;
export function nextMeetingId() {
  return `mtg_${String(meetingCounter++).padStart(4, "0")}`;
}
