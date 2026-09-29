import React, { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { DMStackParamList } from "../../navigation/types";
import { colors, radii, spacing, typography, ICONS } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { searchUsers, type SearchResult } from "../../api/users";
import { openConversation } from "../../api/conversations";
import { ApiError } from "../../api/client";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { EmptyState } from "../../components/EmptyState";

type Props = NativeStackScreenProps<DMStackParamList, "NewChat">;

/**
 * Search a user, then open (or reopen) a real conversation with them via
 * the existing `POST /api/v1/users/:username/conversation` — the same
 * endpoint ConversationScreen's own header link already opens through
 * when tapping into someone's profile, just reached from the inbox now.
 */
export function NewChatScreen({ navigation }: Props): React.JSX.Element {
  const { accessToken } = useAuth();
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query.trim(), 300);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
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

  const onSelect = async (result: SearchResult) => {
    if (!accessToken || opening) return;
    setOpening(result.username);
    setError(null);
    try {
      const { conversation } = await openConversation(result.username, accessToken);
      navigation.replace("Conversation", {
        conversationId: conversation.id,
        otherUsername: conversation.otherUser.username,
        otherDisplayName: conversation.otherUser.displayName,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start that conversation — try again.");
      setOpening(null);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.inputWrapper}>
        <Text style={styles.inputIcon}>{ICONS.search}</Text>
        <TextInput
          style={styles.input}
          placeholder="Search people"
          placeholderTextColor={colors.textDisabled}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          value={query}
          onChangeText={setQuery}
        />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading ? <ActivityIndicator color={colors.accent} style={styles.spinner} /> : null}

      {!loading && debouncedQuery && results.length === 0 ? (
        <EmptyState title="No one found" message={`No people match "${debouncedQuery}".`} />
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <Pressable style={styles.row} onPress={() => void onSelect(item)} disabled={opening !== null}>
              <View style={styles.avatarPlaceholder}>
                <Text style={styles.avatarInitial}>{item.displayName.charAt(0).toUpperCase()}</Text>
              </View>
              <View style={styles.rowText}>
                <Text style={typography.bodyStrong}>{item.displayName}</Text>
                <Text style={typography.caption}>@{item.username}</Text>
              </View>
              {opening === item.username ? <ActivityIndicator color={colors.accent} /> : null}
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingHorizontal: spacing.md, paddingTop: spacing.md },
  inputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    marginBottom: spacing.sm,
    gap: spacing.xs,
  },
  inputIcon: { color: colors.textDisabled, fontSize: 16 },
  input: { flex: 1, paddingVertical: spacing.sm, color: colors.textPrimary, fontSize: 15 },
  error: { color: colors.danger, marginTop: spacing.sm },
  spinner: { marginTop: spacing.md },
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
});
