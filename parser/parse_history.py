import argparse
import time
import pandas as pd
from datetime import datetime, timedelta, timezone
from ib_insync import *
from tqdm import tqdm

class HistoryDownloader:
    def __init__(self):
        self.ib = IB()

    def get_contract(self, symbol, sec_type):
        sec_type = sec_type.upper()
        if sec_type == 'FOREX':
            return Forex(symbol)
        elif sec_type == 'STK':
            return Stock(symbol, 'SMART', 'USD')
        elif sec_type == 'IND':
            # Для индексов часто нужен конкретный тикер (например, SPX, а не SP500)
            return Index(symbol, 'CBOE', 'USD')
        elif sec_type == 'CRYPTO':
            return Crypto(symbol, 'PAXOS', 'USD')
        else:
            return None

    def fetch(self, symbol, start_date, end_date, timeframe='1 min', sec_type='FOREX'):
        try:
            if start_date.tzinfo is None:
                start_date = start_date.replace(tzinfo=timezone.utc)
            if end_date.tzinfo is None:
                end_date = end_date.replace(tzinfo=timezone.utc)

            self.ib.connect('127.0.0.1', 7496, clientId=25)

            contract = self.get_contract(symbol, sec_type)
            if not contract:
                print(f"Error: Unknown security type {sec_type}")
                return

            qualified = self.ib.qualifyContracts(contract)
            if not qualified:
                print(f"Error: Contract {symbol} not found.")
                return

            current_end = end_date
            all_bars = []

            total_weeks = (end_date - start_date).days // 7 + 1
            pbar = tqdm(total=total_weeks, desc=f"Loading {symbol}", unit="wk")

            # Для акций и индексов используем TRADES вместо MIDPOINT (если есть подписка)
            what_to_show = 'TRADES' if sec_type in ['STK', 'IND'] else 'MIDPOINT'

            while current_end > start_date:
                duration = '1 W' if 'min' in timeframe else '1 M'
                end_str = current_end.strftime('%Y%m%d %H:%M:%S')

                bars = self.ib.reqHistoricalData(
                    contract,
                    endDateTime=end_str,
                    durationStr=duration,
                    barSizeSetting=timeframe,
                    whatToShow=what_to_show,
                    useRTH=True,
                    formatDate=1
                )

                if not bars:
                    break

                valid_bars = []
                for b in bars:
                    b_date = b.date
                    if not isinstance(b_date, datetime):
                        b_date = datetime.combine(b_date, datetime.min.time()).replace(tzinfo=timezone.utc)
                    if b_date >= start_date:
                        valid_bars.append(b)

                if not valid_bars and bars:
                    if bars[-1].date < start_date:
                        break

                all_bars.extend(valid_bars)
                pbar.update(1)

                oldest_date = bars[0].date
                if isinstance(oldest_date, datetime):
                    current_end = oldest_date
                else:
                    current_end = datetime.combine(oldest_date, datetime.min.time()).replace(tzinfo=timezone.utc)

                time.sleep(1.2)

            pbar.close()

            if all_bars:
                self.save_to_excel(symbol, all_bars, timeframe)
            else:
                print("No data received. Check your subscriptions.")

        except Exception as e:
            print(f"Error: {e}")
        finally:
            self.ib.disconnect()

    def save_to_excel(self, symbol, bars, timeframe):
        df = util.df(bars)
        df = df.sort_values(by='date', ascending=True)

        if 'date' in df.columns:
            df['date'] = pd.to_datetime(df['date']).dt.tz_localize(None)

        filename = f"{symbol}_{timeframe.replace(' ', '')}_history.xlsx"
        df.to_excel(filename, index=False, engine='openpyxl')

        print(f"File: {filename}")
        print(f"Range: {df['date'].iloc[0]} - {df['date'].iloc[-1]}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('symbol', help='Ticker symbol')
    parser.add_argument('--type', default='FOREX', choices=['FOREX', 'STK', 'IND', 'CRYPTO'], help='Security type')
    parser.add_argument('--years', type=int)
    parser.add_argument('--start')
    parser.add_argument('--end')
    parser.add_argument('--tf', default='1 min')

    args = parser.parse_args()

    end_dt = datetime.strptime(args.end, '%Y-%m-%d').replace(tzinfo=timezone.utc) if args.end else datetime.now(timezone.utc)

    if args.years:
        start_dt = end_dt - timedelta(days=365 * args.years)
    elif args.start:
        start_dt = datetime.strptime(args.start, '%Y-%m-%d').replace(tzinfo=timezone.utc)
    else:
        start_dt = end_dt - timedelta(days=7)

    loader = HistoryDownloader()
    loader.fetch(args.symbol, start_dt, end_dt, timeframe=args.tf, sec_type=args.type)