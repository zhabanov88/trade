INSERT INTO default.market_data
SELECT 
    ticker,
    volume,
    open,
    close,
    high,
    low,
    window_start,
    transactions,
    granularity,
    bullish_imbalance,
    bearish_imbalance
FROM postgresql(
    'magic.my:25432',
    'postgres',
    'market_data',
    'gpadmin',
    'GreenPlum',
    'public'
);