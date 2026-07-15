"""
============================================================
RahulBot Pro v8
Paper Executor
============================================================

Responsible for:
✓ Opening Positions
✓ Closing Positions
✓ Portfolio Integration
✓ Performance Update
✓ Trade Logging

Future:
✓ LiveExecutor will implement the same interface.
============================================================
"""

from paper.enums import ExitReason
from paper.logger import TradeLogger
from paper.performance import Performance
from paper.portfolio import Portfolio
from paper.position import Position


class PaperExecutor:

    def __init__(self):

        self.portfolio = Portfolio()

        self.performance = Performance()

        self.logger = TradeLogger()

    # ---------------------------------------------------------
    # Open Position
    # ---------------------------------------------------------

    def open_position(self, trade):

        symbol = trade.symbol

        if self.portfolio.has_position(symbol):

            raise Exception(
                f"{symbol} already has an open position."
            )

        position = Position(trade)

        self.portfolio.add_position(position)

        print(
            f"✅ BUY {symbol} | "
            f"Qty={trade.quantity} | "
            f"Entry={trade.entry_price}"
        )

        return position

    # ---------------------------------------------------------
    # Update Position
    # ---------------------------------------------------------

    def update_position(self, symbol, ltp):

        position = self.portfolio.get_position(symbol)

        if position is None:

            return None

        position.update(ltp)

        return position

    # ---------------------------------------------------------
    # Close Position
    # ---------------------------------------------------------

    def close_position(
        self,
        symbol,
        reason: ExitReason,
    ):

        position = self.portfolio.get_position(symbol)

        if position is None:

            return None

        position.close(reason)

        trade = position.trade

        self.performance.update(trade)

        self.logger.log_trade(trade)

        self.portfolio.remove_position(symbol)

        print(
            f"✅ EXIT {symbol} | "
            f"{reason.name} | "
            f"PnL ₹{trade.pnl:.2f}"
        )

        return trade

    # ---------------------------------------------------------
    # Helpers
    # ---------------------------------------------------------

    def has_position(self, symbol):

        return self.portfolio.has_position(symbol)

    def get_position(self, symbol):

        return self.portfolio.get_position(symbol)

    def summary(self):

        return {

            "portfolio": self.portfolio.summary(),

            "performance": {

                "total_trades": self.performance.total,

                "wins": self.performance.wins,

                "losses": self.performance.losses,

                "gross_profit": self.performance.gross_profit,

                "gross_loss": self.performance.gross_loss,

                "net_profit": self.performance.net_profit,

                "win_rate": self.performance.win_rate,

                "profit_factor": self.performance.profit_factor,

            }

        }

    # ---------------------------------------------------------
    # Print Summary
    # ---------------------------------------------------------

    def print_summary(self):

        print()

        print("=" * 60)

        print("EXECUTION SUMMARY")

        print("=" * 60)

        print()

        self.performance.print_report()

        print()

        print("Portfolio")

        print(self.portfolio)

        print("=" * 60)