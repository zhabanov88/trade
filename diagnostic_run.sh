#!/bin/bash
CH="docker exec clickhouse_container clickhouse-client --port 9000"
OUT="/tmp/diag_extra.txt"

echo "=== ДИАГНОСТИКА extra поля ESU6 ===" > "$OUT"

echo "--- 1. Первые 5 строк ESU6 (extra полностью) ---" >> "$OUT"
$CH --query "
SELECT participant_timestamp, price, size, extra
FROM default.raw_market_data
WHERE provider_id = 200 AND ticker = 'ESU6'
ORDER BY participant_timestamp
LIMIT 5
FORMAT Vertical" >> "$OUT"

echo "" >> "$OUT"
echo "--- 2. Ключи в extra ---" >> "$OUT"
$CH --query "
SELECT JSONExtractKeys(extra) AS keys
FROM default.raw_market_data
WHERE provider_id = 200 AND ticker = 'ESU6'
LIMIT 3
FORMAT Vertical" >> "$OUT"

echo "" >> "$OUT"
echo "--- 3. bid/ask из extra ---" >> "$OUT"
$CH --query "
SELECT
    participant_timestamp,
    price,
    JSONExtractFloat(extra, 'bid')        AS bid,
    JSONExtractFloat(extra, 'ask')        AS ask,
    JSONExtractFloat(extra, 'bid_price')  AS bid_price,
    JSONExtractFloat(extra, 'ask_price')  AS ask_price,
    JSONExtractString(extra, 'side')      AS side,
    JSONExtractString(extra, 'aggressor') AS aggressor,
    JSONExtractString(extra, 'condition') AS condition,
    extra
FROM default.raw_market_data
WHERE provider_id = 200 AND ticker = 'ESU6'
ORDER BY participant_timestamp
LIMIT 10
FORMAT Vertical" >> "$OUT"

echo "" >> "$OUT"
echo "--- 4. 20 строк подряд чтобы увидеть движение цены ---" >> "$OUT"
$CH --query "
SELECT participant_timestamp, price, extra
FROM default.raw_market_data
WHERE provider_id = 200 AND ticker = 'ESU6'
ORDER BY participant_timestamp
LIMIT 20
FORMAT PrettyCompact" >> "$OUT"

cat "$OUT"