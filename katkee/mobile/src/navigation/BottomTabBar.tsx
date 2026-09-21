import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { colors, radii, spacing, typography } from "../theme";

const TAB_LABELS: Record<string, string> = {
  Home: "Home",
  Search: "Search",
  Create: "",
  Activity: "Activity",
  DM: "DM",
  Profile: "Profile",
};

/**
 * Custom bottom tab bar: HOME | SEARCH | + | ACTIVITY | DM | PROFILE, with
 * the center Create button raised and rendered in Katkee amber so it reads
 * immediately as the primary action, not a 7th equal tab.
 */
export function BottomTabBar({ state, descriptors, navigation }: BottomTabBarProps): React.JSX.Element {
  return (
    <View style={styles.container}>
      {state.routes.map((route, index) => {
        const { options } = descriptors[route.key];
        const isFocused = state.index === index;
        const label = TAB_LABELS[route.name] ?? route.name;

        const onPress = () => {
          const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
          if (!isFocused && !event.defaultPrevented) {
            navigation.navigate(route.name);
          }
        };

        if (route.name === "Create") {
          return (
            <Pressable
              key={route.key}
              accessibilityRole="button"
              accessibilityLabel="Create a Story"
              onPress={onPress}
              style={styles.createButtonWrapper}
            >
              <View style={styles.createButton}>
                <Text style={styles.createButtonGlyph}>+</Text>
              </View>
            </Pressable>
          );
        }

        return (
          <Pressable
            key={route.key}
            accessibilityRole="button"
            accessibilityState={isFocused ? { selected: true } : {}}
            accessibilityLabel={options.tabBarAccessibilityLabel ?? label}
            onPress={onPress}
            style={styles.tabItem}
          >
            <Text style={[typography.caption, isFocused && styles.labelFocused]}>{label}</Text>
            {isFocused ? <View style={styles.focusDot} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingBottom: spacing.sm,
    paddingTop: spacing.xs,
  },
  tabItem: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    paddingVertical: spacing.xs,
  },
  labelFocused: {
    color: colors.accent,
    fontWeight: "700",
  },
  focusDot: {
    width: 4,
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
  },
  createButtonWrapper: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    marginTop: -spacing.lg,
  },
  createButton: {
    width: 56,
    height: 56,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: colors.accent,
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  createButtonGlyph: {
    fontSize: 30,
    fontWeight: "700",
    color: colors.onAccent,
    lineHeight: 32,
  },
});
