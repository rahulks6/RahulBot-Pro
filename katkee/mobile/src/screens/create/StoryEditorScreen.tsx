import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import Video from "react-native-video";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { CreateStackParamList } from "../../navigation/types";
import { colors, radii, spacing, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { uploadPhoto, uploadVideo } from "../../api/media";
import { ApiError } from "../../api/client";
import { FILTER_PREVIEWS } from "../../models/filterPreviews";
import { createEmptyDraft, hasMeaningfulEdits, type Overlay } from "../../models/storyDraft";
import { DraggableTextOverlay } from "../../components/DraggableTextOverlay";
import { TextToolModal } from "../../components/TextToolModal";

type Props = NativeStackScreenProps<CreateStackParamList, "StoryEditor">;

const TRASH_ZONE_SIZE = 80;

/**
 * Story editor (spec section 19-27): text overlays, filters (preview-only —
 * see models/filterPreviews.ts for why), discard protection, and uploading
 * the finished media. Publishing (audience, comment/sharing settings, the
 * 24h lifecycle — spec section 28-29) is Phase 4, which doesn't exist yet,
 * so this screen's action is honestly labeled "Upload", not "Share Story".
 */
export function StoryEditorScreen({ route, navigation }: Props): React.JSX.Element {
  const { mediaUri, kind, mimeType } = route.params;
  const { accessToken } = useAuth();

  const [draft, setDraft] = useState(() => createEmptyDraft({ uri: mediaUri, kind, width: route.params.width, height: route.params.height }));
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [textModalVisible, setTextModalVisible] = useState(false);
  const [editingOverlayId, setEditingOverlayId] = useState<string | null>(null);
  const [isDraggingOverlay, setIsDraggingOverlay] = useState(false);
  const [videoMuted, setVideoMuted] = useState(false);
  const [uploadState, setUploadState] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);

  const nextZIndex = useRef(1);

  const onContainerLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setContainerSize({ width, height });
  };

  const isOverTrash = useCallback(
    (pageX: number, pageY: number) => {
      // Trash zone sits bottom-center of the editor; approximate its hit box
      // in absolute (page) coordinates from the container's own layout.
      const zoneLeft = containerSize.width / 2 - TRASH_ZONE_SIZE / 2;
      const zoneTop = containerSize.height - TRASH_ZONE_SIZE - spacing.xl;
      return (
        pageX >= zoneLeft && pageX <= zoneLeft + TRASH_ZONE_SIZE && pageY >= zoneTop && pageY <= zoneTop + TRASH_ZONE_SIZE
      );
    },
    [containerSize],
  );

  const addOrUpdateOverlay = (text: string, properties: Overlay["properties"]) => {
    if (editingOverlayId) {
      setDraft((d) => ({
        ...d,
        overlays: d.overlays.map((o) => (o.id === editingOverlayId ? { ...o, text, properties } : o)),
      }));
    } else {
      const overlay: Overlay = {
        id: `text-${Date.now()}`,
        type: "text",
        x: 0.5,
        y: 0.5,
        scale: 1,
        rotation: 0,
        zIndex: nextZIndex.current++,
        text,
        properties,
      };
      setDraft((d) => ({ ...d, overlays: [...d.overlays, overlay] }));
    }
    setEditingOverlayId(null);
    setTextModalVisible(false);
  };

  const updateOverlay = useCallback((id: string, patch: Partial<Pick<Overlay, "x" | "y" | "scale" | "rotation">>) => {
    setDraft((d) => ({ ...d, overlays: d.overlays.map((o) => (o.id === id ? { ...o, ...patch } : o)) }));
  }, []);

  const deleteOverlay = useCallback((id: string) => {
    setDraft((d) => ({ ...d, overlays: d.overlays.filter((o) => o.id !== id) }));
  }, []);

  const editingOverlay = draft.overlays.find((o) => o.id === editingOverlayId) ?? null;

  const activeFilter = useMemo(() => FILTER_PREVIEWS.find((f) => f.name === draft.filter) ?? FILTER_PREVIEWS[0], [draft.filter]);

  const confirmDiscard = useCallback(
    (onDiscard: () => void) => {
      if (!hasMeaningfulEdits(draft)) {
        onDiscard();
        return;
      }
      Alert.alert("Discard Story?", undefined, [
        { text: "Keep Editing", style: "cancel" },
        { text: "Discard", style: "destructive", onPress: onDiscard },
      ]);
    },
    [draft],
  );

  const onClose = () => confirmDiscard(() => navigation.goBack());

  const onUpload = async () => {
    if (!accessToken) return;
    setUploadState("uploading");
    setUploadError(null);
    try {
      if (kind === "photo") {
        await uploadPhoto(mediaUri, mimeType, accessToken);
      } else {
        await uploadVideo(mediaUri, mimeType, accessToken);
      }
      setUploadState("done");
    } catch (err) {
      setUploadState("error");
      setUploadError(err instanceof ApiError ? err.message : "Upload failed — check your connection and try again.");
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.mediaContainer} onLayout={onContainerLayout}>
        {kind === "photo" ? (
          <Image source={{ uri: mediaUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <Video
            source={{ uri: mediaUri }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            repeat
            muted={videoMuted}
            paused={false}
          />
        )}

        {activeFilter.overlayOpacity > 0 ? (
          <View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { backgroundColor: activeFilter.overlayColor, opacity: activeFilter.overlayOpacity }]}
          />
        ) : null}

        {containerSize.width > 0
          ? draft.overlays.map((overlay) => (
              <DraggableTextOverlay
                key={overlay.id}
                overlay={overlay}
                containerWidth={containerSize.width}
                containerHeight={containerSize.height}
                isOverTrash={isOverTrash}
                onChange={updateOverlay}
                onDeleted={deleteOverlay}
                onDragStateChange={setIsDraggingOverlay}
                onDoubleTap={(id) => {
                  setEditingOverlayId(id);
                  setTextModalVisible(true);
                }}
              />
            ))
          : null}

        {isDraggingOverlay ? (
          <View style={[styles.trashZone, { width: TRASH_ZONE_SIZE, height: TRASH_ZONE_SIZE }]}>
            <Text style={styles.trashIcon}>🗑</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.topBar}>
        <Pressable onPress={onClose} hitSlop={12}>
          <Text style={styles.topIcon}>✕</Text>
        </Pressable>
        <View style={styles.topRight}>
          <Pressable
            onPress={() => {
              setEditingOverlayId(null);
              setTextModalVisible(true);
            }}
            hitSlop={12}
          >
            <Text style={styles.topIcon}>Text</Text>
          </Pressable>
          {kind === "video" ? (
            <Pressable onPress={() => setVideoMuted((m) => !m)} hitSlop={12}>
              <Text style={styles.topIcon}>{videoMuted ? "Muted" : "Audio on"}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <View style={styles.bottomArea}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterStrip}>
          {FILTER_PREVIEWS.map((f) => (
            <Pressable
              key={f.name}
              onPress={() => setDraft((d) => ({ ...d, filter: f.name }))}
              style={[styles.filterChip, draft.filter === f.name && styles.filterChipActive]}
            >
              <Text style={[styles.filterChipLabel, draft.filter === f.name && styles.filterChipLabelActive]}>{f.name}</Text>
            </Pressable>
          ))}
        </ScrollView>

        {uploadError ? <Text style={styles.uploadError}>{uploadError}</Text> : null}

        <Pressable
          style={[styles.uploadButton, uploadState === "uploading" && styles.uploadButtonDisabled]}
          disabled={uploadState === "uploading" || uploadState === "done"}
          onPress={onUpload}
        >
          {uploadState === "uploading" ? (
            <ActivityIndicator color={colors.onAccent} />
          ) : (
            <Text style={styles.uploadButtonLabel}>
              {uploadState === "done" ? "Uploaded ✓" : "Upload"}
            </Text>
          )}
        </Pressable>
      </View>

      <TextToolModal
        visible={textModalVisible}
        initialText={editingOverlay?.text}
        initialProperties={editingOverlay?.properties}
        onCancel={() => {
          setTextModalVisible(false);
          setEditingOverlayId(null);
        }}
        onDone={addOrUpdateOverlay}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  mediaContainer: { flex: 1 },
  topBar: {
    position: "absolute",
    top: spacing.xl,
    left: spacing.md,
    right: spacing.md,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  topRight: { flexDirection: "row", gap: spacing.lg },
  topIcon: { color: colors.textPrimary, fontSize: 16, fontWeight: "600" },
  trashZone: {
    position: "absolute",
    bottom: spacing.xl,
    alignSelf: "center",
    borderRadius: radii.pill,
    backgroundColor: "rgba(228,72,60,0.85)",
    alignItems: "center",
    justifyContent: "center",
  },
  trashIcon: { fontSize: 28 },
  bottomArea: { position: "absolute", bottom: spacing.xl, left: 0, right: 0, gap: spacing.sm, paddingHorizontal: spacing.md },
  filterStrip: { gap: spacing.xs, paddingBottom: spacing.sm },
  filterChip: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  filterChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  filterChipLabel: { color: colors.textPrimary, fontSize: 12 },
  filterChipLabelActive: { color: colors.onAccent, fontWeight: "700" },
  uploadError: { color: colors.danger, textAlign: "center", ...typography.caption },
  uploadButton: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingVertical: spacing.sm + 2,
    alignItems: "center",
  },
  uploadButtonDisabled: { opacity: 0.7 },
  uploadButtonLabel: { color: colors.onAccent, fontWeight: "700", fontSize: 16 },
});
