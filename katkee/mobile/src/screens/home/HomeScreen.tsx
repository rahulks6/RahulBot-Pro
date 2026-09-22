import React, { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { colors, radii, spacing, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { getFollowingFeed, type FeedEntry } from "../../api/stories";
import { EmptyState } from "../../components/EmptyState";
import type { RootStackParamList } from "../../navigation/types";

/**
 * The full swipeable, gesture-driven Story feed (spec sections 4-6) is
 * Phase 5's "full Home gesture system" — it needs a ranked mix of
 * following + recommended creators that doesn't exist until Phase 6
 * either. What's real here now: the actual list of people you follow (+
 * yourself) who have an active Story, fetched from Phase 4's backend,
 * shown as a tappable row that opens the real Story viewer. No mock
 * creators, no fake feed.
 */
export function HomeScreen(): React.JSX.Element {
  const { accessToken } = useAuth();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [feed, setFeed] = useState<FeedEntry[] | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const { feed: fetched } = await getFollowingFeed(accessToken);
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
        message="Once people you follow post, their Stories will appear here."
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
          </Pressable>
        )}
      />
      <View style={styles.placeholderBody}>
        <Text style={[typography.body, styles.placeholderText]}>
          Tap a person above to view their Stories. The full ranked Home feed lands in a later phase.
        </Text>
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
  placeholderBody: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.xl },
  placeholderText: { textAlign: "center", color: colors.textSecondary },
});
