import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radii, spacing, typography } from "../theme";
import { useAuth } from "../state/AuthContext";
import { getStoryViewers, type StoryViewer } from "../api/stories";

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

/**
 * Owner-only: who actually watched (spec's Insights viewer list). The
 * count itself (StoryFeed's small "eye" figure) is visible to any viewer —
 * this sheet, and the identities in it, are not; the backend rejects this
 * endpoint outright for anyone but the Story's own owner.
 */
export function StoryViewersSheet({ visible, storyId, onClose }: Props): React.JSX.Element {
  const { accessToken } = useAuth();
  const [viewers, setViewers] = useState<StoryViewer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const { viewers: fetched } = await getStoryViewers(storyId, accessToken);
      setViewers(fetched);
    } catch {
      setError("Couldn't load viewers.");
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
        <Text style={[typography.bodyStrong, styles.title]}>
          {viewers.length > 0 ? `Viewed by ${viewers.length}` : "Viewers"}
        </Text>

        {loading ? (
          <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.lg }} />
        ) : error ? (
          <Text style={[typography.caption, styles.empty]}>{error}</Text>
        ) : viewers.length === 0 ? (
          <Text style={[typography.caption, styles.empty]}>No views yet.</Text>
        ) : (
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
    maxHeight: "70%",
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.lg,
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: "center", marginVertical: spacing.sm },
  title: { textAlign: "center", marginBottom: spacing.sm },
  empty: { textAlign: "center", marginVertical: spacing.lg },
  list: { maxHeight: 360 },
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
