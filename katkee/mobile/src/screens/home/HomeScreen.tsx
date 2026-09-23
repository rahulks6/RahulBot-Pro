import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { CompositeNavigationProp } from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { colors, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { getRankedHomeFeed, type RankedFeedEntry } from "../../api/stories";
import { EmptyState } from "../../components/EmptyState";
import { StoryFeed } from "../story/StoryFeed";
import type { MainTabParamList, RootStackParamList } from "../../navigation/types";

type HomeNavigationProp = CompositeNavigationProp<
  BottomTabNavigationProp<MainTabParamList, "Home">,
  NativeStackNavigationProp<RootStackParamList>
>;

/**
 * Home *is* the Story feed (spec sections 4-6): a zero-tap, full-screen,
 * auto-advancing sequence through a ranked mix of followed + discovered
 * creators (Phase 6's backend scoring), not a tray you tap into first. All
 * of the gesture handling, engagement rail, and comment/share/report sheets
 * live in StoryFeed, shared with StoryViewerScreen (used when a specific
 * creator's Stories are opened from somewhere else — a profile, a
 * notification, a DM share — which has a real "back" to return to; Home
 * doesn't, so it renders StoryFeed directly instead of through that
 * wrapper).
 */
export function HomeScreen(): React.JSX.Element {
  const { accessToken } = useAuth();
  const navigation = useNavigation<HomeNavigationProp>();
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
    <StoryFeed
      creators={feed.map((entry) => entry.owner.username)}
      startIndex={0}
      onOpenDM={({ storyId, ownerUsername }) => {
        navigation.navigate("DM", { screen: "SendStory", params: { storyId, ownerUsername } });
      }}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center" },
});
