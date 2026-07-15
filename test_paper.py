"""
============================================================
RahulBot Pro v11
Paper Trading Test
============================================================
"""

from market.market import Market
from paper.paper_engine import PaperEngine

market = Market()

paper = PaperEngine(market)

trade = paper.buy(

    symbol="TCS",

    entry=2190,

    stop_loss=2175,

    target=2220,

    quantity=5

)

paper.monitor(trade)