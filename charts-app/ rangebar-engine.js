/**
 * rangebar-engine.js
 *
 * Извлечён из spx-rangebar-backtest.js для использования в server.js.
 * Экспортирует runRangeBarBacktest(clickhouse, cfg, onProgress, branches)
 */
'use strict';

// ── Time helpers ──────────────────────────────────────────────

function utcHMS(tsMs) {
    const d = new Date(tsMs);
    return { h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds(), day: d.getUTCDay() };
}

function secOfDay(hms) { return hms.h * 3600 + hms.m * 60 + hms.s; }

const SESSION_OPEN  = 14 * 3600 + 30 * 60;  // 14:30 UTC
const SESSION_CLOSE = 21 * 3600;             // 21:00 UTC
const FRIDAY_CUTOFF = 19 * 3600 + 58 * 60 + 30; // 19:58:30 UTC

function inSession(tsMs) {
    const hms = utcHMS(tsMs);
    if (hms.day === 0 || hms.day === 6) return false;
    const s = secOfDay(hms);
    return s >= SESSION_OPEN && s < SESSION_CLOSE;
}

function canEnter(tsMs) {
    if (!inSession(tsMs)) return false;
    const hms = utcHMS(tsMs);
    if (hms.day === 5) return secOfDay(hms) < FRIDAY_CUTOFF;
    return true;
}

function isWeekend(tsMs) { const d = new Date(tsMs).getUTCDay(); return d === 0 || d === 6; }
function isFriday(tsMs)   { return new Date(tsMs).getUTCDay() === 5; }

// ── GEX binary search index ───────────────────────────────────

function buildGEXIndex(gexRows) {
    const tsMsArr = gexRows.map(r => new Date(r.ts).getTime());
    return function(tsMs) {
        let lo = 0, hi = tsMsArr.length - 1, res = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (tsMsArr[mid] <= tsMs) { res = mid; lo = mid + 1; }
            else hi = mid - 1;
        }
        if (res < 0) return null;
        // Only return GEX if it's within the same session day (not stale from prev day)
        const gexDate = new Date(gexRows[res].ts).toISOString().slice(0, 10);
        const reqDate = new Date(tsMs).toISOString().slice(0, 10);
        if (gexDate !== reqDate) return null;
        return gexRows[res];
    };
}

// ── Range bar builder ─────────────────────────────────────────

function buildRangeBars(ticks, RANGE) {
    const bars = [];
    let barOpen = null, high = null, low = null;
    let barTicks = 0, delta = 0;
    let prevPrice = null, prevDir = 0;
    let sessionDay = null;

    for (const tick of ticks) {
        const tsMs = new Date(tick.ts).getTime();
        const px   = parseFloat(tick.price);

        // Lee-Ready direction
        let dir;
        if (prevPrice === null || px > prevPrice) { dir = 1;  prevDir = 1;  }
        else if (px < prevPrice)                   { dir = -1; prevDir = -1; }
        else                                        { dir = prevDir;          }
        prevPrice = px;

        if (isWeekend(tsMs)) continue;
        const hms  = utcHMS(tsMs);
        const sod  = secOfDay(hms);
        const inS  = sod >= SESSION_OPEN && sod < SESSION_CLOSE;
        const date = new Date(tsMs).toISOString().slice(0, 10);

        // Reset at day boundary
        if (date !== sessionDay) {
            sessionDay = date;
            barOpen = null; high = null; low = null;
            barTicks = 0; delta = 0;
        }

        if (!inS) continue;

        if (barOpen === null) {
            barOpen = { price: px, ts: tsMs };
            high = px; low = px;
            barTicks = 0; delta = 0;
        }

        high = Math.max(high, px);
        low  = Math.min(low,  px);
        barTicks++;
        delta += dir;

        const up   = high - barOpen.price;
        const down = barOpen.price - low;

        if (up >= RANGE) {
            const close = barOpen.price + RANGE;
            bars.push({ open: barOpen.price, high: close, low: barOpen.price, close,
                open_ts: barOpen.ts, close_ts: tsMs, ticks: barTicks, delta, direction: 'bull' });
            barOpen = { price: close, ts: tsMs };
            high = close; low = close; barTicks = 0; delta = 0;
        } else if (down >= RANGE) {
            const close = barOpen.price - RANGE;
            bars.push({ open: barOpen.price, high: barOpen.price, low: close, close,
                open_ts: barOpen.ts, close_ts: tsMs, ticks: barTicks, delta, direction: 'bear' });
            barOpen = { price: close, ts: tsMs };
            high = close; low = close; barTicks = 0; delta = 0;
        }
    }
    return bars;
}

