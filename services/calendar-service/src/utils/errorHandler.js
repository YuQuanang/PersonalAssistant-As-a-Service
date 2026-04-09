export function sendCalendarError(res, err) {
  if (err?.status === 401) {
    return res.status(401).json({ error: "Unauthorized. Missing or invalid token." });
  }
  if (err?.response?.status === 401) {
    return res.status(401).json({ error: "Unauthorized. Missing or invalid token." });
  }
  if (err?.response?.status === 403) {
    return res.status(403).json({ error: "Forbidden. Calendar scope or permissions missing." });
  }
  if (err?.response?.status === 404) {
    return res.status(404).json({ error: "Calendar event not found." });
  }
  if (err?.response?.status) {
    return res.status(err.response.status).json({
      error: err.response.data?.error?.message ?? "Google Calendar request failed.",
    });
  }
  return res.status(500).json({ error: err?.message ?? "Unknown calendar service error." });
}
