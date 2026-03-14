

'use strict';

const { classifyMarketRegimes, analyzeSetupByRegime } = require('./ai-engine');
const { runBacktestOnBars, calcStats } = require('./backtest-engine-server');

// ════════════════════════════════════════════════════════════════
// УСЛОВИЯ АЛЕРТА
// ════════════════════════════════════════════════════════════════

/**
 * Типы условий:
 *   price_cross_above  — цена пересекает уровень снизу вверх
 *   price_cross_below  — цена пересекает уровень сверху вниз
 *   price_above        — цена выше уровня
 *   price_below        — цена ниже уровня
 *   setup_signal       — появился сигнал сетапа (bar[column] === triggerValue)
 *   pct_change         — изменение цены за N баров > threshold%
 *   atr_spike          — ATR вырос в X раз выше среднего (волатильность)
 */
function checkCondition(alert, bar, prevBar) {
    const price = parseFloat(bar.close);
    const { type, level, column, triggerValue = 1, threshold, period = 1 } = alert.condition;

    switch (type) {
        case 'price_cross_above':
            return prevBar && parseFloat(prevBar.close) <= level && price > level;

        case 'price_cross_below':
            return prevBar && parseFloat(prevBar.close) >= level && price < level;

        case 'price_above':
            return price > level;

        case 'price_below':
            return price < level;

        case 'setup_signal':
            return column && +bar[column] === +triggerValue;

        case 'pct_change': {
            if (!prevBar) return false;
            const prev = parseFloat(prevBar.close);
            return prev > 0 && Math.abs((price - prev) / prev * 100) >= threshold;
        }

        case 'atr_spike': {
            const atr = parseFloat(bar.atr) || 0;
            return atr > 0 && threshold > 0 && atr >= threshold;
        }

        default:
            return false;
    }
}

/**
 * Проверяет список алертов на текущем баре
 * @param {Array}  alerts  — массив объектов алерта
 * @param {Object} bar     — текущий бар
 * @param {Object} prevBar — предыдущий бар
 * @returns {Array} сработавшие алерты
 */
function checkAlertsOnBar(alerts, bar, prevBar) {
    return alerts.filter(a => {
        if (!a.active) return false;
        return checkCondition(a, bar, prevBar);
    });
}

// ════════════════════════════════════════════════════════════════
// УРОВНИ ЛИКВИДНОСТИ (без внешнего API)
// ════════════════════════════════════════════════════════════════

/**
 * Вычисляет ключевые уровни ликвидности по историческим данным:
 *   — High Volume Nodes (кластеры объёма)
 *   — Swing High/Low (локальные экстремумы)
 *   — Round Numbers (психологические уровни)
 *
 * @param {Object} bar   — текущий бар
 * @param {Array}  bars  — массив исторических баров
 * @returns {Array} [{ level, type, strength, distancePct }]
 */
function estimateLiquidityLevels(bar, bars) {
    const price  = parseFloat(bar.close);
    const levels = [];
    const lookback = Math.min(200, bars.length);
    const recent   = bars.slice(-lookback);

    // ── 1. Swing High/Low (пивоты) ───────────────────────────────
    const swingPeriod = 5;
    for (let i = swingPeriod; i < recent.length - swingPeriod; i++) {
        const hi = parseFloat(recent[i].high);
        const lo = parseFloat(recent[i].low);
        let isSwingHigh = true, isSwingLow = true;

        for (let j = i - swingPeriod; j <= i + swingPeriod; j++) {
            if (j === i) continue;
            if (parseFloat(recent[j].high) > hi) isSwingHigh = false;
            if (parseFloat(recent[j].low)  < lo) isSwingLow  = false;
        }

        if (isSwingHigh) levels.push({ level: hi, type: 'swing_high', strength: 2 });
        if (isSwingLow)  levels.push({ level: lo, type: 'swing_low',  strength: 2 });
    }

    // ── 2. High Volume Nodes ──────────────────────────────────────
    // Группируем объём по ценовым корзинам (20 корзин)
    const allHighs  = recent.map(b => parseFloat(b.high));
    const allLows   = recent.map(b => parseFloat(b.low));
    const priceMin  = Math.min(...allLows);
    const priceMax  = Math.max(...allHighs);
    const buckets   = 20;
    const bucketSz  = (priceMax - priceMin) / buckets;

    if (bucketSz > 0) {
        const volumeByBucket = new Array(buckets).fill(0);
        recent.forEach(b => {
            const mid = (parseFloat(b.high) + parseFloat(b.low)) / 2;
            const idx = Math.min(buckets - 1, Math.floor((mid - priceMin) / bucketSz));
            volumeByBucket[idx] += parseFloat(b.volume) || 0;
        });
        const maxVol = Math.max(...volumeByBucket);
        volumeByBucket.forEach((vol, idx) => {
            if (vol > maxVol * 0.7) { // топ 30% по объёму
                const lvlPrice = priceMin + (idx + 0.5) * bucketSz;
                levels.push({ level: lvlPrice, type: 'high_volume_node', strength: 3 });
            }
        });
    }

    // ── 3. Round Numbers ─────────────────────────────────────────
    // Ближайшие круглые числа (10, 100, 1000 и т.д.)
    const magnitude = Math.pow(10, Math.floor(Math.log10(price)) - 1);
    for (let mult = -5; mult <= 5; mult++) {
        const round = Math.round(price / magnitude + mult) * magnitude;
        if (Math.abs(round - price) / price < 0.05) { // в пределах 5%
            levels.push({ level: round, type: 'round_number', strength: 1 });
        }
    }

    // ── Дедупликация и сортировка по близости к цене ─────────────
    const merged = [];
    const sorted = levels.sort((a, b) => Math.abs(a.level - price) - Math.abs(b.level - price));

    for (const lvl of sorted) {
        const isDup = merged.some(m => Math.abs(m.level - lvl.level) / price < 0.002);
        if (!isDup) {
            merged.push({
                level:       +lvl.level.toFixed(5),
                type:        lvl.type,
                strength:    lvl.strength,
                distancePct: +((lvl.level - price) / price * 100).toFixed(2),
                side:        lvl.level > price ? 'above' : 'below',
            });
        }
        if (merged.length >= 10) break;
    }

    return merged;
}

