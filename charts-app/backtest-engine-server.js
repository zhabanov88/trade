/**
 * backtest-engine-server.js  v4.0
 *
 * ══════════════════════════════════════════════════════════════════
 * АРХИТЕКТУРА
 * ══════════════════════════════════════════════════════════════════
 *
 * Проблема:
 *   JS-скрипты (как 6226) — stateful state machines, которые нельзя
 *   выразить SQL. Физических колонок в ClickHouse нет.
 *
 * Решение:
 *   1. Загружаем сырые OHLCV-данные из ClickHouse в Node.js (стримом)
 *   2. Запускаем оригинальный JS-код скрипта через vm.Script (sandbox)
 *      — тот же самый код что работает в браузере
 *   3. Скрипт заполняет массив bars[] сигналами (bar['6226_signal'] = 1/2/3/4)
 *   4. Читаем сигналы, прогоняем бектест-движок
 *   5. Возвращаем трейды и статистику
 *
 * Это "копия работы логики JS-функций на сервере" — дословно.
 *
 * Экспортирует:
 *   runBacktestOnServer(clickhouse, cfg, onProgress) → { trades, barsProcessed }
 *   calcStats(trades, startCapital) → stats
 *   getDateRange(clickhouse, ticker, table) → { min, max, totalRows }
 */

'use strict';

const vm = require('vm');

// ══════════════════════════════════════════════════════════════
// SCRIPT SANDBOX — запускает JS-код скрипта на массиве баров
// ══════════════════════════════════════════════════════════════

/**
 * Запускает JS-код скрипта в изолированном sandbox.
 * Передаёт bars[] через window.app.activedata.
 * После выполнения читает window.app.setups.
 *
 * @param {string} scriptCode
 * @param {Array}  bars  — массив объектов с OHLCV + timestamp
 * @returns {{ setups, bars, logs, error }}
 */
function runScriptOnBars(scriptCode, bars) {
    const logs = [];
    const sandbox = {
        window: {
            app: {
                activedata: bars,
                setups: {},
            },
        },
        console: {
            log:   (...a) => logs.push(['log',   a.join(' ')]),
            warn:  (...a) => logs.push(['warn',  a.join(' ')]),
            error: (...a) => logs.push(['error', a.join(' ')]),
        },
        Date,
        Math,
        JSON,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        Number,
        String,
        Array,
        Object,
        Infinity,
        NaN,
        undefined,
        setTimeout: () => {},
        clearTimeout: () => {},
    };

    try {
        // Оборачиваем: большинство скриптов уже IIFE, но на всякий случай
        // Если скрипт начинается с (function... — он уже самовызывающийся
        const needsWrap = !scriptCode.trim().startsWith('(function');
        const code = needsWrap
            ? `(function(){\n${scriptCode}\n})();`
            : scriptCode;

        const script = new vm.Script(code, {
            filename: 'user-script.js',
        });
        script.runInNewContext(sandbox, { timeout: 60000 }); // 60s max

        // Диагностика: покажем первые несколько timestamp из баров
        if (bars.length > 0) {
            const sample = bars.slice(0, 3);
            sample.forEach((b, i) => {
                const ts = b.timestamp;
                const d = new Date(typeof ts === 'string' ? ts.replace(' ', 'T') + 'Z' : ts);
                const h = (d.getUTCHours() + 3 + 24) % 24;
                logs.push(['log', `[DBG] bar[${i}] ts="${ts}" type=${typeof ts} → UTC+3 hour=${h}`]);
            });
            // Сколько сигналов поставил скрипт
            const sig1 = bars.filter(b => b['6226_signal'] === 1).length;
            const liq  = bars.filter(b => b['6226_liq']    === 1).length;
            logs.push(['log', `[DBG] После скрипта: signal=1 count=${sig1}, liq count=${liq}`]);
        }
        return { setups: sandbox.window.app.setups || {}, bars, logs, error: null };
    } catch (err) {
        return { setups: {}, bars, logs, error: err.message };
    }
}

// ══════════════════════════════════════════════════════════════
// CALC HELPERS — идентичны клиентской версии
// ══════════════════════════════════════════════════════════════

