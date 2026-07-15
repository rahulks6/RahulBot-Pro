"""
============================================================
RahulBot Pro v5
Signal Scoring Engine
============================================================
"""

from scanner.filters import Filters


class SignalEngine:

    @staticmethod
    def score(ema20, ema50, rsi, atr, macd):

        score = 0

        reasons = []

        if Filters.ema_bullish(ema20, ema50):

            score += 30
            reasons.append("EMA20 > EMA50")

        if Filters.rsi_good(rsi):

            score += 20
            reasons.append("Healthy RSI")

        if Filters.macd_bullish(macd):

            score += 30
            reasons.append("MACD Bullish")

        if Filters.atr_good(atr):

            score += 20
            reasons.append("ATR Available")

        return score, reasons