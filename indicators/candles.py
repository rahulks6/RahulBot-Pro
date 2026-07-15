"""
============================================================
RahulBot Pro v5
Candle Utilities
============================================================
"""


class CandleUtils:

    @staticmethod
    def close(candles):

        return [candle["close"] for candle in candles]

    @staticmethod
    def open(candles):

        return [candle["open"] for candle in candles]

    @staticmethod
    def high(candles):

        return [candle["high"] for candle in candles]

    @staticmethod
    def low(candles):

        return [candle["low"] for candle in candles]

    @staticmethod
    def volume(candles):

        return [candle["volume"] for candle in candles]

    @staticmethod
    def dates(candles):

        if "date" in candles[0]:
            return [candle["date"] for candle in candles]

        return [candle["time"] for candle in candles]