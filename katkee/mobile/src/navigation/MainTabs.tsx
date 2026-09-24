import React from "react";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import type { MainTabParamList } from "./types";
import { BottomTabBar } from "./BottomTabBar";
import { HomeScreen } from "../screens/home/HomeScreen";
import { SearchStack } from "./SearchStack";
import { CreateStack } from "./CreateStack";
import { ActivityScreen } from "../screens/activity/ActivityScreen";
import { DMStack } from "./DMStack";
import { ProfileScreen } from "../screens/profile/ProfileScreen";

const Tab = createBottomTabNavigator<MainTabParamList>();

/** HOME | SEARCH | + | ACTIVITY | DM | PROFILE — exactly 6 items, no Discover tab. */
export function MainTabs(): React.JSX.Element {
  return (
    <Tab.Navigator
      screenOptions={{ headerShown: false }}
      tabBar={(props) => <BottomTabBar {...props} />}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Search" component={SearchStack} />
      <Tab.Screen name="Create" component={CreateStack} />
      <Tab.Screen name="Activity" component={ActivityScreen} />
      <Tab.Screen name="DM" component={DMStack} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}
