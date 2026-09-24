import React, { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/types";
import { colors, radii, spacing, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import {
  acceptFollowRequest,
  declineFollowRequest,
  listFollowRequests,
  type IncomingFollowRequest,
} from "../../api/users";
import { EmptyState } from "../../components/EmptyState";

const PAGE_SIZE = 30;

/**
 * A real inbox for incoming follow requests — `GET /api/v1/follow-requests`
 * and the accept/decline endpoints have existed since Phase 2, but no
 * mobile screen was ever built against them; tapping a `follow_request`
 * notification only opened the requester's profile, with no way to act on
 * it from there. Reached from Settings (see SettingsScreen.tsx).
 */
export function FollowRequestsScreen(): React.JSX.Element {
  const { accessToken } = useAuth();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [requests, setRequests] = useState<IncomingFollowRequest[] | null>(null);
  const [resolving, setResolving] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!accessToken) return;
    const { requests: fetched } = await listFollowRequests(accessToken, { limit: PAGE_SIZE });
    setRequests(fetched);
  }, [accessToken]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onResolve = async (request: IncomingFollowRequest, accept: boolean) => {
    if (!accessToken || resolving.has(request.requestId)) return;
    setResolving((current) => new Set(current).add(request.requestId));
    try {
      await (accept ? acceptFollowRequest(request.requestId, accessToken) : declineFollowRequest(request.requestId, accessToken));
      setRequests((current) => (current ?? []).filter((r) => r.requestId !== request.requestId));
    } catch {
      // Leave the row in place — the most likely cause (already resolved elsewhere) is harmless to retry, and a hard failure is visible by the row simply staying actionable.
    } finally {
      setResolving((current) => {
        const next = new Set(current);
        next.delete(request.requestId);
        return next;
      });
    }
  };

  if (requests === null) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (requests.length === 0) {
    return <EmptyState title="No pending requests" message="Follow requests waiting on your approval will show up here." />;
  }

  return (
    <FlatList
      style={styles.container}
      data={requests}
      keyExtractor={(item) => item.requestId}
      renderItem={({ item }) => {
        const busy = resolving.has(item.requestId);
        return (
          <View style={styles.row}>
            <Pressable
              style={styles.identity}
              onPress={() => navigation.navigate("Main", { screen: "Search", params: { screen: "UserProfile", params: { username: item.username } } })}
            >
              <View style={styles.avatarPlaceholder}>
                <Text style={styles.avatarInitial}>{item.displayName.charAt(0).toUpperCase()}</Text>
              </View>
              <View style={styles.rowText}>
                <Text style={typography.bodyStrong}>{item.displayName}</Text>
                <Text style={typography.caption}>@{item.username}</Text>
              </View>
            </Pressable>
            {busy ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <View style={styles.actions}>
                <Pressable style={styles.declineButton} onPress={() => void onResolve(item, false)}>
                  <Text style={styles.declineLabel}>Decline</Text>
                </Pressable>
                <Pressable style={styles.acceptButton} onPress={() => void onResolve(item, true)}>
                  <Text style={styles.acceptLabel}>Accept</Text>
                </Pressable>
              </View>
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
  actions: { flexDirection: "row", gap: spacing.xs },
  declineButton: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  declineLabel: { ...typography.caption, color: colors.textSecondary, fontWeight: "600" },
  acceptButton: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  acceptLabel: { ...typography.caption, color: colors.onAccent, fontWeight: "700" },
});
