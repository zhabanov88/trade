import json
import string
import time
from ib_insync import *
from tqdm import tqdm

def get_complete_market_data():
    ib = IB()
    try:
        # clientId=80 для новой чистой сессии
        ib.connect('127.0.0.1', 7496, clientId=80)
    except Exception as e:
        print(f"❌ Ошибка подключения: {e}")
        return

    all_data = {
        'FUT': [],    # Фьючерсы
        'CASH': [],   # Валютные пары
        'CRYPTO': [], # Крипта
        'STK': [],    # Акции
        'IND': []     # Индексы
    }
    seen_conids = set()

    print("\n" + "="*50)
    print("🚀 СТАРТ КОМПЛЕКСНОГО СБОРА ДАННЫХ")
    print("="*50)

    # --- ЭТАП 1: ФЬЮЧЕРСЫ (ПЕРВЫМ ДЕЛОМ) ---
    print("\n🚀 Этап 1: Сбор фьючерсов (Прямой запрос)...")
    fut_configs = [
        ('CL', 'NYMEX'), ('GC', 'COMEX'), ('NG', 'NYMEX'),
        ('ES', 'CME'),   ('NQ', 'CME'),   ('YM', 'CBOT'),
        ('HG', 'COMEX'), ('SI', 'COMEX'), ('BZ', 'ICEEU')
    ]

    for symbol, exchange in tqdm(fut_configs, desc="Futures"):
        try:
            contract = Future(symbol=symbol, exchange=exchange)
            details = ib.reqContractDetails(contract)
            if details:
                for d in details:
                    if d.contract.conId not in seen_conids:
                        seen_conids.add(d.contract.conId)
                        all_data['FUT'].append({
                            'symbol': d.contract.symbol,
                            'conId': d.contract.conId,
                            'expiry': d.contract.lastTradeDateOrContractMonth,
                            'exchange': d.contract.exchange
                        })
        except: continue
    print(f"✅ ЭТАП ЗАВЕРШЕН. Найдено фьючерсов: {len(all_data['FUT'])}")

    # --- ЭТАП 2: ВАЛЮТНЫЕ ПАРЫ (ТВОЙ СПИСОК 101 ПАРА) ---
    print("\n🚀 Этап 2: Сбор валютных пар (Твой список)...")
    pairs = [
        'USDJPY','USDCHF','USDCAD','USDSEK','USDNOK','USDDKK','USDHKD','USDSGD',
        'USDTRY','USDPLN','USDCZK','USDHUF','USDMXN','USDZAR','USDILS','USDCNH',
        'USDKRW','EURUSD','EURGBP','EURJPY','EURCHF','EURCAD','EURAUD','EURNZD',
        'EURSEK','EURNOK','EURDKK','EURHKD','EURSGD','EURTRY','EURPLN','EURCZK',
        'EURHUF','EURMXN','EURZAR','EURILS','EURCNH','GBPUSD','GBPJPY','GBPCHF',
        'GBPCAD','GBPAUD','GBPNZD','GBPSEK','GBPNOK','GBPDKK','GBPHKD','GBPSGD',
        'GBPTRY','GBPPLN','GBPCZK','GBPHUF','GBPMXN','GBPZAR','GBPCNH','CHFUSD',
        'CHFJPY','CHFSEK','CHFNOK','CHFDKK','CHFTRY','CHFPLN','CHFCZK','CHFHUF',
        'CHFZAR','CHFCNH','CADJPY','CADCHF','CADHKD','CADCNH','AUDUSD','AUDJPY',
        'AUDCHF','AUDCAD','AUDNZD','AUDHKD','AUDSGD','AUDZAR','AUDCNH','NZDUSD',
        'NZDJPY','NZDCHF','NZDCAD','SEKJPY','NOKJPY','NOKSEK','DKKJPY','DKKSEK',
        'DKKNOK','HKDJPY','SGDJPY','SGDHKD','SGDCNH','MXNJPY','ZARJPY','CNHJPY',
        'CNHHKD','KRWUSD','KRWEUR','KRWGBP'
    ]

    for p in tqdm(pairs, desc="Forex"):
        try:
            # Используем прямой объект Forex для надежности
            contract = Forex(p)
            details = ib.reqContractDetails(contract)
            for d in details:
                if d.contract.conId not in seen_conids:
                    seen_conids.add(d.contract.conId)
                    all_data['CASH'].append({
                        'symbol': d.contract.symbol,
                        'currency': d.contract.currency,
                        'pair': f"{d.contract.symbol}/{d.contract.currency}",
                        'conId': d.contract.conId
                    })
        except: continue
    print(f"✅ ЭТАП ЗАВЕРШЕН. Найдено валют: {len(all_data['CASH'])}")

    # --- ЭТАП 3: КРИПТА ---
    print("\n🚀 Этап 3: Сбор криптовалют...")
    crypto_list = ['BTC', 'ETH', 'LTC', 'BCH', 'SOL', 'MATIC']
    for c_sym in tqdm(crypto_list, desc="Crypto"):
        try:
            contract = Crypto(c_sym, 'PAXOS', 'USD')
            details = ib.reqContractDetails(contract)
            for d in details:
                if d.contract.conId not in seen_conids:
                    seen_conids.add(d.contract.conId)
                    all_data['CRYPTO'].append({
                        'symbol': d.contract.symbol, 'conId': d.contract.conId
                    })
        except: continue
    print(f"✅ ЭТАП ЗАВЕРШЕН. Найдено крипто: {len(all_data['CRYPTO'])}")

    # --- ЭТАП 4: АКЦИИ (ФИНАЛЬНЫЙ МАССИВ) ---
    print("\n🚀 Этап 4: Сбор акций (Алфавитный перебор)...")
    letters = string.ascii_uppercase
    queries = [a + b for a in letters for b in letters]

    for q in tqdm(queries, desc="Stocks"):
        try:
            matches = ib.reqMatchingSymbols(q)
            for m in matches:
                c = m.contract
                if c.conId not in seen_conids and c.secType in ['STK', 'IND']:
                    seen_conids.add(c.conId)
                    all_data[c.secType].append({
                        'symbol': c.symbol,
                        'conId': c.conId,
                        'exchange': c.primaryExchange or c.exchange
                    })
        except: continue
        # Небольшая пауза для стабильности API
        if queries.index(q) % 50 == 0: time.sleep(0.1)
    print(f"✅ ЭТАП ЗАВЕРШЕН. Найдено акций: {len(all_data['STK'])}")

    # --- СОХРАНЕНИЕ ---
    filename = 'ibkr_final_report.json'
    with open(filename, 'w', encoding='utf-8') as f:
        json.dump(all_data, f, indent=4, ensure_ascii=False)

    print("\n" + "="*50)
    print(f"📊 ИТОГОВАЯ СТАТИСТИКА (Файл: {filename})")
    print(f" - Фьючерсы (FUT):   {len(all_data['FUT'])}")
    print(f" - Валюты (CASH):    {len(all_data['CASH'])}")
    print(f" - Крипта (CRYPTO):  {len(all_data['CRYPTO'])}")
    print(f" - Акции (STK):      {len(all_data['STK'])}")
    print(f" - Индексы (IND):    {len(all_data['IND'])}")
    print("="*50)

    ib.disconnect()

if __name__ == "__main__":
    get_complete_market_data()