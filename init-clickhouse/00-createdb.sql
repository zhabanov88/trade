CREATE TABLE default.market_data_minute
(
    ticker String,
    volume Int64,
    open Decimal(18, 8),
    close Decimal(18, 8),
    high Decimal(18, 8),
    low Decimal(18, 8),
    window_start DateTime64(3, 'UTC'),
    transactions Int32,
    granularity String,
    bullish_imbalance Int16,
    bearish_imbalance Int16,
	swing_high Int16,
	swing_low Int16,
	vwap Int16,
	tr Decimal(18, 8),
	smaatr Decimal(18, 8),
	emaatr Decimal(18, 8),
	stoploss Decimal(18, 8),
	takeprofit Decimal(18, 8)
)
ENGINE = MergeTree()
ORDER BY (ticker, window_start);