

if (window._decayUILoaded) {} else { window._decayUILoaded = true; (function () {
    'use strict';
    
    // ════════════════════════════════════════════════════════════════
    // STATE
    // ════════════════════════════════════════════════════════════════
    
    const DM = {
        running:    false,
        result:     null,    // результат analyzeDecay()
        activeSetup: null,   // выбранный сетап в bySetup режиме
        cfg: {
            windowSize:  'month',
            minWindows:  3,
            setupFilter: '',
        },
        charts: {},
    };
    
    // ════════════════════════════════════════════════════════════════
    // INJECT TAB INTO 🧠 AI PANEL
    // Добавляем вкладку "📉 Decay" в существующий ai-vtabs блок
    // ════════════════════════════════════════════════════════════════
    
    function injectDecayTab() {
        const t = setInterval(() => {
            const vtabs = document.querySelector('.ai-tabs-vert');
            if (!vtabs) return;
            clearInterval(t);
            if (document.querySelector('[data-aitab="decay"]')) return;
    
            injectCSS();
    
            // Добавляем кнопку в вертикальный таб-бар AI
            const btn = document.createElement('button');
            btn.className = 'ai-vtab';
            btn.dataset.aitab = 'decay';
            btn.textContent = '📉 Alpha Decay';
            vtabs.appendChild(btn);
    
            // Кликаем — рендерим через существующий механизм AI панели
            btn.addEventListener('click', () => {
                document.querySelectorAll('.ai-vtab').forEach(b => b.classList.remove('ai-vtab-a'));
                btn.classList.add('ai-vtab-a');
    
                const main = document.getElementById('ai-main');
                if (!main) return;
    
                // Показываем сайдбар для decay
                renderDecaySidebar();
                renderDecayMain(main);
            });
        }, 300);
    }
    
    // ════════════════════════════════════════════════════════════════
    // SIDEBAR
    // ════════════════════════════════════════════════════════════════
    
    function renderDecaySidebar() {
        const sb = document.getElementById('ai-sidebar');
        if (!sb) return;
    
        // Сохраняем лого и tabbar, заменяем только секции под ними
        const logo  = sb.querySelector('.ai-logo');
        const vtabs = sb.querySelector('.ai-tabs-vert');
    
        sb.innerHTML = '';
        if (logo)  sb.appendChild(logo);
        if (vtabs) sb.appendChild(vtabs);
    
        const c = DM.cfg;
    
        // Выбор сетапа (из результата если есть)
        let setupOptions = '<option value="">All setups</option>';
        if (DM.result?.setupNames) {
            for (const name of DM.result.setupNames) {
                setupOptions += `<option value="${esc(name)}" ${c.setupFilter === name ? 'selected' : ''}>${esc(name)}</option>`;
            }
        }
    
        const sect = document.createElement('div');
        sect.className = 'ai-sb-sect';
        sect.innerHTML = `
            <div class="ai-sb-h">Analysis Settings</div>
    
            <div class="ai-sb-row">
                <label class="ai-sb-lbl">Window Size</label>
                <select class="ai-sb-inp" id="dm-window-size" style="width:90px">
                    <option value="month"   ${c.windowSize==='month'   ?'selected':''}>Monthly</option>
                    <option value="quarter" ${c.windowSize==='quarter' ?'selected':''}>Quarterly</option>
                    <option value="year"    ${c.windowSize==='year'    ?'selected':''}>Yearly</option>
                    <option value="20"      ${c.windowSize==='20'      ?'selected':''}>20 trades</option>
                    <option value="50"      ${c.windowSize==='50'      ?'selected':''}>50 trades</option>
                </select>
            </div>
    
            <div class="ai-sb-row">
                <label class="ai-sb-lbl">Min Windows</label>
                <input class="ai-sb-inp ai-sb-inp-sm" id="dm-min-windows" type="number" min="2" max="20" value="${c.minWindows}">
            </div>
    
            <div class="ai-sb-row">
                <label class="ai-sb-lbl">Setup</label>
                <select class="ai-sb-inp" id="dm-setup-filter" style="width:90px">
                    ${setupOptions}
                </select>
            </div>
    
            <div class="ai-sb-h" style="margin-top:10px">Data Source</div>
            <div class="dm-trades-info" id="dm-trades-info">
                ${getTradesInfo()}
            </div>
    
            <button class="sb-btn sb-btn-srv ai-run-btn" id="dm-run-btn" ${DM.running?'disabled':''}>
                ${DM.running
                    ? '<span class="ai-spin"></span> Analyzing...'
                    : '📉 Run Decay Analysis'}
            </button>
            <div class="ai-hint">Uses trades from the last Server Backtest. Run a backtest first.</div>
        `;
        sb.appendChild(sect);
    
        bindSidebarEvents();
    }
    
    function getTradesInfo() {
        const trades = getLastTrades();
        if (!trades || !trades.length) {
            return `<div class="dm-no-trades">⚠️ No trades found.<br>Run a Server BT first.</div>`;
        }
        const setups = [...new Set(trades.map(t => t.setupName).filter(Boolean))];
        return `<div class="dm-trades-ok">
            ✓ <strong>${trades.length}</strong> trades loaded<br>
            <span style="color:#6a7090">${setups.length} setup(s): ${setups.slice(0,3).join(', ')}${setups.length>3?'…':''}</span>
        </div>`;
    }
    
    function bindSidebarEvents() {
        document.getElementById('dm-window-size')?.addEventListener('change', e => {
            const v = e.target.value;
            DM.cfg.windowSize = isNaN(v) ? v : Number(v);
        });
        document.getElementById('dm-min-windows')?.addEventListener('change', e => {
            DM.cfg.minWindows = parseInt(e.target.value) || 3;
        });
        document.getElementById('dm-setup-filter')?.addEventListener('change', e => {
            DM.cfg.setupFilter = e.target.value;
        });
        document.getElementById('dm-run-btn')?.addEventListener('click', runDecayAnalysis);
    }
    
    // ════════════════════════════════════════════════════════════════
    // MAIN RENDER
    // ════════════════════════════════════════════════════════════════
    
    function renderDecayMain(main) {
        destroyCharts();
        main.innerHTML = '';
    
        if (!DM.result) {
            main.innerHTML = emptyState();
            return;
        }
    
        // bySetup режим — несколько сетапов
        if (DM.result.bySetup) {
            main.innerHTML = renderMultiSetup(DM.result);
        } else if (DM.result.error) {
            main.innerHTML = `<div class="ai-empty">
                <div style="font-size:28px">⚠️</div>
                <div class="ai-empty-t">Analysis Failed</div>
                <div class="ai-empty-s">${esc(DM.result.error)}</div>
            </div>`;
        } else {
            main.innerHTML = renderSingleReport(DM.result, true);
        }
    
        setTimeout(() => drawAllCharts(), 80);
    }
    
    function emptyState() {
        return `<div class="ai-empty">
            <div style="font-size:40px;opacity:.25">📉</div>
            <div class="ai-empty-t">Alpha Decay Monitor</div>
            <div class="ai-empty-s">
                Detects when your setup is losing its edge.<br><br>
                <strong>How it works:</strong><br>
                Splits backtest trades into time windows → tracks<br>
                WinRate, ProfitFactor and Expectancy over time →<br>
                linear regression detects downward trend.<br><br>
                <strong>Outputs:</strong><br>
                Decay level · Half-Life · Stability Score · Forecast<br><br>
                Run a Server Backtest first, then click<br>
                <strong>📉 Run Decay Analysis</strong>
            </div>
        </div>`;
    }
    
    // ── Несколько сетапов ────────────────────────────────────────
    
    function renderMultiSetup(result) {
        const { bySetup, overall, setupNames } = result;
    
        // Сводная таблица сетапов
        const rows = Object.entries(bySetup).map(([name, r]) => {
            const meta = { none:'✅', mild:'🟡', moderate:'🟠', critical:'🔴' };
            const ic   = meta[r.decayLevel] || '❓';
            const pfCls = r.pfChange < -10 ? 'ai-neg' : r.pfChange > 0 ? 'ai-pos' : '';
            return `<tr class="dm-setup-row ${DM.activeSetup===name?'dm-active-row':''}" data-setup="${esc(name)}">
                <td style="font-weight:700">${esc(name)}</td>
                <td><span class="dm-badge" style="background:${r.decayColor}20;color:${r.decayColor}">${ic} ${r.decayLabel}</span></td>
                <td>${r.current.profitFactor}</td>
                <td>${r.current.winRate}%</td>
                <td class="${pfCls}">${r.pfChange >= 0 ? '+' : ''}${r.pfChange}%</td>
                <td>${r.halfLifeLabel || '—'}</td>
                <td><div class="dm-stab-bar-bg"><div class="dm-stab-bar" style="width:${r.stability.overall}%;background:${stabColor(r.stability.overall)}"></div></div>${r.stability.overall}</td>
            </tr>`;
        }).join('');
    
        const detail = DM.activeSetup && bySetup[DM.activeSetup]
            ? renderSingleReport(bySetup[DM.activeSetup], false, DM.activeSetup)
            : (overall ? renderSingleReport(overall, false, 'Overall') : '');
    
        return `
        <div class="ai-block" style="margin-bottom:10px">
            <div class="ai-bh">
                <span class="ai-bt">📉 Alpha Decay — All Setups</span>
                <span class="ai-bsub">${setupNames.length} setups · click row for details</span>
            </div>
            <div style="overflow-x:auto;padding:4px 6px">
            <table class="ai-tbl dm-summary-tbl">
                <thead><tr>
                    <th>Setup</th><th>Decay</th><th>PF Now</th><th>WR Now</th>
                    <th>PF Change</th><th>Half-Life</th><th>Stability</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
            </div>
        </div>
        <div id="dm-detail">${detail}</div>`;
    }
    
    // ── Один сетап ───────────────────────────────────────────────
    
    function renderSingleReport(r, standalone = true, titleSuffix = '') {
        if (r.error) return `<div class="ai-block"><div class="ai-nodata">⚠️ ${esc(r.error)}</div></div>`;
    
        const pfCls  = r.pfChange < -15 ? 'ai-neg' : r.pfChange < 0 ? 'dm-warn' : 'ai-pos';
        const wrCls  = r.wrChange < -5  ? 'ai-neg' : r.wrChange < 0 ? 'dm-warn' : 'ai-pos';
        const title  = standalone ? '📉 Decay Analysis' : `📉 ${titleSuffix || 'Setup Detail'}`;
    
        return `
        <div class="ai-block" id="dm-report-block">
            <div class="ai-bh">
                <span class="ai-bt">${title}</span>
                <span class="ai-bsub">${r.totalTrades} trades · ${r.totalWindows} ${r.windowSize} windows</span>
            </div>
    
            <!-- VERDICT BANNER -->
            <div class="dm-verdict" style="border-color:${r.decayColor};background:${r.decayColor}18">
                <div class="dm-verdict-icon">${r.decayIcon}</div>
                <div class="dm-verdict-body">
                    <div class="dm-verdict-level" style="color:${r.decayColor}">${r.decayLabel} Decay</div>
                    <div class="dm-verdict-sub">
                        ${r.halfLifeLabel ? `Half-life: <strong>${r.halfLifeLabel}</strong> · ` : ''}
                        Stability: <strong>${r.stability.overall}/100</strong>
                        ${r.breakevenIn !== null ? ` · Breakeven in ~<strong>${r.breakevenIn}</strong> ${typeof r.windowSize==='number'?'windows':r.windowSize+'s'}` : ''}
                    </div>
                </div>
            </div>
    
            <!-- KPI ROW: baseline vs current -->
            <div class="ai-sect-hdr">Baseline → Current Performance</div>
            <div class="dm-kpi-compare">
                <div class="dm-kpi-col">
                    <div class="dm-kpi-period">Baseline (first 25%)</div>
                    ${kpi2('Profit Factor', r.baseline.profitFactor)}
                    ${kpi2('Win Rate',      r.baseline.winRate + '%')}
                </div>
                <div class="dm-kpi-arrow">→</div>
                <div class="dm-kpi-col">
                    <div class="dm-kpi-period">Current (last window)</div>
                    ${kpi2('Profit Factor', r.current.profitFactor)}
                    ${kpi2('Win Rate',      r.current.winRate + '%')}
                </div>
                <div class="dm-kpi-col dm-kpi-delta">
                    <div class="dm-kpi-period">Δ Change</div>
                    <div class="dm-kpi-val ${pfCls}">${r.pfChange >= 0 ? '+' : ''}${r.pfChange}%</div>
                    <div class="dm-kpi-val ${wrCls}">${r.wrChange >= 0 ? '+' : ''}${r.wrChange}pp</div>
                </div>
            </div>
    
            <!-- PROFIT FACTOR CHART + TREND -->
            <div class="ai-sect-hdr">Profit Factor over Time</div>
            <div class="ai-chart-wrap" style="height:200px">
                <canvas id="dm-pf-chart"></canvas>
            </div>
    
            <!-- WIN RATE CHART -->
            <div class="ai-sect-hdr">Win Rate & Expectancy over Time</div>
            <div class="ai-chart-wrap" style="height:180px">
                <canvas id="dm-wr-chart"></canvas>
            </div>
    
            <!-- STABILITY SCORES -->
            <div class="ai-sect-hdr">Stability Scores</div>
            <div class="dm-stab-grid">
                ${stabCard('Profit Factor', r.stability.profitFactor)}
                ${stabCard('Win Rate',      r.stability.winRate)}
                ${stabCard('Expectancy',    r.stability.expectancy)}
                ${stabCard('Overall',       r.stability.overall, true)}
            </div>
    
            <!-- REGRESSION STATS -->
            <div class="ai-sect-hdr">Regression Statistics</div>
            <div class="dm-reg-grid">
                ${regCard('Profit Factor', r.regression.profitFactor, 'PF')}
                ${regCard('Win Rate',      r.regression.winRate,      'WR')}
                ${regCard('Expectancy',    r.regression.expectancy,   'EXP')}
            </div>
    
            <!-- BEST / WORST PERIODS -->
            <div class="dm-bw-grid">
                <div>
                    <div class="ai-sect-hdr">🏆 Best Periods</div>
                    ${periodsTable(r.bestPeriods, 'best')}
                </div>
                <div>
                    <div class="ai-sect-hdr">💀 Worst Periods</div>
                    ${periodsTable(r.worstPeriods, 'worst')}
                </div>
            </div>
    
            <!-- PERIOD TABLE -->
            <div class="ai-sect-hdr">All Windows</div>
            <div style="overflow-x:auto;padding:4px 6px">
            <table class="ai-tbl">
                <thead><tr>
                    <th>Period</th><th>Trades</th><th>Win Rate</th>
                    <th>Profit Factor</th><th>Expectancy</th><th>Total PnL</th><th>Max DD</th>
                </tr></thead>
                <tbody>
                ${r.windows.map((w, i) => {
                    const pfCl = w.profitFactor >= 1.5 ? 'ai-pos' : w.profitFactor < 1.0 ? 'ai-neg' : '';
                    const wrCl = w.winRate >= 55 ? 'ai-pos' : w.winRate < 40 ? 'ai-neg' : '';
                    const isLast = i === r.windows.length - 1;
                    return `<tr ${isLast ? 'class="dm-last-row"' : ''}>
                        <td style="white-space:nowrap">${esc(w.label)}</td>
                        <td>${w.total}</td>
                        <td class="${wrCl}">${w.winRate}%</td>
                        <td class="${pfCl}">${w.profitFactor}</td>
                        <td>${w.expectancy}</td>
                        <td class="${w.totalPnl >= 0 ? 'ai-pos' : 'ai-neg'}">${w.totalPnl >= 0 ? '+' : ''}${w.totalPnl}</td>
                        <td class="ai-neg">${w.maxDD}%</td>
                    </tr>`;
                }).join('')}
                </tbody>
            </table>
            </div>
    
            <!-- RECOMMENDATION -->
            <div class="ai-sect-hdr">Recommendation</div>
            <div class="dm-recommendation" style="border-left-color:${r.decayColor}">
                ${r.recommendation.map(line => `<div class="dm-rec-line">${esc(line)}</div>`).join('')}
            </div>
        </div>`;
    }
    
    // ════════════════════════════════════════════════════════════════
    // EVENTS
    // ════════════════════════════════════════════════════════════════
    
    function bindMainEvents() {
        // Клик по строке таблицы сетапов
        document.querySelectorAll('.dm-setup-row').forEach(row => {
            row.addEventListener('click', () => {
                DM.activeSetup = row.dataset.setup;
                renderDecaySidebar();
    
                const detail = document.getElementById('dm-detail');
                if (detail && DM.result?.bySetup?.[DM.activeSetup]) {
                    destroyCharts();
                    detail.innerHTML = renderSingleReport(
                        DM.result.bySetup[DM.activeSetup], false, DM.activeSetup
                    );
                    document.querySelectorAll('.dm-setup-row').forEach(r => r.classList.remove('dm-active-row'));
                    row.classList.add('dm-active-row');
                    setTimeout(() => drawAllCharts(), 80);
                }
            });
        });
    }
    
    // ════════════════════════════════════════════════════════════════
    // API
    // ════════════════════════════════════════════════════════════════
    
    function runDecayAnalysis() {
        if (DM.running) return;
    
        const trades = getLastTrades();
        if (!trades || !trades.length) {
            alert('No trades found. Run a Server Backtest first.');
            return;
        }
    
        DM.running = true;
        updateRunBtn(true);
    
        // Всё считается локально в браузере — никаких API-запросов
        setTimeout(() => {
            try {
                const t0 = performance.now();
                DM.result = analyzeDecay(trades, {
                    windowSize:  DM.cfg.windowSize,
                    minWindows:  DM.cfg.minWindows,
                    setupFilter: DM.cfg.setupFilter || null,
                });
                DM.result.computeMs = +(performance.now() - t0).toFixed(1);
                DM.activeSetup = null;
                console.log('[AlphaDecay] computed in', DM.result.computeMs, 'ms,', trades.length, 'trades');
            } catch(e) {
                DM.result = { error: e.message };
                console.error('[DecayUI]', e);
            } finally {
                DM.running = false;
                updateRunBtn(false);
            }
    
            renderDecaySidebar();
            const main = document.getElementById('ai-main');
            if (main) renderDecayMain(main);
            setTimeout(() => bindMainEvents(), 100);
        }, 20);
    }
    
    function updateRunBtn(loading) {
        const btn = document.getElementById('dm-run-btn');
        if (!btn) return;
        btn.disabled = loading;
        btn.innerHTML = loading
            ? '<span class="ai-spin"></span> Analyzing...'
            : '📉 Run Decay Analysis';
    }
    
    // Берём трейды из последнего бэктеста (точно как ai-ui.js и walkforward-ui.js)
    function getLastTrades() {
        if (window.SB_TRADES) {
            const t = window.SB_TRADES();
            if (t?.length) return t;
        }
        if (window._lastBacktestTrades?.length) return window._lastBacktestTrades;
        if (window._sbState?.trades?.length)    return window._sbState.trades;
        return null;
    }
    
    // ════════════════════════════════════════════════════════════════
    // CHARTS
    // ════════════════════════════════════════════════════════════════
    
    function destroyCharts() {
        Object.values(DM.charts).forEach(c => { try { c.destroy(); } catch(_) {} });
        DM.charts = {};
    }
    
    function ensureChartJS(cb) {
        if (window.Chart) { cb(); return; }
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
        s.onload = cb;
        document.head.appendChild(s);
    }
    
    function drawAllCharts() {
        ensureChartJS(() => {
            const r = DM.result?.bySetup?.[DM.activeSetup]
                ?? (DM.result?.overall ?? DM.result);
            if (!r || r.error || !r.series) return;
            drawPFChart(r);
            drawWRChart(r);
        });
    }
    
    function drawPFChart(r) {
        const canvas = document.getElementById('dm-pf-chart');
        if (!canvas) return;
    
        const s = r.series;
        const col = s.profitFactor.map(v =>
            v >= 1.5 ? 'rgba(76,175,80,0.7)' :
            v >= 1.0 ? 'rgba(255,152,0,0.7)' :
                       'rgba(239,83,80,0.7)'
        );
    
        DM.charts['pf'] = new Chart(canvas, {
            type: 'bar',
            data: {
                labels: s.labels,
                datasets: [
                    {
                        type: 'bar',
                        label: 'Profit Factor',
                        data: s.profitFactor,
                        backgroundColor: col,
                        borderRadius: 3,
                        order: 2,
                    },
                    {
                        type: 'line',
                        label: 'Trend',
                        data: s.trendPF,
                        borderColor: r.decayColor,
                        borderWidth: 2,
                        borderDash: [5, 3],
                        pointRadius: 0,
                        fill: false,
                        tension: 0,
                        order: 1,
                    },
                    {
                        type: 'line',
                        label: 'Breakeven (1.0)',
                        data: s.labels.map(() => 1.0),
                        borderColor: 'rgba(255,255,255,0.15)',
                        borderWidth: 1,
                        pointRadius: 0,
                        fill: false,
                        tension: 0,
                        order: 0,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { labels: { color: '#787b86', boxWidth: 12, font: { size: 10 } } },
                },
                scales: {
                    x: { ticks: { color: '#787b86', maxTicksLimit: 12, font: { size: 10 } }, grid: { display: false } },
                    y: {
                        ticks: { color: '#787b86' },
                        grid:  { color: 'rgba(255,255,255,.05)' },
                        min: 0,
                    },
                },
            },
        });
    }
    
    function drawWRChart(r) {
        const canvas = document.getElementById('dm-wr-chart');
        if (!canvas) return;
        const s = r.series;
    
        DM.charts['wr'] = new Chart(canvas, {
            type: 'line',
            data: {
                labels: s.labels,
                datasets: [
                    {
                        label: 'Win Rate %',
                        data: s.winRate,
                        borderColor: '#4a9eff',
                        backgroundColor: 'rgba(74,158,255,.08)',
                        borderWidth: 2,
                        pointRadius: 3,
                        fill: true,
                        tension: 0.3,
                        yAxisID: 'y',
                    },
                    {
                        label: 'Expectancy',
                        data: s.expectancy,
                        borderColor: '#ff9800',
                        backgroundColor: 'transparent',
                        borderWidth: 1.5,
                        pointRadius: 2,
                        fill: false,
                        tension: 0.3,
                        borderDash: [4, 2],
                        yAxisID: 'y2',
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { labels: { color: '#787b86', boxWidth: 12, font: { size: 10 } } },
                },
                scales: {
                    x: { ticks: { color: '#787b86', maxTicksLimit: 12, font: { size: 10 } }, grid: { display: false } },
                    y:  { position: 'left',  ticks: { color: '#787b86' }, grid: { color: 'rgba(255,255,255,.05)' } },
                    y2: { position: 'right', ticks: { color: '#ff9800' }, grid: { display: false } },
                },
            },
        });
    }
    
    // ════════════════════════════════════════════════════════════════
    // HELPERS
    // ════════════════════════════════════════════════════════════════
    
    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    
    function kpi2(label, value) {
        return `<div class="dm-kpi2">
            <div class="dm-kpi2-l">${label}</div>
            <div class="dm-kpi2-v">${value}</div>
        </div>`;
    }
    
    function stabCard(label, score, isMain = false) {
        const color = stabColor(score);
        return `<div class="dm-stab-card ${isMain ? 'dm-stab-main' : ''}">
            <div class="dm-stab-lbl">${label}</div>
            <div class="dm-stab-val" style="color:${color}">${score}</div>
            <div class="dm-stab-bar-bg">
                <div class="dm-stab-bar" style="width:${score}%;background:${color}"></div>
            </div>
        </div>`;
    }
    
    function stabColor(score) {
        return score >= 75 ? '#4caf50' : score >= 50 ? '#ff9800' : '#ef5350';
    }
    
    function regCard(label, reg, short) {
        const slopeCls = reg.slope < 0 ? 'ai-neg' : 'ai-pos';
        return `<div class="dm-reg-card">
            <div class="dm-reg-lbl">${label}</div>
            <div class="dm-reg-row">
                <span class="dm-reg-k">Slope</span>
                <span class="dm-reg-v ${slopeCls}">${reg.slope >= 0 ? '+' : ''}${reg.slope}</span>
            </div>
            <div class="dm-reg-row">
                <span class="dm-reg-k">R²</span>
                <span class="dm-reg-v">${reg.r2}</span>
            </div>
            <div class="dm-reg-row">
                <span class="dm-reg-k">Intercept</span>
                <span class="dm-reg-v">${reg.intercept}</span>
            </div>
        </div>`;
    }
    
    function periodsTable(periods, type) {
        if (!periods?.length) return '<div class="ai-nodata">—</div>';
        return `<table class="ai-tbl" style="font-size:10px">
            <thead><tr><th>Period</th><th>Trades</th><th>PF</th><th>WR</th><th>PnL</th></tr></thead>
            <tbody>
            ${periods.map(p => `<tr>
                <td style="white-space:nowrap">${esc(p.period)}</td>
                <td>${p.trades}</td>
                <td class="${type==='best'?'ai-pos':'ai-neg'}">${p.profitFactor}</td>
                <td>${p.winRate}%</td>
                <td class="${p.totalPnl>=0?'ai-pos':'ai-neg'}">${p.totalPnl>=0?'+':''}${p.totalPnl}</td>
            </tr>`).join('')}
            </tbody>
        </table>`;
    }
    
    // ════════════════════════════════════════════════════════════════
    // CSS
    // ════════════════════════════════════════════════════════════════
    
    function injectCSS() {
        if (document.getElementById('dm-css')) return;
        const s = document.createElement('style');
        s.id = 'dm-css';
        s.textContent = `
    /* ── VERDICT BANNER ── */
    .dm-verdict{display:flex;align-items:center;gap:14px;margin:10px 12px;padding:14px 16px;border:1px solid;border-radius:8px}
    .dm-verdict-icon{font-size:30px;flex-shrink:0}
    .dm-verdict-level{font-size:18px;font-weight:700;margin-bottom:3px}
    .dm-verdict-sub{font-size:11px;color:#9598a1}
    .dm-warn{color:#ff9800}
    
    /* ── KPI COMPARE ── */
    .dm-kpi-compare{display:flex;align-items:center;gap:8px;padding:8px 12px 12px;flex-wrap:wrap}
    .dm-kpi-col{background:#111320;border:1px solid #1a1e30;border-radius:6px;padding:10px 14px;min-width:110px}
    .dm-kpi-period{font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:#444c70;margin-bottom:6px}
    .dm-kpi-arrow{font-size:20px;color:#444c70;padding:0 4px}
    .dm-kpi-delta{border-color:rgba(255,255,255,.06)}
    .dm-kpi2{margin-bottom:6px}
    .dm-kpi2-l{font-size:9px;color:#6a7090;margin-bottom:1px}
    .dm-kpi2-v{font-size:16px;font-weight:700}
    .dm-kpi-val{font-size:18px;font-weight:700;margin-bottom:6px}
    
    /* ── STABILITY ── */
    .dm-stab-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:6px 12px 10px}
    .dm-stab-card{background:#111320;border:1px solid #1a1e30;border-radius:5px;padding:8px 10px}
    .dm-stab-main{border-color:rgba(74,158,255,.3);background:#0d1420}
    .dm-stab-lbl{font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#444c70;margin-bottom:3px}
    .dm-stab-val{font-size:20px;font-weight:700;margin-bottom:5px}
    .dm-stab-bar-bg{height:3px;background:#1a1e30;border-radius:2px;overflow:hidden}
    .dm-stab-bar{height:100%;border-radius:2px;transition:width .5s}
    
    /* ── REGRESSION ── */
    .dm-reg-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;padding:6px 12px 10px}
    .dm-reg-card{background:#111320;border:1px solid #1a1e30;border-radius:5px;padding:8px 10px}
    .dm-reg-lbl{font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#444c70;margin-bottom:5px;font-weight:700}
    .dm-reg-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:2px}
    .dm-reg-k{font-size:10px;color:#6a7090}
    .dm-reg-v{font-size:11px;font-weight:700;font-family:monospace}
    
    /* ── BEST/WORST ── */
    .dm-bw-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 1px;background:#141826;margin:6px 1px}
    .dm-bw-grid>div{background:#0d0f1a}
    
    /* ── RECOMMENDATION ── */
    .dm-recommendation{margin:6px 12px 14px;padding:12px 14px;border-left:3px solid;border-radius:0 6px 6px 0;background:#0d0f1a}
    .dm-rec-line{font-size:11px;color:#9598a1;line-height:1.9;padding-bottom:2px}
    
    /* ── MULTI-SETUP TABLE ── */
    .dm-summary-tbl td,.dm-summary-tbl th{padding:5px 8px}
    .dm-setup-row{cursor:pointer}
    .dm-setup-row:hover td{background:rgba(255,255,255,.03)}
    .dm-active-row td{background:rgba(74,158,255,.07)!important}
    .dm-badge{padding:2px 7px;border-radius:9px;font-size:10px;font-weight:700}
    .dm-last-row td{background:rgba(255,152,0,.04)}
    
    /* ── SIDEBAR INFO ── */
    .dm-trades-ok{font-size:11px;color:#4caf50;padding:4px 0;line-height:1.7}
    .dm-no-trades{font-size:11px;color:#ef5350;padding:4px 0;line-height:1.7}
    `;
        document.head.appendChild(s);
    }
    
    // ════════════════════════════════════════════════════════════════
    // INIT
    // ════════════════════════════════════════════════════════════════
    
    // ════════════════════════════════════════════════════════════════
    // ВСТРОЕННЫЙ ДВИЖОК (порт alpha-decay-engine.js для браузера)
    // ════════════════════════════════════════════════════════════════
    
    function _dmMean(arr) { return arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : 0; }
    function _dmStd(arr) {
        if (arr.length < 2) return 0;
        const m = _dmMean(arr);
        return Math.sqrt(arr.reduce((s,v)=>s+(v-m)**2,0)/(arr.length-1));
    }
    function _dmLinReg(ys) {
        const n = ys.length;
        if (n < 2) return { slope:0, intercept:ys[0]||0, r2:0 };
        const xs = ys.map((_,i)=>i);
        const mx = _dmMean(xs), my = _dmMean(ys);
        let num=0, den=0, ssY=0;
        for (let i=0;i<n;i++) { num+=(xs[i]-mx)*(ys[i]-my); den+=(xs[i]-mx)**2; ssY+=(ys[i]-my)**2; }
        const slope = den>0 ? num/den : 0;
        const intercept = my - slope*mx;
        const r2 = ssY>0 ? Math.min(1,(num*num)/(den*ssY)) : 0;
        return { slope:+slope.toFixed(6), intercept:+intercept.toFixed(6), r2:+r2.toFixed(4) };
    }
    function _dmHalfLife(ys) {
        const pairs = ys.map((v,i)=>[i,v]).filter(([,v])=>v>1e-6);
        if (pairs.length<3) return null;
        const reg = _dmLinReg(pairs.map(([,v])=>Math.log(v)));
        if (reg.slope>=0) return null;
        return +(-Math.LN2/reg.slope).toFixed(1);
    }
    function _dmStability(vals) {
        if (vals.length<2) return 100;
        const m = _dmMean(vals);
        if (Math.abs(m)<1e-6) return 0;
        return Math.max(0,Math.round((1-Math.min(_dmStd(vals)/Math.abs(m),1))*100));
    }
    function _dmToMs(ts) {
        if (!ts) return 0;
        if (typeof ts==='number') return ts<2e12 ? ts*1000 : ts;
        return new Date(ts).getTime()||0;
    }
    function _dmCalKey(ms,size) {
        const d=new Date(ms), y=d.getUTCFullYear(), m=d.getUTCMonth();
        if (size==='quarter') return `${y}-Q${Math.floor(m/3)+1}`;
        if (size==='year')    return `${y}`;
        return `${y}-${String(m+1).padStart(2,'0')}`;
    }
    function _dmLabel(ms,size) {
        const d=new Date(ms), y=d.getUTCFullYear(), m=d.getUTCMonth();
        if (size==='quarter') return `${y} Q${Math.floor(m/3)+1}`;
        if (size==='year')    return `${y}`;
        return `${y}-${String(m+1).padStart(2,'0')}`;
    }
    function _dmWinStats(trades) {
        if (!trades.length) return {total:0,wins:0,losses:0,winRate:0,profitFactor:0,expectancy:0,totalPnl:0,avgPnl:0,avgWin:0,avgLoss:0,maxDD:0};
        const wins=trades.filter(t=>t.pnl>0), losses=trades.filter(t=>t.pnl<=0);
        const totalPnl=trades.reduce((s,t)=>s+(t.pnl||0),0);
        const grossW=wins.reduce((s,t)=>s+t.pnl,0), grossL=Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
        const wr=wins.length/trades.length;
        const avgWin=wins.length?grossW/wins.length:0, avgLoss=losses.length?grossL/losses.length:0;
        let runCap=0,peak=0,maxDD=0;
        for (const t of trades) { runCap+=(t.pnl||0); if(runCap>peak)peak=runCap; const dd=peak>0?(peak-runCap)/peak*100:0; if(dd>maxDD)maxDD=dd; }
        return {
            total:trades.length, wins:wins.length, losses:losses.length,
            winRate:+(wr*100).toFixed(1),
            profitFactor:grossL>0?+(grossW/grossL).toFixed(3):(grossW>0?9.99:0),
            expectancy:+((wr*avgWin)-((1-wr)*avgLoss)).toFixed(2),
            totalPnl:+totalPnl.toFixed(2), avgPnl:+(totalPnl/trades.length).toFixed(2),
            avgWin:+avgWin.toFixed(2), avgLoss:+(-avgLoss).toFixed(2), maxDD:+maxDD.toFixed(1),
        };
    }
    function _dmBuildWindows(trades, windowSize) {
        if (!trades.length) return [];
        const sorted=[...trades].map(t=>({...t,_ms:_dmToMs(t.entryTs)})).filter(t=>t._ms>0).sort((a,b)=>a._ms-b._ms);
        if (!sorted.length) return [];
        let groups=[];
        if (typeof windowSize==='number') {
            for (let i=0;i<sorted.length;i+=windowSize) {
                const chunk=sorted.slice(i,i+windowSize);
                if (chunk.length<3) continue;
                groups.push({label:_dmLabel(chunk[0]._ms,'month'),fromMs:chunk[0]._ms,trades:chunk});
            }
        } else {
            const map=new Map();
            for (const t of sorted) {
                const key=_dmCalKey(t._ms,windowSize);
                if (!map.has(key)) map.set(key,{key,label:_dmLabel(t._ms,windowSize),fromMs:t._ms,trades:[]});
                map.get(key).trades.push(t);
            }
            groups=[...map.values()].filter(g=>g.trades.length>=3);
        }
        return groups.map((g,idx)=>({idx,...g,..._dmWinStats(g.trades)}));
    }
    function _dmClassify(pfSlope,pfR2,blinePF) {
        const rel=blinePF>0?pfSlope/blinePF:pfSlope, conf=Math.sqrt(Math.max(0,pfR2));
        if (rel>=-0.01||conf<0.25)  return 'none';
        if (rel>=-0.05&&conf>=0.25) return 'mild';
        if (rel>=-0.12&&conf>=0.35) return 'moderate';
        return 'critical';
    }
    function _dmRecommend(level,pfChange,wrChange,stability,hl,breakevenIn,winSz) {
        const unit=typeof winSz==='number'?'windows':winSz+'s';
        if (level==='none') return [
            '✅ Setup is performing consistently — no significant decay detected.',
            stability>=80?'Stability is excellent. Results are predictable across periods.':'Moderate variance across periods. Monitor different market regimes.',
        ];
        if (level==='mild') return [
            '🟡 Mild decay: performance gradually declining.',
            pfChange<-10?`Profit Factor dropped ${Math.abs(pfChange).toFixed(1)}% vs baseline.`:null,
            hl?`Estimated half-life: ${hl} ${unit}.`:null,
            'Action: Monitor closely. Re-run Bayesian Optimization if trend continues 2+ more periods.',
        ].filter(Boolean);
        if (level==='moderate') return [
            '🟠 Moderate decay — consistent downward trend in core metrics.',
            (breakevenIn>0&&breakevenIn<20)?`At current rate, setup hits breakeven PF in ~${breakevenIn} ${unit}.`:null,
            wrChange<-5?`Win Rate fell ${Math.abs(wrChange).toFixed(1)}pp — signal quality degrading.`:null,
            'Action: Reduce position size 30–50%. Re-optimize on recent data only (last 3–6 months).',
        ].filter(Boolean);
        return [
            '🔴 Critical decay — setup is losing edge rapidly.',
            breakevenIn!==null&&breakevenIn<=2?'WARNING: Approaching breakeven within 1–2 periods.':null,
            'Action: Pause trading this setup immediately.',
            'Run full re-backtest from scratch on the last 6 months. Consider replacing signal logic.',
        ].filter(Boolean);
    }
    const _dmLEVELS = {
        none:     {label:'None',    color:'#4caf50',icon:'✅',score:0},
        mild:     {label:'Mild',    color:'#8bc34a',icon:'🟡',score:1},
        moderate: {label:'Moderate',color:'#ff9800',icon:'🟠',score:2},
        critical: {label:'Critical',color:'#ef5350',icon:'🔴',score:3},
    };
    function _dmSingle(trades, windowSize, minWindows) {
        const windows=_dmBuildWindows(trades,windowSize);
        if (windows.length<minWindows) return {error:`Only ${windows.length} windows built, need ${minWindows}. Use smaller windowSize or provide more trade history.`,windows};
        const pfS=windows.map(w=>w.profitFactor), wrS=windows.map(w=>w.winRate), expS=windows.map(w=>w.expectancy), pnlS=windows.map(w=>w.totalPnl);
        const pfReg=_dmLinReg(pfS), wrReg=_dmLinReg(wrS), expReg=_dmLinReg(expS);
        const baseN=Math.max(1,Math.round(windows.length*0.25));
        const blinePF=_dmMean(pfS.slice(0,baseN)), blineWR=_dmMean(wrS.slice(0,baseN));
        const last=windows[windows.length-1], first=windows[0];
        const pfChange=blinePF>0?+((last.profitFactor-blinePF)/blinePF*100).toFixed(1):0;
        const wrChange=+(last.winRate-first.winRate).toFixed(1);
        const level=_dmClassify(pfReg.slope,pfReg.r2,blinePF), meta=_dmLEVELS[level];
        const hl=_dmHalfLife(pfS);
        let breakevenIn=null;
        if (pfReg.slope<0&&pfReg.r2>0.15&&last.profitFactor>1.0)
            breakevenIn=Math.max(0,Math.round((1.0-last.profitFactor)/pfReg.slope));
        const stability={
            profitFactor:_dmStability(pfS), winRate:_dmStability(wrS), expectancy:_dmStability(expS),
            overall:Math.round(_dmStability(pfS)*0.4+_dmStability(wrS)*0.3+_dmStability(expS)*0.3),
        };
        const sorted=[...windows].sort((a,b)=>b.profitFactor-a.profitFactor);
        const bestPeriods=sorted.slice(0,3).map(w=>({period:w.label,trades:w.total,winRate:w.winRate,profitFactor:w.profitFactor,expectancy:w.expectancy,totalPnl:w.totalPnl}));
        const worstPeriods=sorted.slice(-3).reverse().map(w=>({period:w.label,trades:w.total,winRate:w.winRate,profitFactor:w.profitFactor,expectancy:w.expectancy,totalPnl:w.totalPnl}));
        return {
            windowSize, totalTrades:trades.length, totalWindows:windows.length,
            decayLevel:level, decayLabel:meta.label, decayColor:meta.color, decayIcon:meta.icon, decayScore:meta.score,
            regression:{profitFactor:pfReg,winRate:wrReg,expectancy:expReg},
            halfLifeWindows:hl, halfLifeLabel:hl?`${hl} ${typeof windowSize==='number'?'windows':windowSize+'s'}`:null,
            stability, pfChange, wrChange, breakevenIn,
            baseline:{profitFactor:+blinePF.toFixed(3),winRate:+blineWR.toFixed(1)},
            current:{profitFactor:last.profitFactor,winRate:last.winRate,expectancy:last.expectancy,trades:last.total},
            series:{
                labels:windows.map(w=>w.label),
                profitFactor:pfS.map(v=>+v.toFixed(3)), winRate:wrS.map(v=>+v.toFixed(1)),
                expectancy:expS.map(v=>+v.toFixed(2)), totalPnl:pnlS.map(v=>+v.toFixed(2)),
                trades:windows.map(w=>w.total),
                trendPF:windows.map((_,i)=>+(pfReg.intercept+pfReg.slope*i).toFixed(3)),
            },
            windows:windows.map(w=>({label:w.label,fromMs:w.fromMs,total:w.total,winRate:w.winRate,profitFactor:w.profitFactor,expectancy:w.expectancy,totalPnl:w.totalPnl,avgPnl:w.avgPnl,maxDD:w.maxDD})),
            bestPeriods, worstPeriods,
            recommendation:_dmRecommend(level,pfChange,wrChange,stability.overall,hl,breakevenIn,windowSize),
        };
    }
    function analyzeDecay(trades, options={}) {
        const {windowSize='month', minWindows=3, setupFilter=null}=options;
        const filtered=setupFilter?trades.filter(t=>t.setupName===setupFilter):trades;
        if (filtered.length<5) return {error:'Not enough trades (need at least 5).'};
        const setupNames=[...new Set(filtered.map(t=>t.setupName).filter(Boolean))];
        if (setupNames.length>1&&!setupFilter) {
            const bySetup={};
            for (const name of setupNames) {
                const r=_dmSingle(filtered.filter(t=>t.setupName===name),windowSize,minWindows);
                if (!r.error) bySetup[name]=r;
            }
            const overall=_dmSingle(filtered,windowSize,minWindows);
            return {bySetup, overall:overall.error?null:overall, setupNames};
        }
        return _dmSingle(filtered,windowSize,minWindows);
    }
    
    injectDecayTab();
    console.log('[AlphaDecayUI] v1.1 client-side engine loaded');
    
    })(); }