#!/bin/bash
set -euo pipefail

CH_HOST="bot32.app"
CH_PORT=9000
CH_USER="default"
CH_PASS="CL4ICLIsdf4HOUOUSE"
PROVIDER_ID=1
DATA_DIR="/projects/base/csv/global_forex/quotes_v1"
LOG_FILE="/projects/base/forex_load.log"
DONE_FILE="/projects/base/forex_done.log"

ch() {
	clickhouse-client --host "$CH_HOST" --port "$CH_PORT" --user "$CH_USER" --password "$CH_PASS" "$@"
}

# heredoc без кавычек: $PROVIDER_ID раскроется, одинарные кавычки — литеральные
read -r -d '' INSERT_QUERY <<ENDQUERY || true
INSERT INTO raw_market_data SELECT
    ticker,
    fromUnixTimestamp64Nano(participant_timestamp),
    toUInt32($PROVIDER_ID),
    toDecimal128((ask_price + bid_price) / 2, 18),
    toDecimal128(0, 18),
    concat('{"bid_price":', toString(bid_price), ',"ask_price":', toString(ask_price), ',"bid_exchange":', toString(bid_exchange), ',"ask_exchange":', toString(ask_exchange), '}')
FROM input('ticker String, ask_exchange UInt16, ask_price Float64, bid_exchange UInt16, bid_price Float64, participant_timestamp Int64')
FORMAT CSVWithNames
ENDQUERY

touch "$DONE_FILE"

mapfile -t FILES < <(find "$DATA_DIR" -name "*.csv.gz" | sort)
TOTAL=${#FILES[@]}
LOADED=0
SKIPPED=0
START_TS=$(date +%s)

echo "$(date '+%F %T') Начало загрузки: $TOTAL файлов" | tee -a "$LOG_FILE"

for FILE in "${FILES[@]}"; do
	BASENAME=$(basename "$FILE")

	if grep -qxF "$FILE" "$DONE_FILE" 2>/dev/null; then
		SKIPPED=$((SKIPPED + 1))
		continue
	fi

	LOADED=$((LOADED + 1))
	IDX=$((LOADED + SKIPPED))

	FILE_START=$(date +%s)

	if zcat "$FILE" | ch \
		--max_insert_block_size=1048576 \
		--input_format_parallel_parsing=1 \
		--query "$INSERT_QUERY" 2>>"$LOG_FILE"; then

		echo "$FILE" >>"$DONE_FILE"
		FILE_END=$(date +%s)
		ELAPSED=$((FILE_END - FILE_START))
		TOTAL_ELAPSED=$((FILE_END - START_TS))

		if [ "$IDX" -gt 0 ]; then
			REMAINING=$(((TOTAL - IDX) * TOTAL_ELAPSED / IDX))
			ETA_MIN=$((REMAINING / 60))
		else
			ETA_MIN=0
		fi

		echo "$(date '+%F %T') [$IDX/$TOTAL] $BASENAME — ${ELAPSED}s (ETA: ${ETA_MIN}min)" | tee -a "$LOG_FILE"
	else
		echo "$(date '+%F %T') ОШИБКА: $FILE" | tee -a "$LOG_FILE"
		echo "Для продолжения: bash /projects/base/load_forex.sh" | tee -a "$LOG_FILE"
		exit 1
	fi
done

TOTAL_ELAPSED=$(($(date +%s) - START_TS))
TOTAL_COUNT=$(ch --query "SELECT count() FROM raw_market_data WHERE provider_id = $PROVIDER_ID")
echo "$(date '+%F %T') Загрузка завершена: $LOADED файлов за $((TOTAL_ELAPSED / 60))min, $TOTAL_COUNT строк" | tee -a "$LOG_FILE"
