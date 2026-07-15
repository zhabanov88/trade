/**
 * backtest-engine-server.js  v7.1
 *
 * v7.0 (SharedArrayBuffer + WorkerPool) + тиковый режим:
 *
 * 5. Тиковый режим (IS_RAW_TICKS):
 *    Если cfg.raw_config != null или table === 'raw_market_data':
 *    - Загружает тики из raw_market_data (не OHLCV свечи)
 *    - Загружает GEX данные и кладёт в cfg._gex_data
 *    - В WORKER sandbox добавляет window.app.gex_data
 *    - После скриптов фильтрует bars[] → только закрытия range-баров (rb_direction)
 *    - Подменяет OHLC из rb_open/rb_high/rb_low/rb_close
 *
 * SharedArrayBuffer: [open, high, low, close, volume, atr, t] + 16 extra слотов
 * BAR_STRIDE = 23 Float64
 */

'use strict';

const vm      = require('vm');
const os      = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const RangeBars = require('./range-bars.js');

// ════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════

const FIELDS      = ['open', 'high', 'low', 'close', 'volume', 'atr', 't'];
const FIELD_COUNT = FIELDS.length;
const EXTRA_SLOTS = 16;
const BAR_STRIDE  = FIELD_COUNT + EXTRA_SLOTS; // 23 float64 на бар

// ════════════════════════════════════════════════════════════
// WORKER THREAD CODE
// ════════════════════════════════════════════════════════════

const WORKER_CODE = `
'use strict';
const vm = require('vm');
const { parentPort } = require('worker_threads');

const NAN_MARKER = -1.7976931348623157e+308;

parentPort.on('message', (task) => {
    const {
        sab, barCount, stride, fieldCount, extraSlots,
        extraKeys, scriptCode, paramOverrides, timestamps,
        newExtraStart,
        gexData,      // ← GEX данные для тикового режима
        askPrices, bidPrices, askSizes, bidSizes, // ← bid/ask для volume delta
    } = task;

    const floats = new Float64Array(sab);
    const logs   = [];

    const bars = new Array(barCount);
    for (let i = 0; i < barCount; i++) {
        const off = i * stride;
        const bar = {
            timestamp: timestamps[i],
            open:  floats[off + 0], high:  floats[off + 1],
            low:   floats[off + 2], close: floats[off + 3],
            volume:floats[off + 4], atr:   floats[off + 5],
            t:     floats[off + 6],
            o: floats[off + 0], h: floats[off + 1],
            l: floats[off + 2], c: floats[off + 3],
            v: floats[off + 4],
            price:     floats[off + 3],
            // bid/ask для volume delta (provider 201)
            ask_price: askPrices?.[i] || 0,
            bid_price: bidPrices?.[i] || 0,
            ask_size:  askSizes?.[i]  || 0,
            bid_size:  bidSizes?.[i]  || 0,
        };
        for (let e = 0; e < extraKeys.length; e++) {
            const val = floats[off + fieldCount + e];
            if (!isNaN(val) && val !== NAN_MARKER) {
                bar[extraKeys[e]] = val;
            }
        }
        bars[i] = bar;
    }

    const keysBefore = new Set(Object.keys(bars[0] || {}));

    const TVEngine = {
        define: function(def) {
            if (!def) return;
            const name    = def.name || 'indicator';
            const defInps = def.defaultInputs || {};
            const merged  = Object.assign({}, defInps, paramOverrides || {});
            let cfg = {};
            try { cfg = def.buildCfg ? def.buildCfg(merged) : {}; } catch(e) {}
            logs.push(['log', '[TVEngine] define: ' + name]);
            if (typeof def.analyze === 'function') {
                try { def.analyze(bars, cfg); logs.push(['log', '[TVEngine] analyze() ok']); }
                catch(e) { logs.push(['error', '[TVEngine] analyze() error: ' + e.message]); }
                return;
            }
            if (typeof def.calc === 'function') {
                for (let i = 0; i < bars.length; i++) {
                    try { def.calc(bars[i], i, bars, cfg); } catch(e) {}
                }
                logs.push(['log', '[TVEngine] calc() ok']);
            }
        },
        instances: () => [], registry:  () => {},
        redraw: () => {}, redrawAll: () => {},
        destroy: () => {}, clearAll: () => {},
        state: () => null, cleanGhosts: () => {},
        updateLegendColor: () => {}, setViewportBuffer: () => {},
    };

    const sandbox = {
        window: {
            app: {
                activedata: bars,
                setups:     {},
                gex_data:   gexData || [],   // ← GEX доступен в скрипте
            }
        },
        console: {
            log:   (...a) => logs.push(['log',   a.join(' ')]),
            warn:  (...a) => logs.push(['warn',  a.join(' ')]),
            error: (...a) => logs.push(['error', a.join(' ')]),
        },
        TVEngine,
        Date, Math, JSON, parseInt, parseFloat,
        isNaN, isFinite, Number, String, Array, Object,
        Infinity, NaN, undefined,
        setTimeout: () => {}, clearTimeout: () => {},
    };

    try {
        const needsWrap = !scriptCode.trim().startsWith('(function');
        const code = needsWrap ? '(function(){\\n' + scriptCode + '\\n})();' : scriptCode;
        new vm.Script(code, { filename: 'user-script.js' })
            .runInNewContext(sandbox, { timeout: 120000 });

        // ВАЖНО: сканируем ВСЕ бары для поиска новых числовых ключей.
        // bars[0] может не иметь rb_dir если первый тик не закрывает range-бар.
        // Скрипт типа RangeBar Engine пишет поля только на ~0.1% баров (закрытия),
        // поэтому нужно найти первый бар у которого есть новые поля.
        const newKeys = [];
        const keysBefore_ = keysBefore; // closure
        // Собираем все ключи которые появились на любом баре
        const candidateKeys = new Set();
        for (let i = 0; i < barCount; i++) {
            for (const k of Object.keys(bars[i])) {
                if (!keysBefore_.has(k)) candidateKeys.add(k);
            }
            // Оптимизация: как только нашли хотя бы один бар с новыми ключами
            // и прошли достаточно баров — можно остановиться
            if (candidateKeys.size > 0 && i > 100) break;
        }
        // Фильтруем: только числовые (SAB хранит только Float64)
        for (const k of candidateKeys) {
            // Находим первый бар где это поле определено как число
            for (let i = 0; i < barCount; i++) {
                if (typeof bars[i][k] === 'number') { newKeys.push(k); break; }
            }
        }

        const writtenKeys = [];
        let slotIdx = newExtraStart;
        for (const key of newKeys) {
            if (slotIdx >= extraSlots) break;
            for (let i = 0; i < barCount; i++) {
                const val = bars[i][key];
                floats[i * stride + fieldCount + slotIdx] =
                    (typeof val === 'number' && !isNaN(val)) ? val : NAN_MARKER;
            }
            writtenKeys.push({ key, slot: slotIdx });
            slotIdx++;
        }

        parentPort.postMessage({
            ok: true,
            setups:      sandbox.window.app.setups || {},
            writtenKeys,
            newKeys,
            logs,
        });
    } catch(err) {
        parentPort.postMessage({ ok: false, error: err.message, writtenKeys: [], newKeys: [], logs });
    }
});
`;

// ════════════════════════════════════════════════════════════
// WORKER POOL
// ════════════════════════════════════════════════════════════

class WorkerPool {
    constructor(size) {
        this.size    = size;
        this.queue   = [];
        this.workers = [];
        for (let i = 0; i < size; i++) this.workers.push({ busy: false, worker: null });
    }

    _createWorker() { return new Worker(WORKER_CODE, { eval: true }); }

    run(task) { return new Promise((resolve, reject) => { this._enqueue({ resolve, reject, task }); }); }

    _enqueue(job) {
        const slot = this.workers.find(w => !w.busy);
        if (slot) this._runJob(slot, job); else this.queue.push(job);
    }

