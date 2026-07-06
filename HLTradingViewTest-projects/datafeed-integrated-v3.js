/**
 * DatabaseIntegratedDatafeed V4
 *
 * ИСПРАВЛЕНИЕ 1 — TIMEZONE:
 *   - timezone: 'Etc/UTC' во всех symbolInfo
 *   - parseLocalTimestamp() вместо new Date(ts).getTime() везде
 *
 * ИСПРАВЛЕНИЕ 2 — "Go to date" на обычных ТФ:
 *   - Детектируем прыжок по gap > 3000 баров от края кэша
 *   - Прямой запрос к нужной дате вместо пошагового движения
 *   - Кэш сбрасывается до нового диапазона при прыжке
 *
 * ИСПРАВЛЕНИЕ 3 — защита от шквала запросов:
 *   - Debounce 50ms: отбрасываем промежуточные вызовы без callback
 *   - _inFlight: одновременно летит максимум 1 запрос
 *
 * ИСПРАВЛЕНИЕ 4 — скролл внутри activedata (UNDEFINED direction):
 *   - Трекаем загруженные диапазоны через _fetchedSegments
 *   - При gap внутри activedata грузим чанк ~10000 баров (to=окно.from)
 *     вместо точечных запросов по каждому маленькому окну TV
 *   - Уже загруженные сегменты не перезапрашиваются
 *
 * ТИКИ (1t):
 *   - loadWindowSec = 4 часа (14400s)
 *   - jumpThresholdSec = 1 час (3600s)
 *   - Логика та же что для обычных ТФ
 */

function parseLocalTimestamp(ts) {
    if (!ts) return 0;
    const s = String(ts).replace(' ', 'T').replace('Z', '');
    const [datePart, timePart = '00:00:00'] = s.split('T');
    const [y, mo, d] = datePart.split('-').map(Number);
    const [timeMain, msStr = '0'] = timePart.split('.');
    const [h = 0, m = 0, sec = 0] = timeMain.split(':').map(Number);
    const ms = parseInt(msStr.slice(0, 3).padEnd(3, '0'));
    return Date.UTC(y, mo - 1, d, h, m, sec, ms);
}

class DatabaseIntegratedDatafeed {
    constructor() {
        this.supportedResolutions = [];
        this.intervals = [];
        this.instruments = [];
        this.config = null;
        this.symbols = new Map();
        this.subscribers = new Map();
        this.loadedRanges = new Map();

        if (!window.app) window.app = {};
        if (!Array.isArray(window.app.activedata)) window.app.activedata = [];
        if (!window.app._activeDataKey) window.app._activeDataKey = null;
        if (!window.app._activeDataIndex) window.app._activeDataIndex = new Set();

        this._inFlight = null;
        this._debounceTimer = null;
        this._debouncePending = null;

        // Трекер загруженных сегментов: Map<rangeKey, Array<{from, to}>>
        // Позволяет не перезапрашивать уже загруженные диапазоны
        this._fetchedSegments = new Map();

        this._tickStepsBack = 0;
        this._tickStepsKey = null;
        this._tickGotoTs = null;
        this._tickStartTs = null;
        this._lastTickWindow = null;

        console.log('📡 DatabaseIntegratedDatafeed V4 created');
    }

    async initialize() {
        try {
            console.log('🔄 Initializing DatabaseIntegratedDatafeed V4...');
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
            this.intervals.filter(i => i.is_active).forEach(i => {
                const tvCode = i.tradingview_code;
                if (tvCode && !allResolutions.includes(tvCode)) allResolutions.push(tvCode);
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
                const uniqueKey = `${instrument.group_provider_name}:${instrument.symbol}`;
                this.symbols.set(uniqueKey, this.buildSymbolInfo(instrument));
            });
            console.log('✓ Loaded instruments:', this.instruments.length);
        } catch (error) {
            console.error('Failed to load instruments:', error);
            this.createDefaultSymbols();
        }
    }

