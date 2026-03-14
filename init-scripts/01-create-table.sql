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

CREATE TABLE IF NOT EXISTS public.dataframes (
	id bigserial NOT NULL,
	"name" varchar(255) NOT NULL,
	description varchar(1000) NULL,
	meta json NULL,
	CONSTRAINT dataframe_pk PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.criterion (
	id bigserial NOT NULL,
	"name" varchar(255) NOT NULL,
	description varchar(1000) NULL,
	meta json NULL,
	CONSTRAINT newtable1_pk PRIMARY KEY (id)
);
