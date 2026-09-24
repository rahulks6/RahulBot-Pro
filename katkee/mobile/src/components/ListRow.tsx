import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, spacing, typography } from "../theme";

interface Props {
  label: string;
  icon?: string;
  detail?: string;
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
}

/** One tappable row in a settings-style list — icon, label, optional trailing detail/chevron. */
export function ListRow({ label, icon, detail, destructive, disabled, onPress }: Props): React.JSX.Element {
  return (
    <Pressable
      style={[styles.row, disabled && styles.rowDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {icon ? <Text style={styles.icon}>{icon}</Text> : null}
      <Text style={[typography.body, styles.label, destructive && styles.destructiveLabel]}>{label}</Text>
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      {!destructive ? <Text style={styles.chevron}>›</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowDisabled: { opacity: 0.5 },
  icon: { width: 24, textAlign: "center", marginRight: spacing.sm, color: colors.textSecondary },
  label: { flex: 1 },
  destructiveLabel: { color: colors.danger },
  detail: { ...typography.caption, color: colors.textDisabled, marginRight: spacing.xs },
  chevron: { color: colors.textDisabled, fontSize: 18 },
});