function calcSL(close, atr, cfg, dir) {
    const d = cfg.slMode === 'atr'
        ? (atr || close * 0.01) * cfg.slValue
        : close * cfg.slValue / 100;
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
    const riskAmt  = capital * cfg.riskPct / 100;
    const riskPerU = Math.abs(entry - sl);
    if (riskPerU <= 0) return 0;
    
    const PIP = 0.0001;
    const PIP_VALUE_PER_LOT = 10;
    const riskPips = riskPerU / PIP;
    if (riskPips < 0.1) return 0; // защита от деления на почти ноль
    
    const lots = riskAmt / (riskPips * PIP_VALUE_PER_LOT);
    
    // Максимум 100 лотов — защита от аномалий
    return Math.min(lots * cfg.leverage, 100);
}

// ══════════════════════════════════════════════════════════════
// BACKTEST ENGINE — прогоняет бектест по bars[] с сигналами
// ══════════════════════════════════════════════════════════════

/**
 * Прогоняет бектест по массиву bars[] с уже заполненными сигналами.
 *
 * setupCols: {
 *   "6226": {
 *     column: "6226_signal",
 *     dir: "auto" | "long" | "short",
 *     exitRules: [{ status: 3, label: "TP" }],
 *     dirColumn: "6226_dir",       // опционально: колонка с направлением (1=long, -1=short)
 *     entryCol:  "6226_entry",     // опционально: кастомный entry price
 *     slCol:     "6226_sl",        // опционально: кастомный SL из скрипта
 *     tpCol:     "6226_tp",        // опционально: кастомный TP из скрипта
 *   }
 * }
 */
