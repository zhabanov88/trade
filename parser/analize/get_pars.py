from ib_insync import *
from collections import defaultdict
import time

HOST = "127.0.0.1"
PORT = 7496  # TWS/IB Gateway
CLIENT_ID = 12

ib = IB()
ib.connect(HOST, PORT, clientId=CLIENT_ID)

# Основные валюты
currencies = [
    'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD',
    'SEK', 'NOK', 'DKK', 'HKD', 'SGD', 'TRY', 'PLN', 'CZK',
    'HUF', 'MXN', 'ZAR', 'ILS', 'CNH', 'KRW'
]

pairs = []

for base in currencies:
    for quote in currencies:
        if base == quote:
            continue

        symbol = f"{base}{quote}"

        contract = Forex(f"{base}{quote}")

        try:
            details = ib.reqContractDetails(contract)

            if details:
                pairs.append({
                    "pair": symbol,
                    "exchange": details[0].contract.exchange,
                    "conId": details[0].contract.conId,
                    "localSymbol": details[0].contract.localSymbol,
                    "tradingClass": details[0].contract.tradingClass,
                })
                print(f"[OK] {symbol}")

            time.sleep(0.1)

        except Exception as e:
            print(f"[ERR] {symbol}: {e}")

# Убираем дубли
unique = {}
for p in pairs:
    unique[p["pair"]] = p

pairs = sorted(unique.values(), key=lambda x: x["pair"])

print("\n=== RESULT ===")
for p in pairs:
    print(p)

print(f"\nTOTAL: {len(pairs)}")

ib.disconnect()