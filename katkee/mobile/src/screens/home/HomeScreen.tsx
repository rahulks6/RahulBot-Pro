import React, { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { colors, radii, spacing, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { getRankedHomeFeed, type RankedFeedEntry } from "../../api/stories";
import { EmptyState } from "../../components/EmptyState";
import type { RootStackParamList } from "../../navigation/types";

/**
 * The full swipeable, gesture-driven Story feed (spec sections 4-6) needs
 * cross-creator swipe navigation (built into StoryViewerScreen — Phase 5)
 * and a ranked mix of following + discovered creators (Phase 6's backend
 * scoring — spec sections 7-11). Both are real now: this tray is ordered
 * by `GET /api/v1/stories/feed/home`'s actual score, not just follow-graph
 * order, and includes public creators you don't yet follow. The layout
 * itself (a horizontal tray you tap into, rather than one full-bleed
 * auto-advancing card) is still a simplification of the spec's vertical
 * full-screen Home — see mobile/README.md for why.
 */
export function HomeScreen(): React.JSX.Element {
  const { accessToken } = useAuth();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [feed, setFeed] = useState<RankedFeedEntry[] | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const { feed: fetched } = await getRankedHomeFeed(accessToken);
      setFeed(fetched);
    } catch {
      setFeed([]);
    }
  }, [accessToken]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  useEffect(() => {
    void load();
  }, [load]);

  if (feed === null) {
    return (
      <View style={styles.container}>
        <Text style={typography.body}>Loading…</Text>
      </View>
    );
  }

  if (feed.length === 0) {
    return (
      <EmptyState
        title="No active Stories yet"
        message="Once people you follow — or people Katkee thinks you'd like — post, their Stories will appear here."
      />
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={feed}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tray}
        keyExtractor={(entry) => entry.owner.id}
        renderItem={({ item, index }) => (
          <Pressable
            style={styles.trayItem}
            onPress={() =>
              navigation.navigate("StoryViewer", {
                creators: feed.map((e) => e.owner.username),
                startIndex: index,
              })
            }
          >
            <View style={styles.ring}>
              <Text style={styles.ringInitial}>{item.owner.displayName.charAt(0).toUpperCase()}</Text>
            </View>
            <Text style={styles.trayLabel} numberOfLines={1}>
              @{item.owner.username}
            </Text>
            {!item.isFollowing ? <Text style={styles.discoverBadge}>Discover</Text> : null}
          </Pressable>
        )}
      />
      <View style={styles.placeholderBody}>
        <Text style={[typography.body, styles.placeholderText]}>Tap a person above to view their Stories.</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  tray: { paddingHorizontal: spacing.md, paddingVertical: spacing.md, gap: spacing.md },
  trayItem: { alignItems: "center", width: 68, gap: spacing.xs },
  ring: {
    width: 60,
    height: 60,
    borderRadius: radii.pill,
    borderWidth: 3,
    borderColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  ringInitial: { color: colors.textPrimary, fontWeight: "700", fontSize: 20 },
  trayLabel: { color: colors.textSecondary, fontSize: 11 },
  discoverBadge: { color: colors.accent, fontSize: 9, fontWeight: "700" },
  placeholderBody: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.xl },
  placeholderText: { textAlign: "center", color: colors.textSecondary },
});
