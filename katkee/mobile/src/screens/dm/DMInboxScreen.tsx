import React, { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { DMStackParamList } from "../../navigation/types";
import { colors, radii, spacing, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { useDM } from "../../state/DMContext";
import { listConversations, type ConversationSummary } from "../../api/conversations";
import { EmptyState } from "../../components/EmptyState";

function previewText(conversation: ConversationSummary, myUserId: string | undefined): string {
  const lastMessage = conversation.lastMessage;
  if (!lastMessage) return "Say hi 👋";
  const prefix = lastMessage.senderId === myUserId ? "You: " : "";
  if (lastMessage.sharedStoryId) return `${prefix}Shared a Story`;
  return `${prefix}${lastMessage.body ?? ""}`;
}

/** Real conversation list (spec sections 32-33), backed by the Phase 8 backend. */
export function DMInboxScreen(): React.JSX.Element {
  const { accessToken, user } = useAuth();
  const { refreshUnreadCount } = useDM();
  const navigation = useNavigation<NativeStackNavigationProp<DMStackParamList>>();

  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken) return;
    const { conversations: fetched } = await listConversations(accessToken, { limit: 50 });
    setConversations(fetched);
    void refreshUnreadCount();
  }, [accessToken, refreshUnreadCount]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  if (conversations === null) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (conversations.length === 0) {
    return <EmptyState title="No messages yet" message="Conversations with people you message will appear here." />;
  }

  return (
    <FlatList
      style={styles.container}
      data={conversations}
      keyExtractor={(item) => item.id}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
      renderItem={({ item }) => (
        <Pressable
          style={styles.row}
          onPress={() =>
            navigation.navigate("Conversation", {
              conversationId: item.id,
              otherUsername: item.otherUser.username,
              otherDisplayName: item.otherUser.displayName,
            })
          }
        >
          <View style={styles.avatarPlaceholder}>
            <Text style={styles.avatarInitial}>{item.otherUser.displayName.charAt(0).toUpperCase()}</Text>
          </View>
          <View style={styles.rowText}>
            <Text style={typography.bodyStrong}>{item.otherUser.displayName}</Text>
            <Text style={[typography.caption, item.unread && styles.unreadPreview]} numberOfLines={1}>
              {previewText(item, user?.id)}
            </Text>
          </View>
          {item.unread ? <View style={styles.unreadDot} /> : null}
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  avatarPlaceholder: {
    width: 48,
    height: 48,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarInitial: { color: colors.textPrimary, fontWeight: "700", fontSize: 18 },
  rowText: { flex: 1, gap: 2 },
  unreadPreview: { color: colors.textPrimary, fontWeight: "600" },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
  },
});