// ════════════════════════════════════════════════════════════════
// АКТИВНЫЕ СЕТАПЫ НА ТЕКУЩЕМ БАРЕ
// ════════════════════════════════════════════════════════════════

/**
 * Находит какие сетапы дали сигнал на текущем баре
 * и вычисляет историческую точность каждого
 *
 * @param {Object} bar       — текущий бар
 * @param {Array}  bars      — исторические бары
 * @param {Object} setupCols — { name: { column, dir, ... } }
 * @param {Object} cfg       — конфиг бэктеста
 * @returns {Array} [{ name, column, dir, signal, historicalWR, historicalPF }]
 */
function getActiveSetups(bar, bars, setupCols, cfg) {
    const active = [];

    for (const [name, def] of Object.entries(setupCols || {})) {
        const col = def.column || name;
        const val = +bar[col];
        if (!val || val === 0) continue;

        // Считаем историческую точность на последних 100 барах
        const lookback = bars.slice(-100);
        const trades   = runBacktestOnBars(lookback, { ...cfg, setupCols: { [name]: def } });
        const stats    = calcStats(trades, cfg.capital || 10000);

        active.push({
            name,
            column:       col,
            dir:          def.dir || 'long',
            signal:       val,
            trades:       stats?.total || 0,
            winRate:      stats?.winRate || null,
            profitFactor: stats?.profitFactor || null,
            expectancy:   stats?.expectancy || null,
            maxDD:        stats?.maxDD || null,
            reliable:     stats && stats.total >= 10 && stats.winRate > 50,
        });
    }

    return active;
}

// ════════════════════════════════════════════════════════════════
// ГЕНЕРАЦИЯ ПОЛНОГО КОНТЕКСТА
// ════════════════════════════════════════════════════════════════

/**
 * Генерирует полный контекст для умного алерта
 *
 * @param {Object} triggeredAlert — сработавший алерт
 * @param {Object} bar            — текущий бар
 * @param {Array}  bars           — исторические бары (для анализа)
 * @param {Object} cfg            — { setupCols, capital, ... }
 * @param {Array}  trades         — трейды из последнего бэктеста (для regime analysis)
 * @returns {Object} context
 */
