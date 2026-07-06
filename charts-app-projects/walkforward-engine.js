/**
 * walkforward-engine.js  v1.0
 *
 * Walk-Forward Analysis + Monte Carlo Simulation
 * Работает поверх существующего backtest-engine-server.js
 *
 * ══════════════════════════════════════════════════════════════
 * АРХИТЕКТУРА
 * ══════════════════════════════════════════════════════════════
 *
 * Walk-Forward:
 *   1. Делим временной ряд на N окон (in-sample + out-of-sample)
 *   2. На in-sample: оптимизируем параметры (SL/TP/riskPct)
 *   3. На out-of-sample: тестируем найденные параметры
 *   4. Агрегируем результаты OOS окон → реальная оценка стратегии
 *
 * Monte Carlo:
 *   1. Берём трейды из бектеста
 *   2. Случайно перемешиваем их порядок (N симуляций)
 *   3. Пересчитываем equity curve для каждой симуляции
 *   4. Строим доверительные интервалы для MaxDD и итоговой доходности
 *
 * Экспортирует:
 *   runWalkForward(clickhouse, cfg, onProgress) → { windows, aggregated, efficiency }
 *   runMonteCarlo(trades, capital, simulations) → { percentiles, risk, curves }
 *
 * ══════════════════════════════════════════════════════════════
 */

'use strict';

const { runBacktestOnServer, runBacktestOnBars, runScriptOnBars, calcStats } = require('./backtest-engine-server');

// ══════════════════════════════════════════════════════════════
// WALK-FORWARD ENGINE
// ══════════════════════════════════════════════════════════════

/**
 * Параметры оптимизации — решётка значений для grid search
 * Можно расширить, добавив свои параметры
 */
function buildParamGrid(paramRanges) {
    const keys = Object.keys(paramRanges);
    const values = Object.values(paramRanges);
    const combinations = [];

    function recurse(idx, current) {
        if (idx === keys.length) {
            combinations.push({ ...current });
            return;
        }
        for (const v of values[idx]) {
            current[keys[idx]] = v;
            recurse(idx + 1, current);
        }
    }
    recurse(0, {});
    return combinations;
}

/**
 * Запускает бектест на заданном диапазоне баров с конкретными параметрами
 */
async function backtestSlice(bars, cfg, params) {
    const sliceCfg = { ...cfg, ...params };
    const trades = runBacktestOnBars(bars, sliceCfg);
    const stats = calcStats(trades, sliceCfg.capital);
    return { trades, stats, params };
}

/**
 * Находит лучшие параметры на in-sample периоде
 * Метрика оптимизации: Sharpe-like = expectancy / maxDD (если maxDD > 0)
 *
 * @param {Array}  bars      — массив баров in-sample
 * @param {Object} cfg       — базовый конфиг бектеста
 * @param {Object} paramRanges — { slValue: [0.5,1,1.5,2], tpValue: [1,1.5,2,3], riskPct: [0.5,1,2] }
 * @returns {{ bestParams, bestScore, allResults }}
 */
async function optimizeOnInSample(bars, cfg, paramRanges) {
    const grid = buildParamGrid(paramRanges);
    let bestParams = null;
    let bestScore = -Infinity;
    const allResults = [];

    for (const params of grid) {
        const { trades, stats } = await backtestSlice(bars, cfg, params);
        if (!stats || stats.total < 5) continue; // слишком мало сделок — пропуск

        // Метрика: Profit Factor × Win Rate / (MaxDD + 1)
        // Штрафуем за высокий DD и малое количество сделок
        const tradeCountFactor = Math.min(1, stats.total / 20); // бонус за больше сделок
        const score = (stats.profitFactor * (stats.winRate / 100) * tradeCountFactor) / (stats.maxDD / 100 + 0.01);

        allResults.push({ params, stats, score });

        if (score > bestScore) {
            bestScore = score;
            bestParams = params;
        }
    }

    return { bestParams, bestScore, allResults };
}

