"""
============================================================
RahulBot Pro v5
Simple Moving Average
============================================================
"""

from indicators.candles import CandleUtils


class SMA:

    @staticmethod
    def calculate(candles, period):

        closes = CandleUtils.close(candles)

        if len(closes) < period:
            raise Exception("Not enough candles.")

        sma = []

        for i in range(period - 1, len(closes)):

            average = sum(
                closes[i - period + 1:i + 1]
            ) / period

            sma.append(average)

        return sma

    @staticmethod
    def latest(candles, period):

        return SMA.calculate(candles, period)[-1]