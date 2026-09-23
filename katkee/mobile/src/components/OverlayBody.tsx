import React from "react";
import { StyleSheet, Text, View } from "react-native";
import type { Overlay } from "../models/storyDraft";
import { colors, radii } from "../theme";

export const STICKER_GLYPHS: Record<string, string> = {
  spark: "✦",
  "heart-line": "♡",
  "star-outline": "☆",
  wave: "〰",
  flame: "🔥",
  confetti: "✺",
  ring: "◯",
  bolt: "⚡",
};

/**
 * Renders exactly one overlay's visual body — used by both
 * DraggableCanvasObject (editable, in the editor) and StoryOverlayLayer
 * (read-only, at view time), so what the editor shows is what actually
 * publishes (spec section 47: "preview accuracy"). Font sizes are
 * expressed relative to `containerHeight`/`containerWidth` because the
 * overlay's own `properties.fontSize` (text) is itself normalized —
 * see storyDraft.ts.
 */
export function OverlayBody({
  overlay,
  containerWidth,
  containerHeight,
  onMentionPress,
}: {
  overlay: Overlay;
  containerWidth: number;
  containerHeight: number;
  onMentionPress?: (username: string) => void;
}): React.JSX.Element {
  switch (overlay.type) {
    case "text": {
      const { properties } = overlay;
      const backgroundStyle =
        properties.backgroundColor !== null
          ? { backgroundColor: "rgba(0,0,0,0.55)", paddingHorizontal: 10, paddingVertical: 4, borderRadius: radii.sm }
          : null;
      return (
        <View style={backgroundStyle}>
          <Text
            style={[
              styles.text,
              { color: properties.color, fontSize: properties.fontSize * containerHeight, textAlign: properties.align },
              properties.style === "Bold" && styles.bold,
              properties.style === "Outline" && styles.outline,
              properties.style === "Typewriter" && styles.typewriter,
              properties.style === "Classic" && styles.classic,
              properties.style === "Modern" && styles.modern,
              properties.style === "Soft" && styles.soft,
              properties.style === "Highlight" && [styles.highlight, { color: colors.background }],
            ]}
          >
            {properties.text}
          </Text>
        </View>
      );
    }
    case "emoji":
      return <Text style={{ fontSize: 0.09 * containerHeight }}>{overlay.properties.emoji}</Text>;
    case "sticker":
      return <Text style={[styles.sticker, { fontSize: 0.08 * containerHeight }]}>{STICKER_GLYPHS[overlay.properties.stickerId] ?? "✦"}</Text>;
    case "mention":
      return (
        <Text
          style={styles.chip}
          onPress={overlay.properties.username && onMentionPress ? () => onMentionPress!(overlay.properties.username as string) : undefined}
        >
          @{overlay.properties.username ?? "unknown"}
        </Text>
      );
    case "location":
      return <Text style={styles.chip}>📍 {overlay.properties.label}</Text>;
    case "datetime":
      return <Text style={styles.chip}>{overlay.properties.display}</Text>;
    default:
      return <View />;
  }
}

const styles = StyleSheet.create({
  text: { fontWeight: "600", color: colors.textPrimary },
  bold: { fontWeight: "800" },
  outline: { textShadowColor: "#000", textShadowRadius: 4, textShadowOffset: { width: 1, height: 1 } },
  typewriter: { fontFamily: "Courier" },
  classic: { fontFamily: "Georgia" },
  modern: { fontWeight: "300", letterSpacing: 1 },
  soft: { fontWeight: "400", textShadowColor: "rgba(255,255,255,0.4)", textShadowRadius: 6 },
  highlight: { backgroundColor: colors.accent, paddingHorizontal: 6, borderRadius: radii.sm, overflow: "hidden" },
  sticker: { color: colors.accent },
  chip: {
    color: colors.onAccent,
    backgroundColor: colors.accent,
    fontWeight: "700",
    fontSize: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radii.pill,
    overflow: "hidden",
  },
});
