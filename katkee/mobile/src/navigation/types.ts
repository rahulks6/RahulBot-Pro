export type AuthStackParamList = {
  Login: undefined;
  Signup: undefined;
};

export type MainTabParamList = {
  Home: undefined;
  Search: undefined;
  Create: undefined;
  Activity: undefined;
  DM: undefined;
  Profile: undefined;
};

export type SearchStackParamList = {
  SearchHome: undefined;
  UserProfile: { username: string };
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
  Main: undefined;
  /**
   * `creators` is the ordered list of usernames swipe up/down moves
   * through (spec section 4) — a single-element list when opened from a
   * profile's Story ring (nowhere to swipe to), the full Home tray order
   * when opened from there. `startIndex` is which one to open on.
   */
  StoryViewer: { creators: string[]; startIndex: number; initialStoryId?: string };
};
