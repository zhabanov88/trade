/**
 * setups-backtest.js  v2.0
 *
 * Добавляет в панель data-table две новые вкладки:
 *   📐 Setups   — просмотр сигналов сетапов по данным activedata
 *   📊 Backtest — бэктестирование с журналом сделок
 *
 * ── Модель сетапов ──────────────────────────────────────────────
 *
 * Сетап = числовая колонка в activedata:
 *   0 = нет сигнала
 *   1 = вход (entry)
 *   2 = в позиции (hold)
 *   3 = выход по правилу 1 (например TP)
 *   4 = выход по правилу 2 (например SL)
 *   5+ = расширяемые кастомные правила
 *
 * Регистрация сетапа:
 *   window.app.setups = {
 *     "FVG Bull": { column: "fvg_bull", dir: "long", exitRules: [
 *       { status: 3, label: "TP hit" },
 *       { status: 4, label: "SL hit" },
 *     ]},
 *   }
 *
 * Если exitRules не заданы — используется фиксированный SL/TP из настроек.
 * Если window.app.setups пуст — автодетект числовых колонок.
 *
 * ── Интеграция с REPLAY ─────────────────────────────────────────
 *   backtestPlayer.start() → таблица сделок заполняется в реальном времени.
 *
 * ── Подключение ─────────────────────────────────────────────────
 *   <script src="setups-backtest.js"></script>  (после data-table.js)
 */

