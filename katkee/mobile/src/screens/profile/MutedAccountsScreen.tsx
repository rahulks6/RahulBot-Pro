import React, { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { colors, radii, spacing, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { listMutedUsers, unmuteUser, type MutedUser } from "../../api/users";
import { EmptyState } from "../../components/EmptyState";

const PAGE_SIZE = 30;

/**
 * A real management screen for `GET /api/v1/mutes` — muting someone from
 * a Story's More menu (`StoryMoreMenu.tsx`) was a one-way door before
 * this: the backend's `DELETE /api/v1/users/:username/mute` (unmute) has
 * existed since Phase 2, but nothing anywhere in the app ever called it.
 * Reached from Settings > Privacy.
 */
export function MutedAccountsScreen(): React.JSX.Element {
  const { accessToken } = useAuth();
  const [muted, setMuted] = useState<MutedUser[] | null>(null);
  const [resolving, setResolving] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!accessToken) return;
    const { muted: fetched } = await listMutedUsers(accessToken, { limit: PAGE_SIZE });
    setMuted(fetched);
  }, [accessToken]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onUnmute = async (user: MutedUser) => {
    if (!accessToken || resolving.has(user.id)) return;
    setResolving((current) => new Set(current).add(user.id));
    try {
      await unmuteUser(user.username, accessToken);
      setMuted((current) => (current ?? []).filter((u) => u.id !== user.id));
    } catch {
      // Leave the row in place — safe to retry.
    } finally {
      setResolving((current) => {
        const next = new Set(current);
        next.delete(user.id);
        return next;
      });
    }
  };

  if (muted === null) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (muted.length === 0) {
    return <EmptyState title="No muted accounts" message="Accounts you mute will show up here so you can unmute them later." />;
  }

  return (
    <FlatList
      style={styles.container}
      data={muted}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => {
        const busy = resolving.has(item.id);
        return (
          <View style={styles.row}>
            <View style={styles.identity}>
              <View style={styles.avatarPlaceholder}>
                <Text style={styles.avatarInitial}>{item.displayName.charAt(0).toUpperCase()}</Text>
              </View>
              <View style={styles.rowText}>
                <Text style={typography.bodyStrong}>{item.displayName}</Text>
                <Text style={typography.caption}>@{item.username}</Text>
              </View>
            </View>
            {busy ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <Pressable style={styles.unmuteButton} onPress={() => void onUnmute(item)}>
                <Text style={styles.unmuteLabel}>Unmute</Text>
              </Pressable>
            )}
          </View>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  identity: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flex: 1 },
  avatarPlaceholder: {
    width: 44,
    height: 44,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarInitial: { color: colors.textPrimary, fontWeight: "700" },
  rowText: { gap: 2, flexShrink: 1 },
  unmuteButton: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  unmuteLabel: { ...typography.caption, color: colors.textPrimary, fontWeight: "600" },
});
