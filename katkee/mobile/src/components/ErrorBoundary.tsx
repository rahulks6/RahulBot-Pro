import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radii, spacing, typography } from "../theme";
import { reportCrash } from "../crashReporting";

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Top-level crash boundary — a real production app can't ship a blank
 * white screen (or React Native's red-screen dev overlay, which doesn't
 * even show in a release build) as its answer to an unexpected render
 * error. Catches anything React itself would otherwise unmount the whole
 * tree for, reports it (see crashReporting.ts — inert until a real
 * service is wired in), and shows a real, recoverable screen instead.
 *
 * Deliberately does NOT catch errors from event handlers, async code, or
 * effects — React error boundaries never do; those already go through
 * each screen's own try/catch + ApiError handling throughout this app
 * (see api/client.ts's ApiError and the dozens of call sites that catch it).
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    reportCrash(error, { componentStack: info.componentStack ?? undefined });
  }

  private reset = (): void => this.setState({ error: null });

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <View style={styles.container}>
        <Text style={[typography.title, styles.title]}>Something went wrong</Text>
        <Text style={[typography.body, styles.message]}>
          Katkee ran into a problem. Try again — if it keeps happening, restart the app.
        </Text>
        <Pressable style={styles.button} onPress={this.reset}>
          <Text style={styles.buttonLabel}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    backgroundColor: colors.background,
    gap: spacing.md,
  },
  title: { textAlign: "center" },
  message: { textAlign: "center", color: colors.textSecondary },
  button: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    marginTop: spacing.md,
  },
  buttonLabel: { color: colors.onAccent, fontWeight: "700" },
});
