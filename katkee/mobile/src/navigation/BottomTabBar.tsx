import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { colors, radii, spacing, typography } from "../theme";
import { useNotifications } from "../state/NotificationsContext";

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
  const { unreadCount } = useNotifications();

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

        const showUnreadBadge = route.name === "Activity" && unreadCount > 0;

        return (
          <Pressable
            key={route.key}
            accessibilityRole="button"
            accessibilityState={isFocused ? { selected: true } : {}}
            accessibilityLabel={
              showUnreadBadge
                ? `${options.tabBarAccessibilityLabel ?? label}, ${unreadCount} unread`
                : (options.tabBarAccessibilityLabel ?? label)
            }
            onPress={onPress}
            style={styles.tabItem}
          >
            <View>
              <Text style={[typography.caption, isFocused && styles.labelFocused]}>{label}</Text>
              {showUnreadBadge ? (
                <View style={styles.unreadBadge}>
                  <Text style={styles.unreadBadgeText}>{unreadCount > 99 ? "99+" : unreadCount}</Text>
                </View>
              ) : null}
            </View>
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
  unreadBadge: {
    position: "absolute",
    top: -6,
    right: -14,
    minWidth: 16,
    height: 16,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 3,
  },
  unreadBadgeText: {
    color: colors.onAccent,
    fontSize: 10,
    fontWeight: "700",
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
