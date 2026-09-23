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
import { colors, radii, spacing, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { uploadPhoto, uploadVideo } from "../../api/media";
import { publishStory } from "../../api/stories";
import { ApiError } from "../../api/client";
import { FILTER_PREVIEWS } from "../../models/filterPreviews";
import { createEmptyDraft, hasMeaningfulEdits, filterKey, type Overlay, type TextOverlayProperties } from "../../models/storyDraft";
import { DraggableCanvasObject } from "../../components/DraggableCanvasObject";
import { OverlayBody } from "../../components/OverlayBody";
import { TextToolModal } from "../../components/TextToolModal";
import { StickerSheet, type StickerAddPayload } from "../../components/StickerSheet";
import { DrawingCanvas } from "../../components/DrawingCanvas";
import { OverlayAdjustSheet } from "../../components/OverlayAdjustSheet";

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
  const [editingOverlayId, setEditingOverlayId] = useState<string | null>(null);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [isDraggingOverlay, setIsDraggingOverlay] = useState(false);
  const [uploadState, setUploadState] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [filterToastName, setFilterToastName] = useState<string | null>(null);

  const nextZIndex = useRef(1);
  const filterToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (filterToastTimer.current) clearTimeout(filterToastTimer.current);
    };
  }, []);

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

  const deleteOverlay = useCallback((id: string) => {
    setDraft((d) => ({ ...d, overlays: d.overlays.filter((o) => o.id !== id) }));
  }, []);

  const editingOverlay = draft.overlays.find((o) => o.id === editingOverlayId && o.type === "text") as
    | (Overlay & { type: "text" })
    | undefined;

  const selectedOverlay = draft.overlays.find((o) => o.id === selectedOverlayId) ?? null;

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

  const onClose = () => confirmDiscard(() => navigation.goBack());

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
        },
        accessToken,
      );
      setUploadState("done");
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
          <Image source={{ uri: mediaUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <Video
            source={{ uri: mediaUri }}
            style={StyleSheet.absoluteFill}
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

        {!drawMode ? (
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

        {containerSize.width > 0 && !drawMode
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
                  } else {
                    setSelectedOverlayId(id);
                  }
                }}
              />
            ))
          : containerSize.width > 0
            ? // While drawing, overlays render statically (no gesture handlers) so drag/pinch never fights with the drawing gesture.
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
            <Text style={styles.trashIcon}>🗑</Text>
          </View>
        ) : null}
      </View>

      {!drawMode ? (
        <View style={styles.topBar}>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close editor">
            <Text style={styles.topIcon}>✕</Text>
          </Pressable>
          <View style={styles.topRight}>
            <Pressable
              onPress={() => {
                setEditingOverlayId(null);
                setTextModalVisible(true);
              }}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Add text"
            >
              <Text style={styles.topIcon}>Text</Text>
            </Pressable>
            <Pressable onPress={() => setStickerSheetVisible(true)} hitSlop={12} accessibilityRole="button" accessibilityLabel="Add sticker, emoji, mention, location, or date and time">
              <Text style={styles.topIcon}>Stickers</Text>
            </Pressable>
            <Pressable onPress={() => setDrawMode(true)} hitSlop={12} accessibilityRole="button" accessibilityLabel="Draw">
              <Text style={styles.topIcon}>Draw</Text>
            </Pressable>
            {kind === "video" ? (
              <Pressable
                onPress={() => setDraft((d) => ({ ...d, audioMuted: !d.audioMuted }))}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel={draft.audioMuted ? "Audio muted, tap to turn on" : "Audio on, tap to mute"}
              >
                <Text style={styles.topIcon}>{draft.audioMuted ? "Muted" : "Audio on"}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}

      {!drawMode ? (
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
      <StickerSheet visible={stickerSheetVisible} onClose={() => setStickerSheetVisible(false)} onAdd={addSticker} />
      <OverlayAdjustSheet
        overlay={selectedOverlay}
        onChange={updateOverlay}
        onEditText={(id) => {
          setEditingOverlayId(id);
          setTextModalVisible(true);
        }}
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