    _runJob(slot, job) {
        slot.busy = true;
        if (!slot.worker) slot.worker = this._createWorker();
        const { resolve, reject, task } = job;
        const timeout = setTimeout(() => {
            slot.worker.terminate();
            slot.worker = null; slot.busy = false;
            reject(new Error('Worker timeout 120s'));
            this._next(slot);
        }, 125000);

        const onMsg = (msg) => {
            clearTimeout(timeout);
            slot.worker.off('message', onMsg); slot.worker.off('error', onErr);
            slot.busy = false; resolve(msg); this._next(slot);
        };
        const onErr = (err) => {
            clearTimeout(timeout);
            slot.worker.off('message', onMsg); slot.worker.off('error', onErr);
            slot.worker.terminate().catch(() => {}); slot.worker = null; slot.busy = false;
            reject(err); this._next(slot);
        };
        slot.worker.on('message', onMsg);
        slot.worker.on('error',   onErr);
        slot.worker.postMessage(task); // SAB shared по определению — transfer не нужен
    }

    _next(slot) { if (this.queue.length) this._runJob(slot, this.queue.shift()); }

    terminate() { for (const s of this.workers) if (s.worker) s.worker.terminate().catch(() => {}); }
}

const POOL_SIZE = Math.max(2, os.cpus().length - 1);
const pool = new WorkerPool(POOL_SIZE);
console.log(`[BT v7.1] Worker pool size: ${POOL_SIZE}`);

// ════════════════════════════════════════════════════════════
// BARS ↔ SharedArrayBuffer
// ════════════════════════════════════════════════════════════

const NAN_MARKER = -1.7976931348623157e+308;

function barsToSAB(bars) {
    const n   = bars.length;
    const sab = new SharedArrayBuffer(n * BAR_STRIDE * 8);
    const f   = new Float64Array(sab);
    for (let i = 0; i < n; i++) {
        const off = i * BAR_STRIDE;
        const b   = bars[i];
        f[off + 0] = b.open   || 0;
        f[off + 1] = b.high   || 0;
        f[off + 2] = b.low    || 0;
        f[off + 3] = b.close  || 0;
        f[off + 4] = b.volume || 0;
        f[off + 5] = b.atr    || 0;
        f[off + 6] = b.t      || 0;
        for (let e = FIELD_COUNT; e < BAR_STRIDE; e++) f[off + e] = NAN_MARKER;
    }
    return { sab, floats: f, timestamps: bars.map(b => b.timestamp || '') };
}

// ════════════════════════════════════════════════════════════
// MTF LOADER
// ════════════════════════════════════════════════════════════

async function loadMTFData(clickhouse, ticker, mainBars, upTables = [], fromTs, toTs) {
    if (!upTables.length || !mainBars.length) return;
    const whereBase = `WHERE ticker = {ticker:String}`
        + (fromTs ? ' AND toUnixTimestamp(window_start) >= {fromTs:UInt32}' : '')
        + (toTs   ? ' AND toUnixTimestamp(window_start) <= {toTs:UInt32}'   : '');
    for (const tfTable of upTables) {
        try {
            const rs = await clickhouse.query({
                query: `SELECT toUnixTimestamp(window_start) AS t,
                    toFloat64(open) AS open, toFloat64(high) AS high,
                    toFloat64(low) AS low, toFloat64(close) AS close,
                    toFloat64OrZero(toString(coalesce(volume,0))) AS volume
                    FROM ${tfTable} ${whereBase} ORDER BY window_start ASC`,
                format: 'JSONEachRow',
                query_params: { ticker, ...(fromTs?{fromTs}:{}), ...(toTs?{toTs}:{}) },
                clickhouse_settings: { max_execution_time: 120 },
            });
            const tfBars = [];
            const stream = rs.stream();
            for await (const rows of stream) {
                for (const rawRow of rows) {
                    const row = rawRow?.text ? JSON.parse(rawRow.text) : rawRow;
                    tfBars.push({ t: parseInt(row.t,10), open: parseFloat(row.open),
                        high: parseFloat(row.high), low: parseFloat(row.low),
                        close: parseFloat(row.close), volume: parseFloat(row.volume)||0 });
                }
            }
            if (!tfBars.length) continue;
            const tfDuration = tfBars.length > 1 ? tfBars[1].t - tfBars[0].t : 3600;
            const findTFBar = (targetT) => {
                let lo = 0, hi = tfBars.length - 1, res = -1;
                while (lo <= hi) { const mid=(lo+hi)>>1; if (tfBars[mid].t<=targetT){res=mid;lo=mid+1;}else hi=mid-1; }
                if (res < 0) return null;
                const tf = tfBars[res];
                return (targetT >= tf.t && targetT < tf.t + tfDuration) ? tf : null;
            };
            for (const bar of mainBars) {
                const tf = findTFBar(bar.t);
                if (tf) { if (!bar.tf_up) bar.tf_up = {}; bar.tf_up[tfTable] = tf; }
            }
        } catch(e) { console.warn(`[BT v7.1] MTF failed for ${tfTable}: ${e.message}`); }
    }
}

// ════════════════════════════════════════════════════════════
// CALC HELPERS
// ════════════════════════════════════════════════════════════

function calcSL(close, atr, cfg, dir) {
    const d = cfg.slMode === 'atr' ? (atr || close * 0.01) * cfg.slValue : close * cfg.slValue / 100;
    return dir === 'long' ? close - d : close + d;
}
function calcTP(entry, sl, cfg, dir) {
    if (cfg.tpMode === 'rr') {
        const risk = Math.abs(entry - sl);
        return dir === 'long' ? entry + risk * cfg.tpValue : entry - risk * cfg.tpValue;
    }
    const d = entry * cfg.tpValue / 100;
    return dir === 'long' ? entry + d : entry - d;
}
function calcQty(capital, entry, sl, cfg) {
    // For ES futures: default 1 contract
    // If riskPct is set, calculate based on risk per contract
    const riskAmt  = capital * (cfg.riskPct || 1) / 100;
    const riskPerU = Math.abs(entry - sl);
    if (riskPerU <= 0) return 1;  // default 1 contract
    const TICK_SIZE  = 0.25;
    const TICK_VALUE = 12.50;
    const riskTicks  = riskPerU / TICK_SIZE;
    const riskPerContract = riskTicks * TICK_VALUE;
    if (riskPerContract <= 0) return 1;
    return Math.max(1, Math.min(Math.floor(riskAmt / riskPerContract), 10));
}

// ════════════════════════════════════════════════════════════
// BACKTEST ENGINE
// ════════════════════════════════════════════════════════════

