import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { CompositeNavigationProp } from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { colors, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { getRankedHomeFeed, type HomeFeedEntry, type SponsoredHomeFeedEntry } from "../../api/stories";
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
  const [feed, setFeed] = useState<HomeFeedEntry[] | null>(null);

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

  // The backend interleaves sponsored entries into this same array at
  // fixed positions (recommendation.service.ts's interleaveSponsoredSlots)
  // — StoryFeed's creator sequence only knows organic usernames, so this
  // pulls the sponsored ones back out into a side map keyed by "which
  // organic creatorIndex it follows," preserving exactly the position the
  // server (not this client) decided. With ads off, `feed` never contains
  // a "sponsored" entry, so `sponsoredAfter` is always `{}` here and
  // StoryFeed's ad-handling code paths are never exercised at all.
  const creators: string[] = [];
  const sponsoredAfter: Record<number, SponsoredHomeFeedEntry> = {};
  for (const entry of feed) {
    if (entry.kind === "sponsored") {
      if (creators.length > 0) sponsoredAfter[creators.length - 1] = entry;
      continue;
    }
    creators.push(entry.owner.username);
  }

  return (
    <StoryFeed
      creators={creators}
      startIndex={0}
      sponsoredAfter={sponsoredAfter}
      onOpenDM={({ storyId, ownerUsername }) => {
        navigation.navigate("DM", { screen: "SendStory", params: { storyId, ownerUsername } });
      }}
      onOpenProfile={(username) => {
        navigation.navigate("Search", { screen: "UserProfile", params: { username } });
      }}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center" },
});
