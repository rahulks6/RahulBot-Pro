"""
============================================================
RahulBot Pro v5
MACD Indicator
============================================================
"""

from indicators.ema import EMA


class MACD:

    @staticmethod
    def calculate(candles):

        ema12 = EMA.calculate(candles, 12)
        ema26 = EMA.calculate(candles, 26)

        # Align EMA arrays
        offset = len(ema12) - len(ema26)
        ema12 = ema12[offset:]

        macd_line = []

        for i in range(len(ema26)):
            macd_line.append(ema12[i] - ema26[i])

        signal_line = MACD.__ema(macd_line, 9)

        offset = len(macd_line) - len(signal_line)
        macd_line = macd_line[offset:]

        histogram = []

        for i in range(len(signal_line)):
            histogram.append(
                macd_line[i] - signal_line[i]
            )

        return {
            "macd": macd_line,
            "signal": signal_line,
            "histogram": histogram
        }

    @staticmethod
    def latest(candles):

        result = MACD.calculate(candles)

        return {
            "macd": result["macd"][-1],
            "signal": result["signal"][-1],
            "histogram": result["histogram"][-1]
        }

    @staticmethod
    def __ema(values, period):

        multiplier = 2 / (period + 1)

        ema = []

        first = sum(values[:period]) / period

        ema.append(first)

        for value in values[period:]:

            ema.append(
                ((value - ema[-1]) * multiplier)
                + ema[-1]
            )

        return ema