import { useState } from "react";
import styles from "./ChatInput.module.css";

export default function ChatInput({ onSend, onCancel, isLoading }) {
  const [value, setValue] = useState("");

  async function submit() {
    const text = value.trim();
    if (!text || isLoading) return;
    setValue("");
    await onSend(text);
  }

  return (
    <div className={styles.inputRow}>
      <textarea
        className={styles.input}
        rows={1}
        placeholder="Ask me anything..."
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
      />

      <button
        type="button"
        className={`${styles.sendBtn} ${isLoading ? styles.cancelBtn : ""}`}
        disabled={!isLoading && !value.trim()}
        onClick={() => {
          if (isLoading) {
            onCancel?.();
            return;
          }
          void submit();
        }}
      >
        {isLoading ? "Cancel" : "▶"}
      </button>
    </div>
  );
}
