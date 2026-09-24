import React from "react";
import { StatusBar } from "react-native";
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
    </ErrorBoundary>
  );
}
