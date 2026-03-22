import { useEffect, useRef } from "react";
import { marked } from "marked";
import styles from "./MessageList.module.css";

marked.use({ breaks: true, gfm: true });

function renderAssistantHtml(content) {
  return { __html: marked.parse(content ?? "") };
}

export default function MessageList({ messages, isLoading, onSuggestion }) {
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  return (
    <div className={styles.chat}>
      {messages.map((m) => {
        const toolSet = new Set(Array.isArray(m.toolsUsed) ? m.toolsUsed : []);
        const hasEmailTool = toolSet.has("get_emails") || toolSet.has("summarize_email");

        return (
          <div key={m.id} className={styles.entry}>
            <div
              className={`${styles.bubble} ${m.role === "user" ? styles.user : styles.assistant} ${
                m.role === "assistant" && hasEmailTool ? styles.assistantEmail : ""
              }`}
              {...(m.role === "assistant"
                ? { dangerouslySetInnerHTML: renderAssistantHtml(m.content) }
                : { children: m.content })}
            />

            {m.role === "assistant" && Array.isArray(m.toolsUsed) && m.toolsUsed.length > 0 && (
              <div className={styles.meta}>Tools used: {[...new Set(m.toolsUsed)].join(", ")}</div>
            )}

            {m.role === "assistant" && Array.isArray(m.errors) && m.errors.length > 0 && (
              <div className={`${styles.bubble} ${styles.error}`}>
                ⚠️ Some services had issues:
                {"\n"}
                {m.errors.map((e) => `• ${e.service}: ${e.reason}`).join("\n")}
              </div>
            )}

            {m.role === "assistant" && Array.isArray(m.suggestions) && m.suggestions.length > 0 && (
              <div className={styles.suggestions}>
                {m.suggestions.map((s, idx) => (
                  <button
                    type="button"
                    key={`${m.id}-s-${idx}`}
                    className={styles.chip}
                    onClick={() => onSuggestion?.(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {isLoading && (
        <div className={styles.typing}>
          <span />
          <span />
          <span />
        </div>
      )}

      <div ref={endRef} />
    </div>
  );
}
