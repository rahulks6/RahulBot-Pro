"""
============================================================
RahulBot Pro v7
Market Exceptions
============================================================
"""


class MarketError(Exception):
    """Base Market Exception."""
    pass


class SymbolNotFoundError(MarketError):
    """Raised when symbol is missing from Instrument Master."""

    def __init__(self, symbol: str):
        super().__init__(f"Unknown symbol: {symbol}")


class QuoteUnavailableError(MarketError):
    """Raised when Dhan fails to return a live quote."""

    def __init__(self, symbol: str):
        super().__init__(f"Live quote unavailable for {symbol}")


class MarketAPIError(MarketError):
    """Raised when Dhan API returns failure."""

    def __init__(self, response):
        self.response = response
        super().__init__(str(response))