if (window._sbLoaded) {} else { window._sbLoaded = true; (function () {
    'use strict';

    // ════════════════════════════════════════════════════════════════
    // STATE
    // ════════════════════════════════════════════════════════════════

    const SB = {
        setupSignals: [],
        signalFilter: 'all',
        signalPage:   0,
        PAGE:         200,
    
        cfg: loadCfg(),
    
        trades:      [],
        btRunning:   false,
        btProgress:  0,
        detailTrade: null,
        tradeFilter: 'all',
        tickerFilter: 'all',
        tfFilter:     'all',
    
        liveReplay:  false,
        liveTrade:   null,

        dateRange:        { from: '', to: '' },
        // Мульти-запуск
        multiTickers:    [],  // дополнительные тикеры ['BTC-USD', ...]
        multiTimeframes: [],  // дополнительные таймфреймы ['market_data_1min', ...]
        availableTables: [], // список таблиц из БД
    };

    function loadCfg() {
        try { return Object.assign(defaultCfg(), JSON.parse(localStorage.getItem('sb_bt_cfg') || '{}')); }
        catch(_) { return defaultCfg(); }
    }
    function saveCfg() {
        try { localStorage.setItem('sb_bt_cfg', JSON.stringify(SB.cfg)); } catch(_) {}
    }
    function defaultCfg() {
        return {
            setups: [], capital: 10000, riskPct: 1, leverage: 1,
            slMode: 'pct', slValue: 1,
            tpMode: 'rr',  tpValue: 2,
            maxBars: 50, direction: 'long', useColExit: true,
        };
    }

    // ════════════════════════════════════════════════════════════════
    // HELPERS
    // ════════════════════════════════════════════════════════════════

    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g,
            c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    function fmtP(v) {
        const n = parseFloat(v);
        if (isNaN(n)) return '—';
        return n < 0.01 ? n.toFixed(8) : n < 1 ? n.toFixed(6) : n < 100 ? n.toFixed(4) : n.toFixed(2);
    }
    function gotoBar(tsMs) {
        try { window.app?.widget?.activeChart()?.scrollToPosition?.(Math.floor(tsMs / 1000)); } catch(_) {}
        window.dataTable?.highlight?.(tsMs);
    }
    function getSetupDefs() { return window.app?.setups || {}; }

    function autoDetectCols() {
        const bars = window.app?.activedata;
        if (!bars?.length) return {};
        const skip = new Set(['timestamp','open','high','low','close','volume','transactions']);
        const sample = bars.slice(0, Math.min(300, bars.length));
        const res = {};
        for (const key of Object.keys(sample[sample.length - 1] || {})) {
            if (skip.has(key)) continue;
            const has = sample.some(b => { const v = +b[key]; return Number.isInteger(v) && v >= 1 && v <= 9; });
            if (has) res[key] = { column: key };
        }
        return res;
    }

    function getActiveCols(cfg) {
        const defs = getSetupDefs();
        if (Object.keys(defs).length && cfg.setups.length) {
            const res = {};
            cfg.setups.forEach(n => { if (defs[n]) res[n] = defs[n]; });
            return res;
        }
        if (Object.keys(defs).length) return defs;
        return autoDetectCols();
    }

    // ════════════════════════════════════════════════════════════════
    // SCAN
    // ════════════════════════════════════════════════════════════════

    function runScan() {
        const bars  = window.app?.activedata;
        if (!bars?.length) return [];
        const defs  = getSetupDefs();
        const cols  = Object.keys(defs).length ? defs : autoDetectCols();
        const out   = [];
        bars.forEach((bar, idx) => {
            for (const [name, def] of Object.entries(cols)) {
                const col = def.column || name;
                const v   = +bar[col];
                if (isNaN(v) || v === 0) continue;
                out.push({ barIdx: idx, bar, setupName: name, col, status: v });
            }
        });
        return out;
    }

    // ════════════════════════════════════════════════════════════════
    // BACKTEST ENGINE
    // ════════════════════════════════════════════════════════════════

    function calcSL(bar, cfg, dir) {
        const e = parseFloat(bar.close), atr = parseFloat(bar.atr) || e * 0.01;
        const d = cfg.slMode === 'atr' ? atr * cfg.slValue : e * cfg.slValue / 100;
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
        return riskPerU ? (riskAmt / riskPerU) * cfg.leverage : 0;
    }

    function checkColExit(bar, trade, activeCols, cfg) {
        if (!cfg.useColExit) return null;
        const v = +bar[trade.col];
        if (isNaN(v) || v < 3) return null;
        const def   = activeCols[trade.setupName] || {};
        const rules = def.exitRules || [];
        const rule  = rules.find(r => r.status === v);
        return { price: parseFloat(bar.close), reason: rule?.label || `Status ${v}` };
    }

    function runBacktest(cfg) {
        const bars      = window.app?.activedata;
        if (!bars?.length) return [];
        const activeCols = getActiveCols(cfg);
        if (!Object.keys(activeCols).length) return [];

        const trades = [];
        let capital  = cfg.capital;
        let inTrade  = null;

        for (let i = 0; i < bars.length; i++) {
            const bar   = bars[i];
            const close = parseFloat(bar.close);
            const high  = parseFloat(bar.high);
            const low   = parseFloat(bar.low);
            const ts    = new Date(bar.timestamp).getTime();

            if (inTrade) {
                let exitPrice = null, exitReason = null;

                const colExit = checkColExit(bar, inTrade, activeCols, cfg);
                if (colExit) { exitPrice = colExit.price; exitReason = colExit.reason; }

                if (!exitPrice) {
                    if (inTrade.dir === 'long') {
                        if (low  <= inTrade.sl) { exitPrice = inTrade.sl; exitReason = 'SL'; }
                        else if (high >= inTrade.tp) { exitPrice = inTrade.tp; exitReason = 'TP'; }
                    } else {
                        if (high >= inTrade.sl) { exitPrice = inTrade.sl; exitReason = 'SL'; }
                        else if (low  <= inTrade.tp) { exitPrice = inTrade.tp; exitReason = 'TP'; }
                    }
                }

                const barsIn = i - inTrade.entryBarIdx;
                if (!exitPrice && barsIn >= cfg.maxBars) { exitPrice = close; exitReason = 'TIMEOUT'; }

                if (exitPrice) {
                    const pnl = inTrade.dir === 'long'
                        ? (exitPrice - inTrade.entry) * inTrade.qty
                        : (inTrade.entry - exitPrice) * inTrade.qty;
                    capital += pnl;
                    trades.push({
                        ...inTrade,
                        exitPrice, exitReason,
                        exitBar: bar, exitTs: ts, exitBarIdx: i,
                        pnl:          +pnl.toFixed(4),
                        pnlPct:       +((pnl / inTrade.capitalBefore) * 100).toFixed(2),
                        capitalAfter: +capital.toFixed(2),
                        barsHeld:     barsIn,
                    });
                    inTrade = null;
                }
            }

            if (!inTrade) {
                for (const [name, def] of Object.entries(activeCols)) {
                    const col = def.column || name;
                    const v   = +bar[col];
                    if (isNaN(v) || v !== 1) continue;

                    const dir = def.dir || (cfg.direction !== 'both' ? cfg.direction : 'long');
                    if (cfg.direction !== 'both' && dir !== cfg.direction) continue;

                    const entry = close;
                    const sl    = calcSL(bar, cfg, dir);
                    const tp    = calcTP(entry, sl, cfg, dir);
                    const qty   = calcQty(capital, entry, sl, cfg);
                    if (qty <= 0) continue;

                    inTrade = {
                        setupName: name, col, dir, entry, sl, tp, qty,
                        entryBar: bar, entryTs: ts, entryBarIdx: i,
                        capitalBefore: +capital.toFixed(2),
                        riskAmt: +(capital * cfg.riskPct / 100).toFixed(2),
                        leverage: cfg.leverage,
                    };
                    break;
                }
            }
        }
        return trades;
    }

    // ════════════════════════════════════════════════════════════════
    // STATS
    // ════════════════════════════════════════════════════════════════

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
        const byTicker = {};
        trades.forEach(t => {
            if (!t.ticker) return;
            if (!byTicker[t.ticker]) byTicker[t.ticker] = { total:0, wins:0, pnl:0 };
            byTicker[t.ticker].total++;
            if (t.pnl > 0) byTicker[t.ticker].wins++;
            byTicker[t.ticker].pnl += t.pnl;
        });
        const byTimeframe = {};
        trades.forEach(t => {
            if (!t.timeframe) return;
            if (!byTimeframe[t.timeframe]) byTimeframe[t.timeframe] = { total:0, wins:0, pnl:0 };
            byTimeframe[t.timeframe].total++;
            if (t.pnl > 0) byTimeframe[t.timeframe].wins++;
            byTimeframe[t.timeframe].pnl += t.pnl;
        });

        return {
            total: trades.length, wins: wins.length, losses: losses.length,
            winRate:     +(wins.length / trades.length * 100).toFixed(1),
            totalPnl:    +totalPnl.toFixed(2),
            totalPnlPct: +((endCap - startCapital) / startCapital * 100).toFixed(2),
            endCapital:  +endCap.toFixed(2),
            avgWin:  +avgWin.toFixed(2),  avgLoss: +avgLoss.toFixed(2),
            rr:      +Math.abs(avgLoss ? avgWin / avgLoss : 0).toFixed(2),
            maxDD:   +maxDD.toFixed(2),
            expectancy: +((wins.length/trades.length * avgWin) + (losses.length/trades.length * avgLoss)).toFixed(2),
            profitFactor: grossL ? +(grossW / grossL).toFixed(2) : 0,
            bySetup, byExit,
            byTicker, byTimeframe,
        };
    }

    // ════════════════════════════════════════════════════════════════
    // LIVE REPLAY INTEGRATION
    // ════════════════════════════════════════════════════════════════

    function hookReplay() {
        const bp = window.backtestPlayer;
        if (!bp) { setTimeout(hookReplay, 600); return; }

        const _next  = bp.next;
        const _start = bp.start;
        const _exit  = bp.exit;

        bp.next = function(...a) {
            const r = _next?.(...a);
            onReplayStep();
            return r;
        };
        bp.start = function(...a) {
            SB.liveReplay = true; SB.trades = []; SB.liveTrade = null;
            refreshIfOpen('backtest');
            return _start?.(...a);
        };
        bp.exit = function(...a) {
            SB.liveReplay = false; SB.liveTrade = null;
            refreshIfOpen('backtest');
            return _exit?.(...a);
        };
    }

    function onReplayStep() {
        if (!SB.liveReplay) return;
        const bars = window.app?.activedata;
        if (!bars?.length) return;
        const cfg  = SB.cfg;
        const i    = bars.length - 1;
        const bar  = bars[i];
        const ts   = new Date(bar.timestamp).getTime();
        const activeCols = getActiveCols(cfg);
        const close = parseFloat(bar.close);
        const high  = parseFloat(bar.high);
        const low   = parseFloat(bar.low);

        if (SB.liveTrade) {
            const t = SB.liveTrade;
            let exitPrice = null, exitReason = null;

            const colExit = checkColExit(bar, t, activeCols, cfg);
            if (colExit) { exitPrice = colExit.price; exitReason = colExit.reason; }

            if (!exitPrice) {
                if (t.dir === 'long') {
                    if (low  <= t.sl) { exitPrice = t.sl; exitReason = 'SL'; }
                    else if (high >= t.tp) { exitPrice = t.tp; exitReason = 'TP'; }
                } else {
                    if (high >= t.sl) { exitPrice = t.sl; exitReason = 'SL'; }
                    else if (low  <= t.tp) { exitPrice = t.tp; exitReason = 'TP'; }
                }
            }
            if (!exitPrice && (i - t.entryBarIdx) >= cfg.maxBars) { exitPrice = close; exitReason = 'TIMEOUT'; }

            if (exitPrice) {
                const pnl = t.dir === 'long'
                    ? (exitPrice - t.entry) * t.qty
                    : (t.entry - exitPrice) * t.qty;
                SB.trades.push({
                    ...t, exitPrice, exitReason, exitBar: bar, exitTs: ts, exitBarIdx: i,
                    pnl: +pnl.toFixed(4), pnlPct: +((pnl/t.capitalBefore)*100).toFixed(2),
                    capitalAfter: +(t.capitalBefore + pnl).toFixed(2),
                    barsHeld: i - t.entryBarIdx,
                });
                SB.liveTrade = null;
                refreshIfOpen('backtest');
            }
        }

        if (!SB.liveTrade && cfg.setups.length) {
            for (const [name, def] of Object.entries(activeCols)) {
                const col = def.column || name;
                if (+bar[col] !== 1) continue;
                const lastCap = SB.trades.length ? SB.trades[SB.trades.length-1].capitalAfter : cfg.capital;
                const dir   = def.dir || (cfg.direction !== 'both' ? cfg.direction : 'long');
                const entry = close;
                const sl    = calcSL(bar, cfg, dir);
                const tp    = calcTP(entry, sl, cfg, dir);
                const qty   = calcQty(lastCap, entry, sl, cfg);
                if (!qty) break;
                SB.liveTrade = {
                    setupName: name, col, dir, entry, sl, tp, qty,
                    entryBar: bar, entryTs: ts, entryBarIdx: i,
                    capitalBefore: lastCap, riskAmt: +(lastCap*cfg.riskPct/100).toFixed(2),
                    leverage: cfg.leverage,
                };
                refreshIfOpen('backtest');
                break;
            }
        }
    }

    function refreshIfOpen(tab) {
        const active = document.querySelector('.sb-tab.sb-tab-active');
        if (active?.dataset?.tab !== tab) return;
        const body = document.getElementById('sb-tab-body');
        if (!body) return;
        if (tab === 'setups')   renderSetupsTab(body);
        if (tab === 'backtest') renderBacktestTab(body);
    }

    // ════════════════════════════════════════════════════════════════
    // RENDER — SETUPS TAB
    // ════════════════════════════════════════════════════════════════

    function stLabel(v, def) {
        const rule = (def?.exitRules||[]).find(r => r.status === v);
        if (rule) return `<span class="sb-st sb-st-exit">${esc(rule.label)}</span>`;
        if (v === 1) return `<span class="sb-st sb-st-entry">Entry</span>`;
        if (v === 2) return `<span class="sb-st sb-st-hold">Hold</span>`;
        if (v >= 3)  return `<span class="sb-st sb-st-exit">Exit ${v}</span>`;
        return `<span class="sb-st">${v}</span>`;
    }

    function renderSetupsTab(container) {
        SB.setupSignals = runScan();
        const defs  = getSetupDefs();
        const names = [...new Set(SB.setupSignals.map(s => s.setupName))];
        const filt  = SB.signalFilter === 'all' ? SB.setupSignals
                    : SB.setupSignals.filter(s => s.setupName === SB.signalFilter);
        const total = filt.length;
        const page  = SB.signalPage;
        const slice = filt.slice(page * SB.PAGE, (page+1) * SB.PAGE);
        const pages = Math.ceil(total / SB.PAGE);

        container.innerHTML = `
        <div class="sb-toolbar">
            <span class="sb-title">📐 Setup Signals</span>
            <span class="sb-cnt">${total} of ${SB.setupSignals.length} signals · ${window.app?.activedata?.length||0} bars</span>
            <div class="sb-flex1"></div>
            ${!names.length ? `<span class="sb-warn">⚠ No columns detected — run a script first</span>` : ''}
            <select class="sb-sel" id="sb-sig-filter">
                <option value="all">All setups</option>
                ${names.map(n=>`<option value="${esc(n)}" ${SB.signalFilter===n?'selected':''}>${esc(n)}</option>`).join('')}
            </select>
            <button class="sb-btn" id="sb-scan-btn">🔄 Scan</button>
            <button class="sb-btn sb-btn-reg" id="sb-add-btn">＋ Register</button>
        </div>
        ${pages > 1 ? `<div class="sb-pager">
            <button class="sb-pgbtn" id="sb-pg-p" ${page===0?'disabled':''}>‹ Prev</button>
            <span>Page ${page+1} / ${pages} (${total})</span>
            <button class="sb-pgbtn" id="sb-pg-n" ${(page+1)>=pages?'disabled':''}>Next ›</button>
        </div>` : ''}
        <div class="sb-scroll">
            <table class="sb-tbl">
                <thead><tr>
                    <th>Time</th><th>Setup · Column</th><th>Status</th>
                    <th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Bar#</th><th></th>
                </tr></thead>
                <tbody>
                ${!slice.length
                  ? `<tr><td colspan="9" class="sb-empty">No signals. Ensure your script sets integer 1–4 values in activedata columns, then Scan.</td></tr>`
                  : slice.map(s => {
                      const d = new Date(s.bar.timestamp).toISOString().replace('T',' ').slice(0,16);
                      return `<tr class="sb-sig-row sb-st${s.status}" data-ts="${new Date(s.bar.timestamp).getTime()}">
                          <td>${d}</td>
                          <td><span class="sb-badge">${esc(s.setupName)}</span><span class="sb-mono">.${esc(s.col)}</span></td>
                          <td>${stLabel(s.status, defs[s.setupName])}</td>
                          <td>${fmtP(s.bar.open)}</td><td>${fmtP(s.bar.high)}</td>
                          <td>${fmtP(s.bar.low)}</td><td>${fmtP(s.bar.close)}</td>
                          <td>${s.barIdx+1}</td>
                          <td><button class="sb-goto" data-ts="${new Date(s.bar.timestamp).getTime()}">→</button></td>
                      </tr>`;
                  }).join('')}
                </tbody>
            </table>
        </div>`;

        container.querySelector('#sb-scan-btn')?.addEventListener('click', () => { SB.signalPage=0; renderSetupsTab(container); });
        container.querySelector('#sb-sig-filter')?.addEventListener('change', e => { SB.signalFilter=e.target.value; SB.signalPage=0; renderSetupsTab(container); });
        container.querySelector('#sb-pg-p')?.addEventListener('click', () => { SB.signalPage--; renderSetupsTab(container); });
        container.querySelector('#sb-pg-n')?.addEventListener('click', () => { SB.signalPage++; renderSetupsTab(container); });
        container.querySelectorAll('.sb-goto').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); gotoBar(+b.dataset.ts); }));
        container.querySelectorAll('.sb-sig-row').forEach(r => r.addEventListener('click', () => gotoBar(+r.dataset.ts)));
        container.querySelector('#sb-add-btn')?.addEventListener('click', () => openRegisterDialog(container));
    }

    // ════════════════════════════════════════════════════════════════
    // REGISTER SETUP DIALOG  — body-level, draggable, always visible
    // ════════════════════════════════════════════════════════════════

    function openRegisterDialog(container) {
        document.getElementById('sb-reg-dlg')?.remove();

        const dlg = document.createElement('div');
        dlg.id = 'sb-reg-dlg';
        dlg.className = 'sb-float-dlg';

        const vw = window.innerWidth, vh = window.innerHeight;
        const w = 380;
        dlg.style.left = Math.max(20, (vw - w) / 2) + 'px';
        dlg.style.top  = Math.max(20, Math.min(60, vh * 0.05)) + 'px';
        dlg.style.width = w + 'px';
        dlg.style.maxHeight = (vh - 80) + 'px';

        dlg.innerHTML = `
            <div class="sb-float-hdr" id="sb-dlg-drag-hdr">
                <span>📐 Register Setup</span>
                <div style="display:flex;gap:6px;align-items:center">
                    <button class="sb-float-close" id="sb-reg-collapse" title="Свернуть/развернуть">—</button>
                    <button class="sb-float-close" id="sb-reg-close">✕</button>
                </div>
            </div>
            <div class="sb-float-body">
                <label class="sb-lbl">Setup name</label>
                <input class="sb-inp sb-inp-w" id="sb-reg-name" placeholder="FVG Bull">
                <label class="sb-lbl">Column in activedata</label>
                <input class="sb-inp sb-inp-w" id="sb-reg-col" placeholder="fvg_bull">
                <label class="sb-lbl">Direction</label>
                <select class="sb-sel sb-sel-w" id="sb-reg-dir">
                    <option value="long">Long</option>
                    <option value="short">Short</option>
                </select>
                <label class="sb-lbl">Exit rules <span class="sb-lbl-hint">(status number → label)</span></label>
                <div class="sb-rule-hint">
                    When column value = status → close trade with that label.<br>
                    Leave empty to use fixed SL/TP from Backtest config.
                </div>
                <div id="sb-rule-wrap">
                    <div class="sb-rule">
                        <span class="sb-rule-ico">if =</span>
                        <input class="sb-inp sb-inp-xs" type="number" value="3" placeholder="#">
                        <span class="sb-rule-ico">→</span>
                        <input class="sb-inp sb-inp-flex" value="TP hit" placeholder="Label">
                    </div>
                    <div class="sb-rule">
                        <span class="sb-rule-ico">if =</span>
                        <input class="sb-inp sb-inp-xs" type="number" value="4" placeholder="#">
                        <span class="sb-rule-ico">→</span>
                        <input class="sb-inp sb-inp-flex" value="SL hit" placeholder="Label">
                    </div>
                </div>
                <button class="sb-btn sb-btn-add-rule" id="sb-rule-add">+ Add exit rule</button>
                <div class="sb-float-foot">
                    <button class="sb-btn sb-btn-ok" id="sb-reg-ok">✓ Register</button>
                    <button class="sb-btn" id="sb-reg-cancel">Cancel</button>
                </div>
            </div>`;

        document.body.appendChild(dlg);
        makeDraggable(dlg, dlg.querySelector('#sb-dlg-drag-hdr'));

        const close = () => dlg.remove();
        dlg.querySelector('#sb-reg-close')?.addEventListener('click', close);
        dlg.querySelector('#sb-reg-cancel')?.addEventListener('click', close);

        const colBtn  = dlg.querySelector('#sb-reg-collapse');
        const body    = dlg.querySelector('.sb-float-body');
        let collapsed = false;
        colBtn?.addEventListener('click', () => {
            collapsed = !collapsed;
            body.style.display = collapsed ? 'none' : '';
            colBtn.textContent = collapsed ? '▲' : '—';
            if (!collapsed) dlg.style.maxHeight = (window.innerHeight - 80) + 'px';
        });

        dlg.querySelector('#sb-rule-add')?.addEventListener('click', () => {
            const wrap = dlg.querySelector('#sb-rule-wrap');
            const row  = document.createElement('div');
            row.className = 'sb-rule';
            row.innerHTML = `
                <span class="sb-rule-ico">if =</span>
                <input class="sb-inp sb-inp-xs" type="number" placeholder="#">
                <span class="sb-rule-ico">→</span>
                <input class="sb-inp sb-inp-flex" placeholder="Label">
                <button class="sb-rule-del" title="Remove">✕</button>`;
            row.querySelector('.sb-rule-del')?.addEventListener('click', () => row.remove());
            wrap?.appendChild(row);
        });

        dlg.querySelector('#sb-reg-ok')?.addEventListener('click', () => {
            const name = dlg.querySelector('#sb-reg-name')?.value.trim();
            const col  = dlg.querySelector('#sb-reg-col')?.value.trim();
            if (!name || !col) {
                dlg.querySelector('#sb-reg-name').style.borderColor = name ? '' : '#ef5350';
                dlg.querySelector('#sb-reg-col').style.borderColor  = col  ? '' : '#ef5350';
                return;
            }
            const dir = dlg.querySelector('#sb-reg-dir')?.value;
            const exitRules = [];
            dlg.querySelectorAll('.sb-rule').forEach(row => {
                const inputs = row.querySelectorAll('input');
                const st = parseInt(inputs[0]?.value);
                const lb = inputs[1]?.value?.trim();
                if (!isNaN(st) && lb) exitRules.push({ status: st, label: lb });
            });
            if (!window.app.setups) window.app.setups = {};
            window.app.setups[name] = { column: col, dir, exitRules };
            close();
            SB.signalPage = 0;
            renderSetupsTab(container);
        });
    }

    function makeDraggable(el, handle) {
        let ox = 0, oy = 0, mx = 0, my = 0;
        (handle || el).style.cursor = 'grab';
        (handle || el).addEventListener('mousedown', e => {
            if (e.target.tagName === 'BUTTON') return;
            e.preventDefault();
            mx = e.clientX; my = e.clientY;
            (handle || el).style.cursor = 'grabbing';
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
        function onMove(e) {
            ox = mx - e.clientX; oy = my - e.clientY;
            mx = e.clientX; my = e.clientY;
            const newTop  = Math.max(0, el.offsetTop  - oy);
            const newLeft = Math.max(0, el.offsetLeft - ox);
            el.style.top  = Math.min(newTop,  window.innerHeight - 40) + 'px';
            el.style.left = Math.min(newLeft, window.innerWidth  - 40) + 'px';
        }
        function onUp() {
            (handle || el).style.cursor = 'grab';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        }
    }

    // ════════════════════════════════════════════════════════════════
    // RENDER — BACKTEST TAB
    // ════════════════════════════════════════════════════════════════

    function renderBacktestTab(container) {
        const defs  = getSetupDefs();
        const names = Object.keys(defs).length ? Object.keys(defs) : Object.keys(autoDetectCols());
        const cfg   = SB.cfg;
        const stats = SB.trades.length ? calcStats(SB.trades, cfg.capital) : null;
        const dr    = SB.dateRangeMeta;

        let filt = SB.tradeFilter === 'all'  ? SB.trades
                 : SB.tradeFilter === 'win'  ? SB.trades.filter(t => t.pnl > 0)
                 : SB.tradeFilter === 'loss' ? SB.trades.filter(t => t.pnl <= 0)
                 : SB.trades.filter(t => t.setupName === SB.tradeFilter);
        if (SB.tickerFilter !== 'all') filt = filt.filter(t => t.ticker === SB.tickerFilter);
        if (SB.tfFilter     !== 'all') filt = filt.filter(t => t.timeframe === SB.tfFilter);

        container.innerHTML = `
        <div class="sb-toolbar">
            <span class="sb-title">📊 Backtest</span>
            ${SB.liveReplay ? `<span class="sb-live-tag">● LIVE</span>` : ''}
            <span class="sb-cnt">${SB.trades.length} trades</span>
            <div class="sb-flex1"></div>
            ${SB.btRunning
              ? `<div class="sb-pbar"><div class="sb-pfill" style="width:${SB.btProgress}%"></div></div>
              <span class="sb-cnt" style="color:#2962FF">${SB.btProgress}%</span>
              ${SB.btMessage ? `<span class="sb-cnt" style="color:#8a90a8;font-size:10px">${esc(SB.btMessage)}</span>` : ''}`
              : SB.liveReplay
                ? `<span class="sb-cnt" style="color:#f5a623">Auto-filling with Replay…</span>`
                : `<button class="sb-btn sb-btn-run" id="sb-run-btn">▶ Run (active data)</button>
                   <button class="sb-btn sb-btn-srv" id="sb-run-srv-btn" title="Серверный бектест по выбранному диапазону дат">📊 Run Server BT</button>`}
            ${SB.trades.length ? `<button class="sb-btn" id="sb-clear-btn">🗑</button>` : ''}
        </div>

        <div class="sb-layout">
            <!-- CONFIG panel -->
            <div class="sb-cfg">
                <div class="sb-cfg-h">📐 Setups</div>
                ${!names.length
                  ? `<div class="sb-warn-sm">No setups detected</div>`
                  : names.map(n => `<label class="sb-chklbl">
                        <input type="checkbox" class="sb-chk" value="${esc(n)}" ${cfg.setups.includes(n)?'checked':''}>
                        <span class="sb-chkn">${esc(n)}</span>
                    </label>`).join('')}

                <div class="sb-cfg-h">💰 Capital</div>
                <div class="sb-cfg-lbl">Starting $</div>
                <input class="sb-inp" id="sb-cap" type="number" value="${cfg.capital}">
                <div class="sb-cfg-lbl">Risk per trade %</div>
                <input class="sb-inp" id="sb-risk" type="number" value="${cfg.riskPct}" step="0.1">
                <div class="sb-cfg-lbl">Leverage ×</div>
                <input class="sb-inp" id="sb-lev" type="number" value="${cfg.leverage}" step="0.1">

                <div class="sb-cfg-h">🛑 Stop Loss</div>
                <div class="sb-cfg-row">
                    <select class="sb-sel" id="sb-slm">
                        <option value="pct" ${cfg.slMode==='pct'?'selected':''}>% entry</option>
                        <option value="atr" ${cfg.slMode==='atr'?'selected':''}>× ATR</option>
                    </select>
                    <input class="sb-inp sb-inp-sm" id="sb-slv" type="number" value="${cfg.slValue}" step="0.1">
                </div>

                <div class="sb-cfg-h">🎯 Take Profit</div>
                <div class="sb-cfg-row">
                    <select class="sb-sel" id="sb-tpm">
                        <option value="rr"  ${cfg.tpMode==='rr' ?'selected':''}>R:R</option>
                        <option value="pct" ${cfg.tpMode==='pct'?'selected':''}>% entry</option>
                    </select>
                    <input class="sb-inp sb-inp-sm" id="sb-tpv" type="number" value="${cfg.tpValue}" step="0.1">
                </div>

                <div class="sb-cfg-h">⚙ Rules</div>
                <div class="sb-cfg-lbl">Max bars in trade</div>
                <input class="sb-inp" id="sb-maxb" type="number" value="${cfg.maxBars}">
                <div class="sb-cfg-lbl">Direction</div>
                <select class="sb-sel" id="sb-dir">
                    <option value="long"  ${cfg.direction==='long' ?'selected':''}>Long only</option>
                    <option value="short" ${cfg.direction==='short'?'selected':''}>Short only</option>
                    <option value="both"  ${cfg.direction==='both' ?'selected':''}>Both</option>
                </select>
                <label class="sb-chklbl" style="margin-top:6px">
                    <input type="checkbox" id="sb-col-exit" ${cfg.useColExit?'checked':''}>
                    <span class="sb-chkn" style="font-size:10px">Use column exit (status 3/4…)</span>
                </label>

                <!-- DATE RANGE SECTION -->
                <div class="sb-cfg-h">📅 Date Range <span class="sb-mono">SERVER BT</span></div>
                <div class="sb-cfg-lbl">From</div>
                <input class="sb-inp sb-inp-w" id="sb-from" type="date" value="${cfg.fromDate||''}">
                <div class="sb-cfg-lbl">To</div>
                <input class="sb-inp sb-inp-w" id="sb-to"   type="date" value="${cfg.toDate||''}">
                <button class="sb-btn" id="sb-load-dr-btn" style="margin-top:4px;font-size:10px">📅 Load date range</button>

                <div class="sb-cfg-h">🌐 Multi-Run</div>
                <div class="sb-cfg-lbl">Дополнительные тикеры</div>
                <textarea class="sb-inp sb-inp-w" id="sb-multi-tickers" 
                    rows="2" placeholder="BTC-USD&#10;ETH-USD"
                    style="resize:vertical;font-size:10px">${SB.multiTickers.join('\n')}</textarea>
                <div class="sb-cfg-lbl">Таймфреймы</div>
                ${['market_data_minute','market_data_2min','market_data_3min','market_data_5min',
                   'market_data_15min','market_data_30min','market_data_hourly',
                   'market_data_4hour','market_data_1d'].map(t => {
                    const label = t.replace('market_data_','');
                    const active = window.app?._currentTable || 'market_data_3min';
                    const isActive = t === active;
                    const checked = isActive || SB.multiTimeframes.includes(t);
                    return `<label class="sb-chklbl" title="${isActive ? 'активный' : ''}">
                        <input type="checkbox" class="sb-tf-chk" value="${t}" 
                            ${checked ? 'checked' : ''}
                            ${isActive ? 'disabled style="opacity:.4"' : ''}>
                        <span class="sb-chkn" style="${isActive ? 'color:#2962FF' : ''}">${label}${isActive ? ' ★' : ''}</span>
                    </label>`;
                }).join('')}
                <button class="sb-btn sb-btn-dr" id="sb-load-dr-btn">
                    ${dr ? '🔄 Reload range' : '📅 Load date range'}
                </button>
            </div>

            <!-- RESULTS panel -->
            <div class="sb-results">
                ${stats ? `
                    <div class="sb-stats">
                        ${statCard('Net PnL',  '$'+stats.totalPnl,    stats.totalPnl>=0?'#4caf50':'#ef5350')}
                        ${statCard('Return',   stats.totalPnlPct+'%', stats.totalPnlPct>=0?'#4caf50':'#ef5350')}
                        ${statCard('Win Rate', stats.winRate+'%')}
                        ${statCard('W / L',    stats.wins+' / '+stats.losses)}
                        ${statCard('Profit F', stats.profitFactor)}
                        ${statCard('Avg Win',  '$'+stats.avgWin,  '#4caf50')}
                        ${statCard('Avg Loss', '$'+stats.avgLoss, '#ef5350')}
                        ${statCard('R:R',      stats.rr)}
                        ${statCard('Max DD',   stats.maxDD+'%',   '#ef5350')}
                        ${statCard('Expect.',  '$'+stats.expectancy)}
                        ${statCard('End Cap',  '$'+stats.endCapital)}
                        ${statCard('Trades',   stats.total)}
                    </div>
                    ${renderBreakdown(stats)}
                    <div class="sb-jtoolbar">
                        <span class="sb-jt">Trade Journal</span>
                        <select class="sb-sel" id="sb-tfilt">
                            <option value="all">All (${SB.trades.length})</option>
                            <option value="win"  ${SB.tradeFilter==='win' ?'selected':''}>Wins (${stats.wins})</option>
                            <option value="loss" ${SB.tradeFilter==='loss'?'selected':''}>Losses (${stats.losses})</option>
                            ${Object.keys(stats.bySetup).map(n=>
                              `<option value="${esc(n)}" ${SB.tradeFilter===n?'selected':''}>
                                ${esc(n)} (${stats.bySetup[n].total})</option>`).join('')}
                        </select>
                        ${[...new Set(SB.trades.map(t=>t.ticker).filter(Boolean))].length > 1 ? `
                        <select class="sb-sel" id="sb-ticker-filt">
                            <option value="all">All tickers</option>
                            ${[...new Set(SB.trades.map(t=>t.ticker).filter(Boolean))].map(tk=>
                              `<option value="${esc(tk)}" ${SB.tickerFilter===tk?'selected':''}>${esc(tk)}</option>`).join('')}
                        </select>` : ''}
                        ${[...new Set(SB.trades.map(t=>t.timeframe).filter(Boolean))].length > 1 ? `
                        <select class="sb-sel" id="sb-tf-filt">
                            <option value="all">All TF</option>
                            ${[...new Set(SB.trades.map(t=>t.timeframe).filter(Boolean))].map(tf=>
                              `<option value="${esc(tf)}" ${SB.tfFilter===tf?'selected':''}>${esc(tf.replace('market_data_',''))}</option>`).join('')}
                        </select>` : ''}
                    </div>
                    ${renderJournal(filt)}
                ` : `<div class="sb-empty-big">
                        <div class="sb-empty-ico">📊</div>
                        <div>Select setups and click <b>Run (active data)</b> or <b>Run Server BT</b></div>
                        ${SB.liveReplay ? '<div class="sb-hint">or trades will auto-fill during Replay</div>' : ''}
                    </div>`}
                ${SB.liveReplay && SB.liveTrade ? renderOpenTrade(SB.liveTrade) : ''}
            </div>
        </div>

        ${SB.detailTrade ? `<div class="sb-modal">${renderDetail(SB.detailTrade)}</div>` : ''}`;

        bindBTEvents(container, names);

/*
        window.SB_TRADES = () => SB.trades || [];
        window.SB_CFG = () => ({
            ticker:     window.app?._currentTicker || '',
            table:      window.app?.currentTable  || 'market_data_minute',
            capital:    SB.cfg.capital    || 10000,
            riskPct:    SB.cfg.riskPct    || 1,
            leverage:   SB.cfg.leverage   || 1,
            slMode:     SB.cfg.slMode     || 'pct',
            slValue:    SB.cfg.slValue    || 1,
            tpMode:     SB.cfg.tpMode     || 'rr',
            tpValue:    SB.cfg.tpValue    || 2,
            maxBars:    SB.cfg.maxBars    || 50,
            direction:  SB.cfg.direction  || 'both',
            useColExit: SB.cfg.useColExit !== false,
            setupCols:  window.app?.getSetupColsForBacktest?.() || {},
            fromDate:   SB.cfg.fromDate   || null,
            toDate:     SB.cfg.toDate     || null,
        });
        */
    }

    function statCard(lbl, val, color) {
        return `<div class="sb-scard">
            <div class="sb-slbl">${lbl}</div>
            <div class="sb-sval" ${color?`style="color:${color}"`:''}>${val}</div>
        </div>`;
    }

    function renderBreakdown(stats) {
        const bkRow = (left, total, wr, pnl) => `<div class="sb-bkrow">
            ${left}
            <span>${total}</span>
            <span>${wr}% WR</span>
            <span class="${pnl>=0?'sb-pos':'sb-neg'}">$${pnl.toFixed(2)}</span>
        </div>`;
        const bkSect = (title, rows) => rows ? `<div class="sb-bksect">
            <div class="sb-bkh">${title}</div>${rows}</div>` : '';

        const sus = Object.entries(stats.bySetup || {});
        const exs = Object.entries(stats.byExit  || {});
        const tks = Object.entries(stats.byTicker || {});
        const tfs = Object.entries(stats.byTimeframe || {});

        const setupRows = sus.map(([n,b]) => bkRow(
            `<span class="sb-badge">${esc(n)}</span>`,
            b.total, (b.wins/b.total*100).toFixed(0), b.pnl)).join('');

        const exitRows = exs.map(([r,c]) => `<div class="sb-bkrow">
            <span class="sb-xtag sb-x-${r.toLowerCase().replace(/\s+/g,'')}">${r}</span>
            <span>${c}</span>
            <span>${(c/SB.trades.length*100).toFixed(0)}%</span>
        </div>`).join('');

        const tkRows = tks.length > 1 ? tks.map(([tk,b]) => bkRow(
            `<span class="sb-badge" style="color:#4a9eff">${esc(tk)}</span>`,
            b.total, (b.wins/b.total*100).toFixed(0), b.pnl)).join('') : null;

        const tfRows = tfs.length > 1 ? tfs.map(([tf,b]) => bkRow(
            `<span style="font-size:10px;color:#8a90a8">${esc(tf.replace('market_data_',''))}</span>`,
            b.total, (b.wins/b.total*100).toFixed(0), b.pnl)).join('') : null;

        if (!sus.length && !exs.length && !tkRows && !tfRows) return '';
        return `<div class="sb-breakdown">
            ${bkSect('By Setup', setupRows)}
            ${bkSect('By Exit', exitRows)}
            ${tkRows ? bkSect('By Ticker', tkRows) : ''}
            ${tfRows ? bkSect('By Timeframe', tfRows) : ''}
        </div>`;
    }

    function renderJournal(trades) {
        if (!trades.length) return `<div class="sb-empty">No trades match filter</div>`;
        return `<div class="sb-scroll">
            <table class="sb-tbl">
            <thead>
                <tr>
                    <th>#</th><th>Entry Time</th><th>Setup</th>
                    ${SB.trades.some(t=>t.ticker) ? '<th>Ticker</th>' : ''}
                    ${SB.trades.some(t=>t.timeframe) ? '<th>TF</th>' : ''}
                    <th>Dir</th>
                    <th>Entry</th><th>Exit</th><th>SL</th><th>TP</th>
                    <th>Reason</th><th>PnL $</th><th>PnL %</th><th>Capital</th><th>Bars</th><th></th>
                </tr></thead>
                <tbody>
                ${trades.map((t,i) => {
                    const gi  = SB.trades.indexOf(t);
                    const d   = new Date(t.entryTs).toISOString().replace('T',' ').slice(0,16);
                    const win = t.pnl > 0;
                    const xc  = t.exitReason==='TP'?'sb-x-tp':t.exitReason==='SL'?'sb-x-sl':'sb-x-timeout';
                    return `<tr class="sb-trow ${win?'sb-win':'sb-loss'}" data-idx="${gi}">
                        <td>${i+1}</td><td>${d}</td>
                        <td><span class="sb-badge">${esc(t.setupName)}</span></td>
                        ${SB.trades.some(x=>x.ticker) ? `<td><span class="sb-badge" style="color:#4a9eff">${esc(t.ticker||'')}</span></td>` : ''}
                        ${SB.trades.some(x=>x.timeframe) ? `<td style="font-size:9px;color:#4a5080">${esc((t.timeframe||'').replace('market_data_',''))}</td>` : ''}
                        <td><span class="sb-dir sb-dir-${t.dir}">${t.dir.toUpperCase()}</span></td>
                        <td>${fmtP(t.entry)}</td><td>${fmtP(t.exitPrice)}</td>
                        <td class="sb-slc">${fmtP(t.sl)}</td><td class="sb-tpc">${fmtP(t.tp)}</td>
                        <td><span class="${xc}">${t.exitReason}</span></td>
                        <td class="${win?'sb-pos':'sb-neg'}">$${t.pnl}</td>
                        <td class="${win?'sb-pos':'sb-neg'}">${t.pnlPct}%</td>
                        <td>$${t.capitalAfter}</td><td>${t.barsHeld}</td>
                        <td><button class="sb-jump" data-ts="${t.entryTs}">→</button></td>
                    </tr>`;
                }).join('')}
                </tbody>
            </table>
        </div>`;
    }

    function renderOpenTrade(t) {
        return `<div class="sb-open">
            <span class="sb-live-tag">● OPEN</span>
            <span class="sb-badge">${esc(t.setupName)}</span>
            <span class="sb-dir sb-dir-${t.dir}">${t.dir.toUpperCase()}</span>
            Entry <b>${fmtP(t.entry)}</b>
            SL <span class="sb-slc">${fmtP(t.sl)}</span>
            TP <span class="sb-tpc">${fmtP(t.tp)}</span>
            Risk <b>$${t.riskAmt}</b>
        </div>`;
    }

    function renderDetail(t) {
        const d1 = new Date(t.entryTs).toISOString().replace('T',' ').slice(0,19);
        const d2 = new Date(t.exitTs ).toISOString().replace('T',' ').slice(0,19);
        const win = t.pnl > 0;
        const row = (l,v,c='') => `<div class="sb-dr"><span class="sb-dl">${l}</span><b class="${c}">${v}</b></div>`;
        return `<div class="sb-modal-box">
            <div class="sb-mhdr">
                <span>Trade — <span class="sb-badge">${esc(t.setupName)}</span></span>
                <button id="sb-mclose">✕</button>
            </div>
            <div class="sb-mbody">
                ${row('Direction', `<span class="sb-dir sb-dir-${t.dir}">${t.dir.toUpperCase()}</span>`)}
                ${row('Entry Time', d1)} ${row('Exit Time', d2)}
                ${row('Entry', fmtP(t.entry))} ${row('Exit', fmtP(t.exitPrice))}
                ${row('Stop Loss', fmtP(t.sl),'sb-slc')} ${row('Take Profit', fmtP(t.tp),'sb-tpc')}
                ${row('Exit Reason', t.exitReason)}
                ${row('Qty', t.qty?.toFixed(4))} ${row('Leverage', t.leverage+'×')}
                ${row('Risk Amount', '$'+t.riskAmt)} ${row('Bars Held', t.barsHeld)}
                ${row('PnL', '$'+t.pnl+' ('+t.pnlPct+'%)', win?'sb-pos':'sb-neg')}
                ${row('Capital Before', '$'+t.capitalBefore)} ${row('Capital After', '$'+t.capitalAfter)}
                <div class="sb-mact">
                    <button class="sb-btn sb-jump" data-ts="${t.entryTs}">→ Entry Bar</button>
                    <button class="sb-btn sb-jump" data-ts="${t.exitTs}">→ Exit Bar</button>
                </div>
            </div>
        </div>`;
    }

    function bindBTEvents(container, names) {
        const get = id => container.querySelector(`#${id}`);
        const bind = (id, key, fn) => get(id)?.addEventListener('change', e => { SB.cfg[key]=fn(e.target.value); saveCfg(); });
        bind('sb-cap',  'capital',   parseFloat);
        bind('sb-risk', 'riskPct',   parseFloat);
        bind('sb-lev',  'leverage',  parseFloat);
        bind('sb-slm',  'slMode',    v=>v);
        bind('sb-slv',  'slValue',   parseFloat);
        bind('sb-tpm',  'tpMode',    v=>v);
        bind('sb-tpv',  'tpValue',   parseFloat);
        bind('sb-maxb', 'maxBars',   parseInt);
        bind('sb-dir',  'direction', v=>v);
        get('sb-col-exit')?.addEventListener('change', e => { SB.cfg.useColExit=e.target.checked; saveCfg(); });
        container.querySelectorAll('.sb-chk').forEach(c =>
            c.addEventListener('change', () => {
                SB.cfg.setups=[...container.querySelectorAll('.sb-chk:checked')].map(x=>x.value); saveCfg();
            }));

        // Run local backtest
        get('sb-run-btn')?.addEventListener('click', () => {
            SB.cfg.capital   = parseFloat(get('sb-cap')?.value)  || SB.cfg.capital;
            SB.cfg.riskPct   = parseFloat(get('sb-risk')?.value) || SB.cfg.riskPct;
            SB.cfg.leverage  = parseFloat(get('sb-lev')?.value)  || SB.cfg.leverage;
            SB.cfg.slMode    = get('sb-slm')?.value || SB.cfg.slMode;
            SB.cfg.slValue   = parseFloat(get('sb-slv')?.value)  || SB.cfg.slValue;
            SB.cfg.tpMode    = get('sb-tpm')?.value || SB.cfg.tpMode;
            SB.cfg.tpValue   = parseFloat(get('sb-tpv')?.value)  || SB.cfg.tpValue;
            SB.cfg.maxBars   = parseInt(get('sb-maxb')?.value)   || SB.cfg.maxBars;
            SB.cfg.direction = get('sb-dir')?.value || SB.cfg.direction;
            SB.cfg.setups    = [...container.querySelectorAll('.sb-chk:checked')].map(c=>c.value);
            SB.cfg.useColExit = get('sb-col-exit')?.checked ?? SB.cfg.useColExit;
            saveCfg();

            const cols = Object.keys(getActiveCols(SB.cfg));
            if (!cols.length) { alert('No setups or columns found. Run a script that adds integer columns to activedata.'); return; }

            SB.btRunning=true; SB.btProgress=0; SB.btMessage=''; SB.trades=[];
            renderBacktestTab(container);
            setTimeout(() => { SB.trades=runBacktest(SB.cfg); SB.btRunning=false; renderBacktestTab(container); }, 30);
        });

        get('sb-clear-btn')?.addEventListener('click', () => { SB.trades=[]; SB.detailTrade=null; SB.tradeFilter='all'; renderBacktestTab(container); });
        get('sb-tfilt')?.addEventListener('change', e => { SB.tradeFilter=e.target.value; renderBacktestTab(container); });

        // Load date range
        get('sb-load-dr-btn')?.addEventListener('click', () => loadDateRange(container));

        // Date inputs sync
        get('sb-from')?.addEventListener('change', e => { SB.dateRange.from = e.target.value; });
        get('sb-to')?.addEventListener('change',   e => { SB.dateRange.to   = e.target.value; });

        // Server backtest
        get('sb-run-srv-btn')?.addEventListener('click', () => {
            const ticker = window.app?._currentTicker;
            const table  = window.app?._currentTable;
            if (!ticker || !table) {
                alert('Нет данных о текущем инструменте. Откройте график и дождитесь загрузки данных.');
                return;
            }
            SB.cfg.capital   = parseFloat(get('sb-cap')?.value)  || SB.cfg.capital;
            SB.cfg.riskPct   = parseFloat(get('sb-risk')?.value) || SB.cfg.riskPct;
            SB.cfg.leverage  = parseFloat(get('sb-lev')?.value)  || SB.cfg.leverage;
            SB.cfg.slMode    = get('sb-slm')?.value || SB.cfg.slMode;
            SB.cfg.slValue   = parseFloat(get('sb-slv')?.value)  || SB.cfg.slValue;
            SB.cfg.tpMode    = get('sb-tpm')?.value || SB.cfg.tpMode;
            SB.cfg.tpValue   = parseFloat(get('sb-tpv')?.value)  || SB.cfg.tpValue;
            SB.cfg.maxBars   = parseInt(get('sb-maxb')?.value)   || SB.cfg.maxBars;
            SB.cfg.direction = get('sb-dir')?.value || SB.cfg.direction;
            SB.cfg.setups    = [...container.querySelectorAll('.sb-chk:checked')].map(c => c.value);
            SB.cfg.useColExit = get('sb-col-exit')?.checked ?? SB.cfg.useColExit;
            SB.dateRange.from = get('sb-date-from')?.value || SB.dateRange.from;
            SB.dateRange.to   = get('sb-date-to')?.value   || SB.dateRange.to;
            saveCfg();

            const activeCols = getActiveCols(SB.cfg);
            if (!Object.keys(activeCols).length) {
                alert('No setups or columns found. Run a script that adds integer columns to activedata first.');
                return;
            }

            SB.btRunning = true; SB.btProgress = 0; SB.btMessage = 'Running on server...'; SB.trades = [];
            renderBacktestTab(container);
            runBacktestServer(ticker, table, SB.cfg, activeCols, SB.dateRange, container);
        });

        get('sb-multi-tickers')?.addEventListener('change', e => {
            SB.multiTickers = e.target.value.split(/[\n,]/).map(s=>s.trim()).filter(Boolean);
        });
        container.querySelectorAll('.sb-tf-chk').forEach(c =>
            c.addEventListener('change', () => {
                const active = window.app?.currentTable || 'market_data_3min';
                SB.multiTimeframes = [...container.querySelectorAll('.sb-tf-chk:not([disabled]):checked')]
                    .map(x => x.value)
                    .filter(v => v !== active);
            })
        );
        get('sb-ticker-filt')?.addEventListener('change', e => { SB.tickerFilter=e.target.value; renderBacktestTab(container); });
        get('sb-tf-filt')?.addEventListener('change', e => { SB.tfFilter=e.target.value; renderBacktestTab(container); });

        get('sb-srv-btn')?.addEventListener('click', async () => {
            // Собираем конфиг
            const cfg = SB.cfg;
            cfg.capital   = parseFloat(get('sb-cap')?.value)  || cfg.capital;
            cfg.riskPct   = parseFloat(get('sb-risk')?.value) || cfg.riskPct;
            cfg.leverage  = parseFloat(get('sb-lev')?.value)  || cfg.leverage;
            cfg.slMode    = get('sb-slm')?.value  || cfg.slMode;
            cfg.slValue   = parseFloat(get('sb-slv')?.value)  || cfg.slValue;
            cfg.tpMode    = get('sb-tpm')?.value  || cfg.tpMode;
            cfg.tpValue   = parseFloat(get('sb-tpv')?.value)  ?? cfg.tpValue;
            cfg.maxBars   = parseInt(get('sb-maxb')?.value)   || cfg.maxBars;
            cfg.direction = get('sb-dir')?.value  || cfg.direction;
            cfg.useColExit = get('sb-col-exit')?.checked ?? cfg.useColExit;
            cfg.fromDate  = get('sb-from')?.value || undefined;
            cfg.toDate    = get('sb-to')?.value   || undefined;
            cfg.setups    = [...container.querySelectorAll('.sb-chk:checked')].map(c=>c.value);
            saveCfg();

            const activeCols = getActiveCols(cfg);
            if (!Object.keys(activeCols).length) {
                alert('Нет сетапов. Выполни скрипт через Code Panel.'); return;
            }

            // Строим список тикеров и таймфреймов
            const activeTicker = window.app?.widget?.activeChart()?.symbol?.() || '';
            const activeTable  = window.app?.currentTable || 'market_data_3min';
            const dateRange    = { from: cfg.fromDate, to: cfg.toDate };

            // Тикеры: активный + дополнительные из textarea
            const extraTickers = SB.multiTickers.filter(t => t && t !== activeTicker);
            const tickers = [activeTicker, ...extraTickers];

            // Таймфреймы: активный + выбранные чекбоксы
            const extraTFs = SB.multiTimeframes.filter(t => t && t !== activeTable);
            const tables   = [activeTable, ...extraTFs];

            const total = tickers.length * tables.length;
            SB.btRunning  = true;
            SB.btProgress = 0;
            SB.btMessage  = `0/${total} готово`;
            SB.trades     = [];
            SB.tickerFilter = 'all';
            SB.tfFilter     = 'all';
            renderBacktestTab(container);

            const allTrades = [];
            let done = 0;

            for (const ticker of tickers) {
                for (const table of tables) {
                    try {
                        SB.btMessage = `${ticker} @ ${table.replace('market_data_','')} …`;
                        renderBacktestTab(container);

                        const result = await runBacktestServer(ticker, table, cfg, activeCols, dateRange, container, false);

                        if (result?.trades?.length) {
                            result.trades.forEach(t => {
                                t.ticker    = ticker;
                                t.timeframe = table;
                            });
                            allTrades.push(...result.trades);
                        }

                        // Логи скрипта в консоль
                        if (result?.scriptLogs?.length) {
                            console.group(`[Server BT] ${ticker} @ ${table.replace('market_data_','')}`);
                            result.scriptLogs.forEach(entry => {
                                if (Array.isArray(entry)) {
                                    const [lvl, msg] = entry;
                                    if (lvl==='error') console.error(msg);
                                    else if (lvl==='warn') console.warn(msg);
                                    else console.log(msg);
                                } else console.log(entry);
                            });
                            console.groupEnd();
                        }
                    } catch(e) {
                        console.error(`[Server BT] ${ticker} @ ${table} FAILED:`, e.message);
                    }
                    done++;
                    SB.btProgress = Math.round(done / total * 100);
                    SB.btMessage  = `${done}/${total} готово`;
                    renderBacktestTab(container);
                }
            }

            SB.trades     = allTrades;
            SB.btRunning  = false;
            SB.btProgress = 100;
            SB.btMessage  = `✅ ${allTrades.length} сделок из ${total} комбинаций`;
            renderBacktestTab(container);
        });


        container.querySelectorAll('.sb-trow').forEach(r =>
            r.addEventListener('click', () => { SB.detailTrade=SB.trades[+r.dataset.idx]; renderBacktestTab(container); }));
        get('sb-mclose')?.addEventListener('click', () => { SB.detailTrade=null; renderBacktestTab(container); });
        container.querySelectorAll('.sb-jump').forEach(b =>
            b.addEventListener('click', e => { e.stopPropagation(); gotoBar(+b.dataset.ts); }));
    }

    // ════════════════════════════════════════════════════════════════
    // DATE RANGE LOADER
    // ════════════════════════════════════════════════════════════════

    async function loadDateRange(container) {
        const ticker = window.app?._currentTicker;
        const table  = window.app?._currentTable;
        if (!ticker || !table) {
            alert('Откройте график инструмента чтобы загрузить диапазон дат.');
            return;
        }
        SB.dateRangeLoading = true;
        SB.dateRangeMeta    = null;
        renderBacktestTab(container);

        try {
            const resp = await fetch(
                `/api/backtest/date-range?ticker=${encodeURIComponent(ticker)}&table=${encodeURIComponent(table)}`,
                { credentials: 'include' }
            );
            if (!resp.ok) { const e = await resp.json(); throw new Error(e.error || resp.status); }

            const data = await resp.json();
            const minDate = new Date(data.min);
            const maxDate = new Date(data.max);
            const fmt = d => d.toISOString().slice(0, 10);

            SB.dateRangeMeta = {
                minDate:      fmt(minDate),
                maxDate:      fmt(maxDate),
                minFormatted: fmt(minDate),
                maxFormatted: fmt(maxDate),
                totalRows:    data.totalRows,
                totalRowsFmt: data.totalRows > 1e6
                    ? (data.totalRows / 1e6).toFixed(1) + 'M'
                    : data.totalRows > 1e3
                        ? (data.totalRows / 1e3).toFixed(0) + 'K'
                        : String(data.totalRows),
            };

            if (!SB.dateRange.from) SB.dateRange.from = fmt(minDate);
            if (!SB.dateRange.to)   SB.dateRange.to   = fmt(maxDate);

        } catch (err) {
            console.error('[DateRange] Error:', err);
            alert('Ошибка загрузки диапазона дат: ' + err.message);
        }

        SB.dateRangeLoading = false;
        renderBacktestTab(container);
    }

    // ════════════════════════════════════════════════════════════════
    // SERVER BACKTEST — запускает бектест на сервере
    // ════════════════════════════════════════════════════════════════

    async function runBacktestServer(ticker, table, cfg, activeCols, dateRange, container, applyToState = true) {
        let pulseInterval = null;
        try {
            // Формируем setupCols в формат который ожидает сервер
            const setupCols = {};
            for (const [name, def] of Object.entries(activeCols)) {
                setupCols[name] = {
                    column:          def.column || name,
                    dir:             def.dir || (cfg.direction !== 'both' ? cfg.direction : 'long'),
                    exitRules:       def.exitRules || [],
                    clickhouse_expr: def.clickhouse_expr || undefined,
                    ...(def.scriptId   ? { scriptId:   def.scriptId   } : {}),
                    ...(def.scriptCode ? { scriptCode: def.scriptCode } : {}),
                    ...(def.dirColumn  ? { dirColumn:  def.dirColumn  } : {}),
                    ...(def.entryCol   ? { entryCol:   def.entryCol   } : {}),
                    ...(def.slCol      ? { slCol:      def.slCol      } : {}),
                    ...(def.tpCol      ? { tpCol:      def.tpCol      } : {}),
                };
            }

            // Show appropriate message if script execution is involved
            const hasScript = Object.values(setupCols).some(d => d.scriptId);
            if (hasScript) {
                SB.btMessage = '⚙ Загрузка данных + запуск JS-скрипта на сервере…';
                renderBacktestTab(container);
            }

            const body = {
                ticker, table,
                fromDate:   dateRange.from || undefined,
                toDate:     dateRange.to   || undefined,
                capital:    cfg.capital,
                riskPct:    cfg.riskPct,
                leverage:   cfg.leverage,
                slMode:     cfg.slMode,
                slValue:    cfg.slValue,
                tpMode:     cfg.tpMode,
                tpValue:    cfg.tpValue,
                maxBars:    cfg.maxBars,
                direction:  cfg.direction,
                useColExit: cfg.useColExit,
                setupCols,
            };

            // Диагностика: проверяем есть ли scriptId
            for (const [name, def] of Object.entries(setupCols)) {
                if (def.scriptId) {
                    console.log(`[Server BT] Setup "${name}" has scriptId=${def.scriptId} ✓`);
                } else {
                    console.warn(`[Server BT] Setup "${name}" has NO scriptId — сигналы будут пустыми!`);
                }
            }
            console.log('[Server BT] Starting:', body);

            // Пульсирующий прогресс пока сервер работает
            const intervalId = setInterval(() => {
                if (!SB.btRunning) { clearInterval(intervalId); return; }
                if (SB.btProgress < 90) SB.btProgress += 2;
                renderBacktestTab(container);
            }, 500);
            pulseInterval = intervalId;

            const resp = await fetch('/api/backtest/run', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(body),
            });

            if (!resp.ok) {
                const e = await resp.json().catch(() => ({}));
                throw new Error(e.error || `HTTP ${resp.status}`);
            }

            const result = await resp.json();
            console.log('[Server BT] Done:', result.barsProcessed, 'bars,', result.trades.length, 'trades');

            // Сохраняем глобально — для AI Chat и других модулей
            window._lastBacktestResult = {
                trades:   result.trades,
                stats:    result.stats,
                meta:     result.meta,
                ticker:   body.ticker,
                table:    body.table,
                fromDate: body.fromDate,
                toDate:   body.toDate,
            };
            window._lastBacktestTrades = result.trades; // обратная совместимость

            if (applyToState) {
                SB.trades = result.trades;
                SB.btRunning  = false;
                SB.btProgress = 100;
                SB.btMessage  = `Done: ${(result.barsProcessed || 0).toLocaleString()} bars`;
            }

            // Display script execution logs in browser console
            if (result.scriptLogs && result.scriptLogs.length) {
                console.group('[Server BT] Script execution logs:');
                result.scriptLogs.forEach(entry => {
                    if (Array.isArray(entry)) {
                        const [lvl, msg] = entry;
                        if (lvl === 'error') console.error(msg);
                        else if (lvl === 'warn') console.warn(msg);
                        else console.log(msg);
                    } else {
                        console.log(entry);
                    }
                });
                console.groupEnd();
            }
            if (applyToState) {
                renderBacktestTab(container);
            }
            return result

        } catch (err) {
            clearInterval(pulseInterval);
            console.error('[Server BT] Error:', err);
            alert('Ошибка серверного бектеста: ' + err.message);
            SB.btRunning = false;
            SB.btMessage = '';
            renderBacktestTab(container);
        }
    }

    // ════════════════════════════════════════════════════════════════
    // TAB INJECTION
    // ════════════════════════════════════════════════════════════════

    function inject() {
        const timer = setInterval(() => {
            const panel = document.getElementById('dt-panel');
            if (!panel) return;
            clearInterval(timer);
            buildTabs(panel);
            hookReplay();
            injectCSS();
        }, 300);
    }

    function buildTabs(panel) {
        if (document.getElementById('sb-tabbar')) return;

        const tabbar = document.createElement('div');
        tabbar.id = 'sb-tabbar';
        tabbar.innerHTML = `
            <button class="sb-tab sb-tab-data  sb-tab-active" data-tab="data">📋 Data</button>
            <button class="sb-tab sb-tab-setup"               data-tab="setups">📐 Setups</button>
            <button class="sb-tab sb-tab-bt"                  data-tab="backtest">📊 Backtest</button>`;

        const twrap = panel.querySelector('#dt-twrap');
        const sbBody = document.createElement('div');
        sbBody.id = 'sb-tab-body';
        Object.assign(sbBody.style, { display:'none', flexDirection:'column', flex:'1', overflow:'hidden', position:'relative' });

        if (twrap) { panel.insertBefore(tabbar, twrap); panel.insertBefore(sbBody, twrap); }

        tabbar.querySelectorAll('.sb-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                tabbar.querySelectorAll('.sb-tab').forEach(b => b.classList.remove('sb-tab-active'));
                btn.classList.add('sb-tab-active');
                const tab = btn.dataset.tab;
                if (twrap) twrap.style.display = tab === 'data' ? '' : 'none';
                sbBody.style.display = tab !== 'data' ? 'flex' : 'none';
                if (tab === 'setups')   { SB.signalPage=0; renderSetupsTab(sbBody); }
                if (tab === 'backtest') renderBacktestTab(sbBody);
            });
        });

        window.setupsBacktest = {
            refresh: () => {
                const a = document.querySelector('.sb-tab.sb-tab-active');
                const b = document.getElementById('sb-tab-body');
                if (!a || !b) return;
                const t = a.dataset?.tab;
                if (t === 'setups')   renderSetupsTab(b);
                if (t === 'backtest') renderBacktestTab(b);
            }
        };
    }
    
    // ════════════════════════════════════════════════════════════════
    // CSS
    // ════════════════════════════════════════════════════════════════

    function injectCSS() {
        if (document.getElementById('sb-css')) return;
        const s = document.createElement('style');
        s.id = 'sb-css';
        s.textContent = `
/* ── Tabs ── */
#sb-tabbar{display:flex;align-items:center;background:#080a12;border-bottom:2px solid #181b28;flex-shrink:0;padding:0 6px}
.sb-tab{padding:6px 13px;background:transparent;border:none;border-bottom:2px solid transparent;margin-bottom:-2px;color:#d1d4dc;font-size:11px;font-weight:700;letter-spacing:.4px;cursor:pointer;white-space:nowrap;text-transform:uppercase;transition:color .12s,border-color .12s}
.sb-tab:hover{color:#5a6080}
.sb-tab-data.sb-tab-active{color:#d1d4dc;border-bottom-color:#d1d4dc}
.sb-tab-setup.sb-tab-active{color:#f5a623;border-bottom-color:#f5a623}
.sb-tab-bt.sb-tab-active{color:#4caf50;border-bottom-color:#4caf50}
#sb-tab-body{background:#080a12}

/* ── Common ── */
.sb-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:5px 10px;background:#080a12;border-bottom:1px solid #141826;flex-shrink:0}
.sb-flex1{flex:1;min-width:0}
.sb-title{font-size:12px;font-weight:700;color:#d1d4dc}
.sb-cnt{font-size:11px;color:#d1d4dc}
.sb-warn{font-size:11px;color:#f5a623;padding:2px 6px;border:1px solid #f5a62333;border-radius:3px}
.sb-warn-sm{font-size:10px;color:#f5a623;padding:2px 0}
.sb-hint{font-size:11px;color:#f5a62388}
.sb-btn{padding:3px 9px;background:#0f1220;border:1px solid #1a1e30;border-radius:3px;color:#6a7090;font-size:11px;cursor:pointer;white-space:nowrap;transition:border-color .12s,color .12s}
.sb-btn:hover{border-color:#3040a0;color:#d1d4dc}
.sb-btn-run{background:#0a1c0f;border-color:#4caf50;color:#4caf50;font-weight:700}
.sb-btn-run:hover{background:#122518}
.sb-btn-srv{background:#0d1a2e;border-color:#2962FF;color:#2962FF;font-weight:700;font-size:10px}
.sb-btn-srv:hover{background:#111f3a}
.sb-cfg-hint{font-size:9px;color:#666;font-weight:400;margin-left:4px}
.sb-dr-loading{font-size:10px;color:#888;padding:4px 0;font-style:italic}
.sb-dr-avail{font-size:10px;color:#aaa;padding:3px 0 5px;line-height:1.5}
.sb-dr-avail b{color:#e0e0e0}
.sb-dr-rows{display:block;font-size:9px;color:#666;margin-top:2px}
.sb-date-inp{padding:4px 6px !important;font-size:11px !important;color-scheme:dark;width:100%;box-sizing:border-box}
.sb-date-inp::-webkit-calendar-picker-indicator{filter:invert(0.7)}
.sb-btn-dr{font-size:10px;padding:4px 8px;background:#1a1f2a;border-color:#444;color:#aaa;width:100%;text-align:center;margin-top:4px}
.sb-btn-dr:hover{background:#222a36;color:#ddd}
.sb-btn-reg{border-color:#2962FF44;color:#2962FF88}
.sb-btn-reg:hover{border-color:#2962FF;color:#2962FF;background:#0a1230}
.sb-btn-ok{background:#0a1c0f;border-color:#4caf50;color:#4caf50}
.sb-sel{background:#080a12;border:1px solid #1a1e30;border-radius:3px;color:#d1d4dc;font-size:11px;padding:2px 5px;cursor:pointer}
.sb-inp{background:#080a12;border:1px solid #1a1e30;border-radius:3px;color:#d1d4dc;font-size:11px;padding:2px 6px;width:90px}
.sb-inp-w{width:100%;box-sizing:border-box}
.sb-inp-sm{width:52px}
.sb-inp-xs{width:44px}
.sb-inp:focus,.sb-sel:focus{outline:none;border-color:#2962FF}
.sb-lbl{font-size:10px;color:#3a4060;margin-top:2px}
.sb-mono{font-size:10px;color:#d1d4dc;font-family:monospace;margin-left:3px}
.sb-live-tag{font-size:10px;font-weight:700;color:#ef5350;padding:1px 5px;border:1px solid #ef535044;border-radius:3px;animation:sb-blink 1.4s infinite}
@keyframes sb-blink{50%{opacity:.35}}
.sb-pbar{width:80px;height:4px;background:#1a1e30;border-radius:2px;overflow:hidden}
.sb-pfill{height:100%;background:#2962FF;transition:width .2s}
.sb-pager{display:flex;align-items:center;gap:6px;padding:3px 10px;font-size:11px;color:#3a4060;border-bottom:1px solid #141826;flex-shrink:0}
.sb-pgbtn{padding:1px 8px;background:#0f1220;border:1px solid #1a1e30;border-radius:3px;color:#9598a1;cursor:pointer;font-size:12px}
.sb-pgbtn:hover:not([disabled]){border-color:#2962FF;color:#2962FF}
.sb-pgbtn[disabled]{opacity:.3;cursor:default}

/* ── Table ── */
.sb-scroll{flex:1;overflow:auto}
.sb-tbl{width:100%;border-collapse:collapse;font-size:11px}
.sb-tbl th{position:sticky;top:0;z-index:2;background:#0c0e1a;color:#d1d4dc;font-weight:700;text-transform:uppercase;letter-spacing:.3px;padding:4px 8px;text-align:left;white-space:nowrap;border-bottom:1px solid #1a1e30}
.sb-tbl td{padding:3px 8px;border-bottom:1px solid #0c0e1a80;color:#8a90a8}
.sb-tbl tbody tr:hover td{background:#141826}
.sb-sig-row{cursor:pointer}
.sb-st1 td{border-left:2px solid #2962FF44}
.sb-st2 td{border-left:2px solid #f5a62344}
.sb-st3 td{border-left:2px solid #4caf5044}
.sb-st4 td{border-left:2px solid #ef535044}
.sb-st{display:inline-block;padding:1px 5px;border-radius:2px;font-size:10px;font-weight:700}
.sb-st-entry{background:#2962FF22;color:#2962FF;border:1px solid #2962FF44}
.sb-st-hold{background:#f5a62322;color:#f5a623;border:1px solid #f5a62344}
.sb-st-exit{background:#4caf5022;color:#4caf50;border:1px solid #4caf5044}
.sb-badge{display:inline-block;padding:1px 5px;border-radius:3px;background:#0f1220;border:1px solid #1a1e30;font-size:10px;color:#6a7090}
.sb-dir{display:inline-block;font-size:10px;font-weight:700;padding:1px 5px;border-radius:2px}
.sb-dir-long{background:#0a1c0f;color:#4caf50;border:1px solid #4caf5044}
.sb-dir-short{background:#1c0a0f;color:#ef5350;border:1px solid #ef535044}
.sb-goto,.sb-jump{padding:1px 6px;background:transparent;border:1px solid #1a1e30;border-radius:2px;color:#d1d4dc;font-size:11px;cursor:pointer}
.sb-goto:hover,.sb-jump:hover{border-color:#2962FF;color:#2962FF}
.sb-empty{text-align:center;padding:24px;color:#d1d4dc;font-size:12px;font-style:italic}

/* ── Backtest layout ── */
.sb-layout{display:flex;flex:1;overflow:hidden}
.sb-cfg{width:188px;flex-shrink:0;overflow-y:auto;padding:8px 10px;border-right:1px solid #141826;background:#060810;display:flex;flex-direction:column;gap:3px}
.sb-cfg-h{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#d1d4dc;margin-top:8px;padding-top:6px;border-top:1px solid #14182680}
.sb-cfg-h:first-child{border-top:none;margin-top:0}
.sb-cfg-row{display:flex;gap:4px;align-items:center}
.sb-cfg-lbl{font-size:10px;color:#d1d4dc;margin-top:2px}
.sb-chklbl{display:flex;align-items:center;gap:4px;cursor:pointer}
.sb-chkn{font-size:11px;color:#8a90a8}
.sb-chklbl input[type=checkbox]{accent-color:#2962FF}
.sb-results{flex:1;overflow:auto;display:flex;flex-direction:column}

/* ── Stats ── */
.sb-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:1px;background:#1a1e30;border-bottom:1px solid #1a1e30;flex-shrink:0}
.sb-scard{background:#080a12;padding:7px 10px;display:flex;flex-direction:column;gap:2px}
.sb-slbl{font-size:9px;color:#d1d4dc;text-transform:uppercase;letter-spacing:.4px}
.sb-sval{font-size:13px;font-weight:700;color:#d1d4dc;font-variant-numeric:tabular-nums}
.sb-empty-big{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#d1d4dc;font-size:12px;gap:6px}
.sb-empty-ico{font-size:40px;opacity:.2}

/* ── Breakdown ── */
.sb-breakdown{display:flex;flex-shrink:0;border-bottom:1px solid #141826}
.sb-bksect{flex:1;padding:8px 10px;border-right:1px solid #141826}
.sb-bksect:last-child{border-right:none}
.sb-bkh{font-size:9px;font-weight:700;text-transform:uppercase;color:#d1d4dc;margin-bottom:4px}
.sb-bkrow{display:flex;align-items:center;gap:8px;padding:2px 0;font-size:11px;color:#8a90a8;border-bottom:1px solid #14182840}
.sb-xtag{font-size:10px;font-weight:700;padding:1px 5px;border-radius:2px}
.sb-x-tp{color:#4caf50;background:#4caf5022}.sb-x-sl{color:#ef5350;background:#ef535022}
.sb-x-timeout,.sb-x-to{color:#f5a623;background:#f5a62322}

/* ── Journal ── */
.sb-jtoolbar{display:flex;align-items:center;gap:6px;padding:4px 8px;border-bottom:1px solid #141826;flex-shrink:0;background:#080a12}
.sb-jt{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#d1d4dc}
.sb-trow{cursor:pointer}
.sb-win:hover td{background:#4caf5008!important}
.sb-loss:hover td{background:#ef53500a!important}
.sb-pos{color:#4caf50;font-weight:700}
.sb-neg{color:#ef5350;font-weight:700}
.sb-slc{color:#ef535066}
.sb-tpc{color:#4caf5066}

/* ── Open trade ── */
.sb-open{display:flex;align-items:center;gap:8px;padding:5px 10px;background:#1c120022;border-top:1px solid #f5a62333;font-size:11px;color:#8a90a8;flex-shrink:0;flex-wrap:wrap}
.sb-open b{color:#d1d4dc}

/* ── Modal ── */
.sb-modal{position:absolute;inset:0;background:#000d;display:flex;align-items:center;justify-content:center;z-index:100}
.sb-modal-box{background:#0c0e1a;border:1px solid #2a2e44;border-radius:8px;width:380px;max-width:90%;max-height:80%;overflow-y:auto;box-shadow:0 16px 60px #000b}
.sb-mhdr{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #1a1e30;font-size:12px;font-weight:700;color:#d1d4dc;position:sticky;top:0;background:#0c0e1a}
.sb-mhdr button{background:transparent;border:none;color:#3a4060;cursor:pointer;font-size:15px}
.sb-mhdr button:hover{color:#ef5350}
.sb-mbody{padding:12px;display:flex;flex-direction:column;gap:1px}
.sb-dr{display:flex;justify-content:space-between;align-items:center;padding:4px 6px;background:#0a0c1680}
.sb-dr:nth-child(even){background:#0d101a80}
.sb-dl{font-size:10px;color:#d1d4dc;text-transform:uppercase;letter-spacing:.3px}
.sb-dr b{font-size:11px;color:#d1d4dc;font-weight:600}
.sb-mact{display:flex;gap:6px;margin-top:8px}

/* ── Floating draggable dialog ── */
.sb-float-dlg{position:fixed;z-index:100000;background:#0c0e1c;border:1px solid #2a2e50;border-radius:10px;box-shadow:0 20px 70px rgba(0,0,0,.85),0 0 0 1px #ffffff08;min-width:340px;max-width:440px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow:hidden;display:flex;flex-direction:column}
.sb-float-hdr{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:linear-gradient(135deg,#141830 0%,#0e1228 100%);border-bottom:1px solid #1e2240;font-size:13px;font-weight:700;color:#d1d4dc;user-select:none;cursor:grab}
.sb-float-hdr:active{cursor:grabbing}
.sb-float-close{background:transparent;border:none;color:#3a4060;cursor:pointer;font-size:16px;line-height:1;padding:0 2px;transition:color .12s}
.sb-float-close:hover{color:#ef5350}
.sb-float-body{padding:16px;display:flex;flex-direction:column;gap:8px;overflow-y:auto;flex:1;min-height:0}
.sb-float-body .sb-lbl{font-size:10px;color:#4a5080;text-transform:uppercase;letter-spacing:.4px;margin-top:4px}
.sb-lbl-hint{font-size:10px;color:#2e3255;text-transform:none;letter-spacing:0}
.sb-rule-hint{font-size:10px;color:#3a4260;line-height:1.5;padding:6px 8px;background:#080a14;border-radius:4px;border:1px solid #141828}
.sb-float-body .sb-inp,.sb-float-body .sb-sel{background:#080a14;border:1px solid #1a1e34;border-radius:4px;color:#d1d4dc;font-size:12px;padding:5px 8px;transition:border-color .12s}
.sb-float-body .sb-inp:focus,.sb-float-body .sb-sel:focus{outline:none;border-color:#2962FF}
.sb-inp-flex{flex:1;min-width:0}
.sb-sel-w{width:100%;box-sizing:border-box}
#sb-rule-wrap{display:flex;flex-direction:column;gap:5px}
.sb-rule{display:flex;align-items:center;gap:5px}
.sb-rule-ico{font-size:10px;color:#3a4060;white-space:nowrap;flex-shrink:0}
.sb-rule-del{background:transparent;border:1px solid #2a1818;border-radius:3px;color:#5a3030;cursor:pointer;font-size:11px;padding:2px 5px;flex-shrink:0;transition:color .12s,border-color .12s}
.sb-rule-del:hover{color:#ef5350;border-color:#ef535055}
.sb-btn-add-rule{align-self:flex-start;font-size:11px;border-color:#2962FF33;color:#2962FF88}
.sb-btn-add-rule:hover{border-color:#2962FF;color:#2962FF;background:#0a1230}
.sb-float-foot{display:flex;gap:8px;justify-content:flex-end;padding-top:8px;border-top:1px solid #1a1e34;margin-top:4px}
.sb-float-foot .sb-btn-ok{background:#0a1c0f;border-color:#4caf50;color:#4caf50;font-weight:700;padding:5px 14px}
.sb-float-foot .sb-btn-ok:hover{background:#122518}
.sb-float-foot .sb-btn{padding:5px 12px}

/* Light theme */
body.light-theme #sb-tabbar,body.light-theme .sb-toolbar{background:#f0f3fa}
body.light-theme .sb-cfg{background:#e8ebf5;border-right-color:#d0d3db}
body.light-theme .sb-tbl th{background:#e0e3ef;color:#787b90}
body.light-theme .sb-tbl td{color:#555;border-bottom-color:#e0e3ef80}
body.light-theme .sb-scard{background:#f8f9fd}
body.light-theme .sb-stats{background:#d0d3db}
body.light-theme .sb-modal-box,body.light-theme .sb-dlg-box{background:#fff;border-color:#d0d3db}
body.light-theme .sb-inp,body.light-theme .sb-sel{background:#fff;border-color:#d0d3db;color:#131722}
`;
        document.head.appendChild(s);
    }

    // ════════════════════════════════════════════════════════════════
    // START
    // ════════════════════════════════════════════════════════════════

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
    else inject();

    // Экспортируем состояние для внешнего доступа (например, datafeed сбрасывает дату)
    window._sbState = SB;

    // Экспорт для Walk-Forward / Monte Carlo
    window.SB_TRADES = () => SB.trades || [];
    
    window.SB_CFG = () => {
        const ticker = window.app?._currentTicker;
        const table  = window.app?._currentTable;
    
        // Строим setupCols точно так же как runBacktestServer
        const activeCols = getActiveCols(SB.cfg);
        const setupCols  = {};
        for (const [name, def] of Object.entries(activeCols)) {
            setupCols[name] = {
                column:    def.column    || name,
                dir:       def.dir       || (SB.cfg.direction !== 'both' ? SB.cfg.direction : 'long'),
                exitRules: def.exitRules || [],
                ...(def.scriptId   ? { scriptId:   def.scriptId   } : {}),
                ...(def.scriptCode ? { scriptCode: def.scriptCode } : {}),
                ...(def.dirColumn  ? { dirColumn:  def.dirColumn  } : {}),
                ...(def.entryCol   ? { entryCol:   def.entryCol   } : {}),
                ...(def.slCol      ? { slCol:      def.slCol      } : {}),
                ...(def.tpCol      ? { tpCol:      def.tpCol      } : {}),
            };
        }
    
        return {
            ticker,
            table,
            capital:    SB.cfg.capital    || 10000,
            riskPct:    SB.cfg.riskPct    || 1,
            leverage:   SB.cfg.leverage   || 1,
            slMode:     SB.cfg.slMode     || 'pct',
            slValue:    SB.cfg.slValue    || 1,
            tpMode:     SB.cfg.tpMode     || 'rr',
            tpValue:    SB.cfg.tpValue    || 2,
            maxBars:    SB.cfg.maxBars    || 50,
            direction:  SB.cfg.direction  || 'both',
            useColExit: SB.cfg.useColExit !== false,
            fromDate:   SB.dateRange?.from || null,
            toDate:     SB.dateRange?.to   || null,
            setupCols,
        };
    };

})(); }