"""
============================================================
RahulBot Pro v8
Trade Model
============================================================
"""

from dataclasses import dataclass, field
from datetime import datetime

from paper.enums import (
    ExitReason,
    OrderSide,
    PositionStatus,
    TradeResult,
)


@dataclass
class Trade:
    """
    Represents one completed or open trade.
    """

    symbol: str

    side: OrderSide

    quantity: int

    entry_price: float

    stop_loss: float

    target: float

    entry_time: datetime = field(default_factory=datetime.now)

    exit_price: float | None = None

    exit_time: datetime | None = None

    exit_reason: ExitReason | None = None

    status: PositionStatus = PositionStatus.OPEN

    # -----------------------------------------------------
    # Close Trade
    # -----------------------------------------------------

    def close(
        self,
        exit_price: float,
        reason: ExitReason,
    ):

        self.exit_price = exit_price

        self.exit_reason = reason

        self.exit_time = datetime.now()

        self.status = PositionStatus.CLOSED

    # -----------------------------------------------------
    # Properties
    # -----------------------------------------------------

    @property
    def is_open(self):

        return self.status == PositionStatus.OPEN

    @property
    def is_closed(self):

        return self.status == PositionStatus.CLOSED

    @property
    def risk_per_share(self):

        return abs(
            self.entry_price - self.stop_loss
        )

    @property
    def reward_per_share(self):

        return abs(
            self.target - self.entry_price
        )

    @property
    def total_risk(self):

        return round(
            self.risk_per_share * self.quantity,
            2,
        )

    @property
    def expected_reward(self):

        return round(
            self.reward_per_share * self.quantity,
            2,
        )

    @property
    def risk_reward_ratio(self):

        if self.risk_per_share == 0:
            return 0

        return round(
            self.reward_per_share /
            self.risk_per_share,
            2,
        )

    @property
    def pnl(self):

        if self.exit_price is None:
            return 0

        if self.side == OrderSide.BUY:

            value = (
                self.exit_price -
                self.entry_price
            ) * self.quantity

        else:

            value = (
                self.entry_price -
                self.exit_price
            ) * self.quantity

        return round(value, 2)

    @property
    def pnl_percent(self):

        invested = self.entry_price * self.quantity

        if invested == 0:
            return 0

        return round(
            (self.pnl / invested) * 100,
            2,
        )

    @property
    def result(self):

        if self.is_open:
            return None

        if self.pnl > 0:
            return TradeResult.WIN

        if self.pnl < 0:
            return TradeResult.LOSS

        return TradeResult.BREAKEVEN

    # -----------------------------------------------------
    # Export
    # -----------------------------------------------------

    def to_dict(self):

        return {

            "symbol": self.symbol,

            "side": self.side.name,

            "quantity": self.quantity,

            "entry_price": self.entry_price,

            "stop_loss": self.stop_loss,

            "target": self.target,

            "entry_time": self.entry_time,

            "exit_price": self.exit_price,

            "exit_time": self.exit_time,

            "exit_reason": (
                self.exit_reason.name
                if self.exit_reason
                else None
            ),

            "status": self.status.name,

            "risk": self.total_risk,

            "reward": self.expected_reward,

            "rr": self.risk_reward_ratio,

            "pnl": self.pnl,

            "pnl_percent": self.pnl_percent,

            "result": (
                self.result.name
                if self.result
                else None
            ),
        }

    # -----------------------------------------------------
    # String Representation
    # -----------------------------------------------------

    def __str__(self):

        return (
            f"{self.symbol} | "
            f"{self.side.name} | "
            f"Qty={self.quantity} | "
            f"Entry={self.entry_price} | "
            f"SL={self.stop_loss} | "
            f"Target={self.target} | "
            f"PnL={self.pnl}"
        )