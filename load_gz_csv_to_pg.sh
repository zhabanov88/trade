#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

START_DIR="${1:-}"
if [[ -z "${START_DIR}" || ! -d "${START_DIR}" ]]; then
  echo "Usage: $0 /path/to/start_folder"
  exit 1
fi

: "${PGDATABASE:?Need PGDATABASE}"
: "${PGUSER:?Need PGUSER}"
: "${PGHOST:=localhost}"
: "${PGPORT:=5432}"

ALLOW_RELOAD="${ALLOW_RELOAD:-0}"


sha256_file() {
  local f="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" | awk '{print $1}'
  else
    shasum -a 256 "$f" | awk '{print $1}'
  fi
}

psql_exec() {
  psql -v ON_ERROR_STOP=1 -X -q "$@"
}

# SQL literal via Postgres quote_literal (returns quoted string), NULL if empty
sql_lit() {
  local val="${1-}"
  if [[ -z "${val}" ]]; then
    echo "NULL"
  else
    psql_exec -t -A -c "SELECT quote_literal(${val@Q});" | tr -d '[:space:]'
  fi
}

# for \copy FROM 'file' we must embed a single-quoted string ourselves
# (psql meta-command, not SQL, so quote_literal() not available there)
psql_sq() {
  local s="${1-}"
  # escape single quotes for psql \copy: ' -> ''
  s="${s//\'/\'\'}"
  printf "'%s'" "$s"
}

sql_int() {
  local val="${1-}"
  if [[ -z "${val}" ]]; then
    echo "NULL"
  elif [[ "${val}" =~ ^-?[0-9]+$ ]]; then
    echo "${val}"
  else
    echo "NULL"
  fi
}

sql_bool() {
  local val="${1-0}"
  if [[ "${val}" == "1" ]]; then echo "TRUE"; else echo "FALSE"; fi
}

# --- schema ---
psql_exec -c "
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

CREATE TABLE IF NOT EXISTS ingest_files (
  id SERIAL PRIMARY KEY,
  source_gz_path TEXT NOT NULL,
  extracted_csv_name TEXT,
  gz_size_bytes BIGINT,
  gz_mtime TIMESTAMPTZ,
  gz_sha256 TEXT,
  loaded_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'NEW',
  rows_loaded BIGINT DEFAULT 0,
  last_error TEXT,
  allow_reload BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS ingest_files_unique (
  source_gz_path TEXT NOT NULL,
  extracted_csv_name TEXT NOT NULL,
  PRIMARY KEY (source_gz_path, extracted_csv_name)
);

CREATE UNLOGGED TABLE IF NOT EXISTS market_data_stage (
  ticker TEXT,
  volume BIGINT,
  open NUMERIC,
  close NUMERIC,
  high NUMERIC,
  low NUMERIC,
  window_start_ns BIGINT,
  transactions INT
);
"

# Create unique constraint if not exists (for old PG compatibility)
psql_exec -c "
DO \$\$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'ingest_files_unique_key'
  ) THEN
    ALTER TABLE ingest_files ADD CONSTRAINT ingest_files_unique_key 
    UNIQUE (source_gz_path, extracted_csv_name);
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- Ignore if constraint already exists
  NULL;
END \$\$;
" 2>/dev/null || true

find "$START_DIR" -type f -name "*.gz" -print0 |
while IFS= read -r -d '' GZ; do
  if ! gzip -t "$GZ" >/dev/null 2>&1; then
    echo "SKIP (not valid gzip): $GZ"
    continue
  fi

  GZ_SIZE="$(stat -c%s "$GZ" 2>/dev/null || stat -f%z "$GZ")"
  MTIME_EPOCH="$(stat -c%Y "$GZ" 2>/dev/null || stat -f%m "$GZ")"
  GZ_SHA="$(sha256_file "$GZ")"

  CSV_NAME="$(basename "${GZ%.gz}")"
  SOURCE_PATH="$GZ"

  SOURCE_PATH_LIT="$(sql_lit "$SOURCE_PATH")"
  CSV_NAME_LIT="$(sql_lit "$CSV_NAME")"
  GZ_SHA_LIT="$(sql_lit "$GZ_SHA")"
  GZ_SIZE_SQL="$(sql_int "$GZ_SIZE")"
  MTIME_EPOCH_SQL="$(sql_int "$MTIME_EPOCH")"
  ALLOW_RELOAD_SQL="$(sql_bool "$ALLOW_RELOAD")"

  # Upsert ingest_files using UPDATE + INSERT pattern
  UPDATED_COUNT="$(psql_exec -t -A -c "
UPDATE ingest_files
SET gz_size_bytes = $GZ_SIZE_SQL,
    gz_mtime      = to_timestamp($MTIME_EPOCH_SQL),
    gz_sha256     = $GZ_SHA_LIT
