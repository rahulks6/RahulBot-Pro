import React from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radii, spacing, typography } from "../theme";
import { clampOverlayPosition, type Overlay } from "../models/storyDraft";

const NUDGE_STEP = 0.02;
const SCALE_STEP = 0.15;
const ROTATE_STEP_DEG = 15;
const MIN_SCALE = 0.4;
const MAX_SCALE = 4;

interface Props {
  overlay: Overlay | null;
  onChange: (id: string, patch: Partial<Pick<Overlay, "x" | "y" | "scale" | "rotation">>) => void;
  onEditText?: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/**
 * The non-gesture path to everything the one-finger-drag / two-finger-
 * pinch-and-twist / drag-to-trash gesture model can do (spec's own
 * accessibility requirement: "gesture-only interaction must have an
 * accessible alternative where needed"). Opened by selecting an overlay
 * (a plain tap — see DraggableCanvasObject's `onTap`) and reachable
 * entirely through standard button activation, so it works the same way
 * under VoiceOver/TalkBack as it does with a mouse or a finger: nudge
 * buttons for position, +/- for scale and rotation, and a real Delete
 * button standing in for "drag onto the trash zone."
 */
export function OverlayAdjustSheet({ overlay, onChange, onEditText, onDelete, onClose }: Props): React.JSX.Element {
  // Keeps rendering the last-selected overlay's controls while the Modal
  // itself plays its closing animation (overlay only ever goes non-null →
  // null when a caller closes it) — returning null the instant `overlay`
  // clears would cut that animation short.
  const [lastOverlay, setLastOverlay] = React.useState<Overlay | null>(overlay);
  React.useEffect(() => {
    if (overlay) setLastOverlay(overlay);
  }, [overlay]);

  const shown = overlay ?? lastOverlay;
  if (!shown) return <></>;

  const nudge = (dx: number, dy: number) => onChange(shown.id, clampOverlayPosition(shown.x + dx, shown.y + dy));
  const rescale = (delta: number) => onChange(shown.id, { scale: clamp(shown.scale + delta, MIN_SCALE, MAX_SCALE) });
  const rotate = (delta: number) => onChange(shown.id, { rotation: ((shown.rotation + delta) % 360 + 360) % 360 });

  return (
    <Modal visible={overlay !== null} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <Text style={typography.caption}>Adjust</Text>

        <View style={styles.dpad}>
          <View style={styles.dpadRow}>
            <View style={styles.dpadSpacer} />
            <Pressable style={styles.dpadButton} onPress={() => nudge(0, -NUDGE_STEP)} accessibilityRole="button" accessibilityLabel="Move up">
              <Text style={styles.dpadIcon}>↑</Text>
            </Pressable>
            <View style={styles.dpadSpacer} />
          </View>
          <View style={styles.dpadRow}>
            <Pressable style={styles.dpadButton} onPress={() => nudge(-NUDGE_STEP, 0)} accessibilityRole="button" accessibilityLabel="Move left">
              <Text style={styles.dpadIcon}>←</Text>
            </Pressable>
            <Pressable style={styles.dpadButton} onPress={() => nudge(0, NUDGE_STEP)} accessibilityRole="button" accessibilityLabel="Move down">
              <Text style={styles.dpadIcon}>↓</Text>
            </Pressable>
            <Pressable style={styles.dpadButton} onPress={() => nudge(NUDGE_STEP, 0)} accessibilityRole="button" accessibilityLabel="Move right">
              <Text style={styles.dpadIcon}>→</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.row}>
          <Text style={styles.rowLabel}>Size</Text>
          <Pressable style={styles.stepButton} onPress={() => rescale(-SCALE_STEP)} accessibilityRole="button" accessibilityLabel="Decrease size">
            <Text style={styles.stepIcon}>−</Text>
          </Pressable>
          <Pressable style={styles.stepButton} onPress={() => rescale(SCALE_STEP)} accessibilityRole="button" accessibilityLabel="Increase size">
            <Text style={styles.stepIcon}>+</Text>
          </Pressable>
        </View>

        <View style={styles.row}>
          <Text style={styles.rowLabel}>Rotate</Text>
          <Pressable style={styles.stepButton} onPress={() => rotate(-ROTATE_STEP_DEG)} accessibilityRole="button" accessibilityLabel="Rotate counterclockwise">
            <Text style={styles.stepIcon}>↺</Text>
          </Pressable>
          <Pressable style={styles.stepButton} onPress={() => rotate(ROTATE_STEP_DEG)} accessibilityRole="button" accessibilityLabel="Rotate clockwise">
            <Text style={styles.stepIcon}>↻</Text>
          </Pressable>
        </View>

        {shown.type === "text" && onEditText ? (
          <Pressable
            style={styles.secondaryButton}
            onPress={() => {
              onEditText(shown.id);
              onClose();
            }}
            accessibilityRole="button"
            accessibilityLabel="Edit text and style"
          >
            <Text style={styles.secondaryButtonLabel}>Edit Text</Text>
          </Pressable>
        ) : null}

        <Pressable
          style={styles.deleteButton}
          onPress={() => {
            onDelete(shown.id);
            onClose();
          }}
          accessibilityRole="button"
          accessibilityLabel="Delete"
        >
          <Text style={styles.deleteButtonLabel}>Delete</Text>
        </Pressable>

        <Pressable style={styles.doneButton} onPress={onClose} accessibilityRole="button" accessibilityLabel="Done adjusting">
          <Text style={styles.doneButtonLabel}>Done</Text>
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
    gap: spacing.sm,
    alignItems: "center",
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: "center", marginVertical: spacing.sm },
  dpad: { gap: 4, marginVertical: spacing.xs },
  dpadRow: { flexDirection: "row", gap: 4, justifyContent: "center" },
  dpadButton: {
    width: 48,
    height: 48,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  dpadSpacer: { width: 48, height: 48 },
  dpadIcon: { color: colors.textPrimary, fontSize: 22, fontWeight: "700" },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm, width: "100%" },
  rowLabel: { color: colors.textSecondary, width: 60 },
  stepButton: { width: 44, height: 44, borderRadius: radii.md, backgroundColor: colors.surfaceElevated, alignItems: "center", justifyContent: "center" },
  stepIcon: { color: colors.textPrimary, fontSize: 20, fontWeight: "700" },
  secondaryButton: { paddingVertical: spacing.sm, alignSelf: "stretch", alignItems: "center", backgroundColor: colors.surfaceElevated, borderRadius: radii.md },
  secondaryButtonLabel: { color: colors.accent, fontWeight: "700" },
  deleteButton: { paddingVertical: spacing.sm, alignSelf: "stretch", alignItems: "center", borderRadius: radii.md, backgroundColor: "rgba(228,72,60,0.15)" },
  deleteButtonLabel: { color: colors.danger, fontWeight: "700" },
  doneButton: { paddingVertical: spacing.sm, alignSelf: "stretch", alignItems: "center", backgroundColor: colors.accent, borderRadius: radii.md },
  doneButtonLabel: { color: colors.onAccent, fontWeight: "700" },
});
