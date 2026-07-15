"""
============================================================
RahulBot Pro v8
Portfolio Manager
============================================================
"""

from paper.position import Position


class Portfolio:
    """
    Professional Portfolio Manager

    Responsibilities
    ----------------
    ✓ Track Open Positions
    ✓ Track Closed Trades
    ✓ Portfolio Statistics
    ✓ Exposure
    ✓ P&L
    """

    def __init__(self):

        self.open_positions = {}

        self.closed_trades = []

    # ---------------------------------------------------------
    # Position Management
    # ---------------------------------------------------------

    def add_position(self, position: Position):

        symbol = position.trade.symbol

        if symbol in self.open_positions:
            raise Exception(
                f"{symbol} already has an open position."
            )

        self.open_positions[symbol] = position

    def get_position(self, symbol):

        return self.open_positions.get(symbol)

    def has_position(self, symbol):

        return symbol in self.open_positions

    def remove_position(self, symbol):

        if symbol not in self.open_positions:
            return

        position = self.open_positions.pop(symbol)

        self.closed_trades.append(position.trade)

    # ---------------------------------------------------------
    # Portfolio Metrics
    # ---------------------------------------------------------

    @property
    def open_count(self):

        return len(self.open_positions)

    @property
    def closed_count(self):

        return len(self.closed_trades)

    @property
    def total_trades(self):

        return self.closed_count

    @property
    def gross_profit(self):

        return round(

            sum(

                trade.pnl

                for trade in self.closed_trades

                if trade.pnl > 0

            ),

            2

        )

    @property
    def gross_loss(self):

        return round(

            abs(

                sum(

                    trade.pnl

                    for trade in self.closed_trades

                    if trade.pnl < 0

                )

            ),

            2

        )

    @property
    def net_profit(self):

        return round(

            sum(

                trade.pnl

                for trade in self.closed_trades

            ),

            2

        )

    @property
    def wins(self):

        return len(

            [

                t

                for t in self.closed_trades

                if t.pnl > 0

            ]

        )

    @property
    def losses(self):

        return len(

            [

                t

                for t in self.closed_trades

                if t.pnl < 0

            ]

        )

    @property
    def breakeven(self):

        return len(

            [

                t

                for t in self.closed_trades

                if t.pnl == 0

            ]

        )

    @property
    def win_rate(self):

        if self.total_trades == 0:
            return 0

        return round(

            self.wins /

            self.total_trades * 100,

            2

        )

    @property
    def profit_factor(self):

        if self.gross_loss == 0:

            if self.gross_profit == 0:
                return 0

            return float("inf")

        return round(

            self.gross_profit /

            self.gross_loss,

            2

        )

    @property
    def current_pnl(self):

        return round(

            sum(

                p.pnl

                for p in self.open_positions.values()

            ),

            2

        )

    @property
    def exposure(self):

        return round(

            sum(

                p.trade.entry_price *

                p.trade.quantity

                for p in self.open_positions.values()

            ),

            2

        )

    # ---------------------------------------------------------
    # Portfolio Summary
    # ---------------------------------------------------------

    def summary(self):

        return {

            "open_positions": self.open_count,

            "closed_trades": self.closed_count,

            "wins": self.wins,

            "losses": self.losses,

            "breakeven": self.breakeven,

            "gross_profit": self.gross_profit,

            "gross_loss": self.gross_loss,

            "net_profit": self.net_profit,

            "current_pnl": self.current_pnl,

            "win_rate": self.win_rate,

            "profit_factor": self.profit_factor,

            "exposure": self.exposure,

        }

    # ---------------------------------------------------------
    # Reset
    # ---------------------------------------------------------

    def reset(self):

        self.open_positions.clear()

        self.closed_trades.clear()

    # ---------------------------------------------------------
    # String
    # ---------------------------------------------------------

    def __str__(self):

        stats = self.summary()

        return (

            f"Open={stats['open_positions']} | "

            f"Closed={stats['closed_trades']} | "

            f"PnL={stats['net_profit']} | "

            f"WinRate={stats['win_rate']}%"

        )