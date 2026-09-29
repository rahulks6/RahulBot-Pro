import React, { useMemo, useRef } from "react";
import { PanResponder, StyleSheet, View, type GestureResponderEvent, type PanResponderGestureState } from "react-native";
import { clampCrop, type StoryCrop } from "../models/storyDraft";

interface Props {
  crop: StoryCrop;
  containerWidth: number;
  containerHeight: number;
  onChange: (crop: StoryCrop) => void;
}

function distance(a: { pageX: number; pageY: number }, b: { pageX: number; pageY: number }): number {
  return Math.sqrt((b.pageX - a.pageX) ** 2 + (b.pageY - a.pageY) ** 2);
}

/**
 * The crop tool (spec: `StoryDraft.crop`, "preview accuracy" for
 * crop) — pinch with two fingers to zoom, drag with one to pan, both
 * hand-rolled on `PanResponder` (nativeEvent.touches), the same
 * dependency-free technique the rest of this module uses. Only active
 * while the editor's Crop mode is on (its own toggle, like Draw), so it
 * never competes with the swipe-to-cycle-filter gesture underneath it.
 *
 * Pan is converted to/from the normalized `offsetX`/`offsetY` (see
 * storyDraft.ts's `mediaTransformStyle`) using the *current* zoom, so a
 * finger's on-screen distance always maps to the same visual distance
 * regardless of how zoomed in the preview already is.
 */
export function CropGestureLayer({ crop, containerWidth, containerHeight, onChange }: Props): React.JSX.Element {
  const gestureStart = useRef({ zoom: crop.zoom, offsetX: crop.offsetX, offsetY: crop.offsetY, pinchDistance: 0 });

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt: GestureResponderEvent) => {
          gestureStart.current.zoom = crop.zoom;
          gestureStart.current.offsetX = crop.offsetX;
          gestureStart.current.offsetY = crop.offsetY;
          const touches = evt.nativeEvent.touches;
          if (touches.length >= 2) {
            const [a, b] = touches;
            gestureStart.current.pinchDistance = distance(a, b);
          }
        },
        onPanResponderMove: (evt: GestureResponderEvent, gestureState: PanResponderGestureState) => {
          const touches = evt.nativeEvent.touches;
          if (touches.length >= 2) {
            const [a, b] = touches;
            const currentDistance = distance(a, b);
            if (gestureStart.current.pinchDistance === 0) {
              gestureStart.current.pinchDistance = currentDistance;
              return;
            }
            const factor = currentDistance / gestureStart.current.pinchDistance;
            onChange(clampCrop({ ...crop, zoom: gestureStart.current.zoom * factor }));
            return;
          }
          gestureStart.current.pinchDistance = 0;
          const zoom = gestureStart.current.zoom;
          const panRoomX = (containerWidth * (zoom - 1)) / 2;
          const panRoomY = (containerHeight * (zoom - 1)) / 2;
          const nextOffsetX = panRoomX > 0 ? gestureStart.current.offsetX + gestureState.dx / panRoomX : 0;
          const nextOffsetY = panRoomY > 0 ? gestureStart.current.offsetY + gestureState.dy / panRoomY : 0;
          onChange(clampCrop({ zoom, offsetX: nextOffsetX, offsetY: nextOffsetY }));
        },
        onPanResponderRelease: () => {
          gestureStart.current.pinchDistance = 0;
        },
      }),
    [crop, containerWidth, containerHeight, onChange],
  );

  return (
    <View
      style={StyleSheet.absoluteFill}
      {...panResponder.panHandlers}
      accessible
      accessibilityLabel="Crop: pinch to zoom, drag to reposition"
    />
  );
}
