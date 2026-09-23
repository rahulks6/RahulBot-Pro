import React from "react";
import { StyleSheet, View } from "react-native";
import type { DrawStroke } from "../models/storyDraft";

/**
 * Renders freehand drawing strokes without react-native-svg (not installed
 * in this project — see mobile/package.json's own dependency notes): each
 * segment between two consecutive sampled points becomes one thin, rotated
 * `View`, which is a standard SVG-free way to fake a polyline in React
 * Native. Shared between the editor's live canvas and the read-only
 * viewer, so what was drawn renders in the exact same position published
 * (spec section 47) — accounting for the container's own width/height,
 * since every point is normalized (0..1) the same way overlay x/y are.
 *
 * The eraser tool never appears here: it isn't a drawn mark, it trims/
 * removes stroke data directly as you drag over it (see DrawingCanvas.tsx) —
 * there's no pixel layer under this component for a "white-out" eraser to
 * paint over.
 */
export function DrawingStrokes({
  strokes,
  containerWidth,
  containerHeight,
}: {
  strokes: DrawStroke[];
  containerWidth: number;
  containerHeight: number;
}): React.JSX.Element {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {strokes.map((stroke) => {
        const widthMultiplier = stroke.tool === "highlighter" ? 3 : stroke.tool === "marker" ? 1.8 : 1;
        const opacity = stroke.tool === "highlighter" ? 0.4 : 1;
        const thickness = Math.max(1, stroke.width * containerWidth * widthMultiplier);
        const segments = [];
        for (let i = 0; i < stroke.points.length - 1; i++) {
          const a = stroke.points[i];
          const b = stroke.points[i + 1];
          const ax = a.x * containerWidth;
          const ay = a.y * containerHeight;
          const bx = b.x * containerWidth;
          const by = b.y * containerHeight;
          const length = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
          const angle = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
          segments.push(
            <View
              key={i}
              style={{
                position: "absolute",
                left: ax,
                top: ay - thickness / 2,
                width: length,
                height: thickness,
                backgroundColor: stroke.color,
                opacity,
                borderRadius: thickness / 2,
                // Pivot at the segment's left-center (point `a` itself) rather
                // than its default center — otherwise rotating a box whose
                // un-rotated left edge sits at `a` swings that left edge away
                // from `a` for any angle other than 0, breaking the line.
                transformOrigin: "0% 50%",
                transform: [{ rotate: `${angle}deg` }],
              }}
            />,
          );
        }
        return <React.Fragment key={stroke.id}>{segments}</React.Fragment>;
      })}
    </View>
  );
}
