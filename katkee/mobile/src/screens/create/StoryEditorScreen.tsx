import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type PanResponderGestureState,
} from "react-native";
import Video from "react-native-video";
import type { NativeStackScreenProps, NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useNavigation } from "@react-navigation/native";
import type { CreateStackParamList, RootStackParamList } from "../../navigation/types";
import { colors, radii, spacing, typography, ICONS } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { uploadPhoto, uploadVideo } from "../../api/media";
import { publishStory } from "../../api/stories";
import { ApiError } from "../../api/client";
import { FILTER_PREVIEWS } from "../../models/filterPreviews";
import {
  createEmptyDraft,
  hasMeaningfulEdits,
  filterKey,
  mediaTransformStyle,
  type Overlay,
  type TextOverlayProperties,
  type LocationOverlayProperties,
  type DateTimeOverlayProperties,
} from "../../models/storyDraft";
import { DraggableCanvasObject } from "../../components/DraggableCanvasObject";
import { OverlayBody } from "../../components/OverlayBody";
import { TextToolModal } from "../../components/TextToolModal";
import { StickerSheet, type StickerAddPayload } from "../../components/StickerSheet";
import { DrawingCanvas } from "../../components/DrawingCanvas";
import { OverlayAdjustSheet } from "../../components/OverlayAdjustSheet";
import { CropGestureLayer } from "../../components/CropGestureLayer";
import { CropAdjustControls } from "../../components/CropAdjustControls";
import { savePendingDraft, loadPendingDraft, clearPendingDraft } from "../../state/draftStorage";

type Props = NativeStackScreenProps<CreateStackParamList, "StoryEditor">;
type Audience = "public" | "followers";

const TRASH_ZONE_SIZE = 80;

/**
 * Story editor (spec sections 19-30): text/emoji/mention/location/datetime/
 * sticker overlays sharing one gesture model, freehand drawing, filters,
 * discard protection, and real publishing that actually sends every one of
 * those edits to the backend (see onShare — this used to silently drop
 * overlays and the chosen filter on publish, the single most important
 * correctness bug this module closes; see backend migration 0015).
 */