function runBacktestOnBars(bars, cfg) {
    const { setupCols } = cfg;
    const TICK_SIZE  = 0.25;   // ES: 0.25 pts per tick
    const TICK_VALUE = 12.50;  // ES: $12.50 per tick per contract
    const trades = [];
    let capital  = cfg.capital || 10000;
    const startCapital = capital;
    let inTrade      = null;  // open position
    let pendingLimit = null;  // pending limit order (как в Tradeview Advanced)
    let barIdx   = 0;

    const globalEntryExpr = cfg.setupMeta?.entry_expression || null;
    const globalExitExpr  = cfg.setupMeta?.exit_expression  || null;
    let compiledEntry = null, compiledExit = null;

    if (globalEntryExpr?.trim() && !globalEntryExpr.trim().startsWith('//') && globalEntryExpr.trim() !== 'true') {
        try {
            compiledEntry = new Function('bar','bars','index','params', '"use strict"; return (' + globalEntryExpr + ');');
            console.log('[BT compile] entry_expression (first 120):', globalEntryExpr.slice(0,120).replace(/\n/g,' '));
        }
        catch(e) { console.warn('[BT v7.1] entryExpression compile error:', e.message); }
    } else {
        console.log('[BT compile] globalEntryExpr пустой или не задан — используется sigVal путь');
        console.log('[BT compile] setupMeta?.entry_expression:', (cfg.setupMeta?.entry_expression||'').slice(0,80));
    }
    if (globalExitExpr?.trim() && !globalExitExpr.trim().startsWith('//') && globalExitExpr.trim() !== 'true') {
        try { compiledExit = new Function('bar','bars','index','params', '"use strict"; return (' + globalExitExpr + ');'); }
        catch(e) { console.warn('[BT v7.1] exitExpression compile error:', e.message); }
    }

    const globalParams = cfg.setupMeta?.params_schema
        ? Object.fromEntries(cfg.setupMeta.params_schema.map(p => [p.id, p.defval]))
        : {};
    if (cfg.paramOverride) Object.assign(globalParams, cfg.paramOverride);
    // Convert string params to numbers
    for (const k of Object.keys(globalParams)) {
        const v = globalParams[k];
        if (typeof v === 'string' && v !== '' && !isNaN(Number(v))) globalParams[k] = Number(v);
    }

    // Session helpers for ES futures
    function getUTCHMS(tsMs) {
        const d = new Date(tsMs);
        return { h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds(), dow: d.getUTCDay() };
    }
    function secOfDay(hms) { return hms.h * 3600 + hms.m * 60 + hms.s; }
    const SESSION_OPEN  = 14 * 3600 + 30 * 60;  // 14:30 UTC
    const SESSION_CLOSE = 21 * 3600;             // 21:00 UTC
    const FRI_CUTOFF    = 19 * 3600 + 58 * 60 + 30; // Fri 19:58:30 UTC
    const CANCEL_TICKS  = cfg.slMode === 'ticks' ? (cfg.sl_cancel_ticks || 10) : 10;
    const SL_TICKS      = cfg.slMode === 'ticks' ? (cfg.sl_ticks || 11) : null;
    const TP_TICKS      = cfg.tpMode === 'ticks' ? (cfg.tp_ticks || 19) : null;
    const LIMIT_OFFSET  = cfg.limit_offset || 0.25; // SHORT limit = close + offset

    // Диагностика: считаем сколько баров проходит каждое условие
    if (bars.length > 0) {
        const b0 = bars[0];
        console.log(`[BT diag] params:`, JSON.stringify(globalParams));
        console.log(`[BT diag] bar[0]:`, {dir: b0.rb_dir===1?'bear':b0.rb_dir===2?'bull':'?', delta: b0.rb_delta, close: b0.rb_close, zgamma: b0.gex_zero_gamma});

        // Счётчики условий по всем барам
        const p = globalParams;
        const dt = Number(p.delta_threshold) || 94;
        const vt = Number(p.gex_vol_thresh)  || 4;
        // SHORT цепочка: rb_dir===1, prev_delta < -dt, gex_sum_vol > vt, oi<=0, spot>zgamma+5, spot<mpos
        let cs = {total:0,bear:0,delta:0,gex:0,vol:0,oi:0,zgamma:0,mpos:0,all:0};
        // NEGTREND цепочка: rb_dir===1, prev_delta < -dt, gex_sum_vol < -vt, spot<zgamma-5, spot>mneg
        let cn = {bear:0,delta:0,gex:0,vol:0,zgamma:0,mneg:0,all:0};
        // LONG цепочка: rb_dir===2, prev_delta < -dt, gex_sum_vol > vt, oi>=0, spot>zgamma+5, spot<mpos
        let cl = {bull:0,delta:0,gex:0,vol:0,oi:0,zgamma:0,mpos:0,all:0};
        for (const b of bars) {
            cs.total++;
            // SHORT (postrend)
            const ps1 = b.rb_dir === 1;
            const ps2 = ps1 && b.rb_prev_delta < -dt;
            const ps3 = ps2 && b.gex_has_data === 1;
            const ps4 = ps3 && b.gex_sum_vol > vt;
            const ps5 = ps4 && b.gex_sum_oi <= 0;
            const ps6 = ps5 && b.gex_spot > (b.gex_zero_gamma + 5);
            const ps7 = ps6 && b.gex_spot < b.gex_major_pos;
            if (ps1) cs.bear++;   if (ps2) cs.delta++; if (ps3) cs.gex++;
            if (ps4) cs.vol++;    if (ps5) cs.oi++;     if (ps6) cs.zgamma++;
            if (ps7) { cs.mpos++; cs.all++; }
            // NEGTREND
            const pn1 = b.rb_dir === 1;
            const pn2 = pn1 && b.rb_prev_delta < -dt;
            const pn3 = pn2 && b.gex_has_data === 1;
            const pn4 = pn3 && b.gex_sum_vol < -vt;
            const pn5 = pn4 && b.gex_spot < (b.gex_zero_gamma - 5);
            const pn6 = pn5 && b.gex_spot > b.gex_major_neg;
            if (pn1) cn.bear++;   if (pn2) cn.delta++; if (pn3) cn.gex++;
            if (pn4) cn.vol++;    if (pn5) cn.zgamma++; if (pn6) { cn.mneg++; cn.all++; }
            // LONG (postrend)
            const pl1 = b.rb_dir === 2;
            const pl2 = pl1 && b.rb_prev_delta < -dt;
            const pl3 = pl2 && b.gex_has_data === 1;
            const pl4 = pl3 && b.gex_sum_vol > vt;
            const pl5 = pl4 && b.gex_sum_oi >= 0;
            const pl6 = pl5 && b.gex_spot > (b.gex_zero_gamma + 5);
            const pl7 = pl6 && b.gex_spot < b.gex_major_pos;
            if (pl1) cl.bull++;   if (pl2) cl.delta++; if (pl3) cl.gex++;
            if (pl4) cl.vol++;    if (pl5) cl.oi++;     if (pl6) cl.zgamma++;
            if (pl7) { cl.mpos++; cl.all++; }
        }
        console.log(`[BT diag] params: dt=${dt} vt=${vt} из ${cs.total} баров`);
        console.log(`[BT diag] POSTREND SHORT:  bear=${cs.bear} delta<-${dt}:${cs.delta} gex:${cs.gex} vol>${vt}:${cs.vol} oi<=0:${cs.oi} spot>zgamma+5:${cs.zgamma} spot<mpos:${cs.mpos} → ${cs.all} сигналов`);
        console.log(`[BT diag] NEGTREND SHORT:  bear=${cn.bear} delta<-${dt}:${cn.delta} gex:${cn.gex} vol<-${vt}:${cn.vol} spot<zgamma-5:${cn.zgamma} spot>mneg:${cn.mneg} → ${cn.all} сигналов`);
        console.log(`[BT diag] POSTREND LONG:   bull=${cl.bull} delta<-${dt}:${cl.delta} gex:${cl.gex} vol>${vt}:${cl.vol} oi>=0:${cl.oi} spot>zgamma+5:${cl.zgamma} spot<mpos:${cl.mpos} → ${cl.all} сигналов`);

        // Также показываем sample значений для отладки
        const sample = bars.slice(0,5).map(b=>({
            dir:b.rb_dir, pdelta:b.rb_prev_delta,
            oi:Math.round(b.gex_sum_oi), vol:Math.round(b.gex_sum_vol),
            spot:b.gex_spot?.toFixed(1), zgamma:b.gex_zero_gamma?.toFixed(1),
            mpos:b.gex_major_pos?.toFixed(1)
        }));
        console.log(`[BT diag] sample bars:`, JSON.stringify(sample));
    }
    let _diagDone = false;

    for (const bar of bars) {
        const close = parseFloat(bar.rb_close ?? bar.close);
        const high  = parseFloat(bar.rb_high  ?? bar.high);
        const low   = parseFloat(bar.rb_low   ?? bar.low);
        const atr   = parseFloat(bar.atr) || 0;
        const tsMs  = typeof bar.timestamp === 'string'
            ? new Date(bar.timestamp.replace(' ','T')+(bar.timestamp.includes('Z')?'':'Z')).getTime()
            : (bar.t ? bar.t * 1000
            : (bar.rb_bar_open_ts ? bar.rb_bar_open_ts  // rb_bar_open_ts уже в ms (из скрипта)
            : 0));
        const hms   = getUTCHMS(tsMs);
        const sod   = secOfDay(hms);
        const isFri = hms.dow === 5;
        const isEOD = sod >= SESSION_CLOSE && hms.dow >= 1 && hms.dow <= 5;
        const inSession = sod >= SESSION_OPEN && sod < SESSION_CLOSE && hms.dow >= 1 && hms.dow <= 5;
        const canEnter  = inSession && (!isFri || sod < FRI_CUTOFF);

        // ── Manage open position ───────────────────────────────────────────
        if (inTrade) {
            let exitPrice = null, exitReason = null;

            // Exit expression
            if (!exitPrice && compiledExit) {
                try { if (compiledExit(bar, bars, barIdx, globalParams)) { exitPrice = close; exitReason = 'EXPR'; } } catch(e) {}
            }

            // Breakeven при +1R прибыли (SL переносится в entry)
            // +1R = прибыль >= размер риска (entry - sl для short, sl - entry для long)
            if (!inTrade.breakevenApplied) {
                const riskPts = Math.abs(inTrade.entry - inTrade.sl);
                const profitPts = inTrade.dir === 'long'
                    ? low - inTrade.entry    // для long смотрим worst case на баре
                    : inTrade.entry - high;  // для short смотрим worst case на баре
                const unrealizedPts = inTrade.dir === 'long'
                    ? close - inTrade.entry
                    : inTrade.entry - close;
                if (unrealizedPts >= riskPts) {
                    inTrade.sl = inTrade.entry; // BE: перенос стопа в точку входа
                    inTrade.breakevenApplied = true;
                }
            }

            // TP/SL check
            if (!exitPrice) {
                if (inTrade.dir === 'long') {
                    if (low  <= inTrade.sl) { exitPrice = inTrade.sl; exitReason = inTrade.breakevenApplied && inTrade.sl === inTrade.entry ? 'BE' : 'SL'; }
                    else if (high >= inTrade.tp) { exitPrice = inTrade.tp; exitReason = 'TP'; }
                } else { // short
                    if (high >= inTrade.sl) { exitPrice = inTrade.sl; exitReason = inTrade.breakevenApplied && inTrade.sl === inTrade.entry ? 'BE' : 'SL'; }
                    else if (low  <= inTrade.tp) { exitPrice = inTrade.tp; exitReason = 'TP'; }
                }
            }

            // Timeout
            if (!exitPrice && cfg.maxBars && (barIdx - inTrade.entryBarIdx) >= cfg.maxBars) {
                exitPrice = close; exitReason = 'TIMEOUT';
            }

            if (exitPrice) {
                // ES Futures P&L: $50/point, $12.50/tick (0.25pt)
                const TICK_SIZE  = 0.25;
                const TICK_VALUE = 12.50;
                const diff = inTrade.dir === 'long' ? exitPrice - inTrade.entry : inTrade.entry - exitPrice;
                const pnl  = (diff / TICK_SIZE) * TICK_VALUE * inTrade.qty;
                const priceTicks = Math.round((exitPrice - inTrade.entry) / TICK_SIZE);
                capital += pnl;
                trades.push({
                    setupName: inTrade.setupName, dir: inTrade.dir,
                    entry: inTrade.entry, exitPrice, exitReason,
                    sl: inTrade.sl, tp: inTrade.tp, qty: inTrade.qty,
                    entryTs: inTrade.entryTs, exitTs: tsMs,
                    barsHeld: barIdx - inTrade.entryBarIdx,
                    capitalBefore: inTrade.capitalBefore,
                    capitalAfter:  +(capital.toFixed(2)),
                    pnl:           +(pnl.toFixed(2)),
                    pnlPct:        +((pnl / inTrade.capitalBefore) * 100).toFixed(2),
                    priceTicks,
                    // bar data at entry
                    rb_delta:       inTrade.bar_rb_delta,
                    rb_prev_delta:  inTrade.bar_rb_prev_delta,
                    rb_ticks:       inTrade.bar_rb_ticks,
                    rb_open:        inTrade.bar_rb_open,
                    rb_close:       inTrade.bar_rb_close,
                    rb_high:        inTrade.bar_rb_high,
                    rb_low:         inTrade.bar_rb_low,
                    gex_zero_gamma: inTrade.bar_gex_zero_gamma,
                    gex_sum_vol:    inTrade.bar_gex_sum_vol,
                    gex_major_neg:  inTrade.bar_gex_major_neg,
                    gex_major_pos:  inTrade.bar_gex_major_pos,
                    gex_sum_oi:     inTrade.bar_gex_sum_oi,
                    gex_spot:       inTrade.bar_gex_spot,
                    gex_has_data:   inTrade.bar_gex_has_data,
                    rb_dir:         bar.rb_dir === 1 ? 1 : 2,
                });
                inTrade = null;
            }
        }

        // ── Pending limit: убран для range-bar режима ────────────────────
        // На уровне range-баров нет тиков между барами — pending limit
        // не работает корректно. Вход происходит немедленно при сигнале.

        // ── Check pending limit order ─────────────────────────────────────
        if (pendingLimit && !inTrade) {
            const barDate = new Date(tsMs).toISOString().slice(0, 10);

            if (barDate !== pendingLimit.placedDate) {
                // Новый день — отменяем лимитку
                pendingLimit = null;
            } else if (pendingLimit.dir === 'short' && high >= pendingLimit.price) {
                // FILL: цена откатилась вверх до лимитки SHORT
                inTrade = {
                    setupName: pendingLimit.setupName, dir: 'short',
                    entry: pendingLimit.price, sl: pendingLimit.sl, tp: pendingLimit.tp,
                    qty: pendingLimit.qty, leverage: cfg.leverage || 1,
                    entryTs: tsMs, entryBarIdx: barIdx,
                    capitalBefore: +(capital.toFixed(2)),
                    breakevenApplied: false,
                    bar_rb_delta:       pendingLimit.bar_rb_delta,
                    bar_rb_prev_delta:  pendingLimit.bar_rb_prev_delta,
                    bar_rb_ticks:       pendingLimit.bar_rb_ticks,
                    bar_rb_open:        pendingLimit.bar_rb_open,
                    bar_rb_close:       pendingLimit.bar_rb_close,
                    bar_rb_high:        pendingLimit.bar_rb_high,
                    bar_rb_low:         pendingLimit.bar_rb_low,
                    bar_gex_zero_gamma: pendingLimit.bar_gex_zero_gamma,
                    bar_gex_sum_vol:    pendingLimit.bar_gex_sum_vol,
                    bar_gex_major_neg:  pendingLimit.bar_gex_major_neg,
                    bar_gex_major_pos:  pendingLimit.bar_gex_major_pos,
                    bar_gex_sum_oi:     pendingLimit.bar_gex_sum_oi,
                    bar_gex_spot:       pendingLimit.bar_gex_spot,
                    bar_gex_has_data:   pendingLimit.bar_gex_has_data,
                };
                pendingLimit = null;
            } else if (pendingLimit.dir === 'long' && low <= pendingLimit.price) {
                // FILL: цена откатилась вниз до лимитки LONG
                inTrade = {
                    setupName: pendingLimit.setupName, dir: 'long',
                    entry: pendingLimit.price, sl: pendingLimit.sl, tp: pendingLimit.tp,
                    qty: pendingLimit.qty, leverage: cfg.leverage || 1,
                    entryTs: tsMs, entryBarIdx: barIdx,
                    capitalBefore: +(capital.toFixed(2)),
                    breakevenApplied: false,
                    bar_rb_delta:       pendingLimit.bar_rb_delta,
                    bar_rb_prev_delta:  pendingLimit.bar_rb_prev_delta,
                    bar_rb_ticks:       pendingLimit.bar_rb_ticks,
                    bar_rb_open:        pendingLimit.bar_rb_open,
                    bar_rb_close:       pendingLimit.bar_rb_close,
                    bar_rb_high:        pendingLimit.bar_rb_high,
                    bar_rb_low:         pendingLimit.bar_rb_low,
                    bar_gex_zero_gamma: pendingLimit.bar_gex_zero_gamma,
                    bar_gex_sum_vol:    pendingLimit.bar_gex_sum_vol,
                    bar_gex_major_neg:  pendingLimit.bar_gex_major_neg,
                    bar_gex_major_pos:  pendingLimit.bar_gex_major_pos,
                    bar_gex_sum_oi:     pendingLimit.bar_gex_sum_oi,
                    bar_gex_spot:       pendingLimit.bar_gex_spot,
                    bar_gex_has_data:   pendingLimit.bar_gex_has_data,
                };
                pendingLimit = null;
            } else if (pendingLimit.dir === 'short' && low <= pendingLimit.cancelPrice) {
                // CANCEL: цена ушла на 10 тиков ниже лимитки — не заполнилась
                pendingLimit = null;
            } else if (pendingLimit.dir === 'long' && high >= pendingLimit.cancelPrice) {
                // CANCEL: цена ушла на 10 тиков выше лимитки — не заполнилась
                pendingLimit = null;
            }
        }

        // ── Check for new entry ────────────────────────────────────────────
        if (!inTrade && !pendingLimit) {
            let triggered = null;
            if (compiledEntry) {
                try {
                    const result = compiledEntry(bar, bars, barIdx, globalParams);

                    if (result) {
                        const first = Object.entries(setupCols)[0];
                        if (first) triggered = { name: first[0], def: first[1] };
                    }
                } catch(e) {}
            } else {
                for (const [name, def] of Object.entries(setupCols)) {
                    const col    = def.column || name;
                    const sigVal = parseInt(bar[col], 10);
                    if (!isNaN(sigVal) && sigVal === 1) { triggered = { name, def }; break; }
                }
            }

            if (triggered && canEnter) {
                const { name, def } = triggered;

                // Direction: rb_dir=1 → bear → SHORT, rb_dir=2 → bull → LONG
                let dir;
                if (bar.rb_dir === 1) {
                    dir = 'short';
                } else if (bar.rb_dir === 2) {
                    dir = 'long';
                } else if (def.dir && def.dir !== 'auto') {
                    dir = def.dir;
                } else {
                    dir = cfg.direction !== 'both' ? cfg.direction : 'short';
                }
                if (cfg.direction !== 'both' && dir !== cfg.direction) { barIdx++; continue; }

                // Entry price: close of signal bar
                const entryPrice = close;
                const limitPrice = entryPrice; // market entry at close

                // Лимитная цена как в Tradeview Advanced:
                // SHORT: limit = rb_close + 0.25 (ask = close + spread)
                // LONG:  limit = rb_close - 0.25 (bid = close - spread)
                // limitPrice уже объявлен выше через const entryPrice/limitPrice
                // SHORT: close + 0.25 (выше), LONG: close - 0.25 (ниже)
                const actualLimitPrice = dir === 'short'
                    ? +(close + TICK_SIZE).toFixed(2)
                    : +(close - TICK_SIZE).toFixed(2);

                // ES Futures: SL=10 тиков (2.50pts), TP=20 тиков (5.00pts) из правил стратегии
                const SL_PTS = 2.50;  // фиксированный из config.json
                const TP_PTS = 5.00;  // фиксированный из config.json
                let sl, tp;
                if (dir === 'short') {
                    sl = +(actualLimitPrice + SL_PTS).toFixed(2);
                    tp = +(actualLimitPrice - TP_PTS).toFixed(2);
                } else {
                    sl = +(actualLimitPrice - SL_PTS).toFixed(2);
                    tp = +(actualLimitPrice + TP_PTS).toFixed(2);
                }

                const qty = 1; // Default 1 ES contract

                // Ставим ЛИМИТНЫЙ ОРДЕР как в Tradeview Advanced:
                // SHORT limit = rb_close + 0.25 (чуть выше закрытия медвежего бара)
                // Заполнение: следующий бар high >= limitPrice
                // Отмена: цена ушла на 10 тиков ниже (low <= limitPrice - 2.50)
                //         или смена UTC-дня
                const cancelTicks = globalParams.cancel_ticks || 10;
                pendingLimit = {
                    setupName: name, dir,
                    price: actualLimitPrice, sl, tp, qty,
                    cancelPrice: dir === 'short'
                        ? +(actualLimitPrice - cancelTicks * TICK_SIZE).toFixed(2)
                        : +(actualLimitPrice + cancelTicks * TICK_SIZE).toFixed(2),
                    placedTs: tsMs, placedDate: new Date(tsMs).toISOString().slice(0,10),
                    bar_rb_delta:       bar.rb_delta       ?? null,
                    bar_rb_prev_delta:  bar.rb_prev_delta  ?? null,
                    bar_rb_ticks:       bar.rb_ticks       ?? null,
                    bar_rb_open:        bar.rb_open        ?? null,
                    bar_rb_close:       bar.rb_close       ?? null,
                    bar_rb_high:        bar.rb_high        ?? null,
                    bar_rb_low:         bar.rb_low         ?? null,
                    bar_gex_zero_gamma: bar.gex_zero_gamma ?? null,
                    bar_gex_sum_vol:    bar.gex_sum_vol    ?? null,
                    bar_gex_major_neg:  bar.gex_major_neg  ?? null,
                    bar_gex_major_pos:  bar.gex_major_pos  ?? null,
                    bar_gex_sum_oi:     bar.gex_sum_oi     ?? null,
                    bar_gex_spot:       bar.gex_spot       ?? null,
                    bar_gex_has_data:   bar.gex_has_data   ?? null,
                };
            }
        }
        barIdx++;
    }
    return trades;
}


