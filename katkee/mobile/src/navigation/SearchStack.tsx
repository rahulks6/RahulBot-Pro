import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { SearchStackParamList } from "./types";
import { colors } from "../theme";
import { SearchScreen } from "../screens/search/SearchScreen";
import { UserProfileScreen } from "../screens/profile/UserProfileScreen";

const Stack = createNativeStackNavigator<SearchStackParamList>();

export function SearchStack(): React.JSX.Element {
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.textPrimary,
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen name="SearchHome" component={SearchScreen} options={{ title: "Search" }} />
      <Stack.Screen name="UserProfile" component={UserProfileScreen} options={{ title: "" }} />
    </Stack.Navigator>
  );
}
