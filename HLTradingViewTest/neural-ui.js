/**
 * neural-ui.js  v1.1
 * ══════════════════════════════════════════════════════════════════════
 * NEURAL TRADING SYSTEM — полный UI интерфейс
 * Встраивается в #sb-tabbar как вкладка "🤖 Neural"
 *
 * Подключение в index.html ПОСЛЕ ai-ui.js:
 *   <script src="neural-ui.js"></script>
 *
 * Требует на сервере: neural-server.js (смонтированные роуты /api/neural/*)
 * ══════════════════════════════════════════════════════════════════════
 */

if (window._neuralUILoaded) {} else { window._neuralUILoaded = true; (function () {
    'use strict';

    // ══════════════════════════════════════════════════════════════════
    // STATE
    // ══════════════════════════════════════════════════════════════════

    const NS = {
        page: 'dashboard',
        loading: false,
        status: null,
        llmStatus: null,
        analysis: null,
        trainResult: null,
        prediction: null,
        strategies: [],
        genResult: null,
        genBacktest: null,
        indicatorSuggestions: null,
        chatMessages: [],
        chatLoading: false,
        cfg: loadCfg(),
        availableInstruments: [],
        availableIntervals: [],
    };

    function loadCfg() {
        try { return Object.assign(defCfg(), JSON.parse(localStorage.getItem('ns_cfg')||'{}')); }
        catch(_) { return defCfg(); }
    }
    function defCfg() {
        return {
            ticker: '', intervalCode: '', table: '',
            fromDate: '', toDate: '',
            epochs: 150, batchSize: 32, lr: 0.001,
            trainSplit: 0.8, labelMode: 'direction', sampleSize: 3000,
            capital: 10000, riskPct: 1, leverage: 1,
            genPrompt: '',
        };
    }
    function saveCfg() { try { localStorage.setItem('ns_cfg', JSON.stringify(NS.cfg)); } catch(_) {} }

    // ══════════════════════════════════════════════════════════════════
    // HELPERS
    // ══════════════════════════════════════════════════════════════════

    const esc = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const fmt2 = v => isNaN(parseFloat(v)) ? '—' : parseFloat(v).toFixed(2);
    const fmtPct = v => { const n=parseFloat(v); return isNaN(n)?'—':`<span class="${n>=0?'ns-pos':'ns-neg'}">${n>=0?'+':''}${n.toFixed(2)}%</span>`; };

    function getSymbolFromCHTicker(chTicker) {
        if (!chTicker) return '';
        const inst = NS.availableInstruments.find(i => i.clickhouse_ticker === chTicker);
        return inst?.symbol || chTicker.split(':')[1]?.split('-')[0] || chTicker;
    }

    function getTicker() {
        return NS.cfg.ticker || getSymbolFromCHTicker(window.app?._currentTicker) || 'EUR';
    }

    function getTable() {
        return NS.cfg.table || window.app?._currentTable || 'market_data_minute';
    }

    function getIntervalCode() {
        return NS.cfg.intervalCode || window.app?._currentResolution || '1';
    }

    function getClickhouseTicker() {
        const sym = NS.cfg.ticker || getTicker();
        const inst = NS.availableInstruments.find(i => i.symbol === sym);
        return inst?.clickhouse_ticker || window.app?._currentTicker || sym;
    }

    function findIntervalByTVCode(tvCode) {
        return NS.availableIntervals.find(i => i.tradingview_code === tvCode);
    }

    async function api(path, data) {
        const opts = data ? {
            method:'POST', credentials:'include',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify(data)
        } : { method:'GET', credentials:'include' };
        const r = await fetch(path, opts);
        if (!r.ok) {
            const e = await r.json().catch(()=>({error:r.statusText}));
            throw new Error(e.error || r.statusText);
        }
        return r.json();
    }

    // ══════════════════════════════════════════════════════════════════
    // TAB INJECTION
    // ══════════════════════════════════════════════════════════════════

    function injectTab() {
        const timer = setInterval(() => {
            const tabbar = document.getElementById('sb-tabbar');
            const body   = document.getElementById('sb-tab-body');
            if (!tabbar || !body) return;
            clearInterval(timer);
            if (document.getElementById('sb-tab-neural')) return;

            injectCSS();

            const btn = document.createElement('button');
            btn.id = 'sb-tab-neural';
            btn.className = 'sb-tab sb-tab-neural';
            btn.dataset.tab = 'neural';
            btn.innerHTML = '🤖 Neural AI';
            tabbar.appendChild(btn);

            btn.addEventListener('click', () => {
                const twrap = document.getElementById('dt-twrap');
                tabbar.querySelectorAll('.sb-tab').forEach(b => b.classList.remove('sb-tab-active'));
                btn.classList.add('sb-tab-active');
                if (twrap) twrap.style.display = 'none';
                body.style.display = 'flex';
                renderNeuralPanel(body);
                loadStatus();
            });
        }, 300);
    }

    // ══════════════════════════════════════════════════════════════════
    // MAIN RENDER
    // ══════════════════════════════════════════════════════════════════

    function renderNeuralPanel(body) {
        body.innerHTML = `
        <div class="ns-root">
            <div class="ns-sidebar" id="ns-sidebar">${renderSidebar()}</div>
            <div class="ns-main"  id="ns-main">${renderMain()}</div>
        </div>`;
        bindEvents();
    }

    function refresh() {
        const body = document.getElementById('sb-tab-body');
        if (!body || !document.getElementById('sb-tab-neural')?.classList.contains('sb-tab-active')) return;
        renderNeuralPanel(body);
    }

    function updateMain() {
        const m = document.getElementById('ns-main');
        if (m) { m.innerHTML = renderMain(); bindMainEvents(); }
    }
    function updateSidebar() {
        const s = document.getElementById('ns-sidebar');
        if (s) { s.innerHTML = renderSidebar(); bindSidebarEvents(); }
    }

    // ══════════════════════════════════════════════════════════════════
    // SIDEBAR
    // ══════════════════════════════════════════════════════════════════

    function renderSidebar() {
        const pages = [
            {id:'dashboard',   icon:'📊', label:'Dashboard'},
            {id:'train',       icon:'🧠', label:'Train Neural Net'},
            {id:'predict',     icon:'🔮', label:'Live Predict'},
            {id:'generate',    icon:'⚡', label:'Generate Strategy'},
            {id:'strategies',  icon:'📁', label:'Strategy Library'},
            {id:'indicators',  icon:'🔭', label:'Find Indicators'},
            {id:'chat',        icon:'💬', label:'AI Chat Analyst'},
        ];

        const st = NS.status;
        return `
        <div class="ns-logo">🤖 Neural AI System</div>

        <div class="ns-nav">
            ${pages.map(p=>`
            <button class="ns-nav-btn ${NS.page===p.id?'ns-nav-a':''}" data-page="${p.id}">
                <span class="ns-nav-ico">${p.icon}</span>
                <span>${p.label}</span>
            </button>`).join('')}
        </div>

        <div class="ns-sb-status">
            <div class="ns-sb-h">System Status</div>
            <div class="ns-status-row">
                <span class="ns-dot ${st?.modelLoaded?'ns-dot-green':'ns-dot-red'}"></span>
                <span>${st?.modelLoaded ? 'Model Loaded' : 'No Model'}</span>
            </div>
            <div class="ns-status-row">
                <span class="ns-dot ${st?.hasAnalysis?'ns-dot-green':'ns-dot-gray'}"></span>
                <span>${st?.hasAnalysis ? 'Analysis Ready' : 'Not Analyzed'}</span>
            </div>
            ${st?.trainMeta ? `
            <div class="ns-sb-meta">
                <div>${esc(st.trainMeta.ticker)} · ${esc(st.trainMeta.table?.split('_').pop())}</div>
                <div>${st.trainMeta.bars?.toLocaleString()} bars · ${st.trainMeta.features?.toLocaleString()} samples</div>
                <div style="color:#3a4060">${new Date(st.trainMeta.trainedAt||0).toLocaleString()}</div>
            </div>` : ''}
        </div>

        <div class="ns-sb-cfg">
            <div class="ns-sb-h">Инструмент</div>
            <div class="ns-sb-row">
                <label class="ns-lbl">Тикер</label>
                <div style="display:flex;gap:4px">
                    <input class="sb-inp ns-inp-flex" id="ns-ticker"
                           value="${esc(NS.cfg.ticker||getTicker())}"
                           placeholder="${esc(getTicker())}"
                           list="ns-ticker-list" autocomplete="off">
                    <datalist id="ns-ticker-list">
                        ${NS.availableInstruments.map(i=>`<option value="${esc(i.symbol)}">${esc(i.name)}</option>`).join('')}
                    </datalist>
                    <button class="ns-btn-ico" id="ns-ticker-refresh" title="Обновить список">↺</button>
                </div>
            </div>
            <div class="ns-sb-row" style="margin-top:8px">
                <label class="ns-lbl">Интервал</label>
                ${NS.availableIntervals.length ? `
                <div class="ns-interval-grid">
                    ${NS.availableIntervals
                        .sort((a,b)=>a.seconds-b.seconds)
                        .map(iv=>{
                            const active = NS.cfg.intervalCode === iv.code ||
                                          (!NS.cfg.intervalCode && window.app?._currentResolution === iv.tradingview_code);
                            return `<button class="ns-iv-btn ${active?'ns-iv-active':''}"
                                data-iv="${esc(iv.code)}"
                                data-table="${esc(iv.clickhouse_table)}"
                                title="${esc(iv.name)}">${esc(iv.code)}</button>`;
                        }).join('')}
                </div>` : `<div style="font-size:10px;color:#3a4060">Загрузка...</div>`}
            </div>
            <div class="ns-sb-row" style="margin-top:2px">
                <div style="font-size:9px;color:#3a4060;font-family:monospace">
                    Таблица: ${esc(getTable())}
                </div>
            </div>
            <div class="ns-sb-row" style="margin-top:8px">
                <label class="ns-lbl">Период</label>
                <input class="sb-inp ns-inp-full" type="date" id="ns-from" value="${esc(NS.cfg.fromDate)}" placeholder="от">
                <input class="sb-inp ns-inp-full" type="date" id="ns-to" value="${esc(NS.cfg.toDate)}" placeholder="до" style="margin-top:3px">
            </div>
        </div>

        <div class="ns-sb-llm">
            ${NS.llmStatus?.configured ? `
            <div class="ns-llm-active">
                <span class="ns-dot ns-dot-green"></span>
                <span>${esc(NS.llmStatus.provider)} · ${esc(NS.llmStatus.model||'')}</span>
            </div>` : `
            <div class="ns-llm-warn" id="ns-goto-llm">
                <span class="ns-dot ns-dot-red"></span>
                <span>LLM не настроен → ⚙️ LLM</span>
            </div>`}
        </div>`;
    }

    // ══════════════════════════════════════════════════════════════════
    // MAIN PAGES
    // ══════════════════════════════════════════════════════════════════

    function renderMain() {
        if (NS.page === 'dashboard')   return renderDashboard();
        if (NS.page === 'train')       return renderTrain();
        if (NS.page === 'predict')     return renderPredict();
        if (NS.page === 'generate')    return renderGenerate();
        if (NS.page === 'strategies')  return renderStrategies();
        if (NS.page === 'indicators')  return renderIndicators();
        if (NS.page === 'chat')        return renderChat();
        return '<div class="ns-empty">Page not found</div>';
    }

    // ── DASHBOARD ──────────────────────────────────────────────────────

    function renderDashboard() {
        const a  = NS.analysis;
        const s  = NS.status;
        const tr = NS.trainResult;

        return `
        <div class="ns-page">
            <div class="ns-page-hdr">
                <div>
                    <h2 class="ns-page-title" style="margin-bottom:3px">📊 Neural Trading Dashboard</h2>
                    <div class="ns-ctx-bar">
                        <span class="ns-ctx-tag ns-ctx-ticker">📌 ${esc(NS.cfg.ticker||getTicker())}</span>
                        <span class="ns-ctx-tag ns-ctx-iv">🕐 ${esc(NS.cfg.intervalCode||getIntervalCode())}</span>
                        ${NS.llmStatus?.configured
                            ? `<span class="ns-ctx-tag ns-ctx-llm">🤖 ${esc(NS.llmStatus.provider)} · ${esc(NS.llmStatus.model||'')}</span>`
                            : `<span class="ns-ctx-tag ns-ctx-llm-off" id="ns-dash-goto-llm">⚠️ LLM не настроен</span>`}
                    </div>
                </div>
                <button class="ns-btn ns-btn-primary" id="ns-analyze-btn" ${NS.loading?'disabled':''}>
                    ${NS.loading?'<span class="ns-spin"></span> Analyzing...':'▶ Run Deep Analysis'}
                </button>
            </div>

            ${!a ? `
            <div class="ns-welcome">
                <div class="ns-welcome-ico">🤖</div>
                <div class="ns-welcome-title">Neural Trading System</div>
                <div class="ns-welcome-sub">
                    Полный AI-анализ вашей базы ClickHouse — 25 признаков, нейросеть, генерация стратегий
                </div>
                <div class="ns-feature-grid">
                    ${[
                        ['🧠','Neural Net','MLP 25→64→32→16→3 (Buy/Hold/Sell)'],
                        ['📊','Deep Analysis','25 признаков: тренд, момент, волат., тики'],
                        ['⚡','AI Strategy Gen','AI генерирует JS стратегии по запросу'],
                        ['🔮','Live Prediction','SHAP-объяснение каждого сигнала'],
                        ['🔭','Indicator Search','AI ищет новые edge-индикаторы'],
                        ['💬','AI Chat','Аналитик знает вашу базу данных'],
                    ].map(([i,t,d])=>`
                    <div class="ns-feature-card">
                        <div class="ns-feature-ico">${i}</div>
                        <div class="ns-feature-title">${t}</div>
                        <div class="ns-feature-desc">${d}</div>
                    </div>`).join('')}
                </div>
                <button class="ns-btn ns-btn-primary ns-btn-lg" id="ns-analyze-btn2">
                    ▶ Начать — Run Deep Analysis
                </button>
            </div>
            ` : `
            <!-- Analysis Results -->
            <div class="ns-section">
                <div class="ns-section-hdr">Market Analysis — ${esc(a.ticker)}</div>
                <div class="ns-cards5">
                    ${statCard('Trend 50b',    a.stats.trend50,    a.stats.trend50?.includes('-')?'ns-neg':'ns-pos')}
                    ${statCard('Volatility',   a.stats.volatility, 'ns-neu')}
                    ${statCard('Sharpe',       a.stats.sharpe,     parseFloat(a.stats.sharpe)>0?'ns-pos':'ns-neg')}
                    ${statCard('Max Drawdown', a.stats.maxDrawdown,'ns-neg')}
                    ${statCard('Win Rate',     a.stats.positiveReturns, 'ns-pos')}
                </div>
            </div>

            <div class="ns-grid2">
                <!-- Regime -->
                <div class="ns-card-block">
                    <div class="ns-card-hdr">Market Regime</div>
                    <div class="ns-regime ${a.regime?.type}">
                        <div class="ns-regime-ico">${regimeIcon(a.regime?.type)}</div>
                        <div>
                            <div class="ns-regime-lbl">${regimeLabel(a.regime?.type)}</div>
                            <div class="ns-regime-sub">Conf: ${((a.regime?.confidence||0)*100).toFixed(0)}% ·
                                 Trend: ${((a.regime?.trend||0)*100).toFixed(2)}% ·
                                 Vol: ${((a.regime?.volatility||0)*100).toFixed(1)}%</div>
                        </div>
                    </div>
                </div>
                <!-- Data Stats -->
                <div class="ns-card-block">
                    <div class="ns-card-hdr">Dataset</div>
                    <div class="ns-data-stats">
                        <div class="ns-ds-row"><span>Bars loaded</span><b>${a.bars?.toLocaleString()}</b></div>
                        <div class="ns-ds-row"><span>Features extracted</span><b>${a.featureCount?.toLocaleString()}</b></div>
                        <div class="ns-ds-row"><span>Tick data</span><b class="${a.ticksAvailable?'ns-pos':'ns-neg'}">${a.ticksAvailable?'✓ Available':'✗ No ticks'}</b></div>
                        <div class="ns-ds-row"><span>Date range</span><b style="font-size:10px">${fmtDate(a.dateRange?.from)} → ${fmtDate(a.dateRange?.to)}</b></div>
                    </div>
                </div>
            </div>

            <!-- Top Features -->
            <div class="ns-card-block">
                <div class="ns-card-hdr">Top Features by Correlation with Future Returns</div>
                <div class="ns-feat-bars">
                    ${(a.topFeatures||[]).slice(0,8).map(f=>{
                        const c = f.corr||0;
                        const w = Math.abs(c)*100;
                        return `
                        <div class="ns-feat-row">
                            <div class="ns-feat-name">${esc(f.name)}</div>
                            <div class="ns-feat-track">
                                <div class="ns-feat-fill" style="width:${w.toFixed(1)}%;background:${c>0?'#4caf50':'#ef5350'}"></div>
                            </div>
                            <div class="ns-feat-val ${c>0?'ns-pos':'ns-neg'}">${c>=0?'+':''}${c.toFixed(3)}</div>
                        </div>`;
                    }).join('')}
                </div>
            </div>

            <!-- Model status -->
            ${tr ? `
            <div class="ns-card-block">
                <div class="ns-card-hdr">🧠 Neural Net — Last Training</div>
                <div class="ns-cards5">
                    ${statCard('Accuracy', (tr.metrics?.acc*100).toFixed(1)+'%', tr.metrics?.acc>0.55?'ns-pos':'ns-neu')}
                    ${statCard('F1 Score', tr.metrics?.f1?.toFixed(3), tr.metrics?.f1>0.5?'ns-pos':'ns-neu')}
                    ${statCard('Precision', (tr.metrics?.prec*100).toFixed(1)+'%', 'ns-neu')}
                    ${statCard('Recall',    (tr.metrics?.rec*100).toFixed(1)+'%',  'ns-neu')}
                    ${statCard('Bars', tr.meta?.bars?.toLocaleString(), '')}
                </div>
            </div>` : ''}
            `}

            ${NS.loading ? `<div class="ns-loading-bar"><div class="ns-loading-fill"></div></div>` : ''}
        </div>`;
    }

    // ── TRAIN ──────────────────────────────────────────────────────────

    function renderTrain() {
        const tr = NS.trainResult;
        return `
        <div class="ns-page">
            <div class="ns-page-hdr">
                <h2 class="ns-page-title">🧠 Train Neural Network</h2>
            </div>

            <div class="ns-grid2">
                <!-- Config -->
                <div class="ns-card-block">
                    <div class="ns-card-hdr">Architecture & Training Config</div>
                    <div class="ns-cfg-grid">
                        <div class="ns-cfg-row">
                            <label class="ns-lbl">Table</label>
                            <select class="sb-sel ns-sel-full" id="tr-table">
                                ${tableOptions(NS.cfg.table)}
                            </select>
                        </div>
                        <div class="ns-cfg-row">
                            <label class="ns-lbl">Label Mode</label>
                            <select class="sb-sel" id="tr-label">
                                <option value="direction" ${NS.cfg.labelMode==='direction'?'selected':''}>Direction (±0.02%)</option>
                                <option value="quantile"  ${NS.cfg.labelMode==='quantile'?'selected':''}>Quantile (33/33/33)</option>
                                <option value="combined"  ${NS.cfg.labelMode==='combined'?'selected':''}>Combined (±0.1%)</option>
                            </select>
                        </div>
                        <div class="ns-cfg-row">
                            <label class="ns-lbl">Epochs</label>
                            <input class="sb-inp sb-inp-sm" id="tr-epochs" type="number" value="${NS.cfg.epochs}" min="20" max="500">
                        </div>
                        <div class="ns-cfg-row">
                            <label class="ns-lbl">Batch Size</label>
                            <input class="sb-inp sb-inp-sm" id="tr-batch" type="number" value="${NS.cfg.batchSize}" min="8" max="256">
                        </div>
                        <div class="ns-cfg-row">
                            <label class="ns-lbl">Learning Rate</label>
                            <input class="sb-inp sb-inp-sm" id="tr-lr" type="number" step="0.0001" value="${NS.cfg.lr}" min="0.0001" max="0.1">
                        </div>
                        <div class="ns-cfg-row">
                            <label class="ns-lbl">Train Split</label>
                            <select class="sb-sel" id="tr-split">
                                <option value="0.7" ${NS.cfg.trainSplit===0.7?'selected':''}>70% / 30%</option>
                                <option value="0.8" ${NS.cfg.trainSplit===0.8?'selected':''}>80% / 20%</option>
                                <option value="0.9" ${NS.cfg.trainSplit===0.9?'selected':''}>90% / 10%</option>
                            </select>
                        </div>
                        <div class="ns-cfg-row">
                            <label class="ns-lbl">Sample Size</label>
                            <input class="sb-inp sb-inp-sm" id="tr-sample" type="number" value="${NS.cfg.sampleSize}" min="100" max="10000">
                        </div>
                    </div>
                    <div class="ns-arch-viz">
                        <div class="ns-arch-title">Architecture: MLP 25→64→32→16→3</div>
                        <div class="ns-arch-layers">
                            ${['Input\n25','Hidden\n64','Hidden\n32','Hidden\n16','Output\n3'].map((l,i)=>`
                            <div class="ns-arch-layer">
                                <div class="ns-arch-box" style="height:${[100,80,60,45,30][i]}px">${l}</div>
                                ${i<4?'<div class="ns-arch-arrow">→</div>':''}
                            </div>`).join('')}
                        </div>
                        <div class="ns-arch-sub">ReLU activations · Momentum SGD · L2 regularization · Softmax output</div>
                    </div>
                    <button class="ns-btn ns-btn-primary ns-btn-wide" id="ns-train-btn" ${NS.loading?'disabled':''}>
                        ${NS.loading?'<span class="ns-spin"></span> Training...':'🧠 Start Training'}
                    </button>
                    ${NS.loading ? `<div class="ns-loading-bar"><div class="ns-loading-fill"></div></div>` : ''}
                </div>

                <!-- Results -->
                <div class="ns-card-block">
                    <div class="ns-card-hdr">Training Results</div>
                    ${!tr ? `<div class="ns-empty-sm">Train the model to see results</div>` : `
                    <div class="ns-train-metrics">
                        <div class="ns-metric-big">
                            <div class="ns-metric-lbl">Accuracy</div>
                            <div class="ns-metric-val ${tr.metrics?.acc>0.55?'ns-pos':tr.metrics?.acc>0.5?'ns-neu':'ns-neg'}">${(tr.metrics?.acc*100||0).toFixed(1)}%</div>
                        </div>
                        <div class="ns-metric-big">
                            <div class="ns-metric-lbl">F1 Score</div>
                            <div class="ns-metric-val ${tr.metrics?.f1>0.5?'ns-pos':'ns-neu'}">${(tr.metrics?.f1||0).toFixed(3)}</div>
                        </div>
                        <div class="ns-metric-big">
                            <div class="ns-metric-lbl">Precision</div>
                            <div class="ns-metric-val ns-neu">${(tr.metrics?.prec*100||0).toFixed(1)}%</div>
                        </div>
                        <div class="ns-metric-big">
                            <div class="ns-metric-lbl">Recall</div>
                            <div class="ns-metric-val ns-neu">${(tr.metrics?.rec*100||0).toFixed(1)}%</div>
                        </div>
                    </div>

                    <!-- Confusion Matrix -->
                    <div class="ns-conf-wrap">
                        <div class="ns-conf-title">Confusion Matrix</div>
                        <table class="ns-conf-tbl">
                            <thead><tr><th></th><th>Pred BUY</th><th>Pred HOLD</th><th>Pred SELL</th></tr></thead>
                            <tbody>
                                ${['BUY','HOLD','SELL'].map((r,ri)=>`
                                <tr>
                                    <td><b>${r}</b></td>
                                    ${(tr.metrics?.conf?.[ri]||[0,0,0]).map((v,ci)=>`
                                    <td class="${ri===ci?'ns-conf-diag':''}">${v}</td>`).join('')}
                                </tr>`).join('')}
                            </tbody>
                        </table>
                    </div>

                    <!-- Class distribution -->
                    <div class="ns-cls-dist">
                        <div class="ns-conf-title">Training Class Distribution</div>
                        ${['BUY','HOLD','SELL'].map((c,i)=>{
                            const v=tr.classCounts?.[i]||0;
                            const t=tr.classCounts?.reduce((s,x)=>s+x,0)||1;
                            const pct=(v/t*100).toFixed(1);
                            return `<div class="ns-cls-row">
                                <span class="ns-cls-lbl">${c}</span>
                                <div class="ns-cls-track"><div class="ns-cls-fill" style="width:${pct}%;background:${['#4caf50','#f5a623','#ef5350'][i]}"></div></div>
                                <span class="ns-cls-val">${v} (${pct}%)</span>
                            </div>`;
                        }).join('')}
                    </div>

                    <div class="ns-train-info">
                        Обучено: ${tr.meta?.bars?.toLocaleString()} баров · ${tr.meta?.features?.toLocaleString()} samples ·
                        ${((tr.meta?.trainMs||0)/1000).toFixed(1)}s
                    </div>
                    `}
                </div>
            </div>
        </div>`;
    }

    // ── PREDICT ────────────────────────────────────────────────────────

    function renderPredict() {
        const p = NS.prediction;
        const signalColors = {BUY:'#4caf50', HOLD:'#f5a623', SELL:'#ef5350'};
        const signalBg     = {BUY:'rgba(76,175,80,.1)', HOLD:'rgba(245,166,35,.1)', SELL:'rgba(239,83,80,.1)'};

        return `
        <div class="ns-page">
            <div class="ns-page-hdr">
                <h2 class="ns-page-title">🔮 Live Prediction</h2>
                <button class="ns-btn ns-btn-primary" id="ns-predict-btn" ${NS.loading||!NS.status?.modelLoaded?'disabled':''}>
                    ${NS.loading?'<span class="ns-spin"></span> Predicting...':'🔮 Predict Current Bar'}
                </button>
            </div>

            ${!NS.status?.modelLoaded ? `
            <div class="ns-warn-box">⚠️ Нейросеть не обучена. Сначала перейдите на вкладку 🧠 Train Neural Net.</div>
            ` : ''}

            ${p ? `
            <!-- Signal Banner -->
            <div class="ns-signal-banner" style="background:${signalBg[p.signal]||'rgba(255,255,255,.05)'};border-color:${signalColors[p.signal]||'#333'}">
                <div class="ns-signal-ico" style="color:${signalColors[p.signal]}">${{BUY:'▲',HOLD:'◆',SELL:'▼'}[p.signal]||'?'}</div>
                <div class="ns-signal-info">
                    <div class="ns-signal-label" style="color:${signalColors[p.signal]}">${p.signal}</div>
                    <div class="ns-signal-conf">Confidence: ${((p.confidence||0)*100).toFixed(1)}%</div>
                </div>
                <div class="ns-signal-probs">
                    ${['BUY','HOLD','SELL'].map((s,i)=>{
                        const v = [p.probs?.buy, p.probs?.hold, p.probs?.sell][i]||0;
                        return `<div class="ns-prob-row">
                            <span class="ns-prob-lbl" style="color:${signalColors[s]}">${s}</span>
                            <div class="ns-prob-track"><div class="ns-prob-fill" style="width:${(v*100).toFixed(1)}%;background:${signalColors[s]}"></div></div>
                            <span class="ns-prob-val">${(v*100).toFixed(1)}%</span>
                        </div>`;
                    }).join('')}
                </div>
            </div>

            <!-- SHAP Feature Importance -->
            <div class="ns-card-block">
                <div class="ns-card-hdr">🔍 SHAP — Feature Contribution to Signal</div>
                <div class="ns-shap-list">
                    ${(p.featureImportance||[]).map((v,i)=>{
                        const names=['trend_5_sma','sma_cross','macd_norm','price_pos','roc_1','roc_5','rsi_norm',
                                     'bb_pos','bb_width','atr_pct','vol_log','vol_rel','reserved',
                                     'body_pct','wick_ratio','bull_candle','macd_hist','stoch_norm','vol_regime',
                                     'tick_ofi','tick_spread','tick_velocity','tick_buysell','time1','time2'];
                        const name = names[i]||`feature_${i}`;
                        const max  = Math.max(...(p.featureImportance||[]).map(Math.abs))||0.001;
                        const w    = Math.abs(v)/max*100;
                        return `
                        <div class="ns-shap-row">
                            <div class="ns-shap-name">${name}</div>
                            <div class="ns-shap-track">
                                <div class="ns-shap-fill" style="width:${w.toFixed(1)}%;background:${v>=0?'#4caf50':'#ef5350'}"></div>
                            </div>
                            <div class="ns-shap-val ${v>=0?'ns-pos':'ns-neg'}">${v>=0?'+':''}${v.toFixed(4)}</div>
                            <div class="ns-shap-raw">${((p.features||[])[i]||0).toFixed(3)}</div>
                        </div>`;
                    }).filter((_,i)=>i<15).join('')}
                </div>
            </div>
            ` : `<div class="ns-empty-big">
                <div style="font-size:48px">🔮</div>
                <div>Нажмите "Predict Current Bar" для прогноза</div>
                <div style="color:#3a4060;font-size:11px;margin-top:6px">Модель анализирует последние ~25 баров и возвращает BUY/HOLD/SELL с SHAP объяснением</div>
            </div>`}
        </div>`;
    }

    // ── GENERATE STRATEGY ──────────────────────────────────────────────

    function renderGenerate() {
        const g  = NS.genResult;
        const bt = NS.genBacktest;

        return `
        <div class="ns-page">
            <div class="ns-page-hdr">
                <h2 class="ns-page-title">⚡ AI Strategy Generator</h2>
            </div>

            <div class="ns-gen-layout">
                <!-- Left: Prompt -->
                <div class="ns-gen-left">
                    <div class="ns-card-block">
                        <div class="ns-card-hdr">Prompt для AI</div>
                        <div class="ns-prompt-examples">
                            ${[
                                'Momentum стратегия с использованием тиков',
                                'Mean-reversion на Bollinger Bands + OFI из тиков',
                                'Breakout стратегия с объёмным подтверждением',
                                'Scalping на tick velocity + spread compression',
                                'Multi-factor: trend + momentum + tick imbalance',
                            ].map(ex=>`<span class="ns-prompt-ex" data-ex="${esc(ex)}">${esc(ex)}</span>`).join('')}
                        </div>
                        <textarea class="ns-textarea" id="ns-gen-prompt" placeholder="Опишите стратегию которую хотите получить...">${esc(NS.cfg.genPrompt)}</textarea>

                        <div class="ns-gen-prefs">
                            <label class="ns-lbl">Предпочтения (через запятую):</label>
                            <input class="sb-inp ns-inp-full" id="ns-gen-prefs" placeholder="например: short timeframe, low DD, many trades">
                        </div>

                        <button class="ns-btn ns-btn-primary ns-btn-wide" id="ns-gen-btn" ${NS.loading?'disabled':''}>
                            ${NS.loading?'<span class="ns-spin"></span> Generating...':'⚡ Generate Strategy'}
                        </button>
                    </div>

                    ${g ? `
                    <div class="ns-card-block">
                        <div class="ns-card-hdr">Backtest Generated Strategy</div>
                        <div class="ns-gen-bt-cfg">
                            <span class="ns-lbl">Capital:</span>
                            <input class="sb-inp sb-inp-xs" id="ns-bt-cap" value="${NS.cfg.capital}" type="number">
                            <span class="ns-lbl">Risk%:</span>
                            <input class="sb-inp sb-inp-xs" id="ns-bt-risk" value="${NS.cfg.riskPct}" type="number" step="0.1">
                            <button class="ns-btn ns-btn-sm" id="ns-bt-btn">▶ Backtest</button>
                        </div>
                        ${NS.loading?`<div class="ns-loading-bar"><div class="ns-loading-fill"></div></div>`:''}
                    </div>` : ''}
                </div>

                <!-- Right: Result -->
                <div class="ns-gen-right">
                    ${!g ? `
                    <div class="ns-empty-big">
                        <div style="font-size:48px">⚡</div>
                        <div>AI сгенерирует полноценный JS код стратегии</div>
                        <div style="color:#3a4060;font-size:11px;margin-top:6px">Используются данные анализа рынка · активная модель: ${NS.llmStatus?.model||'не выбрана'}</div>
                    </div>` : `
                    <!-- Code block -->
                    <div class="ns-card-block" style="flex:none">
                        <div class="ns-card-hdr" style="display:flex;align-items:center;justify-content:space-between">
                            <span>Generated Strategy: <b>${esc(g.strategyName||'ai_strategy')}</b></span>
                            <div style="display:flex;gap:6px">
                                <button class="ns-btn ns-btn-sm" id="ns-gen-copy">📋 Copy</button>
                                <button class="ns-btn ns-btn-sm ns-btn-green" id="ns-gen-save">💾 Save</button>
                                <button class="ns-btn ns-btn-sm ns-btn-blue" id="ns-gen-inject">▶ Run in Chart</button>
                            </div>
                        </div>
                        <pre class="ns-code">${esc(g.code||'')}</pre>
                    </div>

                    ${bt ? `
                    <!-- Backtest results -->
                    <div class="ns-card-block">
                        <div class="ns-card-hdr">📊 Backtest Results</div>
                        <div class="ns-cards5">
                            ${statCard('Trades',     bt.stats?.trades,          '')}
                            ${statCard('Win Rate',   bt.stats?.winRate+'%',     parseFloat(bt.stats?.winRate)>50?'ns-pos':'ns-neg')}
                            ${statCard('Total PnL',  '$'+bt.stats?.totalPnl,    parseFloat(bt.stats?.totalPnl)>0?'ns-pos':'ns-neg')}
                            ${statCard('Profit F',   bt.stats?.profitFactor,    parseFloat(bt.stats?.profitFactor)>1?'ns-pos':'ns-neg')}
                            ${statCard('Return',     bt.stats?.return,          bt.stats?.return?.includes('-')?'ns-neg':'ns-pos')}
                        </div>
                    </div>` : ''}
                    `}
                </div>
            </div>
        </div>`;
    }

    // ── STRATEGIES LIBRARY ─────────────────────────────────────────────

    function renderStrategies() {
        const strats = NS.strategies;
        return `
        <div class="ns-page">
            <div class="ns-page-hdr">
                <h2 class="ns-page-title">📁 Strategy Library</h2>
                <button class="ns-btn ns-btn-sm" id="ns-strat-reload">↺ Reload</button>
            </div>

            ${!strats.length ? `
            <div class="ns-empty-big">
                <div style="font-size:40px">📁</div>
                <div>Нет сохранённых стратегий</div>
                <div style="color:#3a4060;font-size:11px">Генерируйте стратегии во вкладке ⚡ Generate и сохраняйте их</div>
            </div>` : `
            <div class="ns-strat-list">
                ${strats.map(s=>`
                <div class="ns-strat-card" data-id="${s.id}">
                    <div class="ns-strat-hdr">
                        <div class="ns-strat-name">${esc(s.name)}</div>
                        <div class="ns-strat-badges">
                            <span class="ns-badge ns-badge-${s.source==='ai_generated'?'blue':'gray'}">${s.source==='ai_generated'?'AI':'Manual'}</span>
                            ${s.rating ? `<span class="ns-badge ns-badge-gold">★ ${s.rating}</span>` : ''}
                        </div>
                    </div>
                    <div class="ns-strat-desc">${esc(s.description||'No description')}</div>
                    ${s.backtest_stats?.trades ? `
                    <div class="ns-strat-stats">
                        <span>📈 ${s.backtest_stats.trades} trades</span>
                        <span>🎯 ${s.backtest_stats.winRate}% WR</span>
                        <span class="${parseFloat(s.backtest_stats.totalPnl)>0?'ns-pos':'ns-neg'}">PnL: $${s.backtest_stats.totalPnl}</span>
                        <span>PF: ${s.backtest_stats.profitFactor}</span>
                    </div>` : ''}
                    <div class="ns-strat-actions">
                        <button class="ns-btn ns-btn-sm ns-btn-blue ns-strat-inject" data-id="${s.id}">▶ Run</button>
                        <button class="ns-btn ns-btn-sm ns-strat-view" data-id="${s.id}">👁 View Code</button>
                        <button class="ns-btn ns-btn-sm ns-strat-rate" data-id="${s.id}">★ Rate</button>
                        <button class="ns-btn ns-btn-sm ns-btn-red ns-strat-del" data-id="${s.id}">✕ Delete</button>
                    </div>
                </div>`).join('')}
            </div>`}
        </div>`;
    }

    // ── INDICATORS ─────────────────────────────────────────────────────

    function renderIndicators() {
        const ind = NS.indicatorSuggestions;
        return `
        <div class="ns-page">
            <div class="ns-page-hdr">
                <h2 class="ns-page-title">🔭 AI Indicator Discovery</h2>
                <button class="ns-btn ns-btn-primary" id="ns-ind-btn" ${NS.loading?'disabled':''}>
                    ${NS.loading?'<span class="ns-spin"></span> Searching...':'🔭 Find New Indicators'}
                </button>
            </div>

            <div class="ns-card-block">
                <div class="ns-card-hdr">Context</div>
                <textarea class="ns-textarea ns-textarea-sm" id="ns-ind-ctx" placeholder="Опишите что ищете: например 'tick-based momentum signals' или 'volatility breakout filters'"></textarea>
            </div>

            ${!ind ? `
            <div class="ns-empty-big">
                <div style="font-size:48px">🔭</div>
                <div>AI найдёт 5 нестандартных индикаторов с edge</div>
                <div style="color:#3a4060;font-size:11px;margin-top:6px">Учитывает ваши данные, режим рынка и доступность тиков</div>
            </div>` : `
            <div class="ns-card-block">
                <div class="ns-card-hdr">AI Indicator Suggestions</div>
                <div class="ns-ind-response">${markdownToHtml(ind)}</div>
            </div>`}
        </div>`;
    }

    // ── CHAT ───────────────────────────────────────────────────────────

    function renderChat() {
        return `
        <div class="ns-page ns-chat-page">
            <div class="ns-chat-hdr">
                <h2 class="ns-page-title">💬 AI Trading Analyst</h2>
                <button class="ns-btn ns-btn-sm" id="ns-chat-clear">🗑 Clear</button>
            </div>

            <div class="ns-chat-messages" id="ns-chat-msgs">
                ${NS.chatMessages.length === 0 ? `
                <div class="ns-chat-welcome">
                    <div style="font-size:32px">💬</div>
                    <div><b>AI Analyst готов к работе</b></div>
                    <div>Спрашивайте о вашем рынке, стратегиях, данных в ClickHouse</div>
                    <div class="ns-chat-suggestions">
                        ${[
                            'Проанализируй мои результаты бэктеста и дай рекомендации',
                            'Какой сейчас режим рынка? Что это означает для торговли?',
                            'Оцени мои активные сетапы — какие из них лучше работают?',
                            'На основе последних баров — есть ли сейчас сигнал на вход?',
                            'Что улучшить в моей стратегии исходя из статистики сделок?',
                        ].map(q=>`<div class="ns-chat-sug" data-q="${esc(q)}">${esc(q)}</div>`).join('')}
                    </div>
                </div>` :
                NS.chatMessages.map(m=>`
                <div class="ns-chat-msg ns-chat-${m.role}">
                    <div class="ns-chat-avatar">${m.role==='user'?'👤':'🤖'}</div>
                    <div class="ns-chat-bubble">
                        <div class="ns-chat-text">${m.role==='assistant'?markdownToHtml(m.content):esc(m.content)}</div>
                    </div>
                </div>`).join('')
                }
                ${NS.chatLoading?`<div class="ns-chat-msg ns-chat-assistant"><div class="ns-chat-avatar">🤖</div><div class="ns-chat-bubble"><div class="ns-chat-typing"><span></span><span></span><span></span></div></div></div>`:''}
            </div>

            <div class="ns-chat-input-wrap">
                <textarea class="ns-chat-input" id="ns-chat-inp" placeholder="Спросите о рынке, стратегиях, данных..." rows="2"></textarea>
                <button class="ns-btn ns-btn-primary ns-chat-send" id="ns-chat-send">Send ↵</button>
            </div>
        </div>`;
    }

    // ══════════════════════════════════════════════════════════════════
    // EVENTS
    // ══════════════════════════════════════════════════════════════════

    function bindEvents() {
        bindSidebarEvents();
        bindMainEvents();
    }

    function bindSidebarEvents() {
        document.querySelectorAll('.ns-nav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                NS.page = btn.dataset.page;
                if (NS.page === 'strategies') loadStrategies();
                updateSidebar();
                updateMain();
            });
        });

        // Interval buttons
        document.querySelectorAll('.ns-iv-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                NS.cfg.intervalCode = btn.dataset.iv;
                NS.cfg.table        = btn.dataset.table;
                saveCfg();
                NS.analysis = null;
                updateSidebar();
                updateMain();
            });
        });

        // Ticker input
        const tickerInp = document.getElementById('ns-ticker');
        tickerInp?.addEventListener('change', () => {
            NS.cfg.ticker = tickerInp.value.trim().toUpperCase();
            saveCfg();
            NS.analysis = null;
            updateMain();
        });
        tickerInp?.addEventListener('blur', () => {
            if (tickerInp.value.trim()) {
                NS.cfg.ticker = tickerInp.value.trim().toUpperCase();
                saveCfg();
            }
        });

        // Date pickers
        document.getElementById('ns-from')?.addEventListener('change', e => {
            NS.cfg.fromDate = e.target.value; saveCfg();
        });
        document.getElementById('ns-to')?.addEventListener('change', e => {
            NS.cfg.toDate = e.target.value; saveCfg();
        });

        // Refresh tickers list
        document.getElementById('ns-ticker-refresh')?.addEventListener('click', loadTickers);

        // Go to LLM settings
        document.getElementById('ns-goto-llm')?.addEventListener('click', () => {
            document.getElementById('sb-tab-llm')?.click();
        });
    }

    function bindMainEvents() {
        // Dashboard
        ['ns-analyze-btn','ns-analyze-btn2'].forEach(id=>{
            document.getElementById(id)?.addEventListener('click', runAnalyze);
        });
        document.getElementById('ns-dash-goto-llm')?.addEventListener('click', ()=>{
            document.getElementById('sb-tab-llm')?.click();
        });

        // Train
        document.getElementById('ns-train-btn')?.addEventListener('click', runTrain);

        // Predict
        document.getElementById('ns-predict-btn')?.addEventListener('click', runPredict);

        // Generate
        document.getElementById('ns-gen-btn')?.addEventListener('click', runGenerate);
        document.querySelectorAll('.ns-prompt-ex').forEach(el=>{
            el.addEventListener('click', ()=>{
                const ta = document.getElementById('ns-gen-prompt');
                if (ta) ta.value = el.dataset.ex;
            });
        });
        document.getElementById('ns-gen-copy')?.addEventListener('click', ()=>{
            navigator.clipboard?.writeText(NS.genResult?.code||'');
            toast('Copied!');
        });
        document.getElementById('ns-gen-save')?.addEventListener('click', saveGeneratedStrategy);
        document.getElementById('ns-gen-inject')?.addEventListener('click', injectStrategyToChart);
        document.getElementById('ns-bt-btn')?.addEventListener('click', runGenBacktest);

        // Strategies
        document.getElementById('ns-strat-reload')?.addEventListener('click', loadStrategies);
        document.querySelectorAll('.ns-strat-inject').forEach(btn=>{
            btn.addEventListener('click', ()=>injectStrategyById(btn.dataset.id));
        });
        document.querySelectorAll('.ns-strat-view').forEach(btn=>{
            btn.addEventListener('click', ()=>viewStrategyCode(btn.dataset.id));
        });
        document.querySelectorAll('.ns-strat-rate').forEach(btn=>{
            btn.addEventListener('click', ()=>rateStrategy(btn.dataset.id));
        });
        document.querySelectorAll('.ns-strat-del').forEach(btn=>{
            btn.addEventListener('click', ()=>deleteStrategy(btn.dataset.id));
        });

        // Indicators
        document.getElementById('ns-ind-btn')?.addEventListener('click', runIndicatorSearch);

        // Chat
        document.getElementById('ns-chat-send')?.addEventListener('click', sendChat);
        document.getElementById('ns-chat-inp')?.addEventListener('keydown', e=>{
            if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
        });
        document.getElementById('ns-chat-clear')?.addEventListener('click', ()=>{
            NS.chatMessages=[]; updateMain();
        });
        document.querySelectorAll('.ns-chat-sug').forEach(el=>{
            el.addEventListener('click', ()=>{
                const inp = document.getElementById('ns-chat-inp');
                if (inp) { inp.value = el.dataset.q; sendChat(); }
            });
        });
    }

    // ══════════════════════════════════════════════════════════════════
    // API ACTIONS
    // ══════════════════════════════════════════════════════════════════

    async function loadStatus() {
        try {
            [NS.status, NS.llmStatus] = await Promise.all([
                api('/api/neural/status').catch(()=>null),
                api('/api/llm/status').catch(()=>null),
            ]);
            // Синхронизировать тикер и интервал с активным графиком
            if (!NS.cfg.ticker && window.app?._currentTicker) {
                NS.cfg.ticker = getSymbolFromCHTicker(window.app._currentTicker);
            }
            if (!NS.cfg.intervalCode && window.app?._currentResolution) {
                const iv = findIntervalByTVCode(window.app._currentResolution);
                if (iv) { NS.cfg.intervalCode = iv.code; NS.cfg.table = iv.clickhouse_table; }
                else    { NS.cfg.table = window.app?._currentTable || ''; }
            }
            if (!NS.cfg.table && window.app?._currentTable) {
                NS.cfg.table = window.app._currentTable;
            }
            saveCfg();
            updateSidebar();
            await Promise.all([loadTickers(), loadIntervals()]);
        } catch(_) {}
    }

    async function loadTickers() {
        try {
            const r = await fetch('/api/instruments', { credentials:'include' });
            if (!r.ok) return;
            const instruments = await r.json();
            NS.availableInstruments = instruments
                .filter(i => i.is_active)
                .map(i => ({
                    symbol:            i.symbol,
                    name:              i.name,
                    clickhouse_ticker: i.clickhouse_ticker,
                }));
            if (!NS.cfg.ticker) {
                NS.cfg.ticker = getSymbolFromCHTicker(window.app?._currentTicker)
                                || (NS.availableInstruments[0]?.symbol ?? '');
                saveCfg();
            }
            updateSidebar();
        } catch(_) {}
    }

    async function loadIntervals() {
        try {
            const r = await fetch('/api/intervals', { credentials:'include' });
            if (!r.ok) return;
            const intervals = await r.json();
            NS.availableIntervals = intervals
                .filter(i => i.is_active)
                .sort((a,b) => a.sort_order - b.sort_order);

            if (!NS.cfg.intervalCode) {
                const tvCode = window.app?._currentResolution;
                const table  = window.app?._currentTable;
                const iv = tvCode ? NS.availableIntervals.find(i => i.tradingview_code === tvCode) : null;
                if (iv) {
                    NS.cfg.intervalCode = iv.code;
                    NS.cfg.table        = iv.clickhouse_table;
                } else if (table) {
                    const ivByTable = NS.availableIntervals.find(i => i.clickhouse_table === table);
                    if (ivByTable) { NS.cfg.intervalCode = ivByTable.code; NS.cfg.table = ivByTable.clickhouse_table; }
                    else           { NS.cfg.table = table; }
                }
                saveCfg();
            }
            updateSidebar();
        } catch(_) {}
    }

    async function runAnalyze() {
        if (NS.loading) return;
        NS.loading = true;
        updateMain(); updateSidebar();
        try {
            NS.analysis = await api('/api/neural/analyze', {
                ticker:   getClickhouseTicker(),
                table:    getTable(),
                fromDate: NS.cfg.fromDate||undefined,
                toDate:   NS.cfg.toDate||undefined,
                sampleSize: 2000,
            });
            toast('Analysis complete ✓');
        } catch(e) { alert('Analysis error: '+e.message); }
        NS.loading = false;
        updateMain();
    }

    async function runTrain() {
        if (NS.loading) return;
        const selTable = document.getElementById('tr-table')?.value;
        if (selTable) { NS.cfg.table = selTable; }
        NS.cfg.labelMode  = document.getElementById('tr-label')?.value  || NS.cfg.labelMode;
        const matchedIv = NS.availableIntervals.find(i=>i.clickhouse_table===NS.cfg.table);
        if (matchedIv) NS.cfg.intervalCode = matchedIv.code;
        NS.cfg.epochs     = parseInt(document.getElementById('tr-epochs')?.value) || NS.cfg.epochs;
        NS.cfg.batchSize  = parseInt(document.getElementById('tr-batch')?.value)  || NS.cfg.batchSize;
        NS.cfg.lr         = parseFloat(document.getElementById('tr-lr')?.value)   || NS.cfg.lr;
        NS.cfg.trainSplit = parseFloat(document.getElementById('tr-split')?.value)|| NS.cfg.trainSplit;
        NS.cfg.sampleSize = parseInt(document.getElementById('tr-sample')?.value) || NS.cfg.sampleSize;
        saveCfg();

        NS.loading = true;
        updateMain();
        try {
            NS.trainResult = await api('/api/neural/train', {
                ticker:   getClickhouseTicker(),
                table:    getTable(),
                fromDate: NS.cfg.fromDate||undefined,
                toDate:   NS.cfg.toDate||undefined,
                config: {
                    epochs: NS.cfg.epochs, batchSize: NS.cfg.batchSize,
                    lr: NS.cfg.lr, trainSplit: NS.cfg.trainSplit,
                    labelMode: NS.cfg.labelMode, sampleSize: NS.cfg.sampleSize,
                    layers: [25,64,32,16,3],
                },
            });
            await loadStatus();
            toast(`Model trained! Accuracy: ${(NS.trainResult.metrics?.acc*100).toFixed(1)}%`);
        } catch(e) { alert('Train error: '+e.message); }
        NS.loading = false;
        updateMain();
    }

    async function runPredict() {
        if (NS.loading) return;
        const bars = window.app?.activedata;
        if (!bars || bars.length < 25) { alert('Нет данных на графике. Загрузите данные.'); return; }

        NS.loading = true;
        updateMain();
        try {
            NS.prediction = await api('/api/neural/predict', { bars: bars.slice(-30) });
            toast(`Signal: ${NS.prediction.signal} (${(NS.prediction.confidence*100).toFixed(0)}%)`);
        } catch(e) { alert('Predict error: '+e.message); }
        NS.loading = false;
        updateMain();
    }

    async function runGenerate() {
        if (NS.loading) return;
        NS.cfg.genPrompt = document.getElementById('ns-gen-prompt')?.value || '';
        saveCfg();
        if (!NS.cfg.genPrompt.trim()) { alert('Введите описание стратегии'); return; }

        NS.loading = true; NS.genResult = null; NS.genBacktest = null;
        updateMain();
        try {
            NS.genResult = await api('/api/neural/generate', {
                prompt:          NS.cfg.genPrompt,
                analysisContext: NS.analysis,
                preferences:     document.getElementById('ns-gen-prefs')?.value || '',
            });
            toast('Strategy generated! ✓');
        } catch(e) { alert('Generate error: '+e.message); }
        NS.loading = false;
        updateMain();
    }

    async function runGenBacktest() {
        if (!NS.genResult?.code) return;
        NS.loading = true;
        updateMain();
        try {
            NS.genBacktest = await api('/api/neural/backtest-strategy', {
                code:     NS.genResult.code,
                ticker:   getClickhouseTicker(),
                table:    getTable(),
                fromDate: NS.cfg.fromDate||undefined,
                toDate:   NS.cfg.toDate||undefined,
                capital:  parseFloat(document.getElementById('ns-bt-cap')?.value)||10000,
                riskPct:  parseFloat(document.getElementById('ns-bt-risk')?.value)||1,
            });
        } catch(e) { alert('Backtest error: '+e.message); }
        NS.loading = false;
        updateMain();
    }

    async function saveGeneratedStrategy() {
        if (!NS.genResult?.code) return;
        try {
            await api('/api/neural/strategies', {
                name:          NS.genResult.strategyName || 'AI Strategy ' + new Date().toLocaleString(),
                description:   NS.genResult.description || NS.cfg.genPrompt,
                code:          NS.genResult.code,
                backtestStats: NS.genBacktest?.stats || {},
                source:        'ai_generated',
            });
            toast('Strategy saved! ✓');
            loadStrategies();
        } catch(e) { alert('Save error: '+e.message); }
    }

    async function loadStrategies() {
        try {
            NS.strategies = await api('/api/neural/strategies');
            updateMain();
        } catch(e) { console.error(e); }
    }

    function injectStrategyToChart() {
        if (!NS.genResult?.code) return;
        runCodeInChart(NS.genResult.code);
    }

    function injectStrategyById(id) {
        const s = NS.strategies.find(x=>x.id==id);
        if (!s?.code) return;
        runCodeInChart(s.code);
    }

    function runCodeInChart(code) {
        try {
            const bars = window.app?.activedata;
            if (!bars?.length) { alert('Нет данных на графике'); return; }
            const fn = new Function('window', code);
            fn({ app: { activedata: bars, setups: window.app.setups||{} } });
            toast('Strategy injected into chart ✓');
            if (window.setupsBacktest?.refresh) window.setupsBacktest.refresh();
        } catch(e) { alert('Code error: '+e.message); }
    }

    function viewStrategyCode(id) {
        const s = NS.strategies.find(x=>x.id==id);
        if (!s) return;
        const dlg = document.createElement('div');
        dlg.style.cssText='position:fixed;inset:0;background:#000a;z-index:99999;display:flex;align-items:center;justify-content:center';
        dlg.innerHTML=`
        <div style="background:#0c0e1a;border:1px solid #2a2e44;border-radius:10px;width:700px;max-width:90vw;max-height:80vh;display:flex;flex-direction:column">
            <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid #1a1e30">
                <b style="color:#c8ccd8">${esc(s.name)}</b>
                <button style="background:none;border:none;color:#ef5350;cursor:pointer;font-size:18px" id="ns-dlg-close">✕</button>
            </div>
            <pre style="flex:1;overflow:auto;padding:16px;font-size:11px;color:#8a90a8;font-family:monospace;margin:0">${esc(s.code)}</pre>
            <div style="padding:10px 16px;border-top:1px solid #1a1e30;display:flex;gap:8px">
                <button class="ns-btn ns-btn-blue" id="ns-dlg-inject">▶ Run in Chart</button>
                <button class="ns-btn ns-btn-sm" id="ns-dlg-copy">📋 Copy</button>
            </div>
        </div>`;
        document.body.appendChild(dlg);
        dlg.querySelector('#ns-dlg-close').onclick = ()=>dlg.remove();
        dlg.querySelector('#ns-dlg-inject').onclick = ()=>{ runCodeInChart(s.code); dlg.remove(); };
        dlg.querySelector('#ns-dlg-copy').onclick  = ()=>{ navigator.clipboard?.writeText(s.code); toast('Copied!'); };
    }

    async function rateStrategy(id) {
        const r = prompt('Rate this strategy (1-5):');
        if (!r || isNaN(r)) return;
        try {
            await api(`/api/neural/strategies/${id}`, { rating: parseFloat(r) });
            await loadStrategies();
        } catch(e) { alert(e.message); }
    }

    async function deleteStrategy(id) {
        if (!confirm('Delete this strategy?')) return;
        try {
            await fetch(`/api/neural/strategies/${id}`, {method:'DELETE', credentials:'include'});
            await loadStrategies();
        } catch(e) { alert(e.message); }
    }

    async function runIndicatorSearch() {
        if (NS.loading) return;
        NS.loading = true; NS.indicatorSuggestions = null;
        updateMain();
        try {
            const ctx = document.getElementById('ns-ind-ctx')?.value || '';
            const r   = await api('/api/neural/indicators', { context: ctx });
            NS.indicatorSuggestions = r.response;
            toast('Indicators found! ✓');
        } catch(e) { alert('Error: '+e.message); }
        NS.loading = false;
        updateMain();
    }

    // Собирает весь доступный контекст приложения для AI чата
    function gatherAppContext() {
        const ctx = {};

        ctx.ticker       = NS.cfg.ticker || getTicker();
        ctx.chTicker     = getClickhouseTicker();
        ctx.intervalCode = NS.cfg.intervalCode || getIntervalCode();
        ctx.table        = getTable();

        const bars = window.app?.activedata;
        if (bars?.length) {
            ctx.barsTotal = bars.length;
            ctx.barsFrom  = bars[0]?.timestamp;
            ctx.barsTo    = bars[bars.length-1]?.timestamp;
            ctx.lastBars  = bars.slice(-5).map(b=>({
                ts: b.timestamp,
                o: parseFloat(b.open).toFixed(5),
                h: parseFloat(b.high).toFixed(5),
                l: parseFloat(b.low).toFixed(5),
                c: parseFloat(b.close).toFixed(5),
                v: b.volume,
            }));
            const last = bars[bars.length-1];
            ctx.currentPrice = parseFloat(last?.close).toFixed(5);
        }

        const setups = window.app?.setups;
        if (setups && Object.keys(setups).length) {
            ctx.activeSetups = Object.entries(setups).map(([name, def]) => ({
                name,
                column:      def.column || name,
                description: def.description || '',
                entrySignal: def.entrySignal,
                exitSignal:  def.exitSignal,
            }));
        }

        const bt = window._lastBacktestResult;
        if (bt) {
            ctx.backtest = {
                ticker:   bt.ticker || bt.meta?.ticker,
                table:    bt.table  || bt.meta?.table,
                fromDate: bt.fromDate || bt.meta?.fromDate,
                toDate:   bt.toDate   || bt.meta?.toDate,
                stats:    bt.stats,
                trades:   bt.trades ? bt.trades.length : 0,
                lastTrades: (bt.trades||[]).slice(-10).map(t=>({
                    entry:  t.entry,
                    exit:   t.exit,
                    pnl:    t.pnl != null ? parseFloat(t.pnl).toFixed(2) : '?',
                    pnlPct: (((t.pnlPct||0)*100).toFixed(3))+'%',
                    reason: t.exitReason || t.reason,
                    bars:   t.bars,
                    setup:  t.setupName || t.setup || '?',
                })),
            };
        }

        const wf = window._lastWalkForwardResult || window.app?.lastWalkForward;
        if (wf) {
            ctx.walkForward = {
                windows:    wf.summary?.validWindows,
                oosWinRate: wf.summary?.avgOosWinRate,
                oosPf:      wf.summary?.avgOosPf,
                stability:  wf.summary?.stabilityScore,
            };
        }

        if (NS.analysis) {
            ctx.neuralAnalysis = {
                ticker:      NS.analysis.ticker,
                regime:      NS.analysis.regime,
                stats:       NS.analysis.stats,
                topFeatures: NS.analysis.topFeatures?.slice(0,5),
                ticksAvail:  NS.analysis.ticksAvailable,
            };
        }

        if (NS.status?.modelLoaded && NS.status?.trainMeta) {
            ctx.neuralModel = {
                trainedOn: NS.status.trainMeta.bars + ' bars',
                accuracy:  NS.status.trainMeta.accuracy,
                labelMode: NS.status.trainMeta.labelMode,
                trainedAt: NS.status.trainMeta.trainedAt,
            };
        }

        if (NS.prediction) {
            ctx.lastPrediction = {
                signal:     NS.prediction.signal,
                confidence: ((NS.prediction.confidence||0)*100).toFixed(1)+'%',
                probs:      NS.prediction.probs,
            };
        }

        if (NS.llmStatus) {
            ctx.llm = { provider: NS.llmStatus.provider, model: NS.llmStatus.model };
        }

        return ctx;
    }

    async function sendChat() {
        const inp = document.getElementById('ns-chat-inp');
        const text = inp?.value?.trim();
        if (!text || NS.chatLoading) return;

        NS.chatMessages.push({ role:'user', content: text });
        if (inp) inp.value = '';
        NS.chatLoading = true;
        updateMain();

        setTimeout(()=>{
            const msgs = document.getElementById('ns-chat-msgs');
            if (msgs) msgs.scrollTop = msgs.scrollHeight;
        }, 50);

        try {
            const apiMsgs  = NS.chatMessages.slice(-12).map(m=>({role:m.role, content:m.content}));
            const appCtx   = gatherAppContext();
            const r = await api('/api/neural/chat', {
                messages:   apiMsgs,
                appContext:  appCtx,   // ← передаём полный контекст на сервер
            });
            NS.chatMessages.push({ role:'assistant', content: r.response });
        } catch(e) {
            NS.chatMessages.push({ role:'assistant', content: '❌ Error: '+e.message });
        }
        NS.chatLoading = false;
        updateMain();
        setTimeout(()=>{
            const msgs = document.getElementById('ns-chat-msgs');
            if (msgs) msgs.scrollTop = msgs.scrollHeight;
        }, 50);
    }

    // ══════════════════════════════════════════════════════════════════
    // UTILS
    // ══════════════════════════════════════════════════════════════════

    function statCard(label, value, cls) {
        return `<div class="ns-stat-card"><div class="ns-stat-lbl">${label}</div><div class="ns-stat-val ${cls||''}">${esc(String(value||'—'))}</div></div>`;
    }

    function tableOptions(current) {
        // Если загружены интервалы с сервера — используем их
        if (NS.availableIntervals.length) {
            return NS.availableIntervals.map(iv =>
                `<option value="${esc(iv.clickhouse_table)}" ${current===iv.clickhouse_table?'selected':''}>${esc(iv.name)} (${esc(iv.clickhouse_table)})</option>`
            ).join('');
        }
        // Fallback: статический список
        const tables = [
            'mv_market_data_1min_from_ticks',
            'mv_market_data_5min_from_ticks',
            'mv_market_data_15min_from_ticks',
            'mv_market_data_1hour_from_ticks',
            'mv_market_data_4hour_from_ticks',
            'mv_market_data_1day_from_ticks',
        ];
        return tables.map(t=>`<option value="${t}" ${current===t?'selected':''}>${t.replace('mv_market_data_','').replace('_from_ticks','')}</option>`).join('');
    }

    function fmtDate(ts) {
        if (!ts) return '—';
        try { return new Date(ts).toISOString().slice(0,10); } catch(_) { return String(ts).slice(0,10); }
    }

    function regimeIcon(type) {
        return {trending_up:'📈',trending_down:'📉',ranging:'↔️',volatile:'⚡',neutral:'➡️'}[type]||'❓';
    }
    function regimeLabel(type) {
        return {trending_up:'Trending Up',trending_down:'Trending Down',ranging:'Ranging',volatile:'Volatile',neutral:'Neutral'}[type]||'Unknown';
    }

    function markdownToHtml(text) {
        if (!text) return '';
        return esc(text)
            .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
            .replace(/`([^`]+)`/g, '<code style="background:#1a1e30;padding:1px 4px;border-radius:3px">$1</code>')
            .replace(/```[\w]*\n([\s\S]+?)```/g, '<pre class="ns-code-inline">$1</pre>')
            .replace(/^### (.*)/gm, '<h4 style="color:#a78bfa;margin:8px 0 4px">$1</h4>')
            .replace(/^## (.*)/gm, '<h3 style="color:#58a6ff;margin:10px 0 4px">$1</h3>')
            .replace(/^# (.*)/gm, '<h3 style="color:#e6edf3;margin:10px 0 4px">$1</h3>')
            .replace(/^\d+\. (.*)/gm, '<div style="padding:2px 0;padding-left:12px">• $1</div>')
            .replace(/^- (.*)/gm, '<div style="padding:2px 0;padding-left:12px">• $1</div>')
            .replace(/\n/g, '<br>');
    }

    function toast(msg, color) {
        const el = document.createElement('div');
        el.style.cssText=`position:fixed;bottom:60px;right:20px;background:${color||'#4caf50'};color:#fff;padding:8px 16px;border-radius:6px;font-size:12px;font-family:monospace;z-index:99999;box-shadow:0 4px 20px rgba(0,0,0,.5)`;
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(()=>el.remove(), 2500);
    }

    // ══════════════════════════════════════════════════════════════════
    // CSS
    // ══════════════════════════════════════════════════════════════════

    function injectCSS() {
        if (document.getElementById('ns-css')) return;
        const s = document.createElement('style');
        s.id = 'ns-css';
        s.textContent = `
    /* ── Tab ── */
    .sb-tab-neural.sb-tab-active{color:#a78bfa;border-bottom-color:#a78bfa}

    /* ── Root Layout ── */
    .ns-root{display:flex;height:100%;min-height:0;font-size:12px;color:#c8ccd8;background:#080a12;overflow:hidden}
    .ns-sidebar{width:220px;min-width:220px;border-right:1px solid #141826;overflow-y:auto;background:#0b0d16;flex-shrink:0;display:flex;flex-direction:column;gap:0}
    .ns-main{flex:1;overflow-y:auto;min-height:0}

    /* ── Sidebar ── */
    .ns-logo{padding:10px 12px;font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#a78bfa;border-bottom:1px solid #141826;flex-shrink:0}
    .ns-nav{display:flex;flex-direction:column;border-bottom:1px solid #141826}
    .ns-nav-btn{display:flex;align-items:center;gap:8px;padding:8px 12px;background:transparent;border:none;border-left:2px solid transparent;text-align:left;color:#4a5080;font-size:11px;font-weight:600;cursor:pointer;transition:all .12s;font-family:inherit;white-space:nowrap}
    .ns-nav-btn:hover{color:#c8ccd8;background:rgba(255,255,255,.02)}
    .ns-nav-a{color:#a78bfa!important;border-left-color:#a78bfa!important;background:rgba(167,139,250,.06)!important}
    .ns-nav-ico{font-size:14px;width:18px;text-align:center}

    .ns-sb-status,.ns-sb-cfg{padding:8px 10px;border-bottom:1px solid #141826}
    .ns-sb-h{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#3a4060;margin-bottom:6px}
    .ns-status-row{display:flex;align-items:center;gap:6px;font-size:10px;color:#8a90a8;margin-bottom:3px}
    .ns-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
    .ns-dot-green{background:#4caf50;box-shadow:0 0 5px #4caf5088}
    .ns-dot-red{background:#ef5350;box-shadow:0 0 5px #ef535088}
    .ns-dot-gray{background:#3a4060}
    .ns-sb-meta{font-size:9px;color:#3a4060;margin-top:4px;line-height:1.5;padding:4px;background:#06080f;border-radius:3px}
    .ns-sb-row{margin-bottom:5px}
    .ns-lbl{font-size:9px;color:#3a4060;display:block;margin-bottom:2px;text-transform:uppercase;letter-spacing:.04em}
    .ns-inp-full{width:100%!important;box-sizing:border-box}
    .ns-sel-full{width:100%;box-sizing:border-box}

    /* ── Page ── */
    .ns-page{padding:12px 14px;min-height:100%}
    .ns-chat-page{display:flex;flex-direction:column;height:100%;padding:0}
    .ns-page-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px}
    .ns-page-title{font-size:14px;font-weight:700;color:#e6edf3;margin:0}

    /* ── Buttons ── */
    .ns-btn{padding:4px 12px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;border:1px solid transparent;transition:all .12s;font-family:inherit;white-space:nowrap}
    .ns-btn-primary{background:#4a1fb8;color:#fff;border-color:#5b2bc4}
    .ns-btn-primary:hover{background:#5b2bc4}
    .ns-btn-primary:disabled{opacity:.4;cursor:default}
    .ns-btn-sm{background:#0f1220;color:#8a90a8;border:1px solid #1a1e30}
    .ns-btn-sm:hover{border-color:#a78bfa;color:#a78bfa}
    .ns-btn-green{background:#0a1c0f;color:#4caf50;border-color:#4caf5044}
    .ns-btn-green:hover{background:#122518}
    .ns-btn-blue{background:#0d1a2e;color:#58a6ff;border-color:#2962FF44}
    .ns-btn-blue:hover{background:#111f3a}
    .ns-btn-red{background:#1c0a0f;color:#ef5350;border-color:#ef535044}
    .ns-btn-red:hover{background:#250f14}
    .ns-btn-wide{width:100%;margin-top:8px;padding:8px}
    .ns-btn-lg{padding:10px 24px;font-size:13px}
    .ns-btn-save{width:100%;margin-top:6px;padding:5px}

    /* ── Cards & Sections ── */
    .ns-section{margin-bottom:14px}
    .ns-section-hdr{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#3a4060;margin-bottom:8px}
    .ns-card-block{background:#0c0e1a;border:1px solid #1a1e30;border-radius:6px;padding:12px;margin-bottom:12px}
    .ns-card-hdr{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#3a4060;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #141826}
    .ns-grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
    .ns-cards5{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:#141826;margin-bottom:10px;border-radius:4px;overflow:hidden}
    .ns-stat-card{background:#0c0e1a;padding:8px 10px}
    .ns-stat-lbl{font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#3a4060;margin-bottom:3px}
    .ns-stat-val{font-size:14px;font-weight:700;color:#c8ccd8}

    .ns-pos{color:#4caf50}.ns-neg{color:#ef5350}.ns-neu{color:#f5a623}.ns-pur{color:#a78bfa}

    /* ── Welcome ── */
    .ns-welcome{text-align:center;padding:20px 10px}
    .ns-welcome-ico{font-size:48px;margin-bottom:10px}
    .ns-welcome-title{font-size:16px;font-weight:700;color:#e6edf3;margin-bottom:6px}
    .ns-welcome-sub{font-size:12px;color:#8a90a8;margin-bottom:16px}
    .ns-feature-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px;text-align:left}
    .ns-feature-card{background:#0c0e1a;border:1px solid #1a1e30;border-radius:6px;padding:10px}
    .ns-feature-ico{font-size:20px;margin-bottom:4px}
    .ns-feature-title{font-size:11px;font-weight:700;color:#c8ccd8;margin-bottom:3px}
    .ns-feature-desc{font-size:10px;color:#4a5080}

    /* ── Regime ── */
    .ns-regime{display:flex;align-items:center;gap:12px;padding:12px;border-radius:6px;background:#0f1220}
    .ns-regime-ico{font-size:28px}
    .ns-regime-lbl{font-size:14px;font-weight:700;color:#c8ccd8}
    .ns-regime-sub{font-size:10px;color:#4a5080;margin-top:3px}

    /* ── Data stats ── */
    .ns-data-stats{display:flex;flex-direction:column;gap:4px}
    .ns-ds-row{display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid #14182640;font-size:11px;color:#8a90a8}
    .ns-ds-row b{color:#c8ccd8}

    /* ── Feature bars ── */
    .ns-feat-bars{display:flex;flex-direction:column;gap:4px}
    .ns-feat-row{display:flex;align-items:center;gap:6px}
    .ns-feat-name{font-size:9px;font-family:monospace;color:#6a7090;width:120px;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ns-feat-track{flex:1;height:8px;background:#1a1e30;border-radius:4px;overflow:hidden}
    .ns-feat-fill{height:100%;border-radius:4px;transition:width .5s}
    .ns-feat-val{font-size:10px;font-family:monospace;width:48px;text-align:right}

    /* ── Loading ── */
    .ns-loading-bar{height:3px;background:#1a1e30;border-radius:2px;overflow:hidden;margin:8px 0}
    .ns-loading-fill{height:100%;background:linear-gradient(90deg,#6d28d9,#a78bfa,#6d28d9);background-size:200% 100%;animation:ns-shimmer 1.5s infinite}
    @keyframes ns-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
    .ns-spin{display:inline-block;width:10px;height:10px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:ns-spin .7s linear infinite}
    @keyframes ns-spin{to{transform:rotate(360deg)}}

    /* ── Train ── */
    .ns-cfg-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}
    .ns-cfg-row{display:flex;flex-direction:column;gap:2px}
    .ns-arch-viz{background:#06080f;border-radius:4px;padding:10px;margin-bottom:10px;text-align:center}
    .ns-arch-title{font-size:9px;color:#3a4060;margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em}
    .ns-arch-layers{display:flex;align-items:center;justify-content:center;gap:4px}
    .ns-arch-layer{display:flex;align-items:center;gap:4px}
    .ns-arch-box{width:50px;background:linear-gradient(135deg,#1a1e30,#232840);border:1px solid #2a2e44;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:9px;color:#a78bfa;font-family:monospace;white-space:pre-line;text-align:center}
    .ns-arch-arrow{color:#3a4060;font-size:16px}
    .ns-arch-sub{font-size:9px;color:#3a4060;margin-top:8px}
    .ns-train-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#1a1e30;border-radius:4px;overflow:hidden;margin-bottom:10px}
    .ns-metric-big{background:#0d0f1a;padding:10px;text-align:center}
    .ns-metric-lbl{font-size:9px;color:#3a4060;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px}
    .ns-metric-val{font-size:18px;font-weight:700}
    .ns-conf-wrap{margin-bottom:10px}
    .ns-conf-title{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#3a4060;margin-bottom:6px}
    .ns-conf-tbl{width:100%;border-collapse:collapse;font-size:11px}
    .ns-conf-tbl th,.ns-conf-tbl td{padding:5px 8px;border:1px solid #1a1e30;text-align:center}
    .ns-conf-tbl th{background:#0d0f1a;color:#4a5080;font-size:9px;text-transform:uppercase}
    .ns-conf-diag{background:rgba(167,139,250,.15);color:#a78bfa;font-weight:700}
    .ns-cls-dist{margin-bottom:10px}
    .ns-cls-row{display:flex;align-items:center;gap:8px;margin-bottom:4px}
    .ns-cls-lbl{font-size:10px;font-weight:700;width:34px;color:#c8ccd8}
    .ns-cls-track{flex:1;height:8px;background:#1a1e30;border-radius:4px;overflow:hidden}
    .ns-cls-fill{height:100%;border-radius:4px}
    .ns-cls-val{font-size:10px;color:#4a5080;width:80px}
    .ns-train-info{font-size:9px;color:#3a4060;text-align:center}

    /* ── Predict ── */
    .ns-signal-banner{display:flex;align-items:center;gap:16px;padding:16px 20px;border:1px solid;border-radius:8px;margin-bottom:14px}
    .ns-signal-ico{font-size:36px;font-weight:900;font-family:monospace;flex-shrink:0}
    .ns-signal-label{font-size:24px;font-weight:800;font-family:monospace}
    .ns-signal-conf{font-size:11px;color:#4a5080;margin-top:3px}
    .ns-signal-info{flex:none;width:140px}
    .ns-signal-probs{flex:1}
    .ns-prob-row{display:flex;align-items:center;gap:8px;margin-bottom:4px}
    .ns-prob-lbl{font-size:10px;font-weight:700;width:36px}
    .ns-prob-track{flex:1;height:8px;background:#1a1e30;border-radius:4px;overflow:hidden}
    .ns-prob-fill{height:100%;border-radius:4px}
    .ns-prob-val{font-size:10px;font-family:monospace;color:#c8ccd8;width:36px}
    .ns-shap-list{display:flex;flex-direction:column;gap:3px}
    .ns-shap-row{display:flex;align-items:center;gap:6px}
    .ns-shap-name{font-size:9px;font-family:monospace;color:#6a7090;width:110px;flex-shrink:0}
    .ns-shap-track{flex:1;height:10px;background:#1a1e30;border-radius:5px;overflow:hidden}
    .ns-shap-fill{height:100%;border-radius:5px}
    .ns-shap-val{font-size:9px;font-family:monospace;width:56px;text-align:right}
    .ns-shap-raw{font-size:9px;color:#3a4060;width:46px;text-align:right}
    .ns-warn-box{background:rgba(245,166,35,.1);border:1px solid rgba(245,166,35,.3);border-radius:6px;padding:10px 14px;color:#f5a623;font-size:12px;margin-bottom:12px}

    /* ── Generate ── */
    .ns-gen-layout{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .ns-gen-left,.ns-gen-right{display:flex;flex-direction:column;gap:10px}
    .ns-prompt-examples{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px}
    .ns-prompt-ex{padding:3px 8px;background:#0f1220;border:1px solid #1a1e30;border-radius:12px;font-size:10px;color:#8a90a8;cursor:pointer;transition:all .12s}
    .ns-prompt-ex:hover{border-color:#a78bfa;color:#a78bfa}
    .ns-textarea{width:100%;box-sizing:border-box;background:#06080f;border:1px solid #1a1e30;border-radius:4px;color:#c8ccd8;font-size:11px;padding:8px;resize:vertical;min-height:80px;font-family:monospace}
    .ns-textarea:focus{outline:none;border-color:#a78bfa}
    .ns-textarea-sm{min-height:56px}
    .ns-gen-prefs{margin-top:6px}
    .ns-gen-bt-cfg{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .ns-code{background:#06080f;border:1px solid #1a1e30;border-radius:4px;padding:10px;font-size:10px;color:#8a90a8;overflow-x:auto;max-height:400px;overflow-y:auto;white-space:pre;margin:0}
    .ns-code-inline{background:#0c0e1a;padding:6px 8px;border-radius:4px;font-size:10px;margin:4px 0;overflow-x:auto;white-space:pre}

    /* ── Strategies ── */
    .ns-strat-list{display:flex;flex-direction:column;gap:8px}
    .ns-strat-card{background:#0c0e1a;border:1px solid #1a1e30;border-radius:6px;padding:12px;transition:border-color .12s}
    .ns-strat-card:hover{border-color:#2a2e44}
    .ns-strat-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:5px}
    .ns-strat-name{font-size:12px;font-weight:700;color:#c8ccd8}
    .ns-strat-badges{display:flex;gap:5px}
    .ns-badge{padding:1px 7px;border-radius:9px;font-size:10px;font-weight:700}
    .ns-badge-blue{background:rgba(88,166,255,.15);color:#58a6ff}
    .ns-badge-gray{background:#1a1e30;color:#4a5080}
    .ns-badge-gold{background:rgba(210,165,32,.15);color:#d2a520}
    .ns-strat-desc{font-size:11px;color:#4a5080;margin-bottom:8px}
    .ns-strat-stats{display:flex;gap:12px;font-size:10px;color:#8a90a8;margin-bottom:8px;flex-wrap:wrap}
    .ns-strat-actions{display:flex;gap:6px;flex-wrap:wrap}

    /* ── Indicators ── */
    .ns-ind-response{font-size:11px;color:#8a90a8;line-height:1.7;max-height:500px;overflow-y:auto}

    /* ── Chat ── */
    .ns-chat-hdr{display:flex;align-items:center;justify-content:space-between;padding:8px 14px;border-bottom:1px solid #141826;flex-shrink:0}
    .ns-chat-messages{flex:1;overflow-y:auto;padding:10px 14px;display:flex;flex-direction:column;gap:10px}
    .ns-chat-welcome{text-align:center;padding:20px;color:#4a5080}
    .ns-chat-suggestions{display:flex;flex-direction:column;gap:4px;margin-top:12px;text-align:left}
    .ns-chat-sug{padding:6px 10px;background:#0c0e1a;border:1px solid #1a1e30;border-radius:4px;cursor:pointer;font-size:11px;color:#8a90a8;transition:all .12s}
    .ns-chat-sug:hover{border-color:#a78bfa;color:#a78bfa}
    .ns-chat-msg{display:flex;gap:8px;align-items:flex-start}
    .ns-chat-user{flex-direction:row-reverse}
    .ns-chat-avatar{font-size:18px;flex-shrink:0;width:24px;text-align:center}
    .ns-chat-bubble{max-width:80%;padding:8px 12px;border-radius:8px;font-size:11px;line-height:1.6}
    .ns-chat-user .ns-chat-bubble{background:#1a1030;border:1px solid #2a1050;color:#c8ccd8}
    .ns-chat-assistant .ns-chat-bubble{background:#0c0e1a;border:1px solid #1a1e30;color:#c8ccd8}
    .ns-chat-text{word-break:break-word}
    .ns-chat-typing{display:flex;gap:4px;align-items:center;padding:4px 0}
    .ns-chat-typing span{width:6px;height:6px;background:#a78bfa;border-radius:50%;animation:ns-typing 1s infinite}
    .ns-chat-typing span:nth-child(2){animation-delay:.2s}
    .ns-chat-typing span:nth-child(3){animation-delay:.4s}
    @keyframes ns-typing{0%,60%,100%{opacity:.3}30%{opacity:1}}
    .ns-chat-input-wrap{display:flex;gap:8px;padding:10px 14px;border-top:1px solid #141826;flex-shrink:0;align-items:flex-end}
    .ns-chat-input{flex:1;background:#06080f;border:1px solid #1a1e30;border-radius:6px;color:#c8ccd8;font-size:11px;padding:8px;resize:none;font-family:inherit}
    .ns-chat-input:focus{outline:none;border-color:#a78bfa}
    .ns-chat-send{align-self:flex-end}

    /* ── Ctx bar ── */
    .ns-ctx-bar{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
    .ns-ctx-tag{font-size:10px;padding:2px 8px;border-radius:9px;font-weight:600}
    .ns-ctx-ticker{background:rgba(167,139,250,.12);color:#a78bfa}
    .ns-ctx-iv{background:rgba(34,211,238,.1);color:#22d3ee}
    .ns-ctx-llm{background:rgba(76,175,80,.1);color:#4caf50}
    .ns-ctx-llm-off{background:rgba(239,83,80,.1);color:#ef5350;cursor:pointer}
    .ns-ctx-llm-off:hover{background:rgba(239,83,80,.2)}

    /* ── Interval grid ── */
    .ns-interval-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:3px}
    .ns-iv-btn{padding:4px 2px;background:#0f1220;border:1px solid #1a1e30;border-radius:3px;font-size:10px;font-weight:700;color:#4a5080;cursor:pointer;font-family:inherit;transition:all .12s;text-align:center}
    .ns-iv-btn:hover{border-color:#a78bfa;color:#a78bfa}
    .ns-iv-active{background:rgba(167,139,250,.12)!important;border-color:#a78bfa!important;color:#a78bfa!important}

    /* ── LLM status in sidebar ── */
    .ns-sb-llm{padding:8px 10px;border-top:1px solid #141826;margin-top:auto}
    .ns-llm-active{display:flex;align-items:center;gap:6px;font-size:10px;color:#4caf50}
    .ns-llm-warn{display:flex;align-items:center;gap:6px;font-size:10px;color:#ef5350;cursor:pointer}
    .ns-llm-warn:hover{color:#ff6b6b}

    /* ── Ticker input ── */
    .ns-inp-flex{flex:1;min-width:0}
    .ns-btn-ico{padding:4px 7px;background:#0f1220;border:1px solid #1a1e30;border-radius:3px;color:#4a5080;font-size:12px;cursor:pointer;flex-shrink:0}
    .ns-btn-ico:hover{border-color:#a78bfa;color:#a78bfa}

    /* ── Misc ── */
    .ns-empty{display:flex;align-items:center;justify-content:center;height:100%;color:#3a4060;font-size:12px}
    .ns-empty-sm{text-align:center;padding:24px;color:#3a4060;font-size:11px}
    .ns-empty-big{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:40px;color:#4a5080;font-size:12px;text-align:center}
    `;
        document.head.appendChild(s);
    }

    // ══════════════════════════════════════════════════════════════════
    // INIT
    // ══════════════════════════════════════════════════════════════════

    injectTab();
    window.neuralUI = {
        open:          () => document.getElementById('sb-tab-neural')?.click(),
        getStatus:     () => NS.status,
        getPrediction: () => NS.prediction,
        getAnalysis:   () => NS.analysis,
    };
    console.log('[NeuralUI] v1.1 loaded');

})(); }