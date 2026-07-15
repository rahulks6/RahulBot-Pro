"""
============================================================
RahulBot Pro v8
Trade Logger
============================================================
"""

import csv
from pathlib import Path


class TradeLogger:
    """
    Professional CSV Trade Logger

    Responsibilities
    ----------------
    ✓ Create trades.csv automatically
    ✓ Log completed trades
    ✓ Append without overwriting
    """

    def __init__(self):

        self.logs_dir = Path("logs")

        self.logs_dir.mkdir(exist_ok=True)

        self.file = self.logs_dir / "trades.csv"

        self._create_file()

    # ---------------------------------------------------------
    # Create CSV
    # ---------------------------------------------------------

    def _create_file(self):

        if self.file.exists():
            return

        with open(self.file, "w", newline="", encoding="utf-8") as csvfile:

            writer = csv.writer(csvfile)

            writer.writerow([

                "Entry Time",
                "Exit Time",
                "Symbol",
                "Side",
                "Quantity",
                "Entry Price",
                "Exit Price",
                "Stop Loss",
                "Target",
                "Exit Reason",
                "Risk",
                "Reward",
                "Risk Reward",
                "PnL",
                "PnL %",
                "Result"

            ])

    # ---------------------------------------------------------
    # Log Trade
    # ---------------------------------------------------------

    def log_trade(self, trade):

        with open(self.file, "a", newline="", encoding="utf-8") as csvfile:

            writer = csv.writer(csvfile)

            writer.writerow([

                trade.entry_time,

                trade.exit_time,

                trade.symbol,

                trade.side.name,

                trade.quantity,

                trade.entry_price,

                trade.exit_price,

                trade.stop_loss,

                trade.target,

                trade.exit_reason.name if trade.exit_reason else "",

                trade.total_risk,

                trade.expected_reward,

                trade.risk_reward_ratio,

                trade.pnl,

                trade.pnl_percent,

                trade.result.name if trade.result else ""

            ])

    # ---------------------------------------------------------
    # Utility
    # ---------------------------------------------------------

    def clear(self):

        if self.file.exists():

            self.file.unlink()

        self._create_file()

    @property
    def path(self):

        return str(self.file)