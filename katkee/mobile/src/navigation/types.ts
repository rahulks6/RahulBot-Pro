import type { NavigatorScreenParams } from "@react-navigation/native";

export type AuthStackParamList = {
  Login: undefined;
  Signup: undefined;
};

export type SearchStackParamList = {
  SearchHome: undefined;
  UserProfile: { username: string };
};

export type DMStackParamList = {
  DMInbox: undefined;
  Conversation: { conversationId: string; otherUsername: string; otherDisplayName: string };
  /** Reached from ShareSheet's "Send to a Katkee user" (spec section 15) via a root→tab→stack deep link. */
  SendStory: { storyId: string; ownerUsername: string };
};

export type MainTabParamList = {
  Home: undefined;
  // Nested-params typing so a sibling tab (e.g. Activity) can deep-link into
  // Search's UserProfile via navigation.navigate("Search", { screen: ..., params: ... }).
  Search: NavigatorScreenParams<SearchStackParamList>;
  Create: undefined;
  Activity: undefined;
  DM: NavigatorScreenParams<DMStackParamList>;
  Profile: undefined;
};

export type CreateStackParamList = {
  Camera: undefined;
  StoryEditor: {
    mediaUri: string;
    kind: "photo" | "video";
    mimeType: string;
    width: number | null;
    height: number | null;
  };
};

export type RootStackParamList = {
  // Nested so the root level (StoryViewer's ShareSheet) can deep-link two
  // levels down into a tab's own stack — e.g. Main -> DM -> SendStory.
  Main: NavigatorScreenParams<MainTabParamList>;
  /**
   * `creators` is the ordered list of usernames swipe up/down moves
   * through (spec section 4) — a single-element list when opened from a
   * profile's Story ring (nowhere to swipe to), the full Home tray order
   * when opened from there. `startIndex` is which one to open on.
   */
  StoryViewer: { creators: string[]; startIndex: number; initialStoryId?: string };
};
