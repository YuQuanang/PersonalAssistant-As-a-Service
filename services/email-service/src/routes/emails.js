import { Router } from "express";
import * as emailController from "../controllers/emailController.js";

const router = Router();

// GET /api/emails?filter=unread|read|all
router.get("/", emailController.handleListEmails);

// POST /api/emails/summarize
router.post("/summarize", emailController.handleSummarizeEmail);

export default router;
