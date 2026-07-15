"""
============================================================
RahulBot Pro v5
Scanner Filters
============================================================
"""


class Filters:

    @staticmethod
    def ema_bullish(ema20, ema50):

        return ema20 > ema50

    @staticmethod
    def rsi_good(rsi):

        return 45 <= rsi <= 70

    @staticmethod
    def macd_bullish(macd):

        return macd["macd"] > macd["signal"]

    @staticmethod
    def atr_good(atr):

        return atr > 0