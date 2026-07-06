-- Процедура обнаружения закрытия бычьих имбалансов
CREATE OR REPLACE PROCEDURE detect_bullish_fvg_fill(
    p_ticker VARCHAR(20),
    p_granularity VARCHAR(10)
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_record RECORD;
    v_current_record RECORD;
    v_fvg_top NUMERIC;
    v_fvg_bottom NUMERIC;
    v_candle_number INTEGER;
    v_current_candle_number INTEGER;
    v_touch_candle INTEGER;
    v_fill_candle INTEGER;
    v_is_touched BOOLEAN;
    v_is_filled BOOLEAN;
BEGIN
    -- Перебираем все активные бычьи имбалансы
    FOR v_record IN
        SELECT 
            ticker,
            granularity,
            window_start,
            candle_number,
            fvg_top,
            fvg_bottom,
            filling_status
        FROM bullish_fvg_temp
        WHERE ticker = p_ticker
          AND granularity = p_granularity
          AND filling_status = 'active'
        ORDER BY candle_number
    LOOP
        v_fvg_top := v_record.fvg_top;
        v_fvg_bottom := v_record.fvg_bottom;
        v_candle_number := v_record.candle_number;
        v_touch_candle := NULL;
        v_fill_candle := NULL;
        v_is_touched := FALSE;
        v_is_filled := FALSE;
        
        -- Проверяем все последующие свечи
        FOR v_current_record IN
            SELECT 
                window_start,
                low,
                close,
                ROW_NUMBER() OVER (ORDER BY window_start) as candle_num
            FROM market_data
            WHERE ticker = p_ticker
              AND granularity = p_granularity
              AND window_start > v_record.window_start
            ORDER BY window_start
        LOOP
            v_current_candle_number := v_candle_number + 
                (SELECT COUNT(*) 
                 FROM market_data 
                 WHERE ticker = p_ticker 
                   AND granularity = p_granularity 
                   AND window_start > v_record.window_start 
                   AND window_start <= v_current_record.window_start);
            
            -- Проверка на закрытие имбаланса
            -- Закрытие тенью: Low[m] <= FVG_bottom
            IF v_current_record.low <= v_fvg_bottom THEN
                v_is_filled := TRUE;
                v_fill_candle := v_current_candle_number;
                
                -- Обновляем запись в временной таблице
                UPDATE bullish_fvg_temp
                SET filling_status = 'filled',
                    touch_candle = v_touch_candle,
                    touch_term = CASE WHEN v_touch_candle IS NOT NULL 
                                      THEN v_touch_candle - v_candle_number 
                                      ELSE NULL END,
                    fill_candle = v_fill_candle,
                    fill_term = v_fill_candle - v_candle_number
                WHERE ticker = p_ticker
                  AND granularity = p_granularity
                  AND window_start = v_record.window_start;
                
                -- Устанавливаем флаг закрытия в основной таблице
                UPDATE market_data
                SET bullish_fvg_triggered = 2
                WHERE ticker = p_ticker
                  AND granularity = p_granularity
                  AND window_start = v_record.window_start;
                
                EXIT; -- Выходим из цикла, имбаланс закрыт
            END IF;
            
            -- Проверка на касание имбаланса (только если еще не было касания и не закрыт)
            -- Касание: Low[n] < FVG_top И Low[n] > FVG_bottom
            IF NOT v_is_touched 
               AND v_current_record.low < v_fvg_top 
               AND v_current_record.low > v_fvg_bottom THEN
                v_is_touched := TRUE;
                v_touch_candle := v_current_candle_number;
                
                -- Обновляем запись о касании
                UPDATE bullish_fvg_temp
                SET filling_status = 'touched',
                    touch_candle = v_touch_candle,
                    touch_term = v_touch_candle - v_candle_number
                WHERE ticker = p_ticker
                  AND granularity = p_granularity
                  AND window_start = v_record.window_start;
            END IF;
        END LOOP;
    END LOOP;
END;
$$;

-- Процедура обнаружения закрытия медвежьих имбалансов
CREATE OR REPLACE PROCEDURE detect_bearish_fvg_fill(
    p_ticker VARCHAR(20),
    p_granularity VARCHAR(10)
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_record RECORD;
    v_current_record RECORD;
    v_fvg_top NUMERIC;
    v_fvg_bottom NUMERIC;
    v_candle_number INTEGER;
    v_current_candle_number INTEGER;
    v_touch_candle INTEGER;
    v_fill_candle INTEGER;
    v_is_touched BOOLEAN;
    v_is_filled BOOLEAN;
BEGIN
    -- Перебираем все активные медвежьи имбалансы
    FOR v_record IN
        SELECT 
            ticker,
            granularity,
            window_start,
            candle_number,
            fvg_top,
            fvg_bottom,
            filling_status
        FROM bearish_fvg_temp
        WHERE ticker = p_ticker
          AND granularity = p_granularity
          AND filling_status = 'active'
        ORDER BY candle_number
    LOOP
        v_fvg_top := v_record.fvg_top;
        v_fvg_bottom := v_record.fvg_bottom;
        v_candle_number := v_record.candle_number;
        v_touch_candle := NULL;
        v_fill_candle := NULL;
        v_is_touched := FALSE;
        v_is_filled := FALSE;
        
        -- Проверяем все последующие свечи
        FOR v_current_record IN
            SELECT 
                window_start,
                high,
                close,
                ROW_NUMBER() OVER (ORDER BY window_start) as candle_num
            FROM market_data
            WHERE ticker = p_ticker
              AND granularity = p_granularity
              AND window_start > v_record.window_start
            ORDER BY window_start
        LOOP
            v_current_candle_number := v_candle_number + 
                (SELECT COUNT(*) 
                 FROM market_data 
                 WHERE ticker = p_ticker 
                   AND granularity = p_granularity 
                   AND window_start > v_record.window_start 
                   AND window_start <= v_current_record.window_start);
            
            -- Проверка на закрытие имбаланса
            -- Закрытие тенью: High[m] >= FVG_top
            IF v_current_record.high >= v_fvg_top THEN
                v_is_filled := TRUE;
                v_fill_candle := v_current_candle_number;
                
                -- Обновляем запись в временной таблице
                UPDATE bearish_fvg_temp
                SET filling_status = 'filled',
                    touch_candle = v_touch_candle,
                    touch_term = CASE WHEN v_touch_candle IS NOT NULL 
                                      THEN v_touch_candle - v_candle_number 
                                      ELSE NULL END,
                    fill_candle = v_fill_candle,
                    fill_term = v_fill_candle - v_candle_number
                WHERE ticker = p_ticker
                  AND granularity = p_granularity
                  AND window_start = v_record.window_start;
                
                -- Устанавливаем флаг закрытия в основной таблице
                UPDATE market_data
                SET bearish_fvg_triggered = 2
                WHERE ticker = p_ticker
                  AND granularity = p_granularity
                  AND window_start = v_record.window_start;
                
                EXIT; -- Выходим из цикла, имбаланс закрыт
            END IF;
            
            -- Проверка на касание имбаланса
            -- Касание: High[n] > FVG_bottom И High[n] < FVG_top
            IF NOT v_is_touched 
               AND v_current_record.high > v_fvg_bottom 
               AND v_current_record.high < v_fvg_top THEN
                v_is_touched := TRUE;
                v_touch_candle := v_current_candle_number;
                
                -- Обновляем запись о касании
                UPDATE bearish_fvg_temp
                SET filling_status = 'touched',
                    touch_candle = v_touch_candle,
                    touch_term = v_touch_candle - v_candle_number
                WHERE ticker = p_ticker
                  AND granularity = p_granularity
                  AND window_start = v_record.window_start;
            END IF;
        END LOOP;
    END LOOP;
END;
$$;