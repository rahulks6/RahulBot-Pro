import React, { useCallback, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { colors, radii, spacing, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { demoteFromStaff, listStaff, promoteToStaff, type StaffMember } from "../../api/moderation";
import { ApiError } from "../../api/client";

type PromotableRole = "moderator" | "admin";

/**
 * Admin-only staff management: any admin can grant moderator or admin
 * access to another account, or revoke it — "an admin has to have rights
 * to create other admins if he wants." The primary admin (seeded once,
 * out of band — see backend/scripts/seedPrimaryAdmin.ts) can never be
 * demoted; its row has no Demote button at all, and the backend rejects
 * the call regardless. Reached from Settings > Moderation > Manage Staff,
 * itself only shown to accounts with role 'admin' (see SettingsScreen.tsx).
 */
export function AdminStaffScreen(): React.JSX.Element {
  const { accessToken } = useAuth();
  const [staff, setStaff] = useState<StaffMember[] | null>(null);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<PromotableRole>("moderator");
  const [busyUsername, setBusyUsername] = useState<string | null>(null);
  const [promoting, setPromoting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const { staff: fetched } = await listStaff(accessToken);
      setStaff(fetched);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load staff — try again.");
      setStaff([]);
    }
  }, [accessToken]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onPromote = async () => {
    if (!accessToken || !username.trim() || promoting) return;
    setPromoting(true);
    setError(null);
    try {
      await promoteToStaff(username.trim().toLowerCase(), role, accessToken);
      setUsername("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't promote that account — try again.");
    } finally {
      setPromoting(false);
    }
  };

  const onDemote = (member: StaffMember) => {
    Alert.alert(`Remove @${member.username} as ${member.role}?`, undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove access",
        style: "destructive",
        onPress: async () => {
          if (!accessToken) return;
          setBusyUsername(member.username);
          try {
            await demoteFromStaff(member.username, accessToken);
            setStaff((current) => (current ?? []).filter((s) => s.id !== member.id));
          } catch (err) {
            Alert.alert("Couldn't remove access", err instanceof ApiError ? err.message : "Try again.");
          } finally {
            setBusyUsername(null);
          }
        },
      },
    ]);
  };

  if (staff === null) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={styles.content}
      data={staff}
      keyExtractor={(item) => item.id}
      ListHeaderComponent={
        <View style={styles.promoteCard}>
          <Text style={styles.sectionLabel}>Grant access</Text>
          <TextInput
            style={styles.input}
            placeholder="username"
            placeholderTextColor={colors.textDisabled}
            autoCapitalize="none"
            autoCorrect={false}
            value={username}
            onChangeText={setUsername}
          />
          <View style={styles.roleRow}>
            {(["moderator", "admin"] as PromotableRole[]).map((r) => (
              <Pressable
                key={r}
                style={[styles.roleChip, role === r && styles.roleChipActive]}
                onPress={() => setRole(r)}
                accessibilityRole="button"
                accessibilityLabel={r}
                accessibilityState={{ selected: role === r }}
              >
                <Text style={[styles.roleChipLabel, role === r && styles.roleChipLabelActive]}>
                  {r === "moderator" ? "Moderator" : "Admin"}
                </Text>
              </Pressable>
            ))}
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable
            style={[styles.promoteButton, (!username.trim() || promoting) && styles.promoteButtonDisabled]}
            disabled={!username.trim() || promoting}
            onPress={onPromote}
          >
            {promoting ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.promoteButtonLabel}>Grant access</Text>}
          </Pressable>
          <Text style={styles.sectionLabel}>Current staff</Text>
        </View>
      }
      renderItem={({ item }) => (
        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={typography.bodyStrong}>
              @{item.username} {item.isPrimaryAdmin ? "★" : ""}
            </Text>
            <Text style={typography.caption}>{item.isPrimaryAdmin ? "Primary admin" : item.role === "admin" ? "Admin" : "Moderator"}</Text>
          </View>
          {item.isPrimaryAdmin ? null : busyUsername === item.username ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <Pressable style={styles.demoteButton} onPress={() => onDemote(item)}>
              <Text style={styles.demoteLabel}>Remove</Text>
            </Pressable>
          )}
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background },
  content: { paddingBottom: spacing.xxl },
  promoteCard: { padding: spacing.md, gap: spacing.sm },
  sectionLabel: { ...typography.label, color: colors.textSecondary, marginTop: spacing.sm },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontSize: 15,
  },
  roleRow: { flexDirection: "row", gap: spacing.sm },
  roleChip: {
    flex: 1,
    alignItems: "center",
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  roleChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  roleChipLabel: { ...typography.caption, fontWeight: "700", color: colors.textPrimary },
  roleChipLabelActive: { color: colors.onAccent },
  error: { color: colors.danger },
  promoteButton: { backgroundColor: colors.accent, borderRadius: radii.md, paddingVertical: spacing.sm, alignItems: "center" },
  promoteButtonDisabled: { opacity: 0.5 },
  promoteButtonLabel: { color: colors.onAccent, fontWeight: "700" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowText: { gap: 2 },
  demoteButton: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, paddingVertical: spacing.xs, paddingHorizontal: spacing.sm },
  demoteLabel: { ...typography.caption, color: colors.danger, fontWeight: "600" },
});
