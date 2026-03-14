/**
 * alpha-decay-engine.js  v1.0
 *
 * Движок анализа Alpha Decay.
 * Детектирует деградацию сетапа во времени по трейдам из бэктеста.
 *
 * Алгоритм:
 *   1. Разбиваем трейды на временные окна (месяц / квартал / N трейдов)
 *   2. В каждом окне: WinRate, ProfitFactor, Expectancy, TotalPnL
 *   3. Линейная регрессия по ряду PF → slope + R²
 *   4. Классификация: None / Mild / Moderate / Critical
 *   5. Half-Life: через сколько окон PF потеряет 50%
 *   6. Stability Score 0–100
 *   7. Best / Worst периоды
 *   8. Прогноз: через сколько периодов PF < 1.0
 *   9. Рекомендация текстом
 *
 * Экспорт: analyzeDecay(trades, options) → DecayReport
 */

'use strict';

function mean(arr) {
    return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}
function std(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}
function linearRegression(ys) {
    const n = ys.length;
    if (n < 2) return { slope: 0, intercept: ys[0] || 0, r2: 0 };
    const xs = ys.map((_, i) => i);
    const mx = mean(xs), my = mean(ys);
    let num = 0, den = 0, ssY = 0;
    for (let i = 0; i < n; i++) {
        num += (xs[i] - mx) * (ys[i] - my);
        den += (xs[i] - mx) ** 2;
        ssY += (ys[i] - my) ** 2;
    }
    const slope     = den > 0 ? num / den : 0;
    const intercept = my - slope * mx;
    const r2        = ssY > 0 ? Math.min(1, (num * num) / (den * ssY)) : 0;
    return { slope: +slope.toFixed(6), intercept: +intercept.toFixed(6), r2: +r2.toFixed(4) };
}
function calcHalfLife(ys) {
    const pairs = ys.map((v, i) => [i, v]).filter(([, v]) => v > 1e-6);
    if (pairs.length < 3) return null;
    const logYs = pairs.map(([, v]) => Math.log(v));
    const reg   = linearRegression(logYs);
    if (reg.slope >= 0) return null;
    return +(-Math.LN2 / reg.slope).toFixed(1);
}
function stabilityScore(vals) {
    if (vals.length < 2) return 100;
    const m = mean(vals);
    if (Math.abs(m) < 1e-6) return 0;
    const cv = std(vals) / Math.abs(m);
    return Math.max(0, Math.round((1 - Math.min(cv, 1)) * 100));
}
function toMs(ts) {
    if (!ts) return 0;
    if (typeof ts === 'number') return ts < 2e12 ? ts * 1000 : ts;
    return new Date(ts).getTime() || 0;
}
function calendarKey(ms, size) {
    const d = new Date(ms);
    const y = d.getUTCFullYear(), m = d.getUTCMonth();
    if (size === 'quarter') return `${y}-Q${Math.floor(m / 3) + 1}`;
    if (size === 'year')    return `${y}`;
    return `${y}-${String(m + 1).padStart(2, '0')}`;
}
function fmtLabel(ms, size) {
    const d = new Date(ms);
    const y = d.getUTCFullYear(), m = d.getUTCMonth();
    if (size === 'quarter') return `${y} Q${Math.floor(m / 3) + 1}`;
    if (size === 'year')    return `${y}`;
    return `${y}-${String(m + 1).padStart(2, '0')}`;
}

function buildWindows(trades, windowSize) {
    if (!trades.length) return [];
    const sorted = [...trades]
        .map(t => ({ ...t, _ms: toMs(t.entryTs) }))
        .filter(t => t._ms > 0)
        .sort((a, b) => a._ms - b._ms);
    if (!sorted.length) return [];

    let groups = [];
    if (typeof windowSize === 'number') {
        for (let i = 0; i < sorted.length; i += windowSize) {
            const chunk = sorted.slice(i, i + windowSize);
            if (chunk.length < 3) continue;
            groups.push({ label: fmtLabel(chunk[0]._ms, 'month'), fromMs: chunk[0]._ms, trades: chunk });
        }
    } else {
        const map = new Map();
        for (const t of sorted) {
            const key = calendarKey(t._ms, windowSize);
            if (!map.has(key)) map.set(key, { key, label: fmtLabel(t._ms, windowSize), fromMs: t._ms, trades: [] });
            map.get(key).trades.push(t);
        }
        groups = [...map.values()].filter(g => g.trades.length >= 3);
    }
    return groups.map((g, idx) => ({ idx, ...g, ...windowStats(g.trades) }));
}

