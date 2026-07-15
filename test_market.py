"""
============================================================
RahulBot Pro v7
Market Service Test
============================================================
"""

from pprint import pprint

from market.market import Market


def main():

    market = Market()

    symbol = "TCS"

    print("=" * 60)
    print("RahulBot Pro Market Test")
    print("=" * 60)

    print(f"Symbol : {symbol}")

    print()

    print("LTP   :", market.get_ltp(symbol))
    print("OPEN  :", market.get_open(symbol))
    print("HIGH  :", market.get_high(symbol))
    print("LOW   :", market.get_low(symbol))
    print("CLOSE :", market.get_close(symbol))

    print()

    print("=" * 60)
    print("Cache Statistics")
    print("=" * 60)

    pprint(market.cache_stats())

    print()

    print("=" * 60)
    print("Second Run (Should Use Cache)")
    print("=" * 60)

    print("LTP   :", market.get_ltp(symbol))
    print("OPEN  :", market.get_open(symbol))
    print("HIGH  :", market.get_high(symbol))
    print("LOW   :", market.get_low(symbol))
    print("CLOSE :", market.get_close(symbol))

    print()

    pprint(market.cache_stats())

    print()

    print("=" * 60)
    print("Cache Test Complete")
    print("=" * 60)


if __name__ == "__main__":
    main()