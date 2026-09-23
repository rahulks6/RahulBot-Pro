import React, { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { SearchStackParamList } from "../../navigation/types";
import { colors, radii, spacing, typography, ICONS } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { searchUsers, type SearchResult } from "../../api/users";
import { ApiError } from "../../api/client";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { EmptyState } from "../../components/EmptyState";

type Props = NativeStackScreenProps<SearchStackParamList, "SearchHome">;

/** People-focused search (spec section 30) — no Discover/Reels feed here. */
export function SearchScreen({ navigation }: Props): React.JSX.Element {
  const { accessToken } = useAuth();
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query.trim(), 300);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!debouncedQuery || !accessToken) {
      setResults([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    searchUsers(debouncedQuery, accessToken)
      .then(({ results: found }) => {
        if (!cancelled) setResults(found);
      })
      .catch((err) => {
        if (cancelled) return;
        setResults([]);
        setError(err instanceof ApiError ? err.message : "Search failed — check your connection.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, accessToken]);

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
          value={query}
          onChangeText={setQuery}
        />
        {query.length > 0 ? (
          <Pressable onPress={() => setQuery("")} hitSlop={8} accessibilityRole="button" accessibilityLabel="Clear search">
            <Text style={styles.inputIcon}>{ICONS.clear}</Text>
          </Pressable>
        ) : null}
      </View>

      {loading ? <ActivityIndicator color={colors.accent} style={styles.spinner} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {!loading && !error && debouncedQuery && results.length === 0 ? (
        <EmptyState title="No one found" message={`No people match "${debouncedQuery}".`} />
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onPress={() => navigation.navigate("UserProfile", { username: item.username })}
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
  input: {
    flex: 1,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontSize: 15,
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
  rowText: { gap: 2 },
});
