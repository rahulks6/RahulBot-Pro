"""
============================================================
RahulBot Pro v10
Professional Risk Manager Test
============================================================
"""

from risk.risk_manager import RiskManager


trade = RiskManager.calculate(

    capital=10000,

    risk_percent=1,

    entry=1452,

    stop_loss=1433

)

print("=" * 60)
print("RISK MANAGER TEST")
print("=" * 60)
print()

for key, value in trade.items():

    print(f"{key:<18}: {value}")