    buildMarketDataUrl({ ticker, table, from, to }) {
        const aggregateUp = localStorage.getItem('aggregateUp');
        const aggregateDown = localStorage.getItem('aggregateDown');
        const data = window.app.intervals_obj;
        const list = data.sort((a, b) => a.sort_order - b.sort_order).map(x => x.clickhouse_table);
        const idx = Object.fromEntries(list.map((v, i) => [v, i]));
        const current = window.app._currentTable;

        function parse(str) {
            if (!str) return [];
            const parts = str.split(',').map(x => x.trim()).filter(Boolean);
            const res = [];
            const start = idx[current];
            if (start === undefined) return [];
            for (let i = 0; i < parts.length; i++) {
                const p = parts[i];
                if (idx[p] !== undefined) { res.push(p); continue; }
                const n = Number(p);
                if (Number.isNaN(n)) continue;
                const val = list[start + n];
                if (val) res.push(val);
            }
            return [...new Set(res)];
        }

        const up = parse(aggregateUp);
        const down = parse(aggregateDown);

        let endpoint = 'market-data-test';
        const params = new URLSearchParams({ ticker, table });

        if (from != null) params.append('from', from);
        if (to != null) params.append('to', to);

        if (up.length) params.append('up', up.join(','));
        if (down.length) params.append('down', down.join(','));
        if (up.length || down.length) endpoint = 'market-data/mtf';
        if (table === 'raw_market_data') {
            endpoint = 'market-data/ticks/aggregated';
            params.append('interval', '1');
        }

        return `/api/${endpoint}?${params.toString()}`;
    }

    buildMarketDataUrl__1({ ticker, table, from, to }) {
        const aggregateUp = localStorage.getItem('aggregateUp');
        const aggregateDown = localStorage.getItem('aggregateDown');
        const data = window.app.intervals_obj;
        const list = data.sort((a, b) => a.sort_order - b.sort_order).map(x => x.clickhouse_table);
        const idx = Object.fromEntries(list.map((v, i) => [v, i]));
        const current = window.app._currentTable;

        function parse(str) {
            if (!str) return [];
            const parts = str.split(',').map(x => x.trim());
            const res = [];
            const start = idx[current];
            if (start === undefined) return [];
            let fromIndex = 0;
            if (idx[parts[0]] !== undefined) { res.push(parts[0]); fromIndex = 1; }
            for (let i = fromIndex; i < parts.length; i++) {
                const n = Number(parts[i]);
                if (Number.isNaN(n)) continue;
                const val = list[start + n];
                if (val) res.push(val);
            }
            return [...new Set(res)];
        }

        const up = parse(aggregateUp);
        const down = parse(aggregateDown);
        let endpoint = 'market-data';
        const params = new URLSearchParams({ ticker, table, from, to });
        if (up.length) params.append('up', up.join(','));
        if (down.length) params.append('down', down.join(','));
        if (up.length || down.length) endpoint = 'market-data/mtf';
        if (table === 'raw_market_data') {
            endpoint = 'market-data/ticks/aggregated';
            params.append('interval', '1');
        }
        return `/api/${endpoint}?${params.toString()}`;
    }

    buildSymbolInfo(instrument) {
        return {
            name: instrument.symbol,
            full_name: instrument.tradingview_symbol || `${instrument.symbol}USD`,
            description: instrument.description || instrument.name || `${instrument.symbol}/USD`,
            type: instrument.provider_name || 'crypto',
            session: '24x7',
            timezone: 'Etc/UTC',
            exchange: instrument.group_provider_name || 'CLICKHOUSE',
            minmov: 1, pricescale: 100000,
            has_intraday: true, has_weekly_and_monthly: true,
            has_seconds: true, seconds_multipliers: ['30'],
            supported_resolutions: this.supportedResolutions,
            volume_precision: 8, data_status: 'streaming',
            currency_code: instrument.quote_currency || 'USD',
            provider_id: instrument.provider_id,
            clickhouse_ticker: instrument.clickhouse_ticker,
            base_currency: instrument.base_currency,
            quote_currency: instrument.quote_currency,
            metadata: instrument.metadata,
            type_filter: instrument.type
        };
    }

    createDefaultSymbols() {
        this.instruments.forEach(item => {
            this.symbols.set(item.symbol, {
                name: item.symbol, full_name: `${item.symbol}`,
                description: item.name, type: item.type,
                session: '24x7', timezone: 'Etc/UTC', exchange: 'CLICKHOUSE',
                minmov: 1, pricescale: 100000,
                has_intraday: true, has_weekly_and_monthly: true,
                has_seconds: true, seconds_multipliers: ['30'],
                supported_resolutions: this.supportedResolutions,
                volume_precision: 8, data_status: 'streaming',
                currency_code: 'USD', clickhouse_ticker: item.clickhouse_ticker
            });
        });
    }

    buildConfig() {
        this.config = {
            supported_resolutions: this.supportedResolutions,
            exchanges: [{ value: 'CLICKHOUSE', name: 'ClickHouse', desc: 'ClickHouse Database' }],
            symbols_types: [
                { name: 'All', value: 'all' },
                { name: 'FX', value: 'fx' },
                { name: 'Stock', value: 'stock' },
                { name: 'Crypto', value: 'crypto' },
                { name: 'Commodities', value: 'commodities' },
                { name: 'Bond', value: 'bond' },
                { name: 'Derivatives', value: 'derivatives' },
            ]
        };
    }

