"""
============================================================
RahulBot Pro v8
Volume Indicator
============================================================
"""


class Volume:

    @staticmethod
    def average(candles, period=20):

        if len(candles) < period:
            raise Exception("Not enough candles.")

        volumes = [c["volume"] for c in candles]

        return sum(volumes[-period:]) / period

    @staticmethod
    def latest(candles):

        return candles[-1]["volume"]

    @staticmethod
    def ratio(candles, period=20):

        avg_volume = Volume.average(candles, period)

        latest_volume = Volume.latest(candles)

        if avg_volume == 0:
            return 0

        return latest_volume / avg_volume