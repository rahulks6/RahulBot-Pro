import React, { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { DMStackParamList } from "../../navigation/types";
import { colors, radii, spacing, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { useDM } from "../../state/DMContext";
import { searchUsers, type SearchResult } from "../../api/users";
import { openConversation, sendMessage } from "../../api/conversations";
import { ApiError } from "../../api/client";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { EmptyState } from "../../components/EmptyState";

type Props = NativeStackScreenProps<DMStackParamList, "SendStory">;

/**
 * The "Send to a Katkee user" leg of the Share sheet (spec section 15),
 * reached from ShareSheet.tsx via a root -> Main -> DM deep link. Picking
 * someone opens (or reuses) the 1:1 conversation with them and sends the
 * Story as a message — the same allowSharing/view-access rule and
 * analytics logging as the Share sheet's other two options, enforced
 * server-side in conversations.service.ts's sendMessage.
 */
export function SendStoryScreen({ route, navigation }: Props): React.JSX.Element {
  const { storyId } = route.params;
  const { accessToken } = useAuth();
  const { refreshUnreadCount } = useDM();
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query.trim(), 300);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [sendingTo, setSendingTo] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!debouncedQuery || !accessToken) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    searchUsers(debouncedQuery, accessToken)
      .then(({ results: found }) => {
        if (!cancelled) setResults(found);
      })
      .catch(() => {
        if (!cancelled) setResults([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, accessToken]);

  const onSendTo = async (username: string) => {
    if (!accessToken || sendingTo) return;
    setSendingTo(username);
    setError(null);
    try {
      const { conversation } = await openConversation(username, accessToken);
      await sendMessage(conversation.id, { storyId }, accessToken);
      setSentTo((current) => new Set(current).add(username));
      void refreshUnreadCount();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't send — try again.");
    } finally {
      setSendingTo(null);
    }
  };

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        placeholder="Search people"
        placeholderTextColor={colors.textDisabled}
        autoCapitalize="none"
        autoCorrect={false}
        value={query}
        onChangeText={setQuery}
      />
      {loading ? <ActivityIndicator color={colors.accent} style={styles.spinner} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {!loading && debouncedQuery && results.length === 0 ? (
        <EmptyState title="No one found" message={`No people match "${debouncedQuery}".`} />
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => {
            const sent = sentTo.has(item.username);
            const busy = sendingTo === item.username;
            return (
              <Pressable style={styles.row} disabled={sent || busy} onPress={() => void onSendTo(item.username)}>
                <View style={styles.avatarPlaceholder}>
                  <Text style={styles.avatarInitial}>{item.displayName.charAt(0).toUpperCase()}</Text>
                </View>
                <View style={styles.rowText}>
                  <Text style={typography.bodyStrong}>{item.displayName}</Text>
                  <Text style={typography.caption}>@{item.username}</Text>
                </View>
                {busy ? (
                  <ActivityIndicator color={colors.accent} />
                ) : (
                  <Text style={sent ? styles.sentLabel : styles.sendLabel}>{sent ? "Sent" : "Send"}</Text>
                )}
              </Pressable>
            );
          }}
        />
      )}

      <Pressable style={styles.doneButton} onPress={() => navigation.goBack()}>
        <Text style={styles.doneLabel}>Done</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingHorizontal: spacing.md, paddingTop: spacing.md },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontSize: 15,
    marginBottom: spacing.sm,
  },
  spinner: { marginTop: spacing.md },
  error: { color: colors.danger, marginTop: spacing.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
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
  rowText: { flex: 1, gap: 2 },
  sendLabel: { color: colors.accent, fontWeight: "700" },
  sentLabel: { color: colors.textSecondary, fontWeight: "600" },
  doneButton: { paddingVertical: spacing.md, alignItems: "center" },
  doneLabel: { color: colors.textSecondary, fontWeight: "600" },
});
