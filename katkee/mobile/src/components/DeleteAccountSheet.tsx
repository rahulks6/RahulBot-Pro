import React, { useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { colors, radii, spacing, typography } from "../theme";
import { useAuth } from "../state/AuthContext";
import { ApiError } from "../api/client";

interface Props {
  visible: boolean;
  onClose: () => void;
}

/**
 * Real, in-app, password-confirmed account deletion (spec: App Store
 * review guideline 5.1.1(v) requires this exist for any app that
 * supports account creation — see backend/README.md's Phase 12 section).
 * A bottom-sheet Modal, same style as ShareSheet.tsx/ReportSheet.tsx, not
 * a new pattern.
 */
export function DeleteAccountSheet({ visible, onClose }: Props): React.JSX.Element {
  const { deleteAccount } = useAuth();
  const [password, setPassword] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = (): void => {
    setPassword("");
    setConfirming(false);
    setError(null);
  };

  const onSubmit = async (): Promise<void> => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteAccount(password);
      // No need to reset local state or close manually — a successful
      // deleteAccount() flips AuthContext to signedOut, which unmounts
      // this screen (and this sheet with it) via RootNavigator.
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't go through — try again.");
      setBusy(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={() => {
        reset();
        onClose();
      }}
    >
      <Pressable
        style={styles.backdrop}
        onPress={() => {
          if (!busy) {
            reset();
            onClose();
          }
        }}
      />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <Text style={[typography.bodyStrong, styles.title]}>Delete your account?</Text>
        <Text style={[typography.body, styles.warning]}>
          This is permanent. Your profile, Stories, and Highlights are removed immediately and can't be recovered.
        </Text>

        {!confirming ? (
          <Pressable style={styles.destructiveButton} onPress={() => setConfirming(true)}>
            <Text style={styles.destructiveLabel}>Continue</Text>
          </Pressable>
        ) : (
          <>
            <TextInput
              style={styles.input}
              placeholder="Confirm your password"
              placeholderTextColor={colors.textDisabled}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              value={password}
              onChangeText={setPassword}
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Pressable style={[styles.destructiveButton, (!password || busy) && styles.disabled]} disabled={!password || busy} onPress={onSubmit}>
              {busy ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.destructiveLabel}>Permanently delete my account</Text>}
            </Pressable>
          </>
        )}

        <Pressable
          style={styles.cancelRow}
          disabled={busy}
          onPress={() => {
            reset();
            onClose();
          }}
        >
          <Text style={typography.caption}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)" },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xl,
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: "center", marginVertical: spacing.sm },
  title: { textAlign: "center", marginBottom: spacing.xs },
  warning: { textAlign: "center", color: colors.textSecondary, marginBottom: spacing.md },
  input: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    marginBottom: spacing.sm,
  },
  error: { color: colors.danger, textAlign: "center", marginBottom: spacing.sm },
  destructiveButton: {
    backgroundColor: colors.danger,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    alignItems: "center",
  },
  disabled: { opacity: 0.6 },
  destructiveLabel: { color: colors.onAccent, fontWeight: "700" },
  cancelRow: { paddingVertical: spacing.md, alignItems: "center" },
});
