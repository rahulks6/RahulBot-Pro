import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radii, spacing, typography } from "../theme";
import { useAuth } from "../state/AuthContext";
import { getStoryInsights, getStoryViewers, type StoryInsights, type StoryViewer } from "../api/stories";

interface Props {
  visible: boolean;
  storyId: string;
  onClose: () => void;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function StatRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.statRow}>
      <Text style={[typography.caption, styles.statLabel]}>{label}</Text>
      <Text style={typography.bodyStrong}>{value}</Text>
    </View>
  );
}

/**
 * Owner-only Story Insights (spec): the real count and identities
 * (StoryFeed's small "eye" figure is visible to any viewer; who's behind
 * it, and everything in this sheet, is strictly owner-only — the backend
 * rejects both endpoints outright for anyone else). Completion rate,
 * following-vs-discovery split, and profile-visit rate all come from
 * real recorded events (see backend/src/modules/stories/stories.repository.ts's
 * getStoryInsights) — not invented numbers, but honestly-scoped
 * approximations where the schema genuinely can't be exact (see that
 * function's own comment on "following" meaning *current* relationship,
 * not relationship-at-view-time).
 */
export function StoryInsightsSheet({ visible, storyId, onClose }: Props): React.JSX.Element {
  const { accessToken } = useAuth();
  const [insights, setInsights] = useState<StoryInsights | null>(null);
  const [viewers, setViewers] = useState<StoryViewer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const [{ insights: fetchedInsights }, { viewers: fetchedViewers }] = await Promise.all([
        getStoryInsights(storyId, accessToken),
        getStoryViewers(storyId, accessToken),
      ]);
      setInsights(fetchedInsights);
      setViewers(fetchedViewers);
    } catch {
      setError("Couldn't load Insights.");
    } finally {
      setLoading(false);
    }
  }, [storyId, accessToken]);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <Text style={[typography.bodyStrong, styles.title]}>Insights</Text>

        {loading ? (
          <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.lg }} />
        ) : error ? (
          <Text style={[typography.caption, styles.empty]}>{error}</Text>
        ) : !insights || insights.viewCount === 0 ? (
          <Text style={[typography.caption, styles.empty]}>No views yet.</Text>
        ) : (
          <>
            <View style={styles.stats}>
              <StatRow label="Views" value={String(insights.viewCount)} />
              <StatRow label="Completed" value={`${insights.completionRate}%`} />
              <StatRow label="Following" value={`${insights.followingViewRate}%`} />
              <StatRow label="Discovery" value={`${insights.discoveryViewRate}%`} />
              <StatRow label="Visited your profile" value={`${insights.profileVisitRate}%`} />
            </View>

            <Text style={[typography.label, styles.viewersHeader]}>Viewed by {viewers.length}</Text>
            <FlatList
              data={viewers}
              keyExtractor={(v) => v.id}
              style={styles.list}
              renderItem={({ item }) => (
                <View style={styles.row}>
                  <View style={styles.avatar}>
                    <Text style={styles.avatarInitial}>{item.displayName.charAt(0).toUpperCase()}</Text>
                  </View>
                  <Text style={typography.bodyStrong}>@{item.username}</Text>
                  <Text style={[typography.caption, styles.viewedAt]}>{timeAgo(item.viewedAt)}</Text>
                </View>
              )}
            />
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)" },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    maxHeight: "75%",
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.lg,
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: "center", marginVertical: spacing.sm },
  title: { textAlign: "center", marginBottom: spacing.sm },
  empty: { textAlign: "center", marginVertical: spacing.lg },
  stats: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  statRow: { width: "30%", gap: 2 },
  statLabel: { color: colors.textSecondary },
  viewersHeader: { marginTop: spacing.sm, marginBottom: spacing.xs },
  list: { maxHeight: 280 },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.xs },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarInitial: { color: colors.textPrimary, fontSize: 12, fontWeight: "700" },
  viewedAt: { marginLeft: "auto", color: colors.textDisabled },
});
