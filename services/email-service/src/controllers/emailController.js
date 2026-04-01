import {
  getGmailClient,
  getCappedMessageCount,
  listMessages,
  getMessageMetadata,
  getFullMessage,
} from "../services/googleEmailService.js";
import {
  decodeBase64Url,
  normalizeText,
  stripHtml,
  findPlainTextPart,
  findHtmlPart,
} from "../utils/textUtils.js";

// ── GET /api/emails?filter=unread|read|all ───────────────────────────────────
export async function handleListEmails(req, res) {
  const filter = req.query.filter ?? "unread";

  if (filter !== "unread" && filter !== "read" && filter !== "all") {
    return res.status(400).json({
      error: `Invalid 'filter' value. Allowed: unread, read, all.`,
    });
  }

  try {
    const gmail = getGmailClient(req.headers.authorization);

    // Fast count snapshots with hard cap at 100.
    const [allCount, unreadCount, readCount] = await Promise.all([
      getCappedMessageCount(gmail, "all", 100),
      getCappedMessageCount(gmail, "unread", 100),
      getCappedMessageCount(gmail, "read", 100),
    ]);

    // List only the latest 10 messages for preview.
    const listParams = { userId: "me", maxResults: 10 };
    if (filter === "unread") {
      listParams.q = "is:unread";
    } else if (filter === "read") {
      listParams.q = "is:read";
    }

    const listRes = await listMessages(gmail, listParams);
    const messages = listRes.data.messages || [];
    const totalCount =
      filter === "unread"
        ? unreadCount.display
        : filter === "read"
        ? readCount.display
        : allCount.display;

    // Fetch details for each message
    const emailPromises = messages.map(async (msg) => {
      const detailRes = await getMessageMetadata(gmail, msg.id, ["Subject", "From"]);

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
      filter,
      emails,
      shown_count: emails.length,
      total_count: totalCount,
      total_unread: unreadCount.display,
      total_read: readCount.display,
      total_all: allCount.display,
      count_cap: 100,
    });
  } catch (err) {
    console.error("[email-service] Error fetching emails:", err.message);
    if (err.status === 401) {
      return res.status(401).json({ error: "Unauthorized. Missing or invalid token." });
    }
    return res.status(500).json({ error: "Failed to fetch emails from Google" });
  }
}

// ── POST /api/emails/summarize ────────────────────────────────────────────────
export async function handleSummarizeEmail(req, res) {
  const { email_id } = req.body ?? {};

  if (!email_id) {
    return res.status(400).json({ error: "Missing required field: email_id." });
  }

  try {
    const gmail = getGmailClient(req.headers.authorization);

    // Fetch the full email content
    const msgRes = await getFullMessage(gmail, email_id);

    const payload = msgRes.data.payload;
    const headers = payload.headers || [];
    const subject = headers.find((h) => h.name === "Subject")?.value || "No Subject";
    const from = headers.find((h) => h.name === "From")?.value || "Unknown Sender";
    const dateHeader = headers.find((h) => h.name === "Date")?.value || null;
    const receivedAt = msgRes.data.internalDate
      ? new Date(Number(msgRes.data.internalDate)).toISOString()
      : null;

    let emailBodyText = "";
    
    // Attempt to extract plain text
    if (payload.mimeType === "text/plain" && payload.body?.data) {
        emailBodyText = normalizeText(decodeBase64Url(payload.body.data));
    } else if (payload.parts) {
        const plainTextPart = findPlainTextPart(payload.parts);
        if (plainTextPart && plainTextPart.body?.data) {
            emailBodyText = normalizeText(decodeBase64Url(plainTextPart.body.data));
        }
    }

    // HTML fallback for emails that do not include text/plain content.
    if (!emailBodyText) {
      if (payload.mimeType === "text/html" && payload.body?.data) {
        emailBodyText = stripHtml(decodeBase64Url(payload.body.data));
      } else if (payload.parts) {
        const htmlPart = findHtmlPart(payload.parts);
        if (htmlPart && htmlPart.body?.data) {
          emailBodyText = stripHtml(decodeBase64Url(htmlPart.body.data));
        }
      }
    }
    
    // Fallback to snippet if body extraction totally fails
    if (!emailBodyText) {
        emailBodyText = normalizeText(msgRes.data.snippet || "Could not extract plain text body.");
    }

    // Keep payload manageable while preserving enough context for rich summaries.
    const bodyForSummary = emailBodyText.slice(0, 12000);

    return res.status(200).json({
      email_id,
      subject,
      from,
      received_at: receivedAt,
      date_header: dateHeader,
      snippet: msgRes.data.snippet || "",
      body_char_count: emailBodyText.length,
      // Pass the *entire* text body back to the Orchestrator for LLM summarization!
      summary: bodyForSummary,
      body_text: bodyForSummary,
    });
  } catch (err) {
    console.error(`[email-service] Error fetching full email ${email_id}:`, err.message);
    if (err.status === 401) {
      return res.status(401).json({ error: "Unauthorized. Missing or invalid token." });
    }
    if (err?.response?.status === 400 && /invalid id value/i.test(err.message ?? "")) {
      return res.status(400).json({ error: "Invalid email_id. Use an ID returned by GET /api/emails." });
    }
    return res.status(500).json({ error: "Failed to fetch full email from Google" });
  }
}
