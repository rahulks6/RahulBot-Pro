"""
============================================================
RahulBot Pro v10
Signal Engine
============================================================
"""


class SignalEngine:

    @staticmethod
    def generate(stock):

        score = stock["score"]

        rsi = stock["rsi"]

        volume = stock["volume_ratio"]

        ema20 = stock["ema20"]

        ema50 = stock["ema50"]

        histogram = stock["macd"]["histogram"]

        reasons = []

        # -----------------------------------------
        # BUY
        # -----------------------------------------

        if (

            score >= 80 and

            ema20 > ema50 and

            histogram > 0 and

            55 <= rsi <= 70 and

            volume >= 2

        ):

            reasons.append("Strong Trend")
            reasons.append("Healthy RSI")
            reasons.append("MACD Bullish")
            reasons.append("High Volume")

            return {

                "signal": "BUY",

                "reasons": reasons

            }

        # -----------------------------------------
        # WATCH
        # -----------------------------------------

        if score >= 60:

            reasons.append("Needs Confirmation")

            return {

                "signal": "WATCH",

                "reasons": reasons

            }

        # -----------------------------------------
        # AVOID
        # -----------------------------------------

        return {

            "signal": "AVOID",

            "reasons": [

                "Weak Setup"

            ]

        }