// ════════════════════════════════════════════════════════════
// MAIN — runBacktestOnServer
// ════════════════════════════════════════════════════════════

async function runBacktestOnServer(clickhouse, cfg, onProgress) {
    const { ticker, table, setupCols } = cfg;
    if (!Object.keys(setupCols).length) throw new Error('No setup columns defined');
    for (const [name, def] of Object.entries(setupCols)) {
        if (!def.scriptCode) throw new Error(`Setup "${name}": нет scriptCode.`);
    }

    // ── Определяем режим: тики или свечи ───────────────────────────────────
    // Тиковый режим: raw_market_data ИЛИ ES/NQ фьючерсы (у которых есть provider 201)
    const FUTURES_TICKERS = ['ESU6','ESH7','ESZ6','ESM7','NQU6','NQH7','NQZ6','NQM7'];
    const IS_RAW_TICKS = table === 'raw_market_data'
        || cfg.raw_config != null
        || FUTURES_TICKERS.includes(ticker);
    const bars = [];


    if (IS_RAW_TICKS && !cfg.raw_config) {
        const GEX_MAP = {
            ESU6: 'SPX_classic_gex_zero', ESH7: 'SPX_classic_gex_zero',
            ESZ6: 'SPX_classic_gex_zero', ESM7: 'SPX_classic_gex_zero',
            NQU6: 'NDX_classic_gex_zero', NQH7: 'NDX_classic_gex_zero',
            NQZ6: 'NDX_classic_gex_zero', NQM7: 'NDX_classic_gex_zero',
        };
        cfg.raw_config = {
            ticker:       ticker,
            provider_id:  201,
            gex_ticker:   GEX_MAP[ticker] || 'SPX_classic_gex_zero',
            gex_provider: 100,
        };
    }

    if (IS_RAW_TICKS) {
        // ────────────────────────────────────────────────────────────────────
        // РЕЖИМ ТИКОВ: raw_market_data
        // Используется когда interval.clickhouse_table === 'raw_market_data'
        // (например таймфрейм "Тики (raw)" с provider_id=200)
        // ────────────────────────────────────────────────────────────────────
        const rc          = cfg.raw_config || {};
        const tickTicker  = rc.ticker       || ticker;
        const tickProv    = rc.provider_id  || 201; // 201 = Massive bid/ask, 200 = price only
        const gexTicker   = rc.gex_ticker   || 'SPX_classic_gex_zero';
        const gexProv     = rc.gex_provider || 100;

        onProgress?.({ pct: 3, phase: 'loading', message: `Загрузка тиков ${tickTicker}...` });
        console.log(`[BT v7.1] RAW_TICKS mode: ${tickTicker} (prov=${tickProv}), GEX: ${gexTicker}`);

        // Тики
        let tickWhere = 'provider_id = {prov:UInt32} AND ticker = {tkr:String}';
        const tickParams = { prov: tickProv, tkr: tickTicker };
        if (cfg.fromTs) { tickWhere += ' AND toUnixTimestamp(participant_timestamp) >= {fromTs:UInt32}'; tickParams.fromTs = cfg.fromTs; }
        if (cfg.toTs)   { tickWhere += ' AND toUnixTimestamp(participant_timestamp) <= {toTs:UInt32}';   tickParams.toTs   = cfg.toTs;   }

        // ── Потоковая обработка тиков (без накопления в памяти) ──────
        // RangeBar Engine обрабатывается прямо в потоке:
        // строим range-бары на лету, в bars[] кладём только закрытия баров
        const RANGE_PTS = 10; // TODO: брать из cfg.raw_config или параметров сетапа
        const SESSION_START = 14 * 3600 + 30 * 60; // 14:30 UTC
        const SESSION_END   = 21 * 3600;            // 21:00 UTC
        const TICK_SIZE_ES  = 0.25;

        // Lee-Ready state
        let prevPrice = null, prevDir = 0;
        const leeReady = (px) => {
            let dir;
            if (prevPrice === null || px > prevPrice) { dir = 1; prevDir = 1; }
            else if (px < prevPrice)                   { dir = -1; prevDir = -1; }
            else                                        { dir = prevDir; }
            prevPrice = px;
            return dir;
        };

        // Range-bar state (v2 module — только O/H/L/C + факт закрытия)
        let rbState = null;              // RangeBars.newRangeState(...) объект
        let barDelta = 0, barTicks = 0;
        let barOpenTs = 0;
        let sessionDay = null;
        let cumDelta = 0, prevBarDelta = 0;

        // Добавляем фильтр сессии прямо в SQL — уменьшаем объём с 144M до ~10M
        const sessionFilter = ` AND toHour(participant_timestamp) >= 14
                    AND toHour(participant_timestamp) < 21
                    AND toDayOfWeek(participant_timestamp) BETWEEN 1 AND 5`;

        const tickRs = await clickhouse.query({
            query: `SELECT participant_timestamp AS timestamp,
                    toFloat64(price) AS price,
                    toFloat64(size)  AS size,
                    toFloat64(JSONExtractFloat(extra, 'ask_price')) AS ask_price,
                    toFloat64(JSONExtractFloat(extra, 'bid_price')) AS bid_price,
                    toFloat64(JSONExtractFloat(extra, 'ask_size'))  AS ask_size,
                    toFloat64(JSONExtractFloat(extra, 'bid_size'))  AS bid_size,
                    toUnixTimestamp(participant_timestamp) AS t
                    FROM default.raw_market_data
                    WHERE ${tickWhere}${sessionFilter}
                    ORDER BY participant_timestamp ASC`,
            format: 'JSONEachRow', query_params: tickParams,
            clickhouse_settings: { max_execution_time: 600 },
        });

        let tickCount = 0;
        const tickStream = tickRs.stream();
        for await (const rows of tickStream) {
            for (const rawRow of rows) {
                const row = rawRow?.text ? JSON.parse(rawRow.text) : rawRow;

                // Mid price
                const askPx = parseFloat(row.ask_price) || 0;
                const bidPx = parseFloat(row.bid_price) || 0;
                const px = (askPx > 0 && bidPx > 0) ? (askPx + bidPx) / 2 : parseFloat(row.price) || 0;
                if (!px) continue;

                const tSec = parseInt(row.t, 10);
                const tsMs = tSec * 1000;
                const d    = new Date(tsMs);
                const dow  = d.getUTCDay();
                if (dow === 0 || dow === 6) continue;
                const sod  = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
                if (sod < SESSION_START || sod >= SESSION_END) continue;

                const tickDate = d.toISOString().slice(0, 10);
                if (tickDate !== sessionDay) {
                    sessionDay = tickDate;
                    rbState = null;
                    barDelta = 0; barTicks = 0; barOpenTs = 0;
                    cumDelta = 0; prevBarDelta = 0;
                    prevPrice = null; prevDir = 0;
                }

                // Volume delta
                const askSz = parseFloat(row.ask_size) || 0;
                const bidSz = parseFloat(row.bid_size) || 0;
                const tickDelta = (askSz > 0 || bidSz > 0) ? (askSz - bidSz) : leeReady(px);

                if (rbState === null) {
                    // Первый тик сессии/дня — затравка бара
                    rbState   = RangeBars.newRangeState(RANGE_PTS, px);
                    barOpenTs = tsMs;
                    barDelta  = tickDelta;
                    barTicks  = 1;
                    cumDelta += tickDelta;
                } else {
                    const { completed } = RangeBars.rangeStep(rbState, px, 0);

                    if (completed.length > 0) {
                        // v2-спека: закрывается максимум ОДИН бар за тик.
                        const closed = completed[0];
                        const dir = RangeBars.classifySide(closed) === 'bear' ? 1 : 2;
                        // GEX присоединяется позже, отдельным шагом (GEX JOIN ниже).

                        bars.push({
                            timestamp:      row.timestamp,
                            t:              tSec,
                            rb_dir:         dir,
                            rb_delta:       barDelta,
                            rb_prev_delta:  prevBarDelta,
                            rb_cum_delta:   cumDelta,
                            rb_ticks:       barTicks,
                            rb_open:        closed.open,
                            rb_high:        closed.high,
                            rb_low:         closed.low,
                            rb_close:       closed.close,
                            rb_bar_open_ts: barOpenTs,
                        });

                        prevBarDelta = barDelta;
                        // Тик, вызвавший overflow, становится затравкой НОВОГО бара —
                        // он не входит в закрытый (совпадает с семантикой rangeStep).
                        barOpenTs = tsMs;
                        barDelta  = tickDelta;
                        barTicks  = 1;
                    } else {
                        barDelta += tickDelta;
                        barTicks++;
                    }
                    cumDelta += tickDelta;
                }
                tickCount++;
            }
            if (tickCount % 500000 === 0 && tickCount > 0) {
                onProgress?.({ pct: 10 + Math.min(20, tickCount / 500000), phase: 'loading',
                    message: `Обработка тиков: ${tickCount.toLocaleString()}, баров: ${bars.length}...` });
            }
        }
        // GEX будет присоединён через getGEX в воркере — бары уже готовы
        onProgress?.({ pct: 25, phase: 'loading', message: `${bars.length.toLocaleString()} тиков. Загрузка GEX...` });

        // GEX данные
        let gexWhere = 'provider_id = {gprov:UInt32} AND ticker = {gtkr:String}';
        const gexParams = { gprov: gexProv, gtkr: gexTicker };
        if (cfg.fromTs) { gexWhere += ' AND toUnixTimestamp(participant_timestamp) >= {fromTs:UInt32}'; gexParams.fromTs = cfg.fromTs; }
        if (cfg.toTs)   { gexWhere += ' AND toUnixTimestamp(participant_timestamp) <= {toTs:UInt32}';   gexParams.toTs   = cfg.toTs;   }

        const gexRs = await clickhouse.query({
            query: `SELECT participant_timestamp AS ts,
                    toFloat64(JSONExtractFloat(extra, 'spot'))          AS spot,
                    toFloat64(JSONExtractFloat(extra, 'zero_gamma'))    AS zero_gamma,
                    toFloat64(JSONExtractFloat(extra, 'major_neg_vol')) AS major_neg_vol,
                    toFloat64(JSONExtractFloat(extra, 'major_pos_vol')) AS major_pos_vol,
                    toFloat64(JSONExtractFloat(extra, 'sum_gex_vol'))   AS sum_gex_vol,
                    toFloat64(JSONExtractFloat(extra, 'sum_gex_oi'))    AS sum_gex_oi
                    FROM default.raw_market_data
                    WHERE ${gexWhere}
                    ORDER BY participant_timestamp ASC`,
            format: 'JSONEachRow', query_params: gexParams,
            clickhouse_settings: { max_execution_time: 300 },
        });
        cfg._gex_data = await gexRs.json();
        const gexCount = cfg._gex_data.length;
        onProgress?.({ pct: 35, phase: 'loading',
            message: `${bars.length.toLocaleString()} range-баров + ${gexCount.toLocaleString()} GEX` });
        console.log(`[BT v7.1] RangeBars: ${bars.length}, GEX: ${gexCount}`);

        // ── GEX JOIN: присоединяем GEX к каждому range-бару ────────
        if (bars.length > 0 && gexCount > 0) {
            // Строим индекс GEX по timestamp ms
            const gexTs = cfg._gex_data.map(g => new Date(g.ts).getTime());

            const getGEX = (tsMs) => {
                let lo = 0, hi = gexTs.length - 1, res = -1;
                while (lo <= hi) {
                    const mid = (lo + hi) >> 1;
                    if (gexTs[mid] <= tsMs) { res = mid; lo = mid + 1; }
                    else hi = mid - 1;
                }
                if (res < 0) return null;
                const gexDate = new Date(gexTs[res]).toISOString().slice(0, 10);
                const reqDate = new Date(tsMs).toISOString().slice(0, 10);
                if (gexDate !== reqDate) return null;
                return cfg._gex_data[res];
            };

            for (const bar of bars) {
                const gex = getGEX(bar.rb_bar_open_ts || bar.t * 1000);
                if (gex) {
                    bar.gex_spot         = parseFloat(gex.spot)          || 0;
                    bar.gex_zero_gamma   = parseFloat(gex.zero_gamma)    || 0;
                    bar.gex_major_neg    = parseFloat(gex.major_neg_vol) || 0;
                    bar.gex_major_pos    = parseFloat(gex.major_pos_vol) || 0;
                    bar.gex_sum_vol      = parseFloat(gex.sum_gex_vol)   || 0;
                    bar.gex_sum_oi       = parseFloat(gex.sum_gex_oi)    || 0;
                    bar.gex_has_data     = 1;
                } else {
                    bar.gex_spot = 0; bar.gex_zero_gamma = 0;
                    bar.gex_major_neg = 0; bar.gex_major_pos = 0;
                    bar.gex_sum_vol = 0; bar.gex_sum_oi = 0;
                    bar.gex_has_data = 0;
                }
            }
            // Освобождаем GEX данные из памяти
            cfg._gex_data = null;
            onProgress?.({ pct: 38, phase: 'loading', message: 'GEX присоединён к барам' });
        }

    } else {
        // ────────────────────────────────────────────────────────────────────
        // РЕЖИМ СВЕЧЕЙ: market_data_* (стандартный)
        // ────────────────────────────────────────────────────────────────────
        let whereClause = 'WHERE ticker = {ticker:String}';
        const queryParams = { ticker };
        if (cfg.fromTs) { whereClause += ' AND toUnixTimestamp(window_start) >= {fromTs:UInt32}'; queryParams.fromTs = cfg.fromTs; }
        if (cfg.toTs)   { whereClause += ' AND toUnixTimestamp(window_start) <= {toTs:UInt32}';   queryParams.toTs   = cfg.toTs;   }

        onProgress?.({ phase: 'loading', pct: 0, message: 'Загрузка данных...' });
        const resultSet = await clickhouse.query({
            query: `SELECT window_start AS timestamp,
                toFloat64(open) AS open, toFloat64(high) AS high,
                toFloat64(low) AS low, toFloat64(close) AS close,
                toFloat64OrZero(toString(coalesce(volume,0))) AS volume,
                toFloat64OrZero(toString(coalesce(0,0))) AS atr
                FROM ${table} ${whereClause} ORDER BY window_start ASC`,
            format: 'JSONEachRow', query_params: queryParams,
            clickhouse_settings: { max_execution_time: 3600 },
        });
        const stream = resultSet.stream();
        for await (const rows of stream) {
            for (const rawRow of rows) {
                const row = rawRow?.text ? JSON.parse(rawRow.text) : rawRow;
                const rawTs = row.timestamp || row.window_start;
                let tSec = 0;
                if (typeof rawTs === 'number') tSec = rawTs;
                else if (typeof rawTs === 'string') {
                    tSec = Math.floor(new Date(rawTs.replace(' ','T')+(rawTs.includes('Z')?'':'Z')).getTime() / 1000);
                }
                const o=parseFloat(row.open), h=parseFloat(row.high);
                const l=parseFloat(row.low),  c=parseFloat(row.close);
                const v=parseFloat(row.volume)||0;
                bars.push({ timestamp: rawTs, open: o, high: h, low: l, close: c, volume: v,
                    atr: parseFloat(row.atr)||0, t: tSec, o, h, l, c, v });
            }
            if (bars.length % 50000 === 0 && bars.length > 0) {
                onProgress?.({ pct: Math.min(25, bars.length/4000), phase: 'loading',
                    message: `Загрузка: ${bars.length.toLocaleString()} баров...` });
            }
        }
        // Автолимит только для свечей
        const MAX_BARS = 200_000;
        if (bars.length > MAX_BARS) {
            const step = Math.ceil(bars.length / MAX_BARS);
            const sampled = bars.filter((_,i) => i % step === 0);
            bars.length = 0; for (const b of sampled) bars.push(b);
            console.log(`[BT v7.1] Sampled → ${bars.length} bars`);
        }
        onProgress?.({ phase: 'loading', pct: 28, message: `Загружено: ${bars.length.toLocaleString()} баров` });

        // MTF (только для свечного режима)
        const upTables = cfg.mtfUpTables || [];
        if (upTables.length) {
            onProgress?.({ phase: 'mtf', pct: 30, message: `Загрузка MTF...` });
            await loadMTFData(clickhouse, ticker, bars, upTables, cfg.fromTs, cfg.toTs);
        }
    }

    // ── Упаковываем в SAB ───────────────────────────────────────────────────
    onProgress?.({ phase: 'script', pct: 36, message: 'Подготовка данных...' });
    console.log(`[BT v7.1] Bars to process: ${bars.length} (IS_RAW_TICKS=${IS_RAW_TICKS})`);

    // В тиковом режиме range-бары уже построены потоково — пропускаем скрипты
    // GEX данные уже присоединены через потоковую обработку
    // Сразу переходим к бэктесту
    if (IS_RAW_TICKS) {
        onProgress?.({ phase: 'bars', pct: 84, message: `${bars.length} range-баров построено` });
        const trades = runBacktestOnBars(bars, cfg);
        onProgress?.({ phase: 'done', pct: 100, message: `Готово: ${trades.length} сделок` });
        console.log(`[BT v7.1] Done: ${trades.length} trades`);

        // Лёгкая версия ВСЕХ range-баров (независимо от сделок) — фронтенд
        // использует её как отдельную статическую серию (resolution 'RB'),
        // поэтому навигация к любой дате бэктеста (включая март) работает
        // мгновенно, без повторных походов на сервер.
        const barsForChart = bars.map(b => ({
            t:     b.t,
            open:  b.rb_open,
            high:  b.rb_high,
            low:   b.rb_low,
            close: b.rb_close,
            dir:   b.rb_dir,
            delta: b.rb_delta,
            ticks: b.rb_ticks,
        }));

        return { trades, barsProcessed: bars.length, barsForChart, logs: [] };
    }

    const { sab, floats, timestamps } = barsToSAB(bars);
    const barCount = bars.length;

    // ── Запускаем скрипты через пул ─────────────────────────────────────────
    const scriptGroups = new Map();
    for (const [name, def] of Object.entries(setupCols)) {
        const code = def.scriptCode || '';
        if (!scriptGroups.has(code)) scriptGroups.set(code, { names: [], def });
        scriptGroups.get(code).names.push(name);
    }

    const allLogs   = [];
    const extraKeys = [];
    let scriptIdx   = 0;
    const scriptTotal = scriptGroups.size;

    for (const [scriptCode, { names, def }] of scriptGroups) {
        scriptIdx++;
        const pct = 37 + Math.round((scriptIdx / scriptTotal) * 43);
        onProgress?.({ phase: `script:${scriptIdx}/${scriptTotal}`, pct,
            message: `Скрипт ${scriptIdx}/${scriptTotal}: ${names[0]}...` });

        const paramOverrides  = def.params || {};
        const newExtraStart   = extraKeys.length;

        // Передаём GEX данные в воркер для тикового режима
        const gexData = IS_RAW_TICKS ? (cfg._gex_data || []) : [];

        // Prepare bid/ask arrays for volume delta calculation
        const askPrices = IS_RAW_TICKS ? bars.map(b => b.ask_price || 0) : [];
        const bidPrices = IS_RAW_TICKS ? bars.map(b => b.bid_price || 0) : [];
        const askSizes  = IS_RAW_TICKS ? bars.map(b => b.ask_size  || 0) : [];
        const bidSizes  = IS_RAW_TICKS ? bars.map(b => b.bid_size  || 0) : [];

        let result;
        try {
            result = await pool.run({
                sab, barCount,
                stride:       BAR_STRIDE,
                fieldCount:   FIELD_COUNT,
                extraSlots:   EXTRA_SLOTS,
                extraKeys:    [...extraKeys],
                newExtraStart,
                scriptCode,
                paramOverrides,
                timestamps,
                gexData,     // ← GEX для RangeBar Engine
                askPrices, bidPrices, askSizes, bidSizes, // ← bid/ask для volume delta
            });
        } catch(e) {
            console.error(`[BT v7.1] Worker error [${names}]: ${e.message}`);
            allLogs.push(['error', `Worker error: ${e.message}`]);
            continue;
        }

        allLogs.push(...(result.logs || []));
        if (result.error) { allLogs.push(['error', `Script error: ${result.error}`]); continue; }

        // Печатаем логи скрипта в консоль сервера для отладки
        for (const [level, msg] of (result.logs || [])) {
            console.log(`[Script:${names[0]}] [${level}] ${msg}`);
        }

        // Регистрируем новые ключи
        for (const { key, slot } of result.writtenKeys || []) {
            while (extraKeys.length <= slot) extraKeys.push(null);
            extraKeys[slot] = key;
        }
        if (result.newKeys?.length) console.log(`[BT v7.1] "${names[0]}" added: ${result.newKeys.join(', ')}`);

        for (const [sn, sd] of Object.entries(result.setups || {})) {
            if (setupCols[sn]) {
                setupCols[sn] = { ...sd, ...setupCols[sn],
                    entryCol:  setupCols[sn].entryCol  || sd.entryCol,
                    slCol:     setupCols[sn].slCol     || sd.slCol,
                    tpCol:     setupCols[sn].tpCol     || sd.tpCol,
                    dirColumn: setupCols[sn].dirColumn || sd.dirColumn,
                };
            }
        }
    }

    // ── Читаем extra поля из SAB → bars[] ───────────────────────────────────
    onProgress?.({ phase: 'merge', pct: 82, message: 'Подготовка к бэктесту...' });
    for (let i = 0; i < barCount; i++) {
        const off = i * BAR_STRIDE;
        for (let e = 0; e < extraKeys.length; e++) {
            const key = extraKeys[e];
            if (!key) continue;
            const val = floats[off + FIELD_COUNT + e];
            if (val !== NAN_MARKER) bars[i][key] = val;
        }
    }

    // ── Тиковый режим: фильтруем только закрытия range-баров ───────────────
    if (IS_RAW_TICKS) {
        const barCloses = bars.filter(b => b.rb_dir);
        console.log(`[BT v7.1] ${bars.length} ticks → ${barCloses.length} range-bar closes`);
        if (barCloses.length === 0) {
            console.warn('[BT v7.1] No range-bar closes — RangeBar Engine не сработал');
        }
        bars.length = 0;
        for (const b of barCloses) bars.push(b);

        // Подменяем OHLC из rb_* полей (закрытие бара — главная цена)
        for (const b of bars) {
            if (b.rb_open  != null) b.open  = b.rb_open;
            if (b.rb_high  != null) b.high  = b.rb_high;
            if (b.rb_low   != null) b.low   = b.rb_low;
            if (b.rb_close != null) b.close = b.rb_close;
            b.o = b.open; b.h = b.high; b.l = b.low; b.c = b.close;
        }
        onProgress?.({ phase: 'bars', pct: 84,
            message: `${bars.length} range-баров построено` });
        if (bars.length > 0) {
            const b = bars[0];
            const tsMs0 = typeof b.timestamp === 'string'
                ? new Date(b.timestamp.replace(' ','T')+(b.timestamp.includes('Z')?'':'Z')).getTime()
                : (b.t ? b.t * 1000 : (b.rb_bar_open_ts || 0));
            console.log(`[BT diag] first bar after filter: ts=${new Date(tsMs0).toISOString()} t=${b.t} ts_str=${b.timestamp?.slice(0,20)} rb_open_ts=${b.rb_bar_open_ts}`);
        }
    }

    // ── Бэктест ─────────────────────────────────────────────────────────────
    onProgress?.({ phase: 'backtest', pct: 85, message: `Прогон по ${bars.length.toLocaleString()} барам...` });
    const trades = runBacktestOnBars(bars, cfg);
    onProgress?.({ phase: 'done', pct: 100, message: `Готово: ${trades.length} сделок` });
    console.log(`[BT v7.1] Done: ${trades.length} trades`);

    return { trades, barsProcessed: bars.length, logs: allLogs };
}

