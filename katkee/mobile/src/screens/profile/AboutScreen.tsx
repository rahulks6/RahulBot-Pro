import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, spacing, typography } from "../../theme";

// Mirrors package.json's real version — update both together, there's no build-time injection of this in the sandbox.
const APP_VERSION = "1.0.0";

/** Real, minimal About content — version number and the one-line description this project actually has, not filler legal text that doesn't apply. */
export function AboutScreen(): React.JSX.Element {
  return (
    <View style={styles.container}>
      <Text style={[typography.title, styles.name]}>Katkee</Text>
      <Text style={styles.version}>Version {APP_VERSION}</Text>
      <Text style={[typography.body, styles.description]}>A Stories-first social app.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, alignItems: "center", paddingTop: spacing.xxl, paddingHorizontal: spacing.lg, gap: spacing.xs },
  name: {},
  version: { ...typography.caption, color: colors.textSecondary },
  description: { marginTop: spacing.md, textAlign: "center", color: colors.textSecondary },
});
