import React from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/types";
import { StoryFeed } from "./StoryFeed";

type Props = NativeStackScreenProps<RootStackParamList, "StoryViewer">;

/**
 * A single creator (or an ordered set of them) opened from somewhere else —
 * a profile's Story ring, a notification, a DM share — with something real
 * to return to. Home (the zero-tap, full-screen, auto-advancing feed itself
 * — spec sections 4-6) renders the same StoryFeed core directly, without
 * this wrapper, since it has no "back" to go to.
 */
export function StoryViewerScreen({ route, navigation }: Props): React.JSX.Element {
  const { creators, startIndex, initialStoryId } = route.params;

  return (
    <StoryFeed
      creators={creators}
      startIndex={startIndex}
      initialStoryId={initialStoryId}
      onClose={() => navigation.goBack()}
      onOpenDM={({ storyId, ownerUsername }) => {
        navigation.navigate("Main", {
          screen: "DM",
          params: { screen: "SendStory", params: { storyId, ownerUsername } },
        });
      }}
    />
  );
}
