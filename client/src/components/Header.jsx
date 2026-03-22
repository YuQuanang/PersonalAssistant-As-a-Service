import { useEffect, useRef, useState } from "react";
import useAuth from "../hooks/useAuth";
import { shutdownAll } from "../services/api";
import AccountDropdown from "./AccountDropdown";
import styles from "./Header.module.css";

function initialsFromName(name = "") {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return (parts[0]?.[0] ?? "G").toUpperCase();
}

export default function Header() {
  const { user, login, logout, switchAccount } = useAuth();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    function onDocClick(e) {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  async function onShutdown() {
    const ok = window.confirm("This will stop all PAaaS services and quit Ollama. Continue?");
    if (!ok) return;
    try {
      await shutdownAll();
    } catch {
      // no-op
    }
  }

  const owner = user?.name ?? "Not signed in";

  return (
    <header className={styles.header}>
      <div>
        <h1 className={styles.title}>
          <span className={styles.titleLogo} aria-hidden="true">🌿</span>
          <span>Personal Assistant</span>
        </h1>
        <p className={styles.subtitle}>Powered by Ollama · Calendar · Tasks · Email</p>
      </div>

      <div className={styles.headerActions} ref={wrapRef}>
        <button
          type="button"
          className={styles.accountBtn}
          aria-label="Google account menu"
          onClick={() => setOpen((v) => !v)}
        >
          {user?.picture ? (
            <img src={user.picture} alt="profile" className={styles.avatarImg} />
          ) : (
            <span className={styles.avatarFallback}>{initialsFromName(owner)}</span>
          )}
        </button>

        <span className={`${styles.accountOwner} ${!user ? styles.muted : ""}`}>{owner}</span>

        <AccountDropdown
          open={open}
          user={user}
          onSignIn={() => login("/chat")}
          onSwitch={() => switchAccount("/chat")}
          onSignOut={async () => {
            await logout();
            setOpen(false);
          }}
        />

        <button type="button" className={styles.shutdownBtn} onClick={onShutdown}>
          Shut down
        </button>
      </div>
    </header>
  );
}
