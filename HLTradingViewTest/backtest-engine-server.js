/**
 * backtest-engine-server.js
 *
 * Серверная реализация движка бектеста.
 * Полностью повторяет логику setups-backtest.js (runBacktest),
 * но работает на сервере — данные стримятся из ClickHouse,
 * не загружаются в браузер. Поддерживает сотни миллионов строк.
 *
 * Экспортирует:
 *   runBacktestOnServer(clickhouse, cfg)  → { trades, stats }
 *   getDateRange(clickhouse, ticker, table) → { min, max }
 */

'use strict';

// ══════════════════════════════════════════════════════════════
// HELPERS — повтор логики из setups-backtest.js
// ══════════════════════════════════════════════════════════════

function calcSL(close, atr, cfg, dir) {
    const e = close;
    const a = atr || e * 0.01;
    const d = cfg.slMode === 'atr' ? a * cfg.slValue : e * cfg.slValue / 100;
    return dir === 'long' ? e - d : e + d;
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
    return riskPerU > 0 ? (riskAmt / riskPerU) * cfg.leverage : 0;
}

/**
 * Проверяет выход по колонке (status >= 3).
 * setupCols: { [setupName]: { column, dir, exitRules: [{status, label}] } }
 */
function checkColExit(row, trade, setupCols, cfg) {
    if (!cfg.useColExit) return null;
    const col = trade.col;
    const v   = parseInt(row[col], 10);
    if (isNaN(v) || v < 3) return null;
    const def   = setupCols[trade.setupName] || {};
    const rules = def.exitRules || [];
    const rule  = rules.find(r => r.status === v);
    return { price: parseFloat(row.close), reason: rule?.label || `Status ${v}` };
}

// ══════════════════════════════════════════════════════════════
// MAIN ENGINE
// ══════════════════════════════════════════════════════════════

/**
 * cfg = {
 *   ticker:     'C:EUR-USD',
 *   table:      'market_data_minute',
 *   fromTs:     unix seconds (optional),
 *   toTs:       unix seconds (optional),
 *   capital:    10000,
 *   riskPct:    1,
 *   leverage:   1,
 *   slMode:     'pct' | 'atr',
 *   slValue:    1,
 *   tpMode:     'rr'  | 'pct',
 *   tpValue:    2,
 *   maxBars:    50,
 *   direction:  'long' | 'short' | 'both',
 *   useColExit: true,
 *   setupCols:  {          // аналог getActiveCols() на клиенте
 *     "Setup Name": {
 *       column: "col_name",
 *       dir: "long",
 *       exitRules: [{ status: 3, label: "TP hit" }]
 *     }
 *   }
 * }
 */
