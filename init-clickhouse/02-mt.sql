CREATE MATERIALIZED VIEW default.fvg_detection
ENGINE = MergeTree()
ORDER BY (ticker, fvg_start_time)
AS
WITH numbered_candles AS (
    SELECT 
        ticker,
        window_start,
        open,
        close,
        high,
        low,
        volume,
        transactions,
        row_number() OVER (PARTITION BY ticker ORDER BY window_start) AS candle_num
    FROM default.market_data_minute
),
three_candle_windows AS (
    SELECT
        t1.ticker AS ticker,  -- Явно выбираем ticker
        t1.candle_num AS i_minus_1,
        t2.candle_num AS i,
        t3.candle_num AS i_plus_1,
        t2.window_start AS fvg_start_time,
        
        -- Свеча i-1
        t1.high AS high_i_minus_1,
        t1.low AS low_i_minus_1,
        t1.open AS open_i_minus_1,
        t1.close AS close_i_minus_1,
        
        -- Свеча i
        t2.high AS high_i,
        t2.low AS low_i,
        
        -- Свеча i+1
        t3.high AS high_i_plus_1,
        t3.low AS low_i_plus_1,
        t3.open AS open_i_plus_1,
        t3.close AS close_i_plus_1,
        t3.window_start AS i_plus_1_time
        
    FROM numbered_candles t1
    JOIN numbered_candles t2 ON t1.ticker = t2.ticker AND t2.candle_num = t1.candle_num + 1
    JOIN numbered_candles t3 ON t2.ticker = t3.ticker AND t3.candle_num = t2.candle_num + 1
)
SELECT
    ticker,
    i AS candle_i,
    fvg_start_time,
    i_plus_1_time,
    
    -- Определение типа имбаланса
    multiIf(
        high_i_minus_1 < low_i_plus_1, 'bullish',
        low_i_minus_1 > high_i_plus_1, 'bearish',
        'none'
    ) AS direction,
    
    -- Границы имбаланса
    multiIf(
        high_i_minus_1 < low_i_plus_1, low_i_plus_1,  -- bullish: FVG_top
        low_i_minus_1 > high_i_plus_1, low_i_minus_1,  -- bearish: FVG_top
        0
    ) AS fvg_top,
    
    multiIf(
        high_i_minus_1 < low_i_plus_1, high_i_minus_1,  -- bullish: FVG_bottom
        low_i_minus_1 > high_i_plus_1, high_i_plus_1,  -- bearish: FVG_bottom
        0
    ) AS fvg_bottom,
    
    -- Длина имбаланса
    abs(fvg_top - fvg_bottom) AS fvg_length,
    
    -- Середина имбаланса (для сетапа 50% FVG)
    (fvg_top + fvg_bottom) / 2 AS fvg_middle,
    
    -- Одноцветность для бычьего
    multiIf(
        direction = 'bullish' AND close_i_minus_1 > open_i_minus_1 AND close_i_plus_1 > open_i_plus_1, 'monochrome',
        direction = 'bullish', 'polychrome',
        direction = 'bearish' AND close_i_minus_1 < open_i_minus_1 AND close_i_plus_1 < open_i_plus_1, 'monochrome',
        direction = 'bearish', 'polychrome',
        'none'
    ) AS chromatic_consistency
    
FROM three_candle_windows
WHERE direction != 'none';

CREATE MATERIALIZED VIEW default.fvg_detection_day
ENGINE = MergeTree()
ORDER BY (ticker, fvg_start_time)
AS
WITH numbered_candles AS (
    SELECT 
        ticker,
        window_start,
        open,
        close,
        high,
        low,
        volume,
        transactions,
        row_number() OVER (PARTITION BY ticker ORDER BY window_start) AS candle_num
    FROM default.market_data
),
three_candle_windows AS (
    SELECT
        t1.ticker AS ticker,  -- Явно выбираем ticker
        t1.candle_num AS i_minus_1,
        t2.candle_num AS i,
        t3.candle_num AS i_plus_1,
        t2.window_start AS fvg_start_time,
        
        -- Свеча i-1
        t1.high AS high_i_minus_1,
        t1.low AS low_i_minus_1,
        t1.open AS open_i_minus_1,
        t1.close AS close_i_minus_1,
        
        -- Свеча i
        t2.high AS high_i,
        t2.low AS low_i,
        
        -- Свеча i+1
        t3.high AS high_i_plus_1,
        t3.low AS low_i_plus_1,
        t3.open AS open_i_plus_1,
        t3.close AS close_i_plus_1,
        t3.window_start AS i_plus_1_time
        
    FROM numbered_candles t1
    JOIN numbered_candles t2 ON t1.ticker = t2.ticker AND t2.candle_num = t1.candle_num + 1
    JOIN numbered_candles t3 ON t2.ticker = t3.ticker AND t3.candle_num = t2.candle_num + 1
)
SELECT
    ticker,
    i AS candle_i,
    fvg_start_time,
    i_plus_1_time,
    
    -- Определение типа имбаланса
    multiIf(
        high_i_minus_1 < low_i_plus_1, 'bullish',
        low_i_minus_1 > high_i_plus_1, 'bearish',
        'none'
    ) AS direction,
    
    -- Границы имбаланса
    multiIf(
        high_i_minus_1 < low_i_plus_1, low_i_plus_1,  -- bullish: FVG_top
        low_i_minus_1 > high_i_plus_1, low_i_minus_1,  -- bearish: FVG_top
        0
    ) AS fvg_top,
    
    multiIf(
        high_i_minus_1 < low_i_plus_1, high_i_minus_1,  -- bullish: FVG_bottom
        low_i_minus_1 > high_i_plus_1, high_i_plus_1,  -- bearish: FVG_bottom
        0
    ) AS fvg_bottom,
    
    -- Длина имбаланса
    abs(fvg_top - fvg_bottom) AS fvg_length,
    
    -- Середина имбаланса (для сетапа 50% FVG)
    (fvg_top + fvg_bottom) / 2 AS fvg_middle,
    
    -- Одноцветность для бычьего
    multiIf(
        direction = 'bullish' AND close_i_minus_1 > open_i_minus_1 AND close_i_plus_1 > open_i_plus_1, 'monochrome',
        direction = 'bullish', 'polychrome',
        direction = 'bearish' AND close_i_minus_1 < open_i_minus_1 AND close_i_plus_1 < open_i_plus_1, 'monochrome',
        direction = 'bearish', 'polychrome',
        'none'
    ) AS chromatic_consistency
    
FROM three_candle_windows
WHERE direction != 'none';