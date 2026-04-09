export function decodeBase64Url(encoded) {
  if (!encoded) return "";
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

export function normalizeText(text) {
  if (!text) return "";
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function stripHtml(html = "") {
  return normalizeText(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/[ \t]{2,}/g, " ")
  );
}

// Helper to recursively find plain text part
export function findPlainTextPart(parts) {
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

export function findHtmlPart(parts) {
  if (!parts) return null;
  for (const part of parts) {
    if (part.mimeType === "text/html") return part;
    if (part.parts) {
      const found = findHtmlPart(part.parts);
      if (found) return found;
    }
  }
  return null;
}
