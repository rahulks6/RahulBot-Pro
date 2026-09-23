import React from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import type { Overlay, DrawStroke, FilterName } from "../models/storyDraft";
import { FILTER_PREVIEWS } from "../models/filterPreviews";
import { OverlayBody } from "./OverlayBody";
import { DrawingStrokes } from "./DrawingStrokes";

/**
 * The read-only counterpart to the editor's live canvas: renders a
 * published Story's filter tint, drawing, and overlays exactly where they
 * were placed (same normalized x/y/scale/rotation, same OverlayBody used
 * while editing — spec section 47's "preview accuracy"). Not interactive
 * except a mention, which is the one overlay type the spec requires stay
 * tappable after publish (section 30: "tapping a mention must navigate to
 * that user's live profile").
 */
export function StoryOverlayLayer({
  overlays,
  drawing,
  filter,
  containerWidth,
  containerHeight,
  onMentionPress,
}: {
  overlays: Overlay[];
  drawing: DrawStroke[];
  filter: FilterName;
  containerWidth: number;
  containerHeight: number;
  onMentionPress?: (username: string) => void;
}): React.JSX.Element {
  const activeFilter = FILTER_PREVIEWS.find((f) => f.name === filter) ?? FILTER_PREVIEWS[0];
  const sorted = [...overlays].sort((a, b) => a.zIndex - b.zIndex);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {activeFilter.overlayOpacity > 0 ? (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: activeFilter.overlayColor, opacity: activeFilter.overlayOpacity }]}
        />
      ) : null}

      {containerWidth > 0 ? <DrawingStrokes strokes={drawing} containerWidth={containerWidth} containerHeight={containerHeight} /> : null}

      {containerWidth > 0
        ? sorted.map((overlay) => (
            <View
              key={overlay.id}
              pointerEvents={overlay.type === "mention" ? "auto" : "none"}
              style={[
                styles.wrapper,
                {
                  left: overlay.x * containerWidth,
                  top: overlay.y * containerHeight,
                  transform: [{ scale: overlay.scale }, { rotate: `${overlay.rotation}deg` }],
                },
              ]}
            >
              <OverlayBody overlay={overlay} containerWidth={containerWidth} containerHeight={containerHeight} onMentionPress={onMentionPress} />
            </View>
          ))
        : null}
    </View>
  );
}

/** Convenience for a screen that doesn't yet know its container size — call in onLayout. */
export function useContainerLayout(): [{ width: number; height: number }, (e: LayoutChangeEvent) => void] {
  const [size, setSize] = React.useState({ width: 0, height: 0 });
  const onLayout = React.useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize({ width, height });
  }, []);
  return [size, onLayout];
}

const styles = StyleSheet.create({
  wrapper: { position: "absolute" },
});
