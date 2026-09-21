import React, { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { colors, radii, spacing } from "../theme";
import type { TextOverlayProperties } from "../models/storyDraft";

const STYLES: TextOverlayProperties["style"][] = ["Clean", "Bold", "Classic", "Modern", "Typewriter", "Outline"];
const COLORS = ["#F5F3EF", "#F5B400", "#E4483C", "#3FBF7F", "#3E7BFF", "#000000"];

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
  const [style, setStyle] = useState<TextOverlayProperties["style"]>(initialProperties?.style ?? "Clean");
  const [color, setColor] = useState(initialProperties?.color ?? COLORS[0]);
  const [hasBackground, setHasBackground] = useState(initialProperties?.hasBackground ?? false);

  return (
    <Modal visible={visible} animationType="fade" transparent={false} onRequestClose={onCancel}>
      <View style={styles.container}>
        <View style={styles.topBar}>
          <Pressable onPress={onCancel}>
            <Text style={styles.topAction}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              if (text.trim()) onDone(text, { style, color, hasBackground });
            }}
          >
            <Text style={[styles.topAction, styles.doneAction]}>Done</Text>
          </Pressable>
        </View>

        <View style={styles.inputArea}>
          <TextInput
            autoFocus
            multiline
            style={[styles.input, { color }]}
            placeholder="Type something…"
            placeholderTextColor={colors.textDisabled}
            value={text}
            onChangeText={setText}
          />
        </View>

        <View style={styles.stylesRow}>
          {STYLES.map((s) => (
            <Pressable key={s} onPress={() => setStyle(s)} style={[styles.styleChip, style === s && styles.styleChipActive]}>
              <Text style={[styles.styleChipLabel, style === s && styles.styleChipLabelActive]}>{s}</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.colorsRow}>
          {COLORS.map((c) => (
            <Pressable
              key={c}
              onPress={() => setColor(c)}
              style={[styles.colorSwatch, { backgroundColor: c }, color === c && styles.colorSwatchActive]}
            />
          ))}
          <Pressable onPress={() => setHasBackground((v) => !v)} style={styles.bgToggle}>
            <Text style={styles.bgToggleLabel}>{hasBackground ? "Background: on" : "Background: off"}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingTop: spacing.xxl, paddingHorizontal: spacing.md },
  topBar: { flexDirection: "row", justifyContent: "space-between", marginBottom: spacing.lg },
  topAction: { color: colors.textPrimary, fontSize: 16 },
  doneAction: { color: colors.accent, fontWeight: "700" },
  inputArea: { flex: 1, justifyContent: "center" },
  input: { fontSize: 28, fontWeight: "600", textAlign: "center" },
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
  colorsRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.lg },
  colorSwatch: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: "transparent" },
  colorSwatchActive: { borderColor: colors.accent },
  bgToggle: { marginLeft: spacing.sm },
  bgToggleLabel: { color: colors.textSecondary, fontSize: 12 },
});
