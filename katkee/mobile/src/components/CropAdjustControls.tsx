import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radii, spacing } from "../theme";
import { clampCrop, type StoryCrop } from "../models/storyDraft";

const ZOOM_STEP = 0.25;
const PAN_STEP = 0.1;

interface Props {
  crop: StoryCrop;
  onChange: (crop: StoryCrop) => void;
}

/**
 * The non-gesture path to what CropGestureLayer's pinch-to-zoom/drag-to-pan
 * otherwise requires — the same accessibility requirement OverlayAdjustSheet
 * already answers for canvas objects, just not previously extended to crop
 * mode. Zoom +/- and a directional pad, reachable through ordinary button
 * activation; both apply through the same `clampCrop` the gesture layer
 * itself uses, so a button nudge and a real pinch/drag can never disagree
 * about what a valid crop is.
 */
export function CropAdjustControls({ crop, onChange }: Props): React.JSX.Element {
  const zoomBy = (delta: number) => onChange(clampCrop({ ...crop, zoom: crop.zoom + delta }));
  const panBy = (dx: number, dy: number) => onChange(clampCrop({ ...crop, offsetX: crop.offsetX + dx, offsetY: crop.offsetY + dy }));

  return (
    <View style={styles.container}>
      <View style={styles.zoomRow}>
        <Pressable style={styles.stepButton} onPress={() => zoomBy(-ZOOM_STEP)} accessibilityRole="button" accessibilityLabel="Zoom out">
          <Text style={styles.stepIcon}>−</Text>
        </Pressable>
        <Text style={styles.zoomLabel}>{crop.zoom.toFixed(2)}×</Text>
        <Pressable style={styles.stepButton} onPress={() => zoomBy(ZOOM_STEP)} accessibilityRole="button" accessibilityLabel="Zoom in">
          <Text style={styles.stepIcon}>+</Text>
        </Pressable>
      </View>
      <View style={styles.dpad}>
        <View style={styles.dpadRow}>
          <View style={styles.dpadSpacer} />
          <Pressable style={styles.dpadButton} onPress={() => panBy(0, -PAN_STEP)} accessibilityRole="button" accessibilityLabel="Pan up">
            <Text style={styles.dpadIcon}>↑</Text>
          </Pressable>
          <View style={styles.dpadSpacer} />
        </View>
        <View style={styles.dpadRow}>
          <Pressable style={styles.dpadButton} onPress={() => panBy(-PAN_STEP, 0)} accessibilityRole="button" accessibilityLabel="Pan left">
            <Text style={styles.dpadIcon}>←</Text>
          </Pressable>
          <Pressable
            style={styles.dpadButton}
            onPress={() => onChange({ zoom: 1, offsetX: 0, offsetY: 0 })}
            accessibilityRole="button"
            accessibilityLabel="Reset crop"
          >
            <Text style={styles.resetIcon}>↺</Text>
          </Pressable>
          <Pressable style={styles.dpadButton} onPress={() => panBy(PAN_STEP, 0)} accessibilityRole="button" accessibilityLabel="Pan right">
            <Text style={styles.dpadIcon}>→</Text>
          </Pressable>
        </View>
        <View style={styles.dpadRow}>
          <View style={styles.dpadSpacer} />
          <Pressable style={styles.dpadButton} onPress={() => panBy(0, PAN_STEP)} accessibilityRole="button" accessibilityLabel="Pan down">
            <Text style={styles.dpadIcon}>↓</Text>
          </Pressable>
          <View style={styles.dpadSpacer} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: "center", gap: spacing.sm },
  zoomRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  zoomLabel: { color: colors.textPrimary, fontWeight: "700", minWidth: 48, textAlign: "center" },
  stepButton: {
    width: 40,
    height: 40,
    borderRadius: radii.md,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  stepIcon: { color: colors.textPrimary, fontSize: 20, fontWeight: "700" },
  dpad: { gap: 4 },
  dpadRow: { flexDirection: "row", gap: 4, justifyContent: "center" },
  dpadButton: {
    width: 40,
    height: 40,
    borderRadius: radii.md,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  dpadSpacer: { width: 40, height: 40 },
  dpadIcon: { color: colors.textPrimary, fontSize: 18, fontWeight: "700" },
  resetIcon: { color: colors.textPrimary, fontSize: 16 },
});
