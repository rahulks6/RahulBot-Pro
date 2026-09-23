import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, Image, Pressable, StyleSheet, Text, View } from "react-native";
import Video from "react-native-video";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/types";
import { colors, spacing } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { getHighlightDetail, getHighlightItemDetail, type HighlightItem } from "../../api/highlights";
import { getMedia } from "../../api/media";
import { mediaFileUrl } from "../../api/stories";
import { ApiError } from "../../api/client";
import { EmptyState } from "../../components/EmptyState";

type Props = NativeStackScreenProps<RootStackParamList, "HighlightViewer">;

const PHOTO_DURATION_MS = 5000;

/**
 * Sequential, view-only playback of a Highlight's items. Deliberately a
 * separate, simpler screen from StoryViewerScreen rather than a mode
 * switch on it: StoryViewerScreen's fetches (getStoryDetail, recordView,
 * like/comment/share) all go through the *normal* per-Story endpoints,
 * which enforce the 24h expiry a Highlight exists specifically to
 * outlive. Reusing it here would mean threading an expiry-bypass through
 * every one of those calls; a Highlight is about persisting visibility,
 * not full interactive parity with a live Story, so this pass keeps
 * Highlight playback intentionally read-only — no like/comment/share,
 * no view recording (the normal view-record endpoint would 404 an
 * expired Story for a non-owner the same way the old fetch did) — see
 * mobile/README.md's "Phase 9 specifically" for this tradeoff spelled out.
 */
export function HighlightViewerScreen({ route, navigation }: Props): React.JSX.Element {
  const { highlightId, title } = route.params;
  const { accessToken, user } = useAuth();

  const [items, setItems] = useState<HighlightItem[] | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [mediaKind, setMediaKind] = useState<"photo" | "video" | null>(null);
  const [videoDurationMs, setVideoDurationMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const progress = useRef(new Animated.Value(0)).current;
  const animationRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    getHighlightDetail(highlightId, accessToken)
      .then(({ highlight }) => {
        if (!cancelled) {
          setItems(highlight.items);
          setOwnerId(highlight.ownerId);
        }
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [highlightId, accessToken]);

  const currentItem = items?.[index] ?? null;

  useEffect(() => {
    if (!currentItem || !accessToken) return;
    let cancelled = false;
    setMediaKind(null);
    setVideoDurationMs(null);
    setError(null);
    Promise.all([
      getHighlightItemDetail(highlightId, currentItem.storyId, accessToken),
      getMedia(currentItem.mediaId, accessToken),
    ])
      .then(([, media]) => {
        if (!cancelled) setMediaKind(media.kind);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Couldn't load this Story.");
      });
    return () => {
      cancelled = true;
    };
  }, [currentItem, highlightId, accessToken]);

  const goNext = useCallback(() => {
    if (!items) return;
    if (index >= items.length - 1) {
      navigation.goBack();
      return;
    }
    setIndex((i) => i + 1);
  }, [items, index, navigation]);

  const goPrevious = useCallback(() => {
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  useEffect(() => {
    if (!currentItem || mediaKind === null) return;
    if (mediaKind === "video" && videoDurationMs === null) return;
    const durationMs = mediaKind === "video" ? (videoDurationMs as number) : PHOTO_DURATION_MS;

    progress.setValue(0);
    animationRef.current = Animated.timing(progress, { toValue: 1, duration: durationMs, useNativeDriver: false });
    animationRef.current.start(({ finished }) => {
      if (finished) goNext();
    });
    return () => animationRef.current?.stop();
  }, [currentItem, mediaKind, videoDurationMs, goNext, progress]);

  if (items === null) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (items.length === 0) {
    return <EmptyState title="Nothing here" message="This Highlight has no Stories left to show." />;
  }

  if (!currentItem) return <View style={styles.container} />;

  const mediaUrl = mediaFileUrl(currentItem.mediaId);
  const authHeaders = accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined;

  return (
    <View style={styles.container}>
      {mediaKind === "video" ? (
        <Video
          source={{ uri: mediaUrl, headers: authHeaders }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          onLoad={(meta) => setVideoDurationMs(Math.max(1000, meta.duration * 1000))}
          paused={false}
          muted={false}
        />
      ) : mediaKind === "photo" ? (
        <Image source={{ uri: mediaUrl, headers: authHeaders }} style={StyleSheet.absoluteFill} resizeMode="cover" />
      ) : (
        <View style={styles.centered}>
          {error ? <Text style={styles.errorText}>{error}</Text> : <ActivityIndicator color={colors.accent} />}
        </View>
      )}

      <View style={styles.progressRow}>
        {items.map((item, i) => (
          <View key={item.storyId} style={styles.progressTrack}>
            <Animated.View
              style={[
                styles.progressFill,
                {
                  width:
                    i < index
                      ? "100%"
                      : i === index
                        ? progress.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] })
                        : "0%",
                },
              ]}
            />
          </View>
        ))}
      </View>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>

      {ownerId === user?.id ? (
        <Pressable style={styles.editButton} onPress={() => navigation.navigate("HighlightEditor", { highlightId })} hitSlop={12}>
          <Text style={styles.editIcon}>✎</Text>
        </Pressable>
      ) : null}
      <Pressable style={styles.closeButton} onPress={() => navigation.goBack()} hitSlop={12}>
        <Text style={styles.closeIcon}>✕</Text>
      </Pressable>

      <View style={styles.tapZones}>
        <Pressable style={styles.tapZone} onPress={goPrevious} />
        <Pressable style={styles.tapZone} onPress={goNext} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background },
  errorText: { color: colors.danger },
  progressRow: {
    position: "absolute",
    top: spacing.xl,
    left: spacing.sm,
    right: spacing.sm,
    flexDirection: "row",
    gap: spacing.xs,
  },
  progressTrack: {
    flex: 1,
    height: 3,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.3)",
    overflow: "hidden",
  },
  progressFill: { height: "100%", backgroundColor: "#fff" },
  title: { position: "absolute", top: spacing.xl + 14, left: spacing.md, color: "#fff", fontWeight: "700" },
  closeButton: { position: "absolute", top: spacing.xl + 10, right: spacing.md, padding: spacing.xs },
  closeIcon: { color: "#fff", fontSize: 20 },
  editButton: { position: "absolute", top: spacing.xl + 10, right: spacing.xxl + spacing.sm, padding: spacing.xs },
  editIcon: { color: "#fff", fontSize: 18 },
  tapZones: { ...StyleSheet.absoluteFillObject, flexDirection: "row" },
  tapZone: { flex: 1 },
});
