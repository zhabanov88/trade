#!/bin/bash
set -euo pipefail

CH_HOST="bot32.app"
CH_PORT="9000"
CH_USER="default"
CH_PASS="CL4ICLIsdf4HOUOUSE"
CH="clickhouse-client --host $CH_HOST --port $CH_PORT --user $CH_USER --password $CH_PASS"

PROVIDER_ID="${FOREX_PROVIDER_ID:-1}"
DATA_DIR="/projects/base/csv/global_forex/quotes_v1"
LOG_FILE="/projects/base/forex_done_v2.log"
OUTPUT_LOG="/projects/base/forex_output_v2.log"

touch "$LOG_FILE"

mapfile -t FILE_LIST < <(find "$DATA_DIR" -name "*.csv.gz" | sort)
TOTAL=${#FILE_LIST[@]}
COUNT=0
LOADED=0
SKIPPED=0
GLOBAL_START=$(date +%s)

echo "$(date '+%Y-%m-%d %H:%M:%S') Начало загрузки: $TOTAL файлов, provider_id=$PROVIDER_ID" | tee -a "$OUTPUT_LOG"

for FILE in "${FILE_LIST[@]}"; do
	BASENAME=$(basename "$FILE")
	COUNT=$((COUNT + 1))

	# Resume: пропуск уже загруженных
	if grep -qF "$BASENAME" "$LOG_FILE" 2>/dev/null; then
		SKIPPED=$((SKIPPED + 1))
		continue
	fi

	START=$(date +%s)

	# 1. Очистить staging
	$CH --query "TRUNCATE TABLE _staging_forex"

	# 2. Загрузить CSV в staging
	zcat "$FILE" | $CH --query "INSERT INTO _staging_forex FORMAT CSVWithNames"

	# 3. Перелить в raw_market_data с tick_index
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
            ',\"ask_exchange\":', toString(s.ask_exchange), '}'
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

	END=$(date +%s)
	ELAPSED=$((END - START))
	LOADED=$((LOADED + 1))

	# ETA
	TOTAL_ELAPSED=$((END - GLOBAL_START))
	AVG=$((TOTAL_ELAPSED / LOADED))
	REMAINING=$(((TOTAL - COUNT) * AVG / 60))

	echo "$BASENAME" >>"$LOG_FILE"
	echo "$(date '+%Y-%m-%d %H:%M:%S') [$COUNT/$TOTAL] $BASENAME — ${ELAPSED}s (ETA: ${REMAINING}min)" | tee -a "$OUTPUT_LOG"
done

# Cleanup
$CH --query "DROP TABLE IF EXISTS _staging_forex"

TOTAL_TIME=$((($(date +%s) - GLOBAL_START) / 60))
ROWS=$($CH --query "SELECT count() FROM raw_market_data WHERE provider_id = $PROVIDER_ID")
echo "$(date '+%Y-%m-%d %H:%M:%S') Загрузка завершена: $LOADED файлов за ${TOTAL_TIME}min, $ROWS строк (пропущено: $SKIPPED)" | tee -a "$OUTPUT_LOG"