function runBacktestOnBars(bars, cfg) {
    const { setupCols } = cfg;
    const trades  = [];
    let capital   = cfg.capital;
    const startCapital = cfg.capital; // фиксированный для расчёта qty
    let inTrade   = null;
    let barIdx    = 0;

    for (const bar of bars) {
        const close = parseFloat(bar.close);
        const high  = parseFloat(bar.high);
        const low   = parseFloat(bar.low);
        const atr   = parseFloat(bar.atr) || 0;
        const ts    = new Date(bar.timestamp).getTime();

        // ── Управление открытой позицией ─────────────────────────────────
        if (inTrade) {
            let exitPrice = null, exitReason = null;

            // 1. Кастомный выход из скрипта (status >= 3 в сигнальной колонке)
            if (cfg.useColExit) {
                const sigVal = parseInt(bar[inTrade.col], 10);
                if (!isNaN(sigVal) && sigVal >= 3) {
                    const def   = setupCols[inTrade.setupName] || {};
                    const rules = def.exitRules || [];
                    const rule  = rules.find(r => r.status === sigVal);
                    exitPrice  = close;
                    exitReason = rule?.label || `Status ${sigVal}`;
                }
            }

            // 2. Фиксированный SL/TP (из cfg или из колонок скрипта)
            if (!exitPrice) {
                const sl = inTrade.sl;
                const tp = inTrade.tp;
                if (inTrade.dir === 'long') {
                    if (low  <= sl) { exitPrice = sl;  exitReason = 'SL'; }
                    else if (high >= tp) { exitPrice = tp; exitReason = 'TP'; }
                } else {
                    if (high >= sl) { exitPrice = sl;  exitReason = 'SL'; }
                    else if (low  <= tp) { exitPrice = tp; exitReason = 'TP'; }
                }
            }

            // 3. Timeout
            if (!exitPrice && (barIdx - inTrade.entryBarIdx) >= cfg.maxBars) {
                exitPrice = close; exitReason = 'TIMEOUT';
            }

            if (exitPrice) {
                const PIP = 0.0001;
                const PIP_VALUE_PER_LOT = 10; // $10 за пипс за лот (EUR/USD)
                const priceDiff = inTrade.dir === 'long'
                    ? exitPrice - inTrade.entry
                    : inTrade.entry - exitPrice;
                const pnl = (priceDiff / PIP) * PIP_VALUE_PER_LOT * inTrade.qty;
                
                // Защита от аномальных значений
                if (Math.abs(pnl) > inTrade.capitalBefore * 0.5) {
                    console.log(`[ANOMALY] trade #${trades.length + 1}: pnl=${pnl.toFixed(2)} capitalBefore=${inTrade.capitalBefore.toFixed(2)} qty=${inTrade.qty} entry=${inTrade.entry} exit=${exitPrice} sl=${inTrade.sl}`);
                }

                capital += pnl;

                if (trades.length === 0) {
                    console.log('[DBG Trade#1] dir:', inTrade.dir);
                    console.log('[DBG Trade#1] entry:', inTrade.entry, 'exit:', exitPrice);
                    console.log('[DBG Trade#1] sl:', inTrade.sl, 'tp:', inTrade.tp);
                    console.log('[DBG Trade#1] qty:', inTrade.qty);
                    console.log('[DBG Trade#1] pnl:', pnl);
                    console.log('[DBG Trade#1] capital before:', inTrade.capitalBefore);
                }

                trades.push({
                    setupName:     inTrade.setupName,
                    col:           inTrade.col,
                    dir:           inTrade.dir,
                    entry:         inTrade.entry,
                    exitPrice,
                    exitReason,
                    sl:            inTrade.sl,
                    tp:            inTrade.tp,
                    qty:           inTrade.qty,
                    leverage:      inTrade.leverage,
                    entryTs:       inTrade.entryTs,
                    exitTs:        ts,
                    entryBarIdx:   inTrade.entryBarIdx,
                    exitBarIdx:    barIdx,
                    barsHeld:      barIdx - inTrade.entryBarIdx,
                    capitalBefore: inTrade.capitalBefore,
                    capitalAfter:  +(capital.toFixed(2)),
                    riskAmt:       inTrade.riskAmt,
                    pnl:           +(pnl.toFixed(4)),
                    pnlPct:        +((pnl / inTrade.capitalBefore) * 100).toFixed(2),
                });
                inTrade = null;
            }
        }

        // ── Поиск входа ──────────────────────────────────────────────────
        if (!inTrade) {
            for (const [name, def] of Object.entries(setupCols)) {
                const col    = def.column || name;
                const sigVal = parseInt(bar[col], 10);
                if (isNaN(sigVal) || sigVal !== 1) continue;

                // Определяем направление
                let dir;
                if (def.dir === 'auto') {
                    // Читаем из отдельной колонки направления (6226_dir: 1=long, -1=short)
                    const dirColName = def.dirColumn || (col.replace('_signal', '_dir'));
                    const dirVal = parseFloat(bar[dirColName]);
                    dir = dirVal >= 0 ? 'long' : 'short';
                } else {
                    dir = def.dir || (cfg.direction !== 'both' ? cfg.direction : 'long');
                }

                if (cfg.direction !== 'both' && dir !== cfg.direction) continue;

                // Берём SL/TP: из колонок скрипта (если есть) или из cfg
                let sl, tp, entry;

                const entryColName = def.entryCol || (col.replace('_signal', '_entry'));
                const slColName    = def.slCol    || (col.replace('_signal', '_sl'));
                const tpColName    = def.tpCol    || (col.replace('_signal', '_tp'));

                const scriptEntry = parseFloat(bar[entryColName]);
                const scriptSl    = parseFloat(bar[slColName]);
                const scriptTp    = parseFloat(bar[tpColName]);

                // Используем колонки скрипта если хотя бы entry задан и не ноль
                if (scriptEntry > 0 && scriptSl > 0) {
                    // Скрипт сам посчитал entry/sl/tp (как 6226)
                    entry = scriptEntry;
                    sl    = scriptSl;
                    tp    = scriptTp;
                } else {
                    // Используем cfg
                    entry = close;
                    sl    = calcSL(close, atr, cfg, dir);
                    tp    = calcTP(entry, sl, cfg, dir);
                }

                const qty = calcQty(startCapital, entry, sl, cfg);
                if (qty <= 0) continue;

                inTrade = {
                    setupName:     name,
                    ticker:        cfg.ticker    || '',
                    timeframe:     cfg.table     || '',
                    col,
                    dir,
                    entry,
                    sl, tp, qty,
                    leverage:      cfg.leverage,
                    entryTs:       ts,
                    entryBarIdx:   barIdx,
                    capitalBefore: +(capital.toFixed(2)),
                    riskAmt:       +(capital * cfg.riskPct / 100).toFixed(2),
                };
                break;
            }
        }

        barIdx++;
    }

    return trades;
}

// ══════════════════════════════════════════════════════════════
// MAIN — загрузка данных + выполнение скрипта + бектест
// ══════════════════════════════════════════════════════════════

