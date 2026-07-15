"""
============================================================
RahulBot Pro v7
Market Cache
============================================================
"""

import threading
import time


class MarketCache:
    """
    Thread-safe quote cache.

    Stores:
        Symbol
        Quote
        Timestamp

    Automatically expires entries after TTL.
    """

    def __init__(self, ttl=1.0):

        self.ttl = ttl

        self._cache = {}

        self._lock = threading.Lock()

        self.cache_hits = 0

        self.cache_misses = 0

        self.api_calls = 0

    def get(self, symbol):

        with self._lock:

            item = self._cache.get(symbol)

            if item is None:

                self.cache_misses += 1

                return None

            age = time.time() - item["timestamp"]

            if age > self.ttl:

                del self._cache[symbol]

                self.cache_misses += 1

                return None

            self.cache_hits += 1

            return item["quote"]

    def set(self, symbol, quote):

        with self._lock:

            self._cache[symbol] = {

                "quote": quote,

                "timestamp": time.time()

            }

            self.api_calls += 1

    def clear(self):

        with self._lock:

            self._cache.clear()

    def remove(self, symbol):

        with self._lock:

            self._cache.pop(symbol, None)

    def stats(self):

        with self._lock:

            total = self.cache_hits + self.cache_misses

            hit_rate = 0.0

            if total:

                hit_rate = round(
                    (self.cache_hits / total) * 100,
                    2
                )

            return {

                "cache_size": len(self._cache),

                "cache_hits": self.cache_hits,

                "cache_misses": self.cache_misses,

                "api_calls": self.api_calls,

                "hit_rate": hit_rate

            }

    def __len__(self):

        return len(self._cache)