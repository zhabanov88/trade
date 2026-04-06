/**
 * DatabaseIntegratedDatafeed V2
 * ИСПРАВЛЕНО: Правильная подгрузка исторических данных
 */

class DatabaseIntegratedDatafeed {
    constructor() {
        this.supportedResolutions = [];
        this.intervals = [];
        this.instruments = [];
        this.config = null;
        this.symbols = new Map();
        this.subscribers = new Map();
        this.loadedRanges = new Map();
        
        console.log('📡 DatabaseIntegratedDatafeed V2 created');
    }

    async initialize() {
        try {
            console.log('🔄 Initializing DatabaseIntegratedDatafeed V2...');
            
            await this.loadIntervalsFromDatabase();
            await this.loadInstrumentsFromDatabase();
            this.buildConfig();
            
            console.log('✅ Datafeed initialized successfully');
            console.log(`   Intervals: ${this.supportedResolutions.length}`);
            console.log(`   Instruments: ${this.instruments.length}`);
            
        } catch (error) {
            console.error('❌ Failed to initialize datafeed:', error);
            this.loadFallbackConfiguration();
        }
    }

    async loadIntervalsFromDatabase() {
        try {
            this.intervals = await apiClient.getIntervals();
            
            // Все активные интервалы для supportedResolutions
            const allResolutions = [];
            
            this.intervals
                .filter(i => i.is_active)
                .forEach(i => {
                    const tvCode = i.tradingview_code;
                    if (tvCode && !allResolutions.includes(tvCode)) {
                        allResolutions.push(tvCode);
                    }
                });
            
            this.supportedResolutions = allResolutions;
            
            console.log('✓ Loaded intervals from database:', this.supportedResolutions);
            console.log('✓ Full interval data:', this.intervals.map(i => ({
                code: i.code,
                tv: i.tradingview_code,
                table: i.clickhouse_table,
                active: i.is_active
            })));
            
        } catch (error) {
            console.error('Failed to load intervals from database:', error);
            this.supportedResolutions = ['1t', '1', '3', '5', '15', '30', '60', '240', '1D', '1W'];
        }
    }

    async loadInstrumentsFromDatabase() {
        try {
            this.instruments = await apiClient.getInstruments();
            
            this.instruments.forEach(instrument => {
                const symbolInfo = this.buildSymbolInfo(instrument);
                this.symbols.set(instrument.symbol, symbolInfo);
            });
            
            console.log('✓ Loaded instruments from database:', this.instruments.length);
            
        } catch (error) {
            console.error('Failed to load instruments from database:', error);
            this.createDefaultSymbols();
        }
    }

    buildSymbolInfo(instrument) {
        return {
            name: instrument.symbol,
            full_name: instrument.tradingview_symbol || `${instrument.symbol}USD`,
            description: instrument.description || instrument.name || `${instrument.symbol}/USD`,
            type: instrument.type || 'crypto',
            session: '24x7',
            timezone: 'Etc/UTC',
            exchange: instrument.provider_name || 'CLICKHOUSE',
            minmov: 1,
            pricescale: 100000000,
            has_intraday: true,
            has_weekly_and_monthly: true,
            has_seconds: true, // ВАЖНО: Поддержка секундных/тиковых интервалов
            seconds_multipliers: ['1'], // Поддержка 1-секундных тиков
            supported_resolutions: this.supportedResolutions, // Включает все интервалы включая 1t
            volume_precision: 8,
            data_status: 'streaming',
            currency_code: instrument.quote_currency || 'USD',
            provider_id: instrument.provider_id,
            clickhouse_ticker: instrument.clickhouse_ticker,
            base_currency: instrument.base_currency,
            quote_currency: instrument.quote_currency,
            metadata: instrument.metadata
        };
    }

