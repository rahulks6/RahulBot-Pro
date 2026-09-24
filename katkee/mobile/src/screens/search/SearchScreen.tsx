import React, { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { SearchStackParamList } from "../../navigation/types";
import { colors, radii, spacing, typography, ICONS } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { getFollowing, searchUsers, type SearchResult } from "../../api/users";
import { ApiError } from "../../api/client";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { EmptyState } from "../../components/EmptyState";

type Props = NativeStackScreenProps<SearchStackParamList, "SearchHome">;

type SearchFilter = "all" | "following";

// A hard cap, not a real page limit — enough for this sandbox's realistic
// following-list sizes, fetched once per screen visit and cached, rather
// than re-fetching every page on every keystroke.
const MAX_FOLLOWING_TO_FETCH = 500;
const FOLLOWING_PAGE_SIZE = 50;

/** People-focused search (spec section 30) — no Discover/Reels feed here. */
export function SearchScreen({ navigation }: Props): React.JSX.Element {
  const { accessToken, user } = useAuth();
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query.trim(), 300);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<SearchFilter>("all");
  const [followingUsernames, setFollowingUsernames] = useState<Set<string> | null>(null);
  const [loadingFollowing, setLoadingFollowing] = useState(false);

  const onSelectFilter = async (next: SearchFilter) => {
    setFilter(next);
    if (next === "following" && followingUsernames === null && accessToken && user) {
      setLoadingFollowing(true);
      try {
        const usernames = new Set<string>();
        for (let offset = 0; offset < MAX_FOLLOWING_TO_FETCH; offset += FOLLOWING_PAGE_SIZE) {
          const { following } = await getFollowing(user.username, accessToken, { limit: FOLLOWING_PAGE_SIZE, offset });
          following.forEach((f) => usernames.add(f.username));
          if (following.length < FOLLOWING_PAGE_SIZE) break;
        }
        setFollowingUsernames(usernames);
      } catch {
        setFollowingUsernames(new Set());
      } finally {
        setLoadingFollowing(false);
      }
    }
  };

  const visibleResults =
    filter === "following" && followingUsernames ? results.filter((r) => followingUsernames.has(r.username)) : results;

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

      {debouncedQuery ? (
        <View style={styles.filterRow}>
          <Pressable style={[styles.filterChip, filter === "all" && styles.filterChipActive]} onPress={() => onSelectFilter("all")}>
            <Text style={[styles.filterChipLabel, filter === "all" && styles.filterChipLabelActive]}>All</Text>
          </Pressable>
          <Pressable style={[styles.filterChip, filter === "following" && styles.filterChipActive]} onPress={() => void onSelectFilter("following")}>
            {loadingFollowing ? (
              <ActivityIndicator color={colors.textPrimary} size="small" />
            ) : (
              <Text style={[styles.filterChipLabel, filter === "following" && styles.filterChipLabelActive]}>Following</Text>
            )}
          </Pressable>
        </View>
      ) : null}

      {loading ? <ActivityIndicator color={colors.accent} style={styles.spinner} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {!loading && !error && debouncedQuery && visibleResults.length === 0 ? (
        <EmptyState
          title="No one found"
          message={
            filter === "following"
              ? `No one you follow matches "${debouncedQuery}".`
              : `No people match "${debouncedQuery}".`
          }
        />
      ) : (
        <FlatList
          data={visibleResults}
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
  filterRow: { flexDirection: "row", gap: spacing.xs, marginBottom: spacing.sm },
  filterChip: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    minWidth: 64,
    alignItems: "center",
  },
  filterChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  filterChipLabel: { ...typography.caption, fontWeight: "600", color: colors.textSecondary },
  filterChipLabelActive: { color: colors.onAccent },
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
