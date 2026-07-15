"""
============================================================
RahulBot Pro v11
Paper Trading Engine
============================================================
"""

import time

from paper.portfolio import Portfolio


class PaperEngine:

    def __init__(self, market):

        self.market = market
        self.portfolio = Portfolio()

    def buy(
        self,
        symbol,
        entry,
        stop_loss,
        target,
        quantity
    ):

        trade = self.portfolio.add_trade(
            symbol=symbol,
            signal="BUY",
            entry=entry,
            stop_loss=stop_loss,
            target=target,
            quantity=quantity
        )

        print()
        print("=" * 60)
        print("BUY ORDER")
        print("=" * 60)

        print(f"Symbol      : {symbol}")
        print(f"Entry       : ₹{entry}")
        print(f"Stop Loss   : ₹{stop_loss}")
        print(f"Target      : ₹{target}")
        print(f"Quantity    : {quantity}")
        print()

        return trade

    def monitor(self, trade, timeout=300):

        print()
        print("Monitoring Position...")
        print()

        start = time.time()

        failures = 0

        while trade.status == "OPEN":

            try:

                price = self.market.get_ltp(trade.symbol)

                failures = 0

                print(f"{trade.symbol} : ₹{price}")

                # -----------------------------
                # Target Hit
                # -----------------------------

                if price >= trade.target:

                    trade.close(price)

                    print()
                    print("🎯 TARGET HIT")
                    print(f"Exit Price : ₹{price}")
                    print(f"Profit     : ₹{trade.pnl:.2f}")

                    break

                # -----------------------------
                # Stop Loss Hit
                # -----------------------------

                if price <= trade.stop_loss:

                    trade.close(price)

                    print()
                    print("🛑 STOP LOSS HIT")
                    print(f"Exit Price : ₹{price}")
                    print(f"Loss       : ₹{trade.pnl:.2f}")

                    break

                # -----------------------------
                # Timeout
                # -----------------------------

                if time.time() - start >= timeout:

                    print()
                    print("⏰ Monitoring Timeout")

                    break

                time.sleep(2)

            except Exception as e:

                failures += 1

                print()
                print(f"API Error ({failures}/5)")
                print("Exception:")
                print(e)

                if failures >= 5:

                    print()
                    print("Market may be closed or API unavailable.")
                    print("Stopping monitoring.")

                    break

                time.sleep(2)