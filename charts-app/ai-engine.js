/**
 * ai-engine.js  v1.0
 *
 * AI/ML слой поверх бэктест-движка.
 *
 * Модули:
 *   1. Bayesian Optimization (Gaussian Process + Expected Improvement)
 *      — находит оптимальные SL/TP/Risk за 30-50 итераций вместо 100+ grid search
 *   2. Market Regime Classifier
 *      — определяет режим рынка: trending_up / trending_down / ranging / volatile
 *   3. Setup-by-Regime Analyzer
 *      — какой сетап работает лучше в каком режиме рынка
 *
 * Архитектура (без внешних ML-библиотек — чистый Node.js):
 *
 *   GP Surrogate:
 *     — RBF kernel: k(x1,x2) = exp(-||x1-x2||² / 2ls²)
 *     — Линейная система Kα = y решается Гаусс-Жорданом
 *     — Предсказывает μ(x*) и σ(x*) для любой точки
 *
 *   EI Acquisition:
 *     — EI(x) = (μ-y_best-ξ)Φ(Z) + σφ(Z)
 *     — Максимизируется случайным поиском + локальным спуском
 *
 *   Market Regime:
 *     — Features: ADX (через R²), ATR%, BB Width, slope линрег
 *     — Rule-based порог-классификатор (детерминированный)
 *
 * Экспорт:
 *   bayesianOptimize(bars, cfg, paramSpace, options) → result
 *   classifyMarketRegimes(bars, options) → result
 *   analyzeSetupByRegime(trades, regimeData) → result
 *   loadBarsFromClickhouse(clickhouse, cfg) → bars[]
 */

'use strict';

const { runBacktestOnBars, calcStats } = require('./backtest-engine-server');

// ════════════════════════════════════════════════════════════════
// MATH UTILITIES
// ════════════════════════════════════════════════════════════════

