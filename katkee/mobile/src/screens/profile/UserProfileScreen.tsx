import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { NativeStackScreenProps, NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useNavigation } from "@react-navigation/native";
import type { SearchStackParamList, RootStackParamList } from "../../navigation/types";
import { colors, radii, spacing, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { followUser, getProfile, unfollowUser, type ProfileView } from "../../api/users";
import { ApiError } from "../../api/client";
import { getUserActiveStories } from "../../api/stories";

type Props = NativeStackScreenProps<SearchStackParamList, "UserProfile">;

/**
 * Another user's profile, reached from Search results (spec section 30:
 * "Tap result: Open Profile"). Distinct from the Profile tab's own-profile
 * screen because the actions differ (Follow/Message vs. Edit/Logout) — see
 * spec section 34.
 */
export function UserProfileScreen({ route }: Props): React.JSX.Element {
  const { username } = route.params;
  const { accessToken } = useAuth();
  // StoryViewer is registered on the root stack, above the tabs (see
  // RootNavigator.tsx) — not on this screen's own SearchStack — so this
  // screen reaches it via the shared root navigation type instead of its
  // own typed `navigation` prop.
  const rootNavigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [hasActiveStory, setHasActiveStory] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const { profile: fetched } = await getProfile(username, accessToken);
      setProfile(fetched);
      // A private account not yet followed 403s on the Stories list — that's
      // just "no ring to show", not a real error, so it's swallowed here.
      try {
        const { stories } = await getUserActiveStories(username, accessToken);
        setHasActiveStory(stories.length > 0);
      } catch {
        setHasActiveStory(false);
      }
    } catch (err) {
      setProfile(null);
      setError(err instanceof ApiError && err.status === 404 ? "This account isn't available." : "Couldn't load this profile.");
    } finally {
      setLoading(false);
    }
  }, [username, accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const openStoryViewer = () => {
    if (!hasActiveStory) return;
    rootNavigation.navigate("StoryViewer", { username });
  };

  const onFollowPress = async () => {
    if (!accessToken || !profile) return;
    setActionPending(true);
    try {
      if (profile.viewer.isFollowing || profile.viewer.hasPendingRequestFromViewer) {
        await unfollowUser(username, accessToken);
      } else {
        await followUser(username, accessToken);
      }
      await load();
    } catch {
      setError("That didn't go through — try again.");
    } finally {
      setActionPending(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (error || !profile) {
    return (
      <View style={styles.centered}>
        <Text style={typography.body}>{error ?? "Couldn't load this profile."}</Text>
      </View>
    );
  }

  const followLabel = profile.viewer.isFollowing
    ? "Following"
    : profile.viewer.hasPendingRequestFromViewer
      ? "Requested"
      : "Follow";

  return (
    <View style={styles.container}>
      <Pressable
        onPress={openStoryViewer}
        disabled={!hasActiveStory}
        style={[styles.avatarPlaceholder, hasActiveStory && styles.avatarRingActive]}
      >
        <Text style={styles.avatarInitial}>{profile.displayName.charAt(0).toUpperCase()}</Text>
      </Pressable>
      <Text style={[typography.title, styles.displayName]}>{profile.displayName}</Text>
      <Text style={typography.caption}>@{profile.username}</Text>
      {profile.bio ? <Text style={[typography.body, styles.bio]}>{profile.bio}</Text> : null}

      <View style={styles.statsRow}>
        <View style={styles.stat}>
          <Text style={typography.bodyStrong}>{profile.followerCount}</Text>
          <Text style={typography.caption}>Followers</Text>
        </View>
        <View style={styles.stat}>
          <Text style={typography.bodyStrong}>{profile.followingCount}</Text>
          <Text style={typography.caption}>Following</Text>
        </View>
      </View>

      {!profile.isSelf ? (
        <Pressable
          style={[
            styles.followButton,
            followLabel !== "Follow" && styles.followButtonActive,
            actionPending && styles.followButtonDisabled,
          ]}
          disabled={actionPending}
          onPress={onFollowPress}
        >
          {actionPending ? (
            <ActivityIndicator color={colors.onAccent} />
          ) : (
            <Text style={followLabel === "Follow" ? styles.followLabel : styles.followLabelActive}>
              {followLabel}
            </Text>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    paddingTop: spacing.xxl,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.background,
    gap: spacing.xs,
  },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background },
  avatarPlaceholder: {
    width: 88,
    height: 88,
    borderRadius: radii.pill,
    borderWidth: 3,
    borderColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    marginBottom: spacing.md,
  },
  avatarRingActive: { borderColor: colors.accent },
  avatarInitial: { fontSize: 32, fontWeight: "700", color: colors.textPrimary },
  displayName: { marginTop: spacing.sm },
  bio: { marginTop: spacing.sm, textAlign: "center" },
  statsRow: { flexDirection: "row", gap: spacing.xl, marginTop: spacing.lg },
  stat: { alignItems: "center", gap: spacing.xs },
  followButton: {
    marginTop: spacing.lg,
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    minWidth: 140,
    alignItems: "center",
  },
  followButtonActive: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: colors.border,
  },
  followButtonDisabled: { opacity: 0.6 },
  followLabel: { color: colors.onAccent, fontWeight: "700" },
  followLabelActive: { color: colors.textPrimary, fontWeight: "600" },
});
