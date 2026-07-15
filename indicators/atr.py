"""
============================================================
RahulBot Pro v5
Average True Range (ATR)
============================================================
"""

from indicators.candles import CandleUtils


class ATR:

    @staticmethod
    def calculate(candles, period=14):

        highs = CandleUtils.high(candles)
        lows = CandleUtils.low(candles)
        closes = CandleUtils.close(candles)

        if len(candles) <= period:
            raise Exception("Not enough candles.")

        true_ranges = []

        # First Candle
        true_ranges.append(
            highs[0] - lows[0]
        )

        # Remaining Candles
        for i in range(1, len(candles)):

            tr = max(

                highs[i] - lows[i],

                abs(highs[i] - closes[i - 1]),

                abs(lows[i] - closes[i - 1])

            )

            true_ranges.append(tr)

        atr = []

        # Initial ATR
        first_atr = (
            sum(true_ranges[:period]) / period
        )

        atr.append(first_atr)

        # Wilder's Smoothing
        for tr in true_ranges[period:]:

            value = (

                (atr[-1] * (period - 1)) + tr

            ) / period

            atr.append(value)

        return atr

    @staticmethod
    def latest(candles, period=14):

        return ATR.calculate(
            candles,
            period
        )[-1]