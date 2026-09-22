import React, { useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { colors, radii, spacing, typography } from "../theme";
import { useAuth } from "../state/AuthContext";
import { createReport, REPORT_REASONS, type ReportReason, type ReportTargetType } from "../api/moderation";
import { ApiError } from "../api/client";

interface Props {
  visible: boolean;
  targetType: ReportTargetType;
  targetId: string;
  onClose: () => void;
}

/**
 * Shared reason-picker for reporting a Story, a comment, or a user
 * account (spec's "Report" affordance, real since Phase 10's moderation
 * queue exists to receive it). React Native's built-in `Alert` can't
 * reasonably list 7 reasons, so this is a small bottom-sheet Modal in the
 * same style as ShareSheet.tsx, not a new pattern.
 */
export function ReportSheet({ visible, targetType, targetId, onClose }: Props): React.JSX.Element {
  const { accessToken } = useAuth();
  const [selectedReason, setSelectedReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setSelectedReason(null);
    setDetails("");
  };

  const onSubmit = async () => {
    if (!accessToken || !selectedReason || busy) return;
    setBusy(true);
    try {
      await createReport({ targetType, targetId, reason: selectedReason, details: details.trim() || undefined }, accessToken);
      reset();
      onClose();
      Alert.alert("Thanks for letting us know", "Our moderation team will review this.");
    } catch (err) {
      Alert.alert(err instanceof ApiError ? err.message : "That didn't go through — try again.");
    } finally {
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
          reset();
          onClose();
        }}
      />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <Text style={[typography.bodyStrong, styles.title]}>Report {targetType}</Text>

        {selectedReason === null ? (
          REPORT_REASONS.map((reason) => (
            <Pressable key={reason.value} style={styles.row} onPress={() => setSelectedReason(reason.value)}>
              <Text style={typography.body}>{reason.label}</Text>
            </Pressable>
          ))
        ) : (
          <>
            <Text style={[typography.caption, styles.selectedReason]}>
              {REPORT_REASONS.find((r) => r.value === selectedReason)?.label}
            </Text>
            <TextInput
              style={styles.detailsInput}
              placeholder="Anything else we should know? (optional)"
              placeholderTextColor={colors.textDisabled}
              value={details}
              onChangeText={setDetails}
              multiline
            />
            <Pressable style={[styles.submitButton, busy && styles.submitButtonDisabled]} disabled={busy} onPress={onSubmit}>
              {busy ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.submitLabel}>Submit report</Text>}
            </Pressable>
            <Pressable style={styles.backRow} onPress={() => setSelectedReason(null)} disabled={busy}>
              <Text style={typography.caption}>Choose a different reason</Text>
            </Pressable>
          </>
        )}
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
  title: { textAlign: "center", marginBottom: spacing.sm },
  row: { paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  selectedReason: { marginBottom: spacing.sm },
  detailsInput: {
    minHeight: 60,
    backgroundColor: colors.surfaceElevated,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    textAlignVertical: "top",
    marginBottom: spacing.md,
  },
  submitButton: {
    backgroundColor: colors.danger,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    alignItems: "center",
  },
  submitButtonDisabled: { opacity: 0.6 },
  submitLabel: { color: colors.onAccent, fontWeight: "700" },
  backRow: { paddingVertical: spacing.md, alignItems: "center" },
});