/**
 * Главная функция Walk-Forward анализа
 *
 * @param {Object} clickhouse   — клиент ClickHouse
 * @param {Object} cfg          — конфиг бектеста (аналогично /api/backtest/run)
 * @param {Object} wfCfg        — параметры walk-forward:
 *   {
 *     windows: 5,            // кол-во окон
 *     inSamplePct: 70,       // % данных для in-sample (остаток = OOS)
 *     anchoredStart: false,  // true = anchored (IS всегда с начала), false = rolling
 *     paramRanges: {         // решётка для оптимизации
 *       slValue: [0.5, 1, 1.5, 2],
 *       tpValue: [1.5, 2, 3],
 *       riskPct: [0.5, 1, 2],
 *     }
 *   }
 * @param {Function} onProgress
 */
async function runWalkForward(clickhouse, cfg, wfCfg, onProgress) {
    const {
        windows = 5,
        inSamplePct = 70,
        anchoredStart = false,
        paramRanges = {
            slValue: [0.5, 1.0, 1.5, 2.0],
            tpValue: [1.5, 2.0, 3.0],
            riskPct: [0.5, 1.0, 2.0],
        },
    } = wfCfg;

    // ── Загрузка всех баров один раз ─────────────────────────────────
    onProgress?.({ phase: 'loading', pct: 0, message: 'Loading data from ClickHouse...' });

    // Загружаем бары через существующий механизм
    const { ticker, table, setupCols } = cfg;
    let whereClause = 'WHERE ticker = {ticker:String}';
    const queryParams = { ticker };
    if (cfg.fromTs) { whereClause += ' AND toUnixTimestamp(window_start) >= {fromTs:UInt32}'; queryParams.fromTs = cfg.fromTs; }
    if (cfg.toTs)   { whereClause += ' AND toUnixTimestamp(window_start) <= {toTs:UInt32}';   queryParams.toTs   = cfg.toTs;   }

    const query = `
        SELECT
            window_start AS timestamp,
            toFloat64(open)  AS open,
            toFloat64(high)  AS high,
            toFloat64(low)   AS low,
            toFloat64(close) AS close,
            toFloat64OrZero(toString(coalesce(volume, 0))) AS volume,
            0 AS atr
        FROM ${table}
        ${whereClause}
        ORDER BY window_start ASC
    `;

    const resultSet = await clickhouse.query({
        query,
        format: 'JSONEachRow',
        query_params: queryParams,
        clickhouse_settings: { max_execution_time: 3600 },
    });

    const allBars = [];
    const stream = resultSet.stream();
    for await (const rows of stream) {
        for (const rawRow of rows) {
            const row = (rawRow && rawRow.text) ? JSON.parse(rawRow.text) : rawRow;
            allBars.push({
                timestamp: row.timestamp || row.window_start,
                open:  parseFloat(row.open),
                high:  parseFloat(row.high),
                low:   parseFloat(row.low),
                close: parseFloat(row.close),
                volume: parseFloat(row.volume) || 0,
                atr:   0,
            });
        }
    }

    onProgress?.({ phase: 'script', pct: 10, message: `Loaded ${allBars.length} bars. Running scripts...` });

    // ── Запускаем JS-скрипты сетапов на всех барах один раз ──────────
    const scriptGroups = new Map();
    for (const [name, def] of Object.entries(setupCols)) {
        const code = def.scriptCode || '';
        if (!scriptGroups.has(code)) scriptGroups.set(code, []);
        scriptGroups.get(code).push(name);
    }

    for (const [scriptCode, names] of scriptGroups) {
        if (!scriptCode) continue;
        const result = runScriptOnBars(scriptCode, allBars);
        if (result.error) throw new Error(`Script error [${names.join(',')}]: ${result.error}`);

        // Дополняем setupCols из скрипта
        for (const [setupName, scriptSetupDef] of Object.entries(result.setups)) {
            if (setupCols[setupName]) {
                setupCols[setupName] = {
                    ...scriptSetupDef,
                    ...setupCols[setupName],
                    entryCol:  setupCols[setupName].entryCol  || scriptSetupDef.entryCol,
                    slCol:     setupCols[setupName].slCol     || scriptSetupDef.slCol,
                    tpCol:     setupCols[setupName].tpCol     || scriptSetupDef.tpCol,
                    dirColumn: setupCols[setupName].dirColumn || scriptSetupDef.dirColumn,
                };
            }
        }
    }

    // ── Разбивка на окна ─────────────────────────────────────────────
    const totalBars = allBars.length;
    const windowSize = Math.floor(totalBars / windows);
    const oosBarsCount = Math.floor(windowSize * (100 - inSamplePct) / 100);
    const isBarsCount  = windowSize - oosBarsCount;

    const wfWindows = [];
    const allOosTrades = [];

    for (let w = 0; w < windows; w++) {
        const pct = 15 + Math.round((w / windows) * 75);
        onProgress?.({
            phase: 'walkforward',
            pct,
            message: `Window ${w + 1}/${windows}: optimizing...`,
            window: w + 1,
            totalWindows: windows,
        });

        let isStart, isEnd, oosStart, oosEnd;

        if (anchoredStart) {
            // Anchored: IS всегда начинается с 0
            oosEnd   = Math.min((w + 1) * windowSize, totalBars);
            oosStart = oosEnd - oosBarsCount;
            isStart  = 0;
            isEnd    = oosStart;
        } else {
            // Rolling: окно сдвигается
            const winStart = w * oosBarsCount; // шаг = oosBarsCount
            isStart  = winStart;
            isEnd    = winStart + isBarsCount;
            oosStart = isEnd;
            oosEnd   = Math.min(oosStart + oosBarsCount, totalBars);
        }

        if (isEnd > totalBars || oosStart >= totalBars) break;

        const isBars  = allBars.slice(isStart, isEnd);
        const oosBars = allBars.slice(oosStart, oosEnd);

        if (isBars.length < 50 || oosBars.length < 10) continue;

        // Оптимизируем на IS
        const { bestParams, bestScore, allResults } = await optimizeOnInSample(
            isBars, { ...cfg, setupCols }, paramRanges
        );

        if (!bestParams) {
            wfWindows.push({
                window: w + 1,
                isRange: [allBars[isStart]?.timestamp, allBars[isEnd - 1]?.timestamp],
                oosRange: [allBars[oosStart]?.timestamp, allBars[Math.min(oosEnd, totalBars) - 1]?.timestamp],
                isBars: isBars.length,
                oosBars: oosBars.length,
                bestParams: null,
                isStats: null,
                oosStats: null,
                optimizationScore: null,
                efficiency: null,
            });
            continue;
        }

        // IS результаты с лучшими параметрами
        const { trades: isTrades, stats: isStats } = await backtestSlice(
            isBars, { ...cfg, setupCols }, bestParams
        );

        // OOS результаты с лучшими параметрами
        const { trades: oosTrades, stats: oosStats } = await backtestSlice(
            oosBars, { ...cfg, setupCols }, bestParams
        );

        // Помечаем трейды номером окна
        oosTrades.forEach(t => { t.wfWindow = w + 1; });
        allOosTrades.push(...oosTrades);

        // Efficiency = OOS_return / IS_return (идеал ~ 50-80%)
        const isReturn  = isStats?.totalPnlPct  || 0;
        const oosReturn = oosStats?.totalPnlPct || 0;
        const efficiency = isReturn > 0 ? Math.min(oosReturn / isReturn * 100, 200) : null;

        wfWindows.push({
            window: w + 1,
            isRange:  [allBars[isStart]?.timestamp, allBars[isEnd - 1]?.timestamp],
            oosRange: [allBars[oosStart]?.timestamp, allBars[Math.min(oosEnd, totalBars) - 1]?.timestamp],
            isBars:  isBars.length,
            oosBars: oosBars.length,
            bestParams,
            optimizationScore: +bestScore.toFixed(4),
            isStats,
            oosStats,
            efficiency: efficiency !== null ? +efficiency.toFixed(1) : null,
            topParams: allResults
                .sort((a, b) => b.score - a.score)
                .slice(0, 5)
                .map(r => ({ ...r.params, score: +r.score.toFixed(4), trades: r.stats?.total })),
        });
    }

    // ── Агрегированная OOS статистика ────────────────────────────────
    onProgress?.({ phase: 'aggregating', pct: 92, message: 'Aggregating OOS results...' });

    const aggregatedStats = calcStats(allOosTrades, cfg.capital);

    // Walk-Forward Efficiency Index (WFE)
    const validWindows = wfWindows.filter(w => w.efficiency !== null);
    const avgEfficiency = validWindows.length
        ? validWindows.reduce((s, w) => s + w.efficiency, 0) / validWindows.length
        : null;

    // Стабильность: % окон с положительным OOS
    const positiveOosWindows = validWindows.filter(w => (w.oosStats?.totalPnl || 0) > 0).length;
    const stabilityPct = validWindows.length
        ? +(positiveOosWindows / validWindows.length * 100).toFixed(1)
        : null;

    onProgress?.({ phase: 'done', pct: 100, message: 'Walk-Forward complete.' });

    return {
        windows: wfWindows,
        allOosTrades,
        aggregatedStats,
        summary: {
            totalWindows: wfWindows.length,
            validWindows: validWindows.length,
            avgEfficiency,
            stabilityPct,
            totalOosTrades: allOosTrades.length,
            paramRanges,
        },
    };
}

