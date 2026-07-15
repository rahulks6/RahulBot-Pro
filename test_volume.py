"""
============================================================
RahulBot Pro v8
Volume Test
============================================================
"""

from history.history import History
from indicators.volume import Volume

history = History()

candles = history.daily("TCS", 60)

print("=" * 60)
print("VOLUME TEST")
print("=" * 60)

print()

print("Latest Volume")
print(Volume.latest(candles))

print()

print("20 Day Average")
print(round(Volume.average(candles), 0))

print()

print("Volume Ratio")
print(round(Volume.ratio(candles), 2), "x")