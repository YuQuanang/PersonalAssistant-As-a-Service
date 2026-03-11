import { Router } from "express";
import { google } from "googleapis";

const router = Router();

// Helper to extract Bearer token and initialize Gmail client
function getGmailClient(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing or invalid Authorization header");
  }
  const token = authHeader.split(" ")[1];

  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: token });

  return google.gmail({ version: "v1", auth: oauth2Client });
}

// Helper to decode base64url encoded email body
function decodeBase64Url(encoded) {
  if (!encoded) return "";
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

// ── GET /api/emails?filter=unread|all ────────────────────────────────────────
router.get("/", async (req, res) => {
  const filter = req.query.filter ?? "unread";

  if (filter !== "unread" && filter !== "all") {
    return res.status(400).json({
      error: `Invalid 'filter' value. Allowed: unread, all.`,
    });
  }

  try {
    const gmail = getGmailClient(req);

    // List messages
    const listParams = { userId: "me", maxResults: 10 };
    if (filter === "unread") {
      listParams.q = "is:unread";
    }

    const listRes = await gmail.users.messages.list(listParams);
    const messages = listRes.data.messages || [];

    // Fetch details for each message
    const emailPromises = messages.map(async (msg) => {
      const detailRes = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "metadata",
        metadataHeaders: ["Subject", "From"],
      });

      const headers = detailRes.data.payload?.headers || [];
      const subject = headers.find((h) => h.name === "Subject")?.value || "No Subject";
      const from = headers.find((h) => h.name === "From")?.value || "Unknown Sender";

      return {
        id: msg.id,
        from,
        subject,
        preview: detailRes.data.snippet || "",
      };
    });

    const emails = await Promise.all(emailPromises);

    return res.status(200).json({
      emails,
      total_unread: filter === "unread" ? emails.length : undefined, // Approximation based on returned items
    });
  } catch (err) {
    console.error("[email-service] Error fetching emails:", err.message);
    return res.status(500).json({ error: "Failed to fetch emails from Google" });
  }
});

// Helper to recursively find plain text part
function findPlainTextPart(parts) {
  if (!parts) return null;
  for (const part of parts) {
    if (part.mimeType === "text/plain") return part;
    if (part.parts) {
      const found = findPlainTextPart(part.parts);
      if (found) return found;
    }
  }
  return null;
}

// ── POST /api/emails/summarize ────────────────────────────────────────────────
router.post("/summarize", async (req, res) => {
  const { email_id } = req.body ?? {};

  if (!email_id) {
    return res.status(400).json({ error: "Missing required field: email_id." });
  }

  try {
    const gmail = getGmailClient(req);

    // Fetch the full email content
    const msgRes = await gmail.users.messages.get({
      userId: "me",
      id: email_id,
      format: "full",
    });

    const payload = msgRes.data.payload;
    const headers = payload.headers || [];
    const subject = headers.find((h) => h.name === "Subject")?.value || "No Subject";
    const from = headers.find((h) => h.name === "From")?.value || "Unknown Sender";

    let emailBodyText = "";
    
    // Attempt to extract plain text
    if (payload.mimeType === "text/plain" && payload.body?.data) {
        emailBodyText = decodeBase64Url(payload.body.data);
    } else if (payload.parts) {
        const plainTextPart = findPlainTextPart(payload.parts);
        if (plainTextPart && plainTextPart.body?.data) {
            emailBodyText = decodeBase64Url(plainTextPart.body.data);
        }
    }
    
    // Fallback to snippet if body extraction totally fails
    if (!emailBodyText) {
        emailBodyText = msgRes.data.snippet || "Could not extract plain text body.";
    }

    return res.status(200).json({
      email_id,
      subject,
      from,
      // Pass the *entire* text body back to the Orchestrator for LLM summarization!
      summary: emailBodyText, 
    });
  } catch (err) {
    console.error(`[email-service] Error fetching full email ${email_id}:`, err.message);
    return res.status(500).json({ error: "Failed to fetch full email from Google" });
  }
});

export default router;
