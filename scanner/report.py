"""
============================================================
RahulBot Pro v8
Scanner Report
============================================================
"""


class Report:

    @staticmethod
    def print(results, top=20):

        print()

        print("=" * 70)
        print("TOP OPPORTUNITIES")
        print("=" * 70)

        for i, stock in enumerate(results[:top], start=1):

            print()

            print(f"{i}. {stock['symbol']}")

            print(f"Overall Score : {stock['score']:.2f}")

            print(f"Confidence    : {stock['confidence']}")

            print()

            print(f"Trend         : {stock['trend']:.2f} / 30")

            print(f"Momentum      : {stock['momentum']:.2f} / 25")

            print(f"Volatility    : {stock['volatility']:.2f} / 10")

            print(f"Volume        : {stock['volume']:.2f} / 20")

            print()

            print(f"RSI           : {stock['rsi']:.2f}")

            print(f"EMA20         : {stock['ema20']:.2f}")

            print(f"EMA50         : {stock['ema50']:.2f}")

            print(f"ATR           : {stock['atr']:.2f}")

            print(f"Volume Ratio  : {stock['volume_ratio']:.2f}x")

            print()

            print("Reasons")

            for reason in stock["reasons"]:

                print(f"✓ {reason}")

            print("-" * 70)