export function StoryEditorScreen({ route, navigation }: Props): React.JSX.Element {
  const { mediaUri, kind, mimeType } = route.params;
  const { accessToken } = useAuth();
  const rootNavigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [audience, setAudience] = useState<Audience>("public");

  const [draft, setDraft] = useState(() => createEmptyDraft({ uri: mediaUri, kind, width: route.params.width, height: route.params.height }));
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [textModalVisible, setTextModalVisible] = useState(false);
  const [stickerSheetVisible, setStickerSheetVisible] = useState(false);
  const [drawMode, setDrawMode] = useState(false);
  const [cropMode, setCropMode] = useState(false);
  const [editingOverlayId, setEditingOverlayId] = useState<string | null>(null);
  const [editingStickerOverlayId, setEditingStickerOverlayId] = useState<string | null>(null);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [isDraggingOverlay, setIsDraggingOverlay] = useState(false);
  const [uploadState, setUploadState] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [filterToastName, setFilterToastName] = useState<string | null>(null);

  const nextZIndex = useRef(1);
  const filterToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    return () => {
      if (filterToastTimer.current) clearTimeout(filterToastTimer.current);
    };
  }, []);

  // Crash-safe autosave (spec section 42: "persist local draft" as its own
  // step, not just React state). Restore-on-mount runs once, before the
  // autosave effect below is allowed to write anything — otherwise the
  // freshly-mounted empty draft would overwrite a real saved one before
  // it's ever read.
  useEffect(() => {
    let cancelled = false;
    loadPendingDraft(mediaUri).then((saved) => {
      if (cancelled) return;
      if (saved && hasMeaningfulEdits(saved.draft)) {
        setDraft(saved.draft);
        setAudience(saved.audience);
      }
      setRestored(true);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaUri]);

  useEffect(() => {
    if (!restored) return;
    const timer = setTimeout(() => {
      if (hasMeaningfulEdits(draft)) {
        void savePendingDraft(mediaUri, { draft, audience, mimeType, savedAt: new Date().toISOString() });
      } else {
        void clearPendingDraft(mediaUri);
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [restored, draft, audience, mediaUri, mimeType]);

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

  const addOrUpdateText = (text: string, properties: TextOverlayProperties) => {
    if (editingOverlayId) {
      setDraft((d) => ({
        ...d,
        overlays: d.overlays.map((o) => (o.id === editingOverlayId && o.type === "text" ? { ...o, properties } : o)),
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
        properties,
      };
      setDraft((d) => ({ ...d, overlays: [...d.overlays, overlay] }));
    }
    setEditingOverlayId(null);
    setTextModalVisible(false);
  };

  const addSticker = useCallback((payload: StickerAddPayload) => {
    const overlay = {
      id: `${payload.type}-${Date.now()}`,
      x: 0.5,
      y: 0.5,
      scale: 1,
      rotation: 0,
      zIndex: nextZIndex.current++,
      ...payload,
    } as Overlay;
    setDraft((d) => ({ ...d, overlays: [...d.overlays, overlay] }));
  }, []);

  const updateOverlay = useCallback((id: string, patch: Partial<Pick<Overlay, "x" | "y" | "scale" | "rotation">>) => {
    setDraft((d) => ({ ...d, overlays: d.overlays.map((o) => (o.id === id ? { ...o, ...patch } : o)) }));
  }, []);

  /** Location/date-time content edit — geometry (position/scale/rotation) stays exactly where it was. */
  const updateOverlayContent = useCallback((id: string, properties: LocationOverlayProperties | DateTimeOverlayProperties) => {
    setDraft((d) => ({
      ...d,
      overlays: d.overlays.map((o) => ((o.type === "location" || o.type === "datetime") && o.id === id ? ({ ...o, properties } as Overlay) : o)),
    }));
  }, []);

  const deleteOverlay = useCallback((id: string) => {
    setDraft((d) => ({ ...d, overlays: d.overlays.filter((o) => o.id !== id) }));
  }, []);

  const editingOverlay = draft.overlays.find((o) => o.id === editingOverlayId && o.type === "text") as
    | (Overlay & { type: "text" })
    | undefined;

  const selectedOverlay = draft.overlays.find((o) => o.id === selectedOverlayId) ?? null;

  const editingStickerOverlay = draft.overlays.find((o) => o.id === editingStickerOverlayId) ?? null;

  const openStickerEditor = useCallback((id: string) => {
    setEditingStickerOverlayId(id);
    setStickerSheetVisible(true);
  }, []);

  const activeFilter = useMemo(() => FILTER_PREVIEWS.find((f) => f.name === draft.filter) ?? FILTER_PREVIEWS[0], [draft.filter]);

  const showFilterToast = useCallback((name: string) => {
    setFilterToastName(name);
    if (filterToastTimer.current) clearTimeout(filterToastTimer.current);
    filterToastTimer.current = setTimeout(() => setFilterToastName(null), 900);
  }, []);

  const cycleFilter = useCallback(
    (direction: 1 | -1) => {
      setDraft((d) => {
        const currentIndex = FILTER_PREVIEWS.findIndex((f) => f.name === d.filter);
        const nextIndex = (currentIndex + direction + FILTER_PREVIEWS.length) % FILTER_PREVIEWS.length;
        const next = FILTER_PREVIEWS[nextIndex];
        showFilterToast(next.name);
        return { ...d, filter: next.name };
      });
    },
    [showFilterToast],
  );

  const SWIPE_FILTER_THRESHOLD = 40;

  // Swipe-to-cycle filters (spec: "swipe-to-cycle with a briefly-shown
  // filter name, suppressed while actively manipulating a text/sticker
  // object"). This layer sits beneath the canvas objects in paint order
  // (rendered before them, right below), so it only ever receives a touch
  // that starts on empty canvas — a touch that starts on an object hits
  // that object's own PanResponder first (RN's topmost-sibling-wins
  // hit-testing), which is what "suppressed while manipulating an object"
  // means in practice here, with no extra flag needed. Rendered only
  // outside draw mode, and any modal (text/stickers/adjust) already
  // blocks all touches to the screen beneath it while open.
  const filterSwipeGesture = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_evt: GestureResponderEvent, gestureState: PanResponderGestureState) =>
          Math.abs(gestureState.dx) > 10 && Math.abs(gestureState.dx) > Math.abs(gestureState.dy),
        onPanResponderRelease: (_evt: GestureResponderEvent, gestureState: PanResponderGestureState) => {
          if (gestureState.dx <= -SWIPE_FILTER_THRESHOLD) cycleFilter(1);
          else if (gestureState.dx >= SWIPE_FILTER_THRESHOLD) cycleFilter(-1);
        },
      }),
    [cycleFilter],
  );

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

  const onClose = () =>
    confirmDiscard(() => {
      void clearPendingDraft(mediaUri);
      navigation.goBack();
    });

  const onShare = async () => {
    if (!accessToken) return;
    setUploadState("uploading");
    setUploadError(null);
    try {
      const media = kind === "photo" ? await uploadPhoto(mediaUri, mimeType, accessToken) : await uploadVideo(mediaUri, mimeType, accessToken);
      await publishStory(
        {
          mediaId: media.id,
          caption: draft.caption,
          audience,
          allowComments: "everyone",
          allowSharing: true,
          overlays: draft.overlays,
          drawing: draft.drawing,
          filter: filterKey(draft.filter),
          audioMuted: draft.audioMuted,
          crop: draft.crop,
        },
        accessToken,
      );
      setUploadState("done");
      void clearPendingDraft(mediaUri);
      rootNavigation.reset({ index: 0, routes: [{ name: "Main" }] });
    } catch (err) {
      // Nothing is lost on failure — `draft` (media uri, overlays, drawing,
      // filter, caption, audience) stays exactly as it was so Retry can
      // simply call onShare again (spec section 43).
      setUploadState("error");
      setUploadError(err instanceof ApiError ? err.message : "Sharing failed — check your connection and try again.");
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.mediaContainer} onLayout={onContainerLayout}>
        {kind === "photo" ? (
          <Image
            source={{ uri: mediaUri }}
            style={[StyleSheet.absoluteFill, mediaTransformStyle(draft.crop, containerSize.width, containerSize.height)]}
            resizeMode="cover"
          />
        ) : (
          <Video
            source={{ uri: mediaUri }}
            style={[StyleSheet.absoluteFill, mediaTransformStyle(draft.crop, containerSize.width, containerSize.height)]}
            resizeMode="cover"
            repeat
            muted={draft.audioMuted}
            paused={false}
          />
        )}

        {activeFilter.overlayOpacity > 0 ? (
          <View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { backgroundColor: activeFilter.overlayColor, opacity: activeFilter.overlayOpacity }]}
          />
        ) : null}

        {!drawMode && !cropMode ? (
          <View
            style={StyleSheet.absoluteFill}
            {...filterSwipeGesture.panHandlers}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
        ) : null}

        {filterToastName ? (
          <View style={styles.filterToast} pointerEvents="none">
            <Text style={styles.filterToastLabel}>{filterToastName}</Text>
          </View>
        ) : null}

        {containerSize.width > 0 && cropMode ? (
          <CropGestureLayer
            crop={draft.crop}
            containerWidth={containerSize.width}
            containerHeight={containerSize.height}
            onChange={(crop) => setDraft((d) => ({ ...d, crop }))}
          />
        ) : null}

        {containerSize.width > 0 && !drawMode && !cropMode
          ? draft.overlays.map((overlay) => (
              <DraggableCanvasObject
                key={overlay.id}
                overlay={overlay}
                containerWidth={containerSize.width}
                containerHeight={containerSize.height}
                isOverTrash={isOverTrash}
                onChange={updateOverlay}
                onDeleted={(id) => {
                  deleteOverlay(id);
                  setSelectedOverlayId((s) => (s === id ? null : s));
                }}
                onDragStateChange={setIsDraggingOverlay}
                onTap={(id) => setSelectedOverlayId(id)}
                onDoubleTap={(id) => {
                  const o = draft.overlays.find((x) => x.id === id);
                  if (o?.type === "text") {
                    setEditingOverlayId(id);
                    setTextModalVisible(true);
                  } else if (o?.type === "location" || o?.type === "datetime") {
                    openStickerEditor(id);
                  } else {
                    setSelectedOverlayId(id);
                  }
                }}
              />
            ))
          : containerSize.width > 0
            ? // While drawing or cropping, overlays render statically (no gesture handlers) so drag/pinch never fights with those gestures.
              draft.overlays.map((overlay) => (
                <View
                  key={overlay.id}
                  pointerEvents="none"
                  style={[
                    styles.staticOverlay,
                    {
                      left: overlay.x * containerSize.width,
                      top: overlay.y * containerSize.height,
                      transform: [{ scale: overlay.scale }, { rotate: `${overlay.rotation}deg` }],
                    },
                  ]}
                >
                  <OverlayBody overlay={overlay} containerWidth={containerSize.width} containerHeight={containerSize.height} />
                </View>
              ))
            : null}

        {containerSize.width > 0 && drawMode ? (
          <DrawingCanvas
            containerWidth={containerSize.width}
            containerHeight={containerSize.height}
            strokes={draft.drawing}
            onChangeStrokes={(strokes) => setDraft((d) => ({ ...d, drawing: strokes }))}
            onDone={() => setDrawMode(false)}
          />
        ) : null}

        {isDraggingOverlay ? (
          <View style={[styles.trashZone, { width: TRASH_ZONE_SIZE, height: TRASH_ZONE_SIZE }]}>
            <Text style={styles.trashIcon}>{ICONS.trash}</Text>
          </View>
        ) : null}
      </View>

      {cropMode ? (
        <>
          <View style={styles.topBar}>
            <Text style={styles.cropHint}>Pinch to zoom · Drag to reposition</Text>
            <Pressable
              onPress={() => setCropMode(false)}
              hitSlop={12}
              style={styles.cropDoneButton}
              accessibilityRole="button"
              accessibilityLabel="Done cropping"
            >
              <Text style={styles.cropDoneLabel}>Done</Text>
            </Pressable>
          </View>
          <View style={styles.cropControlsBar}>
            <CropAdjustControls crop={draft.crop} onChange={(crop) => setDraft((d) => ({ ...d, crop }))} />
          </View>
        </>
      ) : null}

      {!drawMode && !cropMode ? (
        <View style={styles.topBar}>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close editor">
            <Text style={styles.topIcon}>{ICONS.close}</Text>
          </Pressable>
          <View style={styles.topRight}>
            <Pressable onPress={() => setCropMode(true)} hitSlop={12} accessibilityRole="button" accessibilityLabel="Crop">
              <Text style={styles.topIcon}>{ICONS.crop}</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setEditingOverlayId(null);
                setTextModalVisible(true);
              }}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Add text"
            >
              <Text style={styles.topIcon}>{ICONS.text}</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setEditingStickerOverlayId(null);
                setStickerSheetVisible(true);
              }}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Add sticker, emoji, mention, location, or date and time"
            >
              <Text style={styles.topIcon}>{ICONS.sticker}</Text>
            </Pressable>
            <Pressable onPress={() => setDrawMode(true)} hitSlop={12} accessibilityRole="button" accessibilityLabel="Draw">
              <Text style={styles.topIcon}>{ICONS.draw}</Text>
            </Pressable>
            {kind === "video" ? (
              <Pressable
                onPress={() => setDraft((d) => ({ ...d, audioMuted: !d.audioMuted }))}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel={draft.audioMuted ? "Audio muted, tap to turn on" : "Audio on, tap to mute"}
              >
                <Text style={styles.topIcon}>{draft.audioMuted ? ICONS.audioMuted : ICONS.audioOn}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}

      {!drawMode && !cropMode ? (
        <View style={styles.bottomArea}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterStrip}>
            {FILTER_PREVIEWS.map((f) => (
              <Pressable
                key={f.name}
                onPress={() => setDraft((d) => ({ ...d, filter: f.name }))}
                style={[styles.filterChip, draft.filter === f.name && styles.filterChipActive]}
                accessibilityRole="button"
                accessibilityState={{ selected: draft.filter === f.name }}
              >
                <Text style={[styles.filterChipLabel, draft.filter === f.name && styles.filterChipLabelActive]}>{f.name}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <TextInput
            style={styles.captionInput}
            placeholder="Add a caption…"
            placeholderTextColor="rgba(255,255,255,0.5)"
            value={draft.caption}
            onChangeText={(text) => setDraft((d) => ({ ...d, caption: text }))}
            maxLength={280}
          />

          <View style={styles.audienceRow}>
            {(["public", "followers"] as Audience[]).map((a) => (
              <Pressable
                key={a}
                onPress={() => setAudience(a)}
                style={[styles.audienceChip, audience === a && styles.audienceChipActive]}
                accessibilityRole="button"
                accessibilityState={{ selected: audience === a }}
              >
                <Text style={[styles.audienceLabel, audience === a && styles.audienceLabelActive]}>
                  {a === "public" ? "Public" : "Followers"}
                </Text>
              </Pressable>
            ))}
          </View>

          {uploadError ? (
            <View>
              <Text style={styles.uploadError}>{uploadError}</Text>
              <Pressable style={styles.retryButton} onPress={onShare}>
                <Text style={styles.retryButtonLabel}>Retry</Text>
              </Pressable>
            </View>
          ) : null}

          <Pressable
            style={[styles.uploadButton, uploadState === "uploading" && styles.uploadButtonDisabled]}
            disabled={uploadState === "uploading" || uploadState === "done"}
            onPress={onShare}
          >
            {uploadState === "uploading" ? (
              <ActivityIndicator color={colors.onAccent} />
            ) : (
              <Text style={styles.uploadButtonLabel}>{uploadState === "done" ? "Story published ✓" : "Share Story"}</Text>
            )}
          </Pressable>
        </View>
      ) : null}

      <TextToolModal
        visible={textModalVisible}
        initialText={editingOverlay?.properties.text}
        initialProperties={editingOverlay?.properties}
        onCancel={() => {
          setTextModalVisible(false);
          setEditingOverlayId(null);
        }}
        onDone={addOrUpdateText}
      />
      <StickerSheet
        visible={stickerSheetVisible}
        onClose={() => {
          setStickerSheetVisible(false);
          setEditingStickerOverlayId(null);
        }}
        onAdd={addSticker}
        editingOverlay={editingStickerOverlay}
        onEditDone={updateOverlayContent}
      />
      <OverlayAdjustSheet
        overlay={selectedOverlay}
        onChange={updateOverlay}
        onEditText={(id) => {
          setEditingOverlayId(id);
          setTextModalVisible(true);
        }}
        onEditLocationOrDateTime={openStickerEditor}
        onDelete={(id) => deleteOverlay(id)}
        onClose={() => setSelectedOverlayId(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  mediaContainer: { flex: 1 },
  staticOverlay: { position: "absolute" },
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
  cropHint: { color: "rgba(255,255,255,0.85)", fontSize: 13 },
  cropDoneButton: { backgroundColor: colors.accent, borderRadius: radii.pill, paddingHorizontal: spacing.md, paddingVertical: 6 },
  cropDoneLabel: { color: colors.onAccent, fontWeight: "700" },
  cropControlsBar: {
    position: "absolute",
    bottom: spacing.xxl,
    left: 0,
    right: 0,
    alignItems: "center",
  },
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
  filterToast: {
    position: "absolute",
    alignSelf: "center",
    top: "45%",
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  filterToastLabel: { color: colors.textPrimary, fontSize: 18, fontWeight: "700" },
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
  captionInput: {
    color: colors.textPrimary,
    backgroundColor: "rgba(0,0,0,0.35)",
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  audienceRow: { flexDirection: "row", gap: spacing.xs, justifyContent: "center" },
  audienceChip: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  audienceChipActive: { backgroundColor: colors.textPrimary, borderColor: colors.textPrimary },
  audienceLabel: { color: colors.textPrimary, fontSize: 13 },
  audienceLabelActive: { color: colors.background, fontWeight: "700" },
  uploadError: { ...typography.caption, color: colors.danger, textAlign: "center" },
  retryButton: { alignSelf: "center", marginTop: spacing.xs, paddingHorizontal: spacing.md, paddingVertical: 4 },
  retryButtonLabel: { color: colors.accent, fontWeight: "700" },
  uploadButton: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingVertical: spacing.sm + 2,
    alignItems: "center",
  },
  uploadButtonDisabled: { opacity: 0.7 },
  uploadButtonLabel: { color: colors.onAccent, fontWeight: "700", fontSize: 16 },
});
