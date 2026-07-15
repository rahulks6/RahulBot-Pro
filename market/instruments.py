"""
============================================================
RahulBot Pro v5
Instrument Manager
============================================================
"""

import csv
import os


class InstrumentManager:

    def __init__(self):

        self.instruments = {}

    def load(self):

        path = os.path.join(
            "data",
            "instrument_master.csv"
        )

        if not os.path.exists(path):

            raise FileNotFoundError(
                "instrument_master.csv not found inside data folder."
            )

        self.instruments.clear()

        with open(path, encoding="utf-8") as file:

            reader = csv.DictReader(file)

            for row in reader:

                try:

                    if row["EXCH_ID"] != "NSE":
                        continue

                    if row["SEGMENT"] != "E":
                        continue

                    if row["SERIES"] != "EQ":
                        continue

                    symbol = row["UNDERLYING_SYMBOL"].strip().upper()

                    if not symbol:
                        continue

                    self.instruments[symbol] = {

                        "security_id": int(row["SECURITY_ID"]),

                        "company": row["SYMBOL_NAME"],

                        "display_name": row["DISPLAY_NAME"]

                    }

                except Exception:

                    continue

        print(f"✅ Loaded {len(self.instruments)} NSE Equity Stocks")

    def get_security_id(self, symbol):

        symbol = symbol.upper()

        if symbol not in self.instruments:

            raise Exception(f"{symbol} not found.")

        return self.instruments[symbol]["security_id"]

    def get_company(self, symbol):

        symbol = symbol.upper()

        if symbol not in self.instruments:

            raise Exception(f"{symbol} not found.")

        return self.instruments[symbol]["company"]

    def get_display_name(self, symbol):

        symbol = symbol.upper()

        if symbol not in self.instruments:

            raise Exception(f"{symbol} not found.")

        return self.instruments[symbol]["display_name"]

    def get_all_symbols(self):

        return sorted(self.instruments.keys())