import React from "react";
import { ActivityIndicator, View } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { RootStackParamList } from "./types";
import { colors } from "../theme";
import { useAuth } from "../state/AuthContext";
import { AuthNavigator } from "./AuthNavigator";
import { MainTabs } from "./MainTabs";
import { StoryViewerScreen } from "../screens/story/StoryViewerScreen";
import { HighlightViewerScreen } from "../screens/highlight/HighlightViewerScreen";
import { HighlightEditorScreen } from "../screens/highlight/HighlightEditorScreen";
import { ArchiveScreen } from "../screens/profile/ArchiveScreen";

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * StoryViewer lives at the root, above the tabs, so any screen (Profile,
 * Search results, later Home's story tray) can open it the same way,
 * regardless of which tab's stack it was tapped from.
 */
function SignedInNavigator(): React.JSX.Element {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Main" component={MainTabs} />
      <Stack.Screen name="StoryViewer" component={StoryViewerScreen} options={{ presentation: "fullScreenModal" }} />
      <Stack.Screen name="HighlightViewer" component={HighlightViewerScreen} options={{ presentation: "fullScreenModal" }} />
      <Stack.Screen
        name="HighlightEditor"
        component={HighlightEditorScreen}
        options={({ route }) => ({
          headerShown: true,
          title: route.params.highlightId ? "Edit Highlight" : "New Highlight",
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.textPrimary,
          headerShadowVisible: false,
        })}
      />
      <Stack.Screen
        name="Archive"
        component={ArchiveScreen}
        options={{
          headerShown: true,
          title: "Archive",
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.textPrimary,
          headerShadowVisible: false,
        }}
      />
    </Stack.Navigator>
  );
}

export function RootNavigator(): React.JSX.Element {
  const { status } = useAuth();

  if (status === "loading") {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background }}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  return <NavigationContainer>{status === "signedIn" ? <SignedInNavigator /> : <AuthNavigator />}</NavigationContainer>;
}
