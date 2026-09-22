import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp, NativeStackScreenProps } from "@react-navigation/native-stack";
import type { DMStackParamList, RootStackParamList } from "../../navigation/types";
import { colors, radii, spacing, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { useDM } from "../../state/DMContext";
import { listMessages, markConversationRead, sendMessage, type Message } from "../../api/conversations";
import { getStoryOwnerUsername } from "../../api/stories";

type Props = NativeStackScreenProps<DMStackParamList, "Conversation">;

const PAGE_SIZE = 30;
const POLL_INTERVAL_MS = 4_000;

/**
 * Real message thread (spec sections 32-33), backed by the Phase 8 backend.
 * The list is `inverted` with data kept in the backend's own newest-first
 * order — that's the standard React Native chat pattern (bottom of screen
 * = index 0), and it means "load older" is just `onEndReached` on this
 * same list, no reversing needed.
 */
export function ConversationScreen({ route }: Props): React.JSX.Element {
  const { conversationId, otherUsername } = route.params;
  const { accessToken, user } = useAuth();
  const { refreshUnreadCount } = useDM();
  const rootNavigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const [messages, setMessages] = useState<Message[] | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const focusedRef = useRef(true);

  const loadFirstPage = useCallback(async () => {
    if (!accessToken) return;
    const { messages: page } = await listMessages(conversationId, accessToken, { limit: PAGE_SIZE, offset: 0 });
    setMessages(page);
    setOffset(page.length);
    setHasMore(page.length === PAGE_SIZE);
    await markConversationRead(conversationId, accessToken).catch(() => {});
    void refreshUnreadCount();
  }, [accessToken, conversationId, refreshUnreadCount]);

  // Polls for new activity while this thread is open — there's no
  // push/websocket channel in this sandbox (see backend/README.md), so a
  // 4s poll is the real-time approximation for an actively open chat, a
  // tighter interval than Activity/DM's 20s badge polling since the user
  // is actively looking at this screen.
  const pollForNew = useCallback(async () => {
    if (!accessToken || !focusedRef.current) return;
    const { messages: latest } = await listMessages(conversationId, accessToken, { limit: PAGE_SIZE, offset: 0 });
    setMessages((current) => {
      if (!current) return latest;
      const knownIds = new Set(current.map((m) => m.id));
      const fresh = latest.filter((m) => !knownIds.has(m.id));
      if (fresh.length === 0) return current;
      return [...fresh, ...current];
    });
    if (latest.some((m) => m.senderId !== user?.id)) {
      await markConversationRead(conversationId, accessToken).catch(() => {});
      void refreshUnreadCount();
    }
  }, [accessToken, conversationId, refreshUnreadCount, user?.id]);

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      void loadFirstPage();
      const interval = setInterval(() => void pollForNew(), POLL_INTERVAL_MS);
      return () => {
        focusedRef.current = false;
        clearInterval(interval);
      };
    }, [loadFirstPage, pollForNew]),
  );

  const loadOlder = useCallback(async () => {
    if (!accessToken || loadingMore || !hasMore || messages === null) return;
    setLoadingMore(true);
    try {
      const { messages: page } = await listMessages(conversationId, accessToken, { limit: PAGE_SIZE, offset });
      setMessages((current) => [...(current ?? []), ...page]);
      setOffset((current) => current + page.length);
      setHasMore(page.length === PAGE_SIZE);
    } finally {
      setLoadingMore(false);
    }
  }, [accessToken, conversationId, loadingMore, hasMore, messages, offset]);

  const onSend = async () => {
    if (!accessToken || sending) return;
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    setDraft("");
    try {
      const { message } = await sendMessage(conversationId, { body }, accessToken);
      setMessages((current) => (current ? [message, ...current] : [message]));
    } catch {
      setDraft(body); // restore so the user doesn't lose what they typed
    } finally {
      setSending(false);
    }
  };

  const onOpenSharedStory = async (storyId: string) => {
    if (!accessToken) return;
    try {
      const { username: ownerUsername } = await getStoryOwnerUsername(storyId, accessToken);
      rootNavigation.navigate("StoryViewer", { creators: [ownerUsername], startIndex: 0, initialStoryId: storyId });
    } catch {
      // The Story is no longer accessible (expired/deleted) — nothing to open.
    }
  };

  if (messages === null) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={messages}
        inverted
        keyExtractor={(item) => item.id}
        onEndReachedThreshold={0.4}
        onEndReached={() => void loadOlder()}
        renderItem={({ item }) => {
          const mine = item.senderId === user?.id;
          return (
            <View style={[styles.bubbleRow, mine ? styles.bubbleRowMine : styles.bubbleRowTheirs]}>
              <Pressable
                style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}
                disabled={!item.sharedStoryId}
                onPress={() => item.sharedStoryId && void onOpenSharedStory(item.sharedStoryId)}
              >
                {item.sharedStoryId ? (
                  <Text style={mine ? styles.bubbleTextMine : styles.bubbleTextTheirs}>📎 Shared a Story — tap to view</Text>
                ) : null}
                {item.body ? <Text style={mine ? styles.bubbleTextMine : styles.bubbleTextTheirs}>{item.body}</Text> : null}
              </Pressable>
            </View>
          );
        }}
        ListFooterComponent={loadingMore ? <ActivityIndicator color={colors.accent} style={styles.footerSpinner} /> : null}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={typography.body}>Say hi to @{otherUsername} 👋</Text>
          </View>
        }
      />
      <View style={styles.composerRow}>
        <TextInput
          style={styles.composerInput}
          placeholder="Message…"
          placeholderTextColor={colors.textDisabled}
          value={draft}
          onChangeText={setDraft}
          multiline
        />
        <Pressable style={[styles.sendButton, (!draft.trim() || sending) && styles.sendButtonDisabled]} disabled={!draft.trim() || sending} onPress={onSend}>
          <Text style={styles.sendButtonText}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background },
  list: { flex: 1 },
  listContent: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, flexGrow: 1 },
  bubbleRow: { flexDirection: "row", marginVertical: spacing.xs / 2 },
  bubbleRowMine: { justifyContent: "flex-end" },
  bubbleRowTheirs: { justifyContent: "flex-start" },
  bubble: { maxWidth: "78%", borderRadius: radii.md, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, gap: 2 },
  bubbleMine: { backgroundColor: colors.accent },
  bubbleTheirs: { backgroundColor: colors.surfaceElevated },
  bubbleTextMine: { color: colors.onAccent, fontSize: 15 },
  bubbleTextTheirs: { color: colors.textPrimary, fontSize: 15 },
  footerSpinner: { marginVertical: spacing.md },
  emptyState: { flex: 1, alignItems: "center", justifyContent: "center", paddingTop: spacing.xxl, transform: [{ scaleY: -1 }] },
  composerRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  composerInput: {
    flex: 1,
    maxHeight: 100,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontSize: 15,
  },
  sendButton: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  sendButtonDisabled: { opacity: 0.5 },
  sendButtonText: { color: colors.onAccent, fontWeight: "700" },
});
