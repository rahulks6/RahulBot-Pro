import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { getUnreadNotificationCount } from "../api/notifications";
import { useAuth } from "./AuthContext";

interface NotificationsContextValue {
  unreadCount: number;
  refreshUnreadCount: () => Promise<void>;
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

const POLL_INTERVAL_MS = 20_000;

/**
 * Shares the unread-notification badge count between the Activity tab icon
 * (BottomTabBar) and the ActivityScreen list itself, so marking something
 * read in one place updates the other without a prop-drilled refetch.
 * Polls rather than pushing — there's no websocket/push channel in this
 * sandbox build (see backend/README.md's known limitations).
 */
export function NotificationsProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
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
      const { count } = await getUnreadNotificationCount(token);
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

  const value = useMemo<NotificationsContextValue>(
    () => ({ unreadCount, refreshUnreadCount }),
    [unreadCount, refreshUnreadCount],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsContextValue {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error("useNotifications must be used within a NotificationsProvider");
  return ctx;
}
