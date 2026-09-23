import React, { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { colors, radii, spacing, typography } from "../../theme";
import { useAuth } from "../../state/AuthContext";
import { getSequenceInsights, type StoryInsights } from "../../api/stories";
import { EmptyState } from "../../components/EmptyState";

function StatCard({ label, value, hint }: { label: string; value: string; hint: string }): React.JSX.Element {
  return (
    <View style={styles.card}>
      <Text style={styles.cardValue}>{value}</Text>
      <Text style={[typography.bodyStrong, styles.cardLabel]}>{label}</Text>
      <Text style={[typography.caption, styles.cardHint]}>{hint}</Text>
    </View>
  );
}

/**
 * "Per-sequence Insights" (spec): the same stats StoryInsightsSheet shows
 * for one Story, aggregated across every currently-active Story you own —
 * the whole run a viewer swipes through for you in one sitting
 * (StoryFeed.tsx). Reached from your own ProfileScreen. No viewer-identity
 * list here — that's real per-Story (StoryInsightsSheet), and an
 * aggregate cross-Story identity list is a genuinely separate feature
 * this pass doesn't add.
 */
export function SequenceInsightsScreen(): React.JSX.Element {
  const { accessToken } = useAuth();
  const [insights, setInsights] = useState<StoryInsights | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    getSequenceInsights(accessToken)
      .then(({ insights: fetched }) => {
        if (!cancelled) setInsights(fetched);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load Insights — try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  if (error) {
    return <EmptyState title="Couldn't load Insights" message={error} />;
  }

  if (insights === null) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (insights.viewCount === 0) {
    return (
      <EmptyState
        title="No views yet"
        message="Once people watch your active Stories, Insights for the whole run will show up here."
      />
    );
  }

  return (
    <View style={styles.container}>
      <Text style={[typography.caption, styles.subtitle]}>
        Across every Story you have active right now
      </Text>
      <View style={styles.grid}>
        <StatCard label="Views" value={String(insights.viewCount)} hint="People who watched at least one" />
        <StatCard label="Completed" value={`${insights.completionRate}%`} hint="Watched through to the end" />
        <StatCard label="Following" value={`${insights.followingViewRate}%`} hint="Already followed you" />
        <StatCard label="Discovery" value={`${insights.discoveryViewRate}%`} hint="Found you through Katkee" />
        <StatCard label="Profile visits" value={`${insights.profileVisitRate}%`} hint="Also visited your profile" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: spacing.md },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background },
  subtitle: { marginBottom: spacing.md },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  card: {
    width: "47%",
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 2,
  },
  cardValue: { color: colors.accent, fontSize: 28, fontWeight: "700" },
  cardLabel: { marginTop: spacing.xs },
  cardHint: { color: colors.textDisabled },
});
