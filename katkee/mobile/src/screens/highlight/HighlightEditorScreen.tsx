import React, { useEffect, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Image, Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/types";
import { colors, radii, spacing, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { getMyArchivedStories, mediaFileUrl, type PublicStory } from "../../api/stories";
import { createHighlight, deleteHighlight, getHighlightDetail, updateHighlight } from "../../api/highlights";
import { ApiError } from "../../api/client";
import { DraggableGrid } from "../../components/DraggableGrid";

type Props = NativeStackScreenProps<RootStackParamList, "HighlightEditor">;

const MAX_TITLE_LENGTH = 30;
const SELECTED_STRIP_COLUMNS = 5;
const SELECTED_STRIP_GAP = spacing.xs;

/**
 * Create (no `highlightId`) or edit (rename/replace items/delete) a
 * Highlight, picking from the Archive — every Story you've ever
 * published, expired or not (`GET /api/v1/stories/mine/archive`), which
 * is exactly the point of an Archive existing at all.
 */
export function HighlightEditorScreen({ route, navigation }: Props): React.JSX.Element {
  const { highlightId, initialStoryIds } = route.params;
  const isEditing = highlightId !== undefined;
  const { accessToken } = useAuth();
  const { width: screenWidth } = useWindowDimensions();

  const [archive, setArchive] = useState<PublicStory[] | null>(null);
  const [title, setTitle] = useState("");
  // Selection order matters (it becomes the Highlight's item order), so this is an ordered array, not a Set.
  const [selected, setSelected] = useState<string[]>(initialStoryIds ?? []);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    (async () => {
      try {
        const [{ stories }, existing] = await Promise.all([
          getMyArchivedStories(accessToken, { limit: 50 }),
          isEditing ? getHighlightDetail(highlightId, accessToken) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setArchive(stories);
        if (existing) {
          setTitle(existing.highlight.title);
          setSelected(existing.highlight.items.map((item) => item.storyId));
        }
      } catch {
        if (!cancelled) setError("Couldn't load your Stories — try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, isEditing, highlightId]);

  const toggle = (storyId: string) => {
    setSelected((current) =>
      current.includes(storyId) ? current.filter((id) => id !== storyId) : [...current, storyId],
    );
  };

  // Selected stories, in current order, as full records — needed to
  // actually render the reorder strip's thumbnails (the archive picker
  // grid below only has ids selected, not full story data).
  const selectedStories = selected
    .map((id) => (archive ?? []).find((s) => s.id === id))
    .filter((s): s is PublicStory => s !== undefined);

  const onReorderSelected = (newOrder: PublicStory[]) => {
    setSelected(newOrder.map((s) => s.id));
  };

  const onSave = async () => {
    if (!accessToken || saving) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle || selected.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      if (isEditing) {
        await updateHighlight(highlightId, { title: trimmedTitle, storyIds: selected }, accessToken);
      } else {
        await createHighlight({ title: trimmedTitle, storyIds: selected }, accessToken);
      }
      navigation.goBack();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't save — try again.");
    } finally {
      setSaving(false);
    }
  };

  const onDelete = () => {
    if (!accessToken || !isEditing) return;
    Alert.alert("Delete Highlight?", "This removes the Highlight — the Stories in it stay in your Archive.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await deleteHighlight(highlightId, accessToken);
            navigation.goBack();
          } catch {
            setError("Couldn't delete — try again.");
          }
        },
      },
    ]);
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const canSave = title.trim().length > 0 && selected.length > 0 && !saving;
  const selectedThumbSize =
    (screenWidth - spacing.md * 2 - SELECTED_STRIP_GAP * (SELECTED_STRIP_COLUMNS - 1)) / SELECTED_STRIP_COLUMNS;

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.titleInput}
        placeholder="Highlight name"
        placeholderTextColor={colors.textDisabled}
        value={title}
        onChangeText={setTitle}
        maxLength={MAX_TITLE_LENGTH}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {selectedStories.length > 0 ? (
        <>
          <Text style={styles.sectionLabel}>Selected, in order — long-press and drag to reorder</Text>
          <View style={styles.selectedStrip}>
            <DraggableGrid
              data={selectedStories}
              keyExtractor={(s) => s.id}
              columns={SELECTED_STRIP_COLUMNS}
              itemWidth={selectedThumbSize}
              itemHeight={selectedThumbSize}
              gap={SELECTED_STRIP_GAP}
              onReorder={onReorderSelected}
              renderItem={(story) => (
                <View style={styles.selectedThumbWrapper}>
                  <Image
                    source={{ uri: mediaFileUrl(story.mediaId), headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined }}
                    style={styles.selectedThumb}
                    resizeMode="cover"
                  />
                  <View style={styles.orderBadge}>
                    <Text style={styles.orderBadgeText}>{selected.indexOf(story.id) + 1}</Text>
                  </View>
                </View>
              )}
            />
          </View>
        </>
      ) : null}

      <Text style={styles.sectionLabel}>Choose from your Archive ({selected.length} selected)</Text>
      <FlatList
        data={archive ?? []}
        numColumns={3}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.grid}
        ListEmptyComponent={<Text style={typography.caption}>No Stories in your Archive yet.</Text>}
        renderItem={({ item }) => {
          const order = selected.indexOf(item.id);
          const isSelected = order !== -1;
          return (
            <Pressable style={styles.thumbWrapper} onPress={() => toggle(item.id)}>
              <Image
                source={{ uri: mediaFileUrl(item.mediaId), headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined }}
                style={[styles.thumb, isSelected && styles.thumbSelected]}
                resizeMode="cover"
              />
              {isSelected ? (
                <View style={styles.orderBadge}>
                  <Text style={styles.orderBadgeText}>{order + 1}</Text>
                </View>
              ) : null}
            </Pressable>
          );
        }}
      />

      <View style={styles.footer}>
        {isEditing ? (
          <Pressable style={styles.deleteButton} onPress={onDelete}>
            <Text style={styles.deleteLabel}>Delete Highlight</Text>
          </Pressable>
        ) : (
          <View />
        )}
        <Pressable style={[styles.saveButton, !canSave && styles.saveButtonDisabled]} disabled={!canSave} onPress={onSave}>
          {saving ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.saveLabel}>{isEditing ? "Save" : "Create"}</Text>}
        </Pressable>
      </View>
    </View>
  );
}