// ══════════════════════════════════════════════════════════════
// MONTE CARLO ENGINE
// ══════════════════════════════════════════════════════════════

/**
 * Fisher-Yates shuffle (in-place)
 */
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

/**
 * Пересчитывает equity curve по массиву PnL
 */
function buildEquityCurve(pnlArray, startCapital) {
    let cap = startCapital;
    let peak = cap;
    let maxDD = 0;
    const curve = [cap];

    for (const pnl of pnlArray) {
        cap += pnl;
        curve.push(cap);
        if (cap > peak) peak = cap;
        const dd = (peak - cap) / peak * 100;
        if (dd > maxDD) maxDD = dd;
    }

    return {
        curve,
        finalCapital: cap,
        totalReturn: (cap - startCapital) / startCapital * 100,
        maxDD,
    };
}

/**
 * Вычисляет перцентиль массива
 */
function percentile(sorted, p) {
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}

/**
 * Запускает Monte Carlo симуляцию
 *
 * @param {Array}  trades      — трейды из бектеста
 * @param {number} capital     — начальный капитал
 * @param {number} simulations — кол-во симуляций (рекомендуется 1000-5000)
 * @param {Function} onProgress
 * @returns {{
 *   percentiles: { p5, p25, p50, p75, p95 } для return и maxDD,
 *   risk: { ruinProb, targetProb, medianReturn, medianMaxDD },
 *   curves: Array — 20 случайных кривых для визуализации,
 *   histogram: { returns: Array, maxDDs: Array }
 * }}
 */