    loadFallbackConfiguration() {
        this.supportedResolutions = ['1', '5', '15', '30', '60', '240', '1D', '1W'];
        this.createDefaultSymbols();
        this.buildConfig();
    }

    // ── activedata ────────────────────────────────────────────────────────────

    initActiveData(symbol, resolution) {
        const key = `${symbol}_${resolution}`;
        window.app._key = key;
        if (!window.app._activeDataKey) {
            window.app._activeDataKey = localStorage.getItem("_activeDataKey");
        }
        localStorage.setItem("_activeDataKey", key);
        if (window.app._activeDataKey === key) return;
        const prevKey = window.app._activeDataKey;
        if (prevKey === null && window.app.activedata.length > 0) {
            window.app._activeDataKey = key;
            window.app._activeDataIndex = new Set(window.app.activedata.map(item => item.timestamp));
            return;
        }
        console.log(`🔄 activedata RESET: [${prevKey ?? 'none'}] → [${key}]`);
        window.app.activedata = [];
        window.app._activeDataKey = key;
        window.app._activeDataIndex = new Set();
        // Сбрасываем трекер сегментов при смене символа/ТФ
        this._fetchedSegments.clear();
    }

    appendActiveData(rawItems) {
        if (!rawItems || rawItems.length === 0) return 0;
        if (!window.app.activedata) {
            window.app.activedata = [];
            window.app._activeDataIndex = new Set();
        }
        if (window.app._activeDataIndex.size === 0 && window.app.activedata.length > 0) {
            window.app.activedata.forEach(item => window.app._activeDataIndex.add(item.timestamp));
        }
        let added = 0;
        rawItems.forEach(item => {
            const ts = item.timestamp;
            if (!window.app._activeDataIndex.has(ts)) {
                window.app._activeDataIndex.add(ts);
                window.app.activedata.push(item);
                added++;
            }
        });
        if (added > 0) console.log(`📦 activedata: +${added} | total: ${window.app.activedata.length}`);
        return added;
    }

    // ── _fetchedSegments helpers ──────────────────────────────────────────────

    /**
     * Проверяет, покрыт ли диапазон [from, to] уже загруженными сегментами.
     * Сегменты могут быть не смежными, поэтому проверяем полное покрытие.
     */
    _isRangeFetched(segKey, from, to) {
        const segs = this._fetchedSegments.get(segKey);
        if (!segs || segs.length === 0) return false;
        // Простая проверка: есть ли хотя бы один сегмент целиком покрывающий [from, to]
        return segs.some(s => s.from <= from && s.to >= to);
    }

    /**
     * Регистрирует загруженный сегмент и мержит пересекающиеся.
     */
    _registerSegment(segKey, from, to) {
        if (!this._fetchedSegments.has(segKey)) {
            this._fetchedSegments.set(segKey, []);
        }
        const segs = this._fetchedSegments.get(segKey);
        segs.push({ from, to });

        // Мержим пересекающиеся и смежные сегменты
        segs.sort((a, b) => a.from - b.from);
        const merged = [segs[0]];
        for (let i = 1; i < segs.length; i++) {
            const last = merged[merged.length - 1];
            if (segs[i].from <= last.to + 1) {
                last.to = Math.max(last.to, segs[i].to);
            } else {
                merged.push(segs[i]);
            }
        }
        this._fetchedSegments.set(segKey, merged);
        console.log(`   📍 Segments for ${segKey}: ${merged.map(s =>
            `[${new Date(s.from * 1000).toISOString().slice(0, 16)} → ${new Date(s.to * 1000).toISOString().slice(0, 16)}]`
        ).join(', ')}`);
    }

    // ── interval helpers ──────────────────────────────────────────────────────

    getIntervalConfig(tvResolution) {
        const normalized = tvResolution.toUpperCase();
        return this.intervals.find(i => {
            const tvCode = i.tradingview_code;
            return tvCode === tvResolution || tvCode === normalized || tvCode.toUpperCase() === normalized;
        });
    }

    getClickHouseTable(tvResolution) {
        if (tvResolution === '1t' || tvResolution === '1T') return 'raw_market_data';
        const config = this.getIntervalConfig(tvResolution);
        if (!config) {
            if (['1', '3', '5'].includes(tvResolution)) return 'market_data_minute';
            if (['15', '30', '60'].includes(tvResolution)) return 'market_data_hour';
            if (['1D', '1W'].includes(tvResolution)) return 'market_data_day';
            return 'market_data_minute';
        }
        return config.clickhouse_table || 'market_data_minute';
    }

