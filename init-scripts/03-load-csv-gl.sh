#!/bin/bash
set -euo pipefail

# Каталог с CSV-файлами по умолчанию
CSV_DIR="${1:-init-scripts}"

# Файл журнала загруженных файлов
LOG_FILE="$CSV_DIR/.loaded_files.log"

# Подключение к Greenplum (настроить под вашу среду)
GP_CONNECTION="psql -h greenplum-host -p 25432 -U gpadmin -d database-name"

FORMAT_QUERY="CREATE TABLE IF NOT EXISTS candlestick_data (
  ticker VARCHAR(255),
  volume BIGINT,
  open DOUBLE PRECISION,
  close DOUBLE PRECISION,
  high DOUBLE PRECISION,
  low DOUBLE PRECISION,
  window_start BIGINT,
  transactions BIGINT
);"

# Убедимся, что таблица существует
echo "Создание таблицы (если отсутствует):"
$GP_CONNECTION -c "$FORMAT_QUERY"

# Инициализируем журнал, если его ещё нет
if [ ! -f "$LOG_FILE" ]; then
  touch "$LOG_FILE"
fi

# Обрабатываем все CSV-файлы в каталоге
# 1) CSV файлы с заголовками
for f in "$CSV_DIR"/*.csv; do
  [ -e "$f" ] || continue

  # Пропускаем, если файл уже загружен
  if grep -Fxq "$f" "$LOG_FILE"; then
    echo "Пропущено (уже загружено): $f"
    continue
  fi

  echo "Обрабатываю: $f"

  # Используем COPY для быстрой загрузки данных
  # IMPORTANT: Формат строки зависит от структуры ваших данных!
  cat <<- EOF | $GP_CONNECTION
    COPY candlestick_data(ticker,volume,open,close,high,low,window_start,transactions)
    FROM '$f'
    DELIMITER ','
    CSV HEADER;
EOF

  if [ $? -eq 0 ]; then
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

  # Пропускаем, если распакованный файл уже загружен
  if grep -Fxq "$csv_path" "$LOG_FILE"; then
    echo "Пропущено (уже загружено): $csv_path"
    continue
  fi

  echo "Распаковываю: $gz -> $csv_path"

  # Распаковываем на лету в тот же каталог
  dir="$(dirname "$csv_path")"
  mkdir -p "$dir"

  if gunzip -c "$gz" > "$csv_path"; then
    # Загружаем распакованный CSV
    cat <<- EOF | $GP_CONNECTION
      COPY candlestick_data(ticker,volume,open,close,high,low,window_start,transactions)
      FROM '$csv_path'
      DELIMITER ','
      CSV HEADER;
EOF

    if [ $? -eq 0 ]; then
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