import React, { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp, NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/types";
import { colors, radii, spacing, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { getFollowers, getFollowing, type FollowedUser } from "../../api/users";
import { ApiError } from "../../api/client";
import { EmptyState } from "../../components/EmptyState";

type Props = NativeStackScreenProps<RootStackParamList, "FollowList">;

const PAGE_SIZE = 30;

/**
 * The follower/following *count* on a profile has been tappable-looking
 * (bold number + label) since Phase 1, but tapping it never did anything
 * — `GET /api/v1/users/:username/followers`/`.../following` have both
 * existed and been tested since Phase 2, with no mobile screen ever built
 * against either. One shared screen for both directions, since they're
 * the same shape and the same access rules (`assertCanViewConnections`
 * on the backend): owner, or an accepted follower of a private account.
 */
export function FollowListScreen({ route }: Props): React.JSX.Element {
  const { username, mode } = route.params;
  const { accessToken } = useAuth();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const [users, setUsers] = useState<FollowedUser[] | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchList = useCallback(
    async (fetchOffset: number): Promise<FollowedUser[]> => {
      if (mode === "followers") {
        const { followers } = await getFollowers(username, accessToken as string, { limit: PAGE_SIZE, offset: fetchOffset });
        return followers;
      }
      const { following } = await getFollowing(username, accessToken as string, { limit: PAGE_SIZE, offset: fetchOffset });
      return following;
    },
    [mode, username, accessToken],
  );

  const loadFirstPage = useCallback(async () => {
    if (!accessToken) return;
    try {
      const list = await fetchList(0);
      setUsers(list);
      setOffset(list.length);
      setHasMore(list.length === PAGE_SIZE);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403 ? "This account is private." : "Couldn't load this list.");
      setUsers([]);
    }
  }, [accessToken, fetchList]);

  useFocusEffect(
    useCallback(() => {
      void loadFirstPage();
    }, [loadFirstPage]),
  );

  const loadMore = useCallback(async () => {
    if (!accessToken || loadingMore || !hasMore || users === null) return;
    setLoadingMore(true);
    try {
      const list = await fetchList(offset);
      setUsers((current) => [...(current ?? []), ...list]);
      setOffset((current) => current + list.length);
      setHasMore(list.length === PAGE_SIZE);
    } finally {
      setLoadingMore(false);
    }
  }, [accessToken, fetchList, loadingMore, hasMore, users, offset]);

  if (users === null) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (error) {
    return <EmptyState title="Can't show this list" message={error} />;
  }

  if (users.length === 0) {
    return (
      <EmptyState
        title={mode === "followers" ? "No followers yet" : "Not following anyone yet"}
        message={mode === "followers" ? "People who follow @" + username + " will show up here." : "Accounts @" + username + " follows will show up here."}
      />
    );
  }

  return (
    <FlatList
      style={styles.container}
      data={users}
      keyExtractor={(item) => item.id}
      onEndReachedThreshold={0.4}
      onEndReached={() => void loadMore()}
      ListFooterComponent={loadingMore ? <ActivityIndicator color={colors.accent} style={styles.footerSpinner} /> : null}
      renderItem={({ item }) => (
        <Pressable
          style={styles.row}
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
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background },
  footerSpinner: { marginVertical: spacing.md },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  avatarPlaceholder: {
    width: 44,
    height: 44,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarInitial: { color: colors.textPrimary, fontWeight: "700" },
  rowText: { gap: 2 },
});
