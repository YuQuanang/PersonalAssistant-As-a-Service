import { Router } from "express";
import * as calendarController from "../controllers/calendarController.js";

const router = Router();

// GET /api/events?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
router.get("/events", calendarController.handleListEvents);

// POST /api/events
router.post("/events", calendarController.handleCreateEvent);

// GET /api/events/:eventId
router.get("/events/:eventId", calendarController.handleGetEvent);

// DELETE /api/events
router.delete("/events", calendarController.handleDeleteEvent);

export default router;
