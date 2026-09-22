import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Dimensions, Image, PanResponder, Pressable, StyleSheet, Text, View } from "react-native";
import Video from "react-native-video";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/types";
import { colors, radii, spacing, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { getMyActiveStories, getUserActiveStories, mediaFileUrl, recordStoryView, type PublicStory } from "../../api/stories";
import { getMedia } from "../../api/media";
import { EmptyState } from "../../components/EmptyState";

type Props = NativeStackScreenProps<RootStackParamList, "StoryViewer">;

const PHOTO_DURATION_MS = 5000;
const DEFAULT_VIDEO_DURATION_MS = 15000; // until the Video component's onLoad reports the real one
const HOLD_DELAY_MS = 250;
const SWIPE_CLOSE_THRESHOLD = 100;
const TAP_MOVE_THRESHOLD = 10;

/**
 * Full-screen viewer for ONE creator's active Story sequence (spec
 * section 4). Cross-creator swipe navigation is bundled with Phase 5's
 * "full Home gesture system" and isn't attempted here — tap right/left
 * move within this creator's own Stories, hold pauses, swipe down closes.
 */
export function StoryViewerScreen({ route, navigation }: Props): React.JSX.Element {
  const { username, initialStoryId } = route.params;
  const { user: authUser, accessToken } = useAuth();

  const [stories, setStories] = useState<PublicStory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [mediaKind, setMediaKind] = useState<"photo" | "video" | null>(null);
  const [videoDurationMs, setVideoDurationMs] = useState<number | null>(null);

  const progress = useRef(new Animated.Value(0)).current;
  const animationRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!accessToken) return;
      try {
        const isSelf = authUser?.username === username;
        const { stories: fetched } = isSelf
          ? await getMyActiveStories(accessToken)
          : await getUserActiveStories(username, accessToken);
        if (cancelled) return;
        if (fetched.length === 0) {
          setError("No active Stories.");
          return;
        }
        setStories(fetched);
        const startIndex = initialStoryId ? fetched.findIndex((s) => s.id === initialStoryId) : 0;
        setIndex(startIndex >= 0 ? startIndex : 0);
      } catch {
        if (!cancelled) setError("Couldn't load this Story.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [username, accessToken, authUser, initialStoryId]);

  const currentStory = stories?.[index] ?? null;

  // Reset per-story playback state, then look up whether this Story's
  // media is a photo or video so the right player renders (media metadata
  // is reachable here even for someone else's Story — see
  // media.routes.ts's requireAccessibleMedia — so this is a real lookup,
  // not a guess).
  useEffect(() => {
    setMediaKind(null);
    setVideoDurationMs(null);
    if (!currentStory || !accessToken) return;
    let cancelled = false;
    getMedia(currentStory.mediaId, accessToken)
      .then((media) => {
        if (!cancelled) setMediaKind(media.kind);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load this Story.");
      });
    return () => {
      cancelled = true;
    };
  }, [currentStory, accessToken]);

  useEffect(() => {
    if (!currentStory || !accessToken) return;
    void recordStoryView(currentStory.id, accessToken).catch(() => undefined);
  }, [currentStory, accessToken]);

  const goNext = useCallback(() => {
    if (!stories) return;
    if (index >= stories.length - 1) {
      navigation.goBack();
      return;
    }
    setIndex((i) => i + 1);
  }, [stories, index, navigation]);

  const goPrevious = useCallback(() => {
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  useEffect(() => {
    progress.setValue(0);
    if (paused || !currentStory || mediaKind === null) return;
    if (mediaKind === "video" && videoDurationMs === null) return; // wait for onLoad before starting the bar

    const durationMs = mediaKind === "video" ? (videoDurationMs as number) : PHOTO_DURATION_MS;
    animationRef.current?.stop();
    const anim = Animated.timing(progress, { toValue: 1, duration: durationMs, useNativeDriver: false });
    animationRef.current = anim;
    anim.start(({ finished }) => {
      if (finished) goNext();
    });
    return () => anim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, paused, mediaKind, videoDurationMs]);

  const gesture = useMemo(() => {
    const screenWidth = Dimensions.get("window").width;
    let startX = 0;
    let startY = 0;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let didHold = false;

    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        startX = evt.nativeEvent.pageX;
        startY = evt.nativeEvent.pageY;
        didHold = false;
        holdTimer = setTimeout(() => {
          didHold = true;
          setPaused(true);
        }, HOLD_DELAY_MS);
      },
      onPanResponderRelease: (evt) => {
        if (holdTimer) clearTimeout(holdTimer);

        if (didHold) {
          setPaused(false);
          return;
        }

        const dx = evt.nativeEvent.pageX - startX;
        const dy = evt.nativeEvent.pageY - startY;

        if (dy > SWIPE_CLOSE_THRESHOLD && Math.abs(dx) < SWIPE_CLOSE_THRESHOLD) {
          navigation.goBack();
          return;
        }
        if (Math.abs(dx) > TAP_MOVE_THRESHOLD || Math.abs(dy) > TAP_MOVE_THRESHOLD) return;

        if (evt.nativeEvent.pageX < screenWidth / 2) {
          goPrevious();
        } else {
          goNext();
        }
      },
      onPanResponderTerminate: () => {
        if (holdTimer) clearTimeout(holdTimer);
        setPaused(false);
      },
    });
  }, [goNext, goPrevious, navigation]);

  if (error) {
    return <EmptyState title="Story unavailable" message={error} />;
  }
  if (!currentStory) {
    return (
      <View style={styles.centered}>
        <Text style={typography.body}>Loading…</Text>
      </View>
    );
  }

  const mediaUrl = mediaFileUrl(currentStory.mediaId);
  const authHeaders = accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined;

  return (
    <View style={styles.container} {...gesture.panHandlers}>
      {mediaKind === "video" ? (
        <Video
          source={{ uri: mediaUrl, headers: authHeaders }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          paused={paused}
          onLoad={(meta) => setVideoDurationMs(Math.max(meta.duration * 1000, 1000))}
          onEnd={goNext}
        />
      ) : mediaKind === "photo" ? (
        <Image source={{ uri: mediaUrl, headers: authHeaders }} style={StyleSheet.absoluteFill} resizeMode="cover" />
      ) : null}

      <View style={styles.progressRow}>
        {stories?.map((s, i) => (
          <View key={s.id} style={styles.progressTrack}>
            <Animated.View
              style={[
                styles.progressFill,
                {
                  width:
                    i < index
                      ? "100%"
                      : i > index
                        ? "0%"
                        : progress.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }),
                },
              ]}
            />
          </View>
        ))}
      </View>

      <View style={styles.footer}>
        <View style={styles.avatarPlaceholder}>
          <Text style={styles.avatarInitial}>{username.charAt(0).toUpperCase()}</Text>
        </View>
        <View style={styles.footerText}>
          <Text style={styles.username}>@{username}</Text>
          {currentStory.caption ? <Text style={styles.caption}>{currentStory.caption}</Text> : null}
          {stories && stories.length > 1 ? (
            <Text style={styles.sequence}>
              {index + 1} of {stories.length} today
            </Text>
          ) : null}
        </View>
      </View>

      <Pressable style={styles.closeButton} onPress={() => navigation.goBack()} hitSlop={12}>
        <Text style={styles.closeIcon}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background },
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
    borderRadius: radii.pill,
    backgroundColor: "rgba(255,255,255,0.3)",
    overflow: "hidden",
  },
  progressFill: { height: "100%", backgroundColor: colors.textPrimary },
  footer: {
    position: "absolute",
    bottom: spacing.xl,
    left: spacing.md,
    right: spacing.md,
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "center",
  },
  avatarPlaceholder: {
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    borderWidth: 2,
    borderColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  avatarInitial: { color: colors.textPrimary, fontWeight: "700" },
  footerText: { flex: 1 },
  username: { color: colors.textPrimary, fontWeight: "700" },
  caption: { color: colors.textPrimary, marginTop: 2 },
  sequence: { color: "rgba(255,255,255,0.7)", fontSize: 12, marginTop: 2 },
  closeButton: { position: "absolute", top: spacing.xl, right: spacing.md },
  closeIcon: { color: colors.textPrimary, fontSize: 22 },
});
