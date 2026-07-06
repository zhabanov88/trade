/**
 * DatabaseIntegratedDatafeed V2 + activedata
 * 
 * НОВОЕ: window.app.activedata[]
 * - Хранит все сырые записи с сервера для текущего символа/интервала
 * - Накапливается при прокрутке (назад/вперёд)
 * - Сбрасывается при смене символа или интервала
 * - Каждая запись — объект как пришёл с сервера (без преобразований)
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
        
        // Инициализируем activedata
        if (!window.app) window.app = {};
        window.app.activedata = [];
        window.app._activeDataKey = null;
        window.app._activeDataIndex = new Set();
        
        console.log('📡 DatabaseIntegratedDatafeed V2 created');
    }

    async initialize() {
        try {
            console.log('🔄 Initializing DatabaseIntegratedDatafeed V2...');
            await this.loadIntervalsFromDatabase();
            await this.loadInstrumentsFromDatabase();
            this.buildConfig();
            console.log('✅ Datafeed initialized successfully');
        } catch (error) {
            console.error('❌ Failed to initialize datafeed:', error);
            this.loadFallbackConfiguration();
        }

        window.app.datafeed = this;
    }

    async loadIntervalsFromDatabase() {
        try {
            this.intervals = await apiClient.getIntervals();
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
            console.log('✓ Loaded intervals:', this.supportedResolutions);
        } catch (error) {
            console.error('Failed to load intervals:', error);
            this.supportedResolutions = ['1t', '1', '3', '5', '15', '30', '60', '240', '1D', '1W'];
        }
    }

    async loadInstrumentsFromDatabase() {
        try {
            this.instruments = await apiClient.getInstruments();
            this.instruments.forEach(instrument => {
                this.symbols.set(instrument.symbol, this.buildSymbolInfo(instrument));
            });
            console.log('✓ Loaded instruments:', this.instruments.length);
        } catch (error) {
            console.error('Failed to load instruments:', error);
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
            has_seconds: true,
            seconds_multipliers: ['1'],
            supported_resolutions: this.supportedResolutions,
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
        [
            { symbol: 'EUR', name: 'EUR/USD', type: 'forex', ticker: 'C:EUR-USD' },
            { symbol: 'GBP', name: 'GBP/USD', type: 'forex', ticker: 'C:GBP-USD' },
            { symbol: 'JPY', name: 'USD/JPY', type: 'forex', ticker: 'C:JPY-USD' }
        ].forEach(item => {
            this.symbols.set(item.symbol, {
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
                has_seconds: true,
                seconds_multipliers: ['1'],
                supported_resolutions: this.supportedResolutions,
                volume_precision: 8,
                data_status: 'streaming',
                currency_code: 'USD',
                clickhouse_ticker: item.ticker
            });
        });
    }

    buildConfig() {
        this.config = {
            supported_resolutions: this.supportedResolutions,
            exchanges: [{ value: 'CLICKHOUSE', name: 'ClickHouse', desc: 'ClickHouse Database' }],
            symbols_types: [
                { name: 'crypto', value: 'crypto' },
                { name: 'forex', value: 'forex' },
                { name: 'stock', value: 'stock' }
            ]
        };
    }

    loadFallbackConfiguration() {
        this.supportedResolutions = ['1', '5', '15', '30', '60', '240', '1D', '1W'];
        this.createDefaultSymbols();
        this.buildConfig();
    }

    // ============================================================
    // НОВЫЕ МЕТОДЫ: Управление activedata
    // ============================================================

    /**
     * Инициализация/сброс activedata при смене символа или интервала
     */
    initActiveData(symbol, resolution) {
        const key = `${symbol}_${resolution}`;

        if (window.app._activeDataKey !== key) {
            const prevKey = window.app._activeDataKey || 'none';
            console.log(`🔄 activedata RESET: [${prevKey}] → [${key}]`);

            window.app.activedata = [];
            window.app._activeDataKey = key;
            window.app._activeDataIndex = new Set();
        }
    }

    /**
     * Добавление новых сырых записей в activedata (без дублей)
     * Данные сохраняются точно в том виде как пришли с сервера
     */
    appendActiveData(rawItems) {
        if (!rawItems || rawItems.length === 0) return 0;

        if (!window.app.activedata) {
            window.app.activedata = [];
            window.app._activeDataIndex = new Set();
        }

        // Восстанавливаем индекс если он пустой но данные есть
        if (window.app._activeDataIndex.size === 0 && window.app.activedata.length > 0) {
            window.app.activedata.forEach(item => {
                window.app._activeDataIndex.add(item.timestamp);
            });
        }

        let added = 0;

        rawItems.forEach(item => {
            // Используем timestamp как уникальный ключ
            const ts = item.timestamp;

            if (!window.app._activeDataIndex.has(ts)) {
                window.app._activeDataIndex.add(ts);
                // Сохраняем объект КАК ЕСТЬ — без каких-либо преобразований
                window.app.activedata.push(item);
                added++;
            }
        });

        if (added > 0) {
            // Сортируем по времени (старые → новые)
            window.app.activedata.sort((a, b) =>
                new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
            );

            console.log(`📦 activedata: +${added} new | total: ${window.app.activedata.length} | ` +
                `range: ${window.app.activedata[0].timestamp} → ` +
                `${window.app.activedata[window.app.activedata.length - 1].timestamp}`
            );
        }

        return added;
    }

    // ============================================================

    getIntervalConfig(tvResolution) {
        const normalized = tvResolution.toUpperCase();
        const config = this.intervals.find(i => {
            const tvCode = i.tradingview_code;
            return tvCode === tvResolution ||
                   tvCode === normalized ||
                   tvCode.toUpperCase() === normalized;
        });
        return config;
    }

    getClickHouseTable(tvResolution) {
        if (tvResolution === '1t' || tvResolution === '1T') {
            return 'forex_quotes';
        }
        const config = this.getIntervalConfig(tvResolution);
        if (!config) {
            if (['1', '3', '5'].includes(tvResolution)) return 'market_data_minute';
            if (['15', '30', '60'].includes(tvResolution)) return 'market_data_hour';
            if (['1D', '1W'].includes(tvResolution)) return 'market_data_day';
            return 'market_data_minute';
        }
        return config.clickhouse_table || 'market_data_minute';
    }

    onReady(callback) {
        setTimeout(() => callback(this.config), 0);
    }

    searchSymbols(userInput, exchange, symbolType, onResultReadyCallback) {
        const searchTerm = userInput.toUpperCase();
        const results = [];
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

            symbolInfo = instrument
                ? this.buildSymbolInfo(instrument)
                : {
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

        symbolInfo.has_ticks = true;
        symbolInfo.has_seconds = true;

        setTimeout(() => onSymbolResolvedCallback(symbolInfo), 0);
    }

    /**
     * ГЛАВНЫЙ МЕТОД: getBars
     * + Накопление сырых данных в window.app.activedata
     */
    async getBars(symbolInfo, resolution, periodParams, onHistoryCallback, onErrorCallback) {
        const { from, to, firstDataRequest, countBack } = periodParams;

        console.log('\n' + '='.repeat(80));
        console.log('📊 getBars CALLED');
        console.log(`Symbol: ${symbolInfo.name} | Resolution: ${resolution}`);
        console.log(`From: ${new Date(from * 1000).toISOString()}`);
        console.log(`To: ${new Date(to * 1000).toISOString()}`);
        console.log(`First: ${firstDataRequest} | CountBack: ${countBack}`);
        console.log('='.repeat(80) + '\n');

        try {
            const ticker = symbolInfo.clickhouse_ticker || `C:${symbolInfo.name}-USD`;
            const table = this.getClickHouseTable(resolution);
            const intervalSeconds = this.getIntervalSeconds(resolution);

            // ── Сброс activedata при смене символа/интервала ──────────────
            this.initActiveData(symbolInfo.name, resolution);

            // ── Сохраняем текущий контекст для бектеста ───────────────────
            window.app._currentTicker = ticker;
            window.app._currentTable  = table;
            window.app._currentResolution = resolution;

            // Сбрасываем мета-данные диапазона дат при смене инструмента/ТФ
            if (window._sbState && window._sbState.dateRangeMeta) {
                window._sbState.dateRangeMeta = null;
                window._sbState.dateRange = { from: '', to: '' };
            }

            // ── Кеш диапазонов ────────────────────────────────────────────
            const cacheKey = `${symbolInfo.name}_${resolution}`;
            if (!this.loadedRanges.has(cacheKey)) {
                this.loadedRanges.set(cacheKey, { firstBar: null, lastBar: null });
            }
            const cache = this.loadedRanges.get(cacheKey);

            // ── Определяем диапазон запроса ──────────────────────────────
            let actualFrom, actualTo;

            if (firstDataRequest) {
                console.log('🎯 FIRST REQUEST');

                const isTick = table === 'forex_quotes' || resolution === '1t' || resolution === '1T';
                const latestUrl = isTick
                    ? `/api/market-data/ticks/latest?ticker=${ticker}`
                    : `/api/market-data/latest?ticker=${ticker}&table=${table}`;

                const latestResponse = await fetch(latestUrl, { credentials: 'include' });

                if (!latestResponse.ok) throw new Error('Failed to get latest timestamp');

                const latestData = await latestResponse.json();
                const latestTs = Math.floor(new Date(latestData.latest_timestamp).getTime() / 1000);

                actualTo = latestTs;
                actualFrom = latestTs - (10000 * intervalSeconds);

                console.log(`✅ Latest in DB: ${new Date(latestTs * 1000).toISOString()}`);

            } else {
                console.log('📥 SUBSEQUENT REQUEST');

                if (cache.firstBar && to <= cache.firstBar) {
                    // ⬅️ Прокрутка назад
                    console.log('⬅️ BACKWARDS');
                    actualTo = cache.firstBar;
                    actualFrom = actualTo - (1500 * intervalSeconds);

                } else if (cache.lastBar && from >= cache.lastBar) {
                    // ➡️ Прокрутка вперёд
                    console.log('➡️ FORWARD');
                    actualFrom = cache.lastBar;
                    actualTo = actualFrom + (1500 * intervalSeconds);

                } else {
                    console.log('❓ UNDEFINED DIRECTION');
                    actualFrom = from;
                    actualTo = to;
                }
            }

            // ── Запрос данных ─────────────────────────────────────────────
            const isTick = table === 'forex_quotes' ||
                           table.includes('tick') ||
                           resolution === '1t' ||
                           resolution === '1T';

            let response;

            if (isTick) {
                response = await fetch(
                    `/api/market-data/ticks/aggregated?ticker=${ticker}&from=${actualFrom}&to=${actualTo}&interval=${intervalSeconds}`,
                    { credentials: 'include' }
                );
            } else {
                response = await fetch(
                    `/api/market-data?ticker=${ticker}&table=${table}&from=${actualFrom}&to=${actualTo}`,
                    { credentials: 'include' }
                );
            }

            if (!response.ok) {
                throw new Error(`API error: ${response.status}`);
            }

            let data = await response.json();

            // ── Retry если данных нет (прокрутка назад) ──────────────────
            if ((!data || data.length === 0) && !firstDataRequest) {
                console.warn('⚠️ No data — retrying earlier ranges...');

                for (let attempt = 1; attempt <= 5; attempt++) {
                    const rangeSize = actualTo - actualFrom;
                    actualTo = actualFrom;
                    actualFrom = actualTo - rangeSize;

                    console.log(`   Attempt ${attempt}: ${new Date(actualFrom * 1000).toISOString()}`);

                    const retry = await fetch(
                        `/api/market-data?ticker=${ticker}&table=${table}&from=${actualFrom}&to=${actualTo}`,
                        { credentials: 'include' }
                    );

                    if (retry.ok) {
                        data = await retry.json();
                        if (data && data.length > 0) break;
                    }
                }
            }

            if (!data || data.length === 0) {
                console.warn('⚠️ No data received\n');
                onHistoryCallback([], { noData: true });
                return;
            }

            // ── СОХРАНЯЕМ СЫРЫЕ ДАННЫЕ в window.app.activedata ───────────
            this.appendActiveData(data);

            // ── Преобразуем в формат TradingView ─────────────────────────
            const bars = data
                .map(bar => ({
                    time: new Date(bar.timestamp).getTime(),
                    open:   parseFloat(bar.open),
                    high:   parseFloat(bar.high),
                    low:    parseFloat(bar.low),
                    close:  parseFloat(bar.close),
                    volume: parseFloat(bar.volume || 0)
                }))
                .sort((a, b) => a.time - b.time);

            // ── Обновляем кеш диапазонов ──────────────────────────────────
            const firstTs = Math.floor(bars[0].time / 1000);
            const lastTs  = Math.floor(bars[bars.length - 1].time / 1000);

            if (!cache.firstBar || firstTs < cache.firstBar) cache.firstBar = firstTs;
            if (!cache.lastBar  || lastTs  > cache.lastBar)  cache.lastBar  = lastTs;

            console.log(`✅ ${bars.length} bars | activedata: ${window.app.activedata.length} records total\n`);

            onHistoryCallback(bars, { noData: false });

        } catch (error) {
            console.error('❌ getBars ERROR:', error);
            onErrorCallback(error.message);
        }
    }

    getIntervalSeconds(resolution) {
        const map = {
            '1t': 1, '1': 60, '3': 180, '5': 300,
            '15': 900, '30': 1800, '60': 3600,
            '180': 10800, '240': 14400,
            '1D': 86400, '1W': 604800, '1M': 2592000
        };
        return map[resolution] || 60;
    }

    async getLatestTickTimestamp(ticker) {
        try {
            const response = await fetch(`/api/market-data/ticks/latest?ticker=${ticker}`, { credentials: 'include' });
            if (!response.ok) return null;
            const data = await response.json();
            return data?.latest_timestamp ? Math.floor(new Date(data.latest_timestamp).getTime() / 1000) : null;
        } catch (error) {
            return null;
        }
    }

    convertTicksToBars(ticks, intervalSeconds) {
        if (!ticks || ticks.length === 0) return [];
        const bars = {};
        ticks.forEach(tick => {
            const tickSeconds = Math.floor(new Date(tick.participant_timestamp).getTime() / 1000);
            const barTime = Math.floor(tickSeconds / intervalSeconds) * intervalSeconds;
            const mid = (parseFloat(tick.ask_price) + parseFloat(tick.bid_price)) / 2;
            if (!bars[barTime]) {
                bars[barTime] = {
                    timestamp: new Date(barTime * 1000).toISOString(),
                    open: mid, high: mid, low: mid, close: mid, volume: 1
                };
            } else {
                const b = bars[barTime];
                b.high = Math.max(b.high, mid);
                b.low  = Math.min(b.low,  mid);
                b.close = mid;
                b.volume++;
            }
        });
        return Object.values(bars).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    }

    subscribeBars(symbolInfo, resolution, onRealtimeCallback, subscriberUID, onResetCacheNeededCallback) {
        this.subscribers.set(subscriberUID, { symbolInfo, resolution, onRealtimeCallback, lastBar: null });

        const intervalId = setInterval(async () => {
            const subscriber = this.subscribers.get(subscriberUID);
            if (!subscriber) { clearInterval(intervalId); return; }

            const now = Math.floor(Date.now() / 1000);
            const ticker = symbolInfo.clickhouse_ticker || `C:${symbolInfo.name}-USD`;
            const table  = this.getClickHouseTable(resolution);

            try {
                const response = await fetch(
                    `/api/market-data?ticker=${ticker}&table=${table}&from=${now - 300}&to=${now}`,
                    { credentials: 'include' }
                );
                if (response.ok) {
                    const data = await response.json();
                    if (data && data.length > 0) {
                        // ── Добавляем realtime данные в activedata ────────
                        this.appendActiveData(data);

                        const latestBar = data[data.length - 1];
                        onRealtimeCallback({
                            time:   new Date(latestBar.timestamp).getTime(),
                            open:   parseFloat(latestBar.open),
                            high:   parseFloat(latestBar.high),
                            low:    parseFloat(latestBar.low),
                            close:  parseFloat(latestBar.close),
                            volume: parseFloat(latestBar.volume || 0)
                        });
                    }
                }
            } catch (error) {
                console.error('Error in subscribeBars:', error);
            }
        }, 5000);

        const subscriber = this.subscribers.get(subscriberUID);
        if (subscriber) subscriber.intervalId = intervalId;
    }

    unsubscribeBars(subscriberUID) {
        const subscriber = this.subscribers.get(subscriberUID);
        if (subscriber?.intervalId) clearInterval(subscriber.intervalId);
        this.subscribers.delete(subscriberUID);
    }

    destroy() {
        for (const [, subscriber] of this.subscribers) {
            if (subscriber.intervalId) clearInterval(subscriber.intervalId);
        }
        this.subscribers.clear();
        this.loadedRanges.clear();
    }
}

window.DatabaseIntegratedDatafeed = DatabaseIntegratedDatafeed;