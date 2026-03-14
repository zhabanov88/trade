DO $$
DECLARE
    current_row RECORD;
    prev_row_1 RECORD;
    prev_row_2 RECORD;
    prev_row_3 RECORD;
    
    -- Для бычьего имбаланса
    bullish_fvg_high NUMERIC;
    bullish_fvg_low NUMERIC;
    bullish_gap_found BOOLEAN;
    
    -- Для медвежьего имбаланса
    bearish_fvg_high NUMERIC;
    bearish_fvg_low NUMERIC;
    bearish_gap_found BOOLEAN;
    
    -- Для проверки закрытия имбалансов
    bullish_closed_count INTEGER;
    bearish_closed_count INTEGER;
    
    row_count INTEGER := 0;
    processed_count INTEGER := 0;
BEGIN
    RAISE NOTICE 'Начинаем обработку всех строк в market_data...';
    
    -- Цикл по всем строкам market_data, отсортированным по времени
    FOR current_row IN 
        SELECT * FROM market_data 
        ORDER BY ticker, granularity, window_start ASC
    LOOP
        row_count := row_count + 1;
        
        -- Получаем 3 предыдущие строки для того же ticker и granularity
        prev_row_1 := NULL;
        prev_row_2 := NULL;
        prev_row_3 := NULL;
        
        SELECT * INTO prev_row_1 
        FROM market_data 
        WHERE ticker = current_row.ticker 
          AND granularity = current_row.granularity 
          AND window_start < current_row.window_start
        ORDER BY window_start DESC 
        LIMIT 1;
        
        IF prev_row_1 IS NOT NULL AND prev_row_1.window_start IS NOT NULL THEN
            SELECT * INTO prev_row_2 
            FROM market_data 
            WHERE ticker = current_row.ticker 
              AND granularity = current_row.granularity 
              AND window_start < prev_row_1.window_start
            ORDER BY window_start DESC 
            LIMIT 1;
        END IF;
        
        IF prev_row_2 IS NOT NULL AND prev_row_2.window_start IS NOT NULL THEN
            SELECT * INTO prev_row_3 
            FROM market_data 
            WHERE ticker = current_row.ticker 
              AND granularity = current_row.granularity 
              AND window_start < prev_row_2.window_start
            ORDER BY window_start DESC 
            LIMIT 1;
        END IF;
        
        -- Если есть все 3 предыдущие строки, проверяем имбалансы
        IF prev_row_1 IS NOT NULL AND prev_row_1.window_start IS NOT NULL 
           AND prev_row_2 IS NOT NULL AND prev_row_2.window_start IS NOT NULL 
           AND prev_row_3 IS NOT NULL AND prev_row_3.window_start IS NOT NULL THEN
            
            -- ПРОВЕРКА БЫЧЬЕГО ИМБАЛАНСА (High[3] < Low[1])
            bullish_gap_found := FALSE;
            IF prev_row_3.high < prev_row_1.low THEN
                bullish_gap_found := TRUE;
                bullish_fvg_low := prev_row_3.high;
                bullish_fvg_high := prev_row_1.low;
                
                -- Записываем имбаланс в таблицу bullish_fvg_temp
                INSERT INTO bullish_fvg_temp (
                    ticker, granularity, window_start, candle_number,
                    fvg_high, fvg_low, length, filling_status
                ) VALUES (
                    prev_row_2.ticker,
                    prev_row_2.granularity,
                    prev_row_2.window_start,
                    (SELECT COUNT(*) FROM market_data m 
                     WHERE m.ticker = prev_row_2.ticker 
                       AND m.granularity = prev_row_2.granularity 
                       AND m.window_start <= prev_row_2.window_start),
                    bullish_fvg_high,
                    bullish_fvg_low,
                    bullish_fvg_high - bullish_fvg_low,
                    'active'
                );
                
                -- Устанавливаем флаг имбаланса (1 = создан)
                UPDATE market_data 
                SET bullish_imbalance = 1 
                WHERE ticker = prev_row_2.ticker
                  AND granularity = prev_row_2.granularity
                  AND window_start = prev_row_2.window_start;
            END IF;
            
            -- ПРОВЕРКА МЕДВЕЖЬЕГО ИМБАЛАНСА (Low[3] > High[1])
            bearish_gap_found := FALSE;
            IF prev_row_3.low > prev_row_1.high THEN
                bearish_gap_found := TRUE;
                bearish_fvg_high := prev_row_3.low;
                bearish_fvg_low := prev_row_1.high;
                
                -- Записываем имбаланс в таблицу bearish_fvg_temp
                INSERT INTO bearish_fvg_temp (
                    ticker, granularity, window_start, candle_number,
                    fvg_high, fvg_low, length, filling_status
                ) VALUES (
                    prev_row_2.ticker,
                    prev_row_2.granularity,
                    prev_row_2.window_start,
                    (SELECT COUNT(*) FROM market_data m 
                     WHERE m.ticker = prev_row_2.ticker 
                       AND m.granularity = prev_row_2.granularity 
                       AND m.window_start <= prev_row_2.window_start),
                    bearish_fvg_high,
                    bearish_fvg_low,
                    bearish_fvg_high - bearish_fvg_low,
                    'active'
                );
                
                -- Устанавливаем флаг имбаланса (1 = создан)
                UPDATE market_data 
                SET bearish_imbalance = 1 
                WHERE ticker = prev_row_2.ticker
                  AND granularity = prev_row_2.granularity
                  AND window_start = prev_row_2.window_start;
            END IF;
            
            processed_count := processed_count + 1;
        END IF;
        
        -- ПРОВЕРКА ЗАКРЫТИЯ БЫЧЬИХ ИМБАЛАНСОВ
        WITH updated_bullish AS (
            UPDATE bullish_fvg_temp b
            SET filling_status = CASE
                    WHEN current_row.low <= b.fvg_low THEN 'filled'
                    WHEN current_row.low < b.fvg_high THEN 'touched'
                    ELSE b.filling_status
                END,
                fill_term = CASE
                    WHEN current_row.low <= b.fvg_low AND b.fill_term IS NULL 
                    THEN (SELECT COUNT(*) FROM market_data m 
                          WHERE m.ticker = current_row.ticker 
                            AND m.granularity = current_row.granularity 
                            AND m.window_start > b.window_start 
                            AND m.window_start <= current_row.window_start)
                    ELSE b.fill_term
                END
            WHERE b.ticker = current_row.ticker
              AND b.granularity = current_row.granularity
              AND b.window_start < current_row.window_start
              AND b.filling_status IN ('active', 'touched')
              AND current_row.low < b.fvg_high
              AND (current_row.low <= b.fvg_low OR current_row.low < b.fvg_high)
            RETURNING b.window_start
        )
        SELECT COUNT(*) INTO bullish_closed_count FROM updated_bullish;
        
        -- Если были закрыты бычьи имбалансы, ставим флаг 2 на текущей свече
        IF bullish_closed_count > 0 THEN
            UPDATE market_data 
            SET bullish_imbalance = 2 
            WHERE ticker = current_row.ticker
              AND granularity = current_row.granularity
              AND window_start = current_row.window_start;
        END IF;
        
        -- ПРОВЕРКА ЗАКРЫТИЯ МЕДВЕЖЬИХ ИМБАЛАНСОВ
        WITH updated_bearish AS (
            UPDATE bearish_fvg_temp b
            SET filling_status = CASE
                    WHEN current_row.high >= b.fvg_high THEN 'filled'
                    WHEN current_row.high > b.fvg_low THEN 'touched'
                    ELSE b.filling_status
                END,
                fill_term = CASE
                    WHEN current_row.high >= b.fvg_high AND b.fill_term IS NULL 
                    THEN (SELECT COUNT(*) FROM market_data m 
                          WHERE m.ticker = current_row.ticker 
                            AND m.granularity = current_row.granularity 
                            AND m.window_start > b.window_start 
                            AND m.window_start <= current_row.window_start)
                    ELSE b.fill_term
                END
            WHERE b.ticker = current_row.ticker
              AND b.granularity = current_row.granularity
              AND b.window_start < current_row.window_start
              AND b.filling_status IN ('active', 'touched')
              AND current_row.high > b.fvg_low
              AND (current_row.high >= b.fvg_high OR current_row.high > b.fvg_low)
            RETURNING b.window_start
        )
        SELECT COUNT(*) INTO bearish_closed_count FROM updated_bearish;
        
        -- Если были закрыты медвежьи имбалансы, ставим флаг 2 на текущей свече
        IF bearish_closed_count > 0 THEN
            UPDATE market_data 
            SET bearish_imbalance = 2 
            WHERE ticker = current_row.ticker
              AND granularity = current_row.granularity
              AND window_start = current_row.window_start;
        END IF;
        
        -- Прогресс каждые 1000 строк
        IF row_count % 1000 = 0 THEN
            RAISE NOTICE 'Обработано строк: %, из них с имбалансами: %', row_count, processed_count;
        END IF;
        
    END LOOP;
    
    RAISE NOTICE 'Обработка завершена!';
    RAISE NOTICE 'Всего строк: %', row_count;
    RAISE NOTICE 'Обработано с проверкой имбалансов: %', processed_count;
    
    -- Статистика по имбалансам
    RAISE NOTICE 'Бычьих имбалансов найдено: %', (SELECT COUNT(*) FROM bullish_fvg_temp);
    RAISE NOTICE 'Медвежьих имбалансов найдено: %', (SELECT COUNT(*) FROM bearish_fvg_temp);
    RAISE NOTICE 'Бычьих закрыто: %', (SELECT COUNT(*) FROM bullish_fvg_temp WHERE filling_status = 'filled');
    RAISE NOTICE 'Медвежьих закрыто: %', (SELECT COUNT(*) FROM bearish_fvg_temp WHERE filling_status = 'filled');
    RAISE NOTICE 'Свечей с закрытием бычьих имбалансов (flag=2): %', (SELECT COUNT(*) FROM market_data WHERE bullish_imbalance = 2);
    RAISE NOTICE 'Свечей с закрытием медвежьих имбалансов (flag=2): %', (SELECT COUNT(*) FROM market_data WHERE bearish_imbalance = 2);
    
END $$;