function clamp(v, lo, hi)           { return Math.max(lo, Math.min(hi, v)); }
function normalize(v, lo, hi)       { return hi === lo ? 0.5 : clamp((v - lo) / (hi - lo), 0, 1); }
function denormalize(v, lo, hi)     { return lo + v * (hi - lo); }
function mean(arr)                  { return arr.reduce((s, v) => s + v, 0) / arr.length; }
function std(arr)  {
    const m = mean(arr);
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function linReg(xs, ys) {
    const n = xs.length;
    if (n < 2) return { slope: 0, intercept: 0, r2: 0 };
    const mx = mean(xs), my = mean(ys);
    let ssxy = 0, ssxx = 0, ssyy = 0;
    for (let i = 0; i < n; i++) {
        ssxy += (xs[i] - mx) * (ys[i] - my);
        ssxx += (xs[i] - mx) ** 2;
        ssyy += (ys[i] - my) ** 2;
    }
    const slope     = ssxx ? ssxy / ssxx : 0;
    const intercept = my - slope * mx;
    const r2        = ssxx && ssyy ? (ssxy ** 2) / (ssxx * ssyy) : 0;
    return { slope, intercept, r2 };
}

// Polynomial approximation of erf (max error < 1.5e-7)
function erf(x) {
    const s = x >= 0 ? 1 : -1;
    x = Math.abs(x);
    const p = 0.3275911;
    const t = 1 / (1 + p * x);
    const y = 1 - (((((1.061405429*t - 1.453152027)*t) + 1.421413741)*t - 0.284496736)*t + 0.254829592)*t*Math.exp(-x*x);
    return s * y;
}

// ════════════════════════════════════════════════════════════════
// GAUSSIAN PROCESS (RBF kernel, Gauss-Jordan solver)
// ════════════════════════════════════════════════════════════════

function rbfKernel(x1, x2, ls) {
    const d2 = x1.reduce((s, v, i) => s + (v - x2[i]) ** 2, 0);
    return Math.exp(-d2 / (2 * ls * ls));
}

function buildK(pts, ls, noise = 1e-4) {
    return pts.map((xi, i) =>
        pts.map((xj, j) => rbfKernel(xi, xj, ls) + (i === j ? noise : 0))
    );
}

// Gauss-Jordan elimination for Ax = b
function solve(A, b) {
    const n = A.length;
    const M = A.map(r => [...r]);
    const x = [...b];
    for (let col = 0; col < n; col++) {
        let maxRow = col;
        for (let row = col + 1; row < n; row++)
            if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
        [M[col], M[maxRow]] = [M[maxRow], M[col]];
        [x[col], x[maxRow]] = [x[maxRow], x[col]];
        const piv = M[col][col];
        if (Math.abs(piv) < 1e-12) continue;
        for (let row = 0; row < n; row++) {
            if (row === col) continue;
            const f = M[row][col] / piv;
            for (let k = col; k < n; k++) M[row][k] -= f * M[col][k];
            x[row] -= f * x[col];
        }
        for (let k = col; k < n; k++) M[col][k] /= piv;
        x[col] /= piv;
    }
    return x;
}

// GP posterior mean and variance at x*
function gpPredict(X, y, xStar, ls) {
    if (!X.length) return { mu: 0, sigma: 1 };
    const K     = buildK(X, ls);
    const alpha = solve(K, y);
    const kStar = X.map(xi => rbfKernel(xStar, xi, ls));
    const mu    = kStar.reduce((s, k, i) => s + k * alpha[i], 0);
    const v     = solve(K, kStar);
    const var_  = Math.max(0, rbfKernel(xStar, xStar, ls) - kStar.reduce((s,k,i)=>s+k*v[i],0));
    return { mu, sigma: Math.sqrt(var_) };
}

// Expected Improvement acquisition function
function EI(mu, sigma, yBest, xi = 0.01) {
    if (sigma < 1e-10) return 0;
    const Z   = (mu - yBest - xi) / sigma;
    const phi = Math.exp(-0.5 * Z * Z) / Math.sqrt(2 * Math.PI);
    const Phi = 0.5 * (1 + erf(Z / Math.SQRT2));
    return (mu - yBest - xi) * Phi + sigma * phi;
}

// ════════════════════════════════════════════════════════════════
// BAYESIAN OPTIMIZATION
// ════════════════════════════════════════════════════════════════

function randPt(dim)  { return Array.from({ length: dim }, () => Math.random()); }

function denormPt(pt, paramSpace) {
    const params = {};
    Object.keys(paramSpace).forEach((key, i) => {
        const { min, max, type } = paramSpace[key];
        let v = denormalize(pt[i], min, max);
        v = type === 'int' ? Math.round(v) : Math.round(v * 100) / 100;
        params[key] = v;
    });
    return params;
}

// Maximise EI via random search + local hill-climb
function nextPoint(obsX, obsY, dim, ls, nRand = 256) {
    if (!obsX.length) return randPt(dim);
    const yBest  = Math.max(...obsY);
    let bestEI   = -Infinity, bestX = null;

    for (let i = 0; i < nRand; i++) {
        const x  = randPt(dim);
        const { mu, sigma } = gpPredict(obsX, obsY, x, ls);
        const ei = EI(mu, sigma, yBest);
        if (ei > bestEI) { bestEI = ei; bestX = [...x]; }
    }

    // Local refinement
    const step = 0.025;
    for (let iter = 0; iter < 40; iter++) {
        let improved = false;
        for (let d = 0; d < dim; d++) {
            for (const delta of [step, -step]) {
                const xNew = [...bestX];
                xNew[d] = clamp(xNew[d] + delta, 0, 1);
                const { mu, sigma } = gpPredict(obsX, obsY, xNew, ls);
                const ei = EI(mu, sigma, yBest);
                if (ei > bestEI) { bestEI = ei; bestX = xNew; improved = true; }
            }
        }
        if (!improved) break;
    }
    return bestX || randPt(dim);
}

// Objective function: composite score
function evalParams(bars, cfg, params) {
    const trades = runBacktestOnBars(bars, { ...cfg, ...params });
    const stats  = calcStats(trades, cfg.capital);
    if (!stats || stats.total < 3) return -1;
    const tf    = Math.min(1, stats.total / 30) ** 0.3;
    const score = (stats.profitFactor * (stats.winRate / 100) * tf) / (stats.maxDD / 100 + 0.05);
    return Math.min(score, 100);
}

/**
 * Bayesian Optimization
 *
 * @param {Array}  bars        — исторические бары
 * @param {Object} cfg         — базовый конфиг бэктеста
 * @param {Object} paramSpace  — { slValue:{min,max,type}, tpValue:{...}, ... }
 * @param {Object} options     — { initPoints, maxIter, ls, onProgress }
 * @returns {{ bestParams, bestScore, bestStats, history, totalEvals }}
 */
async function bayesianOptimize(bars, cfg, paramSpace, options = {}) {
    const { initPoints = 8, maxIter = 40, ls = 0.4, onProgress = null } = options;
    const keys = Object.keys(paramSpace);
    const dim  = keys.length;

    const obsX    = [], obsY = [], history = [];

    // Phase 1: random init
    for (let i = 0; i < initPoints; i++) {
        const pt     = randPt(dim);
        const params = denormPt(pt, paramSpace);
        const score  = evalParams(bars, cfg, params);
        obsX.push(pt); obsY.push(score);
        history.push({ iteration: i, type: 'random', params, score: +score.toFixed(4) });
        onProgress?.({ iter: i + 1, total: initPoints + maxIter, phase: 'init', score });
    }

    // Phase 2: Bayesian iterations
    for (let iter = 0; iter < maxIter; iter++) {
        const pt     = nextPoint(obsX, obsY, dim, ls);
        const params = denormPt(pt, paramSpace);
        const score  = evalParams(bars, cfg, params);
        obsX.push(pt); obsY.push(score);
        history.push({ iteration: initPoints + iter, type: 'bayesian', params, score: +score.toFixed(4) });
        onProgress?.({ iter: initPoints + iter + 1, total: initPoints + maxIter, phase: 'bayesian', score });
    }

    const bestIdx    = obsY.indexOf(Math.max(...obsY));
    const bestParams = history[bestIdx].params;
    const bestScore  = obsY[bestIdx];
    const bestTrades = runBacktestOnBars(bars, { ...cfg, ...bestParams });
    const bestStats  = calcStats(bestTrades, cfg.capital);

    // Сравнение с baseline (средним по random init)
    const baselineScore = mean(obsY.slice(0, initPoints).filter(s => s > 0));
    const improvement   = baselineScore > 0 ? +(bestScore / baselineScore * 100 - 100).toFixed(1) : null;

    return {
        bestParams,
        bestScore:    +bestScore.toFixed(4),
        bestStats,
        improvement,
        history,
        totalEvals:   history.length,
        convergence:  history.map(h => h.score), // для графика
    };
}

// ════════════════════════════════════════════════════════════════
// MARKET REGIME CLASSIFIER
// ════════════════════════════════════════════════════════════════

function computeFeatures(bars) {
    if (bars.length < 5) return null;
    const closes = bars.map(b => parseFloat(b.close));
    const highs  = bars.map(b => parseFloat(b.high));
    const lows   = bars.map(b => parseFloat(b.low));

    // ATR
    const trs = bars.map((b, i) => {
        if (i === 0) return parseFloat(b.high) - parseFloat(b.low);
        const h = parseFloat(b.high), l = parseFloat(b.low), pc = parseFloat(bars[i-1].close);
        return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    });
    const atr    = mean(trs.slice(-Math.min(14, trs.length)));
    const atrPct = (atr / (closes[closes.length-1] || 1)) * 100;

    // Linreg on closes
    const { r2, slope } = linReg(closes.map((_, i) => i), closes);
    const normSlope = slope / (mean(closes) + 1e-10) * 100;

    // Bollinger width
    const sma     = mean(closes);
    const bbWidth = (std(closes) * 2) / (sma + 1e-10) * 100;

    // ADX proxy = r² scaled
    const adx = clamp(r2 * 100, 0, 100);

    return { adx, atrPct, r2, normSlope, bbWidth };
}

function classifyRegime(f) {
    if (!f) return 'unknown';
    const { adx, atrPct, normSlope, bbWidth, r2 } = f;
    const isTrend   = adx > 35 && r2 > 0.5;
    const isVolat   = atrPct > 1.5 || bbWidth > 4;
    const isRanging = adx < 25 && bbWidth < 2;

    if (isTrend  && normSlope > 0.01)  return 'trending_up';
    if (isTrend  && normSlope < -0.01) return 'trending_down';
    if (isVolat  && !isTrend)          return 'volatile';
    if (isRanging)                     return 'ranging';
    return 'neutral';
}

/**
 * Классифицирует режимы рынка по всей истории баров
 *
 * @param {Array}  bars
 * @param {Object} options  { windowSize:50, stepSize:10 }
 */
function classifyMarketRegimes(bars, options = {}) {
    const { windowSize = 50, stepSize = 10 } = options;
    if (bars.length < windowSize) {
        return { regimes: [], timeline: [], current: 'unknown', distribution: {}, totalBars: bars.length };
    }

    const regimes  = [];
    const timeline = new Array(bars.length).fill('unknown');

    for (let i = windowSize; i <= bars.length; i += stepSize) {
        const win   = bars.slice(i - windowSize, i);
        const feat  = computeFeatures(win);
        const reg   = classifyRegime(feat);
        const si    = Math.max(0, i - windowSize);
        const ei    = Math.min(bars.length - 1, i - 1);

        regimes.push({
            startIdx: si, endIdx: ei,
            startTs:  bars[si]?.timestamp,
            endTs:    bars[ei]?.timestamp,
            regime:   reg,
            features: feat ? {
                adx: +feat.adx.toFixed(1), atrPct: +feat.atrPct.toFixed(3),
                r2: +feat.r2.toFixed(3), normSlope: +feat.normSlope.toFixed(4), bbWidth: +feat.bbWidth.toFixed(2),
            } : null,
        });

        for (let j = si; j <= ei; j++) timeline[j] = reg;
    }

    // Текущий режим
    const lastFeat = computeFeatures(bars.slice(-windowSize));
    const current  = classifyRegime(lastFeat);

    // Распределение
    const counts = {};
    timeline.forEach(r => { counts[r] = (counts[r] || 0) + 1; });
    const distribution = {};
    Object.entries(counts).forEach(([r, c]) => {
        distribution[r] = +(c / timeline.length * 100).toFixed(1);
    });

    return {
        regimes,
        timeline, // индекс по барам
        current,
        currentFeatures: lastFeat ? {
            adx: +lastFeat.adx.toFixed(1), atrPct: +lastFeat.atrPct.toFixed(3),
            r2: +lastFeat.r2.toFixed(3), normSlope: +lastFeat.normSlope.toFixed(4), bbWidth: +lastFeat.bbWidth.toFixed(2),
        } : null,
        distribution,
        totalBars: bars.length,
    };
}

// ════════════════════════════════════════════════════════════════
// SETUP × REGIME ANALYZER
// ════════════════════════════════════════════════════════════════

/**
 * Сопоставляет трейды с режимами рынка.
 * Для каждого трейда ищет режим по entryTs.
 *
 * @param {Array}  trades     — трейды с полями entryTs, pnl, setupName
 * @param {Object} regimeData — результат classifyMarketRegimes
 */
function analyzeSetupByRegime(trades, regimeData) {
    const { regimes, current } = regimeData;
    if (!trades.length || !regimes.length) {
        return { byRegime: {}, recommendations: {}, current: { regime: current, recommendation: null } };
    }

    const byRegime = {};

    trades.forEach(trade => {
        const ts = trade.entryTs;
        // Ищем regime для этого timestamp
        let tradeRegime = 'unknown';
        let bestDiff    = Infinity;
        for (const r of regimes) {
            const s = new Date(r.startTs).getTime();
            const e = new Date(r.endTs).getTime();
            if (ts >= s && ts <= e) { tradeRegime = r.regime; break; }
            const diff = Math.min(Math.abs(ts - s), Math.abs(ts - e));
            if (diff < bestDiff) { bestDiff = diff; tradeRegime = r.regime; }
        }

        const setupName = trade.setupName || 'default';
        if (!byRegime[tradeRegime]) byRegime[tradeRegime] = {};
        if (!byRegime[tradeRegime][setupName]) byRegime[tradeRegime][setupName] = { trades: 0, wins: 0, pnl: 0 };

        const s = byRegime[tradeRegime][setupName];
        s.trades++;
        if (trade.pnl > 0) s.wins++;
        s.pnl += trade.pnl;
    });

    // Финальные метрики
    Object.values(byRegime).forEach(map =>
        Object.values(map).forEach(s => {
            s.winRate = s.trades ? +(s.wins / s.trades * 100).toFixed(1) : 0;
            s.avgPnl  = s.trades ? +(s.pnl / s.trades).toFixed(2) : 0;
            s.pnl     = +s.pnl.toFixed(2);
        })
    );

    // Рекомендации
    const recommendations = {};
    Object.entries(byRegime).forEach(([regime, map]) => {
        let bestSetup = null, bestScore = -Infinity;
        Object.entries(map).forEach(([name, s]) => {
            if (s.trades < 3) return;
            const score = (s.winRate / 100) * Math.max(0, s.avgPnl);
            if (score > bestScore) { bestScore = score; bestSetup = name; }
        });
        if (bestSetup) {
            const s = map[bestSetup];
            recommendations[regime] = {
                bestSetup,
                winRate:    s.winRate,
                avgPnl:     s.avgPnl,
                totalPnl:   s.pnl,
                trades:     s.trades,
                confidence: s.trades >= 20 ? 'high' : s.trades >= 10 ? 'medium' : 'low',
            };
        }
    });

    return {
        byRegime,
        recommendations,
        current: {
            regime:         current,
            recommendation: recommendations[current] || null,
        },
    };
}

// ════════════════════════════════════════════════════════════════
// CLICKHOUSE LOADER
// ════════════════════════════════════════════════════════════════

async function loadBarsFromClickhouse(clickhouse, cfg) {
    const { ticker, table, fromTs, toTs } = cfg;
    let where = 'WHERE ticker = {ticker:String}';
    const qp  = { ticker };
    if (fromTs) { where += ' AND toUnixTimestamp(window_start) >= {fromTs:UInt32}'; qp.fromTs = fromTs; }
    if (toTs)   { where += ' AND toUnixTimestamp(window_start) <= {toTs:UInt32}';   qp.toTs   = toTs;   }

    const rs = await clickhouse.query({
        query: `SELECT window_start AS timestamp, toFloat64(open) AS open, toFloat64(high) AS high, toFloat64(low) AS low, toFloat64(close) AS close, toFloat64OrZero(toString(coalesce(volume,0))) AS volume FROM ${table} ${where} ORDER BY window_start ASC`,
        format: 'JSONEachRow',
        query_params: qp,
        clickhouse_settings: { max_execution_time: 3600 },
    });

    const bars = [];
    const stream = rs.stream();
    for await (const rows of stream) {
        for (const rawRow of rows) {
            const r = rawRow?.text ? JSON.parse(rawRow.text) : rawRow;
            bars.push({
                timestamp: r.timestamp,
                open: parseFloat(r.open), high: parseFloat(r.high),
                low:  parseFloat(r.low),  close: parseFloat(r.close),
                volume: parseFloat(r.volume) || 0, atr: 0,
            });
        }
    }
    return bars;
}

module.exports = {
    bayesianOptimize,
    classifyMarketRegimes,
    analyzeSetupByRegime,
    loadBarsFromClickhouse,
    computeFeatures,
    classifyRegime,
};