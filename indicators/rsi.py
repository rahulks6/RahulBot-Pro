"""
============================================================
RahulBot Pro v5
Relative Strength Index (RSI)
============================================================
"""

from indicators.candles import CandleUtils


class RSI:

    @staticmethod
    def calculate(candles, period=14):

        closes = CandleUtils.close(candles)

        if len(closes) <= period:
            raise Exception("Not enough candles.")

        gains = []
        losses = []

        # Initial Average Gain & Loss
        for i in range(1, period + 1):

            change = closes[i] - closes[i - 1]

            if change > 0:
                gains.append(change)
                losses.append(0)
            else:
                gains.append(0)
                losses.append(abs(change))

        avg_gain = sum(gains) / period
        avg_loss = sum(losses) / period

        rsi = []

        if avg_loss == 0:

            rsi.append(100)

        else:

            rs = avg_gain / avg_loss

            rsi.append(
                100 - (100 / (1 + rs))
            )

        # Wilder's Smoothing
        for i in range(period + 1, len(closes)):

            change = closes[i] - closes[i - 1]

            gain = max(change, 0)
            loss = abs(min(change, 0))

            avg_gain = (
                (avg_gain * (period - 1)) + gain
            ) / period

            avg_loss = (
                (avg_loss * (period - 1)) + loss
            ) / period

            if avg_loss == 0:

                rsi.append(100)

            else:

                rs = avg_gain / avg_loss

                rsi.append(
                    100 - (100 / (1 + rs))
                )

        return rsi

    @staticmethod
    def latest(candles, period=14):

        return RSI.calculate(
            candles,
            period
        )[-1]