// ════════════════════════════════════════════════════════════
// STATS
// ════════════════════════════════════════════════════════════

function calcStats(trades, startCapital) {
    if (!trades.length) return null;
    const wins   = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const endCap   = trades[trades.length - 1]?.capitalAfter || startCapital;
    let peak = startCapital, maxDD = 0, cap = startCapital;
    for (const t of trades) {
        cap = t.capitalAfter;
        if (cap > peak) peak = cap;
        const dd = (peak - cap) / peak * 100;
        if (dd > maxDD) maxDD = dd;
    }
    const avgWin  = wins.length   ? wins.reduce((s,t)=>s+t.pnl,0)   / wins.length   : 0;
    const avgLoss = losses.length ? losses.reduce((s,t)=>s+t.pnl,0) / losses.length : 0;
    const grossW  = wins.reduce((s,t)=>s+t.pnl,0);
    const grossL  = Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
    const byExit  = {};
    trades.forEach(t => { byExit[t.exitReason] = (byExit[t.exitReason]||0)+1; });
    return {
        total:        trades.length,
        wins:         wins.length,
        losses:       losses.length,
        winRate:      +(wins.length / trades.length * 100).toFixed(1),
        totalPnl:     +totalPnl.toFixed(2),
        totalPnlPct:  +((endCap - startCapital) / startCapital * 100).toFixed(2),
        endCapital:   +endCap.toFixed(2),
        avgWin:       +avgWin.toFixed(2),
        avgLoss:      +avgLoss.toFixed(2),
        // ES Futures specific
        avgWinTicks:  wins.length   ? +(avgWin  / 12.5).toFixed(1) : 0,
        avgLossTicks: losses.length ? +(Math.abs(avgLoss) / 12.5).toFixed(1) : 0,
        rr:           +(avgLoss ? Math.abs(avgWin / avgLoss) : 0).toFixed(2),
        maxDD:        +maxDD.toFixed(2),
        expectancy:   +((wins.length/trades.length * avgWin) + (losses.length/trades.length * avgLoss)).toFixed(2),
        profitFactor: grossL ? +(grossW / grossL).toFixed(2) : 0,
        byExit,
    };
}

