"""
============================================================
RahulBot Pro v8
Position Model
============================================================
"""

from datetime import datetime

from paper.enums import ExitReason
from paper.trade import Trade


class Position:
    """
    Represents a live paper trading position.
    """

    def __init__(self, trade: Trade):

        self.trade = trade

        self.current_price = trade.entry_price

        self.highest_price = trade.entry_price

        self.lowest_price = trade.entry_price

        self.last_update = datetime.now()

    # ---------------------------------------------------------
    # Update Live Price
    # ---------------------------------------------------------

    def update(self, ltp: float):

        self.current_price = ltp

        self.last_update = datetime.now()

        if ltp > self.highest_price:
            self.highest_price = ltp

        if ltp < self.lowest_price:
            self.lowest_price = ltp

    # ---------------------------------------------------------
    # Exit Conditions
    # ---------------------------------------------------------

    def hit_target(self):

        return self.current_price >= self.trade.target

    def hit_stop_loss(self):

        return self.current_price <= self.trade.stop_loss

    # ---------------------------------------------------------
    # Close Position
    # ---------------------------------------------------------

    def close(self, reason: ExitReason):

        self.trade.close(

            exit_price=self.current_price,

            reason=reason

        )

    # ---------------------------------------------------------
    # Properties
    # ---------------------------------------------------------

    @property
    def is_open(self):

        return self.trade.is_open

    @property
    def is_closed(self):

        return self.trade.is_closed

    @property
    def pnl(self):

        return round(

            (self.current_price - self.trade.entry_price)
            * self.trade.quantity,

            2

        )

    @property
    def pnl_percent(self):

        investment = (

            self.trade.entry_price *

            self.trade.quantity

        )

        if investment == 0:
            return 0

        return round(

            (self.pnl / investment) * 100,

            2

        )

    # ---------------------------------------------------------
    # Export
    # ---------------------------------------------------------

    def to_dict(self):

        return {

            "symbol": self.trade.symbol,

            "entry_price": self.trade.entry_price,

            "current_price": self.current_price,

            "quantity": self.trade.quantity,

            "stop_loss": self.trade.stop_loss,

            "target": self.trade.target,

            "highest_price": self.highest_price,

            "lowest_price": self.lowest_price,

            "pnl": self.pnl,

            "pnl_percent": self.pnl_percent,

            "status": self.trade.status.name,

            "entry_time": self.trade.entry_time,

            "last_update": self.last_update,

        }

    # ---------------------------------------------------------
    # String
    # ---------------------------------------------------------

    def __str__(self):

        return (

            f"{self.trade.symbol} | "

            f"LTP={self.current_price:.2f} | "

            f"PnL={self.pnl:.2f}"

        )