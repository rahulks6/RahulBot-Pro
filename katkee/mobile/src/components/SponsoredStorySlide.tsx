import React, { useEffect, useRef, useState } from "react";
import { Animated, Linking, Modal, PanResponder, Pressable, StyleSheet, Text, View } from "react-native";
import Video from "react-native-video";
import { colors, radii, spacing, typography, ICONS } from "../theme";
import { useAuth } from "../state/AuthContext";
import { getMedia } from "../api/media";
import { mediaFileUrl } from "../api/stories";
import { recordAdEvent, getWhyThisAd, type WhyThisAd } from "../api/ads";
import type { SponsoredHomeFeedEntry } from "../api/stories";

const PHOTO_DURATION_MS = 5000;
const SWIPE_THRESHOLD = 100;

interface Props {
  slot: SponsoredHomeFeedEntry;
  /** Swiped/tapped past the end — advance to the next organic entry, exactly where this slide was inserted. */
  onAdvance: () => void;
  /** Swiped back before this slide (only reachable if the previous entry is still around). */
  onGoBack: () => void;
  /** Hidden or reported — remove this slide from the sequence entirely, same as onAdvance but also skips it forever for this viewer (server-enforced via ad_hidden). */
  onDismiss: () => void;
}

/**
 * A Sponsored Story — one full-screen slide, clearly labeled, living inside
 * the same vertical sequence as organic creator Stories (spec sections
 * 26-27) but rendered as its own, separate branch: it never touches
 * StoryFeed's tap-left/right, double-tap-like, or hold-to-pause gesture
 * recognizer (there is no rail of Stories within one ad, no like/comment on
 * an ad), only the same swipe-up/down "move to the next thing" gesture,
 * reimplemented here with its own tiny PanResponder rather than sharing
 * StoryFeed's (which is wired to creator-Story navigation, not this).
 */
