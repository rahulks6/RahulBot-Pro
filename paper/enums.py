"""
============================================================
RahulBot Pro v8
Paper Trading Enums
============================================================
"""

from enum import Enum, auto


class OrderSide(Enum):
    """
    BUY / SELL
    """

    BUY = auto()
    SELL = auto()


class PositionStatus(Enum):
    """
    Current Position Status
    """

    OPEN = auto()
    CLOSED = auto()


class ExitReason(Enum):
    """
    Why the trade exited.
    """

    TARGET = auto()

    STOP_LOSS = auto()

    TRAILING_STOP = auto()

    TIMEOUT = auto()

    MANUAL = auto()

    MARKET_CLOSE = auto()


class TradeResult(Enum):
    """
    Trade Outcome
    """

    WIN = auto()

    LOSS = auto()

    BREAKEVEN = auto()


class OrderStatus(Enum):
    """
    Order Lifecycle
    """

    PENDING = auto()

    FILLED = auto()

    CANCELLED = auto()

    REJECTED = auto()