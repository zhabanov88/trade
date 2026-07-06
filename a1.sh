#!/bin/bash
CH="docker exec clickhouse_container clickhouse-client --port 9000"
OUT="/tmp/diag_rangebar.txt"
echo "=== Range-Bar Диагностика ===" > "$OUT"
echo "Время: $(date)" >> "$OUT"

echo "" >> "$OUT"
echo "--- 1. Тики ESU6: всего vs в сессию ---" >> "$OUT"
$CH --query "
SELECT
    count() AS total_ticks,
    countIf(toHour(participant_timestamp) >= 14 AND toHour(participant_timestamp) < 21
            AND toDayOfWeek(participant_timestamp) BETWEEN 1 AND 5) AS weekday_session_ticks
FROM default.raw_market_data
WHERE provider_id = 200 AND ticker = 'ESU6'
  AND toDate(participant_timestamp) >= '2026-01-01'
  AND toDate(participant_timestamp) <= '2026-07-10'
FORMAT PrettyCompact" >> "$OUT" 2>&1

echo "" >> "$OUT"
echo "--- 2. Тики ESU6 по часам UTC ---" >> "$OUT"
$CH --query "
SELECT toHour(participant_timestamp) AS hour_utc, count() AS ticks
FROM default.raw_market_data
WHERE provider_id = 200 AND ticker = 'ESU6'
  AND toDate(participant_timestamp) >= '2026-01-01'
  AND toDate(participant_timestamp) <= '2026-07-10'
GROUP BY hour_utc ORDER BY hour_utc
FORMAT PrettyCompact" >> "$OUT" 2>&1

echo "" >> "$OUT"
echo "--- 3. Диапазон цены за день (ожидаемые range-бары) ---" >> "$OUT"
$CH --query "
SELECT
    toDate(participant_timestamp) AS d,
    count() AS ticks,
    round(min(toFloat64(price)),2) AS low,
    round(max(toFloat64(price)),2) AS high,
    round(max(toFloat64(price)) - min(toFloat64(price)), 2) AS day_range,
    floor((max(toFloat64(price)) - min(toFloat64(price))) / 10) AS bars_10pts
FROM default.raw_market_data
WHERE provider_id = 200 AND ticker = 'ESU6'
  AND toHour(participant_timestamp) >= 14 AND toHour(participant_timestamp) < 21
  AND toDayOfWeek(participant_timestamp) BETWEEN 1 AND 5
  AND toDate(participant_timestamp) >= '2026-01-01'
  AND toDate(participant_timestamp) <= '2026-07-10'
GROUP BY d ORDER BY d LIMIT 20
FORMAT PrettyCompact" >> "$OUT" 2>&1

echo "" >> "$OUT"
echo "--- 4. GEX по часам UTC ---" >> "$OUT"
$CH --query "
SELECT
    toHour(participant_timestamp) AS hour_utc,
    count() AS records,
    round(avg(toFloat64(JSONExtractFloat(extra, 'sum_gex_vol'))), 0) AS avg_gex_vol,
    round(avg(toFloat64(JSONExtractFloat(extra, 'zero_gamma'))), 2) AS avg_zero_gamma
FROM default.raw_market_data
WHERE provider_id = 100 AND ticker = 'SPX_classic_gex_zero'
  AND toDate(participant_timestamp) >= '2026-01-01'
  AND toDate(participant_timestamp) <= '2026-07-10'
GROUP BY hour_utc ORDER BY hour_utc
FORMAT PrettyCompact" >> "$OUT" 2>&1

echo "" >> "$OUT"
echo "--- 5. Условие ④: sum_gex_vol >= -4000 (% дней когда проходит) ---" >> "$OUT"
$CH --query "
SELECT
    toDate(participant_timestamp) AS d,
    count() AS total_gex,
    countIf(toFloat64(JSONExtractFloat(extra, 'sum_gex_vol')) >= -4000) AS pass_cond4,
    round(avg(toFloat64(JSONExtractFloat(extra, 'sum_gex_vol'))), 0) AS avg_gex_vol,
    round(min(toFloat64(JSONExtractFloat(extra, 'sum_gex_vol'))), 0) AS min_gex_vol,
    round(max(toFloat64(JSONExtractFloat(extra, 'sum_gex_vol'))), 0) AS max_gex_vol
FROM default.raw_market_data
WHERE provider_id = 100 AND ticker = 'SPX_classic_gex_zero'
  AND toHour(participant_timestamp) >= 14 AND toHour(participant_timestamp) < 21
  AND toDate(participant_timestamp) >= '2026-01-01'
  AND toDate(participant_timestamp) <= '2026-07-10'
GROUP BY d ORDER BY d LIMIT 20
FORMAT PrettyCompact" >> "$OUT" 2>&1

echo "" >> "$OUT"
echo "--- 6. Условие ⑤: price < zero_gamma - 5 (% тиков когда проходит) ---" >> "$OUT"
$CH --query "
SELECT
    toDate(t.participant_timestamp) AS d,
    count() AS bearish_candidates,
    countIf(toFloat64(t.price) < toFloat64(JSONExtractFloat(g.extra, 'zero_gamma')) - 5) AS pass_cond5,
    round(avg(toFloat64(JSONExtractFloat(g.extra, 'zero_gamma')) - toFloat64(t.price)), 2) AS avg_dist_from_zgamma
FROM default.raw_market_data t
CROSS JOIN (
    SELECT
        toDate(participant_timestamp) AS gd,
        avg(toFloat64(JSONExtractFloat(extra, 'zero_gamma'))) AS zero_gamma
    FROM default.raw_market_data
    WHERE provider_id = 100 AND ticker = 'SPX_classic_gex_zero'
      AND toDate(participant_timestamp) >= '2026-01-01'
    GROUP BY gd
) g ON toDate(t.participant_timestamp) = g.gd
WHERE t.provider_id = 200 AND t.ticker = 'ESU6'
  AND toHour(t.participant_timestamp) >= 14 AND toHour(t.participant_timestamp) < 21
  AND toDate(t.participant_timestamp) >= '2026-01-01'
  AND toDate(t.participant_timestamp) <= '2026-01-10'
GROUP BY d ORDER BY d
FORMAT PrettyCompact" >> "$OUT" 2>&1

echo "" >> "$OUT"
echo "=== ГОТОВО ===" >> "$OUT"
cat "$OUT"
echo ""
echo "Сохранено в $OUT"