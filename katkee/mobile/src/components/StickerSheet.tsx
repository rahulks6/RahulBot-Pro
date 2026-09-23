import React, { useState } from "react";
import { ActivityIndicator, FlatList, Modal, PermissionsAndroid, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Geolocation from "@react-native-community/geolocation";
import { colors, radii, spacing, typography } from "../theme";
import { useAuth } from "../state/AuthContext";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { searchUsers, type SearchResult } from "../api/users";
import { STICKER_GLYPHS } from "./OverlayBody";
import {
  STICKER_IDS,
  type EmojiOverlayProperties,
  type MentionOverlayProperties,
  type LocationOverlayProperties,
  type DateTimeOverlayProperties,
  type StickerOverlayProperties,
} from "../models/storyDraft";

type Tab = "emoji" | "mention" | "location" | "datetime" | "stickers";

const TABS: { key: Tab; label: string }[] = [
  { key: "emoji", label: "Emoji" },
  { key: "mention", label: "Mention" },
  { key: "location", label: "Location" },
  { key: "datetime", label: "Date/Time" },
  { key: "stickers", label: "Stickers" },
];

const STICKER_NAMES: Record<string, string> = {
  spark: "Spark",
  "heart-line": "Heart outline",
  "star-outline": "Star outline",
  wave: "Wave",
  flame: "Flame",
  confetti: "Confetti",
  ring: "Ring",
  bolt: "Bolt",
};

const EMOJI_SET = ["😀", "😂", "😍", "🔥", "🎉", "❤️", "👏", "😢", "😎", "🥳", "👀", "✨", "💯", "🙌", "😮", "🤔", "😴", "🙏", "💪", "😅", "🤩", "😭", "👍", "🎂"];

export type StickerAddPayload =
  | { type: "emoji"; properties: EmojiOverlayProperties }
  | { type: "mention"; properties: MentionOverlayProperties }
  | { type: "location"; properties: LocationOverlayProperties }
  | { type: "datetime"; properties: DateTimeOverlayProperties }
  | { type: "sticker"; properties: StickerOverlayProperties };

interface Props {
  visible: boolean;
  onClose: () => void;
  onAdd: (payload: StickerAddPayload) => void;
}

/**
 * Everything except text (spec section 22): Emoji, Mention, Location,
 * Date, Time, and Katkee's own original stickers — no music tab, no song
 * search, nothing that resembles one (spec section 53's exhaustive "NO
 * MUSIC"). Each selection becomes a regular canvas object via the same
 * `onAdd` → DraggableCanvasObject path text already uses; this sheet only
 * ever hands back type-specific `properties`, never geometry.
 */
export function StickerSheet({ visible, onClose, onAdd }: Props): React.JSX.Element {
  const { accessToken } = useAuth();
  const [tab, setTab] = useState<Tab>("emoji");
  const [mentionQuery, setMentionQuery] = useState("");
  const debouncedMentionQuery = useDebouncedValue(mentionQuery, 300);
  const [mentionResults, setMentionResults] = useState<SearchResult[]>([]);
  const [mentionSearching, setMentionSearching] = useState(false);
  const [locationLabel, setLocationLabel] = useState("");
  const [locatingDevice, setLocatingDevice] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  React.useEffect(() => {
    if (!visible || tab !== "mention" || !accessToken || debouncedMentionQuery.trim().length < 2) {
      setMentionResults([]);
      return;
    }
    let cancelled = false;
    setMentionSearching(true);
    searchUsers(debouncedMentionQuery.trim(), accessToken)
      .then(({ results }) => {
        if (!cancelled) setMentionResults(results);
      })
      .catch(() => {
        if (!cancelled) setMentionResults([]);
      })
      .finally(() => {
        if (!cancelled) setMentionSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, tab, accessToken, debouncedMentionQuery]);

  const close = () => {
    setMentionQuery("");
    setMentionResults([]);
    setLocationLabel("");
    setLocationError(null);
    onClose();
  };

  const addEmoji = (emoji: string) => {
    onAdd({ type: "emoji", properties: { emoji } });
    close();
  };

  const addMention = (user: SearchResult) => {
    onAdd({ type: "mention", properties: { userId: user.id, username: user.username, displayName: user.displayName } });
    close();
  };

  const addLocation = () => {
    const label = locationLabel.trim();
    if (!label) return;
    onAdd({ type: "location", properties: { label } });
    close();
  };

  // Device location is only ever requested here, in direct response to
  // this explicit tap (spec section 31) — never on the editor simply
  // opening, and never silently. There's no reverse-geocoding service
  // configured in this sandbox (no Maps/Places API key), so the result is
  // a coarse, rounded coordinate label the user can edit or discard before
  // it's ever added to the Story — never the raw, full-precision reading.
  const useCurrentLocation = async () => {
    setLocationError(null);
    setLocatingDevice(true);
    try {
      if (Platform.OS === "android") {
        const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          setLocationError("Location permission denied.");
          setLocatingDevice(false);
          return;
        }
      }
      Geolocation.getCurrentPosition(
        (position) => {
          const lat = position.coords.latitude.toFixed(2);
          const lng = position.coords.longitude.toFixed(2);
          setLocationLabel(`Near ${lat}, ${lng}`);
          setLocatingDevice(false);
        },
        () => {
          setLocationError("Couldn't get your location.");
          setLocatingDevice(false);
        },
        { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 },
      );
    } catch {
      setLocationError("Location isn't available on this device.");
      setLocatingDevice(false);
    }
  };

  const addDateTime = (mode: "date" | "time") => {
    const now = new Date();
    const display = mode === "date" ? now.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    onAdd({ type: "datetime", properties: { mode, value: now.toISOString(), display } });
    close();
  };

  const addSticker = (stickerId: (typeof STICKER_IDS)[number]) => {
    onAdd({ type: "sticker", properties: { stickerId } });
    close();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close} accessibilityRole="button" accessibilityLabel="Close" />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.tabRow}>
          {TABS.map((t) => (
            <Pressable
              key={t.key}
              onPress={() => setTab(t.key)}
              style={[styles.tab, tab === t.key && styles.tabActive]}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === t.key }}
            >
              <Text style={[styles.tabLabel, tab === t.key && styles.tabLabelActive]}>{t.label}</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.body}>
          {tab === "emoji" ? (
            <FlatList
              data={EMOJI_SET}
              keyExtractor={(e) => e}
              numColumns={6}
              renderItem={({ item }) => (
                <Pressable style={styles.emojiCell} onPress={() => addEmoji(item)} accessibilityRole="button" accessibilityLabel={`Add ${item} emoji`}>
                  <Text style={styles.emojiGlyph}>{item}</Text>
                </Pressable>
              )}
            />
          ) : null}

          {tab === "mention" ? (
            <View>
              <TextInput
                style={styles.input}
                placeholder="Search people…"
                placeholderTextColor={colors.textDisabled}
                value={mentionQuery}
                onChangeText={setMentionQuery}
                autoFocus
              />
              {mentionSearching ? <ActivityIndicator color={colors.accent} style={styles.spinner} /> : null}
              <FlatList
                data={mentionResults}
                keyExtractor={(u) => u.id}
                renderItem={({ item }) => (
                  <Pressable
                    style={styles.resultRow}
                    onPress={() => addMention(item)}
                    accessibilityRole="button"
                    accessibilityLabel={`Mention ${item.displayName}, @${item.username}`}
                  >
                    <Text style={typography.body}>{item.displayName}</Text>
                    <Text style={styles.resultUsername}>@{item.username}</Text>
                  </Pressable>
                )}
                ListEmptyComponent={
                  debouncedMentionQuery.trim().length >= 2 && !mentionSearching ? (
                    <Text style={styles.emptyText}>No one found.</Text>
                  ) : null
                }
              />
            </View>
          ) : null}

          {tab === "location" ? (
            <View>
              <TextInput
                style={styles.input}
                placeholder="Add a location…"
                placeholderTextColor={colors.textDisabled}
                value={locationLabel}
                onChangeText={setLocationLabel}
              />
              <Pressable style={styles.secondaryButton} onPress={useCurrentLocation} disabled={locatingDevice}>
                {locatingDevice ? <ActivityIndicator color={colors.accent} /> : <Text style={styles.secondaryButtonLabel}>Use current location</Text>}
              </Pressable>
              {locationError ? <Text style={styles.errorText}>{locationError}</Text> : null}
              <Pressable style={[styles.primaryButton, !locationLabel.trim() && styles.primaryButtonDisabled]} disabled={!locationLabel.trim()} onPress={addLocation}>
                <Text style={styles.primaryButtonLabel}>Add</Text>
              </Pressable>
            </View>
          ) : null}

          {tab === "datetime" ? (
            <View style={styles.dateTimeRow}>
              <Pressable style={styles.primaryButton} onPress={() => addDateTime("date")}>
                <Text style={styles.primaryButtonLabel}>Add today's date</Text>
              </Pressable>
              <Pressable style={styles.primaryButton} onPress={() => addDateTime("time")}>
                <Text style={styles.primaryButtonLabel}>Add current time</Text>
              </Pressable>
            </View>
          ) : null}

          {tab === "stickers" ? (
            <FlatList
              data={STICKER_IDS}
              keyExtractor={(s) => s}
              numColumns={4}
              renderItem={({ item }) => (
                <Pressable
                  style={styles.stickerCell}
                  onPress={() => addSticker(item)}
                  accessibilityRole="button"
                  accessibilityLabel={`Add ${STICKER_NAMES[item] ?? "sticker"}`}
                >
                  <Text style={styles.stickerGlyph}>{STICKER_GLYPHS[item]}</Text>
                </Pressable>
              )}
            />
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)" },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xl,
    maxHeight: "70%",
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: "center", marginVertical: spacing.sm },
  tabRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginBottom: spacing.sm },
  tab: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 6 },
  tabActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  tabLabel: { color: colors.textSecondary, fontSize: 12 },
  tabLabelActive: { color: colors.onAccent, fontWeight: "700" },
  body: { minHeight: 220 },
  emojiCell: { flex: 1 / 6, aspectRatio: 1, alignItems: "center", justifyContent: "center" },
  emojiGlyph: { fontSize: 26 },
  stickerCell: { flex: 1 / 4, aspectRatio: 1, alignItems: "center", justifyContent: "center" },
  stickerGlyph: { fontSize: 30, color: colors.accent },
  input: {
    color: colors.textPrimary,
    backgroundColor: colors.surfaceElevated,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.sm,
  },
  spinner: { marginVertical: spacing.sm },
  resultRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  resultUsername: { color: colors.textSecondary, fontSize: 12 },
  emptyText: { color: colors.textSecondary, textAlign: "center", marginTop: spacing.md },
  secondaryButton: { paddingVertical: spacing.sm, alignItems: "center" },
  secondaryButtonLabel: { color: colors.accent, fontWeight: "600" },
  errorText: { color: colors.danger, textAlign: "center", marginBottom: spacing.xs },
  primaryButton: { backgroundColor: colors.accent, borderRadius: radii.md, paddingVertical: spacing.sm, alignItems: "center", marginTop: spacing.xs },
  primaryButtonDisabled: { opacity: 0.5 },
  primaryButtonLabel: { color: colors.onAccent, fontWeight: "700" },
  dateTimeRow: { gap: spacing.sm },
});