    createDefaultSymbols() {
        const defaultSymbols = [
            { symbol: 'EUR', name: 'EUR/USD', type: 'forex', ticker: 'C:EUR-USD' },
            { symbol: 'GBP', name: 'GBP/USD', type: 'forex', ticker: 'C:GBP-USD' },
            { symbol: 'JPY', name: 'USD/JPY', type: 'forex', ticker: 'C:JPY-USD' }
        ];
        
        defaultSymbols.forEach(item => {
            const symbolInfo = {
                name: item.symbol,
                full_name: `${item.symbol}USD`,
                description: item.name,
                type: item.type,
                session: '24x7',
                timezone: 'Etc/UTC',
                exchange: 'CLICKHOUSE',
                minmov: 1,
                pricescale: 100000000,
                has_intraday: true,
                has_weekly_and_monthly: true,
                has_seconds: true, // Поддержка секундных/тиковых
                seconds_multipliers: ['1'],
                supported_resolutions: this.supportedResolutions,
                volume_precision: 8,
                data_status: 'streaming',
                currency_code: 'USD',
                clickhouse_ticker: item.ticker
            };
            
            this.symbols.set(item.symbol, symbolInfo);
        });
    }

    buildConfig() {
        this.config = {
            supported_resolutions: this.supportedResolutions,
            exchanges: [{
                value: 'CLICKHOUSE',
                name: 'ClickHouse',
                desc: 'ClickHouse Database'
            }],
            symbols_types: [
                { name: 'crypto', value: 'crypto' },
                { name: 'forex', value: 'forex' },
                { name: 'stock', value: 'stock' }
            ]
        };
    }

    loadFallbackConfiguration() {
        console.warn('⚠️ Using fallback configuration');
        this.supportedResolutions = ['1', '5', '15', '30', '60', '240', '1D', '1W'];
        this.createDefaultSymbols();
        this.buildConfig();
    }

    getIntervalConfig(tvResolution) {
        // Нормализуем resolution для поиска
        const normalized = tvResolution.toUpperCase();
        
        const config = this.intervals.find(i => {
            const tvCode = i.tradingview_code;
            return tvCode === tvResolution || 
                   tvCode === normalized ||
                   tvCode.toUpperCase() === normalized;
        });
        
        if (config) {
            console.log(`   ✓ Found config for ${tvResolution}:`, {
                code: config.code,
                tv_code: config.tradingview_code,
                table: config.clickhouse_table
            });
        } else {
            console.log(`   ⚠️ No config found for ${tvResolution}`);
        }
        
        return config;
    }

    getClickHouseTable(tvResolution) {
        // СНАЧАЛА проверяем это тиковый интервал
        if (tvResolution === '1t' || tvResolution === '1T') {
            console.log(`   ✓ Tick interval detected (${tvResolution}) → forex_quotes`);
            return 'forex_quotes';
        }
        
        // Ищем конфигурацию интервала
        const config = this.getIntervalConfig(tvResolution);
        
        if (!config) {
            // Fallback logic для стандартных интервалов
            if (tvResolution === '1' || tvResolution === '3' || tvResolution === '5') {
                return 'market_data_minute';
            } else if (tvResolution === '15' || tvResolution === '30' || tvResolution === '60') {
                return 'market_data_hour';
            } else if (tvResolution === '1D' || tvResolution === '1W') {
                return 'market_data_day';
            }
            return 'market_data_minute';
        }
        
        console.log(`   ✓ Using table from config: ${config.clickhouse_table}`);
        return config.clickhouse_table || 'market_data_minute';
    }

    onReady(callback) {
        console.log('📡 Datafeed onReady called');
        setTimeout(() => {
            callback(this.config);
        }, 0);
    }

    searchSymbols(userInput, exchange, symbolType, onResultReadyCallback) {
        console.log('🔍 Search symbols:', userInput);
        const results = [];
        const searchTerm = userInput.toUpperCase();
        
        for (const [symbol, symbolInfo] of this.symbols) {
            if (symbol.includes(searchTerm) || symbolInfo.description.includes(searchTerm)) {
                results.push({
                    symbol: symbolInfo.name,
                    full_name: symbolInfo.full_name,
                    description: symbolInfo.description,
                    exchange: symbolInfo.exchange,
                    type: symbolInfo.type
                });
            }
        }
        
        onResultReadyCallback(results);
    }

