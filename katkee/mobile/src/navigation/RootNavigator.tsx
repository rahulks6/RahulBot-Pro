import React from "react";
import { ActivityIndicator, View } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { colors } from "../theme";
import { useAuth } from "../state/AuthContext";
import { AuthNavigator } from "./AuthNavigator";
import { MainTabs } from "./MainTabs";

export function RootNavigator(): React.JSX.Element {
  const { status } = useAuth();

  if (status === "loading") {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background }}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  return (
    <NavigationContainer>
      {status === "signedIn" ? <MainTabs /> : <AuthNavigator />}
    </NavigationContainer>
  );
}
