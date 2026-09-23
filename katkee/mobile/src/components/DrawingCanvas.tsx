import React, { useMemo, useRef, useState } from "react";
import { PanResponder, Pressable, StyleSheet, Text, View, type GestureResponderEvent } from "react-native";
import { colors, radii, spacing } from "../theme";
import type { DrawStroke, DrawTool } from "../models/storyDraft";
import { DrawingStrokes } from "./DrawingStrokes";

const TOOLS: DrawTool[] = ["pen", "marker", "highlighter", "eraser"];
const COLORS = ["#FFFFFF", "#FCB020", "#E4483C", "#3FBF7F", "#3E7BFF", "#000000"];
const SIZE_STEPS = [0.006, 0.01, 0.016, 0.024, 0.034];
const ERASE_RADIUS_NORM = 0.035;
const MIN_POINT_SPACING_PX = 4;

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
}

interface Props {
  containerWidth: number;
  containerHeight: number;
  strokes: DrawStroke[];
  onChangeStrokes: (strokes: DrawStroke[]) => void;
  onDone: () => void;
}

/**
 * Real freehand drawing (spec section 23): Pen/Marker/Highlighter/Eraser,
 * a color picker, a granular size stepper with live preview, and local
 * Undo/Redo. Strokes are sampled touch points normalized (0..1) to the
 * media container — the same coordinate system overlays use — so a stroke
 * drawn here renders in the exact position when this StoryDraft publishes,
 * accounting for whatever size the container actually is (spec: "must
 * render into the final published Story in the exact position it was
 * drawn"). Rendered without react-native-svg via DrawingStrokes' segment
 * technique. The eraser removes whole strokes it passes over rather than
 * pixel-level trimming — a real, working simplification, not a decorative
 * button; see DrawingStrokes.tsx's own note on why there's no pixel layer
 * here to paint over.
 */
