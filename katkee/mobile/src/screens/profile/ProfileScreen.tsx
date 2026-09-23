import React, { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useNavigation } from "@react-navigation/native";
import { colors, radii, spacing, typography, ICONS } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { getProfile } from "../../api/users";
import { getMyActiveStories } from "../../api/stories";
import { HighlightsRow } from "../../components/HighlightsRow";
import type { RootStackParamList } from "../../navigation/types";

/**
 * The authenticated user's own profile: real data from `/api/v1/auth/me`,
 * real follower/following counts, and a tappable Story ring when there's
 * an active Story (per spec section 34/58: Stories are reachable ONLY
 * through the profile photo — no post grid, no recent-Stories row here).
 */
export function ProfileScreen(): React.JSX.Element {
  const { user, accessToken } = useAuth();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [counts, setCounts] = useState<{ followerCount: number; followingCount: number } | null>(null);
  const [hasActiveStory, setHasActiveStory] = useState(false);
  const [scrollEnabled, setScrollEnabled] = useState(true);

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

  const onShareProfile = async () => {
    const deepLink = `katkee://user/${user.username}`;
    try {
      await Share.share({ message: `@${user.username} on Katkee: ${deepLink}` });
    } catch {
      // User cancelled the native sheet — not an error.
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container} scrollEnabled={scrollEnabled}>
      <Pressable
        style={styles.settingsButton}
        onPress={() => navigation.navigate("Settings")}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Settings"
      >
        <Text style={styles.settingsGlyph}>{ICONS.settings}</Text>
      </Pressable>

      <Pressable
        onPress={() => {
          if (hasActiveStory) navigation.navigate("StoryViewer", { creators: [user.username], startIndex: 0 });
        }}
        disabled={!hasActiveStory}
        style={[styles.avatarPlaceholder, hasActiveStory && styles.avatarRingActive]}
        accessibilityRole={hasActiveStory ? "button" : undefined}
        accessibilityLabel={hasActiveStory ? "Open your Story" : user.displayName}
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

      <View style={styles.actionRow}>
        <Pressable style={styles.actionButton} onPress={() => navigation.navigate("EditProfile")}>
          <Text style={styles.actionButtonLabel}>Edit Profile</Text>
        </Pressable>
        <Pressable style={styles.actionButton} onPress={() => void onShareProfile()}>
          <Text style={styles.actionButtonLabel}>Share Profile</Text>
        </Pressable>
      </View>

      <View style={styles.linkRow}>
        <Pressable style={styles.archiveLink} onPress={() => navigation.navigate("Archive")}>
          <Text style={styles.archiveLinkLabel}>Archive</Text>
        </Pressable>
        <Pressable style={styles.archiveLink} onPress={() => navigation.navigate("SequenceInsights")}>
          <Text style={styles.archiveLinkLabel}>Insights</Text>
        </Pressable>
      </View>

      <HighlightsRow username={user.username} isOwner onReorderModeChange={(active) => setScrollEnabled(!active)} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    alignItems: "center",
    paddingTop: spacing.xxl,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
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
  settingsButton: { position: "absolute", top: spacing.md, right: spacing.md, padding: spacing.xs },
  settingsGlyph: { fontSize: 22, color: colors.textPrimary },
  actionRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.lg, width: "100%" },
  actionButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    alignItems: "center",
  },
  actionButtonLabel: { ...typography.caption, fontWeight: "700", color: colors.textPrimary },
  linkRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.lg },
  archiveLink: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  archiveLinkLabel: { ...typography.caption, color: colors.textSecondary, fontWeight: "600" },
});