    getIntervalSeconds(resolution) {
        const map = {
            '1t': 1, '30S': 30, '1': 60, '3': 180, '5': 300,
            '15': 900, '30': 1800, '60': 3600,
            '180': 10800, '240': 14400,
            '1D': 86400, '1W': 604800, '1M': 2592000
        };
        return map[resolution] || 60;
    }

    // ── TV API ────────────────────────────────────────────────────────────────

    onReady(callback) {
        setTimeout(() => callback(this.config), 0);
    }

    searchSymbols(userInput, exchange, symbolType, onResultReadyCallback) {
        const searchTerm = userInput.toUpperCase();
        const results = [];

        for (const [symbol, symbolInfo] of this.symbols) {
            const matchesSearch = searchTerm === ''
                || symbol.includes(searchTerm)
                || (symbolInfo.description || '').toUpperCase().includes(searchTerm);

            const matchesType = !symbolType
                || symbolType === 'all'
                || symbolInfo.type_filter === symbolType;

            if (matchesSearch && matchesType) {
                results.push({
                    symbol: symbolInfo.name,
                    full_name: symbolInfo.full_name,
                    description: symbolInfo.description,
                    exchange: symbolInfo.exchange,
                    type: symbolInfo.type_filter
                });
            }
        }

        onResultReadyCallback(results);
    }

    async findNewestBySymbol(symbol) {
        try {
            const response = await fetch(`/api/market-data/last-data?ticker=${symbol}&qwe=123`, { credentials: 'include' });
            if (!response.ok) return false;

            const data = await response.json();
            if (!data?.length || !data[0].timestamp) return false;

            const formattedTimestamp = data[0].timestamp.replace(' ', 'T').split('.')[0] + 'Z';
            const lastDataTime = new Date(formattedTimestamp).getTime();
            const now = Date.now();
            const ageMs = now - lastDataTime;
            const ageMinutes = ageMs / (1000 * 60);

            console.log(`📊 Ticker: ${symbol} | Diff: ${ageMinutes.toFixed(2)} min | Status: ${ageMinutes <= 5 ? 'LIVE' : 'DEAD'}`);

            return ageMs <= 5 * 60 * 1000;
        } catch (e) {
            console.error("Ошибка проверки времени:", e);
            return false;
        }
    }

    resolveSymbol(symbolName, onSymbolResolvedCallback, onResolveErrorCallback) {
        console.log('🎯 Resolve symbol:', symbolName);

        // 1. Извлекаем чистый символ без провайдеров (все что после последнего двоеточия)
        let symbol = symbolName;
        if (symbolName.indexOf(":") !== -1) {
            symbol = symbolName.split(':').pop();
        }
        // symbol теперь гарантированно равен "XAU-USD" (а не "XAU")

        // Пробуем найти уже готовый symbolInfo в кэше по полному или чистому имени
        let symbolInfo = this.symbols.get(symbolName) || this.symbols.get(symbol);

        if (!symbolInfo) {
            // 2. Ищем инструмент в базе данных по строгому соответствию, избегая .includes()
            const instrument = this.instruments.find(i =>
                i.tradingview_symbol === symbolName ||
                i.symbol === symbol ||
                i.symbol === symbolName ||
                i.clickhouse_ticker === symbol ||
                i.clickhouse_ticker === `C:${symbol}` // Проверка специфичного формата кликхауса
            );

            // Если точное совпадение не найдено, делаем фоллбек строго на запрошенный символ
            symbolInfo = instrument
                ? this.buildSymbolInfo(instrument)
                : {
                    name: symbol, // Будет "XAU-USD"
                    full_name: symbolName.indexOf(":") !== -1 ? symbolName : `CLICKHOUSE:${symbol}`,
                    description: `${symbol}`,
                    type: 'crypto',
                    session: '24x7',
                    timezone: 'Etc/UTC',
                    exchange: 'CLICKHOUSE',
                    minmov: 1,
                    pricescale: 100000,
                    has_intraday: true,
                    has_weekly_and_monthly: true,
                    supported_resolutions: this.supportedResolutions,
                    volume_precision: 8,
                    data_status: 'streaming',
                    currency_code: symbol.split('-')[1] || 'USD',
                    clickhouse_ticker: `C:${symbol}`
                };

            const canonicalKey = this.symbols.has(symbolName) ? symbolName : symbol;
            if (!this.symbols.has(canonicalKey)) {
                this.symbols.set(canonicalKey, symbolInfo);
            }
        }

        symbolInfo.has_ticks = true;
        symbolInfo.has_seconds = true;
        symbolInfo.seconds_multipliers = ["30"];

        if (!window.app._gotoHooked) {
            window.app._gotoHooked = true;
            const self = this;
            if (window._dateGuardHooks) {
                window._dateGuardHooks.push((ts) => {
                    self.gotoTick(ts);
                });
            }
        }

        this.findNewestBySymbol(symbol).then(isAlive => {
            const finalInfo = JSON.parse(JSON.stringify(symbolInfo));
            finalInfo.data_status = isAlive ? 'streaming' : 'delayed';
            finalInfo.expired = !isAlive;
            setTimeout(() => onSymbolResolvedCallback(finalInfo), 0);
        }).catch(err => {
            console.error(err);
            onSymbolResolvedCallback(symbolInfo);
        });
    }

