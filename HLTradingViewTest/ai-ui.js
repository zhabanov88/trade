/**
 * ai-ui.js  v1.0
 *
 * UI для AI/ML слоя: Bayesian Optimization + Market Regime Classifier
 * Встраивается в #sb-tabbar как 5-я вкладка "🧠 AI"
 *
 * Подключение в index.html ПОСЛЕ walkforward-ui.js:
 *   <script src="ai-ui.js"></script>
 *
 * Требует:
 *   — setups-backtest.js (window.SB_CFG, window.SB_TRADES)
 *   — Chart.js 4.x (подгружается автоматически)
 */

if (window._aiLoaded) {} else { window._aiLoaded = true; (function () {
    'use strict';
    
    // ════════════════════════════════════════════════════════════════
    // STATE
    // ════════════════════════════════════════════════════════════════
    
    const AI = {
        tab: 'optimize',     // optimize | regime
        optRunning:  false,
        optResult:   null,
        regRunning:  false,
        regResult:   null,
        regAnalysis: null,
        progress: 0, progressMsg: '',
        cfg: loadCfg(),
        charts: {},
    };
    
    function loadCfg() {
        try { return Object.assign(defCfg(), JSON.parse(localStorage.getItem('ai_cfg') || '{}')); }
        catch(_) { return defCfg(); }
    }
    function defCfg() {
        return {
            sl_min: 0.3, sl_max: 3.0, sl_on: true,
            tp_min: 1.0, tp_max: 5.0, tp_on: true,
            risk_min: 0.5, risk_max: 2.5, risk_on: false,
            initPoints: 8, maxIter: 40,
            windowSize: 50, stepSize: 10,
        };
    }
    function saveCfg() { try { localStorage.setItem('ai_cfg', JSON.stringify(AI.cfg)); } catch(_) {} }
    
    // ════════════════════════════════════════════════════════════════
    // HELPERS
    // ════════════════════════════════════════════════════════════════
    
    function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    function fmtPct(v, digits=1) { const n=parseFloat(v); if(isNaN(n)) return '—'; return `<span class="${n>=0?'ai-pos':'ai-neg'}">${n>=0?'+':''}${n.toFixed(digits)}%</span>`; }
    function fmtMoney(v) { const n=parseFloat(v); if(isNaN(n)) return '—'; return `<span class="${n>=0?'ai-pos':'ai-neg'}">${n>=0?'+':''}$${Math.abs(n).toFixed(0)}</span>`; }
    
    const REGIME_META = {
        trending_up:   { icon: '📈', label: 'Trending Up',   color: '#4caf50', bg: 'rgba(76,175,80,.12)' },
        trending_down: { icon: '📉', label: 'Trending Down', color: '#ef5350', bg: 'rgba(239,83,80,.12)' },
        ranging:       { icon: '↔️',  label: 'Ranging',       color: '#ff9800', bg: 'rgba(255,152,0,.12)' },
        volatile:      { icon: '⚡',  label: 'Volatile',      color: '#9c27b0', bg: 'rgba(156,39,176,.12)' },
        neutral:       { icon: '➡️',  label: 'Neutral',       color: '#607d8b', bg: 'rgba(96,125,139,.12)' },
        unknown:       { icon: '❓',  label: 'Unknown',       color: '#444c70', bg: 'rgba(68,76,112,.12)' },
    };
    function rm(r) { return REGIME_META[r] || REGIME_META.unknown; }
    
    function getBTCfg() { return window.SB_CFG ? window.SB_CFG() : {}; }
    function getTrades() { return window.SB_TRADES ? window.SB_TRADES() : []; }
    
    // ════════════════════════════════════════════════════════════════
    // TAB INJECTION
    // ════════════════════════════════════════════════════════════════
    
    function injectTab() {
        const timer = setInterval(() => {
            const tabbar = document.getElementById('sb-tabbar');
            const body   = document.getElementById('sb-tab-body');
            if (!tabbar || !body) return;
            clearInterval(timer);
            if (document.getElementById('sb-tab-ai')) return;
    
            injectCSS();
    
            const btn = document.createElement('button');
            btn.id = 'sb-tab-ai'; btn.className = 'sb-tab sb-tab-ai'; btn.dataset.tab = 'ai'; btn.textContent = '🧠 AI';
            tabbar.appendChild(btn);
    
            btn.addEventListener('click', () => {
                const twrap = document.getElementById('dt-twrap');
                tabbar.querySelectorAll('.sb-tab').forEach(b => b.classList.remove('sb-tab-active'));
                btn.classList.add('sb-tab-active');
                if (twrap) twrap.style.display = 'none';
                body.style.display = 'flex';
                renderAIPanel(body);
            });
        }, 250);
    }
    
    // ════════════════════════════════════════════════════════════════
    // RENDER
    // ════════════════════════════════════════════════════════════════
    
    function renderAIPanel(body) {
        Object.values(AI.charts).forEach(c => { try{c.destroy();}catch(_){} }); AI.charts = {};
        body.innerHTML = `<div class="ai-root"><div class="ai-sidebar" id="ai-sidebar">${renderSidebar()}</div><div class="ai-main" id="ai-main">${renderMain()}</div></div>`;
        bindEvents(body);
        setTimeout(() => drawCharts(), 80);
    }
    
    // ── SIDEBAR ────────────────────────────────────────────────────
    
    function renderSidebar() {
        const c = AI.cfg;
        const isOpt = AI.tab === 'optimize';
        const isReg = AI.tab === 'regime';
    
        return `
        <div class="ai-logo">🧠 AI Layer</div>
    
        <div class="ai-tabs-vert">
            <button class="ai-vtab ${isOpt?'ai-vtab-a':''}" data-aitab="optimize">⚡ Bayesian Opt</button>
            <button class="ai-vtab ${isReg?'ai-vtab-a':''}" data-aitab="regime">🌊 Market Regime</button>
        </div>
    
        ${isOpt ? `
        <div class="ai-sb-sect">
            <div class="ai-sb-h">Parameter Space</div>
    
            <label class="ai-sb-chk"><input type="checkbox" id="ai-sl-on" ${c.sl_on?'checked':''}> Stop Loss</label>
            <div class="ai-range-row ${c.sl_on?'':'ai-dim'}" id="ai-sl-row">
                <input class="ai-sb-inp" id="ai-sl-min" type="number" step="0.1" value="${c.sl_min}" placeholder="min">
                <span class="ai-dash">–</span>
                <input class="ai-sb-inp" id="ai-sl-max" type="number" step="0.1" value="${c.sl_max}" placeholder="max">
            </div>
    
            <label class="ai-sb-chk"><input type="checkbox" id="ai-tp-on" ${c.tp_on?'checked':''}> Take Profit</label>
            <div class="ai-range-row ${c.tp_on?'':'ai-dim'}" id="ai-tp-row">
                <input class="ai-sb-inp" id="ai-tp-min" type="number" step="0.1" value="${c.tp_min}" placeholder="min">
                <span class="ai-dash">–</span>
                <input class="ai-sb-inp" id="ai-tp-max" type="number" step="0.1" value="${c.tp_max}" placeholder="max">
            </div>
    
            <label class="ai-sb-chk"><input type="checkbox" id="ai-risk-on" ${c.risk_on?'checked':''}> Risk %</label>
            <div class="ai-range-row ${c.risk_on?'':'ai-dim'}" id="ai-risk-row">
                <input class="ai-sb-inp" id="ai-risk-min" type="number" step="0.1" value="${c.risk_min}" placeholder="min">
                <span class="ai-dash">–</span>
                <input class="ai-sb-inp" id="ai-risk-max" type="number" step="0.1" value="${c.risk_max}" placeholder="max">
            </div>
    
            <div class="ai-sb-h" style="margin-top:10px">Iterations</div>
            <div class="ai-sb-row"><span class="ai-sb-lbl">Init random</span><input class="ai-sb-inp ai-sb-inp-sm" id="ai-init-pts" type="number" min="4" max="20" value="${c.initPoints}"></div>
            <div class="ai-sb-row"><span class="ai-sb-lbl">BO iters</span><input class="ai-sb-inp ai-sb-inp-sm" id="ai-max-iter" type="number" min="10" max="100" value="${c.maxIter}"></div>
    
            <button class="sb-btn sb-btn-srv ai-run-btn" id="ai-opt-btn" ${AI.optRunning?'disabled':''}>
                ${AI.optRunning ? '<span class="ai-spin"></span> Optimizing...' : '⚡ Run Bayesian Opt'}
            </button>
        </div>
        ` : `
        <div class="ai-sb-sect">
            <div class="ai-sb-h">Regime Settings</div>
            <div class="ai-sb-row"><span class="ai-sb-lbl">Window bars</span><input class="ai-sb-inp ai-sb-inp-sm" id="ai-win-size" type="number" min="20" max="200" value="${c.windowSize}"></div>
            <div class="ai-sb-row"><span class="ai-sb-lbl">Step bars</span><input class="ai-sb-inp ai-sb-inp-sm" id="ai-step-size" type="number" min="5" max="50" value="${c.stepSize}"></div>
            <div class="ai-hint">Smaller window = more sensitive detection</div>
    
            <button class="sb-btn sb-btn-srv ai-run-btn" id="ai-reg-btn" ${AI.regRunning?'disabled':''}>
                ${AI.regRunning ? '<span class="ai-spin"></span> Classifying...' : '🌊 Classify Regimes'}
            </button>
    
            ${AI.regResult ? `
            <div style="height:1px;background:#141826;margin:10px 0"></div>
            <button class="sb-btn sb-btn-run ai-run-btn" id="ai-reg-analysis-btn" ${AI.regRunning?'disabled':''}>
                📊 Analyze Setups
            </button>
            <div class="ai-hint">Uses current BT trades<br>to find which setup wins<br>in each market regime</div>
            ` : ''}
        </div>
        `}
    
        ${(AI.optRunning || AI.regRunning) ? `
        <div class="ai-sb-sect">
            <div class="ai-pbar"><div class="ai-pbar-fill" style="width:${AI.progress}%"></div></div>
            <div class="ai-pmsg">${esc(AI.progressMsg)}</div>
        </div>` : ''}`;
    }
    
    // ── MAIN ────────────────────────────────────────────────────────
    
    function renderMain() {
        if (AI.tab === 'optimize') return renderOptMain();
        if (AI.tab === 'regime')   return renderRegMain();
        return '';
    }
    
    // ── OPTIMIZE MAIN ──────────────────────────────────────────────
    
    function renderOptMain() {
        if (!AI.optResult) return `<div class="ai-empty">
            <div style="font-size:36px;opacity:.3">⚡</div>
            <div class="ai-empty-t">Bayesian Optimization</div>
            <div class="ai-empty-s">
                Finds optimal SL/TP/Risk parameters using Gaussian Process surrogate model.<br><br>
                Requires fewer evaluations than grid search:<br>
                <strong>8 random + 40 BO iterations = 48 backtests</strong><br>
                vs ~125+ combinations in grid search.<br><br>
                Make sure Server BT is configured in the Backtest tab.
            </div>
        </div>`;
    
        const r = AI.optResult;
        const s = r.bestStats;
    
        return `
        <div class="ai-block">
            <div class="ai-bh"><span class="ai-bt">⚡ Bayesian Optimization Result</span><span class="ai-bsub">${r.totalEvals} evaluations</span></div>
    
            <!-- Best Params -->
            <div class="ai-best-params">
                ${Object.entries(r.bestParams).map(([k, v]) => `
                <div class="ai-param-card">
                    <div class="ai-param-lbl">${k}</div>
                    <div class="ai-param-val">${v}</div>
                    <div class="ai-param-tag">optimal</div>
                </div>`).join('')}
                ${r.improvement !== null ? `
                <div class="ai-param-card ai-param-improve">
                    <div class="ai-param-lbl">vs baseline</div>
                    <div class="ai-param-val ai-pos">+${r.improvement}%</div>
                    <div class="ai-param-tag">improvement</div>
                </div>` : ''}
            </div>
    
            <!-- Stats of best run -->
            ${s ? `
            <div class="ai-sect-hdr">Performance with Optimal Parameters</div>
            <div class="ai-kpi5">
                ${kpi('Net PnL',     fmtMoney(s.totalPnl))}
                ${kpi('Return',      fmtPct(s.totalPnlPct))}
                ${kpi('Win Rate',    s.winRate+'%')}
                ${kpi('Profit F',    s.profitFactor)}
                ${kpi('Max DD',      `<span class="ai-neg">${s.maxDD}%</span>`)}
            </div>
            <div class="ai-kpi5">
                ${kpi('Trades',      s.total)}
                ${kpi('Avg Win',     fmtMoney(s.avgWin))}
                ${kpi('Avg Loss',    fmtMoney(s.avgLoss))}
                ${kpi('Expectancy',  fmtMoney(s.expectancy))}
                ${kpi('R:R',         s.rr)}
            </div>` : '<div class="ai-nodata">Not enough trades with optimal params.</div>'}
    
            <!-- Convergence Chart -->
            <div class="ai-sect-hdr">Score Convergence (by iteration)</div>
            <div class="ai-chart-wrap"><canvas id="ai-conv-chart"></canvas></div>
    
            <!-- History Table -->
            <div class="ai-sect-hdr">Top 10 Evaluated Points</div>
            <div class="ai-scroll-x">
            <table class="ai-tbl">
                <thead><tr><th>#</th><th>Type</th>${Object.keys(r.bestParams).map(k=>`<th>${k}</th>`).join('')}<th>Score</th></tr></thead>
                <tbody>
                ${r.history.slice().sort((a,b)=>b.score-a.score).slice(0,10).map((h,i) => `
                <tr class="${i===0?'ai-best':''}">
                    <td>${h.iteration+1}</td>
                    <td><span class="ai-badge ${h.type==='bayesian'?'ai-badge-bo':'ai-badge-rnd'}">${h.type==='bayesian'?'BO':'Rnd'}</span></td>
                    ${Object.keys(r.bestParams).map(k=>`<td>${h.params[k]}</td>`).join('')}
                    <td style="font-weight:700;color:${h.score>0?'#4caf50':'#ef5350'}">${h.score.toFixed(3)}</td>
                </tr>`).join('')}
                </tbody>
            </table>
            </div>
        </div>`;
    }
    
    // ── REGIME MAIN ────────────────────────────────────────────────
    
    function renderRegMain() {
        if (!AI.regResult && !AI.regAnalysis) return `<div class="ai-empty">
            <div style="font-size:36px;opacity:.3">🌊</div>
            <div class="ai-empty-t">Market Regime Classifier</div>
            <div class="ai-empty-s">
                Automatically identifies market conditions:<br><br>
                <span style="color:#4caf50">📈 Trending Up</span> — high ADX, positive slope<br>
                <span style="color:#ef5350">📉 Trending Down</span> — high ADX, negative slope<br>
                <span style="color:#ff9800">↔️ Ranging</span> — low ADX, tight Bollinger Bands<br>
                <span style="color:#9c27b0">⚡ Volatile</span> — high ATR, no clear direction<br><br>
                Then shows which setup performs best in each regime.
            </div>
        </div>`;
    
        return `
        ${AI.regResult ? renderRegimeOverview() : ''}
        ${AI.regAnalysis ? renderRegimeAnalysis() : ''}`;
    }
    
    function renderRegimeOverview() {
        const r = AI.regResult;
        const cur = rm(r.current);
    
        return `
        <div class="ai-block">
            <div class="ai-bh"><span class="ai-bt">🌊 Market Regime Analysis</span><span class="ai-bsub">${r.totalBars.toLocaleString()} bars · ${r.regimes.length} windows</span></div>
    
            <!-- Current Regime -->
            <div class="ai-cur-regime" style="border-color:${cur.color};background:${cur.bg}">
                <div class="ai-cur-ico">${cur.icon}</div>
                <div>
                    <div class="ai-cur-lbl">Current Market Regime</div>
                    <div class="ai-cur-val" style="color:${cur.color}">${cur.label}</div>
                    ${r.currentFeatures ? `<div class="ai-cur-feat">ADX ${r.currentFeatures.adx} · ATR% ${r.currentFeatures.atrPct} · BB Width ${r.currentFeatures.bbWidth} · R² ${r.currentFeatures.r2}</div>` : ''}
                </div>
            </div>
    
            <!-- Distribution -->
            <div class="ai-sect-hdr">Regime Distribution</div>
            <div class="ai-dist-grid">
                ${Object.entries(r.distribution).sort((a,b)=>b[1]-a[1]).map(([reg, pct]) => {
                    const m = rm(reg);
                    return `<div class="ai-dist-card">
                        <div class="ai-dist-ico">${m.icon}</div>
                        <div class="ai-dist-lbl">${m.label}</div>
                        <div class="ai-dist-pct" style="color:${m.color}">${pct}%</div>
                        <div class="ai-dist-bar-bg"><div class="ai-dist-bar" style="width:${pct}%;background:${m.color}"></div></div>
                    </div>`;
                }).join('')}
            </div>
    
            <!-- Regime Timeline Chart -->
            <div class="ai-sect-hdr">Regime Timeline</div>
            <div class="ai-chart-wrap"><canvas id="ai-reg-chart"></canvas></div>
    
            <!-- Windows Table -->
            <div class="ai-sect-hdr">Recent Windows</div>
            <div class="ai-scroll-x">
            <table class="ai-tbl">
                <thead><tr><th>Period</th><th>Regime</th><th>ADX</th><th>ATR%</th><th>BB Width</th><th>R²</th><th>Slope</th></tr></thead>
                <tbody>${r.regimes.slice(-12).reverse().map(w => {
                    const m = rm(w.regime);
                    const f = w.features;
                    return `<tr>
                        <td class="ai-mono">${fmtDate(w.startTs)}→${fmtDate(w.endTs)}</td>
                        <td><span class="ai-regime-tag" style="background:${m.bg};color:${m.color}">${m.icon} ${m.label}</span></td>
                        <td>${f?.adx ?? '—'}</td><td>${f?.atrPct ?? '—'}</td><td>${f?.bbWidth ?? '—'}</td><td>${f?.r2 ?? '—'}</td>
                        <td class="${f?.normSlope>0?'ai-pos':'ai-neg'}">${f ? (f.normSlope>0?'+':'')+f.normSlope : '—'}</td>
                    </tr>`;
                }).join('')}
                </tbody>
            </table>
            </div>
        </div>`;
    }
    
    function renderRegimeAnalysis() {
        const a = AI.regAnalysis;
        const cur = a.current;
        const curM = rm(cur.regime);
    
        return `
        <div class="ai-block">
            <div class="ai-bh"><span class="ai-bt">📊 Setup Performance by Regime</span></div>
    
            <!-- Current recommendation -->
            ${cur.recommendation ? `
            <div class="ai-rec-banner" style="border-color:${curM.color};background:${curM.bg}">
                <div class="ai-rec-ico">${curM.icon}</div>
                <div class="ai-rec-body">
                    <div class="ai-rec-lbl">Current regime: <strong style="color:${curM.color}">${curM.label}</strong></div>
                    <div class="ai-rec-val">
                        Recommended setup: <strong>${esc(cur.recommendation.bestSetup)}</strong>
                        · Win rate: <span class="ai-pos">${cur.recommendation.winRate}%</span>
                        · Avg PnL: ${fmtMoney(cur.recommendation.avgPnl)}
                        · Confidence: <span class="ai-conf-${cur.recommendation.confidence}">${cur.recommendation.confidence}</span>
                    </div>
                </div>
            </div>
            ` : `<div class="ai-nodata">Not enough data for current regime (${curM.label}) recommendation.</div>`}
    
            <!-- By regime table -->
            <div class="ai-sect-hdr">All Regimes</div>
            ${Object.entries(a.byRegime).map(([regime, setupMap]) => {
                const m = rm(regime);
                const rec = a.recommendations[regime];
                return `
                <div class="ai-reg-section">
                    <div class="ai-reg-sec-hdr" style="color:${m.color}">
                        ${m.icon} ${m.label}
                        ${rec ? `<span class="ai-rec-badge">Best: ${esc(rec.bestSetup)}</span>` : ''}
                    </div>
                    <table class="ai-tbl ai-tbl-sm">
                        <thead><tr><th>Setup</th><th>Trades</th><th>Win Rate</th><th>Avg PnL</th><th>Total PnL</th></tr></thead>
                        <tbody>${Object.entries(setupMap).sort((a,b)=>b[1].winRate-a[1].winRate).map(([name, s]) => `
                        <tr ${rec?.bestSetup===name?'class="ai-best"':''}>
                            <td style="font-weight:600">${esc(name)}</td>
                            <td>${s.trades}</td>
                            <td class="${s.winRate>=50?'ai-pos':'ai-neg'}">${s.winRate}%</td>
                            <td>${fmtMoney(s.avgPnl)}</td>
                            <td>${fmtMoney(s.pnl)}</td>
                        </tr>`).join('')}
                        </tbody>
                    </table>
                </div>`;
            }).join('')}
        </div>`;
    }
    
    function fmtDate(ts) { if(!ts) return '—'; try { return new Date(ts).toISOString().slice(0,10); } catch(_) { return String(ts).slice(0,10); } }
    function kpi(l, v) { return `<div class="ai-kpi"><div class="ai-kpi-l">${l}</div><div class="ai-kpi-v">${v}</div></div>`; }
    
    // ════════════════════════════════════════════════════════════════
    // EVENTS
    // ════════════════════════════════════════════════════════════════
    
    function bindEvents(root) {
        root.querySelectorAll('[data-aitab]').forEach(btn =>
            btn.addEventListener('click', () => { AI.tab = btn.dataset.aitab; refreshAll(); })
        );
        root.querySelector('#ai-opt-btn')?.addEventListener('click', runOptimize);
        root.querySelector('#ai-reg-btn')?.addEventListener('click', runRegime);
        root.querySelector('#ai-reg-analysis-btn')?.addEventListener('click', runRegimeAnalysis);
    
        // Чекбоксы → dim/undim range rows
        ['sl','tp','risk'].forEach(k => {
            root.querySelector(`#ai-${k}-on`)?.addEventListener('change', e => {
                root.querySelector(`#ai-${k}-row`)?.classList.toggle('ai-dim', !e.target.checked);
            });
        });
    }
    
    function refreshAll() {
        const body = document.getElementById('sb-tab-body');
        if (!body) return;
        renderAIPanel(body);
    }
    
    function updateSidebar() {
        const sb = document.getElementById('ai-sidebar'); if (!sb) return;
        sb.innerHTML = renderSidebar();
        const body = document.getElementById('sb-tab-body'); if (body) bindEvents(body);
    }
    function updateMain() {
        const m = document.getElementById('ai-main'); if (!m) return;
        Object.values(AI.charts).forEach(c=>{try{c.destroy();}catch(_){}});AI.charts={};
        m.innerHTML = renderMain();
        const body = document.getElementById('sb-tab-body'); if (body) bindEvents(body);
        setTimeout(()=>drawCharts(), 80);
    }
    
    // ════════════════════════════════════════════════════════════════
    // API CALLS
    // ════════════════════════════════════════════════════════════════
    
    function collectOptCfg() {
        const c = AI.cfg;
        c.sl_on    = !!document.getElementById('ai-sl-on')?.checked;
        c.tp_on    = !!document.getElementById('ai-tp-on')?.checked;
        c.risk_on  = !!document.getElementById('ai-risk-on')?.checked;
        c.sl_min   = parseFloat(document.getElementById('ai-sl-min')?.value)  || c.sl_min;
        c.sl_max   = parseFloat(document.getElementById('ai-sl-max')?.value)  || c.sl_max;
        c.tp_min   = parseFloat(document.getElementById('ai-tp-min')?.value)  || c.tp_min;
        c.tp_max   = parseFloat(document.getElementById('ai-tp-max')?.value)  || c.tp_max;
        c.risk_min = parseFloat(document.getElementById('ai-risk-min')?.value) || c.risk_min;
        c.risk_max = parseFloat(document.getElementById('ai-risk-max')?.value) || c.risk_max;
        c.initPoints = parseInt(document.getElementById('ai-init-pts')?.value) || c.initPoints;
        c.maxIter    = parseInt(document.getElementById('ai-max-iter')?.value) || c.maxIter;
        saveCfg();
    }
    
    function collectRegCfg() {
        const c = AI.cfg;
        c.windowSize = parseInt(document.getElementById('ai-win-size')?.value)  || c.windowSize;
        c.stepSize   = parseInt(document.getElementById('ai-step-size')?.value) || c.stepSize;
        saveCfg();
    }
    
    async function runOptimize() {
        if (AI.optRunning) return;
        collectOptCfg();
    
        const btCfg = getBTCfg();
        if (!btCfg.ticker) { alert('⚠️ Ticker not found. Make sure the chart is loaded.'); return; }
        if (!btCfg.setupCols || !Object.keys(btCfg.setupCols).length) { alert('⚠️ No setups found. Run a script in Code Panel first.'); return; }
    
        const c = AI.cfg;
        const paramSpace = {};
        if (c.sl_on)   paramSpace.slValue  = { min: c.sl_min,   max: c.sl_max,   type: 'float' };
        if (c.tp_on)   paramSpace.tpValue  = { min: c.tp_min,   max: c.tp_max,   type: 'float' };
        if (c.risk_on) paramSpace.riskPct  = { min: c.risk_min, max: c.risk_max, type: 'float' };
        if (!Object.keys(paramSpace).length) { alert('Select at least one parameter to optimize.'); return; }
    
        AI.optRunning = true; AI.optResult = null; AI.progress = 3; AI.progressMsg = 'Starting optimization...';
        updateSidebar();
    
        try {
            const resp = await fetch('/api/ai/optimize', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...btCfg,
                    paramSpace,
                    options: { initPoints: c.initPoints, maxIter: c.maxIter },
                }),
            });
            if (!resp.ok) { const e = await resp.json().catch(()=>({error:resp.statusText})); throw new Error(e.error||resp.statusText); }
            AI.optResult = await resp.json();
        } catch(err) { alert('Optimization error: ' + err.message); console.error('[AI/Opt]', err); }
        finally {
            AI.optRunning = false; AI.progress = 0;
            const body = document.getElementById('sb-tab-body');
            if (body && document.getElementById('sb-tab-ai')?.classList.contains('sb-tab-active')) renderAIPanel(body);
        }
    }
    
    async function runRegime() {
        if (AI.regRunning) return;
        collectRegCfg();
    
        const btCfg = getBTCfg();
        if (!btCfg.ticker) { alert('⚠️ Ticker not found. Make sure the chart is loaded.'); return; }
    
        AI.regRunning = true; AI.regResult = null; AI.regAnalysis = null; AI.progress = 5; AI.progressMsg = 'Loading bars...';
        updateSidebar();
    
        try {
            const resp = await fetch('/api/ai/regime', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ticker: btCfg.ticker, table: btCfg.table,
                    fromDate: btCfg.fromDate, toDate: btCfg.toDate,
                    windowSize: AI.cfg.windowSize, stepSize: AI.cfg.stepSize,
                }),
            });
            if (!resp.ok) { const e = await resp.json().catch(()=>({error:resp.statusText})); throw new Error(e.error||resp.statusText); }
            AI.regResult = await resp.json();
        } catch(err) { alert('Regime error: ' + err.message); console.error('[AI/Regime]', err); }
        finally {
            AI.regRunning = false; AI.progress = 0;
            const body = document.getElementById('sb-tab-body');
            if (body && document.getElementById('sb-tab-ai')?.classList.contains('sb-tab-active')) renderAIPanel(body);
        }
    }
    
    async function runRegimeAnalysis() {
        if (AI.regRunning || !AI.regResult) return;
        const trades = getTrades();
        if (!trades.length) { alert('Run Server BT first (Backtest tab) to get trades.'); return; }
    
        const btCfg = getBTCfg();
        AI.regRunning = true; AI.regAnalysis = null; AI.progress = 5; AI.progressMsg = 'Analyzing setups by regime...';
        updateSidebar();
    
        try {
            // Отправляем только нужные поля трейдов
            const slimTrades = trades.map(t => ({ pnl: t.pnl, entryTs: t.entryTs, setupName: t.setupName }));
            const resp = await fetch('/api/ai/regime-analysis', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ticker: btCfg.ticker, table: btCfg.table,
                    fromDate: btCfg.fromDate, toDate: btCfg.toDate,
                    trades: slimTrades,
                    windowSize: AI.cfg.windowSize, stepSize: AI.cfg.stepSize,
                }),
            });
            if (!resp.ok) { const e = await resp.json().catch(()=>({error:resp.statusText})); throw new Error(e.error||resp.statusText); }
            AI.regAnalysis = await resp.json();
        } catch(err) { alert('Regime analysis error: ' + err.message); console.error('[AI/RegimeAnalysis]', err); }
        finally {
            AI.regRunning = false; AI.progress = 0;
            const body = document.getElementById('sb-tab-body');
            if (body && document.getElementById('sb-tab-ai')?.classList.contains('sb-tab-active')) renderAIPanel(body);
        }
    }
    
    // ════════════════════════════════════════════════════════════════
    // CHARTS
    // ════════════════════════════════════════════════════════════════
    
    function ensureChartJS(cb) { if(window.Chart){cb();return;} const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';s.onload=cb;document.head.appendChild(s); }
    function destroyChart(id) { if(AI.charts[id]){try{AI.charts[id].destroy();}catch(_){}delete AI.charts[id];} }
    
    function drawCharts() {
        ensureChartJS(() => {
            if (AI.optResult) drawConvChart();
            if (AI.regResult) drawRegimeChart();
        });
    }
    
    function drawConvChart() {
        const canvas = document.getElementById('ai-conv-chart'); if(!canvas) return; destroyChart('conv');
        const data = AI.optResult.convergence;
        const labels = data.map((_,i) => i+1);
        // Running best
        const running = [];
        let best = -Infinity;
        data.forEach(v => { best = Math.max(best, v); running.push(+best.toFixed(4)); });
        const n = AI.optResult.history[0] ? AI.optResult.totalEvals : 0;
        const initPts = AI.cfg.initPoints;
    
        AI.charts['conv'] = new Chart(canvas, {
            type: 'line',
            data: { labels, datasets: [
                { label: 'Score', data, borderColor: 'rgba(123,79,255,.5)', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 3, pointBackgroundColor: labels.map(i => i <= initPts ? '#ff9800' : '#4a9eff'), tension: 0 },
                { label: 'Best so far', data: running, borderColor: '#4caf50', backgroundColor: 'rgba(76,175,80,.08)', borderWidth: 2, pointRadius: 0, fill: true, tension: 0.3 },
            ]},
            options: {
                responsive: true, interaction: { mode: 'index', intersect: false },
                plugins: { legend: { labels: { color: '#787b86', boxWidth: 12, font:{size:11} } },
                    annotation: { annotations: { line1: { type: 'line', x: initPts, borderColor: 'rgba(255,152,0,.4)', borderWidth: 1, borderDash: [4,4], label: { content: 'BO starts', display: true, color: '#ff9800', font:{size:10} } } } } },
                scales: { x: { ticks:{ color:'#787b86' }, grid:{ color:'rgba(255,255,255,.05)' } }, y: { ticks:{ color:'#787b86' }, grid:{ color:'rgba(255,255,255,.06)' } } }
            }
        });
    }
    
    function drawRegimeChart() {
        const canvas = document.getElementById('ai-reg-chart'); if(!canvas || !AI.regResult?.regimes?.length) return; destroyChart('reg');
        const regimes = AI.regResult.regimes;
        const COLORS = { trending_up:'#4caf50', trending_down:'#ef5350', ranging:'#ff9800', volatile:'#9c27b0', neutral:'#607d8b', unknown:'#444c70' };
    
        const labels = regimes.map(r => fmtDate(r.startTs));
        const datasets = Object.keys(COLORS).map(regime => ({
            label: rm(regime).label,
            data: regimes.map(r => r.regime === regime ? 1 : 0),
            backgroundColor: COLORS[regime],
            borderWidth: 0, borderRadius: 2,
        }));
    
        AI.charts['reg'] = new Chart(canvas, {
            type: 'bar',
            data: { labels, datasets },
            options: {
                responsive: true, indexAxis: 'x',
                plugins: { legend: { labels: { color: '#787b86', boxWidth: 12, font:{size:10} } } },
                scales: {
                    x: { stacked: true, ticks:{ color:'#787b86', maxTicksLimit:10 }, grid:{ display:false } },
                    y: { stacked: true, display: false }
                }
            }
        });
    }
    
    // ════════════════════════════════════════════════════════════════
    // CSS
    // ════════════════════════════════════════════════════════════════
    
    function injectCSS() {
        if (document.getElementById('ai-css')) return;
        const s = document.createElement('style'); s.id = 'ai-css';
        s.textContent = `
    .sb-tab-ai.sb-tab-active{color:#ff9800;border-bottom-color:#ff9800}
    
    .ai-root{display:flex;height:100%;min-height:0;font-size:12px;color:#c8ccd8;background:#080a12}
    .ai-sidebar{width:215px;min-width:215px;border-right:1px solid #141826;overflow-y:auto;background:#0b0d16;flex-shrink:0}
    .ai-logo{padding:6px 12px 8px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#ff9800;border-bottom:1px solid #141826}
    .ai-main{flex:1;overflow-y:auto;padding:10px;min-height:0}
    
    .ai-tabs-vert{display:flex;flex-direction:column;gap:0;border-bottom:1px solid #141826}
    .ai-vtab{padding:8px 12px;background:transparent;border:none;border-left:2px solid transparent;text-align:left;color:#444c70;font-size:11px;font-weight:700;cursor:pointer;transition:all .12s;font-family:inherit}
    .ai-vtab:hover{color:#c8ccd8;background:rgba(255,255,255,.02)}
    .ai-vtab-a{color:#ff9800;border-left-color:#ff9800;background:rgba(255,152,0,.06)}
    
    .ai-sb-sect{padding:8px 10px}
    .ai-sb-h{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#444c70;margin:8px 0 5px}
    .ai-sb-row{display:flex;align-items:center;gap:6px;margin-bottom:4px}
    .ai-sb-lbl{flex:1;font-size:11px;color:#6a7090}
    .ai-sb-inp{background:#111320;border:1px solid #1a1e30;color:#c8ccd8;padding:3px 6px;border-radius:3px;font-size:11px;outline:none;font-family:inherit}
    .ai-sb-inp:focus{border-color:#ff9800}
    .ai-sb-inp-sm{width:55px}
    .ai-sb-chk{display:flex;align-items:center;gap:5px;font-size:11px;color:#8a90a8;cursor:pointer;margin-bottom:3px}
    .ai-range-row{display:flex;align-items:center;gap:4px;margin-bottom:6px}
    .ai-range-row .ai-sb-inp{width:55px}
    .ai-dash{color:#444c70;font-size:13px}
    .ai-dim{opacity:.35}
    .ai-run-btn{width:100%;margin-top:8px}
    .ai-hint{font-size:10px;color:#2a3050;margin-top:4px;line-height:1.5}
    .ai-spin{display:inline-block;width:9px;height:9px;border:2px solid rgba(255,255,255,.2);border-top-color:#fff;border-radius:50%;animation:ai-s .7s linear infinite;vertical-align:middle;margin-right:3px}
    @keyframes ai-s{to{transform:rotate(360deg)}}
    .ai-pbar{height:3px;background:#1a1e30;border-radius:2px;overflow:hidden;margin-bottom:4px}
    .ai-pbar-fill{height:100%;background:linear-gradient(90deg,#ff9800,#7b4fff);transition:width .3s}
    .ai-pmsg{font-size:10px;color:#444c70}
    
    .ai-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;min-height:260px;text-align:center;gap:10px;padding:20px}
    .ai-empty-t{font-size:15px;font-weight:700;color:#444c70}
    .ai-empty-s{font-size:11px;color:#2a3050;line-height:1.9}
    
    .ai-block{background:#0d0f1a;border:1px solid #141826;border-radius:6px;margin-bottom:12px;overflow:hidden}
    .ai-bh{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid #141826;background:#0b0d16}
    .ai-bt{font-weight:700;font-size:12px}
    .ai-bsub{font-size:10px;color:#444c70}
    .ai-nodata{padding:14px;text-align:center;color:#2a3050;font-size:11px}
    .ai-sect-hdr{padding:8px 12px 3px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#444c70}
    .ai-chart-wrap{padding:6px 10px}
    .ai-scroll-x{overflow-x:auto;padding:6px}
    
    .ai-best-params{display:flex;flex-wrap:wrap;gap:8px;padding:12px}
    .ai-param-card{background:#111320;border:1px solid #1a1e30;border-radius:6px;padding:10px 14px;min-width:90px;text-align:center}
    .ai-param-lbl{font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:#444c70;margin-bottom:4px}
    .ai-param-val{font-size:20px;font-weight:700;color:#4a9eff}
    .ai-param-tag{font-size:9px;color:#444c70;margin-top:3px;text-transform:uppercase}
    .ai-param-improve .ai-param-val{color:#4caf50}
    .ai-param-improve{border-color:rgba(76,175,80,.3)}
    
    .ai-kpi5{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:#141826;margin:1px}
    .ai-kpi{padding:9px 10px;background:#0d0f1a}
    .ai-kpi-l{font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:#444c70;margin-bottom:2px}
    .ai-kpi-v{font-size:14px;font-weight:700}
    .ai-pos{color:#4caf50}.ai-neg{color:#ef5350}
    
    .ai-badge{padding:2px 6px;border-radius:9px;font-size:10px;font-weight:700}
    .ai-badge-bo{background:rgba(74,158,255,.15);color:#4a9eff}
    .ai-badge-rnd{background:rgba(255,152,0,.15);color:#ff9800}
    
    .ai-tbl{width:100%;border-collapse:collapse;font-size:11px}
    .ai-tbl-sm{font-size:11px}
    .ai-tbl th{padding:5px 7px;text-align:left;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#444c70;border-bottom:1px solid #141826;white-space:nowrap}
    .ai-tbl td{padding:4px 7px;border-bottom:1px solid rgba(255,255,255,.03);white-space:nowrap}
    .ai-tbl tr:hover td{background:rgba(255,255,255,.02)}
    .ai-best td{background:rgba(74,158,255,.08);font-weight:700}
    .ai-mono{font-family:'JetBrains Mono',monospace;font-size:10px}
    
    .ai-cur-regime{display:flex;align-items:center;gap:14px;margin:10px 12px;padding:12px 16px;border:1px solid;border-radius:8px}
    .ai-cur-ico{font-size:28px}
    .ai-cur-lbl{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:#787b86;margin-bottom:3px}
    .ai-cur-val{font-size:18px;font-weight:700}
    .ai-cur-feat{font-size:10px;color:#444c70;margin-top:4px;font-family:'JetBrains Mono',monospace}
    
    .ai-dist-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;padding:6px 12px 10px}
    .ai-dist-card{background:#111320;border:1px solid #1a1e30;border-radius:5px;padding:8px 10px}
    .ai-dist-ico{font-size:16px;margin-bottom:3px}
    .ai-dist-lbl{font-size:10px;color:#787b86;margin-bottom:2px}
    .ai-dist-pct{font-size:16px;font-weight:700;margin-bottom:4px}
    .ai-dist-bar-bg{height:3px;background:#1a1e30;border-radius:2px;overflow:hidden}
    .ai-dist-bar{height:100%;border-radius:2px;transition:width .4s}
    
    .ai-regime-tag{padding:2px 7px;border-radius:9px;font-size:10px;font-weight:600}
    
    .ai-rec-banner{display:flex;align-items:center;gap:12px;margin:10px 12px;padding:12px 16px;border:1px solid;border-radius:8px}
    .ai-rec-ico{font-size:24px}
    .ai-rec-lbl{font-size:11px;color:#8a90a8;margin-bottom:3px}
    .ai-rec-val{font-size:12px;line-height:1.7}
    .ai-conf-high{color:#4caf50;font-weight:700}
    .ai-conf-medium{color:#ff9800;font-weight:700}
    .ai-conf-low{color:#607d8b;font-weight:700}
    
    .ai-reg-section{margin:6px 12px 10px}
    .ai-reg-sec-hdr{font-size:12px;font-weight:700;margin-bottom:5px;display:flex;align-items:center;gap:8px}
    .ai-rec-badge{font-size:10px;background:rgba(74,158,255,.15);color:#4a9eff;padding:2px 7px;border-radius:9px;font-weight:600}
    `;
        document.head.appendChild(s);
    }
    
    // ════════════════════════════════════════════════════════════════
    // INIT
    // ════════════════════════════════════════════════════════════════
    
    injectTab();
    window.aiPanel = { open: () => document.getElementById('sb-tab-ai')?.click() };
    console.log('[AI] v1.0 loaded — injecting into #sb-tabbar...');
    
    })(); }