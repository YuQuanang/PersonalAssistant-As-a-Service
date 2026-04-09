import { google } from "googleapis";

// Helper to extract Bearer token and initialize Gmail client
export function getGmailClient(authHeader) {
  if (!authHeader?.startsWith("Bearer ")) {
    const err = new Error("Missing or invalid Authorization header");
    err.status = 401;
    throw err;
  }
  const token = authHeader.split(" ")[1];

  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: token });

  return google.gmail({ version: "v1", auth: oauth2Client });
}

export async function getCappedMessageCount(gmail, scope = "all", cap = 100) {
  const query = scope === "unread" ? "is:unread" : scope === "read" ? "is:read" : undefined;

  const { data } = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: cap + 1,
    fields: "messages/id,nextPageToken",
  });

  const length = data.messages?.length ?? 0;
  const capped = !!data.nextPageToken || length > cap;
  const count = capped ? cap : length;

  return {
    count,
    capped,
    display: capped ? `more than ${cap}` : count,
  };
}

export async function listMessages(gmail, listParams) {
  return gmail.users.messages.list(listParams);
}

export async function getMessageMetadata(gmail, id, metadataHeaders = ["Subject", "From"]) {
  return gmail.users.messages.get({
    userId: "me",
    id,
    format: "metadata",
    metadataHeaders,
  });
}

export async function getFullMessage(gmail, id) {
  return gmail.users.messages.get({
    userId: "me",
    id,
    format: "full",
  });
}
