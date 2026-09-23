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
   * profile's Story ring or a notification (nowhere to swipe to). Home
   * itself renders the same StoryFeed core directly (see HomeScreen.tsx),
   * not through this route — there's nothing to return to from there.
   * `startIndex` is which one to open on.
   */
  StoryViewer: { creators: string[]; startIndex: number; initialStoryId?: string };
  /** Sequential, view-only playback of one Highlight's items — see HighlightViewerScreen.tsx for why it's a separate, simpler viewer from StoryViewer. */
  HighlightViewer: { highlightId: string; title: string };
  /**
   * Create when `highlightId` is omitted, edit (rename/replace items/delete)
   * when it's given. Always the caller's own Highlight. `initialStoryIds`
   * (create only) preselects Stories chosen via multi-select in Archive.
   */
  HighlightEditor: { highlightId?: string; initialStoryIds?: string[] };
  /** Every Story you've ever published, expired or not — private, owner-only, grouped by month (spec: a dedicated Archive, not just the Highlight picker). */
  Archive: undefined;
};
