"""
============================================================
RahulBot Pro v7
Market Service
============================================================
"""

import time

from broker.dhan import DhanBroker
from config import Config
from market.cache import MarketCache
from market.exceptions import (
    MarketAPIError,
    QuoteUnavailableError,
    SymbolNotFoundError,
)
from market.instruments import InstrumentManager


class Market:
    """
    Professional Market Service

    Features
    --------
    ✓ Smart Quote Cache
    ✓ Retry Logic
    ✓ Thread Safe Cache
    ✓ Automatic Refresh
    ✓ Live Quote API
    ✓ OHLC Helpers
    """

    def __init__(self):

        self.broker = DhanBroker()

        self.instruments = InstrumentManager()

        self.instruments.load()

        self.cache = MarketCache(
            ttl=Config.MARKET_CACHE_TTL
        )

    # ---------------------------------------------------------
    # Internal API
    # ---------------------------------------------------------

    def _fetch_quote(self, symbol):

        security_id = self.instruments.get_security_id(symbol)

        if security_id is None:
            raise SymbolNotFoundError(symbol)

        response = self.broker.client.quote_data(
            {
                "NSE_EQ": [security_id]
            }
        )

        if response.get("status") != "success":
            raise MarketAPIError(response)

        try:

            quote = response["data"]["data"]["NSE_EQ"][str(security_id)]

        except Exception:

            raise QuoteUnavailableError(symbol)

        self.cache.set(symbol, quote)

        return quote

    # ---------------------------------------------------------
    # Public API
    # ---------------------------------------------------------

    def get_quote(self, symbol, refresh=False):

        if not refresh:

            cached = self.cache.get(symbol)

            if cached is not None:
                return cached

        retries = Config.MARKET_API_RETRIES

        last_exception = None

        for attempt in range(retries):

            try:

                return self._fetch_quote(symbol)

            except Exception as e:

                last_exception = e

                if attempt < retries - 1:

                    time.sleep(Config.MARKET_RETRY_DELAY)

        cached = self.cache.get(symbol)

        if cached is not None:
            return cached

        raise last_exception

    # ---------------------------------------------------------
    # Price Helpers
    # ---------------------------------------------------------

    def get_ltp(self, symbol):

        return self.get_quote(symbol)["last_price"]

    def get_open(self, symbol):

        return self.get_quote(symbol)["ohlc"]["open"]

    def get_high(self, symbol):

        return self.get_quote(symbol)["ohlc"]["high"]

    def get_low(self, symbol):

        return self.get_quote(symbol)["ohlc"]["low"]

    def get_close(self, symbol):

        return self.get_quote(symbol)["ohlc"]["close"]

    def get_volume(self, symbol):

        return self.get_quote(symbol)["volume"]

    # ---------------------------------------------------------
    # Bulk Quotes
    # ---------------------------------------------------------

    def get_quotes(self, symbols):

        quotes = {}

        for symbol in symbols:

            try:

                quotes[symbol] = self.get_quote(symbol)

            except Exception as e:

                quotes[symbol] = {

                    "error": str(e)

                }

        return quotes

    # ---------------------------------------------------------
    # Cache Utilities
    # ---------------------------------------------------------

    def refresh(self, symbol):

        return self.get_quote(
            symbol,
            refresh=True
        )

    def clear_cache(self):

        self.cache.clear()

    def cache_stats(self):

        return self.cache.stats()