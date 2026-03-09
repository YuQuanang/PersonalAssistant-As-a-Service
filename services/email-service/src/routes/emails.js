import { Router } from "express";
import { emails, summaries } from "../data/dummy.js";

const router = Router();

// ── GET /api/emails?filter=unread|all ────────────────────────────────────────
router.get("/", (req, res) => {
  const filter = req.query.filter ?? "unread";

  if (filter !== "unread" && filter !== "all") {
    return res.status(400).json({
      error: `Invalid 'filter' value. Allowed: unread, all.`,
    });
  }

  const filtered = filter === "all" ? emails : emails.filter((e) => !e.read);

  // Strip the full body from list responses to keep payloads lean.
  const payload = filtered.map(({ body: _body, ...rest }) => rest);

  return res.status(200).json({
    emails: payload,
    total_unread: emails.filter((e) => !e.read).length,
  });
});

// ── POST /api/emails/summarize ────────────────────────────────────────────────
router.post("/summarize", (req, res) => {
  const { email_id } = req.body ?? {};

  if (!email_id) {
    return res.status(400).json({ error: "Missing required field: email_id." });
  }

  const email = emails.find((e) => e.id === email_id);

  if (!email) {
    return res.status(404).json({
      error: `Email with id '${email_id}' not found.`,
    });
  }

  const summary = summaries[email_id] ?? `No summary available for email '${email_id}'.`;

  return res.status(200).json({
    email_id,
    subject: email.subject,
    from: email.from,
    summary,
  });
});

export default router;
