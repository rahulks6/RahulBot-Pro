import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Image, Pressable, SectionList, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/types";
import { colors, radii, spacing, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { deleteStory, getMyArchivedStories, mediaFileUrl, type PublicStory } from "../../api/stories";
import { EmptyState } from "../../components/EmptyState";

type Props = NativeStackScreenProps<RootStackParamList, "Archive">;

const PAGE_SIZE = 60;
const COLUMNS = 3;
const GAP = spacing.xs;
const CONTAINER_PADDING = spacing.md;

interface MonthSection {
  key: string;
  title: string;
  data: PublicStory[][]; // rows of up to COLUMNS stories — SectionList has no numColumns of its own
}

function monthKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}`;
}

function monthTitle(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function groupByMonth(stories: PublicStory[]): MonthSection[] {
  const sections: MonthSection[] = [];
  const byKey = new Map<string, PublicStory[]>();
  for (const story of stories) {
    const key = monthKey(story.createdAt);
    if (!byKey.has(key)) {
      byKey.set(key, []);
      sections.push({ key, title: monthTitle(story.createdAt), data: [] });
    }
    byKey.get(key)!.push(story);
  }
  for (const section of sections) {
    const stories2 = byKey.get(section.key)!;
    const rows: PublicStory[][] = [];
    for (let i = 0; i < stories2.length; i += COLUMNS) rows.push(stories2.slice(i, i + COLUMNS));
    section.data = rows;
  }
  return sections;
}

/**
 * Every Story you've ever published, expired or not (spec: a dedicated
 * private Archive, grouped by month, with multi-select). A plain tap
 * opens full-screen playback (ArchivedStoryViewerScreen — works
 * regardless of expiry, since an owner already bypasses the normal 24h
 * check for their own content); a long-press, or a tap while already
 * mid-selection, toggles selection instead — same convention as a
 * Photos-app picker. Multi-select feeds into creating a Highlight or
 * bulk deletion.
 */
export function ArchiveScreen({ navigation }: Props): React.JSX.Element {
  const { accessToken } = useAuth();
  const { width: screenWidth } = useWindowDimensions();

  const [stories, setStories] = useState<PublicStory[] | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(
    async (nextOffset: number) => {
      if (!accessToken) return;
      const { stories: fetched } = await getMyArchivedStories(accessToken, { limit: PAGE_SIZE, offset: nextOffset });
      setStories((prev) => (nextOffset === 0 ? fetched : [...(prev ?? []), ...fetched]));
      setHasMore(fetched.length === PAGE_SIZE);
      setOffset(nextOffset + fetched.length);
    },
    [accessToken],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  const onEndReached = useCallback(async () => {
    if (loadingMore || !hasMore || !accessToken) return;
    setLoadingMore(true);
    try {
      await load(offset);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, accessToken, load, offset]);

  const sections = useMemo(() => groupByMonth(stories ?? []), [stories]);
  const thumbSize = (screenWidth - CONTAINER_PADDING * 2 - GAP * (COLUMNS - 1)) / COLUMNS;
  const authHeaders = accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined;

  const toggle = (storyId: string) => {
    setSelected((current) => (current.includes(storyId) ? current.filter((id) => id !== storyId) : [...current, storyId]));
  };

  const onCreateHighlight = () => {
    const storyIds = selected;
    setSelected([]);
    navigation.navigate("HighlightEditor", { initialStoryIds: storyIds });
  };

  const onDelete = () => {
    if (selected.length === 0 || !accessToken) return;
    Alert.alert(
      `Delete ${selected.length} ${selected.length === 1 ? "Story" : "Stories"}?`,
      "This can't be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setDeleting(true);
            const ids = selected;
            try {
              await Promise.all(ids.map((id) => deleteStory(id, accessToken)));
              setStories((prev) => (prev ?? []).filter((s) => !ids.includes(s.id)));
              setSelected([]);
            } catch {
              Alert.alert("Some deletions failed", "Try again for the ones that didn't go through.");
            } finally {
              setDeleting(false);
            }
          },
        },
      ],
    );
  };

  if (stories === null) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {stories.length === 0 ? (
        <EmptyState title="Your Archive is empty" message="Every Story you publish stays here, even after it expires." />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(row, index) => `${row[0]?.id ?? index}-row`}
          contentContainerStyle={styles.listContent}
          onEndReachedThreshold={0.4}
          onEndReached={onEndReached}
          ListFooterComponent={loadingMore ? <ActivityIndicator color={colors.accent} style={styles.footerSpinner} /> : null}
          renderSectionHeader={({ section }) => <Text style={styles.sectionHeader}>{section.title}</Text>}
          renderItem={({ item: row }) => (
            <View style={[styles.row, { gap: GAP }]}>
              {row.map((story) => {
                const isSelected = selected.includes(story.id);
                return (
                  <Pressable
                    key={story.id}
                    onPress={() => (selected.length > 0 ? toggle(story.id) : navigation.navigate("ArchivedStoryViewer", { storyId: story.id }))}
                    onLongPress={() => toggle(story.id)}
                    style={[styles.thumbWrapper, { width: thumbSize, height: thumbSize }]}
                  >
                    <Image source={{ uri: mediaFileUrl(story.mediaId), headers: authHeaders }} style={styles.thumb} resizeMode="cover" />
                    {isSelected ? (
                      <View style={styles.selectedOverlay}>
                        <View style={styles.selectedCheck}>
                          <Text style={styles.selectedCheckGlyph}>✓</Text>
                        </View>
                      </View>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          )}
        />
      )}

      {selected.length > 0 ? (
        <View style={styles.actionBar}>
          <Pressable onPress={() => setSelected([])} hitSlop={8}>
            <Text style={styles.actionCancel}>Cancel</Text>
          </Pressable>
          <Text style={typography.caption}>{selected.length} selected</Text>
          <View style={styles.actionButtons}>
            <Pressable onPress={onDelete} disabled={deleting} hitSlop={8} style={styles.actionButton}>
              {deleting ? <ActivityIndicator color={colors.danger} /> : <Text style={styles.actionDelete}>Delete</Text>}
            </Pressable>
            <Pressable onPress={onCreateHighlight} hitSlop={8} style={styles.actionButton}>
              <Text style={styles.actionCreate}>Create Highlight</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background },
  listContent: { paddingHorizontal: CONTAINER_PADDING, paddingBottom: spacing.xxl, paddingTop: spacing.sm },
  sectionHeader: { ...typography.bodyStrong, marginTop: spacing.md, marginBottom: spacing.sm },
  row: { flexDirection: "row", marginBottom: GAP },
  thumbWrapper: { borderRadius: radii.sm, overflow: "hidden", backgroundColor: colors.surfaceElevated },
  thumb: { width: "100%", height: "100%" },
  selectedOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  selectedCheck: {
    width: 28,
    height: 28,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  selectedCheckGlyph: { color: colors.onAccent, fontWeight: "700" },
  footerSpinner: { marginVertical: spacing.md },
  actionBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  actionCancel: { color: colors.textSecondary },
  actionButtons: { flexDirection: "row", gap: spacing.lg },
  actionButton: {},
  actionDelete: { color: colors.danger, fontWeight: "600" },
  actionCreate: { color: colors.accent, fontWeight: "700" },
});
