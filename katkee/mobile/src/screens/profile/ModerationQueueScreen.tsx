import React, { useCallback, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { colors, radii, spacing, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import {
  listReportsQueue,
  resolveReport,
  type ReportQueueEntry,
  type ReportStatus,
  type ResolveAction,
} from "../../api/moderation";
import { ApiError } from "../../api/client";
import { EmptyState } from "../../components/EmptyState";

const PAGE_SIZE = 30;

const TABS: Array<{ key: ReportStatus; label: string }> = [
  { key: "pending", label: "Pending" },
  { key: "actioned", label: "Actioned" },
  { key: "dismissed", label: "Dismissed" },
];

function targetSummary(entry: ReportQueueEntry): string {
  const t = entry.target;
  switch (t.type) {
    case "user":
      return `Account @${t.username}${t.isActive ? "" : " (already suspended)"}`;
    case "story":
      return `Story by @${t.ownerUsername}${t.deleted ? " (already deleted)" : ""}`;
    case "comment":
      return `Comment by @${t.authorUsername}: "${t.body}"${t.deleted ? " (already deleted)" : ""}`;
    default:
      return "Content no longer available";
  }
}

/**
 * The real moderator queue this project's own docs used to say had "no
 * mobile screen... didn't earn its place" (backend/README.md's Phase 10
 * section) — now built, since a real admin login needs a real place to
 * actually delete reported content, not just an API that exists. Reached
 * from Settings > Moderation, itself only shown to accounts with
 * role 'moderator' or 'admin' (see SettingsScreen.tsx).
 */
export function ModerationQueueScreen(): React.JSX.Element {
  const { accessToken } = useAuth();
  const [status, setStatus] = useState<ReportStatus>("pending");
  const [reports, setReports] = useState<ReportQueueEntry[] | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const { reports: fetched } = await listReportsQueue(status, accessToken, { limit: PAGE_SIZE });
      setReports(fetched);
    } catch {
      setReports([]);
    }
  }, [accessToken, status]);

  useFocusEffect(
    useCallback(() => {
      setReports(null);
      void load();
    }, [load]),
  );

  const onResolve = async (entry: ReportQueueEntry, action: ResolveAction) => {
    if (!accessToken || resolvingId) return;
    setResolvingId(entry.id);
    try {
      await resolveReport(entry.id, { action }, accessToken);
      setReports((current) => (current ?? []).filter((r) => r.id !== entry.id));
    } catch (err) {
      Alert.alert("Couldn't resolve that report", err instanceof ApiError ? err.message : "Try again.");
    } finally {
      setResolvingId(null);
    }
  };

  const onPressReport = (entry: ReportQueueEntry) => {
    if (entry.status !== "pending") return;
    const options: Array<{ text: string; style?: "destructive" | "cancel"; onPress?: () => void }> = [
      { text: "Cancel", style: "cancel" },
      { text: "Dismiss", onPress: () => void onResolve(entry, "dismiss") },
    ];
    if (entry.targetType === "story" || entry.targetType === "comment") {
      options.push({ text: `Remove ${entry.targetType}`, style: "destructive", onPress: () => void onResolve(entry, "remove_content") });
    }
    if (entry.targetType === "user") {
      options.push({ text: "Suspend account", style: "destructive", onPress: () => void onResolve(entry, "suspend_user") });
    }
    Alert.alert(`${entry.reason.replace("_", " ")} report`, targetSummary(entry), options);
  };

  return (
    <View style={styles.container}>
      <View style={styles.tabBar}>
        {TABS.map((tab) => (
          <Pressable
            key={tab.key}
            style={[styles.tab, status === tab.key && styles.tabActive]}
            onPress={() => setStatus(tab.key)}
            accessibilityRole="button"
            accessibilityLabel={tab.label}
          >
            <Text style={[styles.tabLabel, status === tab.key && styles.tabLabelActive]}>{tab.label}</Text>
          </Pressable>
        ))}
      </View>

      {reports === null ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : reports.length === 0 ? (
        <EmptyState title={`No ${status} reports`} message="Reports filed by users will show up here." />
      ) : (
        <FlatList
          data={reports}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <Pressable style={styles.row} onPress={() => onPressReport(item)} disabled={resolvingId === item.id}>
              <View style={styles.rowHeader}>
                <Text style={styles.reason}>{item.reason.replace("_", " ")}</Text>
                <Text style={typography.caption}>{new Date(item.createdAt).toLocaleDateString()}</Text>
              </View>
              <Text style={typography.body}>{targetSummary(item)}</Text>
              <Text style={styles.reporter}>Reported by @{item.reporter.username}</Text>
              {item.details ? <Text style={styles.details}>"{item.details}"</Text> : null}
              {resolvingId === item.id ? <ActivityIndicator color={colors.accent} style={styles.rowSpinner} /> : null}
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  tabBar: {
    flexDirection: "row",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  tab: { paddingVertical: spacing.xs, paddingHorizontal: spacing.sm, borderRadius: radii.pill },
  tabActive: { backgroundColor: colors.surfaceElevated },
  tabLabel: { ...typography.caption, color: colors.textSecondary, fontWeight: "600" },
  tabLabelActive: { color: colors.textPrimary },
  row: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: spacing.xs / 2,
  },
  rowHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  reason: { ...typography.bodyStrong, textTransform: "capitalize" },
  reporter: { ...typography.caption, color: colors.textSecondary },
  details: { ...typography.caption, color: colors.textSecondary, fontStyle: "italic" },
  rowSpinner: { marginTop: spacing.xs },
});
