import { useNavigate } from "react-router-dom";
import useAuth from "../hooks/useAuth";
import styles from "./LandingPage.module.css";

export default function LandingPage() {
  const { isAuthenticated, login } = useAuth();
  const navigate = useNavigate();

  return (
    <main className={styles.wrap}>
      <div className={styles.card}>
        <h1 className={styles.title}>PAaaS Chat</h1>
        <p className={styles.text}>Sign in with Google to use your assistant tools.</p>

        <button
          type="button"
          className={styles.btn}
          onClick={() => (isAuthenticated ? navigate("/chat") : login("/chat"))}
        >
          {isAuthenticated ? "Go to Chat" : "Sign in with Google"}
        </button>
      </div>
    </main>
  );
}
