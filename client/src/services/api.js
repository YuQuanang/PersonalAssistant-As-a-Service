import axios from "axios";

const http = axios.create({
  baseURL: "/",
  withCredentials: true,
});

export async function sendMessage(sessionId, userMessage, history, signal) {
  const res = await http.post("/api/chat", {
    session_id: sessionId,
    sessionId,
    message: userMessage,
    history,
  }, {
    signal,
  });

  return res.data;
}

export async function fetchProfile() {
  try {
    const res = await http.get("/api/auth/profile", {
      headers: { "Cache-Control": "no-store" },
    });
    return res.data;
  } catch (err) {
    if (err?.response?.status === 404) {
      const fallback = await http.get("/api/profile", {
        headers: { "Cache-Control": "no-store" },
      });
      return fallback.data;
    }
    if (err?.response?.status === 401) return null;
    throw err;
  }
}

export async function clearSession(sessionId) {
  try {
    await http.post("/api/chat/session/end", { sessionId, session_id: sessionId });
  } catch (err) {
    if (err?.response?.status === 404) {
      await http.post("/api/session/clear", { sessionId, session_id: sessionId });
      return;
    }
    throw err;
  }
}

function getClientOrigin() {
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return "";
}

export function getLoginUrl(returnTo = "/chat") {
  const params = new URLSearchParams({
    return_to: returnTo,
  });
  const origin = getClientOrigin();
  if (origin) params.set("return_origin", origin);
  return `/api/auth/google?${params.toString()}`;
}

export function getSwitchAccountUrl(returnTo = "/chat") {
  const params = new URLSearchParams({
    return_to: returnTo,
  });
  const origin = getClientOrigin();
  if (origin) params.set("return_origin", origin);
  return `/api/auth/google/switch?${params.toString()}`;
}

export async function logout() {
  try {
    await http.post("/api/auth/logout");
  } catch (err) {
    if (err?.response?.status === 404) {
      await http.get("/auth/logout");
      return;
    }
    throw err;
  }
}

