import React, { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import type { CompositeNavigationProp } from "@react-navigation/native";
import type { MainTabParamList, RootStackParamList } from "../../navigation/types";
import { colors, radii, spacing, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { useNotifications } from "../../state/NotificationsContext";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationRecord,
} from "../../api/notifications";
import { getStoryOwnerUsername } from "../../api/stories";
import { EmptyState } from "../../components/EmptyState";

const PAGE_SIZE = 20;

type ActivityNavigationProp = CompositeNavigationProp<
  BottomTabNavigationProp<MainTabParamList, "Activity">,
  NativeStackNavigationProp<RootStackParamList>
>;

function isToday(isoDate: string): boolean {
  const date = new Date(isoDate);
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

function messageFor(notification: NotificationRecord): string {
  const name = notification.actor?.displayName ?? "Someone";
  switch (notification.type) {
    case "like":
      return `${name} liked your Story.`;
    case "comment":
      return `${name} commented: "${notification.comment?.body ?? ""}"`;
    case "follow":
      return `${name} started following you.`;
    case "follow_request":
      return `${name} requested to follow you.`;
    case "mention":
      return `${name} mentioned you in a comment.`;
    default:
      return `${name} did something.`;
  }
}

interface GroupedLikeRow {
  kind: "grouped-like";
  key: string;
  unreadIds: string[];
  storyId: string;
  actorNames: string[]; // up to 2, most recent first
  totalCount: number;
  createdAt: string;
  anyUnread: boolean;
}

interface SingleRow {
  kind: "single";
  key: string;
  notification: NotificationRecord;
}

type ActivityRow = GroupedLikeRow | SingleRow;

function messageForGroup(row: GroupedLikeRow): string {
  const [first, second] = row.actorNames;
  if (row.totalCount <= 1) return `${first ?? "Someone"} liked your Story.`;
  if (row.totalCount === 2) return `${first} and ${second} liked your Story.`;
  const others = row.totalCount - 2;
  return `${first}, ${second} and ${others} other${others === 1 ? "" : "s"} liked your Story.`;
}

/**
 * Merges consecutive-by-story `like` notifications into one row — spec:
 * "Rahul, Priya and 12 others liked your Story" rather than a dozen
 * identical individual rows. Every other notification type (comment has
 * its own body per row; follow/follow_request/mention are each about a
 * distinct relationship or reference) stays one row per notification.
 * Grouping happens per Today/Earlier bucket, keyed by story id, keeping
 * each group's position at its most recent like (the list arrives
 * newest-first from the backend).
 */
function groupNotifications(notifications: NotificationRecord[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  const groupIndexByStoryId = new Map<string, number>();

  for (const notification of notifications) {
    if (notification.type === "like" && notification.story) {
      const storyId = notification.story.id;
      const existingIndex = groupIndexByStoryId.get(storyId);
      const actorName = notification.actor?.displayName ?? "Someone";
      if (existingIndex !== undefined) {
        const group = rows[existingIndex] as GroupedLikeRow;
        if (notification.readAt === null) {
          group.unreadIds.push(notification.id);
          group.anyUnread = true;
        }
        group.totalCount += 1;
        if (group.actorNames.length < 2) group.actorNames.push(actorName);
        continue;
      }
      const group: GroupedLikeRow = {
        kind: "grouped-like",
        key: `like-group-${storyId}`,
        unreadIds: notification.readAt === null ? [notification.id] : [],
        storyId,
        actorNames: [actorName],
        totalCount: 1,
        createdAt: notification.createdAt,
        anyUnread: notification.readAt === null,
      };
      groupIndexByStoryId.set(storyId, rows.length);
      rows.push(group);
      continue;
    }
    rows.push({ kind: "single", key: notification.id, notification });
  }

  return rows;
}

/**
 * Real notification list (spec section 31), grouped into Today/Earlier.
 * Tapping a like/comment/mention notification you own the Story for opens
 * that Story directly; a mention resolves the Story's real owner via
 * GET /api/v1/stories/:id/owner (Phase 8) since a mention's Story can
 * belong to anyone, unlike like/comment. A follow / follow_request, or a
 * mention whose owner lookup fails (e.g. the Story has since expired),
 * opens the actor's profile instead.
 */
export function ActivityScreen(): React.JSX.Element {
  const { accessToken, user } = useAuth();
  const { refreshUnreadCount } = useNotifications();
  const navigation = useNavigation<ActivityNavigationProp>();

  const [notifications, setNotifications] = useState<NotificationRecord[] | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadFirstPage = useCallback(async () => {
    if (!accessToken) return;
    const { notifications: page } = await listNotifications(accessToken, { limit: PAGE_SIZE, offset: 0 });
    setNotifications(page);
    setOffset(page.length);
    setHasMore(page.length === PAGE_SIZE);
    void refreshUnreadCount();
  }, [accessToken, refreshUnreadCount]);

  useFocusEffect(
    useCallback(() => {
      void loadFirstPage();
    }, [loadFirstPage]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadFirstPage();
    } finally {
      setRefreshing(false);
    }
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!accessToken || loadingMore || !hasMore || notifications === null) return;
    setLoadingMore(true);
    try {
      const { notifications: page } = await listNotifications(accessToken, { limit: PAGE_SIZE, offset });
      setNotifications((current) => [...(current ?? []), ...page]);
      setOffset((current) => current + page.length);
      setHasMore(page.length === PAGE_SIZE);
    } finally {
      setLoadingMore(false);
    }
  }, [accessToken, loadingMore, hasMore, notifications, offset]);

  const sections = useMemo(() => {
    if (!notifications) return [];
    const today = notifications.filter((n) => isToday(n.createdAt));
    const earlier = notifications.filter((n) => !isToday(n.createdAt));
    return [
      ...(today.length ? [{ title: "Today", data: groupNotifications(today) }] : []),
      ...(earlier.length ? [{ title: "Earlier", data: groupNotifications(earlier) }] : []),
    ];
  }, [notifications]);

  const unreadInList = notifications?.some((n) => n.readAt === null) ?? false;

  const markLocalRead = (ids: string[]) => {
    setNotifications((current) =>
      current ? current.map((n) => (ids.includes(n.id) ? { ...n, readAt: n.readAt ?? new Date().toISOString() } : n)) : current,
    );
  };

  const onPressRow = async (row: ActivityRow) => {
    if (row.kind === "grouped-like") {
      if (row.unreadIds.length > 0 && accessToken) {
        markLocalRead(row.unreadIds);
        Promise.all(row.unreadIds.map((id) => markNotificationRead(id, accessToken)))
          .then(() => refreshUnreadCount())
          .catch(() => {});
      }
      if (user) {
        // Same reasoning as the single-like case below: the recipient of a
        // like is always the Story's own owner.
        navigation.navigate("StoryViewer", { creators: [user.username], startIndex: 0, initialStoryId: row.storyId });
      }
      return;
    }

    const notification = row.notification;
    if (notification.readAt === null && accessToken) {
      markLocalRead([notification.id]);
      markNotificationRead(notification.id, accessToken)
        .then(() => refreshUnreadCount())
        .catch(() => {});
    }

    if ((notification.type === "like" || notification.type === "comment") && notification.story && user) {
      // The recipient of a like/comment notification is always the Story's
      // owner (see backend notifications.service.ts's notifyLike/notifyComment),
      // so the viewer's own username is the correct `creators` entry here.
      navigation.navigate("StoryViewer", {
        creators: [user.username],
        startIndex: 0,
        initialStoryId: notification.story.id,
      });
      return;
    }

    if (notification.type === "mention" && notification.story && accessToken) {
      // A mention's Story could belong to anyone, unlike like/comment —
      // resolve the real owner via GET /api/v1/stories/:id/owner rather
      // than guessing. Falls back to the actor's profile if that lookup
      // fails (e.g. the Story has since expired for this viewer).
      try {
        const { username: ownerUsername } = await getStoryOwnerUsername(notification.story.id, accessToken);
        navigation.navigate("StoryViewer", {
          creators: [ownerUsername],
          startIndex: 0,
          initialStoryId: notification.story.id,
        });
        return;
      } catch {
        // fall through to opening the actor's profile below
      }
    }

    if (notification.actor) {
      navigation.navigate("Search", { screen: "UserProfile", params: { username: notification.actor.username } });
    }
  };

  const onMarkAllRead = async () => {
    if (!accessToken) return;
    setNotifications((current) => (current ? current.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })) : current));
    try {
      await markAllNotificationsRead(accessToken);
    } finally {
      void refreshUnreadCount();
    }
  };

  if (notifications === null) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (notifications.length === 0) {
    return <EmptyState title="No activity yet" message="Likes, comments, and follows will show up here." />;
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={typography.title}>Activity</Text>
        {unreadInList ? (
          <Pressable onPress={onMarkAllRead} hitSlop={8}>
            <Text style={styles.markAllRead}>Mark all read</Text>
          </Pressable>
        ) : null}
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(row) => row.key}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
        onEndReachedThreshold={0.4}
        onEndReached={() => void loadMore()}
        renderSectionHeader={({ section }) => <Text style={styles.sectionHeader}>{section.title}</Text>}
        renderItem={({ item: row }) => {
          const avatarLetter = (row.kind === "grouped-like" ? row.actorNames[0] : row.notification.actor?.displayName) ?? "?";
          const message = row.kind === "grouped-like" ? messageForGroup(row) : messageFor(row.notification);
          const createdAt = row.kind === "grouped-like" ? row.createdAt : row.notification.createdAt;
          const unread = row.kind === "grouped-like" ? row.anyUnread : row.notification.readAt === null;
          return (
            <Pressable style={styles.row} onPress={() => void onPressRow(row)}>
              <View style={styles.avatarPlaceholder}>
                <Text style={styles.avatarInitial}>{avatarLetter.charAt(0).toUpperCase()}</Text>
              </View>
              <View style={styles.rowText}>
                <Text style={typography.body} numberOfLines={2}>
                  {message}
                </Text>
                <Text style={typography.caption}>{new Date(createdAt).toLocaleString()}</Text>
              </View>
              {unread ? <View style={styles.unreadDot} /> : null}
            </Pressable>
          );
        }}
        ListFooterComponent={loadingMore ? <ActivityIndicator color={colors.accent} style={styles.footerSpinner} /> : null}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  markAllRead: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  sectionHeader: {
    ...typography.label,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
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
  rowText: { flex: 1, gap: 2 },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
  },
  footerSpinner: { marginVertical: spacing.md },
});
