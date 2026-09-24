import React, { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/types";
import { colors, radii, spacing, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { updateMyProfile } from "../../api/users";
import { ApiError } from "../../api/client";

type Props = NativeStackScreenProps<RootStackParamList, "EditProfile">;

const MAX_DISPLAY_NAME_LENGTH = 60;
const MAX_BIO_LENGTH = 150;

/**
 * Edit the two free-text fields `PATCH /api/v1/users/me` already accepts
 * (display name, bio) — the account's privacy toggle lives in Settings
 * instead (spec's Settings > Privacy row), not duplicated here.
 */
export function EditProfileScreen({ navigation }: Props): React.JSX.Element {
  const { user, accessToken, refreshUser } = useAuth();
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [bio, setBio] = useState(user?.bio ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = displayName.trim().length > 0 && !saving && !!accessToken;

  const onSave = async () => {
    if (!canSave || !accessToken) return;
    setSaving(true);
    setError(null);
    try {
      await updateMyProfile({ displayName: displayName.trim(), bio }, accessToken);
      await refreshUser();
      navigation.goBack();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't save — try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Text style={styles.label}>Name</Text>
      <TextInput
        style={styles.input}
        value={displayName}
        onChangeText={setDisplayName}
        placeholder="Your name"
        placeholderTextColor={colors.textDisabled}
        maxLength={MAX_DISPLAY_NAME_LENGTH}
        accessibilityLabel="Display name"
      />

      <Text style={styles.label}>Bio</Text>
      <TextInput
        style={[styles.input, styles.bioInput]}
        value={bio}
        onChangeText={setBio}
        placeholder="Tell people about yourself"
        placeholderTextColor={colors.textDisabled}
        maxLength={MAX_BIO_LENGTH}
        multiline
        accessibilityLabel="Bio"
      />
      <Text style={styles.counter}>
        {bio.length}/{MAX_BIO_LENGTH}
      </Text>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable
        style={[styles.saveButton, !canSave && styles.saveButtonDisabled]}
        disabled={!canSave}
        onPress={onSave}
        accessibilityRole="button"
        accessibilityLabel="Save profile changes"
      >
        {saving ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.saveLabel}>Save</Text>}
      </Pressable>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: spacing.md },
  label: { ...typography.label, marginTop: spacing.md, marginBottom: spacing.xs },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontSize: 16,
  },
  bioInput: { minHeight: 88, textAlignVertical: "top" },
  counter: { ...typography.caption, color: colors.textDisabled, textAlign: "right", marginTop: spacing.xs },
  error: { color: colors.danger, marginTop: spacing.md },
  saveButton: {
    marginTop: spacing.xl,
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    alignItems: "center",
  },
  saveButtonDisabled: { opacity: 0.5 },
  saveLabel: { color: colors.onAccent, fontWeight: "700" },
});
