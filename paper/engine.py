"""
============================================================
RahulBot Pro v9
Professional Paper Trading Engine
============================================================
"""

import time
from datetime import datetime, timedelta

from config import Config
from market.market import Market
from paper.enums import ExitReason, OrderSide
from paper.executor import PaperExecutor
from paper.trade import Trade
from risk.risk_manager import RiskManager
from utils.market_clock import MarketClock


class PaperEngine:
    """
    Professional Paper Trading Engine

    Responsibilities
    ----------------
    ✓ Execute BUY Orders
    ✓ Monitor Live Positions
    ✓ Automatic Exit
    ✓ Portfolio Integration
    ✓ Performance Tracking
    ✓ Trade Logging
    """

    def __init__(
        self,
        capital=None,
        risk_percent=1.0
    ):

        self.market = Market()

        self.executor = PaperExecutor()

        self.capital = capital or Config.CAPITAL

        self.risk_percent = risk_percent

        self.monitor_delay = 1

        self.timeout_minutes = 30

    # ---------------------------------------------------------
    # BUY ORDER
    # ---------------------------------------------------------

    def buy(
        self,
        symbol,
        stop_loss
    ):

        if self.executor.has_position(symbol):

            print(f"\n⚠ {symbol} already has an open position.")

            return None

        entry = self.market.get_ltp(symbol)

        risk = RiskManager.calculate(

            capital=self.capital,

            risk_percent=self.risk_percent,

            entry=entry,

            stop_loss=stop_loss

        )

        trade = Trade(

            symbol=symbol,

            side=OrderSide.BUY,

            quantity=risk["quantity"],

            entry_price=entry,

            stop_loss=risk["stop_loss"],

            target=risk["target"]

        )

        position = self.executor.open_position(trade)

        print()

        print("=" * 60)

        print("PAPER BUY ORDER")

        print("=" * 60)

        print(f"Symbol       : {symbol}")

        print(f"Entry        : ₹{entry:.2f}")

        print(f"Quantity     : {trade.quantity}")

        print(f"Investment   : ₹{risk['investment']:.2f}")

        print(f"Stop Loss    : ₹{trade.stop_loss:.2f}")

        print(f"Target       : ₹{trade.target:.2f}")

        print(f"Risk         : ₹{risk['actual_risk']:.2f}")

        print(f"Reward       : ₹{risk['reward']:.2f}")

        print("=" * 60)

        return position

    # ---------------------------------------------------------
    # Monitor Position
    # ---------------------------------------------------------

    def monitor(
        self,
        symbol
    ):

        position = self.executor.get_position(symbol)

        if position is None:

            print(f"\nNo open position for {symbol}")

            return

        print()

        print("=" * 60)

        print(f"Monitoring {symbol}")

        print("=" * 60)

        start = datetime.now()

        while position.is_open:

            try:

                # ------------------------------------------
                # Market Closed
                # ------------------------------------------

                if not MarketClock.is_market_open():

                    print("\nMarket Closed")

                    break

                # ------------------------------------------
                # Auto Square Off
                # ------------------------------------------

                if MarketClock.should_square_off():

                    print("\nAuto Square Off")

                    self.executor.close_position(

                        symbol,

                        ExitReason.MARKET_CLOSE

                    )

                    break

                # ------------------------------------------
                # Refresh Quote
                # ------------------------------------------

                quote = self.market.refresh(symbol)

                ltp = quote["last_price"]

                self.executor.update_position(

                    symbol,

                    ltp

                )

                elapsed = datetime.now() - start

                print(

                    f"LTP={ltp:.2f} | "

                    f"PnL={position.pnl:.2f}"

                )
                                # ------------------------------------------
                # Target Hit
                # ------------------------------------------

                if position.hit_target():

                    print()

                    print("🎯 TARGET HIT")

                    self.executor.close_position(

                        symbol,

                        ExitReason.TARGET

                    )

                    break

                # ------------------------------------------
                # Stop Loss Hit
                # ------------------------------------------

                if position.hit_stop_loss():

                    print()

                    print("🛑 STOP LOSS HIT")

                    self.executor.close_position(

                        symbol,

                        ExitReason.STOP_LOSS

                    )

                    break

                # ------------------------------------------
                # Timeout
                # ------------------------------------------

                if elapsed >= timedelta(

                    minutes=self.timeout_minutes

                ):

                    print()

                    print("⌛ TIMEOUT")

                    self.executor.close_position(

                        symbol,

                        ExitReason.TIMEOUT

                    )

                    break

                time.sleep(

                    self.monitor_delay

                )

            except KeyboardInterrupt:

                print()

                print("Manual Exit")

                self.executor.close_position(

                    symbol,

                    ExitReason.MANUAL

                )

                break

            except Exception as e:

                print()

                print(f"Monitoring Error: {e}")

                time.sleep(2)

        print()

        print("=" * 60)

        print("POSITION CLOSED")

        print("=" * 60)

        print()

        self.executor.print_summary()

    # ---------------------------------------------------------
    # Execute Complete Trade
    # ---------------------------------------------------------

    def execute(

        self,

        symbol,

        stop_loss

    ):

        position = self.buy(

            symbol,

            stop_loss

        )

        if position is None:

            return

        self.monitor(

            symbol

        )

    # ---------------------------------------------------------
    # Portfolio
    # ---------------------------------------------------------

    @property
    def portfolio(self):

        return self.executor.portfolio

    # ---------------------------------------------------------
    # Performance
    # ---------------------------------------------------------

    @property
    def performance(self):

        return self.executor.performance

    # ---------------------------------------------------------
    # Summary
    # ---------------------------------------------------------

    def summary(self):

        return self.executor.summary()

    # ---------------------------------------------------------
    # Reset
    # ---------------------------------------------------------

    def reset(self):

        self.executor.portfolio.reset()

        self.executor.performance.total = 0

        self.executor.performance.wins = 0

        self.executor.performance.losses = 0

        self.executor.performance.gross_profit = 0

        self.executor.performance.gross_loss = 0

    # ---------------------------------------------------------
    # Open Positions
    # ---------------------------------------------------------

    def open_positions(self):

        return self.executor.portfolio.open_positions

    # ---------------------------------------------------------
    # Closed Trades
    # ---------------------------------------------------------

    def closed_trades(self):

        return self.executor.portfolio.closed_trades

    # ---------------------------------------------------------
    # Print Summary
    # ---------------------------------------------------------

    def print_summary(self):

        summary = self.summary()

        print()

        print("=" * 60)

        print("RAHULBOT SUMMARY")

        print("=" * 60)

        print()

        print("Portfolio")

        print(summary["portfolio"])

        print()

        print("Performance")

        print(summary["performance"])

        print()

        print("=" * 60)

    # ---------------------------------------------------------
    # String
    # ---------------------------------------------------------

    def __str__(self):

        performance = self.summary()["performance"]

        return (

            f"Trades={performance['total_trades']} | "

            f"Wins={performance['wins']} | "

            f"Losses={performance['losses']} | "

            f"Net Profit=₹{performance['net_profit']:.2f}"

        )