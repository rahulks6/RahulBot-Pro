"""
============================================================
RahulBot Pro v9
Multi-threaded Scanner Engine
============================================================
"""

from concurrent.futures import ThreadPoolExecutor, as_completed

from history.history import History

from indicators.ema import EMA
from indicators.rsi import RSI
from indicators.atr import ATR
from indicators.macd import MACD
from indicators.volume import Volume

from ranking.ranking import RankingEngine
from scanner.progress import Progress


class Scanner:

    def __init__(self, workers=8):

        self.history = History()

        self.workers = workers

    def scan_stock(self, symbol):

        candles = self.history.daily(symbol, 120)

        ema20 = EMA.latest(candles, 20)
        ema50 = EMA.latest(candles, 50)

        rsi = RSI.latest(candles)

        atr = ATR.latest(candles)

        macd = MACD.latest(candles)

        volume_ratio = Volume.ratio(candles)

        stock = {

            "symbol": symbol,

            "ema20": ema20,

            "ema50": ema50,

            "rsi": rsi,

            "atr": atr,

            "macd": macd,

            "volume_ratio": volume_ratio

        }

        ranking = RankingEngine.score(stock)

        return {

            "symbol": symbol,

            "score": ranking["score"],

            "trend": ranking["trend"],

            "momentum": ranking["momentum"],

            "volatility": ranking["volatility"],

            "volume": ranking["volume"],

            "confidence": ranking["confidence"],

            "ema20": ema20,

            "ema50": ema50,

            "rsi": rsi,

            "atr": atr,

            "macd": macd,

            "volume_ratio": volume_ratio,

            "reasons": ranking["reasons"]

        }

    def scan(self, symbols):

        results = []

        total = len(symbols)

        completed = 0

        with ThreadPoolExecutor(max_workers=self.workers) as executor:

            futures = {

                executor.submit(
                    self.scan_stock,
                    symbol
                ): symbol

                for symbol in symbols

            }

            for future in as_completed(futures):

                completed += 1

                Progress.show(completed, total)

                try:

                    results.append(

                        future.result()

                    )

                except Exception:

                    continue

        results.sort(

            key=lambda x: x["score"],

            reverse=True

        )

        print()

        return results