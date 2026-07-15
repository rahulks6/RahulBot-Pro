"""
============================================================
RahulBot Pro v5
Dhan Broker
============================================================
"""

from dhanhq import DhanContext, dhanhq
from config import Config


class DhanBroker:

    def __init__(self):

        if not Config.CLIENT_ID:
            raise Exception("DHAN_CLIENT_ID missing in .env")

        if not Config.ACCESS_TOKEN:
            raise Exception("DHAN_ACCESS_TOKEN missing in .env")

        self.context = DhanContext(
            Config.CLIENT_ID,
            Config.ACCESS_TOKEN
        )

        self.client = dhanhq(self.context)

    def connect(self):

        try:

            response = self.client.get_fund_limits()

            if response["status"] == "success":

                print("✅ Connected to Dhan")

                return response["data"]

            raise Exception(response)

        except Exception as e:

            print("❌ Connection Failed")
            raise e