    resolveSymbol(symbolName, onSymbolResolvedCallback, onResolveErrorCallback) {
        console.log('🎯 Resolve symbol:', symbolName);
        
        const symbol = symbolName.split(':').pop().replace('USD', '').replace('-USD', '');
        let symbolInfo = this.symbols.get(symbol);
        
        if (!symbolInfo) {
            const instrument = this.instruments.find(i => 
                i.tradingview_symbol === symbolName || 
                i.symbol === symbol ||
                i.clickhouse_ticker?.includes(symbol)
            );
            
            if (instrument) {
                symbolInfo = this.buildSymbolInfo(instrument);
                this.symbols.set(symbol, symbolInfo);
            } else {
                symbolInfo = {
                    name: symbol,
                    full_name: `CLICKHOUSE:${symbol}USD`,
                    description: `${symbol}/USD`,
                    type: 'crypto',
                    session: '24x7',
                    timezone: 'Etc/UTC',
                    exchange: 'CLICKHOUSE',
                    minmov: 1,
                    pricescale: 100000000,
                    has_intraday: true,
                    has_weekly_and_monthly: true,
                    supported_resolutions: this.supportedResolutions,
                    volume_precision: 8,
                    data_status: 'streaming',
                    currency_code: 'USD',
                    clickhouse_ticker: `C:${symbol}-USD`
                };
                this.symbols.set(symbol, symbolInfo);
            }
        }
        
        // КРИТИЧНО: Добавляем поддержку тиковых интервалов
        symbolInfo.has_ticks = true;  // Включаем тики
        symbolInfo.has_seconds = true;  // Включаем секунды
        
        console.log('✓ Symbol resolved:', symbolInfo.name);
        console.log('   Supported resolutions:', symbolInfo.supported_resolutions);
        console.log('   Has ticks:', symbolInfo.has_ticks);
        
        setTimeout(() => {
            onSymbolResolvedCallback(symbolInfo);
        }, 0);
    }