function runMonteCarlo(trades, capital, simulations = 1000, onProgress) {
    if (!trades || trades.length < 2) {
        return { error: 'Need at least 2 trades for Monte Carlo' };
    }

    const pnlArray = trades.map(t => t.pnl);
    const returns = [];
    const maxDDs  = [];
    const sampleCurves = [];
    const SAMPLE_CURVES_COUNT = 50; // кривых для графика

    for (let i = 0; i < simulations; i++) {
        const shuffled = shuffle([...pnlArray]);
        const { curve, totalReturn, maxDD } = buildEquityCurve(shuffled, capital);

        returns.push(totalReturn);
        maxDDs.push(maxDD);

        if (i < SAMPLE_CURVES_COUNT) {
            sampleCurves.push(curve);
        }

        if (i % 200 === 0) {
            onProgress?.({
                phase: 'montecarlo',
                pct: Math.round(i / simulations * 100),
                message: `Monte Carlo: ${i}/${simulations} simulations...`,
            });
        }
    }

    // Сортируем для перцентилей
    const sortedReturns = [...returns].sort((a, b) => a - b);
    const sortedMaxDDs  = [...maxDDs].sort((a, b) => a - b);

    // Гистограммы
    const buildHistogram = (sorted, bins = 40) => {
        const min = sorted[0];
        const max = sorted[sorted.length - 1];
        const step = (max - min) / bins || 1;
        const hist = Array(bins).fill(0).map((_, i) => ({
            x: +(min + i * step).toFixed(2),
            count: 0,
        }));
        for (const v of sorted) {
            const idx = Math.min(Math.floor((v - min) / step), bins - 1);
            hist[idx].count++;
        }
        return hist;
    };

    // Нормализуем кривые до одинаковой длины (для оверлея)
    const targetLength = Math.max(...sampleCurves.map(c => c.length));
    const normalizedCurves = sampleCurves.map(curve => {
        // Интерполируем до targetLength
        if (curve.length === targetLength) return curve;
        const result = [];
        for (let i = 0; i < targetLength; i++) {
            const idx = (i / (targetLength - 1)) * (curve.length - 1);
            const lo = Math.floor(idx);
            const hi = Math.ceil(idx);
            result.push(curve[lo] + (idx - lo) * ((curve[hi] || curve[lo]) - curve[lo]));
        }
        return result;
    });

    // Перцентильные ленты для графика (p5/p25/p50/p75/p95 на каждой точке)
    const bandLength = Math.min(targetLength, 200); // ограничиваем для передачи на клиент
    const step = targetLength / bandLength;
    const bands = { p5: [], p25: [], p50: [], p75: [], p95: [] };

    for (let i = 0; i < bandLength; i++) {
        const ptIdx = Math.floor(i * step);
        const colValues = normalizedCurves.map(c => c[ptIdx] ?? c[c.length - 1]).sort((a, b) => a - b);
        bands.p5.push( +percentile(colValues, 5).toFixed(2));
        bands.p25.push(+percentile(colValues, 25).toFixed(2));
        bands.p50.push(+percentile(colValues, 50).toFixed(2));
        bands.p75.push(+percentile(colValues, 75).toFixed(2));
        bands.p95.push(+percentile(colValues, 95).toFixed(2));
    }

    // Вероятность руина (капитал < 50% от начального)
    const ruinThreshold = capital * 0.5;
    const ruinProb = returns.filter(r => capital * (1 + r / 100) < ruinThreshold).length / simulations * 100;

    // Вероятность достичь цели (> +50%)
    const targetReturn = 50;
    const targetProb = returns.filter(r => r >= targetReturn).length / simulations * 100;

    return {
        simulations,
        trades: trades.length,
        percentiles: {
            return: {
                p5:  +percentile(sortedReturns, 5).toFixed(2),
                p25: +percentile(sortedReturns, 25).toFixed(2),
                p50: +percentile(sortedReturns, 50).toFixed(2),
                p75: +percentile(sortedReturns, 75).toFixed(2),
                p95: +percentile(sortedReturns, 95).toFixed(2),
            },
            maxDD: {
                p5:  +percentile(sortedMaxDDs, 5).toFixed(2),
                p25: +percentile(sortedMaxDDs, 25).toFixed(2),
                p50: +percentile(sortedMaxDDs, 50).toFixed(2),
                p75: +percentile(sortedMaxDDs, 75).toFixed(2),
                p95: +percentile(sortedMaxDDs, 95).toFixed(2),
            },
        },
        risk: {
            ruinProb:    +ruinProb.toFixed(2),
            targetProb:  +targetProb.toFixed(2),
            medianReturn: +percentile(sortedReturns, 50).toFixed(2),
            medianMaxDD:  +percentile(sortedMaxDDs, 50).toFixed(2),
        },
        bands,   // для графика перцентильных лент
        histogram: {
            returns: buildHistogram(sortedReturns),
            maxDDs:  buildHistogram(sortedMaxDDs),
        },
    };
}

module.exports = {
    runWalkForward,
    runMonteCarlo,
    optimizeOnInSample,
    buildParamGrid,
};