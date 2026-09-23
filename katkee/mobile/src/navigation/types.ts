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
  /** Search a user and open (or reopen) a real conversation with them via the existing conversation-start endpoint. */
  NewChat: undefined;
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
  /** Single, view-only playback of one of your own Stories from Archive, active or long expired — always your own (owners bypass the normal 24h expiry check, see stories.service.ts). */
  ArchivedStoryViewer: { storyId: string };
  /** "Per-sequence Insights" (spec) — completion %, following-vs-discovery split, and profile-visit rate aggregated across every currently-active Story you own. Always the caller's own. */
  SequenceInsights: undefined;
  /** Display name + bio, wired to the existing `PATCH /api/v1/users/me` — always the caller's own profile. */
  EditProfile: undefined;
  /** Privacy, Notifications, Data & Storage, Help, About, Log Out, Delete account — the settings hub the icon reference calls for. */
  Settings: undefined;
  /** Per-type (like/comment/follow/mention) notification toggles, backed by migration 0018's real preferences table. */
  NotificationSettings: undefined;
  Help: undefined;
  About: undefined;
  /** Incoming, still-pending follow requests on a private account — accept/decline each one. */
  FollowRequests: undefined;
  /** Accounts you've blocked — a real unblock action for each, not just a one-way door. */
  BlockedAccounts: undefined;
  /** Accounts you've muted — a real unmute action for each, not just a one-way door. */
  MutedAccounts: undefined;
  /** A profile's real follower or following list — the count on a profile has looked tappable since Phase 1, but never was until now. */
  FollowList: { username: string; mode: "followers" | "following" };
  /** Pending/actioned/dismissed reports, with real Dismiss/Remove Content/Suspend actions — moderator or admin accounts only. */
  ModerationQueue: undefined;
  /** Grant or revoke moderator/admin access — admin accounts only; the primary admin can never be demoted. */
  AdminStaff: undefined;
};