    /**
     * ГЛАВНЫЙ МЕТОД: getBars
     * V2: Упрощенная логика с правильным кешированием
     */
    async getBars(symbolInfo, resolution, periodParams, onHistoryCallback, onErrorCallback) {
        const { from, to, firstDataRequest, countBack } = periodParams;
        
        console.log('\n' + '='.repeat(80));
        console.log('📊 getBars CALLED');
        console.log('='.repeat(80));
        console.log(`Symbol: ${symbolInfo.name}`);
        console.log(`Resolution: ${resolution}`);
        console.log(`From: ${new Date(from * 1000).toISOString()}`);
        console.log(`To: ${new Date(to * 1000).toISOString()}`);
        console.log(`First Request: ${firstDataRequest}`);
        console.log(`CountBack: ${countBack}`);
        console.log('='.repeat(80) + '\n');
        
        try {
            const ticker = symbolInfo.clickhouse_ticker || `C:${symbolInfo.name}-USD`;
            const table = this.getClickHouseTable(resolution);
            const intervalSeconds = this.getIntervalSeconds(resolution);
            
            // Кеш
            const cacheKey = `${symbolInfo.name}_${resolution}`;
            if (!this.loadedRanges.has(cacheKey)) {
                this.loadedRanges.set(cacheKey, {
                    firstBar: null,
                    lastBar: null
                });
            }
            const cache = this.loadedRanges.get(cacheKey);
            
            let actualFrom, actualTo;
            
            if (firstDataRequest) {
                // === ПЕРВЫЙ ЗАПРОС ===
                console.log('🎯 FIRST REQUEST');
                
                // Определяем это тики или обычные бары
                const isTick = table === 'forex_quotes' || resolution === '1t' || resolution === '1T';

                // Используем правильный endpoint
                const latestUrl = isTick
                    ? `/api/market-data/ticks/latest?ticker=${ticker}`  // ✅ Для тиков
                    : `/api/market-data/latest?ticker=${ticker}&table=${table}`; // ✅ Для баров

                const latestResponse = await fetch(latestUrl, { credentials: 'include' });
                
                if (latestResponse.ok) {
                    const latestData = await latestResponse.json();
                    const latestTs = Math.floor(new Date(latestData.latest_timestamp).getTime() / 1000);
                    
                    actualTo = latestTs;
                    actualFrom = latestTs - (10000 * intervalSeconds);
                    
                    console.log(`✅ Latest in DB: ${new Date(latestTs * 1000).toISOString()}`);
                    console.log(`📊 Loading 10000 bars`);
                } else {
                    throw new Error('Failed to get latest timestamp');
                }
                
            } else {
                // === ПОСЛЕДУЮЩИЕ ЗАПРОСЫ ===
                console.log('📥 SUBSEQUENT REQUEST');
                console.log(`Cache: firstBar=${cache.firstBar ? new Date(cache.firstBar * 1000).toISOString() : 'null'}`);
                console.log(`       lastBar=${cache.lastBar ? new Date(cache.lastBar * 1000).toISOString() : 'null'}`);
                
                // Определяем направление
                if (cache.firstBar && to <= cache.firstBar) {
                    // НАЗАД
                    console.log('⬅️ LOADING HISTORICAL (backwards)');
                    actualTo = cache.firstBar;
                    actualFrom = actualTo - (1500 * intervalSeconds);
                    console.log(`   Loading 1500 bars BEFORE ${new Date(cache.firstBar * 1000).toISOString()}`);
                    
                } else if (cache.lastBar && from >= cache.lastBar) {
                    // ВПЕРЁД
                    console.log('➡️ LOADING FORWARD');
                    actualFrom = cache.lastBar;
                    actualTo = actualFrom + (1500 * intervalSeconds);
                    console.log(`   Loading 1500 bars AFTER ${new Date(cache.lastBar * 1000).toISOString()}`);
                    
                } else {
                    // НЕОПРЕДЕЛЁННО
                    console.log('❓ UNDEFINED DIRECTION');
                    actualFrom = from;
                    actualTo = to;
                }
            }
            
            console.log(`\n📡 FETCHING: ${ticker} @ ${table}`);
            console.log(`   From: ${new Date(actualFrom * 1000).toISOString()}`);
            console.log(`   To:   ${new Date(actualTo * 1000).toISOString()}`);
            console.log(`   Bars: ~${Math.floor((actualTo - actualFrom) / intervalSeconds)}\n`);
            
            // СПЕЦИАЛЬНАЯ ОБРАБОТКА ДЛЯ ТИКОВ
            // Проверяем по таблице ИЛИ по resolution
            const isTick = table === 'forex_quotes' || 
                          table.includes('tick') || 
                          resolution === '1t' ||
                          resolution === '1T';
            
            console.log(`   Is tick data? ${isTick}`);
            
            let response;
            
            if (isTick) {
                // Тиковые данные - используем специальный endpoint
                const tickUrl = `/api/market-data/ticks/aggregated?ticker=${ticker}&from=${actualFrom}&to=${actualTo}&interval=${intervalSeconds}`;
                console.log(`   📊 Fetching ticks (aggregated): ${tickUrl}`);
                
                response = await fetch(tickUrl, { credentials: 'include' });
            } else {
                // Обычные OHLC данные
                const ohlcUrl = `/api/market-data?ticker=${ticker}&table=${table}&from=${actualFrom}&to=${actualTo}`;
                console.log(`   📊 Fetching OHLC: ${ohlcUrl}`);
                
                response = await fetch(ohlcUrl, { credentials: 'include' });
            }
            
            if (!response.ok) {
                const errorText = await response.text();
                console.error(`❌ API error (${response.status}):`, errorText);
                throw new Error(`API error: ${response.status}`);
            }
            
            let data = await response.json();
            
            if (isTick && data.length > 0) {
                console.log(`✅ Received ${data.length} aggregated tick bars`);
            }
            
            // ИСПРАВЛЕНО: Если данных нет, пробуем загрузить ЕЩЁ более ранние данные
            // (возможны пропуски в датах, но данные есть раньше)
            if ((!data || data.length === 0) && !firstDataRequest) {
                console.warn('⚠️ NO DATA in this range - trying EARLIER data');
                
                // Пробуем загрузить данные ЕЩЁ раньше (до 5 попыток)
                let attempts = 0;
                const maxAttempts = 5;
                
                while ((!data || data.length === 0) && attempts < maxAttempts) {
                    attempts++;
                    
                    // Сдвигаем диапазон ещё назад
                    const rangeSize = actualTo - actualFrom;
                    actualTo = actualFrom;
                    actualFrom = actualTo - rangeSize;
                    
                    console.log(`   📅 Attempt ${attempts}: trying ${new Date(actualFrom * 1000).toISOString()} - ${new Date(actualTo * 1000).toISOString()}`);
                    
                    const retryResponse = await fetch(
                        `/api/market-data?ticker=${ticker}&table=${table}&from=${actualFrom}&to=${actualTo}`,
                        { credentials: 'include' }
                    );
                    
                    if (retryResponse.ok) {
                        data = await retryResponse.json();
                        
                        if (data && data.length > 0) {
                            console.log(`   ✅ Found ${data.length} bars in earlier range!`);
                            break;
                        }
                    }
                }
                
                // Если после всех попыток данных нет - действительно конец
                if (!data || data.length === 0) {
                    console.warn('⚠️ NO DATA after 5 attempts - reached end of available data\n');
                    onHistoryCallback([], { noData: true });
                    return;
                }
            } else if (!data || data.length === 0) {
                // Для первого запроса - это ошибка
                console.warn('⚠️ NO DATA RECEIVED (first request)\n');
                onHistoryCallback([], { noData: true });
                return;
            }
            
            const bars = data.map(bar => ({
                time: new Date(bar.timestamp).getTime(),
                open: parseFloat(bar.open),
                high: parseFloat(bar.high),
                low: parseFloat(bar.low),
                close: parseFloat(bar.close),
                volume: parseFloat(bar.volume || 0)
            })).sort((a, b) => a.time - b.time);
            
            console.log(`✅ RECEIVED ${bars.length} bars`);
            console.log(`   First: ${new Date(bars[0].time).toISOString()}`);
            console.log(`   Last:  ${new Date(bars[bars.length - 1].time).toISOString()}`);
            
            // Обновляем кеш
            const firstTs = Math.floor(bars[0].time / 1000);
            const lastTs = Math.floor(bars[bars.length - 1].time / 1000);
            
            if (!cache.firstBar || firstTs < cache.firstBar) {
                cache.firstBar = firstTs;
                console.log(`   ✓ Updated firstBar: ${new Date(firstTs * 1000).toISOString()}`);
            }
            if (!cache.lastBar || lastTs > cache.lastBar) {
                cache.lastBar = lastTs;
                console.log(`   ✓ Updated lastBar: ${new Date(lastTs * 1000).toISOString()}`);
            }
            
            console.log(`\n📤 RETURNING ${bars.length} bars (noData: false)`);
            console.log('=' * 80 + '\n');
            
            onHistoryCallback(bars, { noData: false });
            
        } catch (error) {
            console.error('❌ ERROR:', error);
            onErrorCallback(error.message);
        }
    }
    
