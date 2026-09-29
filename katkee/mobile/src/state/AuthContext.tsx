import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import * as authApi from "../api/auth";
import type { PublicUser } from "../api/client";
import { ApiError } from "../api/client";
import { clearTokens, loadTokens, saveTokens, type StoredTokens } from "./tokenStorage";

interface AuthState {
  status: "loading" | "signedOut" | "signedIn";
  user: PublicUser | null;
  accessToken: string | null;
}

interface AuthContextValue extends AuthState {
  signup: (input: authApi.SignupPayload) => Promise<void>;
  login: (input: authApi.LoginPayload) => Promise<void>;
  logout: () => Promise<void>;
  /** Real, irreversible account deletion (password-confirmed) — throws ApiError (e.g. wrong password) on failure, otherwise ends signed out. */
  deleteAccount: (password: string) => Promise<void>;
  /** Re-fetches `/auth/me` and replaces the in-context user — call after any server-side profile edit (display name, bio, privacy) so the rest of the app reflects it without a full re-login. */
  refreshUser: () => Promise<void>;
  error: string | null;
  fieldErrors: Record<string, string> | undefined;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [state, setState] = useState<AuthState>({ status: "loading", user: null, accessToken: null });
  const [refreshToken, setRefreshToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await loadTokens();
      if (!stored) {
        if (!cancelled) setState({ status: "signedOut", user: null, accessToken: null });
        return;
      }
      try {
        const { user } = await authApi.fetchMe(stored.accessToken);
        if (!cancelled) {
          setRefreshToken(stored.refreshToken);
          setState({ status: "signedIn", user, accessToken: stored.accessToken });
        }
      } catch {
        // Access token expired or invalid — try a refresh before giving up.
        try {
          const { tokens } = await authApi.refresh(stored.refreshToken);
          const { user } = await authApi.fetchMe(tokens.accessToken);
          await saveTokens(tokens);
          if (!cancelled) {
            setRefreshToken(tokens.refreshToken);
            setState({ status: "signedIn", user, accessToken: tokens.accessToken });
          }
        } catch {
          await clearTokens();
          if (!cancelled) setState({ status: "signedOut", user: null, accessToken: null });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAuthResponse = useCallback(async (user: PublicUser, tokens: StoredTokens) => {
    await saveTokens(tokens);
    setRefreshToken(tokens.refreshToken);
    setState({ status: "signedIn", user, accessToken: tokens.accessToken });
  }, []);

  const runAuthAction = useCallback(
    async (action: () => Promise<{ user: PublicUser; tokens: StoredTokens }>) => {
      setError(null);
      setFieldErrors(undefined);
      try {
        const { user, tokens } = await action();
        await handleAuthResponse(user, tokens);
      } catch (err) {
        if (err instanceof ApiError) {
          setError(err.message);
          setFieldErrors(err.fieldErrors);
        } else {
          setError("Network error — check your connection and try again.");
        }
        throw err;
      }
    },
    [handleAuthResponse],
  );

  const signup = useCallback(
    (input: authApi.SignupPayload) => runAuthAction(() => authApi.signup(input)),
    [runAuthAction],
  );

  const login = useCallback(
    (input: authApi.LoginPayload) => runAuthAction(() => authApi.login(input)),
    [runAuthAction],
  );

  const logout = useCallback(async () => {
    if (refreshToken) {
      try {
        await authApi.logout(refreshToken);
      } catch {
        // Best-effort server-side revocation — clear local state regardless.
      }
    }
    await clearTokens();
    setRefreshToken(null);
    setState({ status: "signedOut", user: null, accessToken: null });
  }, [refreshToken]);

  const deleteAccount = useCallback(
    async (password: string) => {
      if (!state.accessToken) return;
      // Not wrapped in try/catch — a wrong password (or any other failure)
      // must propagate to the caller so the screen can show it, unlike
      // logout()'s best-effort revocation, since this is the one action
      // here that's genuinely irreversible.
      await authApi.deleteMyAccount(password, state.accessToken);
      await clearTokens();
      setRefreshToken(null);
      setState({ status: "signedOut", user: null, accessToken: null });
    },
    [state.accessToken],
  );

  const clearError = useCallback(() => {
    setError(null);
    setFieldErrors(undefined);
  }, []);

  const refreshUser = useCallback(async () => {
    if (!state.accessToken) return;
    try {
      const { user } = await authApi.fetchMe(state.accessToken);
      setState((current) => (current.status === "signedIn" ? { ...current, user } : current));
    } catch {
      // Best-effort — the screen that triggered this already has its own error handling for the edit itself.
    }
  }, [state.accessToken]);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, signup, login, logout, deleteAccount, refreshUser, error, fieldErrors, clearError }),
    [state, signup, login, logout, deleteAccount, refreshUser, error, fieldErrors, clearError],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
