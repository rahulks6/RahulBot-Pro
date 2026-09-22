import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bayesianSmooth, creatorAffinity, explorationMultiplier, freshness, storyQuality } from "../src/modules/recommendations/scoring";

describe("bayesianSmooth", () => {
  it("pulls a small sample toward the prior", () => {
    // 1 success out of 1 observation would naively be a 100% rate — smoothing must pull it well below that.
    const smoothed = bayesianSmooth(1, 1, 0.1, 10);
    assert.ok(smoothed < 0.3, `expected a heavily-smoothed low rate, got ${smoothed}`);
    assert.ok(smoothed > 0.1, "should still be pulled up somewhat by the one real success");
  });

  it("converges to the true rate as observations grow", () => {
    const smoothed = bayesianSmooth(500, 1000, 0.1, 10);
    assert.ok(Math.abs(smoothed - 0.5) < 0.02, `expected close to the observed 0.5 rate, got ${smoothed}`);
  });

  it("returns exactly the prior with zero observations", () => {
    assert.equal(bayesianSmooth(0, 0, 0.2, 10), 0.2);
  });
});

describe("freshness", () => {
  it("is 1.0 for a Story published this instant", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const createdAt = new Date("2026-01-01T12:00:00Z");
    const expiresAt = new Date("2026-01-02T12:00:00Z");
    assert.equal(freshness(createdAt, expiresAt, now), 1);
  });

  it("decays toward the floor as expiry approaches, never reaching zero", () => {
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const expiresAt = new Date("2026-01-02T00:00:00Z");
    const almostExpired = new Date("2026-01-01T23:59:00Z");
    const score = freshness(createdAt, expiresAt, almostExpired);
    assert.ok(score > 0, "must never hit zero — expiry itself removes the Story from candidates");
    assert.ok(score < 0.35, `expected close to the floor, got ${score}`);
  });

  it("is monotonically decreasing over time", () => {
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const expiresAt = new Date("2026-01-02T00:00:00Z");
    const early = freshness(createdAt, expiresAt, new Date("2026-01-01T02:00:00Z"));
    const later = freshness(createdAt, expiresAt, new Date("2026-01-01T20:00:00Z"));
    assert.ok(early > later, "a newer Story must score higher than an older one from the same creator");
  });
});

describe("explorationMultiplier", () => {
  it("gives brand-new creators the strongest boost, fading to 1.0 as they accumulate impressions", () => {
    const brandNew = explorationMultiplier(0);
    const emerging = explorationMultiplier(50);
    const established = explorationMultiplier(1000);
    const veryEstablished = explorationMultiplier(50000);
    assert.ok(brandNew > emerging, "brand-new must be boosted more than emerging");
    assert.ok(emerging > established, "emerging must be boosted more than established");
    assert.ok(established >= veryEstablished, "the multiplier must never keep growing without bound");
    assert.equal(veryEstablished, 1, "a very established creator gets no exploration boost at all");
  });
});

describe("creatorAffinity", () => {
  const base = {
    isFollowing: false,
    profileVisits: 0,
    meaningfulReplies: 0,
    distinctEngagementDays: 0,
    qualifiedViews: 0,
    storyCompletions: 0,
    sequenceContinuations: 0,
    impressions: 10,
  };

  it("a follower scores meaningfully higher than a stranger with identical other signals", () => {
    const stranger = creatorAffinity(base);
    const follower = creatorAffinity({ ...base, isFollowing: true });
    assert.ok(follower > stranger);
    assert.ok(follower - stranger >= 0.15, "isFollowing should be worth close to its full 0.2 weight");
  });

  it("returning on multiple distinct days scores higher than a single burst of engagement", () => {
    const oneDay = creatorAffinity({ ...base, distinctEngagementDays: 1 });
    const sevenDays = creatorAffinity({ ...base, distinctEngagementDays: 7 });
    assert.ok(sevenDays > oneDay, "spec section 9: a follow/engagement is worth more if the viewer keeps coming back");
  });

  it("never returns exactly zero, even with no positive signal at all", () => {
    assert.ok(creatorAffinity(base) > 0);
  });

  it("meaningful replies increase the score", () => {
    const noReplies = creatorAffinity(base);
    const withReplies = creatorAffinity({ ...base, meaningfulReplies: 5 });
    assert.ok(withReplies > noReplies);
  });
});

describe("storyQuality", () => {
  it("a highly-engaged Story scores higher than a barely-engaged one at the same view count", () => {
    const dull = storyQuality({ likeCount: 1, commentCount: 0, shareCount: 0, viewCount: 100 });
    const popular = storyQuality({ likeCount: 40, commentCount: 15, shareCount: 5, viewCount: 100 });
    assert.ok(popular > dull);
  });

  it("smooths a tiny sample instead of trusting a lucky early ratio", () => {
    const tinySampleHighRatio = storyQuality({ likeCount: 1, commentCount: 0, shareCount: 0, viewCount: 1 });
    const largeSampleSameRatio = storyQuality({ likeCount: 100, commentCount: 0, shareCount: 0, viewCount: 100 });
    assert.ok(
      tinySampleHighRatio < largeSampleSameRatio,
      "1 view / 1 like must not outscore 100 views / 100 likes despite an identical raw ratio",
    );
  });

  it("stays within [0.05, 1] regardless of extreme input", () => {
    const zero = storyQuality({ likeCount: 0, commentCount: 0, shareCount: 0, viewCount: 0 });
    const huge = storyQuality({ likeCount: 100000, commentCount: 100000, shareCount: 100000, viewCount: 1 });
    assert.ok(zero >= 0.05 && zero <= 1);
    assert.ok(huge >= 0.05 && huge <= 1);
  });
});
