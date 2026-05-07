/**
 * DatabaseIntegratedDatafeed V3
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
        // Для тик-таймфрейма: счётчик последовательных шагов назад.
        // После MAX_TICK_STEPS шагов возвращаем noData чтобы остановить TV.
        this._tickStepsBack = 0;
        this._tickStepsKey = null;
        this._tickGotoTs = null;
        this._tickStartTs = null; // внешняя точка старта (устанавливается через gotoTick)
        this._lastTickWindow = null; // защита от зацикливания

        console.log('📡 DatabaseIntegratedDatafeed V3 created');
    }

    async initialize() {
        try {
            console.log('🔄 Initializing DatabaseIntegratedDatafeed V3...');
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
                this.symbols.set(instrument.symbol, this.buildSymbolInfo(instrument));
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
                // Если элемент является именем таблицы — добавляем напрямую
                if (idx[p] !== undefined) { res.push(p); continue; }
                // Иначе — числовой оффсет от текущего TF (+1, +2, -1 и т.д.)
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

        // Передаём только то что нужно — from или to (или ничего)
        if (from != null) params.append('from', from);
        if (to != null) params.append('to', to);

        if (up.length) params.append('up', up.join(','));
        if (down.length) params.append('down', down.join(','));
        if (up.length || down.length) endpoint = 'market-data/mtf';
        if (table === 'raw_market_data') endpoint = 'market-data/ticks';

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
        if (table === 'raw_market_data') endpoint = 'market-data/ticks';
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

            // 1. Убираем микросекунды (JS их не переварит в Date) и добавляем 'Z' (UTC)
            // Пример: "2026-05-04 09:33:24.114" -> "2026-05-04T09:33:24Z"
            const formattedTimestamp = data[0].timestamp.replace(' ', 'T').split('.')[0] + 'Z';

            const lastDataTime = new Date(formattedTimestamp).getTime();
            const now = Date.now(); // Это всегда UTC время

            const ageMs = now - lastDataTime;
            const ageMinutes = ageMs / (1000 * 60);

            console.log(`📊 Ticker: ${symbol} | Diff: ${ageMinutes.toFixed(2)} min | Status: ${ageMinutes <= 5 ? 'LIVE' : 'DEAD'}`);

            // Возвращаем true, если данные свежее 5 минут
            return ageMs <= 5 * 60 * 1000;

        } catch (e) {
            console.error("Ошибка проверки времени:", e);
            return false;
        }
    }

    resolveSymbol(symbolName, onSymbolResolvedCallback, onResolveErrorCallback) {
        console.log('🎯 Resolve symbol:', symbolName);

        let symbol = symbolName;
        if (symbolName.indexOf(":") !== -1) {
            symbol = symbolName.split(':').pop()
                .replace(/-?USD$/i, '');
        }

        let symbolInfo = this.symbols.get(symbolName) || this.symbols.get(symbol);

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
                    pricescale: 100000,
                    has_intraday: true,
                    has_weekly_and_monthly: true,
                    supported_resolutions: this.supportedResolutions,
                    volume_precision: 8,
                    data_status: 'streaming',
                    currency_code: 'USD',
                    clickhouse_ticker: `C:${symbol}-USD`
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

            if (!isAlive) {
                finalInfo.data_status = 'delayed';
                finalInfo.expired = true;

            } else {
                finalInfo.data_status = 'streaming';
                finalInfo.expired = false;
            }

            setTimeout(() => {
                onSymbolResolvedCallback(finalInfo);
            }, 0);

        }).catch(err => {
            console.error(err);
            onSymbolResolvedCallback(symbolInfo);
        });

        //setTimeout(() => onSymbolResolvedCallback(JSON.parse(JSON.stringify(symbolInfo))), 0);
    }

    // ── getBars: debounce wrapper ─────────────────────────────────────────────
    getBars(symbolInfo, resolution, periodParams, onHistoryCallback, onErrorCallback) {
        // Debounce: каждый новый вызов отменяет предыдущий отложенный.
        // Отброшенные вызовы НЕ получают callback — TV сам повторит запрос.
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
                // Уже выполняется — ждём завершения и запускаем последний вызов
                this._inFlight.finally(() => {
                    // Проверяем что за время ожидания не пришёл ещё более новый вызов
                    if (this._debounceTimer === null && this._debouncePending === null) {
                        this._doRun(pending);
                    }
                    // Если пришёл — debounce сам запустит его через 50ms
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

    // Фоновая подгрузка новых данных без блокировки TV callback
    async _fetchAndAppend({ ticker, table, from, to }) {
        const data = await this._fetchFromServer({ ticker, table, from, to });
        if (data && data.length > 0) {
            const added = this.appendActiveData(data);
            if (added > 0) {
                console.log(`🔄 Background append: +${added} bars`);
            }
        }
    }

    // Конвертация сырых объектов activedata в bars для TV
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

            // Для тиков — старая логика
            if (isTick) {
                return this._getBarsTickInternal(symbolInfo, resolution, periodParams, onHistoryCallback, onErrorCallback, ticker, table);
            }

            // ── Activedata границы ────────────────────────────────────────────
            const ad = window.app.activedata;
            let adFirstTs = null; // unix seconds
            let adLastTs = null;

            if (ad && ad.length > 0) {
                // activedata хранит сырые объекты с полем timestamp (строка)
                adFirstTs = Math.floor(parseLocalTimestamp(ad[0].timestamp) / 1000);
                adLastTs = Math.floor(parseLocalTimestamp(ad[ad.length - 1].timestamp) / 1000);
            }

            console.log(`   activedata: ${ad?.length ?? 0} bars | first=${adFirstTs ? new Date(adFirstTs * 1000).toISOString() : 'none'} | last=${adLastTs ? new Date(adLastTs * 1000).toISOString() : 'none'}`);

            // ── ПЕРВЫЙ ЗАПРОС — грузим последние 10000 из БД ─────────────────
            if (firstDataRequest) {
                console.log('🎯 FIRST REQUEST — loading last 10000 bars');

                if (ad && ad.length > 0) {
                    // activedata уже есть (например, после смены ТФ с возвратом)
                    // Отдаём то что есть + догружаем новое если нужно
                    const bars = this._adToBars(ad);
                    console.log(`   Returning ${bars.length} bars from existing activedata`);
                    onHistoryCallback(bars, { noData: false });

                    // Асинхронно догружаем новые данные если они могли появиться
                    this._fetchAndAppend({ ticker, table, from: adLastTs, to: null });
                    return;
                }

                // activedata пуст — загружаем с сервера (без from/to = последние 10000)
                const data = await this._fetchFromServer({ ticker, table, from: null, to: null });

                if (!data || data.length === 0) {
                    console.warn('⚠️ No data on first request');
                    onHistoryCallback([], { noData: true });
                    return;
                }

                this.appendActiveData(data);
                const bars = this._adToBars(data);
                console.log(`✅ First load: ${bars.length} bars`);
                onHistoryCallback(bars, { noData: false });
                return;
            }

            // ── ПОСЛЕДУЮЩИЕ ЗАПРОСЫ ──────────────────────────────────────────

            // TV запрашивает период [from, to]
            // Определяем направление: вперёд или назад

            const isForward = adLastTs && from >= adLastTs;
            const isBackward = adFirstTs && to <= adFirstTs;
            const intervalSec = this.getIntervalSeconds(resolution);

            if (isForward) {
                // ── Скролл / обновление ВПЕРЁД ────────────────────────────────
                console.log('➡️ FORWARD — loading from', new Date(adLastTs * 1000).toISOString());

                const data = await this._fetchFromServer({ ticker, table, from: adLastTs, to: null });

                if (!data || data.length === 0) {
                    console.log('   No new data in forward direction');
                    onHistoryCallback([], { noData: true });
                    return;
                }

                const added = this.appendActiveData(data);
                console.log(`   Added ${added} new bars forward`);

                // Фильтруем только то что запрашивает TV
                const bars = this._adToBars(
                    ad.filter(b => {
                        const ts = Math.floor(parseLocalTimestamp(b.timestamp) / 1000);
                        return ts >= from && ts <= to;
                    })
                );
                onHistoryCallback(bars, { noData: bars.length === 0 });
                return;
            }

            if (isBackward) {
                // ── Скролл НАЗАД ──────────────────────────────────────────────

                // Проверяем: есть ли в activedata данные для запрошенного периода?
                const periodCoveredInAd = adFirstTs && adFirstTs <= from;

                if (periodCoveredInAd) {
                    // Данные уже есть в activedata — отдаём без запроса на сервер
                    console.log('📦 BACKWARD — serving from activedata cache');
                    const bars = this._adToBars(
                        ad.filter(b => {
                            const ts = Math.floor(parseLocalTimestamp(b.timestamp) / 1000);
                            return ts >= from && ts <= to;
                        })
                    );

                    if (bars.length > 0) {
                        onHistoryCallback(bars, { noData: false });
                    } else {
                        // В активдата есть данные раньше, но за этот конкретный период пусто
                        // (например выходные). Сообщаем TV что данных нет в этом окне,
                        // но они могут быть ещё левее.
                        onHistoryCallback([], { noData: false });
                    }
                    return;
                }

                // Данных нет — грузим с сервера: to = adFirstTs (или TV to если activedata пуст)
                const toParam = adFirstTs || to;
                console.log(`⬅️ BACKWARD — loading to ${new Date(toParam * 1000).toISOString()}`);

                const data = await this._fetchFromServer({ ticker, table, from: null, to: toParam });

                if (!data || data.length === 0) {
                    console.warn('⚠️ No data going backward — noData');
                    onHistoryCallback([], { noData: true });
                    return;
                }

                this.appendActiveData(data);

                // Сортируем activedata после добавления исторических данных
                window.app.activedata.sort((a, b) =>
                    parseLocalTimestamp(a.timestamp) - parseLocalTimestamp(b.timestamp)
                );

                const bars = this._adToBars(
                    window.app.activedata.filter(b => {
                        const ts = Math.floor(parseLocalTimestamp(b.timestamp) / 1000);
                        return ts >= from && ts <= to;
                    })
                );

                console.log(`✅ Backward load: got ${data.length} from server, returning ${bars.length} bars for window`);
                onHistoryCallback(bars, { noData: bars.length === 0 && data.length === 0 });
                return;
            }

            // ── Неопределённый случай — отдаём из activedata что есть ────────
            console.log('❓ UNDEFINED direction — serving from activedata');
            if (ad && ad.length > 0) {
                const bars = this._adToBars(
                    ad.filter(b => {
                        const ts = Math.floor(parseLocalTimestamp(b.timestamp) / 1000);
                        return ts >= from && ts <= to;
                    })
                );
                onHistoryCallback(bars, { noData: bars.length === 0 });
            } else {
                onHistoryCallback([], { noData: true });
            }

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

    /**
     * Телепортировать тик-таймфрейм на нужную дату.
     * Вызывается из date-guard.js или другого внешнего кода при "Go to".
     *
     * Пример использования:
     *   window.app.datafeed.gotoTick(new Date('2025-09-11').getTime() / 1000);
     *
     * После вызова datafeed при следующем firstDataRequest загрузит данные
     * начиная с targetTs вместо последнего бара в БД.
     */
    gotoTick(targetTs) {
        console.log(`🎯 gotoTick: ${new Date(targetTs * 1000).toISOString()}`);
        this._tickStartTs = targetTs;
        // Сбрасываем кэш тиков чтобы принудить firstDataRequest
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
    }
}

window.DatabaseIntegratedDatafeed = DatabaseIntegratedDatafeed;