import { useEffect, useState } from "react";
import styles from "./Header.module.css";

export default function AccountDropdown({
  open,
  user,
  onSignIn,
  onSwitch,
  onSignOut,
}) {
  const [avatarBroken, setAvatarBroken] = useState(false);

  useEffect(() => {
    setAvatarBroken(false);
  }, [user?.picture]);

  if (!open) return null;

  const initials = user?.name
    ? user.name
        .split(/\s+/)
        .slice(0, 2)
        .map((p) => p[0]?.toUpperCase() ?? "")
        .join("")
    : "G";
  const canShowAvatar = !!user?.picture && !avatarBroken;

  return (
    <div className={styles.accountMenu} aria-hidden={!open}>
      <div className={styles.accountCard}>
        <div className={styles.accountAvatar}>
          {canShowAvatar ? (
            <img
              src={user.picture}
              alt="profile"
              className={styles.accountAvatarImg}
              onError={() => setAvatarBroken(true)}
            />
          ) : (
            <span>{initials}</span>
          )}
        </div>
        <div className={styles.accountMeta}>
          <div className={styles.accountName}>{user?.name ?? "Google account"}</div>
          <div className={styles.accountEmail}>{user?.email ?? "Not signed in"}</div>
        </div>
      </div>

      <div className={styles.menuSeparator} />
      {!user && (
        <button type="button" className={styles.menuItem} onClick={onSignIn}>
          Sign in with Google
        </button>
      )}
      {user && (
        <>
          <button type="button" className={styles.menuItem} onClick={onSwitch}>
            Switch account
          </button>
          <button type="button" className={styles.menuItem} onClick={onSignOut}>
            Sign out
          </button>
        </>
      )}
    </div>
  );
}
