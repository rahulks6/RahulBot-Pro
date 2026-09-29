import React, { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { colors, radii, spacing } from "../theme";
import type { TextOverlayProperties, TextStyle } from "../models/storyDraft";

const STYLES: TextStyle[] = ["Clean", "Bold", "Classic", "Modern", "Typewriter", "Outline", "Soft", "Highlight"];
const COLORS = ["#F5F3EF", "#F5B400", "#E4483C", "#3FBF7F", "#3E7BFF", "#000000"];
const ALIGNS: TextOverlayProperties["align"][] = ["left", "center", "right"];
const FONT_SIZE_STEPS = [0.03, 0.04, 0.045, 0.055, 0.07, 0.09];

interface Props {
  visible: boolean;
  initialText?: string;
  initialProperties?: TextOverlayProperties;
  onCancel: () => void;
  onDone: (text: string, properties: TextOverlayProperties) => void;
}

/** Full-screen text composer (spec section 20) — keyboard opens immediately, Done places it as a movable overlay. */
export function TextToolModal({ visible, initialText, initialProperties, onCancel, onDone }: Props): React.JSX.Element {
  const [text, setText] = useState(initialText ?? "");
  const [style, setStyle] = useState<TextStyle>(initialProperties?.style ?? "Clean");
  const [color, setColor] = useState(initialProperties?.color ?? COLORS[0]);
  const [hasBackground, setHasBackground] = useState(initialProperties?.backgroundColor !== null && initialProperties?.backgroundColor !== undefined);
  const [align, setAlign] = useState<TextOverlayProperties["align"]>(initialProperties?.align ?? "center");
  const [fontSizeIndex, setFontSizeIndex] = useState(() => {
    const initial = initialProperties?.fontSize ?? FONT_SIZE_STEPS[2];
    let closest = 0;
    let closestDiff = Infinity;
    FONT_SIZE_STEPS.forEach((v, i) => {
      const diff = Math.abs(v - initial);
      if (diff < closestDiff) {
        closestDiff = diff;
        closest = i;
      }
    });
    return closest;
  });

  return (
    <Modal visible={visible} animationType="fade" transparent={false} onRequestClose={onCancel}>
      {/*
        The Done button and every style/align/color/size control sit below
        the input, so an opening keyboard has to be actively avoided or it
        covers all of them (spec: keyboard handling that "never hides the
        Done button/active text field/controls"). `padding` shrinks this
        view's own height on iOS; Android already resizes the window by
        default (windowSoftInputMode), so `height` here is a no-op safety
        net rather than double-compensation.
      */}
      <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <View style={styles.topBar}>
          <Pressable onPress={onCancel}>
            <Text style={styles.topAction}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              if (text.trim()) {
                onDone(text, {
                  text,
                  style,
                  color,
                  backgroundColor: hasBackground ? "#000000" : null,
                  align,
                  fontSize: FONT_SIZE_STEPS[fontSizeIndex],
                });
              }
            }}
          >
            <Text style={[styles.topAction, styles.doneAction]}>Done</Text>
          </Pressable>
        </View>

        <View style={styles.inputArea}>
          <TextInput
            autoFocus
            multiline
            style={[styles.input, { color, textAlign: align, fontSize: 16 + fontSizeIndex * 4 }]}
            placeholder="Type something…"
            placeholderTextColor={colors.textDisabled}
            value={text}
            onChangeText={setText}
          />
        </View>

        <View style={styles.stylesRow}>
          {STYLES.map((s) => (
            <Pressable
              key={s}
              onPress={() => setStyle(s)}
              style={[styles.styleChip, style === s && styles.styleChipActive]}
              accessibilityRole="button"
              accessibilityLabel={`${s} text style`}
              accessibilityState={{ selected: style === s }}
            >
              <Text style={[styles.styleChipLabel, style === s && styles.styleChipLabelActive]}>{s}</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.alignRow}>
          {ALIGNS.map((a) => (
            <Pressable
              key={a}
              onPress={() => setAlign(a)}
              style={[styles.alignChip, align === a && styles.alignChipActive]}
              accessibilityRole="button"
              accessibilityLabel={`Align ${a}`}
              accessibilityState={{ selected: align === a }}
            >
              <Text style={[styles.alignChipLabel, align === a && styles.alignChipLabelActive]}>{a}</Text>
            </Pressable>
          ))}
          <View style={styles.sizeRow}>
            <Pressable
              onPress={() => setFontSizeIndex((i) => Math.max(0, i - 1))}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Decrease text size"
            >
              <Text style={styles.sizeStepper}>A−</Text>
            </Pressable>
            <Pressable
              onPress={() => setFontSizeIndex((i) => Math.min(FONT_SIZE_STEPS.length - 1, i + 1))}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Increase text size"
            >
              <Text style={styles.sizeStepper}>A+</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.colorsRow}>
          {COLORS.map((c) => (
            <Pressable
              key={c}
              onPress={() => setColor(c)}
              style={[styles.colorSwatch, { backgroundColor: c }, color === c && styles.colorSwatchActive]}
              accessibilityRole="button"
              accessibilityLabel={`Text color ${c}`}
              accessibilityState={{ selected: color === c }}
            />
          ))}
          <Pressable
            onPress={() => setHasBackground((v) => !v)}
            style={styles.bgToggle}
            accessibilityRole="button"
            accessibilityLabel="Toggle text background"
            accessibilityState={{ checked: hasBackground }}
          >
            <Text style={styles.bgToggleLabel}>{hasBackground ? "Background: on" : "Background: off"}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingTop: spacing.xxl, paddingHorizontal: spacing.md },
  topBar: { flexDirection: "row", justifyContent: "space-between", marginBottom: spacing.lg },
  topAction: { color: colors.textPrimary, fontSize: 16 },
  doneAction: { color: colors.accent, fontWeight: "700" },
  inputArea: { flex: 1, justifyContent: "center" },
  input: { fontWeight: "600" },
  stylesRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginBottom: spacing.sm },
  styleChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  styleChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  styleChipLabel: { color: colors.textPrimary, fontSize: 12 },
  styleChipLabelActive: { color: colors.onAccent, fontWeight: "700" },
  alignRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, marginBottom: spacing.sm },
  alignChip: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 6 },
  alignChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  alignChipLabel: { color: colors.textPrimary, fontSize: 12, textTransform: "capitalize" },
  alignChipLabelActive: { color: colors.onAccent, fontWeight: "700" },
  sizeRow: { flexDirection: "row", gap: spacing.sm, marginLeft: "auto" },
  sizeStepper: { color: colors.textPrimary, fontSize: 15, fontWeight: "700" },
  colorsRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.lg },
  colorSwatch: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: "transparent" },
  colorSwatchActive: { borderColor: colors.accent },
  bgToggle: { marginLeft: spacing.sm },
  bgToggleLabel: { color: colors.textSecondary, fontSize: 12 },
});