const THUMB_SIZE = 104;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingTop: spacing.md },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background },
  titleInput: {
    marginHorizontal: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontSize: 16,
  },
  error: { color: colors.danger, marginHorizontal: spacing.md, marginTop: spacing.xs },
  sectionLabel: { ...typography.label, marginHorizontal: spacing.md, marginTop: spacing.md, marginBottom: spacing.xs },
  selectedStrip: { paddingHorizontal: spacing.md },
  selectedThumbWrapper: { flex: 1, borderRadius: radii.sm, overflow: "hidden", backgroundColor: colors.surfaceElevated },
  selectedThumb: { width: "100%", height: "100%" },
  grid: { paddingHorizontal: spacing.md, gap: spacing.xs },
  thumbWrapper: { margin: spacing.xs / 2 },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceElevated,
    borderWidth: 2,
    borderColor: "transparent",
  },
  thumbSelected: { borderColor: colors.accent, opacity: 0.85 },
  orderBadge: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  orderBadgeText: { color: colors.onAccent, fontSize: 11, fontWeight: "700" },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  deleteButton: { paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
  deleteLabel: { color: colors.danger, fontWeight: "600" },
  saveButton: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    minWidth: 100,
    alignItems: "center",
  },
  saveButtonDisabled: { opacity: 0.5 },
  saveLabel: { color: colors.onAccent, fontWeight: "700" },
});
