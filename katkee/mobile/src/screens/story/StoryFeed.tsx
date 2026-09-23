import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Dimensions, Image, PanResponder, Pressable, StyleSheet, Text, Vibration, View } from "react-native";
import Video from "react-native-video";
import { colors, radii, spacing, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { getMyActiveStories, getUserActiveStories, getViewCount, mediaFileUrl, recordStoryView, type PublicStory } from "../../api/stories";
import { getMedia } from "../../api/media";
import { getStoryDetail, likeStory, unlikeStory, type StoryDetail } from "../../api/engagement";
import { recordEvent } from "../../api/events";
import { EmptyState } from "../../components/EmptyState";
import { CommentsSheet } from "../../components/CommentsSheet";
import { ShareSheet } from "../../components/ShareSheet";
import { StoryMoreMenu } from "../../components/StoryMoreMenu";
import { StoryViewersSheet } from "../../components/StoryViewersSheet";

const PHOTO_DURATION_MS = 5000;
const HOLD_DELAY_MS = 250;
const SWIPE_CLOSE_THRESHOLD = 100;
const TAP_MOVE_THRESHOLD = 10;
const DOUBLE_TAP_WINDOW_MS = 250;
const QUALIFIED_VIEW_MS = 2000; // spec section 13: "2-second view = tiny positive"
const QUICK_SKIP_MS = 1500; // spec section 8: leaving a creator this fast is a real negative signal

export interface StoryFeedProps {
  creators: string[];
  startIndex: number;
  initialStoryId?: string;
  /**
   * Present only when this feed was pushed on top of something to return
   * to (a profile's Story ring, a notification, a DM share) — shows the
   * close (X) button, and reaching either edge of `creators` calls this
   * instead of the embedded "you're all caught up" end state below.
   */
  onClose?: () => void;
  onOpenDM: (params: { storyId: string; ownerUsername: string }) => void;
}

/**
 * Full-screen Story feed with the complete gesture set (spec section 4):
 * tap right/left move within a creator's Stories (crossing to the next
 * creator only at the end of their sequence, per spec), swipe up/down move
 * between creators outright, hold pauses, double-tap ensures a like (never
 * unlikes), and the right-side action rail (Heart/Comment/Share/More —
 * spec section 5) is real, not decorative.
 *
 * This is the shared core behind both Home (spec sections 4-6: a
 * zero-tap, full-screen, auto-advancing feed — `onClose` omitted, no tap
 * needed to reach it) and StoryViewerScreen (a single creator's Stories
 * opened from their profile, a notification, or a DM share — `onClose`
 * provided so there's something to return to).
 */
export function StoryFeed({ creators, startIndex, initialStoryId, onClose, onOpenDM }: StoryFeedProps): React.JSX.Element {
  const { user: authUser, accessToken } = useAuth();

  const [creatorIndex, setCreatorIndex] = useState(startIndex);
  const [storiesByCreator, setStoriesByCreator] = useState<Record<string, PublicStory[]>>({});
  const [storyIndexByCreator, setStoryIndexByCreator] = useState<Record<string, number>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [caughtUp, setCaughtUp] = useState(false);

  const [detail, setDetail] = useState<StoryDetail | null>(null);
  const [viewCount, setViewCount] = useState<number | null>(null);
  const [mediaKind, setMediaKind] = useState<"photo" | "video" | null>(null);
  const [videoDurationMs, setVideoDurationMs] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [heartPulse] = useState(() => new Animated.Value(0));

  const [commentsOpen, setCommentsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [viewersOpen, setViewersOpen] = useState(false);

  const progress = useRef(new Animated.Value(0)).current;
  const animationRef = useRef<Animated.CompositeAnimation | null>(null);
  const storyShownAtRef = useRef<number>(Date.now());
  const creatorArrivedAtRef = useRef<number>(Date.now());

  const currentUsername = creators[creatorIndex];
  const currentStories = currentUsername ? storiesByCreator[currentUsername] : undefined;
  const currentStoryIndex = currentUsername ? (storyIndexByCreator[currentUsername] ?? 0) : 0;
  const currentStory = currentStories?.[currentStoryIndex] ?? null;

  const sheetOpen = commentsOpen || shareOpen || moreOpen || viewersOpen;

  // Every analytics call is fire-and-forget on purpose (spec section 12: real,
  // server-validated events — but a dropped one must never interrupt viewing).
  const emit = useCallback(
    (eventType: Parameters<typeof recordEvent>[0]["eventType"], extra: { creatorId?: string; storyId?: string; valueMs?: number } = {}) => {
      if (!accessToken) return;
      void recordEvent({ eventType, ...extra }, accessToken).catch(() => undefined);
    },
    [accessToken],
  );

  // The escape hatch for "nothing left to show here": returns to whatever
  // this feed was opened from when there is one (onClose), otherwise (Home)
  // there's nowhere to go back to, so a fresh creator/story is the only move.
  const leaveCurrentCreator = useCallback(
    (direction: "forward" | "backward") => {
      if (onClose) {
        onClose();
        return;
      }
      if (direction === "forward") {
        setCaughtUp(true);
      }
      // Backward past the first creator, with nothing above Home, is a no-op (bounce).
    },
    [onClose],
  );

  // Fetch (and cache) a creator's active Stories the first time we reach them.
  useEffect(() => {
    if (!currentUsername || !accessToken || storiesByCreator[currentUsername]) return;
    let cancelled = false;
    (async () => {
      try {
        const isSelf = authUser?.username === currentUsername;
        const { stories } = isSelf
          ? await getMyActiveStories(accessToken)
          : await getUserActiveStories(currentUsername, accessToken);
        if (cancelled) return;
        if (stories.length === 0) {
          leaveCurrentCreator("forward");
          return;
        }
        setStoriesByCreator((prev) => ({ ...prev, [currentUsername]: stories }));
        if (creatorIndex === startIndex && initialStoryId) {
          const idx = stories.findIndex((s) => s.id === initialStoryId);
          if (idx >= 0) setStoryIndexByCreator((prev) => ({ ...prev, [currentUsername]: idx }));
        }
      } catch {
        if (!cancelled) setLoadError("Couldn't load this Story.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUsername, accessToken]);

  // Fires once per arrival at a creator (including a return visit after
  // swiping away and back — `currentStories` is a different array
  // reference each time storiesByCreator's key selection changes).
  useEffect(() => {
    if (!currentStories || currentStories.length === 0) return;
    creatorArrivedAtRef.current = Date.now();
    const ownerId = currentStories[0]?.ownerId;
    if (ownerId) {
      emit("creator_impression", { creatorId: ownerId });
      emit("creator_sequence_started", { creatorId: ownerId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStories]);

  // Fetch full engagement detail + media kind for whichever story is now current, and record the view.
  useEffect(() => {
    setDetail(null);
    setMediaKind(null);
    setVideoDurationMs(null);
    setViewCount(null);
    if (!currentStory || !accessToken) return;
    let cancelled = false;
    (async () => {
      try {
        const [{ story }, media] = await Promise.all([
          getStoryDetail(currentStory.id, accessToken),
          getMedia(currentStory.mediaId, accessToken),
        ]);
        if (cancelled) return;
        setDetail(story);
        setMediaKind(media.kind);
      } catch {
        if (!cancelled) setLoadError("Couldn't load this Story.");
      }
    })();
    void recordStoryView(currentStory.id, accessToken)
      .then(() => getViewCount(currentStory.id, accessToken))
      .then(({ views }) => {
        if (!cancelled) setViewCount(views);
      })
      .catch(() => undefined);
    emit("story_impression", { storyId: currentStory.id, creatorId: currentStory.ownerId });
    storyShownAtRef.current = Date.now();

    // On leaving this Story (a real navigation away, or the component
    // unmounting), report how long it was actually on screen.
    return () => {
      cancelled = true;
      const elapsed = Date.now() - storyShownAtRef.current;
      emit("watch_duration", { storyId: currentStory.id, valueMs: Math.min(elapsed, 30 * 60 * 1000) });
      if (elapsed >= QUALIFIED_VIEW_MS) {
        emit("qualified_view", { storyId: currentStory.id, creatorId: currentStory.ownerId });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStory, accessToken]);

  // spec section 8: leaving a creator within QUICK_SKIP_MS of arriving is a real negative signal.
  const maybeEmitQuickSkip = useCallback(() => {
    if (!currentStory) return;
    if (Date.now() - creatorArrivedAtRef.current < QUICK_SKIP_MS) {
      emit("quick_creator_skip", { creatorId: currentStory.ownerId });
    }
  }, [currentStory, emit]);

  const goNextCreator = useCallback(() => {
    maybeEmitQuickSkip();
    if (creatorIndex >= creators.length - 1) {
      leaveCurrentCreator("forward");
      return;
    }
    setCreatorIndex((i) => i + 1);
  }, [creatorIndex, creators.length, leaveCurrentCreator, maybeEmitQuickSkip]);

  const goPreviousCreator = useCallback(() => {
    maybeEmitQuickSkip();
    if (creatorIndex <= 0) {
      leaveCurrentCreator("backward");
      return;
    }
    setCreatorIndex((i) => i - 1);
  }, [creatorIndex, leaveCurrentCreator, maybeEmitQuickSkip]);

  const goNextStory = useCallback(() => {
    if (!currentUsername || !currentStories) return;
    if (currentStoryIndex >= currentStories.length - 1) {
      if (currentStory) emit("creator_sequence_completed", { creatorId: currentStory.ownerId });
      goNextCreator(); // spec section 4: a right tap past the last Story moves to the next creator
      return;
    }
    if (currentStory) emit("creator_sequence_continued", { creatorId: currentStory.ownerId });
    setStoryIndexByCreator((prev) => ({ ...prev, [currentUsername]: currentStoryIndex + 1 }));
  }, [currentUsername, currentStories, currentStoryIndex, currentStory, goNextCreator, emit]);

  const goPreviousStory = useCallback(() => {
    if (!currentUsername) return;
    if (currentStory && currentStoryIndex > 0) {
      emit("creator_sequence_continued", { creatorId: currentStory.ownerId });
    }
    setStoryIndexByCreator((prev) => ({ ...prev, [currentUsername]: Math.max(0, currentStoryIndex - 1) }));
  }, [currentUsername, currentStoryIndex, currentStory, emit]);

  // Auto-advance progress bar.
  useEffect(() => {
    progress.setValue(0);
    if (paused || sheetOpen || !currentStory || mediaKind === null) return;
    if (mediaKind === "video" && videoDurationMs === null) return;

    const durationMs = mediaKind === "video" ? (videoDurationMs as number) : PHOTO_DURATION_MS;
    animationRef.current?.stop();
    const anim = Animated.timing(progress, { toValue: 1, duration: durationMs, useNativeDriver: false });
    animationRef.current = anim;
    anim.start(({ finished }) => {
      if (finished) {
        if (currentStory) emit("story_complete", { storyId: currentStory.id, creatorId: currentStory.ownerId });
        goNextStory();
      }
    });
    return () => anim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStory, paused, sheetOpen, mediaKind, videoDurationMs]);

  const ensureLiked = useCallback(async () => {
    if (!accessToken || !currentStory || !detail || detail.viewerHasLiked) return;
    setDetail((d) => (d ? { ...d, viewerHasLiked: true, likeCount: d.likeCount + 1 } : d));
    Vibration.vibrate(10); // no haptics package available — a short vibration is a real, if blunter, substitute
    Animated.sequence([
      Animated.timing(heartPulse, { toValue: 1, duration: 150, useNativeDriver: true }),
      Animated.timing(heartPulse, { toValue: 0, duration: 150, useNativeDriver: true }),
    ]).start();
    try {
      await likeStory(currentStory.id, accessToken);
    } catch {
      setDetail((d) => (d ? { ...d, viewerHasLiked: false, likeCount: Math.max(0, d.likeCount - 1) } : d));
    }
  }, [accessToken, currentStory, detail, heartPulse]);

  const toggleLike = useCallback(async () => {
    if (!accessToken || !currentStory || !detail) return;
    const wasLiked = detail.viewerHasLiked;
    setDetail((d) => (d ? { ...d, viewerHasLiked: !wasLiked, likeCount: d.likeCount + (wasLiked ? -1 : 1) } : d));
    if (!wasLiked) Vibration.vibrate(10);
    try {
      if (wasLiked) await unlikeStory(currentStory.id, accessToken);
      else await likeStory(currentStory.id, accessToken);
    } catch {
      setDetail((d) => (d ? { ...d, viewerHasLiked: wasLiked, likeCount: d.likeCount + (wasLiked ? 1 : -1) } : d));
    }
  }, [accessToken, currentStory, detail]);

  // Combined tap(left/right) / double-tap(like) / hold(pause) / swipe(creator) recognizer.
  // Single-tap navigation is deliberately delayed behind the double-tap
  // window so a double-tap is never misread as two single taps first
  // (same rule as spec section 4's Home gestures).
  const gesture = useMemo(() => {
    const screenWidth = Dimensions.get("window").width;
    let startX = 0;
    let startY = 0;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingTapTimer: ReturnType<typeof setTimeout> | null = null;
    let didHold = false;
    let lastTapAt = 0;

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
          if (currentStory) emit("creator_swipe_previous", { creatorId: currentStory.ownerId });
          goPreviousCreator();
          return;
        }
        if (dy < -SWIPE_CLOSE_THRESHOLD && Math.abs(dx) < SWIPE_CLOSE_THRESHOLD) {
          if (currentStory) emit("creator_swipe_next", { creatorId: currentStory.ownerId });
          goNextCreator();
          return;
        }
        if (Math.abs(dx) > TAP_MOVE_THRESHOLD || Math.abs(dy) > TAP_MOVE_THRESHOLD) return;

        const now = Date.now();
        if (now - lastTapAt < DOUBLE_TAP_WINDOW_MS) {
          if (pendingTapTimer) {
            clearTimeout(pendingTapTimer);
            pendingTapTimer = null;
          }
          lastTapAt = 0;
          void ensureLiked();
          return;
        }
        lastTapAt = now;
        const tapX = evt.nativeEvent.pageX;
        pendingTapTimer = setTimeout(() => {
          pendingTapTimer = null;
          if (!currentStory) return;
          if (tapX < screenWidth / 2) {
            emit("story_previous", { storyId: currentStory.id, creatorId: currentStory.ownerId });
            goPreviousStory();
          } else {
            emit("story_next", { storyId: currentStory.id, creatorId: currentStory.ownerId });
            goNextStory();
          }
        }, DOUBLE_TAP_WINDOW_MS);
      },
      onPanResponderTerminate: () => {
        if (holdTimer) clearTimeout(holdTimer);
        setPaused(false);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goNextStory, goPreviousStory, goNextCreator, goPreviousCreator, ensureLiked, currentStory, emit]);

  if (caughtUp) {
    return <EmptyState title="You're all caught up" message="No more Stories right now — check back soon." />;
  }
  if (loadError) {
    return <EmptyState title="Story unavailable" message={loadError} />;
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
  const isOwnStory = authUser?.username === currentUsername;

  return (
    <View style={styles.container} {...gesture.panHandlers}>
      {mediaKind === "video" ? (
        <Video
          source={{ uri: mediaUrl, headers: authHeaders }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          paused={paused || sheetOpen}
          onLoad={(meta) => setVideoDurationMs(Math.max(meta.duration * 1000, 1000))}
          onEnd={() => {
            emit("story_complete", { storyId: currentStory.id, creatorId: currentStory.ownerId });
            goNextStory();
          }}
        />
      ) : mediaKind === "photo" ? (
        <Image source={{ uri: mediaUrl, headers: authHeaders }} style={StyleSheet.absoluteFill} resizeMode="cover" />
      ) : null}

      <Animated.View
        pointerEvents="none"
        style={[styles.heartBurst, { opacity: heartPulse, transform: [{ scale: heartPulse.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1.4] }) }] }]}
      >
        <Text style={styles.heartBurstIcon}>♥</Text>
      </Animated.View>

      <View style={styles.progressRow}>
        {currentStories?.map((s, i) => (
          <View key={s.id} style={styles.progressTrack}>
            <Animated.View
              style={[
                styles.progressFill,
                {
                  width:
                    i < currentStoryIndex
                      ? "100%"
                      : i > currentStoryIndex
                        ? "0%"
                        : progress.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }),
                },
              ]}
            />
          </View>
        ))}
      </View>

      <View style={styles.actionRail}>
        <Pressable onPress={toggleLike} hitSlop={10} style={styles.actionButton}>
          <Text style={[styles.actionIcon, detail?.viewerHasLiked && styles.actionIconLiked]}>♥</Text>
          <Text style={styles.actionCount}>{detail?.likeCount ?? "—"}</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            emit("comment_open", { storyId: currentStory.id, creatorId: currentStory.ownerId });
            setCommentsOpen(true);
          }}
          hitSlop={10}
          style={styles.actionButton}
        >
          <Text style={styles.actionIcon}>◯</Text>
          <Text style={styles.actionCount}>{detail?.commentCount ?? "—"}</Text>
        </Pressable>
        <Pressable onPress={() => setShareOpen(true)} hitSlop={10} style={styles.actionButton}>
          <Text style={styles.actionIcon}>↗</Text>
        </Pressable>
        <Pressable onPress={() => setMoreOpen(true)} hitSlop={10} style={styles.actionButton}>
          <Text style={styles.actionIcon}>•••</Text>
        </Pressable>
      </View>

      <View style={styles.footer}>
        <View style={styles.avatarPlaceholder}>
          <Text style={styles.avatarInitial}>{(currentUsername ?? "?").charAt(0).toUpperCase()}</Text>
        </View>
        <View style={styles.footerText}>
          <Text style={styles.username}>@{currentUsername}</Text>
          {currentStory.caption ? <Text style={styles.caption}>{currentStory.caption}</Text> : null}
          {currentStories && currentStories.length > 1 ? (
            <Text style={styles.sequence}>
              {currentStoryIndex + 1} of {currentStories.length} today
            </Text>
          ) : null}
        </View>
        {/* Visible to any authorized viewer — who's behind the number is owner-only (StoryViewersSheet). */}
        {isOwnStory ? (
          <Pressable onPress={() => setViewersOpen(true)} hitSlop={8} style={styles.viewCountButton}>
            <Text style={styles.viewCount}>👁 {viewCount ?? "—"}</Text>
          </Pressable>
        ) : (
          <Text style={styles.viewCount}>👁 {viewCount ?? "—"}</Text>
        )}
      </View>

      {onClose ? (
        <Pressable style={styles.closeButton} onPress={onClose} hitSlop={12}>
          <Text style={styles.closeIcon}>✕</Text>
        </Pressable>
      ) : null}

      <CommentsSheet
        visible={commentsOpen}
        storyId={currentStory.id}
        storyOwnerId={currentStory.ownerId}
        commentsDisabled={currentStory.allowComments === "disabled"}
        onClose={() => setCommentsOpen(false)}
        onCommentCountChange={(delta) => setDetail((d) => (d ? { ...d, commentCount: Math.max(0, d.commentCount + delta) } : d))}
      />
      <ShareSheet
        visible={shareOpen}
        storyId={currentStory.id}
        ownerUsername={currentUsername ?? ""}
        isPublic={currentStory.audience === "public" && currentStory.allowSharing}
        onClose={() => setShareOpen(false)}
        onSendToUser={() => {
          setShareOpen(false);
          onOpenDM({ storyId: currentStory.id, ownerUsername: currentUsername ?? "" });
        }}
      />
      <StoryMoreMenu
        visible={moreOpen}
        storyId={currentStory.id}
        isOwnStory={isOwnStory}
        otherUsername={isOwnStory ? null : (currentUsername ?? null)}
        otherUserId={isOwnStory ? null : currentStory.ownerId}
        onClose={() => setMoreOpen(false)}
        onDeleted={() => {
          setMoreOpen(false);
          goNextCreator();
        }}
      />
      {isOwnStory ? (
        <StoryViewersSheet visible={viewersOpen} storyId={currentStory.id} onClose={() => setViewersOpen(false)} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background },
  heartBurst: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  heartBurstIcon: { fontSize: 96, color: colors.textPrimary },
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
  actionRail: {
    position: "absolute",
    right: spacing.md,
    bottom: spacing.xl * 3,
    alignItems: "center",
    gap: spacing.lg,
  },
  actionButton: { alignItems: "center", gap: 2 },
  actionIcon: { color: colors.textPrimary, fontSize: 26 },
  actionIconLiked: { color: colors.accent },
  actionCount: { color: colors.textPrimary, fontSize: 12 },
  footer: {
    position: "absolute",
    bottom: spacing.xl,
    left: spacing.md,
    right: spacing.xxl * 2,
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
  viewCountButton: { alignItems: "flex-end" },
  viewCount: { color: "rgba(255,255,255,0.85)", fontSize: 12, fontWeight: "600" },
  closeButton: { position: "absolute", top: spacing.xl, right: spacing.md },
  closeIcon: { color: colors.textPrimary, fontSize: 22 },
});
