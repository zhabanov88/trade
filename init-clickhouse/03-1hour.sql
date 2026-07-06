1 hour

DROP VIEW IF EXISTS default.market_data_hourly;

CREATE MATERIALIZED VIEW default.market_data_hourly
ENGINE = MergeTree()
ORDER BY (ticker, window_start)
AS
SELECT
    ticker,
    toStartOfInterval(toTimeZone(window_start, 'America/New_York'), INTERVAL 1 hour) AS window_start,
    groupArray((open, window_start))[1].1 AS open, -- Первое значение Open
    max(high) AS high,
    min(low) AS low,
    groupArray((close, window_start))[-1].1 AS close, -- Последнее значение Close
    sum(volume) AS volume,
    sum(transactions) AS transactions
FROM default.market_data_minute
GROUP BY ticker, window_start;

-- Заполняем новую materialized view
INSERT INTO default.market_data_hourly
SELECT
    ticker,
    toStartOfInterval(toTimeZone(window_start, 'America/New_York'), INTERVAL 1 hour) AS window_start,
    groupArray((open, window_start))[1].1 AS open, -- Первое значение Open
    max(high) AS high,
    min(low) AS low,
    groupArray((close, window_start))[-1].1 AS close, -- Последнее значение Close
    sum(volume) AS volume,
    sum(transactions) AS transactions
FROM default.market_data_minute
GROUP BY ticker, window_start;