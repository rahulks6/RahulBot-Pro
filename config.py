"""
============================================================
RahulBot Pro v7
Configuration
============================================================
"""

import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    """
    Global RahulBot Configuration
    """

    # ---------------------------------------------------------
    # Trading
    # ---------------------------------------------------------

    CAPITAL = 5000

    PAPER_MODE = True

    # ---------------------------------------------------------
    # Market Service
    # ---------------------------------------------------------

    # Quote cache validity (seconds)
    MARKET_CACHE_TTL = 1.0

    # API retry attempts
    MARKET_API_RETRIES = 3

    # Delay between retries (seconds)
    MARKET_RETRY_DELAY = 0.5

    # ---------------------------------------------------------
    # Dhan Credentials
    # ---------------------------------------------------------

    CLIENT_ID = os.getenv("DHAN_CLIENT_ID")

    ACCESS_TOKEN = os.getenv("DHAN_ACCESS_TOKEN")

    # ---------------------------------------------------------
    # Telegram
    # ---------------------------------------------------------

    TELEGRAM_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")

    TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")