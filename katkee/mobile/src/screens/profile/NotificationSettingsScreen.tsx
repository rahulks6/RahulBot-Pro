import React, { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Switch, Text, View } from "react-native";
import { colors, radii, spacing, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import {
  getNotificationPreferences,
  updateNotificationPreferences,
  type NotificationPreferences,
} from "../../api/notifications";

const ROWS: Array<{ key: keyof NotificationPreferences; label: string }> = [
  { key: "likesEnabled", label: "Likes" },
  { key: "commentsEnabled", label: "Comments" },
  { key: "followsEnabled", label: "Follows" },
  { key: "mentionsEnabled", label: "Mentions" },
];

/**
 * Real per-type notification toggles, backed by
 * `GET/PATCH /api/v1/notifications/preferences` (migration 0018) — turning
 * one off actually suppresses that notification type at creation time, not
 * just a client-side filter of an unfiltered feed. Follow requests aren't
 * listed: they're an actionable pending request, not a muteable broadcast,
 * so the backend never lets them be suppressed (see notifications.repository
 * .ts's isTypeEnabled).
 */
export function NotificationSettingsScreen(): React.JSX.Element {
  const { accessToken } = useAuth();
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [pending, setPending] = useState<Set<keyof NotificationPreferences>>(new Set());

  useEffect(() => {
    if (!accessToken) return;
    getNotificationPreferences(accessToken)
      .then(({ preferences }) => setPrefs(preferences))
      .catch(() => setPrefs({ likesEnabled: true, commentsEnabled: true, followsEnabled: true, mentionsEnabled: true }));
  }, [accessToken]);

  const onToggle = async (key: keyof NotificationPreferences, value: boolean) => {
    if (!accessToken || !prefs) return;
    const previous = prefs;
    setPrefs({ ...prefs, [key]: value }); // optimistic
    setPending((current) => new Set(current).add(key));
    try {
      const { preferences } = await updateNotificationPreferences({ [key]: value }, accessToken);
      setPrefs(preferences);
    } catch {
      setPrefs(previous);
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  if (!prefs) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.hint}>Choose which activity on your Stories and comments notifies you.</Text>
      <View style={styles.card}>
        {ROWS.map((row, index) => (
          <View key={row.key} style={[styles.row, index === ROWS.length - 1 && styles.rowLast]}>
            <Text style={typography.body}>{row.label}</Text>
            {pending.has(row.key) ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <Switch value={prefs[row.key]} onValueChange={(value) => void onToggle(row.key, value)} />
            )}
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: spacing.md },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background },
  hint: { ...typography.caption, color: colors.textSecondary, marginBottom: spacing.md },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowLast: { borderBottomWidth: 0 },
});
