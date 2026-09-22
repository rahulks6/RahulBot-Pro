import React, { useCallback, useState } from "react";
import { FlatList, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/types";
import { colors, radii, spacing, typography } from "../theme";
import { useAuth } from "../state/AuthContext";
import { listHighlightsForUser, type HighlightSummary } from "../api/highlights";
import { mediaFileUrl } from "../api/stories";

interface Props {
  username: string;
  isOwner: boolean;
}

/**
 * The row of Highlight bubbles under a profile's bio (spec section 35).
 * A Highlight's cover is just its first item's Story media — see
 * migrations/0010_highlights.sql for why there's no separate cover-image
 * upload/crop flow in this pass.
 */
export function HighlightsRow({ username, isOwner }: Props): React.JSX.Element | null {
  const { accessToken } = useAuth();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
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

  if (highlights === null) return null;
  if (highlights.length === 0 && !isOwner) return null;

  const authHeaders = accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined;

  return (
    <FlatList
      style={styles.row}
      contentContainerStyle={styles.content}
      horizontal
      showsHorizontalScrollIndicator={false}
      data={highlights}
      keyExtractor={(item) => item.id}
      ListHeaderComponent={
        isOwner ? (
          <Pressable style={styles.item} onPress={() => navigation.navigate("HighlightEditor", {})}>
            <View style={styles.newBubble}>
              <Text style={styles.newGlyph}>+</Text>
            </View>
            <Text style={styles.label} numberOfLines={1}>
              New
            </Text>
          </Pressable>
        ) : null
      }
      renderItem={({ item }) => (
        <Pressable
          style={styles.item}
          onPress={() => navigation.navigate("HighlightViewer", { highlightId: item.id, title: item.title })}
          onLongPress={() => isOwner && navigation.navigate("HighlightEditor", { highlightId: item.id })}
        >
          <View style={styles.bubble}>
            {item.coverMediaId ? (
              <Image
                source={{ uri: mediaFileUrl(item.coverMediaId), headers: authHeaders }}
                style={styles.coverImage}
                resizeMode="cover"
              />
            ) : (
              <Text style={styles.bubbleInitial}>{item.title.charAt(0).toUpperCase()}</Text>
            )}
          </View>
          <Text style={styles.label} numberOfLines={1}>
            {item.title}
          </Text>
        </Pressable>
      )}
    />
  );
}

const BUBBLE_SIZE = 60;

const styles = StyleSheet.create({
  row: { maxHeight: 90, marginTop: spacing.md, width: "100%" },
  content: { paddingHorizontal: spacing.md, gap: spacing.md },
  item: { alignItems: "center", width: 68, gap: spacing.xs, marginRight: spacing.sm },
  bubble: {
    width: BUBBLE_SIZE,
    height: BUBBLE_SIZE,
    borderRadius: radii.pill,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  coverImage: { width: "100%", height: "100%" },
  bubbleInitial: { color: colors.textPrimary, fontWeight: "700", fontSize: 20 },
  newBubble: {
    width: BUBBLE_SIZE,
    height: BUBBLE_SIZE,
    borderRadius: radii.pill,
    borderWidth: 2,
    borderColor: colors.border,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
  },
  newGlyph: { color: colors.accent, fontSize: 24, fontWeight: "700" },
  label: { ...typography.caption, fontSize: 11, textAlign: "center" },
});
