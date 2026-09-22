import React, { useState } from "react";
import { Alert, Modal, Pressable, Share, StyleSheet, Text, View } from "react-native";
import Clipboard from "@react-native-clipboard/clipboard";
import { colors, radii, spacing, typography } from "../theme";
import { useAuth } from "../state/AuthContext";
import { shareStory } from "../api/engagement";

interface Props {
  visible: boolean;
  storyId: string;
  ownerUsername: string;
  isPublic: boolean;
  onClose: () => void;
}

/**
 * Share bottom sheet (spec section 15). "Send to Katkee user" needs DMs
 * (Phase 8) and isn't here yet. What is real: a native OS share sheet via
 * React Native's built-in `Share` API, and "Copy link" — offered only for
 * public Stories, never for followers-only ones, so sharing can't leak
 * private content (spec: "Sharing must NEVER bypass Story privacy"). Both
 * record the real `POST /api/v1/stories/:id/share` analytics event first.
 *
 * The copied/shared link is a `katkee://` deep link. It will open the app
 * on a device that has Universal Links (iOS) / App Links (Android)
 * configured for this scheme — that native configuration doesn't exist
 * yet, so the link is correct but inert until it does.
 */
export function ShareSheet({ visible, storyId, ownerUsername, isPublic, onClose }: Props): React.JSX.Element {
  const { accessToken } = useAuth();
  const [busy, setBusy] = useState(false);

  const deepLink = `katkee://story/${storyId}`;

  const recordShare = async () => {
    if (!accessToken) return;
    try {
      await shareStory(storyId, accessToken);
    } catch {
      // Sharing still proceeds locally even if the analytics call fails.
    }
  };

  const onCopyLink = async () => {
    setBusy(true);
    await recordShare();
    Clipboard.setString(deepLink);
    setBusy(false);
    onClose();
    Alert.alert("Link copied");
  };

  const onNativeShare = async () => {
    setBusy(true);
    await recordShare();
    try {
      await Share.share({ message: `@${ownerUsername} on Katkee: ${deepLink}` });
    } catch {
      // User cancelled the native sheet — not an error.
    }
    setBusy(false);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <Pressable style={styles.row} disabled={busy} onPress={onNativeShare}>
          <Text style={typography.body}>Share via…</Text>
        </Pressable>
        {isPublic ? (
          <Pressable style={styles.row} disabled={busy} onPress={onCopyLink}>
            <Text style={typography.body}>Copy link</Text>
          </Pressable>
        ) : (
          <Text style={[typography.caption, styles.note]}>
            Copying a link is only available for public Stories.
          </Text>
        )}
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
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: "center", marginVertical: spacing.sm },
  row: { paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  note: { paddingVertical: spacing.md, textAlign: "center" },
});
