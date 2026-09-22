import React, { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useNavigation } from "@react-navigation/native";
import { colors, radii, spacing, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { getProfile } from "../../api/users";
import { getMyActiveStories } from "../../api/stories";
import { HighlightsRow } from "../../components/HighlightsRow";
import { DeleteAccountSheet } from "../../components/DeleteAccountSheet";
import type { RootStackParamList } from "../../navigation/types";

/**
 * The authenticated user's own profile: real data from `/api/v1/auth/me`,
 * real follower/following counts, and a tappable Story ring when there's
 * an active Story (per spec section 34/58: Stories are reachable ONLY
 * through the profile photo — no post grid, no recent-Stories row here).
 */
export function ProfileScreen(): React.JSX.Element {
  const { user, accessToken, logout } = useAuth();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [counts, setCounts] = useState<{ followerCount: number; followingCount: number } | null>(null);
  const [hasActiveStory, setHasActiveStory] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const load = useCallback(async () => {
    if (!user || !accessToken) return;
    try {
      const { profile } = await getProfile(user.username, accessToken);
      setCounts({ followerCount: profile.followerCount, followingCount: profile.followingCount });
    } catch {
      // Non-fatal — the rest of the profile still renders with dashes below.
    }
    try {
      const { stories } = await getMyActiveStories(accessToken);
      setHasActiveStory(stories.length > 0);
    } catch {
      setHasActiveStory(false);
    }
  }, [user, accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!user) {
    return (
      <View style={styles.container}>
        <Text style={typography.body}>Loading profile…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Pressable
        onPress={() => {
          if (hasActiveStory) navigation.navigate("StoryViewer", { creators: [user.username], startIndex: 0 });
        }}
        disabled={!hasActiveStory}
        style={[styles.avatarPlaceholder, hasActiveStory && styles.avatarRingActive]}
      >
        <Text style={styles.avatarInitial}>{user.displayName.charAt(0).toUpperCase()}</Text>
      </Pressable>
      <Text style={[typography.title, styles.displayName]}>{user.displayName}</Text>
      <Text style={[typography.caption, styles.username]}>@{user.username}</Text>
      {user.bio ? <Text style={[typography.body, styles.bio]}>{user.bio}</Text> : null}

      <View style={styles.statsRow}>
        <View style={styles.stat}>
          <Text style={typography.bodyStrong}>{counts ? counts.followerCount : "—"}</Text>
          <Text style={typography.caption}>Followers</Text>
        </View>
        <View style={styles.stat}>
          <Text style={typography.bodyStrong}>{counts ? counts.followingCount : "—"}</Text>
          <Text style={typography.caption}>Following</Text>
        </View>
      </View>

      <HighlightsRow username={user.username} isOwner />

      <Pressable style={styles.logoutButton} onPress={() => void logout()}>
        <Text style={styles.logoutLabel}>Log out</Text>
      </Pressable>

      <Pressable style={styles.deleteAccountLink} onPress={() => setDeleteOpen(true)}>
        <Text style={styles.deleteAccountLabel}>Delete account</Text>
      </Pressable>

      <DeleteAccountSheet visible={deleteOpen} onClose={() => setDeleteOpen(false)} />
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
  avatarInitial: {
    fontSize: 32,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  displayName: { marginTop: spacing.sm },
  username: {},
  bio: { marginTop: spacing.sm, textAlign: "center" },
  statsRow: {
    flexDirection: "row",
    gap: spacing.xl,
    marginTop: spacing.lg,
  },
  stat: { alignItems: "center", gap: spacing.xs },
  logoutButton: {
    marginTop: spacing.xxl,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  logoutLabel: {
    color: colors.danger,
    fontWeight: "600",
  },
  deleteAccountLink: { marginTop: spacing.md },
  deleteAccountLabel: { ...typography.caption, color: colors.textDisabled },
});
