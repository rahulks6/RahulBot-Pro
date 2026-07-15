"""
============================================================
RahulBot Pro v9
Multi-threaded Market Scanner
============================================================
"""

import time

from market.instruments import InstrumentManager
from scanner.scanner import Scanner
from scanner.report import Report


def main():

    start = time.time()

    # ------------------------------------------
    # Load Instrument Master
    # ------------------------------------------

    instruments = InstrumentManager()

    instruments.load()

    symbols = instruments.get_all_symbols()

    # ------------------------------------------
    # Initialize Scanner
    # ------------------------------------------

    scanner = Scanner(workers=8)

    print("=" * 70)
    print("RAHULBOT PRO v9")
    print("=" * 70)

    print()
    print(f"Scanning {len(symbols)} NSE Equity Stocks...")
    print(f"Workers : {scanner.workers}")
    print()

    # ------------------------------------------
    # Scan Market
    # ------------------------------------------

    results = scanner.scan(symbols)

    # ------------------------------------------
    # Display Report
    # ------------------------------------------

    Report.print(results, top=20)

    end = time.time()

    print()
    print("=" * 70)
    print("SCAN COMPLETE")
    print("=" * 70)
    print(f"Stocks Scanned : {len(symbols)}")
    print(f"Results Found  : {len(results)}")
    print(f"Time Taken     : {round(end - start, 2)} seconds")
    print("=" * 70)


if __name__ == "__main__":
    main()