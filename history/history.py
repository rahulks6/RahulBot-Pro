"""
============================================================
RahulBot Pro v5
History Engine
============================================================
"""

from datetime import datetime, timedelta

from broker.dhan import DhanBroker
from market.instruments import InstrumentManager


class History:

    def __init__(self):

        self.broker = DhanBroker()

        self.instruments = InstrumentManager()

        self.instruments.load()

    def daily(self, symbol, days=30):
        """
        Returns Daily OHLC candles.
        """

        security_id = self.instruments.get_security_id(symbol)

        to_date = datetime.today().strftime("%Y-%m-%d")

        from_date = (
            datetime.today() - timedelta(days=days)
        ).strftime("%Y-%m-%d")

        response = self.broker.client.historical_daily_data(

            security_id=str(security_id),

            exchange_segment=self.broker.client.NSE,

            instrument_type="EQUITY",

            from_date=from_date,

            to_date=to_date

        )

        if response["status"] != "success":
            raise Exception(response)

        return self._format_daily(response["data"])

    def intraday(self, symbol, interval=5, days=5):
        """
        Returns Intraday OHLC candles.
        """

        security_id = self.instruments.get_security_id(symbol)

        to_date = datetime.today().strftime("%Y-%m-%d")

        from_date = (
            datetime.today() - timedelta(days=days)
        ).strftime("%Y-%m-%d")

        response = self.broker.client.intraday_minute_data(

            security_id=str(security_id),

            exchange_segment=self.broker.client.NSE,

            instrument_type="EQUITY",

            from_date=from_date,

            to_date=to_date,

            interval=interval

        )

        if response["status"] != "success":
            raise Exception(response)

        return self._format_intraday(response["data"])

    def _format_daily(self, data):
        """
        Converts Dhan Daily API response
        into a list of candle dictionaries.
        """

        candles = []

        count = len(data["open"])

        for i in range(count):

            timestamp = data["timestamp"][i]

            candle = {

                "date": datetime.fromtimestamp(
                    timestamp
                ).strftime("%Y-%m-%d"),

                "open": data["open"][i],

                "high": data["high"][i],

                "low": data["low"][i],

                "close": data["close"][i],

                "volume": int(data["volume"][i])

            }

            candles.append(candle)

        return candles

    def _format_intraday(self, data):
        """
        Converts Dhan Intraday API response
        into a list of candle dictionaries.
        """

        candles = []

        count = len(data["open"])

        for i in range(count):

            timestamp = data["timestamp"][i]

            candle = {

                "time": datetime.fromtimestamp(
                    timestamp
                ).strftime("%Y-%m-%d %H:%M"),

                "open": data["open"][i],

                "high": data["high"][i],

                "low": data["low"][i],

                "close": data["close"][i],

                "volume": int(data["volume"][i])

            }

            candles.append(candle)

        return candles