async function runBacktestOnServer(clickhouse, cfg, onProgress) {
    const { ticker, table, fromTs, toTs, setupCols } = cfg;

    if (!Object.keys(setupCols).length) {
        throw new Error('No setup columns defined');
    }

    // ── Список колонок которые нужно достать из ClickHouse ────────────────
    const setupColNames = [...new Set(
        Object.values(setupCols).map(def => def.column)
    )];

    // ATR нужен если slMode = 'atr'
    const needAtr = cfg.slMode === 'atr';

    // ── Строим SELECT динамически ─────────────────────────────────────────
    const extraCols = setupColNames.map(c => `, ${c}`).join('');
    const atrCol = needAtr ? ', atr' : '';

    let whereClause = `WHERE ticker = {ticker:String}`;
    const queryParams = { ticker };

    if (fromTs) {
        whereClause += ` AND toUnixTimestamp(window_start) >= {fromTs:UInt32}`;
        queryParams.fromTs = parseInt(fromTs);
    }
    if (toTs) {
        whereClause += ` AND toUnixTimestamp(window_start) <= {toTs:UInt32}`;
        queryParams.toTs = parseInt(toTs);
    }

    const query = `
        SELECT
            window_start                          AS timestamp,
            toFloat64(open)                       AS open,
            toFloat64(high)                       AS high,
            toFloat64(low)                        AS low,
            toFloat64(close)                      AS close
            ${needAtr ? ', toFloat64OrZero(toString(atr)) AS atr' : ''}
            ${setupColNames.map(c => `, toInt32OrZero(toString(${c})) AS ${c}`).join('')}
        FROM ${table}
        ${whereClause}
        ORDER BY window_start ASC
    `;

    console.log(`[Backtest Engine] Starting. Ticker=${ticker} Table=${table}`);
    console.log(`[Backtest Engine] Setup cols: ${setupColNames.join(', ')}`);

    // ── Стримим строки из ClickHouse ──────────────────────────────────────
    const resultSet = await clickhouse.query({
        query,
        format: 'JSONEachRow',
        query_params: queryParams,
        // Для больших датасетов увеличиваем таймаут
        clickhouse_settings: {
            max_execution_time: 3600,
            result_overflow_mode: 'throw',
        }
    });

    const stream = resultSet.stream();

    // ── Состояние движка ──────────────────────────────────────────────────
    const trades  = [];
    let capital   = cfg.capital;
    let inTrade   = null;
    let barIdx    = 0;
    let rowCount  = 0;

    // ── Читаем построчно ──────────────────────────────────────────────────
    for await (const rows of stream) {
        for (const row of rows) {
            const close  = parseFloat(row.close);
            const high   = parseFloat(row.high);
            const low    = parseFloat(row.low);
            const atr    = needAtr ? parseFloat(row.atr) : 0;
            const ts     = new Date(row.timestamp).getTime();

            // 1. Обрабатываем открытую позицию
            if (inTrade) {
                let exitPrice  = null;
                let exitReason = null;

                // 1a. Column exit (status >= 3)
                const colExit = checkColExit(row, inTrade, setupCols, cfg);
                if (colExit) {
                    exitPrice  = colExit.price;
                    exitReason = colExit.reason;
                }

                // 1b. Fixed SL / TP
                if (!exitPrice) {
                    if (inTrade.dir === 'long') {
                        if (low  <= inTrade.sl) { exitPrice = inTrade.sl; exitReason = 'SL'; }
                        else if (high >= inTrade.tp) { exitPrice = inTrade.tp; exitReason = 'TP'; }
                    } else {
                        if (high >= inTrade.sl) { exitPrice = inTrade.sl; exitReason = 'SL'; }
                        else if (low  <= inTrade.tp) { exitPrice = inTrade.tp; exitReason = 'TP'; }
                    }
                }

                // 1c. Timeout
                const barsIn = barIdx - inTrade.entryBarIdx;
                if (!exitPrice && barsIn >= cfg.maxBars) {
                    exitPrice  = close;
                    exitReason = 'TIMEOUT';
                }

                if (exitPrice) {
                    const pnl = inTrade.dir === 'long'
                        ? (exitPrice - inTrade.entry) * inTrade.qty
                        : (inTrade.entry - exitPrice) * inTrade.qty;
                    capital += pnl;

                    trades.push({
                        setupName:     inTrade.setupName,
                        col:           inTrade.col,
                        dir:           inTrade.dir,
                        entry:         +inTrade.entry.toFixed(8),
                        exitPrice:     +exitPrice.toFixed(8),
                        sl:            +inTrade.sl.toFixed(8),
                        tp:            +inTrade.tp.toFixed(8),
                        qty:           +inTrade.qty.toFixed(6),
                        leverage:      inTrade.leverage,
                        riskAmt:       +inTrade.riskAmt.toFixed(4),
                        entryTs:       inTrade.entryTs,
                        exitTs:        ts,
                        barsHeld:      barsIn,
                        exitReason,
                        capitalBefore: +inTrade.capitalBefore.toFixed(4),
                        capitalAfter:  +capital.toFixed(4),
                        pnl:           +pnl.toFixed(4),
                        pnlPct:        +((pnl / inTrade.capitalBefore) * 100).toFixed(4),
                    });
                    inTrade = null;
                }
            }

            // 2. Ищем новый вход (только если нет открытой позиции)
            if (!inTrade) {
                for (const [name, def] of Object.entries(setupCols)) {
                    const col = def.column;
                    const v   = parseInt(row[col], 10);
                    if (isNaN(v) || v !== 1) continue;

                    const dir = def.dir || (cfg.direction !== 'both' ? cfg.direction : 'long');
                    if (cfg.direction !== 'both' && dir !== cfg.direction) continue;

                    const sl  = calcSL(close, atr, cfg, dir);
                    const tp  = calcTP(close, sl, cfg, dir);
                    const qty = calcQty(capital, close, sl, cfg);
                    if (qty <= 0) continue;

                    inTrade = {
                        setupName:     name,
                        col,
                        dir,
                        entry:         close,
                        sl,
                        tp,
                        qty,
                        leverage:      cfg.leverage,
                        riskAmt:       +(capital * cfg.riskPct / 100),
                        entryTs:       ts,
                        entryBarIdx:   barIdx,
                        capitalBefore: capital,
                    };
                    break;
                }
            }

            barIdx++;
            rowCount++;

            // Прогресс каждые 100k строк
            if (onProgress && rowCount % 100000 === 0) {
                onProgress({ rowCount, tradesFound: trades.length });
            }
        }
    }

    console.log(`[Backtest Engine] Done. Rows=${rowCount} Trades=${trades.length}`);

    return { trades, barsProcessed: rowCount };
}

