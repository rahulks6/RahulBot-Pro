import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useFocusEffect } from "@react-navigation/native";
import type { RootStackParamList } from "../../navigation/types";
import { colors, radii, spacing, typography, ICONS } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { updateMyProfile, listFollowRequests } from "../../api/users";
import { countPendingDrafts, clearAllPendingDrafts } from "../../state/draftStorage";
import { ListRow } from "../../components/ListRow";
import { DeleteAccountSheet } from "../../components/DeleteAccountSheet";

type Props = NativeStackScreenProps<RootStackParamList, "Settings">;

/**
 * The real settings hub the icon reference calls for: Privacy (backed by
 * the same `isPrivate` field Edit Profile's screen leaves alone), a link
 * into real per-type Notification toggles, a real "Data & Storage" (the
 * one thing this app actually caches on-device — crash-autosaved Story
 * drafts, see draftStorage.ts), static Help/About, Log Out (moved here
 * from the profile page itself, matching the reference), and account
 * deletion (moved here from ProfileScreen, same reasoning).
 */
export function SettingsScreen({ navigation }: Props): React.JSX.Element {
  const { user, accessToken, logout, refreshUser } = useAuth();
  const [isPrivate, setIsPrivate] = useState(user?.isPrivate ?? false);
  const [togglingPrivacy, setTogglingPrivacy] = useState(false);
  const [draftCount, setDraftCount] = useState<number | null>(null);
  const [pendingRequestCount, setPendingRequestCount] = useState<number | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    setIsPrivate(user?.isPrivate ?? false);
  }, [user?.isPrivate]);

  useFocusEffect(
    useCallback(() => {
      void countPendingDrafts().then(setDraftCount);
      if (accessToken) {
        // A count-only fetch, capped at one page — this only needs to show
        // a badge, not the full list (FollowRequestsScreen does that).
        void listFollowRequests(accessToken, { limit: 50 })
          .then(({ requests }) => setPendingRequestCount(requests.length))
          .catch(() => setPendingRequestCount(null));
      }
    }, [accessToken]),
  );

  const onTogglePrivacy = async (next: boolean) => {
    if (!accessToken || togglingPrivacy) return;
    setTogglingPrivacy(true);
    setIsPrivate(next); // optimistic
    try {
      await updateMyProfile({ isPrivate: next }, accessToken);
      await refreshUser();
    } catch {
      setIsPrivate(!next); // the PATCH failed — revert to what the server actually has
      Alert.alert("Couldn't update", "Try again.");
    } finally {
      setTogglingPrivacy(false);
    }
  };

  const onClearData = () => {
    if (!draftCount) return;
    Alert.alert(
      `Clear ${draftCount} saved ${draftCount === 1 ? "draft" : "drafts"}?`,
      "Any Story you were mid-editing when the app closed will no longer be offered for restore.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: async () => {
            await clearAllPendingDrafts();
            setDraftCount(0);
          },
        },
      ],
    );
  };

  const onLogOut = () => {
    Alert.alert("Log out?", undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Log out", style: "destructive", onPress: () => void logout() },
    ]);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.sectionHeader}>Privacy</Text>
      <View style={styles.card}>
        <View style={styles.switchRow}>
          <View style={styles.switchLabelGroup}>
            <Text style={typography.body}>Private account</Text>
            <Text style={styles.switchHint}>Only followers you approve can see your Stories.</Text>
          </View>
          {togglingPrivacy ? <ActivityIndicator color={colors.accent} /> : <Switch value={isPrivate} onValueChange={onTogglePrivacy} />}
        </View>
        <ListRow
          label="Follow requests"
          detail={pendingRequestCount ? String(pendingRequestCount) : undefined}
          onPress={() => navigation.navigate("FollowRequests")}
        />
      </View>

      <Text style={styles.sectionHeader}>Notifications</Text>
      <View style={styles.card}>
        <ListRow label="Notifications" icon={ICONS.notifications} onPress={() => navigation.navigate("NotificationSettings")} />
      </View>

      <Text style={styles.sectionHeader}>Data &amp; Storage</Text>
      <View style={styles.card}>
        <ListRow
          label="Clear saved drafts"
          icon={ICONS.trash}
          detail={draftCount === null ? "…" : String(draftCount)}
          onPress={onClearData}
          disabled={!draftCount}
        />
      </View>

      <Text style={styles.sectionHeader}>Support</Text>
      <View style={styles.card}>
        <ListRow label="Help" onPress={() => navigation.navigate("Help")} />
        <ListRow label="About" onPress={() => navigation.navigate("About")} />
      </View>

      <View style={styles.card}>
        <ListRow label="Log out" destructive onPress={onLogOut} />
        <ListRow label="Delete account" destructive onPress={() => setDeleteOpen(true)} />
      </View>

      <DeleteAccountSheet visible={deleteOpen} onClose={() => setDeleteOpen(false)} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xxl },
  sectionHeader: { ...typography.label, color: colors.textSecondary, marginTop: spacing.lg, marginBottom: spacing.xs },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: "hidden",
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  switchLabelGroup: { flex: 1, marginRight: spacing.md, gap: spacing.xs / 2 },
  switchHint: { ...typography.caption, color: colors.textSecondary },
});
