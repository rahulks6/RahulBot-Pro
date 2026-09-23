import React, { useMemo, useRef, useState } from "react";
import { PanResponder, StyleSheet, View, type GestureResponderEvent, type PanResponderGestureState } from "react-native";
import type { Overlay } from "../models/storyDraft";
import { OverlayBody } from "./OverlayBody";

interface Props {
  overlay: Overlay;
  containerWidth: number;
  containerHeight: number;
  isOverTrash: (x: number, y: number) => boolean;
  onChange: (id: string, patch: Partial<Pick<Overlay, "x" | "y" | "scale" | "rotation">>) => void;
  onDoubleTap: (id: string) => void;
  onDragStateChange: (dragging: boolean) => void;
  onDeleted: (id: string) => void;
}

function distance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

function angleDeg(x1: number, y1: number, x2: number, y2: number): number {
  return (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
}

const DOUBLE_TAP_MS = 250;
const TAP_MOVE_THRESHOLD = 6;

/**
 * The one gesture model shared by every canvas object type — text, emoji,
 * mention, location, datetime, sticker (spec section 21: "a single unified
 * gesture model for ALL object types"): one-finger drag to move (1:1,
 * attached to the finger), two-finger pinch+twist to scale and rotate
 * simultaneously, tap-then-tap-again within DOUBLE_TAP_MS to edit, drag onto
 * the trash zone to delete. Only the rendered body differs per type — see
 * OverlayBody.tsx, shared with the read-only viewer so editor and published
 * Story render identically (spec section 47).
 *
 * Built on React Native's core `PanResponder` reading `nativeEvent.touches`
 * directly — no gesture library dependency, the same technique this file
 * used when it only handled text. Hand-rolled multitouch math like this is
 * exactly the kind of code that most needs on-device verification, which
 * this sandbox can't do (see mobile/README.md).
 */
export function DraggableCanvasObject({
  overlay,
  containerWidth,
  containerHeight,
  isOverTrash,
  onChange,
  onDoubleTap,
  onDragStateChange,
  onDeleted,
}: Props): React.JSX.Element {
  const [dragging, setDragging] = useState(false);
  const gestureStart = useRef({
    x: overlay.x,
    y: overlay.y,
    scale: overlay.scale,
    rotation: overlay.rotation,
    pinchDistance: 0,
    pinchAngle: 0,
  });
  const lastTapTime = useRef(0);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt: GestureResponderEvent) => {
          const now = Date.now();
          if (now - lastTapTime.current < DOUBLE_TAP_MS) {
            onDoubleTap(overlay.id);
            lastTapTime.current = 0;
            return;
          }
          lastTapTime.current = now;

          const touches = evt.nativeEvent.touches;
          gestureStart.current.x = overlay.x;
          gestureStart.current.y = overlay.y;
          gestureStart.current.scale = overlay.scale;
          gestureStart.current.rotation = overlay.rotation;
          if (touches.length >= 2) {
            const [a, b] = touches;
            gestureStart.current.pinchDistance = distance(a.pageX, a.pageY, b.pageX, b.pageY);
            gestureStart.current.pinchAngle = angleDeg(a.pageX, a.pageY, b.pageX, b.pageY);
          }
        },
        onPanResponderMove: (evt: GestureResponderEvent, gestureState: PanResponderGestureState) => {
          const touches = evt.nativeEvent.touches;

          if (touches.length >= 2) {
            const [a, b] = touches;
            const currentDistance = distance(a.pageX, a.pageY, b.pageX, b.pageY);
            const currentAngle = angleDeg(a.pageX, a.pageY, b.pageX, b.pageY);
            const scaleFactor = gestureStart.current.pinchDistance > 0 ? currentDistance / gestureStart.current.pinchDistance : 1;
            const nextScale = Math.min(Math.max(gestureStart.current.scale * scaleFactor, 0.4), 4);
            const nextRotation = gestureStart.current.rotation + (currentAngle - gestureStart.current.pinchAngle);
            onChange(overlay.id, { scale: nextScale, rotation: nextRotation });
            return;
          }

          if (!dragging && (Math.abs(gestureState.dx) > TAP_MOVE_THRESHOLD || Math.abs(gestureState.dy) > TAP_MOVE_THRESHOLD)) {
            setDragging(true);
            onDragStateChange(true);
          }
          const nextX = gestureStart.current.x + gestureState.dx / containerWidth;
          const nextY = gestureStart.current.y + gestureState.dy / containerHeight;
          onChange(overlay.id, { x: nextX, y: nextY });
        },
        onPanResponderRelease: (evt: GestureResponderEvent) => {
          if (dragging) {
            const touch = evt.nativeEvent.changedTouches[0];
            if (touch && isOverTrash(touch.pageX, touch.pageY)) {
              onDeleted(overlay.id);
            }
          }
          setDragging(false);
          onDragStateChange(false);
        },
      }),
    [overlay, containerWidth, containerHeight, dragging, onChange, onDoubleTap, onDragStateChange, isOverTrash, onDeleted],
  );

  return (
    <View
      {...panResponder.panHandlers}
      style={[
        styles.wrapper,
        {
          left: overlay.x * containerWidth,
          top: overlay.y * containerHeight,
          transform: [{ scale: overlay.scale }, { rotate: `${overlay.rotation}deg` }],
          opacity: dragging ? 0.85 : 1,
        },
      ]}
    >
      <OverlayBody overlay={overlay} containerWidth={containerWidth} containerHeight={containerHeight} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { position: "absolute" },
});