    getIntervalSeconds(resolution) {
        const map = {
            '1': 60,
            '1t': 1,      // 1 tick = 1 second aggregation
            '3': 180,
            '5': 300,
            '15': 900,
            '30': 1800,
            '60': 3600,
            '180': 10800,
            '240': 14400,
            '1D': 86400,
            '1W': 604800,
            '1M': 2592000
        };
        return map[resolution] || 60;
    }

    /**
     * Получить последний timestamp из тиковой таблицы
     */
    async getLatestTickTimestamp(ticker) {
        try {
            const response = await fetch(
                `/api/market-data/ticks/latest?ticker=${ticker}`,
                { credentials: 'include' }
            );
            
            if (!response.ok) {
                console.error('Failed to get latest tick timestamp');
                return null;
            }
            
            const data = await response.json();
            
            if (data && data.latest_timestamp) {
                const timestamp = new Date(data.latest_timestamp).getTime() / 1000;
                return Math.floor(timestamp);
            }
            
            return null;
        } catch (error) {
            console.error('Error getting latest tick timestamp:', error);
            return null;
        }
    }

    /**
     * Конвертация тиков в OHLC бары
     * Тики из forex_quotes имеют ask_price, bid_price
     */
    convertTicksToBars(ticks, intervalSeconds) {
        if (!ticks || ticks.length === 0) return [];
        
        // Группируем тики по временным интервалам
        const bars = {};
        
        ticks.forEach(tick => {
            // Берём timestamp тика
            const tickTime = new Date(tick.participant_timestamp).getTime();
            const tickSeconds = Math.floor(tickTime / 1000);
            
            // Округляем до начала интервала
            const barTime = Math.floor(tickSeconds / intervalSeconds) * intervalSeconds;
            
            // Вычисляем среднюю цену (mid price)
            const midPrice = (parseFloat(tick.ask_price) + parseFloat(tick.bid_price)) / 2;
            
            if (!bars[barTime]) {
                // Создаём новый бар
                bars[barTime] = {
                    timestamp: new Date(barTime * 1000).toISOString(),
                    open: midPrice,
                    high: midPrice,
                    low: midPrice,
                    close: midPrice,
                    volume: 1
                };
            } else {
                // Обновляем существующий бар
                const bar = bars[barTime];
                bar.high = Math.max(bar.high, midPrice);
                bar.low = Math.min(bar.low, midPrice);
                bar.close = midPrice;
                bar.volume += 1;
            }
        });
        
        // Преобразуем объект в массив и сортируем
        return Object.keys(bars)
            .map(time => bars[time])
            .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    }