    // ── getBars: debounce wrapper ─────────────────────────────────────────────
    getBars(symbolInfo, resolution, periodParams, onHistoryCallback, onErrorCallback) {
        if (this._debounceTimer !== null) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = null;
        }
        this._debouncePending = { symbolInfo, resolution, periodParams, onHistoryCallback, onErrorCallback };

        this._debounceTimer = setTimeout(() => {
            this._debounceTimer = null;
            const pending = this._debouncePending;
            this._debouncePending = null;
            if (!pending) return;

            if (this._inFlight) {
                this._inFlight.finally(() => {
                    if (this._debounceTimer === null && this._debouncePending === null) {
                        this._doRun(pending);
                    }
                });
            } else {
                this._doRun(pending);
            }
        }, 50);
    }

    _doRun(pending) {
        const p = this._getBarsInternal(
            pending.symbolInfo, pending.resolution, pending.periodParams,
            pending.onHistoryCallback, pending.onErrorCallback
        );
        this._inFlight = p;
        p.finally(() => { this._inFlight = null; });
    }

    async _fetchFromServer({ ticker, table, from, to }) {
        try {
            const url = this.buildMarketDataUrl({ ticker, table, from, to });
            console.log(`   📡 fetch: ${url}`);
            const response = await fetch(url, { credentials: 'include' });
            if (!response.ok) throw new Error(`API error: ${response.status}`);
            return await response.json();
        } catch (err) {
            console.error('   ❌ fetch error:', err.message);
            return null;
        }
    }

    async _fetchAndAppend({ ticker, table, from, to }) {
        const data = await this._fetchFromServer({ ticker, table, from, to });
        if (data && data.length > 0) {
            const added = this.appendActiveData(data);
            if (added > 0) console.log(`🔄 Background append: +${added} bars`);
        }
    }

    _adToBars(items) {
        if (!items || items.length === 0) return [];
        return items
            .map(bar => ({
                time: parseLocalTimestamp(bar.timestamp),
                open: parseFloat(bar.open),
                high: parseFloat(bar.high),
                low: parseFloat(bar.low),
                close: parseFloat(bar.close),
                volume: parseFloat(bar.volume || 0),
                ...(bar.tf_up !== undefined && { tf_up: bar.tf_up }),
                ...(bar.tf_down !== undefined && { tf_down: bar.tf_down }),
            }))
            .sort((a, b) => a.time - b.time);
    }

    // Фильтрация activedata по временному окну [fromSec, toSec] (unix seconds)
    _filterAd(fromSec, toSec) {
        return window.app.activedata.filter(b => {
            const ts = Math.floor(parseLocalTimestamp(b.timestamp) / 1000);
            return ts >= fromSec && ts <= toSec;
        });
    }

    // ── getBars: core logic ───────────────────────────────────────────────────

    async _getBarsInternal(symbolInfo, resolution, periodParams, onHistoryCallback, onErrorCallback) {
        const { from, to, firstDataRequest } = periodParams;

        console.log(`\n${'='.repeat(50)}`);
        console.log(`📊 getBars | ${symbolInfo.name} | ${resolution} | first=${firstDataRequest}`);
        console.log(`   TV from: ${new Date(from * 1000).toISOString()}`);
        console.log(`   TV to:   ${new Date(to * 1000).toISOString()}`);

        try {
            const ticker = symbolInfo.clickhouse_ticker || `C:${symbolInfo.name}-USD`;
            const table = this.getClickHouseTable(resolution);

            this.initActiveData(symbolInfo.name, resolution);
            window.app._currentTicker = ticker;
            window.app._currentTable = table;
            window.app._currentResolution = resolution;

            const isTick = table === 'raw_market_data' || resolution === '1t' || resolution === '1T';
            if (isTick) {
                return this._getBarsTickInternal(symbolInfo, resolution, periodParams, onHistoryCallback, onErrorCallback, ticker, table);
            }

            const segKey = `${ticker}_${table}`;
            const ad = window.app.activedata;

            // ── Activedata границы ────────────────────────────────────────────
            let adFirstTs = null;
            let adLastTs = null;
            if (ad && ad.length > 0) {
                adFirstTs = Math.floor(parseLocalTimestamp(ad[0].timestamp) / 1000);
                adLastTs = Math.floor(parseLocalTimestamp(ad[ad.length - 1].timestamp) / 1000);
            }

            console.log(`   activedata: ${ad?.length ?? 0} bars | first=${adFirstTs ? new Date(adFirstTs * 1000).toISOString() : 'none'} | last=${adLastTs ? new Date(adLastTs * 1000).toISOString() : 'none'}`);

            // ── ПЕРВЫЙ ЗАПРОС ─────────────────────────────────────────────────
            if (firstDataRequest) {
                console.log('🎯 FIRST REQUEST — loading last 10000 bars');

                if (ad && ad.length > 0) {
                    const bars = this._adToBars(ad);
                    console.log(`   Returning ${bars.length} bars from existing activedata`);
                    onHistoryCallback(bars, { noData: false });
                    this._fetchAndAppend({ ticker, table, from: adLastTs, to: null });
                    return;
                }

                const data = await this._fetchFromServer({ ticker, table, from: null, to: null });
                if (!data || data.length === 0) {
                    console.warn('⚠️ No data on first request');
                    onHistoryCallback([], { noData: true });
                    return;
                }

                this.appendActiveData(data);

                // Регистрируем начальный сегмент
                const firstTs = Math.floor(parseLocalTimestamp(data[0].timestamp) / 1000);
                const lastTs = Math.floor(parseLocalTimestamp(data[data.length - 1].timestamp) / 1000);
                this._registerSegment(segKey, firstTs, lastTs);

                const bars = this._adToBars(data);
                console.log(`✅ First load: ${bars.length} bars`);
                onHistoryCallback(bars, { noData: false });
                return;
            }

            // ── ПОСЛЕДУЮЩИЕ ЗАПРОСЫ ───────────────────────────────────────────

            const isForward = adLastTs !== null && from >= adLastTs;
            const isBackward = adFirstTs !== null && from < adFirstTs;

            // ── ВПЕРЁД ────────────────────────────────────────────────────────
            if (isForward) {
                console.log('➡️ FORWARD — loading from', new Date(adLastTs * 1000).toISOString());

                const data = await this._fetchFromServer({ ticker, table, from: adLastTs, to: null });
                if (!data || data.length === 0) {
                    onHistoryCallback([], { noData: true });
                    return;
                }

                this.appendActiveData(data);
                const bars = this._adToBars(this._filterAd(from, to));
                onHistoryCallback(bars, { noData: bars.length === 0 });
                return;
            }

            // ── НАЗАД (за левый край activedata) ─────────────────────────────
            if (isBackward) {
                const periodCoveredInAd = adFirstTs <= from;

                if (periodCoveredInAd) {
                    console.log('📦 BACKWARD — serving from activedata cache');
                    const bars = this._adToBars(this._filterAd(from, to));
                    onHistoryCallback(bars, { noData: false });
                    return;
                }

                const toParam = adFirstTs || to;
                console.log(`⬅️ BACKWARD — loading chunk to ${new Date(toParam * 1000).toISOString()}`);

                const data = await this._fetchFromServer({ ticker, table, from: null, to: toParam });
                if (!data || data.length === 0) {
                    onHistoryCallback([], { noData: true });
                    return;
                }

                this.appendActiveData(data);
                window.app.activedata.sort((a, b) =>
                    parseLocalTimestamp(a.timestamp) - parseLocalTimestamp(b.timestamp)
                );

                // Регистрируем сегмент
                const segFrom = Math.floor(parseLocalTimestamp(data[0].timestamp) / 1000);
                const segTo = Math.floor(parseLocalTimestamp(data[data.length - 1].timestamp) / 1000);
                this._registerSegment(segKey, segFrom, segTo);

                const bars = this._adToBars(this._filterAd(from, to));
                console.log(`✅ Backward load: server=${data.length}, window=${bars.length}`);
                onHistoryCallback(bars, { noData: data.length === 0 });
                return;
            }

            // ── ВНУТРИ ДИАПАЗОНА activedata ───────────────────────────────────
            // from >= adFirstTs && from < adLastTs (скролл внутрь загруженного)
            console.log('🔍 INSIDE activedata range — checking cache');

            const barsFromCache = this._adToBars(this._filterAd(from, to));
            if (barsFromCache.length > 0) {
                // Данные есть в activedata — отдаём напрямую
                console.log(`📦 Serving ${barsFromCache.length} bars from activedata cache`);
                onHistoryCallback(barsFromCache, { noData: false });
                return;
            }

            // Баров в окне нет. Проверяем был ли этот диапазон уже загружен с сервера.
            if (this._isRangeFetched(segKey, from, to)) {
                // Уже запрашивали — данных в БД нет, реальный gap (выходные и т.п.)
                console.log('✅ Range already fetched, real gap (weekend/holiday) — noData: false');
                onHistoryCallback([], { noData: false });
                return;
            }

            // Новый диапазон — грузим крупный чанк (последние ~10000 баров до точки from)
            // Это закрывает весь диапазон скролла одним запросом вместо десятков точечных
            console.log(`🕳️ INSIDE GAP — loading chunk to ${new Date(from * 1000).toISOString()}`);
            const data = await this._fetchFromServer({ ticker, table, from: null, to: from });

            // Регистрируем запрошенный диапазон (даже если сервер вернул пусто)
            this._registerSegment(segKey, 0, from);

            if (!data || data.length === 0) {
                console.warn('⚠️ No data for inside gap range');
                onHistoryCallback([], { noData: false });
                return;
            }

            this.appendActiveData(data);
            window.app.activedata.sort((a, b) =>
                parseLocalTimestamp(a.timestamp) - parseLocalTimestamp(b.timestamp)
            );

            // Обновляем сегмент реальными границами полученных данных
            const segFrom = Math.floor(parseLocalTimestamp(data[0].timestamp) / 1000);
            const segTo = Math.floor(parseLocalTimestamp(data[data.length - 1].timestamp) / 1000);
            this._registerSegment(segKey, segFrom, segTo);

            const newBars = this._adToBars(this._filterAd(from, to));
            console.log(`✅ Inside gap filled: server=${data.length}, window=${newBars.length}`);
            onHistoryCallback(newBars, { noData: newBars.length === 0 });

        } catch (error) {
            console.error('❌ getBars ERROR:', error);
            onErrorCallback(error.message);
        }
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    async getLatestTickTimestamp(ticker) {
        try {
            const response = await fetch(`/api/market-data/ticks/latest?ticker=${ticker}`, { credentials: 'include' });
            if (!response.ok) return null;
            const data = await response.json();
            return data?.latest_timestamp
                ? Math.floor(parseLocalTimestamp(data.latest_timestamp) / 1000)
                : null;
        } catch { return null; }
    }

    convertTicksToBars(ticks, intervalSeconds) {
        if (!ticks || ticks.length === 0) return [];
        const bars = {};
        ticks.forEach(tick => {
            const tickMs = parseLocalTimestamp(tick.participant_timestamp);
            const barTime = Math.floor(Math.floor(tickMs / 1000) / intervalSeconds) * intervalSeconds;
            const mid = (parseFloat(tick.ask_price) + parseFloat(tick.bid_price)) / 2;
            if (!bars[barTime]) {
                bars[barTime] = {
                    timestamp: new Date(barTime * 1000).toISOString().replace('Z', ''),
                    open: mid, high: mid, low: mid, close: mid, volume: 1
                };
            } else {
                const b = bars[barTime];
                b.high = Math.max(b.high, mid);
                b.low = Math.min(b.low, mid);
                b.close = mid;
                b.volume++;
            }
        });
        return Object.values(bars).sort((a, b) =>
            parseLocalTimestamp(a.timestamp) - parseLocalTimestamp(b.timestamp)
        );
    }
// ПАТЧ для datafeed-integrated-v4.js
// Добавить метод _getBarsTickInternal ПЕРЕД методом gotoTick
// (найти строку "gotoTick(targetTs)" и вставить этот метод перед ней)

async _getBarsTickInternal(symbolInfo, resolution, periodParams, onHistoryCallback, onErrorCallback, ticker, table) {
    const { from, to, firstDataRequest } = periodParams;

    console.log(`🎯 TICK getBars | first=${firstDataRequest} | from=${new Date(from*1000).toISOString()} | _tickStartTs=${this._tickStartTs ? new Date(this._tickStartTs*1000).toISOString() : 'none'}`);

    try {
        const ad = window.app.activedata;

        if (firstDataRequest) {
            // Если есть целевая точка от gotoTick — загружаем с неё
            const startTs = this._tickStartTs || null;

            if (startTs) {
                console.log(`🎯 TICK: loading from gotoTick point ${new Date(startTs*1000).toISOString()}`);
                // Сбрасываем activedata (новая точка = новый контекст)
                window.app.activedata = [];
                window.app._activeDataIndex = new Set();
            }

            // Если явной точки от gotoTick нет — не анкеримся на текущее время (now()),
            // а подтягиваем реально последнюю доступную метку времени по тикеру.
            // Это критично: данные могут обрываться задолго до "сейчас" (простой ingest'а,
            // выходные, экспирация ключа провайдера) — тогда окно "now-4h → now" будет пустым,
            // хотя данные в БД есть.
            let anchorTs = startTs;
            if (!anchorTs) {
                anchorTs = await this.getLatestTickTimestamp(ticker);
                if (anchorTs) {
                    console.log(`🕐 TICK: anchoring to latest available data ${new Date(anchorTs*1000).toISOString()}`);
                } else {
                    anchorTs = Math.floor(Date.now() / 1000);
                    console.warn('⚠️ TICK: could not resolve latest timestamp, falling back to now()');
                }
            }

            // Загружаем данные:
            //   - если есть startTs (после gotoTick) — окно 4ч ВПЕРЁД от точки
            //   - если startTs нет — окно 4ч НАЗАД от последней доступной точки данных
            const data = await this._fetchFromServer({
                ticker, table,
                from: startTs ? startTs : Math.max(0, anchorTs - 14400),
                to:   startTs ? startTs + 14400 : anchorTs,
            });

            this._tickStartTs = null;  // сбрасываем после использования

            if (!data || data.length === 0) {
                console.warn('⚠️ TICK: no data');
                onHistoryCallback([], { noData: true });
                return;
            }

            this.appendActiveData(data);
            const bars = this._adToBars(data);
            console.log(`✅ TICK first load: ${bars.length} bars`);
            onHistoryCallback(bars, { noData: false });
            return;
        }

        // Последующие запросы — скролл назад
        const adFirstTs = ad.length > 0
            ? Math.floor(parseLocalTimestamp(ad[0].timestamp) / 1000)
            : null;

        if (adFirstTs !== null && from < adFirstTs) {
            console.log(`⬅️ TICK BACKWARD — loading to ${new Date(adFirstTs*1000).toISOString()}`);
            const data = await this._fetchFromServer({
                ticker, table,
                from: Math.max(0, adFirstTs - 14400),  // 4 часа назад
                to: adFirstTs,
            });

            if (!data || data.length === 0) {
                onHistoryCallback([], { noData: true });
                return;
            }

            this.appendActiveData(data);
            window.app.activedata.sort((a, b) =>
                parseLocalTimestamp(a.timestamp) - parseLocalTimestamp(b.timestamp)
            );

            const bars = this._adToBars(this._filterAd(from, to));
            onHistoryCallback(bars, { noData: data.length === 0 });
            return;
        }

        // Данные в кэше
        const bars = this._adToBars(this._filterAd(from, to));
        onHistoryCallback(bars, { noData: bars.length === 0 });

    } catch (err) {
        console.error('❌ TICK getBars error:', err);
        onErrorCallback(err.message);
    }
}

    gotoTick(targetTs) {
        console.log(`🎯 gotoTick: ${new Date(targetTs * 1000).toISOString()}`);
        this._tickStartTs = targetTs;
        for (const [key] of this.loadedRanges) {
            if (key.includes('1T') || key.includes('1t')) {
                this.loadedRanges.delete(key);
            }
        }
    }

    subscribeBars(symbolInfo, resolution, onRealtimeCallback, subscriberUID, onResetCacheNeededCallback) {
        this.subscribers.set(subscriberUID, { symbolInfo, resolution, onRealtimeCallback, lastBar: null });
        const intervalId = setInterval(async () => {
            const subscriber = this.subscribers.get(subscriberUID);
            if (!subscriber) { clearInterval(intervalId); return; }

            const now = Math.floor(Date.now() / 1000);
            const ticker = symbolInfo.clickhouse_ticker || `C:${symbolInfo.name}-USD`;
            const table = this.getClickHouseTable(resolution);

            try {
                const url = this.buildMarketDataUrl({ ticker, table, from: now - 300, to: now });
                const response = await fetch(url, { credentials: 'include' });
                if (response.ok) {
                    const data = await response.json();
                    if (data && data.length > 0) {
                        this.appendActiveData(data);
                        const lb = data[data.length - 1];
                        onRealtimeCallback({
                            time: parseLocalTimestamp(lb.timestamp),
                            open: parseFloat(lb.open),
                            high: parseFloat(lb.high),
                            low: parseFloat(lb.low),
                            close: parseFloat(lb.close),
                            volume: parseFloat(lb.volume || 0),
                            ...(lb.tf_up !== undefined && { tf_up: lb.tf_up }),
                            ...(lb.tf_down !== undefined && { tf_down: lb.tf_down }),
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
        this._fetchedSegments.clear();
    }
}

window.DatabaseIntegratedDatafeed = DatabaseIntegratedDatafeed;