function generateContext(triggeredAlert, bar, bars, cfg, trades = []) {
    const price = parseFloat(bar.close);

    // 1. Активные сетапы
    const activeSetups = getActiveSetups(bar, bars, cfg.setupCols || {}, cfg);

    // 2. Режим рынка
    let regimeData = null;
    try {
        const regResult = classifyMarketRegimes(bars.slice(-500), { windowSize: 50, stepSize: 10 });
        regimeData = {
            current:        regResult.current,
            features:       regResult.currentFeatures,
            distribution:   regResult.distribution,
        };
    } catch(_) {}

    // 3. Рекомендации по режиму (если есть трейды)
    let regimeAnalysis = null;
    if (trades.length >= 5 && regimeData) {
        try {
            const full = classifyMarketRegimes(bars.slice(-500), { windowSize: 50, stepSize: 10 });
            regimeAnalysis = analyzeSetupByRegime(trades, full);
        } catch(_) {}
    }

    // 4. Уровни ликвидности
    const liquidityLevels = estimateLiquidityLevels(bar, bars);

    // 5. Ближайшие уровни (топ 3 выше и ниже)
    const levelsAbove = liquidityLevels.filter(l => l.side === 'above').slice(0, 3);
    const levelsBelow = liquidityLevels.filter(l => l.side === 'below').slice(0, 3);

    // 6. Итоговая рекомендация
    let recommendation = null;
    if (regimeData && regimeAnalysis) {
        const rec = regimeAnalysis.current?.recommendation;
        if (rec) {
            recommendation = {
                setup:      rec.bestSetup,
                winRate:    rec.winRate,
                avgPnl:     rec.avgPnl,
                confidence: rec.confidence,
                reason:     `Best performer in ${regimeData.current} regime (${rec.trades} trades)`,
            };
        }
    }

    return {
        triggeredAt:    bar.timestamp,
        price,
        alertName:      triggeredAlert.name,
        alertCondition: triggeredAlert.condition,

        // Активные сетапы
        activeSetups,
        hasActiveSignals: activeSetups.length > 0,

        // Режим рынка
        regime:         regimeData?.current || 'unknown',
        regimeFeatures: regimeData?.features || null,

        // Уровни ликвидности
        liquidityLevels,
        nearestAbove:   levelsAbove[0] || null,
        nearestBelow:   levelsBelow[0] || null,
        levelsAbove,
        levelsBelow,

        // Рекомендация
        recommendation,

        // Сводка (для отображения)
        summary: buildSummary({
            price, activeSetups, regime: regimeData?.current,
            recommendation, levelsAbove, levelsBelow,
        }),
    };
}

function buildSummary({ price, activeSetups, regime, recommendation, levelsAbove, levelsBelow }) {
    const parts = [];

    if (activeSetups.length > 0) {
        const names = activeSetups.map(s => `${s.name}${s.winRate ? ` (WR: ${s.winRate}%)` : ''}`).join(', ');
        parts.push(`🎯 Active: ${names}`);
    }

    if (regime && regime !== 'unknown') {
        const labels = { trending_up:'📈 Trending Up', trending_down:'📉 Trending Down', ranging:'↔️ Ranging', volatile:'⚡ Volatile', neutral:'➡️ Neutral' };
        parts.push(`🌊 Regime: ${labels[regime] || regime}`);
    }

    if (recommendation) {
        parts.push(`💡 Best setup: ${recommendation.setup} (${recommendation.winRate}% WR, ${recommendation.confidence} confidence)`);
    }

    if (levelsAbove[0]) {
        parts.push(`⬆️ Next resistance: ${levelsAbove[0].level} (+${levelsAbove[0].distancePct}%)`);
    }
    if (levelsBelow[0]) {
        parts.push(`⬇️ Next support: ${levelsBelow[0].level} (${levelsBelow[0].distancePct}%)`);
    }

    return parts;
}

// ════════════════════════════════════════════════════════════════
// CRUD — работа с алертами в БД
// ════════════════════════════════════════════════════════════════

/**
 * SQL для создания таблицы (выполнить один раз):
 *
 * CREATE TABLE IF NOT EXISTS smart_alerts (
 *   id          SERIAL PRIMARY KEY,
 *   user_id     INTEGER NOT NULL REFERENCES users(id),
 *   name        VARCHAR(200) NOT NULL,
 *   ticker      VARCHAR(100) NOT NULL,
 *   table_name  VARCHAR(100) NOT NULL,
 *   condition   JSONB NOT NULL,
 *   active      BOOLEAN DEFAULT TRUE,
 *   once        BOOLEAN DEFAULT FALSE,
 *   created_at  TIMESTAMPTZ DEFAULT NOW(),
 *   last_fired  TIMESTAMPTZ,
 *   fire_count  INTEGER DEFAULT 0,
 *   context     JSONB
 * );
 */

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS smart_alerts (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    name        VARCHAR(200) NOT NULL,
    ticker      VARCHAR(100) NOT NULL,
    table_name  VARCHAR(100) NOT NULL,
    condition   JSONB NOT NULL,
    active      BOOLEAN DEFAULT TRUE,
    once        BOOLEAN DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    last_fired  TIMESTAMPTZ,
    fire_count  INTEGER DEFAULT 0,
    context     JSONB
);
`;

module.exports = {
    checkAlertsOnBar,
    generateContext,
    estimateLiquidityLevels,
    getActiveSetups,
    CREATE_TABLE_SQL,
};