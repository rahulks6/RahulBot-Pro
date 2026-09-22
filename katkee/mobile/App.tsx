import React from "react";
import { StatusBar } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "./src/state/AuthContext";
import { NotificationsProvider } from "./src/state/NotificationsContext";
import { DMProvider } from "./src/state/DMContext";
import { RootNavigator } from "./src/navigation/RootNavigator";
import { ErrorBoundary } from "./src/components/ErrorBoundary";

export default function App(): React.JSX.Element {
  return (
    // ErrorBoundary is outermost so it can catch a crash even from
    // AuthProvider/the providers below it, not just from screens.
    <ErrorBoundary>
      {/* Required at the root by react-native-gesture-handler (used for the
          Story editor's pinch-to-resize gesture) — see its own setup docs. */}
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <StatusBar barStyle="light-content" />
          <AuthProvider>
            <NotificationsProvider>
              <DMProvider>
                <RootNavigator />
              </DMProvider>
            </NotificationsProvider>
          </AuthProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
