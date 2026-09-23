import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { colors, radii, spacing, typography, ICONS } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { useDM } from "../../state/DMContext";
import { listMessages, markConversationRead, sendMessage, type Message } from "../../api/conversations";
import { getStoryOwnerUsername } from "../../api/stories";

type Props = NativeStackScreenProps<DMStackParamList, "Conversation">;

const PAGE_SIZE = 30;
const POLL_INTERVAL_MS = 4_000;

/**
 * A locally-echoed outgoing message, before (and unless) the server
 * confirms it — spec's Sending/Failed states, which are purely
 * client-local: a message that actually exists server-side is
 * definitionally at least "sent" (see backend/.../conversations.service.ts's
 * listMessages, which is where Sent/Delivered/Read come from instead).
 */
interface PendingMessage {
  kind: "pending";
  tempId: string;
  body: string;
  status: "sending" | "failed";
}

type ListRow = PendingMessage | (Message & { kind: "sent" });

function rowKey(row: ListRow): string {
  return row.kind === "pending" ? row.tempId : row.id;
}

function statusLabel(row: ListRow): string {
  if (row.kind === "pending") return row.status === "failed" ? "Failed · Tap to retry" : "Sending…";
  switch (row.status) {
    case "read":
      return "Read";
    case "delivered":
      return "Delivered";
    default:
      return "Sent";
  }
}

/**
 * Real message thread (spec sections 32-33), backed by the Phase 8 backend.
 * The list is `inverted` with data kept in the backend's own newest-first
 * order — that's the standard React Native chat pattern (bottom of screen
 * = index 0), and it means "load older" is just `onEndReached` on this
 * same list, no reversing needed. Pending (unsent) messages are always
 * newer than anything confirmed, so they're simply prepended ahead of it.
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
  const [pending, setPending] = useState<PendingMessage[]>([]);
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
  // is actively looking at this screen. Also refreshes already-known
  // messages' `status` (not just appends new ones) — otherwise a sent
  // message's tick would never progress to Delivered/Read once it first
  // landed in state.
  const pollForNew = useCallback(async () => {
    if (!accessToken || !focusedRef.current) return;
    const { messages: latest } = await listMessages(conversationId, accessToken, { limit: PAGE_SIZE, offset: 0 });
    const latestById = new Map(latest.map((m) => [m.id, m]));
    setMessages((current) => {
      if (!current) return latest;
      const knownIds = new Set(current.map((m) => m.id));
      const fresh = latest.filter((m) => !knownIds.has(m.id));
      const refreshed = current.map((m) => latestById.get(m.id) ?? m);
      return [...fresh, ...refreshed];
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

  // Shared by a fresh send and a retry — a retry is just re-attempting the
  // same pending entry, not creating a new one (so its position in the
  // list doesn't jump).
  const attemptSend = useCallback(
    async (tempId: string, body: string) => {
      if (!accessToken) return;
      setPending((current) => current.map((p) => (p.tempId === tempId ? { ...p, status: "sending" } : p)));
      try {
        const { message } = await sendMessage(conversationId, { body }, accessToken);
        setPending((current) => current.filter((p) => p.tempId !== tempId));
        setMessages((current) => {
          if (!current) return [message];
          // A concurrent poll (every 4s while this thread is open) can beat
          // this response back with the same message already included.
          if (current.some((m) => m.id === message.id)) return current;
          return [message, ...current];
        });
      } catch {
        setPending((current) => current.map((p) => (p.tempId === tempId ? { ...p, status: "failed" } : p)));
      }
    },
    [accessToken, conversationId],
  );

  const onSend = () => {
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    const tempId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setPending((current) => [{ kind: "pending", tempId, body, status: "sending" }, ...current]);
    void attemptSend(tempId, body);
  };

  const onRetry = (p: PendingMessage) => {
    if (p.status !== "failed") return;
    void attemptSend(p.tempId, p.body);
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

  const rows: ListRow[] = useMemo(
    () => [...pending, ...(messages ?? []).map((m) => ({ ...m, kind: "sent" as const }))],
    [pending, messages],
  );

  // A status caption only ever makes sense under the single most recent
  // message *you* sent — same convention as iMessage/WhatsApp. If the
  // newest row in the thread is pending, that's it; if it's a confirmed
  // message but from the other person (they replied after your last
  // message), nothing shows at all.
  const statusRowKey = useMemo(() => {
    const first = rows[0];
    if (!first) return null;
    if (first.kind === "pending") return first.tempId;
    return first.senderId === user?.id ? first.id : null;
  }, [rows, user?.id]);

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
        data={rows}
        inverted
        keyExtractor={rowKey}
        onEndReachedThreshold={0.4}
        onEndReached={() => void loadOlder()}
        renderItem={({ item: row }) => {
          const mine = row.kind === "pending" || row.senderId === user?.id;
          const failed = row.kind === "pending" && row.status === "failed";
          const showStatus = rowKey(row) === statusRowKey;
          return (
            <View style={[styles.bubbleRow, mine ? styles.bubbleRowMine : styles.bubbleRowTheirs]}>
              <View style={[styles.bubbleColumn, mine ? styles.bubbleColumnMine : styles.bubbleColumnTheirs]}>
                <Pressable
                  style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs, failed && styles.bubbleFailed]}
                  disabled={row.kind === "sent" ? !row.sharedStoryId : !failed}
                  onPress={() => {
                    if (row.kind === "pending") onRetry(row);
                    else if (row.sharedStoryId) void onOpenSharedStory(row.sharedStoryId);
                  }}
                >
                  {row.kind === "sent" && row.sharedStoryId ? (
                    <Text style={mine ? styles.bubbleTextMine : styles.bubbleTextTheirs}>{ICONS.attach} Shared a Story — tap to view</Text>
                  ) : null}
                  {row.body ? <Text style={mine ? styles.bubbleTextMine : styles.bubbleTextTheirs}>{row.body}</Text> : null}
                </Pressable>
                {showStatus ? <Text style={styles.statusCaption}>{statusLabel(row)}</Text> : null}
              </View>
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
        <Pressable
          style={[styles.sendButton, !draft.trim() && styles.sendButtonDisabled]}
          disabled={!draft.trim()}
          onPress={onSend}
          accessibilityRole="button"
          accessibilityLabel="Send"
        >
          <Text style={styles.sendButtonText}>{ICONS.send}</Text>
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
  bubbleColumn: { maxWidth: "78%" },
  bubbleColumnMine: { alignItems: "flex-end" },
  bubbleColumnTheirs: { alignItems: "flex-start" },
  bubble: { borderRadius: radii.md, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, gap: 2 },
  bubbleMine: { backgroundColor: colors.accent },
  bubbleTheirs: { backgroundColor: colors.surfaceElevated },
  bubbleFailed: { backgroundColor: colors.danger },
  bubbleTextMine: { color: colors.onAccent, fontSize: 15 },
  bubbleTextTheirs: { color: colors.textPrimary, fontSize: 15 },
  statusCaption: { color: colors.textDisabled, fontSize: 11, marginTop: 2 },
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
