"""
============================================================
Portfolio Test
============================================================
"""

from paper.portfolio import Portfolio

portfolio = Portfolio()

trade = portfolio.add_trade(

    symbol="TCS",

    signal="BUY",

    entry=2200,

    stop_loss=2180,

    target=2240,

    quantity=5

)

print("=" * 60)

print("OPEN TRADES")

print("=" * 60)

for t in portfolio.open_trades():

    print(vars(t))

trade.close(2240)

print()

print("=" * 60)

print("CLOSED TRADES")

print("=" * 60)

for t in portfolio.closed_trades():

    print(vars(t))