// ══════════════════════════════════════════════════════════════
// STATS (аналог calcStats)
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

    const avgWin  = wins.length   ? wins.reduce((s, t) => s + t.pnl, 0)   / wins.length   : 0;
    const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
    const grossW  = wins.reduce((s, t) => s + t.pnl, 0);
    const grossL  = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

    const bySetup = {};
    trades.forEach(t => {
        if (!bySetup[t.setupName]) bySetup[t.setupName] = { total: 0, wins: 0, pnl: 0 };
        bySetup[t.setupName].total++;
        if (t.pnl > 0) bySetup[t.setupName].wins++;
        bySetup[t.setupName].pnl += t.pnl;
    });

    const byExit = {};
    trades.forEach(t => { byExit[t.exitReason] = (byExit[t.exitReason] || 0) + 1; });

    return {
        total:       trades.length,
        wins:        wins.length,
        losses:      losses.length,
        winRate:     +(wins.length / trades.length * 100).toFixed(2),
        totalPnl:    +totalPnl.toFixed(4),
        totalPnlPct: +((endCap - startCapital) / startCapital * 100).toFixed(4),
        endCapital:  +endCap.toFixed(4),
        startCapital: +startCapital.toFixed(4),
        avgWin:      +avgWin.toFixed(4),
        avgLoss:     +avgLoss.toFixed(4),
        rr:          +Math.abs(avgLoss ? avgWin / avgLoss : 0).toFixed(4),
        maxDD:       +maxDD.toFixed(4),
        expectancy:  +((wins.length / trades.length * avgWin) + (losses.length / trades.length * avgLoss)).toFixed(4),
        profitFactor: grossL ? +(grossW / grossL).toFixed(4) : 0,
        bySetup,
        byExit,
    };
}

// ══════════════════════════════════════════════════════════════
// DATE RANGE QUERY
// ══════════════════════════════════════════════════════════════

async function getDateRange(clickhouse, ticker, table) {
    const allowedTables = ['market_data_minute', 'market_data_hour', 'market_data_day', 'market_data_week'];
    if (!allowedTables.includes(table)) {
        throw new Error(`Table ${table} not allowed`);
    }

    const query = `
        SELECT
            MIN(window_start) AS min_date,
            MAX(window_start) AS max_date,
            count()           AS total_rows
        FROM ${table}
        WHERE ticker = {ticker:String}
    `;

    const resultSet = await clickhouse.query({
        query,
        format: 'JSONEachRow',
        query_params: { ticker }
    });

    const data = await resultSet.json();
    if (!data.length || !data[0].min_date) {
        throw new Error(`No data found for ticker ${ticker} in ${table}`);
    }

    return {
        min: data[0].min_date,  // ISO string или DateTime
        max: data[0].max_date,
        totalRows: parseInt(data[0].total_rows, 10),
    };
}

module.exports = { runBacktestOnServer, calcStats, getDateRange };