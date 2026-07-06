#!/bin/bash
set -euo pipefail

# Каталог с CSV-файлами по умолчанию
CSV_DIR="${1:-init-scripts}"

# Файл журнала загруженных файлов
LOG_FILE="$CSV_DIR/.loaded_files.log"

# Подключение к ClickHouse (настроить под вашу среду)
CLICKHOUSE_BASE="clickhouse-client --multiline --timeonserver"

FORMAT_QUERY="CREATE TABLE IF NOT EXISTS candlestick_data (
  ticker String,
  volume UInt64,
  open Float64,
  close Float64,
  high Float64,
  low Float64,
  window_start UInt64,
  transactions UInt64
) ENGINE = MergeTree()
ORDER BY (ticker, window_start);"

# Убедимся, что таблица существует
echo "Создание таблицы (если отсутствует):"
$CLICKHOUSE_BASE --query="$FORMAT_QUERY"

# Инициализируем журнал, если его ещё нет
if [ ! -f "$LOG_FILE" ]; then
  touch "$LOG_FILE"
fi

# Обрабатываем все CSV-файлы в каталоге
# 1) CSV файлы с заголовками
for f in "$CSV_DIR"/*.csv; do
  [ -e "$f" ] || continue

  # Пропустить, если файл уже загружен
  if grep -Fxq "$f" "$LOG_FILE"; then
    echo "Пропущено (уже загружено): $f"
    continue
  fi

  echo "Обрабатываю: $f"

  # Поскольку в файле есть заголовок, используем FORMAT CSVWithNames
  # и загружаем данные напрямую в таблицу.
  # Важно: столбцы в файле должны соответствовать порядку столбцов в таблице.
  if $CLICKHOUSE_BASE --query="INSERT INTO candlestick_data FORMAT CSVWithNames" < "$f"; then
    echo "$f" >> "$LOG_FILE"
    echo "Файл $f успешно загружен."
  else
    echo "Ошибка загрузки файла: $f" >&2
  fi
done

# 2) CSV.gz файлы
for gz in "$CSV_DIR"/*.csv.gz; do
  [ -e "$gz" ] || continue

  csv_path="${gz%.gz}"

  # Пропустить, если распакованный файл уже загружен
  if grep -Fxq "$csv_path" "$LOG_FILE"; then
    echo "Пропущено (уже загружено): $csv_path"
    continue
  fi

  echo "Распаковываю: $gz -> $csv_path"

  # Распаковать на лету в тот же каталог
  dir="$(dirname "$csv_path")"
  mkdir -p "$dir"

  if gunzip -c "$gz" > "$csv_path"; then
    # Загружаем распакованный CSV
    if $CLICKHOUSE_BASE --query="INSERT INTO candlestick_data FORMAT CSVWithNames" < "$csv_path"; then
      echo "$csv_path" >> "$LOG_FILE"
      echo "Файл $gz успешно распакован и загружен."
    else
      echo "Ошибка загрузки распакованного файла: $csv_path" >&2
    fi
  else
    echo "Ошибка распаковки: $gz" >&2
  fi
done

echo "Все CSV-файлы обработаны."