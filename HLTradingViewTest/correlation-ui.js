/**
 * correlation-ui.js  v1.0
 *
 * UI корреляционного и портфельного анализа.
 * Вкладка "🔬 Portfolio" в #sb-tabbar.
 *
 * Разделы:
 *   1. 🌡 Heat Map      — интерактивная корреляционная матрица
 *   2. 🏗 Portfolio     — построитель портфеля с весами
 *   3. 📈 Frontier      — Efficient Frontier (облако портфелей)
 *   4. 🛡 Market Mode   — Risk-On / Risk-Off / Hedge детектор
 *
 * Подключение в index.html ПОСЛЕ alert-ui.js:
 *   <script src="correlation-ui.js"></script>
 */

if (window._corrUILoaded) {} else { window._corrUILoaded = true; (function () {
    'use strict';
    
    // ════════════════════════════════════════════════════════════════
    // STATE
    // ════════════════════════════════════════════════════════════════
    
    const CR = {
        tab:      'heatmap',  // heatmap | portfolio | frontier | mode
        running:  false,
        tickers:  [],         // выбранные тикеры (все доступные из БД)
        selected: [],         // тикеры отмеченные пользователем
        table:    window.app._currentTable,
        days:     90,
        // Результаты
        matrix:    null,
        portfolio: null,
        frontier:  null,
        mode:      null,
        vols:      {},
        // Asset groups для Mode detector
        groups: { equity:[], crypto:[], bonds:[], gold:[], other:[] },
        charts: {},
    };
    
    // ════════════════════════════════════════════════════════════════
    // TAB INJECTION
    // ════════════════════════════════════════════════════════════════
    
    function injectTab() {
        const t = setInterval(() => {
            const tabbar = document.getElementById('sb-tabbar');
            if (!tabbar) return;
            clearInterval(t);
            if (document.getElementById('sb-tab-corr')) return;
            injectCSS();
            const btn = document.createElement('button');
            btn.id = 'sb-tab-corr'; btn.className = 'sb-tab sb-tab-corr'; btn.textContent = '🔬 Portfolio';
            tabbar.appendChild(btn);
            btn.addEventListener('click', () => {
                const body  = document.getElementById('sb-tab-body');
                const twrap = document.getElementById('dt-twrap');
                if (!body) return;
                tabbar.querySelectorAll('.sb-tab').forEach(b => b.classList.remove('sb-tab-active'));
                btn.classList.add('sb-tab-active');
                if (twrap) twrap.style.display = 'none';
                body.style.display = 'flex';
                mountPanel(body);
            });
        }, 300);
    }
    
    // ════════════════════════════════════════════════════════════════
    // MOUNT
    // ════════════════════════════════════════════════════════════════
    
    async function mountPanel(body) {
        destroyCharts();
        body.innerHTML = `<div class="cr-root"><div class="cr-sidebar" id="cr-sidebar">Loading…</div><div class="cr-main" id="cr-main"></div></div>`;
        await loadTickers();
        renderAll();
    }
    
    async function loadTickers() {
        if (CR.instruments?.length) return;
        try {
            const resp = await fetch('/api/instruments', { credentials: 'include' });
            if (!resp.ok) return;
            const rows = await resp.json();
    
            // Храним полные объекты инструментов
            CR.instruments = rows
                .filter(r => r.is_active && r.clickhouse_ticker)
                .map(r => ({
                    symbol:    r.symbol,
                    name:      r.name || r.symbol,
                    ticker:    r.clickhouse_ticker,   // то что уходит в ClickHouse
                    type:      r.type || 'other',
                }));
    
            // Устаревший массив CR.tickers — оставляем для совместимости
            CR.tickers = CR.instruments.map(i => i.ticker);
    
            // По умолчанию выбираем все (их обычно немного)
            if (!CR.selected.length) {
                CR.selected = CR.tickers.slice(0, 10);
            }
        } catch(e) { console.warn('[Corr] loadTickers:', e); }
    }
    
    function renderAll() {
        const sb = document.getElementById('cr-sidebar');
        const mn = document.getElementById('cr-main');
        if (sb) sb.innerHTML = renderSidebar();
        if (mn) { mn.innerHTML = renderMain(); setTimeout(() => drawCharts(), 80); }
        bindEvents();
    }
    
    function refreshMain() {
        destroyCharts();
        const mn = document.getElementById('cr-main');
        if (mn) { mn.innerHTML = renderMain(); setTimeout(() => drawCharts(), 80); }
    }
    
    // ════════════════════════════════════════════════════════════════
    // SIDEBAR
    // ════════════════════════════════════════════════════════════════
    
    function renderSidebar() {
        const tabs = [
            { id:'heatmap',   icon:'🌡', label:'Heat Map'   },
            { id:'portfolio', icon:'🏗', label:'Portfolio'  },
            { id:'frontier',  icon:'📈', label:'Frontier'   },
            { id:'mode',      icon:'🛡', label:'Market Mode'},
        ];
    
        return `
        <div class="cr-logo">🔬 Portfolio Analysis</div>
    
        <div class="cr-vtabs">
            ${tabs.map(t => `
            <button class="cr-vtab ${CR.tab===t.id?'cr-vtab-a':''}" data-crtab="${t.id}">
                <span>${t.icon}</span> ${t.label}
            </button>`).join('')}
        </div>
    
        <div class="cr-sb-sect">
            <div class="cr-sb-h">Data Settings</div>
            <div class="cr-field">
                <label class="cr-lbl">Timeframe</label>
                <select class="cr-sel" id="cr-table">
                    <option value="market_data_day"    ${CR.table==='market_data'   ?'selected':''}>Daily</option>
                    <option value="market_data_hour"   ${CR.table==='market_data_hour'  ?'selected':''}>Hourly</option>
                    <option value="market_data_minute" ${CR.table==='market_data_minute'?'selected':''}>1 Min</option>
                    <option value="market_data_week"   ${CR.table==='market_data_week'  ?'selected':''}>Weekly</option>
                </select>
            </div>
            <div class="cr-field">
                <label class="cr-lbl">History (days)</label>
                <select class="cr-sel" id="cr-days">
                    <option value="14"  ${CR.days===14 ?'selected':''}>14 days</option>
                    <option value="30"  ${CR.days===30 ?'selected':''}>30 days</option>
                    <option value="60"  ${CR.days===60 ?'selected':''}>60 days</option>
                    <option value="90"  ${CR.days===90 ?'selected':''}>90 days</option>
                    <option value="180" ${CR.days===180?'selected':''}>180 days</option>
                    <option value="365" ${CR.days===365?'selected':''}>1 year</option>
                </select>
            </div>
        </div>
    
        ${CR.tab !== 'mode' ? renderTickerSelector() : renderModeGroupSelector()}
    
        <div class="cr-sb-sect">
            ${CR.tab === 'portfolio' ? `
            <div class="cr-field">
                <label class="cr-lbl">Method</label>
                <select class="cr-sel" id="cr-method">
                    <option value="min_corr">Min Correlation</option>
                    <option value="max_div">Max Diversification</option>
                    <option value="risk_parity">Risk Parity</option>
                    <option value="equal_weight">Equal Weight</option>
                </select>
            </div>
            <div class="cr-field">
                <label class="cr-lbl">Assets in portfolio</label>
                <input class="cr-inp" id="cr-n" type="number" min="2" max="20" value="5">
            </div>` : ''}
            ${CR.tab === 'frontier' ? `
            <div class="cr-field">
                <label class="cr-lbl">Simulations</label>
                <input class="cr-inp" id="cr-sims" type="number" min="100" max="2000" value="500">
            </div>` : ''}
    
            <button class="sb-btn sb-btn-srv cr-run-btn" id="cr-run-btn" ${CR.running?'disabled':''}>
                ${CR.running
                    ? '<span class="cr-spin"></span> Computing...'
                    : { heatmap:'🌡 Build Heat Map', portfolio:'🏗 Build Portfolio',
                        frontier:'📈 Run Frontier',  mode:'🛡 Detect Mode' }[CR.tab]}
            </button>
        </div>`;
    }
    
    function renderTickerSelector() {
        const instruments = CR.instruments || [];
        const typeIcon = { forex:'💱', crypto:'₿', stock:'📊', index:'📈', commodity:'🏅', other:'📦' };
    
        return `
        <div class="cr-sb-sect cr-ticker-sect">
            <div class="cr-sb-h">
                Instruments
                <span class="cr-sel-count">${CR.selected.length} / ${instruments.length}</span>
            </div>
            <input class="cr-search" id="cr-ticker-search" type="text" placeholder="Filter…">
            <div class="cr-ticker-actions">
                <button class="cr-sm-btn" id="cr-sel-all">All</button>
                <button class="cr-sm-btn" id="cr-sel-none">None</button>
                <button class="cr-sm-btn" id="cr-sel-top10">Top 10</button>
            </div>
            <div class="cr-ticker-list" id="cr-ticker-list">
                ${instruments.length === 0
                    ? `<div style="padding:10px;font-size:11px;color:#444c70">No instruments found</div>`
                    : instruments.map(i => `
                <label class="cr-ticker-item ${CR.selected.includes(i.ticker) ? 'cr-ticker-on' : ''}">
                    <input type="checkbox" value="${esc(i.ticker)}" ${CR.selected.includes(i.ticker) ? 'checked' : ''}>
                    <span class="cr-ti-icon">${typeIcon[i.type] || '📦'}</span>
                    <span class="cr-ti-sym">${esc(i.symbol)}</span>
                    <span class="cr-ti-name">${esc(i.name)}</span>
                </label>`).join('')}
            </div>
        </div>`;
    }
    
    
    
    function renderModeGroupSelector() {
        const groups = ['equity','crypto','bonds','gold','other'];
        return `
        <div class="cr-sb-sect">
            <div class="cr-sb-h">Asset Groups</div>
            <div class="cr-hint">Assign tickers to groups for Risk-On/Off detection</div>
            ${groups.map(g => `
            <div class="cr-field">
                <label class="cr-lbl" style="text-transform:capitalize">${g}</label>
                <input class="cr-inp cr-group-inp" id="cr-grp-${g}" type="text"
                       placeholder="Comma-separated tickers"
                       value="${(CR.groups[g]||[]).join(', ')}">
            </div>`).join('')}
            <div class="cr-field">
                <label class="cr-lbl">Lookback (days)</label>
                <input class="cr-inp" id="cr-mode-days" type="number" value="30" min="7" max="365">
            </div>
        </div>`;
    }
    
    // ════════════════════════════════════════════════════════════════
    // MAIN CONTENT
    // ════════════════════════════════════════════════════════════════
    
    function renderMain() {
        if (CR.tab === 'heatmap')   return renderHeatmap();
        if (CR.tab === 'portfolio') return renderPortfolio();
        if (CR.tab === 'frontier')  return renderFrontier();
        if (CR.tab === 'mode')      return renderMode();
        return '';
    }
    
    // ── HEAT MAP ──────────────────────────────────────────────────
    
    function renderHeatmap() {
        if (!CR.matrix) return emptyState('🌡', 'Correlation Heat Map',
            'Select instruments and click Build Heat Map.\n\nClickHouse returns correlation matrix for 200 instruments in < 100ms.');
    
        const { tickers, matrix, avgCorrelations, clusters, queryMs } = CR.matrix;
        const n = tickers.length;
    
        return `
        <div class="cr-block">
            <div class="cr-bh">
                <span class="cr-bt">🌡 Correlation Matrix</span>
                <span class="cr-bsub">${n} instruments · ${CR.days}d · ${queryMs}ms</span>
                <div class="cr-legend">
                    <div class="cr-leg-bar"></div>
                    <div class="cr-leg-labels"><span>-1</span><span>0</span><span>+1</span></div>
                </div>
            </div>
    
            <!-- Heat Map Table -->
            <div class="cr-hm-wrap" id="cr-hm-wrap">
                <table class="cr-hm-tbl" id="cr-hm-tbl">
                    <thead>
                        <tr>
                            <th class="cr-hm-corner"></th>
                            ${tickers.map(t => `<th class="cr-hm-th" title="${esc(t)}">${esc(t.length>8?t.slice(0,7)+'…':t)}</th>`).join('')}
                            <th class="cr-hm-th cr-avg-th">Avg</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tickers.map((rt, ri) => `
                        <tr>
                            <td class="cr-hm-rlabel" title="${esc(rt)}">${esc(rt.length>8?rt.slice(0,7)+'…':rt)}</td>
                            ${tickers.map((ct, ci) => {
                                const v    = matrix[ri][ci];
                                const bg   = corrColor(v);
                                const text = ri === ci ? '–' : v.toFixed(2);
                                const bold = ri === ci ? 'font-weight:700;' : '';
                                return `<td class="cr-hm-cell" style="background:${bg};${bold}" title="${esc(rt)} × ${esc(ct)}: ${v}">${text}</td>`;
                            }).join('')}
                            <td class="cr-hm-avg ${avgColor(avgCorrelations[rt])}">${(avgCorrelations[rt]||0).toFixed(2)}</td>
                        </tr>`).join('')}
                    </tbody>
                </table>
            </div>
    
            <!-- Clusters -->
            ${clusters.filter(c=>c.size>1).length ? `
            <div class="cr-sect-hdr">⚠️ Correlated Clusters (> 0.7)</div>
            <div class="cr-clusters">
                ${clusters.filter(c=>c.size>1).map(c => `
                <div class="cr-cluster-tag">
                    ${c.tickers.map(t=>`<span>${esc(t)}</span>`).join('')}
                </div>`).join('')}
            </div>
            <div class="cr-hint-box">Instruments in the same cluster move together — including them all in a portfolio reduces diversification.</div>
            ` : `<div class="cr-ok-box">✓ No high-correlation clusters found. Good diversification potential.</div>`}
    
            <!-- Avg correlations ranking -->
            <div class="cr-sect-hdr">Diversification Ranking (lower = better)</div>
            <div class="cr-rank-list">
                ${[...tickers].sort((a,b)=>(avgCorrelations[a]||0)-(avgCorrelations[b]||0)).map((t, i) => {
                    const v = avgCorrelations[t] || 0;
                    return `<div class="cr-rank-row">
                        <span class="cr-rank-n">${i+1}</span>
                        <span class="cr-rank-t">${esc(t)}</span>
                        <div class="cr-rank-bar-bg"><div class="cr-rank-bar" style="width:${Math.max(0,v*100)}%;background:${corrColor(v)}"></div></div>
                        <span class="cr-rank-v ${v<0?'cr-pos':v>0.5?'cr-neg':'cr-neu'}">${v>=0?'+':''}${v.toFixed(3)}</span>
                    </div>`;
                }).join('')}
            </div>
        </div>`;
    }
    
    // ── PORTFOLIO ─────────────────────────────────────────────────
    
    function renderPortfolio() {
        if (!CR.portfolio) return emptyState('🏗', 'Portfolio Builder',
            'Select instruments, choose method, click Build Portfolio.\n\nMethods:\n• Min Correlation — lowest correlated assets\n• Max Diversification — greedy diversification\n• Risk Parity — weight by inverse volatility\n• Equal Weight — simple 1/N');
    
        const { portfolio, allCorrelations, allVols } = CR.portfolio;
    
        return `
        <div class="cr-block">
            <div class="cr-bh">
                <span class="cr-bt">🏗 Optimal Portfolio</span>
                <span class="cr-bsub">${portfolio.assetCount} assets · ${portfolio.method.replace('_',' ')}</span>
            </div>
    
            <!-- KPIs -->
            <div class="cr-kpi4">
                ${kpi('Assets',        portfolio.assetCount)}
                ${kpi('Portfolio Vol', portfolio.portfolioVol+'%/day')}
                ${kpi('Div. Ratio',    portfolio.diversificationRatio, portfolio.diversificationRatio >= 1.2 ? 'cr-pos' : 'cr-neu')}
                ${kpi('Avg Pair Corr', portfolio.avgPairCorrelation, portfolio.avgPairCorrelation < 0.3 ? 'cr-pos' : portfolio.avgPairCorrelation > 0.6 ? 'cr-neg' : 'cr-neu')}
            </div>
    
            <!-- Allocation Chart + Table -->
            <div class="cr-port-grid">
                <div>
                    <div class="cr-sect-hdr">Allocation</div>
                    <div class="cr-pie-wrap"><canvas id="cr-pie-chart"></canvas></div>
                </div>
                <div>
                    <div class="cr-sect-hdr">Asset Details</div>
                    <table class="cr-tbl">
                        <thead><tr><th>Ticker</th><th>Weight</th><th>Avg Corr</th><th>Ann. Vol</th></tr></thead>
                        <tbody>
                        ${portfolio.details.map(d => `
                        <tr>
                            <td style="font-weight:700">${esc(d.ticker)}</td>
                            <td>
                                <div class="cr-w-bar-bg">
                                    <div class="cr-w-bar" style="width:${d.weight}%"></div>
                                </div>
                                <span>${d.weight}%</span>
                            </td>
                            <td class="${d.avgCorr<0.3?'cr-pos':d.avgCorr>0.6?'cr-neg':'cr-neu'}">${d.avgCorr>=0?'+':''}${d.avgCorr}</td>
                            <td>${d.vol !== null ? d.vol+'%' : '—'}</td>
                        </tr>`).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
    
            <!-- Excluded assets -->
            ${CR.portfolio.tickers?.length > portfolio.assetCount ? `
            <div class="cr-sect-hdr">Excluded (high correlation)</div>
            <div class="cr-excluded">
                ${CR.portfolio.tickers.filter(t => !portfolio.assets.includes(t)).map(t => `
                <div class="cr-excl-row">
                    <span>${esc(t)}</span>
                    <span class="cr-neg">avg corr: ${(allCorrelations[t]||0)>=0?'+':''}${(allCorrelations[t]||0).toFixed(3)}</span>
                    ${allVols[t] ? `<span class="cr-neu">vol: ${allVols[t].annualVol}%</span>` : ''}
                </div>`).join('')}
            </div>` : ''}
        </div>`;
    }
    
    // ── FRONTIER ──────────────────────────────────────────────────
    
    function renderFrontier() {
        if (!CR.frontier) return emptyState('📈', 'Efficient Frontier',
            'Generates 500 random portfolios and plots the risk/return tradeoff.\n\nThe outer edge = efficient frontier.\nThe highlighted point = maximum Sharpe portfolio.');
    
        const { optimal } = CR.frontier;
        return `
        <div class="cr-block">
            <div class="cr-bh">
                <span class="cr-bt">📈 Efficient Frontier</span>
                <span class="cr-bsub">${CR.frontier.points.length} simulations</span>
            </div>
    
            <div class="cr-chart-wrap" style="height:380px"><canvas id="cr-frontier-chart"></canvas></div>
    
            ${optimal ? `
            <div class="cr-sect-hdr">Optimal Portfolio (Max Sharpe Proxy)</div>
            <div class="cr-kpi4">
                ${kpi('Vol/day', optimal.vol+'%')}
                ${kpi('Div Score', optimal.ret)}
                ${kpi('Sharpe Proxy', optimal.sharpe, 'cr-pos')}
                ${kpi('Assets', Object.keys(optimal.weights).length)}
            </div>
            <div class="cr-opt-weights">
                ${Object.entries(optimal.weights).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([t,w]) => `
                <div class="cr-rank-row">
                    <span class="cr-rank-t">${esc(t)}</span>
                    <div class="cr-rank-bar-bg"><div class="cr-rank-bar" style="width:${w}%;background:#4a9eff"></div></div>
                    <span class="cr-rank-v">${w}%</span>
                </div>`).join('')}
            </div>` : ''}
        </div>`;
    }
    
    // ── MARKET MODE ───────────────────────────────────────────────
    
    function renderMode() {
        if (!CR.mode) return emptyState('🛡', 'Market Mode Detector',
            'Assign tickers to asset groups (equity, crypto, bonds, gold)\nin the sidebar, then click Detect Mode.\n\nDetects:\n🟢 Risk-On — buy equities & crypto\n🔴 Risk-Off — flight to bonds & gold\n🔵 Hedge — inverse correlations active');
    
        const m = CR.mode;
        const META = {
            risk_on:  { icon:'🟢', label:'Risk-On',  color:'#4caf50', bg:'rgba(76,175,80,.1)',   desc:'Market appetite for risk. Equities & crypto outperforming.' },
            risk_off: { icon:'🔴', label:'Risk-Off', color:'#ef5350', bg:'rgba(239,83,80,.1)',  desc:'Flight to safety. Bonds & gold rising, equities falling.' },
            hedge:    { icon:'🔵', label:'Hedge',    color:'#2196f3', bg:'rgba(33,150,243,.1)', desc:'Inverse correlations detected. Active hedging.' },
            neutral:  { icon:'⚪', label:'Neutral',  color:'#607d8b', bg:'rgba(96,125,139,.1)', desc:'No clear regime signal.' },
            unknown:  { icon:'❓', label:'Unknown',  color:'#444c70', bg:'rgba(68,76,112,.1)',  desc:'Insufficient data.' },
        };
        const mt = META[m.mode] || META.unknown;
    
        return `
        <div class="cr-block">
            <div class="cr-bh"><span class="cr-bt">🛡 Market Mode</span><span class="cr-bsub">${m.days}d lookback</span></div>
    
            <!-- Mode Banner -->
            <div class="cr-mode-banner" style="border-color:${mt.color};background:${mt.bg}">
                <div class="cr-mode-ico">${mt.icon}</div>
                <div>
                    <div class="cr-mode-label" style="color:${mt.color}">${mt.label}</div>
                    <div class="cr-mode-conf">Confidence: <strong>${m.confidence}%</strong></div>
                    <div class="cr-mode-desc">${esc(mt.desc)}</div>
                    <div class="cr-mode-reason">${esc(m.description)}</div>
                </div>
            </div>
    
            <!-- Confidence bar -->
            <div class="cr-sect-hdr">Confidence</div>
            <div class="cr-conf-bar-bg">
                <div class="cr-conf-bar" style="width:${m.confidence}%;background:${mt.color}"></div>
            </div>
    
            <!-- Signals -->
            <div class="cr-sect-hdr">Asset Group Returns (${m.days}d)</div>
            <div class="cr-signals">
                ${Object.entries(m.signals).filter(([k]) => !k.includes('corr')).map(([group, ret]) => {
                    const icon = group === 'equity' ? '📊' : group === 'crypto' ? '₿' : group === 'bonds' ? '🏛' : group === 'gold' ? '🥇' : '📦';
                    const cls  = ret > 0 ? 'cr-pos' : ret < 0 ? 'cr-neg' : 'cr-neu';
                    return `<div class="cr-signal-row">
                        <span class="cr-sig-icon">${icon}</span>
                        <span class="cr-sig-group">${group}</span>
                        <div class="cr-sig-bar-bg">
                            <div class="cr-sig-bar" style="width:${Math.min(100,Math.abs(ret)*5)}%;background:${ret>0?'#4caf50':'#ef5350'};${ret<0?'margin-left:auto':''}"></div>
                        </div>
                        <span class="cr-sig-val ${cls}">${ret>0?'+':''}${ret}%</span>
                    </div>`;
                }).join('')}
                ${m.signals.eq_crypto_corr !== undefined ? `
                <div class="cr-signal-row">
                    <span class="cr-sig-icon">🔗</span>
                    <span class="cr-sig-group">EQ↔Crypto corr</span>
                    <div class="cr-sig-bar-bg"></div>
                    <span class="cr-sig-val ${m.signals.eq_crypto_corr<-0.4?'cr-pos':'cr-neg'}">${m.signals.eq_crypto_corr}</span>
                </div>` : ''}
            </div>
    
            <!-- Trading implications -->
            <div class="cr-sect-hdr">Trading Implications</div>
            <div class="cr-implications">
                ${m.mode === 'risk_on'  ? `<div class="cr-impl">✓ Favour momentum / trend-following setups</div><div class="cr-impl">✓ Increase position size on breakout signals</div><div class="cr-impl">✗ Avoid counter-trend mean-reversion</div>` : ''}
                ${m.mode === 'risk_off' ? `<div class="cr-impl">✓ Reduce exposure, favour defensive assets</div><div class="cr-impl">✓ Mean-reversion setups on oversold equity signals</div><div class="cr-impl">✗ Avoid crypto & high-beta instruments</div>` : ''}
                ${m.mode === 'hedge'    ? `<div class="cr-impl">✓ Pairs trading opportunities (long/short correlated assets)</div><div class="cr-impl">✓ Reduce gross exposure</div><div class="cr-impl">✗ Avoid directional bets without hedge</div>` : ''}
                ${m.mode === 'neutral'  ? `<div class="cr-impl">→ Standard position sizing applies</div><div class="cr-impl">→ Monitor signals for regime change</div>` : ''}
            </div>
        </div>`;
    }
    
    // ════════════════════════════════════════════════════════════════
    // EVENTS
    // ════════════════════════════════════════════════════════════════
    
    function bindEvents() {
        // Vertical tabs
        document.querySelectorAll('[data-crtab]').forEach(btn =>
            btn.addEventListener('click', () => { CR.tab = btn.dataset.crtab; renderAll(); })
        );
    
        // Settings
        document.getElementById('cr-table')?.addEventListener('change', e => {
            CR.table = e.target.value; CR.tickers = []; CR.instruments = []; CR.selected = [];
            loadTickers().then(() => renderAll());
        });
        document.getElementById('cr-days')?.addEventListener('change', e => { CR.days = +e.target.value; });
    
        // Ticker bulk actions — используем clickhouse_ticker из CR.instruments
        document.getElementById('cr-sel-all')?.addEventListener('click', () => {
            CR.selected = (CR.instruments || []).map(i => i.ticker);
            renderAll();
        });
        document.getElementById('cr-sel-none')?.addEventListener('click', () => { CR.selected = []; renderAll(); });
        document.getElementById('cr-sel-top10')?.addEventListener('click', () => {
            CR.selected = (CR.instruments || []).slice(0, 10).map(i => i.ticker);
            renderAll();
        });
    
        // Поиск по symbol и name
        document.getElementById('cr-ticker-search')?.addEventListener('input', e => {
            const q = e.target.value.toLowerCase();
            document.querySelectorAll('.cr-ticker-item').forEach(el => {
                const sym  = el.querySelector('.cr-ti-sym')?.textContent  || '';
                const name = el.querySelector('.cr-ti-name')?.textContent || '';
                el.style.display = (sym + ' ' + name).toLowerCase().includes(q) ? '' : 'none';
            });
        });
    
        // Делегирование на контейнер — работает даже после перерисовки дочерних элементов
        document.getElementById('cr-ticker-list')?.addEventListener('change', e => {
            const cb = e.target.closest('input[type="checkbox"]');
            if (!cb) return;
            const ticker = cb.value;
            if (cb.checked) {
                if (!CR.selected.includes(ticker)) CR.selected.push(ticker);
            } else {
                CR.selected = CR.selected.filter(s => s !== ticker);
            }
            cb.closest('.cr-ticker-item')?.classList.toggle('cr-ticker-on', cb.checked);
            const counter = document.querySelector('.cr-sel-count');
            if (counter) counter.textContent = `${CR.selected.length} / ${(CR.instruments || []).length}`;
        });
    
        // Run button
        document.getElementById('cr-run-btn')?.addEventListener('click', runAnalysis);
    }
    
    // ════════════════════════════════════════════════════════════════
    // API CALLS
    // ════════════════════════════════════════════════════════════════
    
    async function runAnalysis() {
        if (CR.running) return;
        CR.running = true;
        updateRunBtn(true);
    
        try {
            if (CR.tab === 'heatmap')   await runHeatmap();
            if (CR.tab === 'portfolio') await runPortfolio();
            if (CR.tab === 'frontier')  await runFrontier();
            if (CR.tab === 'mode')      await runMode();
        } catch(e) { alert('Error: ' + e.message); console.error(e); }
        finally { CR.running = false; updateRunBtn(false); }
    }
    
    function updateRunBtn(running) {
        const btn = document.getElementById('cr-run-btn');
        if (!btn) return;
        btn.disabled = running;
        const labels = { heatmap:'🌡 Build Heat Map', portfolio:'🏗 Build Portfolio', frontier:'📈 Run Frontier', mode:'🛡 Detect Mode' };
        btn.innerHTML = running ? '<span class="cr-spin"></span> Computing...' : labels[CR.tab];
    }
    
    async function runHeatmap() {
        if (CR.selected.length < 2) { alert('Select at least 2 instruments'); return; }
        const resp = await apiFetch('/api/correlation/matrix', {
            tickers: CR.selected, table: CR.table, days: CR.days,
        });
        CR.matrix = resp;
        refreshMain();
    }
    
    async function runPortfolio() {
        if (CR.selected.length < 2) { alert('Select at least 2 instruments'); return; }
        const method = document.getElementById('cr-method')?.value || 'min_corr';
        const n      = parseInt(document.getElementById('cr-n')?.value) || 5;
        const resp   = await apiFetch('/api/correlation/portfolio', {
            tickers: CR.selected, table: CR.table, days: CR.days, method, n,
        });
        CR.portfolio = resp;
        refreshMain();
    }
    
    async function runFrontier() {
        if (CR.selected.length < 2) { alert('Select at least 2 instruments'); return; }
        const sims = parseInt(document.getElementById('cr-sims')?.value) || 500;
        const resp = await apiFetch('/api/correlation/frontier', {
            tickers: CR.selected, table: CR.table, days: CR.days, simulations: sims,
        });
        CR.frontier = resp;
        refreshMain();
    }
    
    async function runMode() {
        // Читаем группы из инпутов
        ['equity','crypto','bonds','gold','other'].forEach(g => {
            const inp = document.getElementById(`cr-grp-${g}`);
            if (inp) CR.groups[g] = inp.value.split(',').map(s=>s.trim()).filter(Boolean);
        });
        const days = parseInt(document.getElementById('cr-mode-days')?.value) || 30;
        const resp = await apiFetch('/api/correlation/mode', {
            assetGroups: CR.groups, table: CR.table, days,
        });
        CR.mode = resp;
        refreshMain();
    }
    
    async function apiFetch(url, body) {
        const resp = await fetch(url, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!resp.ok) { const e = await resp.json().catch(()=>({})); throw new Error(e.error || resp.statusText); }
        return resp.json();
    }
    
    // ════════════════════════════════════════════════════════════════
    // CHARTS
    // ════════════════════════════════════════════════════════════════
    
    function ensureChartJS(cb) {
        if (window.Chart) { cb(); return; }
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
        s.onload = cb; document.head.appendChild(s);
    }
    
    function destroyCharts() {
        Object.values(CR.charts).forEach(c => { try{c.destroy();}catch(_){} }); CR.charts = {};
    }
    
    function drawCharts() {
        ensureChartJS(() => {
            if (CR.tab === 'portfolio' && CR.portfolio) drawPieChart();
            if (CR.tab === 'frontier'  && CR.frontier)  drawFrontierChart();
        });
    }
    
    function drawPieChart() {
        const canvas = document.getElementById('cr-pie-chart'); if (!canvas) return;
        const { assets, weights } = CR.portfolio.portfolio;
        const colors = ['#4a9eff','#4caf50','#ff9800','#9c27b0','#ef5350','#00bcd4','#ffeb3b','#795548','#607d8b','#e91e63'];
        CR.charts['pie'] = new Chart(canvas, {
            type: 'doughnut',
            data: { labels: assets, datasets: [{ data: assets.map(t=>weights[t]), backgroundColor: colors }] },
            options: {
                plugins: { legend: { position:'right', labels:{ color:'#c8ccd8', font:{size:11} } } },
                cutout: '60%',
            },
        });
    }
    
    function drawFrontierChart() {
        const canvas = document.getElementById('cr-frontier-chart'); if(!canvas) return;
        const { points, optimal } = CR.frontier;
        // Цвет точек по Sharpe
        const maxS = Math.max(...points.map(p=>p.sharpe));
        const minS = Math.min(...points.map(p=>p.sharpe));
        const pData = points.map(p => ({ x: p.vol, y: p.ret }));
        const colors = points.map(p => {
            const t = maxS > minS ? (p.sharpe - minS) / (maxS - minS) : 0.5;
            const r = Math.round(239 + (76-239)*t), g = Math.round(83 + (175-83)*t), b = Math.round(80 + (80-80)*t);
            return `rgba(${r},${g},${b},0.5)`;
        });
        CR.charts['frontier'] = new Chart(canvas, {
            type: 'scatter',
            data: { datasets: [
                { label: 'Portfolios', data: pData, backgroundColor: colors, pointRadius: 3 },
                { label: 'Optimal', data: optimal ? [{x:optimal.vol, y:optimal.ret}] : [],
                  backgroundColor:'#f5a623', pointRadius:8, pointStyle:'star' },
            ]},
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { labels:{ color:'#c8ccd8', font:{size:11} } } },
                scales: {
                    x: { title:{display:true,text:'Portfolio Vol %/day',color:'#787b86'}, ticks:{color:'#787b86'}, grid:{color:'rgba(255,255,255,.05)'} },
                    y: { title:{display:true,text:'Diversification Score',color:'#787b86'}, ticks:{color:'#787b86'}, grid:{color:'rgba(255,255,255,.06)'} },
                },
            },
        });
    }
    
    // ════════════════════════════════════════════════════════════════
    // HELPERS
    // ════════════════════════════════════════════════════════════════
    
    function esc(s) { return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    
    function corrColor(v) {
        // -1=синий, 0=белый/серый, +1=красный
        if (v >= 0) {
            const t = v;
            const r = Math.round(13 + (239-13)*t);
            const g = Math.round(15 + (83-15)*t);
            const b = Math.round(26 + (80-26)*t);
            return `rgba(${r},${g},${b},${0.15 + t*0.7})`;
        } else {
            const t = -v;
            const r = Math.round(13 + (33-13)*t);
            const g = Math.round(15 + (150-15)*t);
            const b = Math.round(26 + (243-26)*t);
            return `rgba(${r},${g},${b},${0.15 + t*0.7})`;
        }
    }
    
    function avgColor(v) { return v < 0.2 ? 'cr-pos' : v > 0.5 ? 'cr-neg' : 'cr-neu'; }
    
    function kpi(l, v, cls='') {
        return `<div class="cr-kpi"><div class="cr-kpi-l">${l}</div><div class="cr-kpi-v ${cls}">${v}</div></div>`;
    }
    
    function emptyState(icon, title, text) {
        return `<div class="cr-empty">
            <div style="font-size:36px;opacity:.3">${icon}</div>
            <div class="cr-empty-t">${title}</div>
            <div class="cr-empty-s">${text.replace(/\n/g,'<br>')}</div>
        </div>`;
    }
    
    // ════════════════════════════════════════════════════════════════
    // CSS
    // ════════════════════════════════════════════════════════════════
    
    function injectCSS() {
        if (document.getElementById('cr-css')) return;
        const s = document.createElement('style'); s.id = 'cr-css';
        s.textContent = `
    .sb-tab-corr.sb-tab-active{color:#00bcd4;border-bottom-color:#00bcd4}
    .cr-root{display:flex;height:100%;min-height:0;font-size:12px;color:#c8ccd8;background:#080a12}
    .cr-sidebar{width:220px;min-width:220px;border-right:1px solid #141826;overflow-y:auto;background:#0b0d16;flex-shrink:0}
    .cr-main{flex:1;overflow-y:auto;padding:10px;min-height:0}
    .cr-logo{padding:6px 12px 8px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#00bcd4;border-bottom:1px solid #141826}
    .cr-vtabs{display:flex;flex-direction:column;border-bottom:1px solid #141826}
    .cr-vtab{padding:8px 12px;background:transparent;border:none;border-left:2px solid transparent;text-align:left;color:#444c70;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .12s}
    .cr-vtab:hover{color:#c8ccd8;background:rgba(255,255,255,.02)}
    .cr-vtab-a{color:#00bcd4;border-left-color:#00bcd4;background:rgba(0,188,212,.06)}
    .cr-sb-sect{padding:8px 10px;border-bottom:1px solid #141826}
    .cr-sb-h{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#444c70;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center}
    .cr-sel-count{font-size:10px;color:#00bcd4;font-weight:600}
    .cr-field{margin-bottom:6px}
    .cr-lbl{display:block;font-size:10px;color:#6a7090;margin-bottom:2px}
    .cr-inp{width:100%;box-sizing:border-box;background:#111320;border:1px solid #1a1e30;color:#c8ccd8;padding:4px 7px;border-radius:3px;font-size:11px;outline:none;font-family:inherit}
    .cr-inp:focus{border-color:#00bcd4}
    .cr-sel{width:100%;box-sizing:border-box;background:#111320;border:1px solid #1a1e30;color:#c8ccd8;padding:4px 5px;border-radius:3px;font-size:11px;outline:none;font-family:inherit}
    .cr-search{width:100%;box-sizing:border-box;background:#111320;border:1px solid #1a1e30;color:#c8ccd8;padding:4px 7px;border-radius:3px;font-size:11px;outline:none;font-family:inherit;margin-bottom:4px}
    .cr-ticker-sect{padding:6px 10px!important;max-height:260px;display:flex;flex-direction:column}
    .cr-ticker-actions{display:flex;gap:4px;margin-bottom:5px}
    .cr-sm-btn{padding:2px 7px;background:#111320;border:1px solid #1a1e30;border-radius:3px;color:#6a7090;font-size:10px;cursor:pointer;font-family:inherit}
    .cr-sm-btn:hover{color:#c8ccd8}
    .cr-ticker-list{overflow-y:auto;flex:1}
    .cr-ticker-item{display:flex;align-items:center;gap:5px;padding:3px 4px;border-radius:3px;cursor:pointer;font-size:11px;color:#6a7090;transition:background .1s}
    .cr-ticker-item:hover{background:rgba(255,255,255,.03);color:#c8ccd8}
    .cr-ticker-on{color:#c8ccd8}
    .cr-ti-icon{flex-shrink:0;font-size:11px;width:16px;text-align:center}
    .cr-ti-sym{font-weight:700;font-size:11px;flex-shrink:0;min-width:32px}
    .cr-ti-name{font-size:10px;color:#6a7090;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
    .cr-ticker-on .cr-ti-name{color:#9598a1}
    .cr-ticker-item input{accent-color:#00bcd4;flex-shrink:0}
    .cr-run-btn{width:100%;margin-top:6px}
    .cr-spin{display:inline-block;width:9px;height:9px;border:2px solid rgba(255,255,255,.2);border-top-color:#fff;border-radius:50%;animation:cr-s .7s linear infinite;vertical-align:middle;margin-right:3px}
    @keyframes cr-s{to{transform:rotate(360deg)}}
    .cr-hint{font-size:10px;color:#2a3050;line-height:1.6}
    
    /* Main */
    .cr-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;min-height:260px;text-align:center;gap:10px;padding:20px}
    .cr-empty-t{font-size:15px;font-weight:700;color:#444c70}
    .cr-empty-s{font-size:11px;color:#2a3050;line-height:2}
    .cr-block{background:#0d0f1a;border:1px solid #141826;border-radius:6px;margin-bottom:12px;overflow:hidden}
    .cr-bh{display:flex;align-items:center;gap:10px;padding:8px 12px;background:#0b0d16;border-bottom:1px solid #141826;flex-wrap:wrap}
    .cr-bt{font-weight:700;font-size:12px;flex:1}
    .cr-bsub{font-size:10px;color:#444c70}
    .cr-sect-hdr{padding:8px 12px 3px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#444c70}
    .cr-kpi4{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#141826;margin:1px}
    .cr-kpi{padding:8px 10px;background:#0d0f1a}
    .cr-kpi-l{font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:#444c70;margin-bottom:2px}
    .cr-kpi-v{font-size:14px;font-weight:700}
    .cr-pos{color:#4caf50}.cr-neg{color:#ef5350}.cr-neu{color:#9598a1}
    .cr-tbl{width:100%;border-collapse:collapse;font-size:11px;padding:0 6px}
    .cr-tbl th{padding:5px 7px;text-align:left;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#444c70;border-bottom:1px solid #141826;white-space:nowrap}
    .cr-tbl td{padding:4px 7px;border-bottom:1px solid rgba(255,255,255,.03)}
    
    /* Heatmap */
    .cr-legend{display:flex;flex-direction:column;gap:2px;margin-left:auto}
    .cr-leg-bar{height:8px;width:120px;background:linear-gradient(90deg,#2196f3,#0d0f1a,#ef5350);border-radius:4px}
    .cr-leg-labels{display:flex;justify-content:space-between;font-size:9px;color:#444c70;width:120px}
    .cr-hm-wrap{overflow:auto;padding:6px}
    .cr-hm-tbl{border-collapse:collapse;font-size:10px}
    .cr-hm-corner{min-width:60px}
    .cr-hm-th{padding:3px 5px;text-align:center;color:#6a7090;font-weight:600;white-space:nowrap;min-width:42px;font-size:10px}
    .cr-avg-th{color:#00bcd4}
    .cr-hm-rlabel{padding:3px 8px 3px 4px;color:#6a7090;white-space:nowrap;font-weight:600;min-width:60px}
    .cr-hm-cell{text-align:center;padding:4px 3px;font-size:10px;font-weight:600;color:#c8ccd8;min-width:42px;white-space:nowrap;cursor:default;transition:outline .1s}
    .cr-hm-cell:hover{outline:1px solid #fff;z-index:10;position:relative}
    .cr-hm-avg{padding:4px 8px;font-weight:700;font-size:10px;text-align:center}
    .cr-clusters{padding:6px 12px;display:flex;flex-wrap:wrap;gap:6px}
    .cr-cluster-tag{display:flex;gap:4px;background:rgba(239,83,80,.08);border:1px solid rgba(239,83,80,.3);border-radius:4px;padding:4px 8px}
    .cr-cluster-tag span{font-size:10px;color:#ef5350;font-weight:600}
    .cr-hint-box{margin:4px 12px 8px;font-size:11px;color:#6a7090;background:rgba(239,83,80,.06);padding:6px 10px;border-radius:4px;border-left:2px solid #ef5350}
    .cr-ok-box{margin:4px 12px 8px;font-size:11px;color:#4caf50;background:rgba(76,175,80,.06);padding:6px 10px;border-radius:4px;border-left:2px solid #4caf50}
    .cr-rank-list{padding:4px 12px 10px}
    .cr-rank-row{display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.02)}
    .cr-rank-n{font-size:10px;color:#444c70;width:16px;flex-shrink:0;text-align:right}
    .cr-rank-t{font-size:11px;font-weight:600;width:70px;flex-shrink:0}
    .cr-rank-bar-bg{flex:1;height:4px;background:#141826;border-radius:2px;overflow:hidden}
    .cr-rank-bar{height:100%;border-radius:2px;transition:width .4s}
    .cr-rank-v{font-size:11px;font-weight:700;width:52px;text-align:right;flex-shrink:0;font-family:monospace}
    
    /* Portfolio */
    .cr-port-grid{display:grid;grid-template-columns:220px 1fr;gap:1px;background:#141826;margin:1px}
    .cr-port-grid>div{background:#0d0f1a;padding:10px 12px}
    .cr-pie-wrap{height:180px;display:flex;align-items:center;justify-content:center}
    .cr-w-bar-bg{display:inline-block;width:60px;height:4px;background:#141826;border-radius:2px;vertical-align:middle;margin-right:5px;overflow:hidden}
    .cr-w-bar{height:100%;background:#00bcd4;border-radius:2px}
    .cr-excluded{padding:4px 12px 10px}
    .cr-excl-row{display:flex;gap:10px;align-items:center;padding:3px 0;font-size:11px;border-bottom:1px solid rgba(255,255,255,.02)}
    .cr-opt-weights{padding:4px 12px 10px}
    .cr-chart-wrap{padding:6px 10px}
    
    /* Frontier */
    
    /* Mode */
    .cr-mode-banner{display:flex;align-items:flex-start;gap:14px;margin:10px 12px;padding:14px 16px;border:1px solid;border-radius:8px}
    .cr-mode-ico{font-size:32px;flex-shrink:0}
    .cr-mode-label{font-size:20px;font-weight:700;margin-bottom:3px}
    .cr-mode-conf{font-size:11px;color:#9598a1;margin-bottom:3px}
    .cr-mode-desc{font-size:12px;color:#c8ccd8;margin-bottom:2px}
    .cr-mode-reason{font-size:11px;color:#6a7090}
    .cr-conf-bar-bg{height:6px;background:#141826;border-radius:3px;overflow:hidden;margin:4px 12px 10px}
    .cr-conf-bar{height:100%;border-radius:3px;transition:width .5s}
    .cr-signals{padding:4px 12px 10px}
    .cr-signal-row{display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.03)}
    .cr-sig-icon{width:20px;text-align:center;flex-shrink:0}
    .cr-sig-group{width:90px;font-size:11px;color:#9598a1;flex-shrink:0;text-transform:capitalize}
    .cr-sig-bar-bg{flex:1;height:4px;background:#141826;border-radius:2px;overflow:hidden}
    .cr-sig-bar{height:100%;border-radius:2px;max-width:100%}
    .cr-sig-val{width:60px;text-align:right;font-size:11px;font-weight:700;font-family:monospace;flex-shrink:0}
    .cr-implications{padding:4px 12px 10px}
    .cr-impl{font-size:11px;padding:4px 0;color:#9598a1;border-bottom:1px solid rgba(255,255,255,.02)}
    `;
        document.head.appendChild(s);
    }
    
    // ════════════════════════════════════════════════════════════════
    // INIT
    // ════════════════════════════════════════════════════════════════
    
    injectTab();
    console.log('[CorrelationUI] v1.0 loaded');
    
    })(); }