// ════════════════════════════════════════════════════════════
// DATE RANGE — поддерживает оба режима
// ════════════════════════════════════════════════════════════

async function getDateRange(clickhouse, ticker, table) {
    // Тиковый режим
    if (table === 'raw_market_data') {
        const result = await clickhouse.query({
            query: `SELECT min(participant_timestamp) AS min_ts,
                    max(participant_timestamp) AS max_ts,
                    count() AS total_rows
                    FROM default.raw_market_data
                    WHERE provider_id = 200 AND ticker = {ticker:String}`,
            format: 'JSONEachRow', query_params: { ticker },
        });
        const rows = await result.json();
        if (!rows.length || !rows[0].min_ts) throw new Error(`No tick data for ${ticker}`);
        return { min: rows[0].min_ts, max: rows[0].max_ts, totalRows: parseInt(rows[0].total_rows, 10) };
    }
    // Свечной режим
    const result = await clickhouse.query({
        query: `SELECT min(window_start) AS min_ts, max(window_start) AS max_ts, count() AS total_rows
                FROM ${table} WHERE ticker = {ticker:String}`,
        format: 'JSONEachRow', query_params: { ticker },
    });
    const rows = await result.json();
    if (!rows.length || !rows[0].min_ts) throw new Error(`No data for ${ticker} in ${table}`);
    return { min: rows[0].min_ts, max: rows[0].max_ts, totalRows: parseInt(rows[0].total_rows, 10) };
}

module.exports = { runBacktestOnServer, runBacktestOnBars, calcStats, getDateRange };