WHERE source_gz_path = $SOURCE_PATH_LIT
  AND extracted_csv_name = $CSV_NAME_LIT;

SELECT 1;
" 2>/dev/null | tail -1 | tr -d '[:space:]')"

  # Insert only if UPDATE didn't affect any rows
  psql_exec -c "
INSERT INTO ingest_files (source_gz_path, extracted_csv_name, gz_size_bytes, gz_mtime, gz_sha256, status, allow_reload)
SELECT
  $SOURCE_PATH_LIT,
  $CSV_NAME_LIT,
  $GZ_SIZE_SQL,
  to_timestamp($MTIME_EPOCH_SQL),
  $GZ_SHA_LIT,
  'NEW',
  $ALLOW_RELOAD_SQL
WHERE NOT EXISTS (
  SELECT 1
  FROM ingest_files
  WHERE source_gz_path = $SOURCE_PATH_LIT
    AND extracted_csv_name = $CSV_NAME_LIT
);
" 2>/dev/null || true

  SHOULD_SKIP="$(
    psql_exec -t -A -c "
SELECT CASE
  WHEN EXISTS (
    SELECT 1
    FROM ingest_files
    WHERE source_gz_path = $SOURCE_PATH_LIT
      AND extracted_csv_name = $CSV_NAME_LIT
      AND status = 'LOADED'
      AND (allow_reload IS FALSE OR allow_reload = FALSE)
  ) THEN '1' ELSE '0' END;
" | tr -d '[:space:]'
  )"

  if [[ "$SHOULD_SKIP" == "1" ]] && [[ "$ALLOW_RELOAD" == "0" ]]; then
    echo "SKIP (already loaded): $GZ"
    continue
  fi

  echo "LOAD: $GZ"

  TMPDIR="$(mktemp -d)"
  TMPCSV="$TMPDIR/$CSV_NAME"

  cleanup() { rm -rf "$TMPDIR"; }
  trap cleanup RETURN

  if ! gzip -dc "$GZ" > "$TMPCSV"; then
    echo "FAIL decompress: $GZ"
    ERR_LIT="$(sql_lit "decompress failed")"
    psql_exec -c "
UPDATE ingest_files
SET status='ERROR', last_error=$ERR_LIT
WHERE source_gz_path=$SOURCE_PATH_LIT
  AND extracted_csv_name=$CSV_NAME_LIT;
" >/dev/null || true
    continue
  fi

  HEADER="$(head -n 1 "$TMPCSV" | tr -d '\r')"
  if [[ "$HEADER" != "ticker,volume,open,close,high,low,window_start,transactions" ]]; then
    echo "FAIL header mismatch: $GZ (got: $HEADER)"
    ERR_LIT="$(sql_lit "header mismatch")"
    psql_exec -c "
UPDATE ingest_files
SET status='ERROR', last_error=$ERR_LIT
WHERE source_gz_path=$SOURCE_PATH_LIT
  AND extracted_csv_name=$CSV_NAME_LIT;
" >/dev/null || true
    continue
  fi

  TMPCSV_PSQL="$(psql_sq "$TMPCSV")"

  set +e
  psql -v ON_ERROR_STOP=1 -X -q <<SQL
BEGIN;

TRUNCATE market_data_stage;

\\copy market_data_stage (ticker,volume,open,close,high,low,window_start_ns,transactions) FROM ${TMPCSV_PSQL} WITH (FORMAT csv, HEADER true, DELIMITER ',', QUOTE '"');

INSERT INTO market_data (ticker,volume,open,close,high,low,window_start,transactions)
SELECT
  ticker,
  volume,
  open,
  close,
  high,
  low,
  to_timestamp(window_start_ns / 1000000000.0),
  transactions
FROM market_data_stage;

UPDATE ingest_files
SET status='LOADED',
    loaded_at=now(),
    last_error=NULL,
    rows_loaded=(SELECT count(*) FROM market_data_stage)
WHERE source_gz_path=$SOURCE_PATH_LIT
  AND extracted_csv_name=$CSV_NAME_LIT;

COMMIT;
SQL
  RC=$?
  set -e

  if [[ $RC -ne 0 ]]; then
    echo "FAIL load: $GZ"
    ERR_LIT="$(sql_lit "psql load failed (see logs)")"
    psql_exec -c "
UPDATE ingest_files
SET status='ERROR', last_error=$ERR_LIT
WHERE source_gz_path=$SOURCE_PATH_LIT
  AND extracted_csv_name=$CSV_NAME_LIT;
" >/dev/null || true
    continue
  fi

  trap - RETURN
  rm -rf "$TMPDIR"
done

echo "Done."