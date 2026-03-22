import { createContext, useContext, useEffect, useMemo, useReducer } from "react";
import { fetchProfile, getLoginUrl, getSwitchAccountUrl, logout as apiLogout } from "../services/api";

const AuthContext = createContext(null);

const initialState = {
  user: null,
  isLoading: true,
  isAuthenticated: false,
};

function reducer(state, action) {
  switch (action.type) {
    case "AUTH_LOADING":
      return { ...state, isLoading: true };
    case "AUTH_READY": {
      const user = action.payload;
      return {
        user,
        isLoading: false,
        isAuthenticated: !!user,
      };
    }
    case "LOGOUT":
      return {
        user: null,
        isLoading: false,
        isAuthenticated: false,
      };
    default:
      return state;
  }
}

function normalizeProfile(profile) {
  if (!profile || profile.authenticated === false) return null;

  const email = profile.email ?? null;
  const fallbackName = email ? String(email).split("@")[0] : "Google account";

  return {
    name: profile.name ?? fallbackName,
    email,
    picture: profile.picture ?? null,
  };
}

export function AuthProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    let cancelled = false;

    async function loadProfile() {
      dispatch({ type: "AUTH_LOADING" });
      try {
        const profile = await fetchProfile();
        if (cancelled) return;
        dispatch({ type: "AUTH_READY", payload: normalizeProfile(profile) });
      } catch {
        if (cancelled) return;
        dispatch({ type: "AUTH_READY", payload: null });
      }
    }

    loadProfile();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = (returnTo = "/chat") => {
    window.location.href = getLoginUrl(returnTo);
  };

  const switchAccount = (returnTo = "/chat") => {
    window.location.href = getSwitchAccountUrl(returnTo);
  };

  const logout = async () => {
    await apiLogout();
    dispatch({ type: "LOGOUT" });
  };

  const value = useMemo(
    () => ({
      ...state,
      login,
      logout,
      switchAccount,
    }),
    [state]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuthContext must be used within AuthProvider");
  return ctx;
}