    subscribeBars(symbolInfo, resolution, onRealtimeCallback, subscriberUID, onResetCacheNeededCallback) {
        console.log('📡 Subscribe bars:', symbolInfo.name, resolution);
        
        this.subscribers.set(subscriberUID, {
            symbolInfo,
            resolution,
            onRealtimeCallback,
            lastBar: null
        });
        
        const intervalId = setInterval(async () => {
            const subscriber = this.subscribers.get(subscriberUID);
            if (!subscriber) {
                clearInterval(intervalId);
                return;
            }
            
            const now = Math.floor(Date.now() / 1000);
            const ticker = symbolInfo.clickhouse_ticker || `C:${symbolInfo.name}-USD`;
            const table = this.getClickHouseTable(resolution);
            
            try {
                const response = await fetch(
                    `/api/market-data?ticker=${ticker}&table=${table}&from=${now - 300}&to=${now}`,
                    { credentials: 'include' }
                );
                
                if (response.ok) {
                    const data = await response.json();
                    if (data && data.length > 0) {
                        const latestBar = data[data.length - 1];
                        onRealtimeCallback({
                            time: new Date(latestBar.timestamp).getTime(),
                            open: parseFloat(latestBar.open),
                            high: parseFloat(latestBar.high),
                            low: parseFloat(latestBar.low),
                            close: parseFloat(latestBar.close),
                            volume: parseFloat(latestBar.volume || 0)
                        });
                    }
                }
            } catch (error) {
                console.error('Error in subscribeBars:', error);
            }
        }, 5000);
        
        const subscriber = this.subscribers.get(subscriberUID);
        if (subscriber) {
            subscriber.intervalId = intervalId;
        }
    }

    unsubscribeBars(subscriberUID) {
        console.log('📴 Unsubscribe bars:', subscriberUID);
        const subscriber = this.subscribers.get(subscriberUID);
        if (subscriber && subscriber.intervalId) {
            clearInterval(subscriber.intervalId);
        }
        this.subscribers.delete(subscriberUID);
    }

    destroy() {
        for (const [uid, subscriber] of this.subscribers) {
            if (subscriber.intervalId) {
                clearInterval(subscriber.intervalId);
            }
        }
        this.subscribers.clear();
        this.loadedRanges.clear();
    }
}

window.DatabaseIntegratedDatafeed = DatabaseIntegratedDatafeed;