"""
============================================================
RahulBot Pro
LTP Test
============================================================
"""

from market.market import Market


market = Market()

print("=" * 60)
print("LTP TEST")
print("=" * 60)

try:

    ltp = market.get_ltp("TCS")

    print()
    print("TCS LTP")
    print(ltp)

except Exception as e:

    print()
    print("ERROR")
    print(e)