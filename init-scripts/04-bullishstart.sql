
-- 4. Процедура для обнаружения бычьих имбалансов
CREATE OR REPLACE PROCEDURE detect_bullish_fvg(
    p_ticker TEXT,
    p_granularity TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_candle_number INT;
    v_high_prev NUMERIC;
    v_low_next NUMERIC;
    v_fvg_top NUMERIC;
    v_fvg_bottom NUMERIC;
    v_fvg_length NUMERIC;
    v_window_start TIMESTAMP;
    v_open_i NUMERIC;
    v_close_i NUMERIC;
    v_open_prev NUMERIC;
    v_close_prev NUMERIC;
    v_open_next NUMERIC;
    v_close_next NUMERIC;
    v_chromatic TEXT;
    v_fvg_counter INT := 0;
    v_touch_candle INT;
    v_fill_candle INT;
    v_low_j NUMERIC;
    v_close_j NUMERIC;
    v_status TEXT;
BEGIN
    -- 1. Создаем временную таблицу для хранения детальной информации об имбалансах
    CREATE TEMP TABLE IF NOT EXISTS bullish_fvg_temp (
        ticker TEXT NOT NULL,
        granularity TEXT NOT NULL,
        window_start TIMESTAMP NOT NULL,
        fvg_number INT,
        fvg_top NUMERIC,
        fvg_bottom NUMERIC,
        fvg_length NUMERIC,
        fvg_status TEXT,
        fvg_touch_candle INT,
        fvg_touch_period INT,
        fvg_fill_candle INT,
        fvg_fill_period INT,
        fvg_chromatic TEXT,
        PRIMARY KEY (ticker, granularity, window_start)
    );

    -- Очищаем временную таблицу от предыдущих данных
    DELETE FROM bullish_fvg_temp 
    WHERE ticker = p_ticker AND granularity = p_granularity;

    -- Сбрасываем флаги в основной таблице
    UPDATE market_data
    SET bullish_fvg_triggered = 0
    WHERE ticker = p_ticker AND granularity = p_granularity;

    -- Основной цикл обнаружения имбалансов
    FOR v_candle_number IN 2..(SELECT COUNT(*) - 1 FROM market_data 
                               WHERE ticker = p_ticker AND granularity = p_granularity)
    LOOP
        -- Получаем данные текущей свечи и соседних
        SELECT 
            md_prev.high,
            md_next.low,
            md_i.window_start,
            md_i.open,
            md_i.close,
            md_prev.open,
            md_prev.close,
            md_next.open,
            md_next.close
        INTO 
            v_high_prev,
            v_low_next,
            v_window_start,
            v_open_i,
            v_close_i,
            v_open_prev,
            v_close_prev,
            v_open_next,
            v_close_next
        FROM 
            (SELECT window_start, open, close, high, low,
                    ROW_NUMBER() OVER (ORDER BY window_start) as rn
             FROM market_data
             WHERE ticker = p_ticker AND granularity = p_granularity
            ) md_i
        LEFT JOIN 
            (SELECT window_start, open, close, high, low,
                    ROW_NUMBER() OVER (ORDER BY window_start) as rn
             FROM market_data
             WHERE ticker = p_ticker AND granularity = p_granularity
            ) md_prev ON md_prev.rn = md_i.rn - 1
        LEFT JOIN 
            (SELECT window_start, open, close, high, low,
                    ROW_NUMBER() OVER (ORDER BY window_start) as rn
             FROM market_data
             WHERE ticker = p_ticker AND granularity = p_granularity
            ) md_next ON md_next.rn = md_i.rn + 1
        WHERE md_i.rn = v_candle_number;

        -- Проверяем условие бычьего имбаланса
        IF v_high_prev < v_low_next THEN
            v_fvg_counter := v_fvg_counter + 1;
            v_fvg_top := v_low_next;
            v_fvg_bottom := v_high_prev;
            v_fvg_length := v_fvg_top - v_fvg_bottom;

            -- Определяем одноцветность свечей
            IF (v_close_prev > v_open_prev) AND 
               (v_close_i > v_open_i) AND 
               (v_close_next > v_open_next) THEN
                v_chromatic := 'Yes';
            ELSE
                v_chromatic := 'No';
            END IF;

            -- Поиск касания и полного закрытия имбаланса
            v_touch_candle := NULL;
            v_fill_candle := NULL;
            v_status := 'Open';

            FOR j IN (v_candle_number + 2)..(SELECT COUNT(*) FROM market_data 
                                             WHERE ticker = p_ticker AND granularity = p_granularity)
            LOOP
                SELECT low, close
                INTO v_low_j, v_close_j
                FROM (
                    SELECT low, close, 
                           ROW_NUMBER() OVER (ORDER BY window_start) as rn
                    FROM market_data
                    WHERE ticker = p_ticker AND granularity = p_granularity
                ) sub
                WHERE rn = j;

                -- Проверка касания
                IF v_touch_candle IS NULL AND v_low_j <= v_fvg_top THEN
                    v_touch_candle := j;
                END IF;

                -- Проверка полного закрытия
                IF v_close_j <= v_fvg_bottom THEN
                    v_fill_candle := j;
                    v_status := 'Filled';
                    EXIT;
                END IF;
            END LOOP;

            -- Если было касание, но не закрыт
            IF v_touch_candle IS NOT NULL AND v_fill_candle IS NULL THEN
                v_status := 'Touched';
            END IF;

            -- Сохраняем детальную информацию во временную таблицу
            INSERT INTO bullish_fvg_temp (
                ticker, granularity, window_start,
                fvg_number, fvg_top, fvg_bottom, fvg_length,
                fvg_status, fvg_touch_candle, 
                fvg_touch_period, fvg_fill_candle, 
                fvg_fill_period, fvg_chromatic
            ) VALUES (
                p_ticker, p_granularity, v_window_start,
                v_fvg_counter, v_fvg_top, v_fvg_bottom, v_fvg_length,
                v_status, v_touch_candle,
                CASE WHEN v_touch_candle IS NOT NULL 
                     THEN v_touch_candle - v_candle_number 
                     ELSE NULL END,
                v_fill_candle,
                CASE WHEN v_fill_candle IS NOT NULL 
                     THEN v_fill_candle - v_candle_number 
                     ELSE NULL END,
                v_chromatic
            );

            -- Устанавливаем флаг в основной таблице
            UPDATE market_data
            SET bullish_fvg_triggered = 1
            WHERE ticker = p_ticker
              AND granularity = p_granularity
              AND window_start = v_window_start;
        END IF;
    END LOOP;
END;
$$;