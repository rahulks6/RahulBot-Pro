"""
============================================================
RahulBot Pro v9
Market Clock
============================================================
"""

from datetime import datetime, time


class MarketClock:

    MARKET_OPEN = time(9, 15)

    MARKET_CLOSE = time(15, 30)

    AUTO_SQUARE_OFF = time(15, 20)

    @staticmethod
    def now():

        return datetime.now()

    @classmethod
    def is_market_open(cls):

        current = cls.now().time()

        return cls.MARKET_OPEN <= current <= cls.MARKET_CLOSE

    @classmethod
    def should_square_off(cls):

        current = cls.now().time()

        return current >= cls.AUTO_SQUARE_OFF

    @classmethod
    def is_before_open(cls):

        return cls.now().time() < cls.MARKET_OPEN

    @classmethod
    def is_after_close(cls):

        return cls.now().time() > cls.MARKET_CLOSE