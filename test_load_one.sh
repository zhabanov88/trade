#!/bin/bash
set -eu

CH="clickhouse-client --host bot32.app --port 9000 --user default --password CL4ICLIsdf4HOUOUSE"
PROVIDER_ID=1

mapfile -t FILES < <(find /projects/base/csv/global_forex/quotes_v1 -name "*.csv.gz" | sort)
FILE="${FILES[0]}"
echo "File: $FILE"

$CH --query "TRUNCATE TABLE _staging_forex"
echo "Staging truncated"

zcat "$FILE" | $CH --query "INSERT INTO _staging_forex FORMAT CSVWithNames"
STAGING_COUNT=$($CH --query "SELECT count() FROM _staging_forex")
echo "Staging loaded: $STAGING_COUNT rows"

$CH --query "
INSERT INTO raw_market_data
SELECT
    s.ticker,
    fromUnixTimestamp64Nano(s.participant_timestamp),
    $PROVIDER_ID AS provider_id,
    toDecimal128((s.ask_price + s.bid_price) / 2, 18) AS price,
    toDecimal128(0, 18) AS size,
    concat(
        '{\"bid_price\":', toString(s.bid_price),
        ',\"ask_price\":', toString(s.ask_price),
        ',\"bid_exchange\":', toString(s.bid_exchange),
        ',\"ask_exchange\":', toString(s.ask_price), '}'
    ) AS extra,
    row_number() OVER (PARTITION BY s.ticker ORDER BY s.participant_timestamp)
        + ifNull(o.max_idx, toUInt64(0)) AS tick_index
FROM _staging_forex AS s
LEFT JOIN (
    SELECT ticker, max(tick_index) AS max_idx
    FROM raw_market_data
    WHERE provider_id = $PROVIDER_ID
    GROUP BY ticker
) AS o ON s.ticker = o.ticker
"
echo "INSERT done"

RAW_COUNT=$($CH --query "SELECT count() FROM raw_market_data")
echo "raw_market_data: $RAW_COUNT rows"

echo "--- tick_index sample ---"
$CH --query "SELECT ticker, min(tick_index), max(tick_index), count() FROM raw_market_data GROUP BY ticker ORDER BY ticker LIMIT 5"

echo "--- candles_1m check ---"
$CH --query "SELECT count() FROM candles_1m"
