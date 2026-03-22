import { useEffect, useMemo, useRef, useState } from "react";
import Header from "../components/Header";
import MessageList from "../components/MessageList";
import ChatInput from "../components/ChatInput";
import { clearSession, sendMessage } from "../services/api";
import styles from "./ChatPage.module.css";

function makeMessage(role, content, extra = {}) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    ...extra,
  };
}

export default function ChatPage() {
  const [messages, setMessages] = useState([
    makeMessage(
      "assistant",
      [
        "Hi there! I am your personal assistant 😊",
        "",
        "Here is what I can help you with:",
        "• 📅 Calendar: check availability and book meetings",
        "• ✅ Tasks: list pending/completed tasks and create new ones",
        "• 📧 Email: show read/unread emails and summarize specific emails",
        "",
        "Try asking me:",
        "• What are my pending tasks?",
        "• Do I have free time today?",
        "• Show my unread emails",
        "",
        "I am ready whenever you are 🚀",
      ].join("\n")
    ),
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const activeRequestRef = useRef(null);
  const sessionId = useMemo(() => crypto.randomUUID(), []);

  useEffect(() => {
    return () => {
      clearSession(sessionId).catch(() => {});
    };
  }, [sessionId]);

  async function onSend(text) {
    if (isLoading) return;

    const nextUser = makeMessage("user", text);
    setMessages((prev) => [...prev, nextUser]);
    setIsLoading(true);

    const controller = new AbortController();
    activeRequestRef.current = controller;

    try {
      const data = await sendMessage(sessionId, text, messages, controller.signal);
      const reply = data.reply ?? data.response ?? "No response generated.";
      const assistant = makeMessage("assistant", reply, {
        toolsUsed: Array.isArray(data.tools_used) ? data.tools_used : [],
        errors: Array.isArray(data.errors) ? data.errors : [],
        suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
      });
      setMessages((prev) => [...prev, assistant]);
    } catch (err) {
      const canceled =
        err?.code === "ERR_CANCELED" ||
        err?.name === "CanceledError" ||
        err?.name === "AbortError";

      if (canceled) {
        return;
      }

      const message =
        err?.response?.data?.error ??
        "Could not reach chat backend. Please try again.";
      setMessages((prev) => [
        ...prev,
        makeMessage("assistant", `⚠️ Error: ${message}`, {
          errors: [{ service: "orchestrator", reason: message }],
        }),
      ]);
    } finally {
      activeRequestRef.current = null;
      setIsLoading(false);
    }
  }

  function onCancel() {
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
    setIsLoading(false);
  }

  return (
    <main className={styles.page}>
      <Header />
      <MessageList
        messages={messages}
        isLoading={isLoading}
        onSuggestion={(text) => {
          if (!text) return;
          void onSend(text);
        }}
      />
      <ChatInput onSend={onSend} onCancel={onCancel} isLoading={isLoading} />
    </main>
  );
}
