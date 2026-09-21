import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, spacing, typography } from "../theme";

interface EmptyStateProps {
  title: string;
  message: string;
}

/** Shared empty/not-yet-available state — every screen needs one; see spec section 54. */
export function EmptyState({ title, message }: EmptyStateProps): React.JSX.Element {
  return (
    <View style={styles.container}>
      <Text style={[typography.title, styles.title]}>{title}</Text>
      <Text style={[typography.body, styles.message]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
    backgroundColor: colors.background,
  },
  title: {
    textAlign: "center",
  },
  message: {
    textAlign: "center",
    color: colors.textSecondary,
  },
});
