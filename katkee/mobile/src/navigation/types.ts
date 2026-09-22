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
  StoryViewer: { username: string; initialStoryId?: string };
};