// ── Backtest engine ───────────────────────────────────────────

function runBacktestOnBars(bars, ticks, getGEX, cfg, branchA) {
    const { tick_size, tick_value, delta_threshold, gex_vol_max,
            zero_gamma_offset, limit_offset, sl_ticks, tp_ticks, cancel_ticks } = cfg;

    const trades = [];
    let pendingLimit = null;
    let openTrade    = null;
    let tickCursor   = 0;

    for (let bi = 0; bi < bars.length; bi++) {
        const bar = bars[bi];

        // Advance tick cursor past bar close
        while (tickCursor < ticks.length &&
               new Date(ticks[tickCursor].ts).getTime() < bar.close_ts) {
            tickCursor++;
        }

        // Check entry after bearish bar close
        if (bar.direction === 'bear' && pendingLimit === null && openTrade === null) {
            if (canEnter(bar.close_ts)) {
                // ① bearish ✓
                // ② delta > threshold
                if (bar.delta > delta_threshold) {
                    // ③-⑥ GEX conditions
                    const gex = getGEX(bar.close_ts);
                    if (gex) {
                        const { zero_gamma, major_neg_vol, sum_gex_vol } = gex;
                        const price = bar.close;

                        const c4 = sum_gex_vol >= -gex_vol_max;           // ④
                        const c5 = price < zero_gamma - zero_gamma_offset; // ⑤
                        const c6 = !branchA || price > major_neg_vol;      // ⑥

                        if (c4 && c5 && c6) {
                            const limit = bar.close + limit_offset;
                            pendingLimit = {
                                price:        limit,
                                sl:           limit + sl_ticks   * tick_size,
                                tp:           limit - tp_ticks   * tick_size,
                                cancel_price: limit - cancel_ticks * tick_size,
                                bar_close_ts: bar.close_ts,
                                bar,
                                gex,
                            };
                        }
                    }
                }
            }
        }

        if (pendingLimit === null && openTrade === null) continue;

        // Simulate ticks after bar close
        const nextBarTs = bi + 1 < bars.length ? bars[bi + 1].close_ts : Infinity;
        let cursor = tickCursor;

        while (cursor < ticks.length) {
            const tsMs  = new Date(ticks[cursor].ts).getTime();
            if (tsMs >= nextBarTs) break;
            const px    = parseFloat(ticks[cursor].price);
            const hms   = utcHMS(tsMs);
            const sod   = secOfDay(hms);
            const fri   = hms.day === 5;
            const isEOD = sod >= SESSION_CLOSE && !isWeekend(tsMs);
            cursor++;

            // ── Pending limit ───────────────────────────────────────
            if (pendingLimit !== null) {
                // Mon-Thu EOD: cancel pending limit
                if (isEOD && !fri) { pendingLimit = null; continue; }
                // Friday EOD: cancel
                if (fri && isEOD)  { pendingLimit = null; continue; }

                // Fill: SHORT limit = ask + offset → filled when price rises to limit
                if (px >= pendingLimit.price) {
                    openTrade = {
                        entry:    pendingLimit.price,
                        sl:       pendingLimit.sl,
                        tp:       pendingLimit.tp,
                        fill_ts:  tsMs,
                        signal_ts:pendingLimit.bar_close_ts,
                        bar:      pendingLimit.bar,
                        gex:      pendingLimit.gex,
                    };
                    pendingLimit = null;
                    continue;
                }

                // Cancel: price fell 10 ticks without fill
                if (px <= pendingLimit.cancel_price) {
                    pendingLimit = null;
                    continue;
                }
            }

            // ── Open trade: check TP / SL ───────────────────────────
            if (openTrade !== null) {
                let exitPrice = null, exitReason = null;
                if (px <= openTrade.tp)  { exitPrice = openTrade.tp;  exitReason = 'TP'; }
                else if (px >= openTrade.sl) { exitPrice = openTrade.sl; exitReason = 'SL'; }

                if (exitReason) {
                    const pnl_pts   = openTrade.entry - exitPrice; // SHORT: profit = entry - exit
                    const pnl_ticks = pnl_pts / tick_size;
                    const pnl_usd   = pnl_ticks * tick_value;
                    trades.push({
                        signal_ts:    new Date(openTrade.signal_ts).toISOString(),
                        fill_ts:      new Date(openTrade.fill_ts).toISOString(),
                        exit_ts:      new Date(tsMs).toISOString(),
                        entry_price:  openTrade.entry,
                        exit_price:   exitPrice,
                        sl:           openTrade.sl,
                        tp:           openTrade.tp,
                        exit_reason:  exitReason,
                        pnl_pts:      +pnl_pts.toFixed(4),
                        pnl_ticks:    +pnl_ticks.toFixed(1),
                        pnl_usd:      +pnl_usd.toFixed(2),
                        bar_delta:    openTrade.bar.delta,
                        bar_ticks_count: openTrade.bar.ticks,
                        bar_open:     openTrade.bar.open,
                        bar_close:    openTrade.bar.close,
                        gex_zero_gamma:  openTrade.gex.zero_gamma,
                        gex_sum_vol:     openTrade.gex.sum_gex_vol,
                        gex_major_neg:   openTrade.gex.major_neg_vol,
                        branch:       branchA ? 'A' : 'B',
                    });
                    openTrade = null;
                }
            }
        }
    }
    return trades;
}

