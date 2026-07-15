"""
============================================================
RahulBot Pro v5
Exponential Moving Average
============================================================
"""

from indicators.candles import CandleUtils


class EMA:

    @staticmethod
    def calculate(candles, period):

        closes = CandleUtils.close(candles)

        if len(closes) < period:
            raise Exception("Not enough candles.")

        multiplier = 2 / (period + 1)

        ema = []

        first_ema = sum(closes[:period]) / period

        ema.append(first_ema)

        for price in closes[period:]:

            value = ((price - ema[-1]) * multiplier) + ema[-1]

            ema.append(value)

        return ema

    @staticmethod
    def latest(candles, period):

        return EMA.calculate(candles, period)[-1]