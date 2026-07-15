"""
============================================================
RahulBot Pro v8
Professional Ranking Engine
============================================================
"""

from ranking.confidence import Confidence


class RankingEngine:

    @staticmethod
    def score(stock):

        ema20 = stock["ema20"]
        ema50 = stock["ema50"]

        rsi = stock["rsi"]
        atr = stock["atr"]

        macd = stock["macd"]

        volume_ratio = stock["volume_ratio"]

        trend_score = 0
        momentum_score = 0
        volatility_score = 0
        volume_score = 0

        reasons = []

        # =====================================================
        # Trend Score (30)
        # =====================================================

        if ema20 > ema50:

            spread = ((ema20 - ema50) / ema50) * 100

            trend_score = min(spread * 7.5, 30)

        reasons.append(
            f"Trend {trend_score:.1f}/30"
        )

        # =====================================================
        # Momentum Score (25)
        # =====================================================

        if rsi >= 50:

            momentum_score += min(
                (rsi - 50),
                15
            )

        histogram = macd["histogram"]

        if histogram > 0:

            momentum_score += min(
                histogram * 1.5,
                10
            )

        momentum_score = min(momentum_score, 25)

        reasons.append(
            f"Momentum {momentum_score:.1f}/25"
        )

        # =====================================================
        # Volatility Score (10)
        # =====================================================

        atr_percent = atr / ema20 * 100

        volatility_score = min(
            atr_percent * 2,
            10
        )

        reasons.append(
            f"Volatility {volatility_score:.1f}/10"
        )

        # =====================================================
        # Volume Score (20)
        # =====================================================

        if volume_ratio >= 3:

            volume_score = 20

        elif volume_ratio >= 2:

            volume_score = 15

        elif volume_ratio >= 1.5:

            volume_score = 10

        elif volume_ratio >= 1:

            volume_score = 5

        reasons.append(
            f"Volume {volume_score:.1f}/20"
        )

        # =====================================================
        # Final Score
        # =====================================================

        total = round(

            trend_score +
            momentum_score +
            volatility_score +
            volume_score,

            2

        )

        return {

            "score": total,

            "trend": round(trend_score, 2),

            "momentum": round(momentum_score, 2),

            "volatility": round(volatility_score, 2),

            "volume": volume_score,

            "confidence": Confidence.level(total),

            "reasons": reasons

        }