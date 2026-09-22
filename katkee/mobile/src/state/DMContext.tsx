import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { getUnreadConversationCount } from "../api/conversations";
import { useAuth } from "./AuthContext";

interface DMContextValue {
  unreadCount: number;
  refreshUnreadCount: () => Promise<void>;
}

const DMContext = createContext<DMContextValue | null>(null);

const POLL_INTERVAL_MS = 20_000;

/**
 * Mirrors NotificationsContext.tsx's shape exactly, for the DM tab's own
 * unread badge — a separate count from Activity's, the same way a real
 * app's message badge and notification badge are independent numbers.
 * Polling only, same reason: no push/websocket channel in this sandbox.
 */
export function DMProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { accessToken } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;

  const refreshUnreadCount = useCallback(async () => {
    const token = accessTokenRef.current;
    if (!token) {
      setUnreadCount(0);
      return;
    }
    try {
      const { count } = await getUnreadConversationCount(token);
      setUnreadCount(count);
    } catch {
      // Best-effort badge — a transient failure just leaves the last known count.
    }
  }, []);

  useEffect(() => {
    if (!accessToken) {
      setUnreadCount(0);
      return;
    }
    void refreshUnreadCount();
    const interval = setInterval(() => void refreshUnreadCount(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [accessToken, refreshUnreadCount]);

  const value = useMemo<DMContextValue>(() => ({ unreadCount, refreshUnreadCount }), [unreadCount, refreshUnreadCount]);

  return <DMContext.Provider value={value}>{children}</DMContext.Provider>;
}

export function useDM(): DMContextValue {
  const ctx = useContext(DMContext);
  if (!ctx) throw new Error("useDM must be used within a DMProvider");
  return ctx;
}
