import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { PinchGestureHandler, type PinchGestureHandlerGestureEvent } from "react-native-gesture-handler";
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
import { colors, spacing } from "../../theme";
import { useTapGesture } from "../../hooks/useTapGesture";
import { EmptyState } from "../../components/EmptyState";
import { guessMimeTypeFromUri } from "../../utils/mime";

type Props = NativeStackScreenProps<CreateStackParamList, "Camera">;

const MAX_RECORDING_SECONDS = 60;

/**
 * Full-screen camera capture (spec section 17): tap for a photo,
 * press-and-hold for video, flip, flash, timer, and gallery import. Camera
 * access itself (react-native-vision-camera) can't be exercised in this
 * sandbox — no device, no npm install — so this is correct-by-inspection
 * TypeScript against that library's real v4 API, not verified by running
 * it. See mobile/README.md.
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

  const device = useCameraDevice(position);
  const camera = useRef<Camera>(null);
  const recordingTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!hasCameraPermission) void requestCameraPermission();
    if (!hasMicPermission) void requestMicPermission();
  }, [hasCameraPermission, hasMicPermission, requestCameraPermission, requestMicPermission]);

  useEffect(() => {
    return () => {
      if (recordingTimer.current) clearInterval(recordingTimer.current);
    };
  }, []);

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

  const onPinch = useCallback((event: PinchGestureHandlerGestureEvent) => {
    setZoom((current) => {
      const next = current * event.nativeEvent.scale;
      return Math.min(Math.max(next, 1), device?.maxZoom ?? 4);
    });
  }, [device]);

  const onPreviewTap = useTapGesture(
    (x, y) => {
      void camera.current?.focus({ x, y });
    },
    () => setPosition((p) => (p === "back" ? "front" : "back")),
  );

  if (!hasCameraPermission || !hasMicPermission) {
    return <EmptyState title="Camera access needed" message="Grant camera and microphone permission to create a Story." />;
  }
  if (!device) {
    return <EmptyState title="No camera available" message="This device doesn't have a usable camera." />;
  }

  return (
    <View style={styles.container}>
      <PinchGestureHandler onGestureEvent={onPinch}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={(e) => onPreviewTap(e.nativeEvent.locationX, e.nativeEvent.locationY)}
        >
          <Camera
            ref={camera}
            style={StyleSheet.absoluteFill}
            device={device}
            isActive
            photo
            video
            audio
            zoom={zoom}
          />
        </Pressable>
      </PinchGestureHandler>

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

        <Pressable
          onPress={takePhoto}
          onLongPress={startRecording}
          onPressOut={stopRecording}
          delayLongPress={250}
          style={[styles.captureButton, isRecording && styles.captureButtonRecording]}
        />

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
