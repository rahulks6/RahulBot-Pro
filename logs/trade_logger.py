"""
============================================================
RahulBot Pro v13
Trade Logger
============================================================
"""

import csv
import os
from datetime import datetime


class TradeLogger:

    FILE_NAME = "trades.csv"

    @classmethod
    def initialize(cls):

        if os.path.exists(cls.FILE_NAME):
            return

        with open(cls.FILE_NAME, "w", newline="") as file:

            writer = csv.writer(file)

            writer.writerow([

                "Date",
                "Symbol",
                "Signal",
                "Entry",
                "Exit",
                "Quantity",
                "PnL",
                "Status"

            ])

    @classmethod
    def log(cls, trade):

        cls.initialize()

        with open(cls.FILE_NAME, "a", newline="") as file:

            writer = csv.writer(file)

            writer.writerow([

                datetime.now().strftime("%Y-%m-%d %H:%M:%S"),

                trade.symbol,

                trade.signal,

                trade.entry,

                trade.exit_price,

                trade.quantity,

                round(trade.pnl, 2),

                "WIN" if trade.pnl > 0 else "LOSS"

            ])