import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { DMStackParamList } from "./types";
import { colors } from "../theme";
import { DMInboxScreen } from "../screens/dm/DMInboxScreen";
import { ConversationScreen } from "../screens/dm/ConversationScreen";
import { SendStoryScreen } from "../screens/dm/SendStoryScreen";

const Stack = createNativeStackNavigator<DMStackParamList>();

export function DMStack(): React.JSX.Element {
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.textPrimary,
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen name="DMInbox" component={DMInboxScreen} options={{ title: "Messages" }} />
      <Stack.Screen name="Conversation" component={ConversationScreen} options={({ route }) => ({ title: route.params.otherDisplayName })} />
      <Stack.Screen name="SendStory" component={SendStoryScreen} options={{ title: "Send to…" }} />
    </Stack.Navigator>
  );
}
