import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { colors, radii, spacing, typography, ICONS } from "../theme";
import { useNotifications } from "../state/NotificationsContext";
import { useDM } from "../state/DMContext";

const TAB_LABELS: Record<string, string> = {
  Home: "Home",
  Search: "Search",
  Create: "",
  Activity: "Activity",
  DM: "DM",
  Profile: "Profile",
};

const TAB_ICONS: Record<string, string> = {
  Home: ICONS.home,
  Search: ICONS.search,
  Activity: ICONS.activity,
  DM: ICONS.dm,
  Profile: ICONS.profile,
};

/**
 * Custom bottom tab bar: HOME | SEARCH | + | ACTIVITY | DM | PROFILE, with
 * the center Create button raised and rendered in Katkee amber so it reads
 * immediately as the primary action, not a 7th equal tab.
 */
export function BottomTabBar({ state, descriptors, navigation }: BottomTabBarProps): React.JSX.Element {
  const { unreadCount: unreadNotifications } = useNotifications();
  const { unreadCount: unreadMessages } = useDM();

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
                <Text style={styles.createButtonGlyph}>{ICONS.create}</Text>
              </View>
            </Pressable>
          );
        }

        const badgeCount = route.name === "Activity" ? unreadNotifications : route.name === "DM" ? unreadMessages : 0;
        const showUnreadBadge = badgeCount > 0;

        return (
          <Pressable
            key={route.key}
            accessibilityRole="button"
            accessibilityState={isFocused ? { selected: true } : {}}
            accessibilityLabel={
              showUnreadBadge
                ? `${options.tabBarAccessibilityLabel ?? label}, ${badgeCount} unread`
                : (options.tabBarAccessibilityLabel ?? label)
            }
            onPress={onPress}
            style={styles.tabItem}
          >
            <View style={styles.tabContent}>
              <Text style={[styles.tabIcon, isFocused && styles.labelFocused]}>{TAB_ICONS[route.name] ?? ""}</Text>
              {showUnreadBadge ? (
                <View style={styles.unreadBadge}>
                  <Text style={styles.unreadBadgeText}>{badgeCount > 99 ? "99+" : badgeCount}</Text>
                </View>
              ) : null}
            </View>
            <Text style={[typography.caption, styles.tabLabel, isFocused && styles.labelFocused]}>{label}</Text>
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
    gap: 2,
    paddingVertical: spacing.xs,
  },
  tabContent: { alignItems: "center", justifyContent: "center" },
  tabIcon: { fontSize: 22, color: colors.textSecondary },
  tabLabel: { color: colors.textSecondary, fontSize: 11 },
  labelFocused: {
    color: colors.accent,
    fontWeight: "700",
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
