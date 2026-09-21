import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radii, spacing, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";

/**
 * Real Phase 1 profile: the authenticated user's own data, fetched from
 * /api/v1/auth/me at app start (see AuthContext) and Log out, which calls
 * the real /auth/logout endpoint. Highlights, the Story ring, and follower
 * counts land in Phase 2/9 once those domains exist — per section 34/58,
 * this screen must never grow a post grid or a recent-Stories row.
 */
export function ProfileScreen(): React.JSX.Element {
  const { user, logout } = useAuth();

  if (!user) {
    return (
      <View style={styles.container}>
        <Text style={typography.body}>Loading profile…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.avatarPlaceholder}>
        <Text style={styles.avatarInitial}>{user.displayName.charAt(0).toUpperCase()}</Text>
      </View>
      <Text style={[typography.title, styles.displayName]}>{user.displayName}</Text>
      <Text style={[typography.caption, styles.username]}>@{user.username}</Text>
      {user.bio ? <Text style={[typography.body, styles.bio]}>{user.bio}</Text> : null}

      <View style={styles.statsRow}>
        <View style={styles.stat}>
          <Text style={typography.bodyStrong}>—</Text>
          <Text style={typography.caption}>Followers</Text>
        </View>
        <View style={styles.stat}>
          <Text style={typography.bodyStrong}>—</Text>
          <Text style={typography.caption}>Following</Text>
        </View>
      </View>

      <Pressable style={styles.logoutButton} onPress={() => void logout()}>
        <Text style={styles.logoutLabel}>Log out</Text>
      </Pressable>
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
    borderColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    marginBottom: spacing.md,
  },
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
});
