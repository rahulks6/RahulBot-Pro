import React from "react";
import { Pressable, Text } from "react-native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { DMStackParamList } from "./types";
import { colors, spacing, ICONS } from "../theme";
import { DMInboxScreen } from "../screens/dm/DMInboxScreen";
import { ConversationScreen } from "../screens/dm/ConversationScreen";
import { SendStoryScreen } from "../screens/dm/SendStoryScreen";
import { NewChatScreen } from "../screens/dm/NewChatScreen";

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
      <Stack.Screen
        name="DMInbox"
        component={DMInboxScreen}
        options={({ navigation }) => ({
          title: "Messages",
          headerRight: () => (
            <Pressable
              onPress={() => navigation.navigate("NewChat")}
              hitSlop={8}
              style={{ paddingHorizontal: spacing.xs }}
              accessibilityRole="button"
              accessibilityLabel="New chat"
            >
              <Text style={{ color: colors.textPrimary, fontSize: 20 }}>{ICONS.newChat}</Text>
            </Pressable>
          ),
        })}
      />
      <Stack.Screen name="Conversation" component={ConversationScreen} options={({ route }) => ({ title: route.params.otherDisplayName })} />
      <Stack.Screen name="SendStory" component={SendStoryScreen} options={{ title: "Send to…" }} />
      <Stack.Screen name="NewChat" component={NewChatScreen} options={{ title: "New Chat" }} />
    </Stack.Navigator>
  );
}