export function SponsoredStorySlide({ slot, onAdvance, onGoBack, onDismiss }: Props): React.JSX.Element {
  const { accessToken } = useAuth();
  const [mediaKind, setMediaKind] = useState<"photo" | "video" | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const [whyInfo, setWhyInfo] = useState<WhyThisAd | null>(null);
  const progress = useRef(new Animated.Value(0)).current;
  const shownImpressionRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    if (accessToken) {
      void getMedia(slot.mediaId, accessToken)
        .then((media) => {
          if (!cancelled) setMediaKind(media.kind);
        })
        .catch(() => {
          if (!cancelled) setMediaKind("photo"); // graceful fallback — never a blank/broken slide (spec: graceful ad failure)
        });
    }
    // One real impression event per slide shown, not per render.
    if (accessToken && !shownImpressionRef.current) {
      shownImpressionRef.current = true;
      void recordAdEvent({ campaignId: slot.campaignId, creativeId: slot.creativeId, eventType: "impression" }, accessToken).catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [slot, accessToken]);

  useEffect(() => {
    progress.setValue(0);
    if (mediaKind !== "photo") return; // video auto-advances on its own onEnd
    const anim = Animated.timing(progress, { toValue: 1, duration: PHOTO_DURATION_MS, useNativeDriver: false });
    anim.start(({ finished }) => {
      if (finished) onAdvance();
    });
    return () => anim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaKind]);

  const gesture = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderRelease: (evt, gestureState) => {
        if (gestureState.dy < -SWIPE_THRESHOLD) {
          onAdvance();
          return;
        }
        if (gestureState.dy > SWIPE_THRESHOLD) {
          onGoBack();
          return;
        }
        // A plain tap (not a swipe) also advances — an ad has nothing else to tap into within itself.
        if (Math.abs(gestureState.dx) < 10 && Math.abs(gestureState.dy) < 10) {
          onAdvance();
        }
      },
    }),
  ).current;

  const onOpenCta = () => {
    if (accessToken) {
      void recordAdEvent({ campaignId: slot.campaignId, creativeId: slot.creativeId, eventType: "click" }, accessToken).catch(() => undefined);
    }
    void Linking.openURL(slot.ctaUrl).catch(() => undefined);
  };

  const onHide = async () => {
    setMenuOpen(false);
    if (accessToken) {
      await recordAdEvent({ campaignId: slot.campaignId, creativeId: slot.creativeId, eventType: "hide" }, accessToken).catch(() => undefined);
    }
    onDismiss();
  };

  const onReport = async () => {
    setMenuOpen(false);
    if (accessToken) {
      await recordAdEvent({ campaignId: slot.campaignId, creativeId: slot.creativeId, eventType: "report" }, accessToken).catch(() => undefined);
    }
    onDismiss();
  };

  const onWhyThisAd = async () => {
    setMenuOpen(false);
    if (!accessToken) return;
    void recordAdEvent({ campaignId: slot.campaignId, creativeId: slot.creativeId, eventType: "why_this_ad_open" }, accessToken).catch(() => undefined);
    try {
      const info = await getWhyThisAd(slot.campaignId, accessToken);
      setWhyInfo(info);
      setWhyOpen(true);
    } catch {
      // graceful failure — no crash, no blank screen, just no popup (spec: graceful ad failure)
    }
  };

  const mediaUrl = mediaFileUrl(slot.mediaId);
  const authHeaders = accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined;

  return (
    <View style={styles.container}>
      {mediaKind === "video" ? (
        <Video
          source={{ uri: mediaUrl, headers: authHeaders }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          muted
          onEnd={onAdvance}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.mediaFallback]}>
          <Animated.Image source={{ uri: mediaUrl, headers: authHeaders }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        </View>
      )}

      <View style={styles.gestureLayer} {...gesture.panHandlers} />

      <View style={styles.progressRow}>
        <View style={styles.progressTrack}>
          <Animated.View style={[styles.progressFill, { width: progress.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) }]} />
        </View>
      </View>

      <View style={styles.sponsoredBadge}>
        <Text style={styles.sponsoredBadgeText}>{slot.label}</Text>
      </View>

      <Pressable
        style={styles.menuButton}
        onPress={() => setMenuOpen(true)}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Ad options"
      >
        <Text style={styles.menuIcon}>{ICONS.more}</Text>
      </Pressable>

      <View style={styles.footer}>
        <Text style={styles.headline} numberOfLines={2}>{slot.headline}</Text>
        {slot.bodyText ? (
          <Text style={styles.bodyText} numberOfLines={2}>{slot.bodyText}</Text>
        ) : null}
        <Pressable style={styles.ctaButton} onPress={onOpenCta} accessibilityRole="button" accessibilityLabel={slot.ctaLabel}>
          <Text style={styles.ctaLabel}>{slot.ctaLabel}</Text>
        </Pressable>
      </View>

      <Modal visible={menuOpen} animationType="slide" transparent onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setMenuOpen(false)} accessibilityRole="button" accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Pressable style={styles.sheetRow} onPress={onHide}>
            <Text style={typography.body}>Hide Ad</Text>
          </Pressable>
          <Pressable style={styles.sheetRow} onPress={onReport}>
            <Text style={[typography.body, styles.destructive]}>Report Ad</Text>
          </Pressable>
          <Pressable style={styles.sheetRow} onPress={onWhyThisAd}>
            <Text style={typography.body}>Why am I seeing this?</Text>
          </Pressable>
        </View>
      </Modal>

      <Modal visible={whyOpen} animationType="fade" transparent onRequestClose={() => setWhyOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setWhyOpen(false)} accessibilityRole="button" accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={[typography.body, styles.whyTitle]}>Why you're seeing this ad</Text>
          <Text style={styles.whyLine}>
            {whyInfo && (whyInfo.countries.length || whyInfo.languages.length || whyInfo.interests.length || whyInfo.minAge || whyInfo.maxAge)
              ? [
                  whyInfo.countries.length ? `Countries: ${whyInfo.countries.join(", ")}` : null,
                  whyInfo.languages.length ? `Languages: ${whyInfo.languages.join(", ")}` : null,
                  whyInfo.minAge || whyInfo.maxAge ? `Age: ${whyInfo.minAge ?? "any"}–${whyInfo.maxAge ?? "any"}` : null,
                  whyInfo.interests.length ? `Interests: ${whyInfo.interests.join(", ")}` : null,
                ]
                  .filter(Boolean)
                  .join("\n")
              : "This advertiser is reaching a general audience — no specific targeting is set for this ad."}
          </Text>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  mediaFallback: { backgroundColor: "#111" },
  gestureLayer: { ...StyleSheet.absoluteFillObject },
  progressRow: { position: "absolute", top: spacing.xl, left: spacing.sm, right: spacing.sm },
  progressTrack: { height: 3, borderRadius: radii.pill, backgroundColor: "rgba(255,255,255,0.3)", overflow: "hidden" },
  progressFill: { height: "100%", backgroundColor: colors.textPrimary },
  sponsoredBadge: {
    position: "absolute",
    top: spacing.xl + spacing.md,
    left: spacing.sm,
    backgroundColor: "rgba(0,0,0,0.5)",
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radii.sm,
  },
  sponsoredBadgeText: { color: colors.textPrimary, fontSize: 12, fontWeight: "700" },
  menuButton: { position: "absolute", top: spacing.xl + spacing.md, right: spacing.md },
  menuIcon: { color: colors.textPrimary, fontSize: 20, fontWeight: "700" },
  footer: { position: "absolute", bottom: spacing.xl, left: spacing.md, right: spacing.md },
  headline: { color: colors.textPrimary, fontSize: 18, fontWeight: "700" },
  bodyText: { color: "rgba(255,255,255,0.85)", marginTop: 4 },
  ctaButton: {
    marginTop: spacing.sm,
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    alignItems: "center",
  },
  ctaLabel: { color: "#fff", fontWeight: "700" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)" },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xl,
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: "center", marginVertical: spacing.sm },
  sheetRow: { paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  destructive: { color: colors.danger },
  whyTitle: { fontWeight: "700", marginBottom: spacing.sm },
  whyLine: { color: colors.textSecondary, marginBottom: spacing.lg },
});
