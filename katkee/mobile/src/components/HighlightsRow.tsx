import React, { useCallback, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/types";
import { colors, radii, spacing, typography } from "../theme";
import { useAuth } from "../state/AuthContext";
import { listHighlightsForUser, reorderHighlights, type HighlightSummary } from "../api/highlights";
import { mediaFileUrl } from "../api/stories";
import { DraggableGrid } from "./DraggableGrid";

interface Props {
  username: string;
  isOwner: boolean;
}

const COLUMNS = 3;
const GAP = spacing.sm;
// Matches the horizontal padding both ProfileScreen and UserProfileScreen
// already apply to their container — this grid has none of its own, so
// its cards need to size against the space that padding actually leaves.
const CONTAINER_PADDING = spacing.lg;
const CARD_ASPECT_RATIO = 1.35; // portrait, not circular — spec section 62

/**
 * The Highlights grid under a profile's bio (spec section 62): EXACTLY 3
 * per row, rectangular/portrait cards — explicitly not circular
 * Instagram-style bubbles, which is how this rendered before. A
 * Highlight's cover is just its first item's Story media — see
 * migrations/0010_highlights.sql for why there's no separate cover-image
 * upload/crop flow in this pass.
 *
 * Your own grid is drag-to-reorder (long-press a card) — someone else's
 * is a plain grid, since only the owner's own order can ever change.
 */
export function HighlightsRow({ username, isOwner }: Props): React.JSX.Element | null {
  const { accessToken } = useAuth();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { width: screenWidth } = useWindowDimensions();
  const [highlights, setHighlights] = useState<HighlightSummary[] | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const { highlights: fetched } = await listHighlightsForUser(username, accessToken);
      setHighlights(fetched);
    } catch {
      setHighlights([]);
    }
  }, [accessToken, username]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onReorder = useCallback(
    (newOrder: HighlightSummary[]) => {
      if (!accessToken) return;
      const previous = highlights;
      setHighlights(newOrder); // optimistic — matches what the grid already visually settled into on drop
      reorderHighlights(
        newOrder.map((h) => h.id),
        accessToken,
      ).catch(() => setHighlights(previous)); // the server's set didn't match (stale list, concurrent edit elsewhere) — fall back to what it actually has
    },
    [accessToken, highlights],
  );

  if (highlights === null) return null;
  if (highlights.length === 0 && !isOwner) return null;

  const authHeaders = accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined;
  const cardWidth = (screenWidth - CONTAINER_PADDING * 2 - GAP * (COLUMNS - 1)) / COLUMNS;
  const cardHeight = cardWidth * CARD_ASPECT_RATIO;

  return (
    <DraggableGrid
      data={highlights}
      keyExtractor={(h) => h.id}
      columns={COLUMNS}
      itemWidth={cardWidth}
      itemHeight={cardHeight}
      gap={GAP}
      startIndex={isOwner ? 1 : 0}
      onReorder={onReorder}
      onPress={(highlight) => navigation.navigate("HighlightViewer", { highlightId: highlight.id, title: highlight.title })}
      leadingChildren={
        isOwner ? (
          <Pressable
            style={[styles.card, styles.newCard, { width: cardWidth, height: cardHeight, left: 0, top: 0 }]}
            onPress={() => navigation.navigate("HighlightEditor", {})}
          >
            <Text style={styles.newGlyph}>+</Text>
            <Text style={styles.newLabel}>New</Text>
          </Pressable>
        ) : null
      }
      renderItem={(highlight) => (
        <View style={styles.card}>
          {highlight.coverMediaId ? (
            <Image
              source={{ uri: mediaFileUrl(highlight.coverMediaId), headers: authHeaders }}
              style={styles.coverImage}
              resizeMode="cover"
            />
          ) : (
            <View style={styles.coverFallback}>
              <Text style={styles.coverFallbackInitial}>{highlight.title.charAt(0).toUpperCase()}</Text>
            </View>
          )}
          <View style={styles.labelScrim}>
            <Text style={styles.label} numberOfLines={2}>
              {highlight.title}
            </Text>
          </View>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    borderRadius: radii.md,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  coverImage: { width: "100%", height: "100%" },
  coverFallback: { flex: 1, alignItems: "center", justifyContent: "center" },
  coverFallbackInitial: { color: colors.textPrimary, fontWeight: "700", fontSize: 28 },
  labelScrim: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xs,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  label: { ...typography.caption, color: colors.textPrimary, fontSize: 11, fontWeight: "700" },
  newCard: {
    position: "absolute",
    borderStyle: "dashed",
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
  },
  newGlyph: { color: colors.accent, fontSize: 28, fontWeight: "700" },
  newLabel: { ...typography.caption, fontSize: 11 },
});
