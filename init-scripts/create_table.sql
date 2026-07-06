

CREATE TABLE IF NOT EXISTS public.market_data_quotes (
    -- Поля из CSV
    ticker TEXT NOT NULL,
    ask_exchange TEXT NULL,
    ask_price NUMERIC NULL,
    bid_exchange TEXT NULL,
    bid_price NUMERIC NULL,
    participant_timestamp BIGINT NULL,
    
    -- Дополнительные поля
    granularity TEXT NULL,
    bullish_fvg_triggered SMALLINT DEFAULT 0 NULL,
    bullish_imbalance SMALLINT DEFAULT 0 NULL,
    bearish_imbalance SMALLINT DEFAULT 0 NULL,
    swing_high SMALLINT DEFAULT 0 NULL,
    swing_low SMALLINT DEFAULT 0 NULL,
    vwap NUMERIC DEFAULT 0 NULL,
    tr NUMERIC DEFAULT 0 NULL,
    smaatr NUMERIC DEFAULT 0 NULL,
    emaatr NUMERIC DEFAULT 0 NULL,
    stoploss NUMERIC DEFAULT 0 NULL,
    takeprofit NUMERIC DEFAULT 0 NULL,
    
    -- Индексы для оптимизации
    CONSTRAINT market_data_quotes_pkey PRIMARY KEY (ticker, participant_timestamp)
);
/*
-- Создание индексов для быстрого поиска
CREATE INDEX  idx_market_data_quotes_ticker 
    ON public.market_data_quotes(ticker);

CREATE INDEX idx_market_data_quotes_timestamp 
    ON public.market_data_quotes(participant_timestamp);

CREATE INDEX idx_market_data_quotes_granularity 
    ON public.market_data_quotes(granularity);
*/