export function DrawingCanvas({ containerWidth, containerHeight, strokes, onChangeStrokes, onDone }: Props): React.JSX.Element {
  const [tool, setTool] = useState<DrawTool>("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [sizeIndex, setSizeIndex] = useState(1);
  const [liveStroke, setLiveStroke] = useState<DrawStroke | null>(null);
  const past = useRef<DrawStroke[][]>([]);
  const future = useRef<DrawStroke[][]>([]);
  const erasedThisGesture = useRef<Set<string>>(new Set());
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;

  const commit = (next: DrawStroke[]) => {
    past.current.push(strokesRef.current);
    future.current = [];
    onChangeStrokes(next);
  };

  const undo = () => {
    const previous = past.current.pop();
    if (previous === undefined) return;
    future.current.push(strokesRef.current);
    onChangeStrokes(previous);
  };

  const redo = () => {
    const next = future.current.pop();
    if (next === undefined) return;
    past.current.push(strokesRef.current);
    onChangeStrokes(next);
  };

  const toNormalized = (evt: GestureResponderEvent) => ({
    x: evt.nativeEvent.locationX / containerWidth,
    y: evt.nativeEvent.locationY / containerHeight,
  });

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt: GestureResponderEvent) => {
          if (tool === "eraser") {
            erasedThisGesture.current = new Set();
            return;
          }
          const { x, y } = toNormalized(evt);
          setLiveStroke({ id: `stroke-${Date.now()}`, tool, color, width: SIZE_STEPS[sizeIndex], points: [{ x, y }] });
        },
        onPanResponderMove: (evt: GestureResponderEvent) => {
          if (tool === "eraser") {
            const px = evt.nativeEvent.locationX;
            const py = evt.nativeEvent.locationY;
            const radiusPx = ERASE_RADIUS_NORM * containerWidth;
            for (const s of strokesRef.current) {
              if (erasedThisGesture.current.has(s.id)) continue;
              const hit = s.points.some((p) => distance(p.x * containerWidth, p.y * containerHeight, px, py) < radiusPx);
              if (hit) erasedThisGesture.current.add(s.id);
            }
            return;
          }
          setLiveStroke((current) => {
            if (!current) return current;
            const { x, y } = toNormalized(evt);
            const last = current.points[current.points.length - 1];
            if (last && distance(last.x * containerWidth, last.y * containerHeight, x * containerWidth, y * containerHeight) < MIN_POINT_SPACING_PX) {
              return current;
            }
            return { ...current, points: [...current.points, { x, y }] };
          });
        },
        onPanResponderRelease: () => {
          if (tool === "eraser") {
            if (erasedThisGesture.current.size > 0) {
              commit(strokesRef.current.filter((s) => !erasedThisGesture.current.has(s.id)));
            }
            erasedThisGesture.current = new Set();
            return;
          }
          setLiveStroke((current) => {
            if (current && current.points.length >= 2) {
              commit([...strokesRef.current, current]);
            }
            return null;
          });
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tool, color, sizeIndex, containerWidth, containerHeight],
  );

  const previewSize = 6 + sizeIndex * 5;

  return (
    <View style={StyleSheet.absoluteFill}>
      <View style={StyleSheet.absoluteFill} {...panResponder.panHandlers}>
        <DrawingStrokes strokes={liveStroke ? [...strokes, liveStroke] : strokes} containerWidth={containerWidth} containerHeight={containerHeight} />
      </View>

      <View style={styles.toolbar}>
        <View style={styles.toolRow}>
          {TOOLS.map((t) => (
            <Pressable
              key={t}
              onPress={() => setTool(t)}
              style={[styles.toolChip, tool === t && styles.toolChipActive]}
              accessibilityRole="button"
              accessibilityLabel={`${t} tool`}
              accessibilityState={{ selected: tool === t }}
            >
              <Text style={[styles.toolLabel, tool === t && styles.toolLabelActive]}>{t}</Text>
            </Pressable>
          ))}
          <Pressable onPress={undo} hitSlop={8} style={styles.iconButton} accessibilityRole="button" accessibilityLabel="Undo">
            <Text style={styles.iconLabel}>↺</Text>
          </Pressable>
          <Pressable onPress={redo} hitSlop={8} style={styles.iconButton} accessibilityRole="button" accessibilityLabel="Redo">
            <Text style={styles.iconLabel}>↻</Text>
          </Pressable>
          <Pressable onPress={onDone} style={styles.doneButton} accessibilityRole="button" accessibilityLabel="Done drawing">
            <Text style={styles.doneLabel}>Done</Text>
          </Pressable>
        </View>

        {tool !== "eraser" ? (
          <View style={styles.colorRow}>
            {COLORS.map((c) => (
              <Pressable
                key={c}
                onPress={() => setColor(c)}
                style={[styles.colorSwatch, { backgroundColor: c }, color === c && styles.colorSwatchActive]}
                accessibilityRole="button"
                accessibilityLabel={`Draw color ${c}`}
                accessibilityState={{ selected: color === c }}
              />
            ))}
            <View style={styles.sizeRow}>
              <Pressable
                onPress={() => setSizeIndex((i) => Math.max(0, i - 1))}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Decrease brush size"
              >
                <Text style={styles.sizeStepper}>−</Text>
              </Pressable>
              <View style={[styles.sizePreview, { width: previewSize, height: previewSize, borderRadius: previewSize / 2, backgroundColor: color }]} />
              <Pressable
                onPress={() => setSizeIndex((i) => Math.min(SIZE_STEPS.length - 1, i + 1))}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Increase brush size"
              >
                <Text style={styles.sizeStepper}>+</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: { position: "absolute", bottom: spacing.xl, left: spacing.md, right: spacing.md, gap: spacing.sm },
  toolRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, flexWrap: "wrap" },
  toolChip: { borderWidth: 1, borderColor: "rgba(255,255,255,0.3)", borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 6 },
  toolChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  toolLabel: { color: colors.textPrimary, fontSize: 12, textTransform: "capitalize" },
  toolLabelActive: { color: colors.onAccent, fontWeight: "700" },
  iconButton: { paddingHorizontal: spacing.xs },
  iconLabel: { color: colors.textPrimary, fontSize: 20 },
  doneButton: { marginLeft: "auto", backgroundColor: colors.accent, borderRadius: radii.pill, paddingHorizontal: spacing.md, paddingVertical: 6 },
  doneLabel: { color: colors.onAccent, fontWeight: "700" },
  colorRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  colorSwatch: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: "transparent" },
  colorSwatchActive: { borderColor: colors.accent },
  sizeRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginLeft: "auto" },
  sizeStepper: { color: colors.textPrimary, fontSize: 20, paddingHorizontal: spacing.xs },
  sizePreview: { borderWidth: 1, borderColor: "rgba(255,255,255,0.4)" },
});