// ── Stats ─────────────────────────────────────────────────────

function calcStats(trades) {
    if (!trades.length) return { total: 0 };
    const wins    = trades.filter(t => t.pnl_usd > 0);
    const losses  = trades.filter(t => t.pnl_usd <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl_usd, 0);
    const grossW  = wins.reduce((s, t) => s + t.pnl_usd, 0);
    const grossL  = Math.abs(losses.reduce((s, t) => s + t.pnl_usd, 0));

    let peak = 0, maxDD = 0, eq = 0;
    const equityCurve = trades.map(t => {
        eq += t.pnl_usd;
        if (eq > peak) peak = eq;
        const dd = peak > 0 ? (peak - eq) / peak * 100 : 0;
        if (dd > maxDD) maxDD = dd;
        return { ts: t.exit_ts, equity: +eq.toFixed(2), dd: +dd.toFixed(2) };
    });

    const byExit = {}, byHour = {}, byDay = {};
    trades.forEach(t => {
        byExit[t.exit_reason] = (byExit[t.exit_reason] || 0) + 1;
        const h = new Date(t.fill_ts).getUTCHours();
        byHour[h] = byHour[h] || { trades: 0, wins: 0, pnl: 0 };
        byHour[h].trades++; if (t.pnl_usd > 0) byHour[h].wins++;
        byHour[h].pnl = +(byHour[h].pnl + t.pnl_usd).toFixed(2);
        const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        const d = days[new Date(t.fill_ts).getUTCDay()];
        byDay[d] = byDay[d] || { trades: 0, wins: 0, pnl: 0 };
        byDay[d].trades++; if (t.pnl_usd > 0) byDay[d].wins++;
        byDay[d].pnl = +(byDay[d].pnl + t.pnl_usd).toFixed(2);
    });

    return {
        total: trades.length, wins: wins.length, losses: losses.length,
        win_rate:      +(wins.length / trades.length * 100).toFixed(1),
        total_pnl:     +totalPnl.toFixed(2),
        avg_win:       wins.length   ? +(grossW / wins.length).toFixed(2)   : 0,
        avg_loss:      losses.length ? +(grossL / losses.length).toFixed(2) : 0,
        profit_factor: grossL > 0   ? +(grossW / grossL).toFixed(2)         : null,
        max_drawdown:  +maxDD.toFixed(2),
        ev_per_trade:  +(totalPnl / trades.length).toFixed(2),
        by_exit: byExit, by_hour: byHour, by_day: byDay,
        equity_curve: equityCurve,
    };
}

