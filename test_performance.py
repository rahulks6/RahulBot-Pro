"""
============================================================
Performance Test
============================================================
"""

from paper.performance import Performance
from paper.trade import Trade

performance = Performance()

# Winning trade
trade1 = Trade(
    "TCS",
    "BUY",
    2200,
    2180,
    2240,
    5
)

trade1.close(2240)

performance.update(trade1)

# Losing trade
trade2 = Trade(
    "INFY",
    "BUY",
    1500,
    1485,
    1530,
    5
)

trade2.close(1485)

performance.update(trade2)

performance.print_report()