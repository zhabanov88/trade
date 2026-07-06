-- Создаём базу данных
CREATE DATABASE IF NOT EXISTS stock_market_db;

-- Переключение на новую базу данных (для наглядности и понимания)
\c stock_market_db

-- Создаём таблицу market_data
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