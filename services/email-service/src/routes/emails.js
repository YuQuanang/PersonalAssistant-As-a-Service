import { Router } from "express";
import * as emailController from "../controllers/emailController.js";

const router = Router();

// GET /api/emails?filter=unread|read|all
router.get("/", emailController.handleListEmails);

// GET /api/emails/:emailId
router.get("/:emailId", emailController.handleGetEmail);

export default router;
