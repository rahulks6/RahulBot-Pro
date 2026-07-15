from market.market import Market

market = Market()

stocks = [
    "TCS",
    "RELIANCE",
    "INFY",
    "SBIN",
    "HDFCBANK"
]

for stock in stocks:

    print("\n" + "=" * 60)

    sid = market.instruments.get_security_id(stock)

    print("Symbol      :", stock)
    print("Security ID :", sid)

    response = market.broker.client.quote_data({
        "NSE_EQ": [sid]
    })

    print(response)