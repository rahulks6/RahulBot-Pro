import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { colors, radii, spacing, typography } from "../theme";
import { useAuth } from "../state/AuthContext";
import { deleteComment, listComments, postComment, type Comment } from "../api/engagement";
import { ApiError } from "../api/client";

interface Props {
  visible: boolean;
  storyId: string;
  storyOwnerId: string;
  commentsDisabled: boolean;
  onClose: () => void;
  onCommentCountChange: (delta: number) => void;
}

/**
 * Bottom sheet for a Story's comments (spec section 14). Built as a
 * translucent full-height Modal rather than a real bottom-sheet library —
 * none is installed — but it does everything the spec asks: pagination,
 * create, delete own (or, if you own the Story, delete anyone's), and it
 * pauses the Story underneath while open (the caller is responsible for
 * that — see StoryViewerScreen passing `paused` alongside `visible`).
 */
export function CommentsSheet({ visible, storyId, storyOwnerId, commentsDisabled, onClose, onCommentCountChange }: Props): React.JSX.Element {
  const { user, accessToken } = useAuth();
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const { comments: fetched } = await listComments(storyId, accessToken, { limit: 50 });
      setComments(fetched);
    } catch {
      setError("Couldn't load comments.");
    } finally {
      setLoading(false);
    }
  }, [storyId, accessToken]);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  const onSend = async () => {
    if (!accessToken || !draft.trim()) return;
    setSending(true);
    setError(null);
    try {
      const { comment } = await postComment(storyId, draft.trim(), accessToken);
      setComments((prev) => [...prev, comment]);
      setDraft("");
      onCommentCountChange(1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't post that comment.");
    } finally {
      setSending(false);
    }
  };

  const onDelete = async (commentId: string) => {
    if (!accessToken) return;
    try {
      await deleteComment(commentId, accessToken);
      setComments((prev) => prev.filter((c) => c.id !== commentId));
      onCommentCountChange(-1);
    } catch {
      setError("Couldn't delete that comment.");
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.sheet}
      >
        <View style={styles.handle} />
        <Text style={[typography.bodyStrong, styles.title]}>Comments</Text>

        {loading ? (
          <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.lg }} />
        ) : comments.length === 0 ? (
          <Text style={[typography.caption, styles.empty]}>No comments yet.</Text>
        ) : (
          <FlatList
            data={comments}
            keyExtractor={(c) => c.id}
            style={styles.list}
            renderItem={({ item }) => {
              const canDelete = item.userId === user?.id || storyOwnerId === user?.id;
              return (
                <View style={styles.row}>
                  <View style={styles.avatar}>
                    <Text style={styles.avatarInitial}>{item.displayName.charAt(0).toUpperCase()}</Text>
                  </View>
                  <View style={styles.rowBody}>
                    <Text style={typography.bodyStrong}>
                      @{item.username} <Text style={typography.body}>{item.body}</Text>
                    </Text>
                  </View>
                  {canDelete ? (
                    <Pressable onPress={() => onDelete(item.id)} hitSlop={8}>
                      <Text style={styles.deleteLabel}>Delete</Text>
                    </Pressable>
                  ) : null}
                </View>
              );
            }}
          />
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {commentsDisabled ? (
          <Text style={[typography.caption, styles.disabled]}>Comments are turned off for this Story.</Text>
        ) : (
          <View style={styles.composer}>
            <TextInput
              style={styles.input}
              placeholder="Add a comment…"
              placeholderTextColor={colors.textDisabled}
              value={draft}
              onChangeText={setDraft}
              maxLength={500}
            />
            <Pressable onPress={onSend} disabled={sending || !draft.trim()} hitSlop={8}>
              {sending ? <ActivityIndicator color={colors.accent} /> : <Text style={styles.sendLabel}>Send</Text>}
            </Pressable>
          </View>
        )}
      </KeyboardAvoidingView>
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
  list: { maxHeight: 320 },
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
  rowBody: { flex: 1 },
  deleteLabel: { color: colors.danger, fontSize: 12 },
  error: { color: colors.danger, textAlign: "center", marginTop: spacing.xs },
  disabled: { textAlign: "center", marginTop: spacing.md },
  composer: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  input: {
    flex: 1,
    backgroundColor: colors.surfaceElevated,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
  },
  sendLabel: { color: colors.accent, fontWeight: "700" },
});
