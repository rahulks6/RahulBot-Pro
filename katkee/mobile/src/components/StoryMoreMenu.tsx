import React, { useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radii, spacing, typography } from "../theme";
import { useAuth } from "../state/AuthContext";
import { deleteStory, getViewCount } from "../api/stories";
import { muteUser, blockUser } from "../api/users";
import { recordEvent } from "../api/events";
import { ReportSheet } from "./ReportSheet";

interface Props {
  visible: boolean;
  storyId: string;
  isOwnStory: boolean;
  otherUsername: string | null;
  otherUserId: string | null;
  onClose: () => void;
  onDeleted: () => void;
}

/**
 * More menu (spec section 16). For your own Story: delete, or view its
 * real view count. For someone else's: Not Interested (Phase 6's real
 * exclusion — see backend's creator_not_interested table), Mute, Block,
 * and now Report (Phase 10's real moderation queue — see ReportSheet.tsx).
 */
export function StoryMoreMenu({ visible, storyId, isOwnStory, otherUsername, otherUserId, onClose, onDeleted }: Props): React.JSX.Element {
  const { accessToken } = useAuth();
  const [busy, setBusy] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  const onDelete = () => {
    Alert.alert("Delete this Story?", "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          if (!accessToken) return;
          setBusy(true);
          try {
            await deleteStory(storyId, accessToken);
            onDeleted();
          } catch {
            Alert.alert("Couldn't delete that Story — try again.");
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const onViewInsights = async () => {
    if (!accessToken) return;
    setBusy(true);
    try {
      const { views } = await getViewCount(storyId, accessToken);
      Alert.alert("Insights", `${views} view${views === 1 ? "" : "s"}`);
    } catch {
      Alert.alert("Couldn't load insights.");
    } finally {
      setBusy(false);
      onClose();
    }
  };

  const onNotInterested = async () => {
    if (!accessToken || !otherUserId) return;
    setBusy(true);
    try {
      await recordEvent({ eventType: "not_interested", creatorId: otherUserId }, accessToken);
      onDeleted(); // this creator won't be recommended again — nothing more to show here
    } catch {
      Alert.alert("Couldn't save that — try again.");
    } finally {
      setBusy(false);
    }
  };

  const onMute = async () => {
    if (!accessToken || !otherUsername) return;
    setBusy(true);
    try {
      await muteUser(otherUsername, accessToken);
      Alert.alert(`Muted @${otherUsername}`);
    } catch {
      Alert.alert("Couldn't mute — try again.");
    } finally {
      setBusy(false);
      onClose();
    }
  };

  const onBlock = () => {
    if (!otherUsername) return;
    Alert.alert(`Block @${otherUsername}?`, "They won't be able to see your Stories or profile.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Block",
        style: "destructive",
        onPress: async () => {
          if (!accessToken) return;
          setBusy(true);
          try {
            await blockUser(otherUsername, accessToken);
            onDeleted(); // the story is no longer visible either way — close the viewer
          } catch {
            Alert.alert("Couldn't block — try again.");
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  return (
    <>
      <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          {busy ? (
            <ActivityIndicator color={colors.accent} style={{ marginVertical: spacing.lg }} />
          ) : isOwnStory ? (
            <>
              <Pressable style={styles.row} onPress={onViewInsights}>
                <Text style={typography.body}>View Insights</Text>
              </Pressable>
              <Pressable style={styles.row} onPress={onDelete}>
                <Text style={[typography.body, styles.destructive]}>Delete</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Pressable style={styles.row} onPress={onNotInterested}>
                <Text style={typography.body}>Not Interested</Text>
              </Pressable>
              <Pressable style={styles.row} onPress={onMute}>
                <Text style={typography.body}>Mute @{otherUsername}</Text>
              </Pressable>
              <Pressable style={styles.row} onPress={onBlock}>
                <Text style={[typography.body, styles.destructive]}>Block @{otherUsername}</Text>
              </Pressable>
              <Pressable
                style={styles.row}
                onPress={() => {
                  onClose();
                  setReportOpen(true);
                }}
              >
                <Text style={[typography.body, styles.destructive]}>Report</Text>
              </Pressable>
            </>
          )}
        </View>
      </Modal>
      <ReportSheet visible={reportOpen} targetType="story" targetId={storyId} onClose={() => setReportOpen(false)} />
    </>
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
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: "center", marginVertical: spacing.sm },
  row: { paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  destructive: { color: colors.danger },
});