/**
 * cfg = {
 *   ticker, table,
 *   fromTs, toTs,
 *   capital, riskPct, leverage,
 *   slMode, slValue,
 *   tpMode, tpValue,
 *   maxBars, direction, useColExit,
 *
 *   // Для каждого сетапа:
 *   setupCols: {
 *     "6226": {
 *       column:     "6226_signal",   // сигнальная колонка
 *       dir:        "auto",          // или "long"/"short"
 *       dirColumn:  "6226_dir",      // колонка направления (для auto)
 *       entryCol:   "6226_entry",    // кастомный entry (если скрипт считает)
 *       slCol:      "6226_sl",       // кастомный SL
 *       tpCol:      "6226_tp",       // кастомный TP
 *       exitRules:  [{ status: 3, label: "TP -0.26" }],
 *       scriptCode: "...",           // JS-код скрипта из БД
 *     }
 *   }
 * }
 */
async function runBacktestOnServer(clickhouse, cfg, onProgress) {
    const { ticker, table, setupCols } = cfg;

    if (!Object.keys(setupCols).length) {
        throw new Error('No setup columns defined');
    }

    // ── Загружаем данные из ClickHouse ───────────────────────────────────
    let whereClause = 'WHERE ticker = {ticker:String}';
    const queryParams = { ticker };
    if (cfg.fromTs) { whereClause += ' AND toUnixTimestamp(window_start) >= {fromTs:UInt32}'; queryParams.fromTs = cfg.fromTs; }
    if (cfg.toTs)   { whereClause += ' AND toUnixTimestamp(window_start) <= {toTs:UInt32}';   queryParams.toTs   = cfg.toTs;   }

    // Проверяем: сетапы без scriptCode не могут работать (колонки динамические)
    for (const [name, def] of Object.entries(setupCols)) {
        if (!def.scriptCode) {
            throw new Error(
                `Setup "${name}": нет scriptCode. ` +
                `Выберите JS-скрипт в Code Panel и нажмите Execute — ` +
                `scriptId будет автоматически привязан к сетапу.`
            );
        }
    }

    const query = `
        SELECT
            window_start                                          AS timestamp,
            toFloat64(open)                                       AS open,
            toFloat64(high)                                       AS high,
            toFloat64(low)                                        AS low,
            toFloat64(close)                                      AS close,
            toFloat64OrZero(toString(coalesce(volume, 0)))        AS volume,
            toFloat64OrZero(toString(coalesce(0, 0)))             AS atr
        FROM ${table}
        ${whereClause}
        ORDER BY window_start ASC
    `;

    console.log(`[BT v4] Loading: ${ticker} @ ${table}`);
    if (onProgress) onProgress({ phase: 'loading', rowCount: 0, tradesFound: 0 });

    console.log("query", query)
    const resultSet = await clickhouse.query({
        query,
        format: 'JSONEachRow',
        query_params: queryParams,
        clickhouse_settings: { max_execution_time: 3600 },
    });

    const bars = [];
    const stream = resultSet.stream();
    for await (const rows of stream) {
        for (const rawRow of rows) {
            // ClickHouse клиент может вернуть строку в rawRow.text — парсим
            const row = (rawRow && rawRow.text) ? JSON.parse(rawRow.text) : rawRow;

            bars.push({
                timestamp: row.timestamp || row.window_start,
                open:      parseFloat(row.open),
                high:      parseFloat(row.high),
                low:       parseFloat(row.low),
                close:     parseFloat(row.close),
                volume:    parseFloat(row.volume) || 0,
                atr:       parseFloat(row.atr)    || 0,
            });
        }
        if (bars.length % 100000 === 0 && onProgress) {
            onProgress({ phase: 'loading', rowCount: bars.length, tradesFound: 0 });
        }
    }

    console.log(`[BT v4] Loaded ${bars.length} bars`);
    if (bars.length > 0) {
        console.log(`[BT v4] First bar sample:`, JSON.stringify(bars[0]));
    }

    // ── Запускаем каждый скрипт (setups могут иметь разные scriptCode) ───
    // Группируем сетапы по scriptCode — один скрипт может генерировать несколько колонок
    const scriptGroups = new Map(); // scriptCode → [setupName, ...]
    for (const [name, def] of Object.entries(setupCols)) {
        const code = def.scriptCode || '';
        if (!scriptGroups.has(code)) scriptGroups.set(code, []);
        scriptGroups.get(code).push(name);
    }

    const allLogs = [];

    for (const [scriptCode, names] of scriptGroups) {
        if (!scriptCode) {
            console.log(`[BT v4] Setup(s) [${names.join(', ')}]: no scriptCode, skipping signal computation`);
            continue;
        }

        console.log(`[BT v4] Running script for setup(s): ${names.join(', ')}`);
        if (onProgress) onProgress({ phase: 'script', rowCount: bars.length, tradesFound: 0 });

        const result = runScriptOnBars(scriptCode, bars);

        if (result.error) {
            throw new Error(`Script error for setup [${names.join(', ')}]: ${result.error}`);
        }

        // Сохраняем логи
        allLogs.push(...result.logs);

        // Если скрипт зарегистрировал сетапы — дополняем/обновляем setupCols из БД
        // (например 6226 пишет dir, entry, sl, tp в window.app.setups)
        for (const [setupName, scriptSetupDef] of Object.entries(result.setups)) {
            if (setupCols[setupName]) {
                // Дополняем определение из скрипта
                setupCols[setupName] = {
                    ...scriptSetupDef,
                    ...setupCols[setupName], // пользовательские настройки приоритетнее
                    // но entryCol/slCol/tpCol/dirColumn берём из скрипта если не заданы явно
                    entryCol:  setupCols[setupName].entryCol  || scriptSetupDef.entryCol,
                    slCol:     setupCols[setupName].slCol     || scriptSetupDef.slCol,
                    tpCol:     setupCols[setupName].tpCol     || scriptSetupDef.tpCol,
                    dirColumn: setupCols[setupName].dirColumn || scriptSetupDef.dirColumn,
                };
            }
        }
    }

    console.log(`[BT v4] Running backtest on ${bars.length} bars...`);
    if (onProgress) onProgress({ phase: 'backtest', rowCount: bars.length, tradesFound: 0 });

    // ── Запускаем бектест ─────────────────────────────────────────────────
    const trades = runBacktestOnBars(bars, cfg);

    if (trades.length > 0) {
        const lastTrade = trades[trades.length - 1];
        console.log(`[DBG] Last trade capitalAfter: ${lastTrade.capitalAfter}`);
        console.log(`[DBG] Total PnL: ${trades.reduce((s,t) => s+t.pnl, 0).toFixed(2)}`);
    }
    return { trades, barsProcessed: bars.length, logs: allLogs };
}

