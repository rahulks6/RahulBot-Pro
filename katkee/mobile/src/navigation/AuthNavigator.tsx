import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { AuthStackParamList } from "./types";
import { LoginScreen } from "../screens/auth/LoginScreen";
import { SignupScreen } from "../screens/auth/SignupScreen";

const Stack = createNativeStackNavigator<AuthStackParamList>();

export function AuthNavigator(): React.JSX.Element {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="Signup" component={SignupScreen} />
    </Stack.Navigator>
  );
}
