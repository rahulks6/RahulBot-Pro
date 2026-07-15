from paper.enums import OrderSide, ExitReason
from paper.trade import Trade
from paper.logger import TradeLogger

trade = Trade(
    symbol="TCS",
    side=OrderSide.BUY,
    quantity=10,
    entry_price=100,
    stop_loss=95,
    target=110
)

trade.close(
    exit_price=110,
    reason=ExitReason.TARGET
)

logger = TradeLogger()

logger.log_trade(trade)

print("Trade logged successfully.")
print(logger.path)