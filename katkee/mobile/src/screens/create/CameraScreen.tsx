import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanResponder, Pressable, StyleSheet, Text, View, type GestureResponderEvent } from "react-native";
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useMicrophonePermission,
  type CameraPosition,
} from "react-native-vision-camera";
import { launchImageLibrary } from "react-native-image-picker";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { CreateStackParamList } from "../../navigation/types";
import { colors, radii, spacing } from "../../theme";
import { useTapGesture } from "../../hooks/useTapGesture";
import { EmptyState } from "../../components/EmptyState";
import { guessMimeTypeFromUri } from "../../utils/mime";

type Props = NativeStackScreenProps<CreateStackParamList, "Camera">;

const MAX_RECORDING_SECONDS = 60;
const RECORD_HOLD_DELAY_MS = 250;
const RECORD_DRAG_ZOOM_SENSITIVITY = 4; // px of vertical drag per 1x of zoom
const ZOOM_INDICATOR_HOLD_MS = 900;

function touchDistance(a: { pageX: number; pageY: number }, b: { pageX: number; pageY: number }): number {
  return Math.sqrt((b.pageX - a.pageX) ** 2 + (b.pageY - a.pageY) ** 2);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/**
 * Full-screen camera capture (spec section 17): tap for a photo,
 * press-and-hold for video, two-finger pinch-zoom on the preview AND
 * one-finger drag-to-zoom while holding the capture button (spec section
 * 18) with a temporary "Nx" indicator, tap-to-focus/double-tap-to-flip,
 * flash, timer, and gallery import.
 *
 * Both zoom gestures are hand-rolled on core `PanResponder`
 * (`nativeEvent.touches`) rather than `react-native-gesture-handler` — this
 * file used to import that library's `PinchGestureHandler` without it ever
 * being declared in package.json (a real bug: it would have failed to
 * resolve on a real build). The rest of this codebase already proves a
 * dependency-free multitouch pattern works (DraggableCanvasObject.tsx), so
 * this follows it instead of introducing a new native dependency for one
 * screen. Camera access itself (react-native-vision-camera) can't be
 * exercised in this sandbox — no device, no npm install — so this is
 * correct-by-inspection TypeScript against that library's real v4 API, not
 * verified by running it. See mobile/README.md.
 */
export function CameraScreen({ navigation }: Props): React.JSX.Element {
  const { hasPermission: hasCameraPermission, requestPermission: requestCameraPermission } = useCameraPermission();
  const { hasPermission: hasMicPermission, requestPermission: requestMicPermission } = useMicrophonePermission();
  const [position, setPosition] = useState<CameraPosition>("back");
  const [flash, setFlash] = useState<"off" | "on">("off");
  const [timerSeconds, setTimerSeconds] = useState<0 | 3 | 10>(0);
  const [zoom, setZoom] = useState(1);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [zoomIndicator, setZoomIndicator] = useState<{ visible: boolean; label: string }>({ visible: false, label: "" });

  const device = useCameraDevice(position);
  const camera = useRef<Camera>(null);
  const recordingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const zoomIndicatorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoomRef = useRef(1);
  const minZoom = device?.minZoom ?? 1;
  const maxZoom = device?.maxZoom ?? 4;

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    if (!hasCameraPermission) void requestCameraPermission();
    if (!hasMicPermission) void requestMicPermission();
  }, [hasCameraPermission, hasMicPermission, requestCameraPermission, requestMicPermission]);

  useEffect(() => {
    return () => {
      if (recordingTimer.current) clearInterval(recordingTimer.current);
      if (zoomIndicatorTimer.current) clearTimeout(zoomIndicatorTimer.current);
    };
  }, []);

  const flashZoomIndicator = useCallback((z: number) => {
    setZoomIndicator({ visible: true, label: `${z.toFixed(1)}x` });
    if (zoomIndicatorTimer.current) clearTimeout(zoomIndicatorTimer.current);
    zoomIndicatorTimer.current = setTimeout(() => setZoomIndicator((v) => ({ ...v, visible: false })), ZOOM_INDICATOR_HOLD_MS);
  }, []);

  const applyZoom = useCallback(
    (next: number) => {
      const clamped = clamp(next, minZoom, maxZoom);
      setZoom(clamped);
      flashZoomIndicator(clamped);
    },
    [minZoom, maxZoom, flashZoomIndicator],
  );

  const goToEditor = useCallback(
    (mediaUri: string, kind: "photo" | "video", width: number | null, height: number | null, mimeType?: string) => {
      navigation.replace("StoryEditor", {
        mediaUri,
        kind,
        width,
        height,
        mimeType: mimeType ?? guessMimeTypeFromUri(mediaUri, kind),
      });
    },
    [navigation],
  );

  const takePhoto = useCallback(async () => {
    if (!camera.current) return;
    if (timerSeconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, timerSeconds * 1000));
    }
    const photo = await camera.current.takePhoto({ flash });
    goToEditor(`file://${photo.path}`, "photo", photo.width, photo.height);
  }, [flash, timerSeconds, goToEditor]);

  const startRecording = useCallback(() => {
    if (!camera.current || isRecording) return;
    setIsRecording(true);
    setRecordingSeconds(0);
    recordingTimer.current = setInterval(() => {
      setRecordingSeconds((s) => {
        if (s + 1 >= MAX_RECORDING_SECONDS && camera.current) {
          void camera.current.stopRecording();
        }
        return s + 1;
      });
    }, 1000);

    camera.current.startRecording({
      flash,
      onRecordingFinished: (video) => {
        if (recordingTimer.current) clearInterval(recordingTimer.current);
        setIsRecording(false);
        goToEditor(`file://${video.path}`, "video", null, null);
      },
      onRecordingError: () => {
        if (recordingTimer.current) clearInterval(recordingTimer.current);
        setIsRecording(false);
      },
    });
  }, [flash, isRecording, goToEditor]);

  const stopRecording = useCallback(async () => {
    if (!camera.current || !isRecording) return;
    await camera.current.stopRecording();
  }, [isRecording]);

  const openGallery = useCallback(async () => {
    const result = await launchImageLibrary({ mediaType: "mixed", selectionLimit: 1 });
    const asset = result.assets?.[0];
    if (!asset?.uri) return;
    const kind = asset.type?.startsWith("video") ? "video" : "photo";
    goToEditor(asset.uri, kind, asset.width ?? null, asset.height ?? null, asset.type);
  }, [goToEditor]);

  const onPreviewTap = useTapGesture(
    (x, y) => {
      void camera.current?.focus({ x, y });
    },
    () => setPosition((p) => (p === "back" ? "front" : "back")),
  );

  // Two-finger pinch-zoom + single-tap-to-focus/double-tap-to-flip on the
  // full preview — both live on one PanResponder since RN's touch
  // responder negotiation resolves bottom-up (a nested Pressable would
  // claim the touch before this ever saw it), the same reason
  // DraggableGrid's items detect taps inside their own PanResponder.
  const previewGesture = useMemo(() => {
    let pinchActive = false;
    let pinchStartDistance = 0;
    let pinchStartZoom = 1;
    let tapStart = { x: 0, y: 0, locationX: 0, locationY: 0 };

    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt: GestureResponderEvent) => {
        const touches = evt.nativeEvent.touches;
        pinchActive = false;
        if (touches.length >= 2) {
          const [a, b] = touches;
          pinchActive = true;
          pinchStartDistance = touchDistance(a, b);
          pinchStartZoom = zoomRef.current;
        } else {
          tapStart = {
            x: evt.nativeEvent.pageX,
            y: evt.nativeEvent.pageY,
            locationX: evt.nativeEvent.locationX,
            locationY: evt.nativeEvent.locationY,
          };
        }
      },
      onPanResponderMove: (evt: GestureResponderEvent) => {
        const touches = evt.nativeEvent.touches;
        if (touches.length >= 2) {
          if (!pinchActive) {
            const [a, b] = touches;
            pinchActive = true;
            pinchStartDistance = touchDistance(a, b);
            pinchStartZoom = zoomRef.current;
            return;
          }
          const [a, b] = touches;
          const currentDistance = touchDistance(a, b);
          const factor = pinchStartDistance > 0 ? currentDistance / pinchStartDistance : 1;
          applyZoom(pinchStartZoom * factor);
        }
      },
      onPanResponderRelease: (evt: GestureResponderEvent) => {
        if (pinchActive) {
          pinchActive = false;
          return;
        }
        const dx = evt.nativeEvent.pageX - tapStart.x;
        const dy = evt.nativeEvent.pageY - tapStart.y;
        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) return; // a pan, not a tap
        onPreviewTap(tapStart.locationX, tapStart.locationY);
      },
      onPanResponderTerminate: () => {
        pinchActive = false;
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyZoom, onPreviewTap]);

  // One-finger record-and-vertical-drag-to-zoom, scoped to the capture
  // button itself so nothing else on the preview can be misread as this
  // gesture while actually recording (spec: "nothing else should interpret
  // that motion"). A hold past RECORD_HOLD_DELAY_MS starts recording,
  // exactly like the old onLongPress; a release before that is a photo tap.
  const captureGesture = useMemo(() => {
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let recordingStarted = false;
    let dragStartY = 0;
    let dragStartZoom = 1;

    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt: GestureResponderEvent) => {
        recordingStarted = false;
        dragStartY = evt.nativeEvent.pageY;
        dragStartZoom = zoomRef.current;
        holdTimer = setTimeout(() => {
          recordingStarted = true;
          startRecording();
        }, RECORD_HOLD_DELAY_MS);
      },
      onPanResponderMove: (evt: GestureResponderEvent) => {
        if (!recordingStarted) return;
        const dy = dragStartY - evt.nativeEvent.pageY; // dragging up = zoom in
        applyZoom(dragStartZoom + dy / RECORD_DRAG_ZOOM_SENSITIVITY);
      },
      onPanResponderRelease: () => {
        if (holdTimer) {
          clearTimeout(holdTimer);
          holdTimer = null;
        }
        if (recordingStarted) {
          void stopRecording();
        } else {
          void takePhoto();
        }
      },
      onPanResponderTerminate: () => {
        if (holdTimer) {
          clearTimeout(holdTimer);
          holdTimer = null;
        }
        if (recordingStarted) void stopRecording();
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startRecording, stopRecording, takePhoto, applyZoom]);

  if (!hasCameraPermission || !hasMicPermission) {
    return <EmptyState title="Camera access needed" message="Grant camera and microphone permission to create a Story." />;
  }
  if (!device) {
    return <EmptyState title="No camera available" message="This device doesn't have a usable camera." />;
  }

  return (
    <View style={styles.container}>
      <View style={StyleSheet.absoluteFill} {...previewGesture.panHandlers}>
        <Camera ref={camera} style={StyleSheet.absoluteFill} device={device} isActive photo video audio zoom={zoom} />
      </View>

      {zoomIndicator.visible ? (
        <View style={styles.zoomBadge}>
          <Text style={styles.zoomBadgeLabel}>{zoomIndicator.label}</Text>
        </View>
      ) : null}

      <View style={styles.topBar}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={12}>
          <Text style={styles.topIcon}>✕</Text>
        </Pressable>
        <View style={styles.topRight}>
          <Pressable onPress={() => setFlash((f) => (f === "off" ? "on" : "off"))} hitSlop={12}>
            <Text style={[styles.topIcon, flash === "on" && styles.topIconActive]}>⚡</Text>
          </Pressable>
          <Pressable
            onPress={() => setTimerSeconds((t) => (t === 0 ? 3 : t === 3 ? 10 : 0))}
            hitSlop={12}
            style={styles.timerButton}
          >
            <Text style={[styles.topIcon, timerSeconds > 0 && styles.topIconActive]}>
              {timerSeconds === 0 ? "Timer" : `${timerSeconds}s`}
            </Text>
          </Pressable>
        </View>
      </View>

      {isRecording ? (
        <View style={styles.recordingBadge}>
          <View style={styles.recordingDot} />
          <Text style={styles.recordingText}>
            {String(Math.floor(recordingSeconds / 60)).padStart(2, "0")}:
            {String(recordingSeconds % 60).padStart(2, "0")}
          </Text>
        </View>
      ) : null}

      <View style={styles.bottomBar}>
        <Pressable onPress={openGallery} hitSlop={12} style={styles.sideButton}>
          <Text style={styles.sideButtonLabel}>Gallery</Text>
        </Pressable>

        <View {...captureGesture.panHandlers} style={[styles.captureButton, isRecording && styles.captureButtonRecording]} />

        <Pressable onPress={() => setPosition((p) => (p === "back" ? "front" : "back"))} hitSlop={12} style={styles.sideButton}>
          <Text style={styles.sideButtonLabel}>Flip</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  topBar: {
    position: "absolute",
    top: spacing.xl,
    left: spacing.md,
    right: spacing.md,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  topRight: { flexDirection: "row", gap: spacing.lg },
  topIcon: { color: colors.textPrimary, fontSize: 20, fontWeight: "600" },
  topIconActive: { color: colors.accent },
  timerButton: { minWidth: 40 },
  zoomBadge: {
    position: "absolute",
    alignSelf: "center",
    top: "45%",
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  zoomBadgeLabel: { color: colors.textPrimary, fontSize: 18, fontWeight: "700" },
  recordingBadge: {
    position: "absolute",
    top: spacing.xl,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: "rgba(0,0,0,0.5)",
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  recordingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.danger },
  recordingText: { color: colors.textPrimary, fontWeight: "600" },
  bottomBar: {
    position: "absolute",
    bottom: spacing.xl,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xl,
  },
  sideButton: { width: 56, alignItems: "center" },
  sideButtonLabel: { color: colors.textPrimary, fontSize: 13 },
  captureButton: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: colors.textPrimary,
    backgroundColor: "transparent",
  },
  captureButtonRecording: { backgroundColor: colors.danger, borderColor: colors.danger },
});
