import { Router } from "express";
import {
  allSlots,
  bookedSlots,
  meetings,
  nextMeetingId,
} from "../data/dummy.js";

const router = Router();

// ── GET /api/availability?date=YYYY-MM-DD ────────────────────────────────────
router.get("/availability", (req, res) => {
  const { date } = req.query;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({
      error: "Invalid or missing 'date' query parameter. Expected format: YYYY-MM-DD.",
    });
  }

  const allForDate = allSlots[date] ?? [];

  // Filter out any already-booked slots.
  const available = allForDate.filter(
    (slot) => !bookedSlots.has(`${date}|${slot.start}|${slot.end}`)
  );

  return res.status(200).json({ date, available_slots: available });
});

// ── POST /api/meetings ────────────────────────────────────────────────────────
router.post("/meetings", (req, res) => {
  const { title, date, start, end, attendees = [] } = req.body ?? {};

  // Validate required fields.
  const missing = ["title", "date", "start", "end"].filter((f) => !req.body?.[f]);
  if (missing.length > 0) {
    return res.status(400).json({
      error: `Missing required fields: ${missing.join(", ")}.`,
    });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({
      error: "Invalid 'date' format. Expected: YYYY-MM-DD.",
    });
  }

  const slotKey = `${date}|${start}|${end}`;

  if (bookedSlots.has(slotKey)) {
    return res.status(409).json({
      error: `The requested time slot (${start}–${end}) is already booked.`,
    });
  }

  bookedSlots.add(slotKey);

  const meeting = {
    id: nextMeetingId(),
    title,
    date,
    start,
    end,
    attendees: Array.isArray(attendees) ? attendees : [attendees],
    status: "confirmed",
  };

  meetings.push(meeting);
  return res.status(201).json(meeting);
});

export default router;
