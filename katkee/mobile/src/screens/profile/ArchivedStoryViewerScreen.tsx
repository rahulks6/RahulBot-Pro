import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, Image, Pressable, StyleSheet, Text, View } from "react-native";
import Video from "react-native-video";
import type { NativeStackScreenProps, NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useNavigation } from "@react-navigation/native";
import type { RootStackParamList } from "../../navigation/types";
import { colors, spacing } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { getStoryDetail, type StoryDetail } from "../../api/engagement";
import { getMedia } from "../../api/media";
import { mediaFileUrl } from "../../api/stories";
import { ApiError } from "../../api/client";
import { StoryOverlayLayer, useContainerLayout } from "../../components/StoryOverlayLayer";
import { filterNameFromKey } from "../../models/filterPreviews";

type Props = NativeStackScreenProps<RootStackParamList, "ArchivedStoryViewer">;

const PHOTO_DURATION_MS = 5000;

/**
 * Single, view-only playback of one of your own Archive Stories, active
 * or long expired — the gap StoryFeed.tsx's own doc comment flags:
 * that pipeline only ever fetches a creator's *active* Stories
 * (getMyActiveStories/getUserActiveStories), so it can't play back
 * something Archive shows that's since expired. This works for exactly
 * that case because getStoryDetail/media access both already let an
 * owner reach their own content regardless of expiry (see
 * stories.service.ts's checkStoryAccess and media.routes.ts's
 * requireAccessibleMedia) — no backend change needed, only this screen.
 * Deliberately as simple as HighlightViewerScreen.tsx: no like/comment,
 * no next/previous (Archive's own grid is the "next", one tap away).
 */
export function ArchivedStoryViewerScreen({ route, navigation }: Props): React.JSX.Element {
  const { storyId } = route.params;
  const { accessToken } = useAuth();
  const rootNavigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const [detail, setDetail] = useState<StoryDetail | null>(null);
  const [mediaKind, setMediaKind] = useState<"photo" | "video" | null>(null);
  const [videoDurationMs, setVideoDurationMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [containerSize, onContainerLayout] = useContainerLayout();
  const progress = useRef(new Animated.Value(0)).current;
  const animationRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    (async () => {
      try {
        const { story } = await getStoryDetail(storyId, accessToken);
        const media = await getMedia(story.mediaId, accessToken);
        if (cancelled) return;
        setDetail(story);
        setMediaKind(media.kind);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Couldn't load this Story.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storyId, accessToken]);

  const close = useCallback(() => navigation.goBack(), [navigation]);

  useEffect(() => {
    if (!detail || mediaKind === null) return;
    if (mediaKind === "video" && videoDurationMs === null) return;
    const durationMs = mediaKind === "video" ? (videoDurationMs as number) : PHOTO_DURATION_MS;

    progress.setValue(0);
    animationRef.current = Animated.timing(progress, { toValue: 1, duration: durationMs, useNativeDriver: false });
    animationRef.current.start(({ finished }) => {
      if (finished) close();
    });
    return () => animationRef.current?.stop();
  }, [detail, mediaKind, videoDurationMs, progress, close]);

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error}</Text>
        <Pressable style={styles.closeButton} onPress={close} hitSlop={12}>
          <Text style={styles.closeIcon}>✕</Text>
        </Pressable>
      </View>
    );
  }

  if (!detail) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const mediaUrl = mediaFileUrl(detail.mediaId);
  const authHeaders = accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined;

  return (
    <View style={styles.container} onLayout={onContainerLayout}>
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
        <ActivityIndicator color={colors.accent} style={styles.loadingSpinner} />
      )}

      {containerSize.width > 0 ? (
        <StoryOverlayLayer
          overlays={detail.overlays}
          drawing={detail.drawing}
          filter={filterNameFromKey(detail.filter)}
          containerWidth={containerSize.width}
          containerHeight={containerSize.height}
          onMentionPress={(username) =>
            rootNavigation.navigate("Main", { screen: "Search", params: { screen: "UserProfile", params: { username } } })
          }
        />
      ) : null}

      <View style={styles.progressTrack}>
        <Animated.View
          style={[styles.progressFill, { width: progress.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) }]}
        />
      </View>

      {detail.caption ? <Text style={styles.caption}>{detail.caption}</Text> : null}

      <Pressable style={styles.closeButton} onPress={close} hitSlop={12}>
        <Text style={styles.closeIcon}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background, gap: spacing.md },
  errorText: { color: colors.danger },
  loadingSpinner: { position: "absolute", top: "50%", left: "50%", marginLeft: -10, marginTop: -10 },
  progressTrack: {
    position: "absolute",
    top: spacing.xl,
    left: spacing.sm,
    right: spacing.sm,
    height: 3,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.3)",
    overflow: "hidden",
  },
  progressFill: { height: "100%", backgroundColor: "#fff" },
  caption: {
    position: "absolute",
    bottom: spacing.xl,
    left: spacing.md,
    right: spacing.xxl * 2,
    color: "#fff",
  },
  closeButton: { position: "absolute", top: spacing.xl + 10, right: spacing.md, padding: spacing.xs },
  closeIcon: { color: "#fff", fontSize: 20 },
});
