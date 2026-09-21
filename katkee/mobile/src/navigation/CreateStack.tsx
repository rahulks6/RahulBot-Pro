import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { CreateStackParamList } from "./types";
import { CameraScreen } from "../screens/create/CameraScreen";
import { StoryEditorScreen } from "../screens/create/StoryEditorScreen";

const Stack = createNativeStackNavigator<CreateStackParamList>();

/** Camera → Story editor (spec sections 17-28, minus Phase 4's publish flow — see StoryEditorScreen). */
export function CreateStack(): React.JSX.Element {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, presentation: "fullScreenModal" }}>
      <Stack.Screen name="Camera" component={CameraScreen} />
      <Stack.Screen name="StoryEditor" component={StoryEditorScreen} />
    </Stack.Navigator>
  );
}
