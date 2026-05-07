from ib_insync import *
from datetime import datetime, UTC
from clickhouse.connect import ClickHouseDB
from matrix.matrix import MatrixClient
import pytz
import json
import threading
import time
import math
import asyncio

class TickCollector:
    GRAY = "\033[90m"
    GREEN = "\033[92m"
    RESET = "\033[0m"

    def __init__(self, pairs, provider_id=5):
        self.ib = IB()
        self.db = ClickHouseDB()
        self.pairs = pairs
        self.provider = provider_id

        self.buffer = []
        self.buffer_lock = threading.Lock()

        self.tick_index = self.get_max_tick_index()
        self.last_tick_time = None
        self.connected = False

        self.matrix = MatrixClient(
            homeserver="https://matrix.bot32.app",
            user_id="@notifications:matrix.bot32.app",
            password="Not1f_Matr1x_2026!",
            session_file="matrix_session.json"
        )
        self.matrix_rooms = [
            '!KdzTZJgINoovUFlzlD:matrix.bot32.app',
            '!aIlwvnMndtqeDKshdm:matrix.bot32.app'
        ]

        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self._start_matrix_loop, daemon=True).start()

    def _start_matrix_loop(self):
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_until_complete(self.matrix.login())
        except Exception as e:
            print(f"Matrix login error: {e}")
        self.loop.run_forever()

    def send_matrix(self, msg: str):
        for room in self.matrix_rooms:
            asyncio.run_coroutine_threadsafe(
                self.matrix.send_message(room, msg),
                self.loop
            )

    def get_max_tick_index(self):
        try:
            result = self.db.client.execute("""
                SELECT max(tick_index)
                FROM raw_market_data
                WHERE provider_id = %(provider_id)s
            """, {"provider_id": self.provider})
            return result[0][0] if result and result[0][0] is not None else 0
        except Exception:
            return 0

    def get_symbol(self, contract):
        """Корректно получаем символ для любого типа контракта."""
        if contract.localSymbol:
            return contract.localSymbol
        if contract.secType == 'CASH':
            return f"{contract.symbol}{contract.currency}"
        return contract.symbol or "UNKNOWN"

    def on_disconnected(self, ib_obj=None):
        """Обработчик события разрыва связи с правильной сигнатурой"""
        print(f"{self.GRAY}[IB] Соединение потеряно (TWS закрыт). Остановка loop...{self.RESET}")
        self.connected = False
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                loop.stop()
        except Exception as e:
            print(f"Ошибка при попытке остановить loop1: {e}")

    def save_tick(self, t):
        self.last_tick_time = time.time()
        bid, ask = t.bid, t.ask

        if bid is None or ask is None or not math.isfinite(bid) or not math.isfinite(ask) or bid <= 0 or ask <= 0:
            return

        symbol = self.get_symbol(t.contract)

        self.tick_index += 1
        ts = datetime.now(UTC)

        extra = {
            'pair': symbol,
            'bid': bid, 'ask': ask,
            'bidSize': t.bidSize, 'askSize': t.askSize,
            'last': getattr(t, 'last', None),
            'volume': getattr(t, 'volume', None),
            'time': str(t.time),
        }

        row = (
            symbol.replace(".", ""),
            ts, self.provider, float(bid), float(t.bidSize or 0),
            json.dumps(extra, default=str), self.tick_index,
        )

        with self.buffer_lock:
            self.buffer.append(row)

    def flush_loop(self):
        while True:
            time.sleep(10)
            with self.buffer_lock:
                if not self.buffer: continue
                batch = self.buffer.copy()
                self.buffer.clear()

            inserted = False
            while not inserted:
                try:
                    self.db.client.execute("""
                        INSERT INTO raw_market_data
                        (ticker, participant_timestamp, provider_id, price, size, extra, tick_index)
                        VALUES
                    """, batch)

                    print(f"{self.GREEN}[CLICKHOUSE] inserted {len(batch)} rows{self.RESET}")
                    inserted = True
                except Exception as e:
                    print(f"{self.GRAY}[CLICKHOUSE RETRY] {e}{self.RESET}")
                    time.sleep(5)

    def _is_ib_trading_hours(self) -> bool:
        ny_tz = pytz.timezone("America/New_York")
        now_ny = datetime.now(ny_tz)
        weekday = now_ny.weekday()  # 0=пн, 4=пт, 5=сб, 6=вс
        hour = now_ny.hour

        # Суббота — всегда закрыто
        if weekday == 5:
            return False

        # Воскресенье — открытие в 17:00 NY
        if weekday == 6 and hour < 17:
            return False

        # Пятница — закрытие в 17:00 NY
        if weekday == 4 and hour >= 17:
            return False

        return True

    def watchdog(self):
        last_alert = 0
        was_down = False

        while True:
            time.sleep(5)

            # Вне торговых часов — не сигналим ни при каких условиях
            if not self._is_ib_trading_hours():
                self.last_tick_time = time.time()
                continue

            now = time.time()
            stale = self.last_tick_time and (now - self.last_tick_time > 30)

            if not self.connected or stale:
                was_down = True
                if now - last_alert >= 600:
                    msg = "❌ IB TWS недоступен" if not self.connected else f"⚠️ Тики замерли ({int(now - self.last_tick_time)} сек)"
                    self.send_matrix(msg)
                    last_alert = now

                if stale and self.connected:
                    print(f"{self.GRAY}[WATCHDOG] Force restart loop...{self.RESET}")
                    try:
                        self.ib.disconnect()
                        self.on_disconnected()
                    except: pass
            else:
                if was_down:
                    self.send_matrix("✅ Тики восстановлены")
                    was_down = False
                    last_alert = 0

    def run(self):
        threading.Thread(target=self.flush_loop, daemon=True).start()
        threading.Thread(target=self.watchdog, daemon=True).start()

        while True:
            try:
                print("Connecting to IB...")
                self.connected = False

                try: self.ib.disconnect()
                except: pass

                self.ib = IB()
                self.ib.disconnectedEvent += self.on_disconnected
                self.ib.pendingTickersEvent += lambda tickers: [self.save_tick(t) for t in tickers]

                self.ib.connect("127.0.0.1", 7497, clientId=1, timeout=15)
                print("Connected to IB")
                self.connected = True
                self.last_tick_time = time.time()

                for pair in self.pairs:
                    self.ib.reqMktData(Forex(pair), "", False, False)

                print("LIVE TICKS STARTED")
                self.ib.run()

            except Exception as e:
                print(f"{self.GRAY}[IB] Connection failed: {e}. Retry in 10s...{self.RESET}")

            finally:
                self.connected = False
                time.sleep(10)

if __name__ == "__main__":
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
        'CNHHKD','KRWEUR'
    ]
    collector = TickCollector(pairs=pairs, provider_id=5)
    collector.run()

#aatraderdub
#Betstostocks2221