// ── Main export ───────────────────────────────────────────────

async function runRangeBarBacktest(clickhouse, cfg, onProgress, branches = { branch_a: true, branch_b: true }) {
    const { ticker, gex_ticker, from_date, to_date, range_pts } = cfg;

    onProgress({ pct: 5, phase: 'loading', message: `Загрузка тиков ${ticker}...` });

    // Load ES ticks
    const ticksRs = await clickhouse.query({
        query: `
            SELECT participant_timestamp AS ts, toFloat64(price) AS price
            FROM default.raw_market_data
            WHERE provider_id = 200
              AND ticker = '${ticker}'
              AND toDate(participant_timestamp) >= '${from_date}'
              AND toDate(participant_timestamp) <= '${to_date}'
            ORDER BY participant_timestamp ASC
        `,
        format: 'JSONEachRow',
        clickhouse_settings: { max_execution_time: 600 },
    });
    const ticks = await ticksRs.json();
    onProgress({ pct: 30, phase: 'loading', message: `Загружено ${ticks.length.toLocaleString()} тиков. Загрузка GEX...` });

    if (!ticks.length) throw new Error(`Нет тиков для ${ticker} за ${from_date}–${to_date}`);

    // Load GEX
    const gexRs = await clickhouse.query({
        query: `
            SELECT
                participant_timestamp AS ts,
                toFloat64(JSONExtractFloat(extra, 'zero_gamma'))   AS zero_gamma,
                toFloat64(JSONExtractFloat(extra, 'major_neg_vol')) AS major_neg_vol,
                toFloat64(JSONExtractFloat(extra, 'sum_gex_vol'))  AS sum_gex_vol
            FROM default.raw_market_data
            WHERE provider_id = 100
              AND ticker = '${gex_ticker}'
              AND toDate(participant_timestamp) >= '${from_date}'
              AND toDate(participant_timestamp) <= '${to_date}'
            ORDER BY participant_timestamp ASC
        `,
        format: 'JSONEachRow',
        clickhouse_settings: { max_execution_time: 300 },
    });
    const gexRows = await gexRs.json();
    onProgress({ pct: 45, phase: 'bars', message: `Загружено ${gexRows.length.toLocaleString()} GEX записей. Строим range-бары...` });

    // Build range bars
    const bars = buildRangeBars(ticks, range_pts);
    onProgress({ pct: 60, phase: 'bars', message: `Построено ${bars.length} range-баров (${range_pts} pts). Запуск бэктеста...` });

    const getGEX = buildGEXIndex(gexRows);
    const results = {};

    // Branch A
    if (branches.branch_a) {
        onProgress({ pct: 65, phase: 'backtest_a', message: 'Ветка A (с условием price > major_neg)...' });
        const tradesA = runBacktestOnBars(bars, ticks, getGEX, cfg, true);
        results.branch_a = { trades: tradesA, stats: calcStats(tradesA) };
        onProgress({ pct: 80, phase: 'backtest_a', message: `Ветка A: ${tradesA.length} сделок` });
    }

    // Branch B
    if (branches.branch_b) {
        onProgress({ pct: 85, phase: 'backtest_b', message: 'Ветка B (без условия major_neg)...' });
        const tradesB = runBacktestOnBars(bars, ticks, getGEX, cfg, false);
        results.branch_b = { trades: tradesB, stats: calcStats(tradesB) };
        onProgress({ pct: 95, phase: 'backtest_b', message: `Ветка B: ${tradesB.length} сделок` });
    }

    onProgress({ pct: 100, phase: 'done', message: 'Готово' });

    return {
        ticker, from_date, to_date,
        total_ticks: ticks.length,
        total_bars:  bars.length,
        gex_records: gexRows.length,
        cfg,
        ...results,
    };
}

module.exports = { runRangeBarBacktest, buildRangeBars, calcStats };