function windowStats(trades) {
    if (!trades.length) return { total:0, wins:0, losses:0, winRate:0, profitFactor:0, expectancy:0, totalPnl:0, avgPnl:0, avgWin:0, avgLoss:0, maxDD:0 };
    const wins   = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
    const grossW   = wins.reduce((s, t) => s + t.pnl, 0);
    const grossL   = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const wr       = wins.length / trades.length;
    const avgWin   = wins.length   ? grossW / wins.length   : 0;
    const avgLoss  = losses.length ? grossL / losses.length : 0;
    let runCap = 0, peak = 0, maxDD = 0;
    for (const t of trades) {
        runCap += (t.pnl || 0);
        if (runCap > peak) peak = runCap;
        const dd = peak > 0 ? (peak - runCap) / peak * 100 : 0;
        if (dd > maxDD) maxDD = dd;
    }
    return {
        total: trades.length, wins: wins.length, losses: losses.length,
        winRate:      +(wr * 100).toFixed(1),
        profitFactor: grossL > 0 ? +(grossW / grossL).toFixed(3) : (grossW > 0 ? 9.99 : 0),
        expectancy:   +((wr * avgWin) - ((1 - wr) * avgLoss)).toFixed(2),
        totalPnl:     +totalPnl.toFixed(2),
        avgPnl:       +(totalPnl / trades.length).toFixed(2),
        avgWin:       +avgWin.toFixed(2),
        avgLoss:      +(-avgLoss).toFixed(2),
        maxDD:        +maxDD.toFixed(1),
    };
}

const LEVELS = {
    none:     { label:'None',     color:'#4caf50', icon:'✅', score:0 },
    mild:     { label:'Mild',     color:'#8bc34a', icon:'🟡', score:1 },
    moderate: { label:'Moderate', color:'#ff9800', icon:'🟠', score:2 },
    critical: { label:'Critical', color:'#ef5350', icon:'🔴', score:3 },
};

function classifyDecay(pfSlope, pfR2, blinePF) {
    const rel  = blinePF > 0 ? pfSlope / blinePF : pfSlope;
    const conf = Math.sqrt(Math.max(0, pfR2));
    if (rel >= -0.01 || conf < 0.25)  return 'none';
    if (rel >= -0.05 && conf >= 0.25) return 'mild';
    if (rel >= -0.12 && conf >= 0.35) return 'moderate';
    return 'critical';
}

function buildRecommendation(level, pfChange, wrChange, stability, hl, breakevenIn, winSz) {
    const unit = typeof winSz === 'number' ? 'windows' : winSz + 's';
    if (level === 'none') return [
        '✅ Setup is performing consistently — no significant decay detected.',
        stability >= 80 ? 'Stability is excellent. Results are predictable across periods.'
                        : 'Moderate variance across periods. Monitor across different market regimes.',
    ];
    if (level === 'mild') return [
        '🟡 Mild decay: performance gradually declining.',
        pfChange < -10 ? `Profit Factor dropped ${Math.abs(pfChange).toFixed(1)}% vs baseline.` : null,
        hl ? `Estimated half-life: ${hl} ${unit}.` : null,
        'Action: Monitor closely. Re-run Bayesian Optimization if trend continues 2+ more periods.',
    ].filter(Boolean);
    if (level === 'moderate') return [
        '🟠 Moderate decay — consistent downward trend in core metrics.',
        (breakevenIn > 0 && breakevenIn < 20) ? `At current rate, setup hits breakeven PF in ~${breakevenIn} ${unit}.` : null,
        wrChange < -5 ? `Win Rate fell ${Math.abs(wrChange).toFixed(1)}pp — signal quality degrading.` : null,
        'Action: Reduce position size 30–50%. Re-optimize on recent data only (last 3–6 months).',
    ].filter(Boolean);
    return [
        '🔴 Critical decay — setup is losing edge rapidly.',
        breakevenIn !== null && breakevenIn <= 2 ? 'WARNING: Approaching breakeven within 1–2 periods.' : null,
        'Action: Pause trading this setup immediately.',
        'Run full re-backtest from scratch on the last 6 months. Consider replacing signal logic.',
    ].filter(Boolean);
}

