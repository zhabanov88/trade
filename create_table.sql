CREATE TABLE IF NOT EXISTS market_data (
    ticker TEXT,
    volume BIGINT,
    open NUMERIC,
    close NUMERIC,
    high NUMERIC,
    low NUMERIC,
    window_start TIMESTAMPTZ,
    transactions INT
);