// ══════════════════════════════════════════════════════════════
// STATS
// ══════════════════════════════════════════════════════════════

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

    const bySetup = {};
    trades.forEach(t => {
        if (!bySetup[t.setupName]) bySetup[t.setupName] = { total:0, wins:0, pnl:0 };
        bySetup[t.setupName].total++;
        if (t.pnl > 0) bySetup[t.setupName].wins++;
        bySetup[t.setupName].pnl += t.pnl;
    });
    const byExit = {};
    trades.forEach(t => { byExit[t.exitReason] = (byExit[t.exitReason]||0)+1; });

    return {
        total: trades.length, wins: wins.length, losses: losses.length,
        winRate:     +(wins.length / trades.length * 100).toFixed(1),
        totalPnl:    +totalPnl.toFixed(2),
        totalPnlPct: +((endCap - startCapital) / startCapital * 100).toFixed(2),
        endCapital:  +endCap.toFixed(2),
        avgWin:  +avgWin.toFixed(2),
        avgLoss: +avgLoss.toFixed(2),
        rr:      +(avgLoss ? Math.abs(avgWin / avgLoss) : 0).toFixed(2),
        maxDD:   +maxDD.toFixed(2),
        expectancy: +((wins.length/trades.length * avgWin) + (losses.length/trades.length * avgLoss)).toFixed(2),
        profitFactor: grossL ? +(grossW / grossL).toFixed(2) : 0,
        bySetup,
        byExit,
    };
}

// ══════════════════════════════════════════════════════════════
// DATE RANGE
// ══════════════════════════════════════════════════════════════

async function getDateRange(clickhouse, ticker, table) {
    const result = await clickhouse.query({
        query: `
            SELECT
                min(window_start) AS min_ts,
                max(window_start) AS max_ts,
                count()           AS total_rows
            FROM ${table}
            WHERE ticker = {ticker:String}
        `,
        format: 'JSONEachRow',
        query_params: { ticker },
    });

    const rows = await result.json();
    if (!rows.length || !rows[0].min_ts) {
        throw new Error(`No data for ticker="${ticker}" in table="${table}"`);
    }

    return {
        min:       rows[0].min_ts,
        max:       rows[0].max_ts,
        totalRows: parseInt(rows[0].total_rows, 10),
    };
}

module.exports = {
    runBacktestOnServer,
    runBacktestOnBars,
    runScriptOnBars,
    calcStats,
    getDateRange,
};