function _singleDecay(trades, windowSize, minWindows) {
    const windows = buildWindows(trades, windowSize);
    if (windows.length < minWindows) {
        return { error: `Only ${windows.length} windows built, need ${minWindows}. Use smaller windowSize or more history.`, windows };
    }

    const pfSeries  = windows.map(w => w.profitFactor);
    const wrSeries  = windows.map(w => w.winRate);
    const expSeries = windows.map(w => w.expectancy);
    const pnlSeries = windows.map(w => w.totalPnl);

    const pfReg  = linearRegression(pfSeries);
    const wrReg  = linearRegression(wrSeries);
    const expReg = linearRegression(expSeries);

    const baseN   = Math.max(1, Math.round(windows.length * 0.25));
    const blinePF = mean(pfSeries.slice(0, baseN));
    const blineWR = mean(wrSeries.slice(0, baseN));
    const last    = windows[windows.length - 1];
    const first   = windows[0];

    const pfChange = blinePF > 0 ? +((last.profitFactor - blinePF) / blinePF * 100).toFixed(1) : 0;
    const wrChange = +(last.winRate - first.winRate).toFixed(1);
    const level    = classifyDecay(pfReg.slope, pfReg.r2, blinePF);
    const meta     = LEVELS[level];
    const hl       = calcHalfLife(pfSeries);

    let breakevenIn = null;
    if (pfReg.slope < 0 && pfReg.r2 > 0.15 && last.profitFactor > 1.0) {
        breakevenIn = Math.max(0, Math.round((1.0 - last.profitFactor) / pfReg.slope));
    }

    const stability = {
        profitFactor: stabilityScore(pfSeries),
        winRate:      stabilityScore(wrSeries),
        expectancy:   stabilityScore(expSeries),
        overall: Math.round(stabilityScore(pfSeries)*0.4 + stabilityScore(wrSeries)*0.3 + stabilityScore(expSeries)*0.3),
    };

    const sorted       = [...windows].sort((a, b) => b.profitFactor - a.profitFactor);
    const bestPeriods  = sorted.slice(0, 3).map(w => winSum(w));
    const worstPeriods = sorted.slice(-3).reverse().map(w => winSum(w));

    return {
        windowSize, totalTrades: trades.length, totalWindows: windows.length,
        decayLevel: level, decayLabel: meta.label, decayColor: meta.color, decayIcon: meta.icon, decayScore: meta.score,
        regression: { profitFactor: pfReg, winRate: wrReg, expectancy: expReg },
        halfLifeWindows: hl,
        halfLifeLabel:   hl ? `${hl} ${typeof windowSize === 'number' ? 'windows' : windowSize + 's'}` : null,
        stability, pfChange, wrChange, breakevenIn,
        baseline: { profitFactor: +blinePF.toFixed(3), winRate: +blineWR.toFixed(1) },
        current:  { profitFactor: last.profitFactor, winRate: last.winRate, expectancy: last.expectancy, trades: last.total },
        series: {
            labels:       windows.map(w => w.label),
            profitFactor: pfSeries.map(v => +v.toFixed(3)),
            winRate:      wrSeries.map(v => +v.toFixed(1)),
            expectancy:   expSeries.map(v => +v.toFixed(2)),
            totalPnl:     pnlSeries.map(v => +v.toFixed(2)),
            trades:       windows.map(w => w.total),
            trendPF:      windows.map((_, i) => +(pfReg.intercept + pfReg.slope * i).toFixed(3)),
        },
        windows: windows.map(w => ({
            label: w.label, fromMs: w.fromMs,
            total: w.total, winRate: w.winRate, profitFactor: w.profitFactor,
            expectancy: w.expectancy, totalPnl: w.totalPnl, avgPnl: w.avgPnl, maxDD: w.maxDD,
        })),
        bestPeriods, worstPeriods,
        recommendation: buildRecommendation(level, pfChange, wrChange, stability.overall, hl, breakevenIn, windowSize),
    };
}

function winSum(w) {
    return { period: w.label, trades: w.total, winRate: w.winRate, profitFactor: w.profitFactor, expectancy: w.expectancy, totalPnl: w.totalPnl };
}

function analyzeDecay(trades, options = {}) {
    const { windowSize = 'month', minWindows = 3, setupFilter = null } = options;
    const filtered = setupFilter ? trades.filter(t => t.setupName === setupFilter) : trades;
    if (filtered.length < 5) return { error: 'Not enough trades (need at least 5).' };

    const setupNames = [...new Set(filtered.map(t => t.setupName).filter(Boolean))];
    if (setupNames.length > 1 && !setupFilter) {
        const bySetup = {};
        for (const name of setupNames) {
            const r = _singleDecay(filtered.filter(t => t.setupName === name), windowSize, minWindows);
            if (!r.error) bySetup[name] = r;
        }
        const overall = _singleDecay(filtered, windowSize, minWindows);
        return { bySetup, overall: overall.error ? null : overall, setupNames };
    }
    return _singleDecay(filtered, windowSize, minWindows);
}

module.exports = { analyzeDecay, buildWindows, windowStats, linearRegression };