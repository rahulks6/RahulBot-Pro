/**
 * Pure scoring math for Phase 6's ranking (spec sections 7-11). There is
 * no trained model here and no training data to train one on — this is a
 * deterministic, documented heuristic over real counted signals, exactly
 * what spec section 7 calls "configurable starting weights, NOT
 * hard-coded permanent truth." Every function is pure and independently
 * testable; recommendation.service.ts is the only place that calls them
 * with real repository data.
 */

/**
 * Bayesian smoothing (spec section 11): pulls a rate with few observations
 * toward `priorRate` so one lucky (or unlucky) early viewer can't send a
 * new creator's score to an extreme. `priorWeight` is "how many
 * observations the prior is worth" — higher means new creators lean on
 * the platform-wide average longer before their own data takes over.
 */
export function bayesianSmooth(observedSuccesses: number, observedTotal: number, priorRate: number, priorWeight: number): number {
  return (observedSuccesses + priorRate * priorWeight) / (observedTotal + priorWeight);
}

/**
 * Freshness (spec section 10): 1.0 for a just-published Story, decaying
 * linearly to a floor as it approaches its own expiry — a Story about to
 * expire shouldn't rank alongside one just posted, but it should never
 * hit zero and vanish from scoring before it actually expires (expiry
 * itself is what removes it from candidates, in recommendation.repository.ts).
 */
export function freshness(createdAt: Date, expiresAt: Date, now: Date = new Date()): number {
  const totalMs = expiresAt.getTime() - createdAt.getTime();
  if (totalMs <= 0) return FRESHNESS_FLOOR;
  const elapsedMs = now.getTime() - createdAt.getTime();
  const remainingFraction = 1 - Math.min(Math.max(elapsedMs / totalMs, 0), 1);
  return FRESHNESS_FLOOR + (1 - FRESHNESS_FLOOR) * remainingFraction;
}
const FRESHNESS_FLOOR = 0.3;

/**
 * Exploration multiplier (spec section 11's progressive distribution —
 * "do not publicly promise those numbers," so these thresholds are
 * internal tuning constants, not a claim to surface anywhere). A creator
 * with very few lifetime impressions gets a strong boost so they have a
 * real chance to be seen at all; the boost fades as they accumulate a
 * track record, converging to no boost (1.0) rather than ever penalizing
 * established creators.
 */
export function explorationMultiplier(lifetimeImpressions: number): number {
  if (lifetimeImpressions < 20) return 3.0;
  if (lifetimeImpressions < 100) return 2.0;
  if (lifetimeImpressions < 500) return 1.3;
  if (lifetimeImpressions < 2000) return 1.1;
  return 1.0;
}

export interface AffinitySignals {
  isFollowing: boolean;
  profileVisits: number;
  meaningfulReplies: number; // comments — spec's "meaningful reply"
  distinctEngagementDays: number; // spec section 9: did they come back on a different day
  qualifiedViews: number;
  storyCompletions: number;
  sequenceContinuations: number;
  impressions: number; // denominator for the rate-based signals below
}

/**
 * Viewer→creator affinity (spec section 7's initial weights, section 10's
 * FinalScore component). Each signal is converted to a 0..1 rate (bounded
 * by impressions, i.e. opportunities to have shown that signal) and
 * combined by the spec's own starting percentages. `isFollowing` and
 * repeat visits are treated as strong standalone boosts on top, per
 * sections 8-9 ("voluntary repeat creator visit = extremely strong
 * positive"; follow is "very strong positive").
 */
export function creatorAffinity(signals: AffinitySignals): number {
  const opportunities = Math.max(signals.impressions, 1);
  const qualifiedWatchRate = Math.min(signals.qualifiedViews / opportunities, 1);
  const completionRate = Math.min(signals.storyCompletions / opportunities, 1);
  const sequenceRate = Math.min(signals.sequenceContinuations / opportunities, 1);
  const profileVisitRate = Math.min(signals.profileVisits / opportunities, 1);
  const replyRate = Math.min(signals.meaningfulReplies / opportunities, 1);
  const repeatVisitRate = Math.min(signals.distinctEngagementDays / 7, 1); // "came back on a different day" up to once a day over a week

  const weighted =
    0.1 * qualifiedWatchRate +
    0.1 * completionRate +
    0.1 * sequenceRate +
    0.1 * profileVisitRate +
    0.2 * (signals.isFollowing ? 1 : 0) +
    0.2 * replyRate +
    0.2 * repeatVisitRate;

  // Floor above zero: even a stranger's public Story should be rankable,
  // just low — a hard zero would make FinalScore's multiplication collapse
  // the whole candidate regardless of how good the Story itself is.
  return Math.max(weighted, 0.05);
}

export interface StoryQualitySignals {
  likeCount: number;
  commentCount: number;
  shareCount: number;
  viewCount: number;
}

/**
 * Story-level quality (spec section 10), independent of who's looking —
 * a weighted, view-count-normalized engagement rate, Bayesian-smoothed so
 * a Story with 2 views and 1 like doesn't outscore one with 500 views and
 * 80 likes. Weights follow spec section 8's relative signal strength
 * (share > comment > like).
 */
export function storyQuality(signals: StoryQualitySignals): number {
  const engagementScore = signals.likeCount * 1 + signals.commentCount * 2 + signals.shareCount * 3;
  const maxPossiblePerView = 3; // a view that also shared is the strongest single-view outcome
  const rate = engagementScore / Math.max(signals.viewCount, 1) / maxPossiblePerView;
  const smoothed = bayesianSmooth(rate * signals.viewCount, signals.viewCount, 0.05, 10);
  return Math.min(Math.max(smoothed, 0.05), 1);
}
