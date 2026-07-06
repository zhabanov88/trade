/**
 * tick-analytics.js  v1.0
 * ══════════════════════════════════════════════════════════════════════
 * TICK ANALYTICS MODULE — 3 передовых модуля анализа тиков
 *
 * Требует: window.app.activedata[i].ticks = [{ts, ask, bid, mid}, ...]
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ 1. TICK FLOW ANALYZER                                           │
 * │    Микроструктурный анализ: Order Flow Imbalance, спред-        │
 * │    давление, velocity, buy/sell pressure heatmap                │
 * │                                                                 │
 * │ 2. TICK NEURAL FINGERPRINT                                      │
 * │    Нейросеть (без бэкенда): автоэнкодер паттернов тиков,       │
 * │    аномалии, кластеризация похожих баров, прогноз               │
 * │                                                                 │
 * │ 3. PREDICTIVE SPREAD ENGINE                                     │
 * │    ML-прогноз направления следующего бара по 12 признакам       │
 * │    текущего (спред-динамика, velocity, imbalance, кластер)      │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Подключение:
 *   <script src="tick-analytics.js"></script>
 *   Вызывается из data-table.js / code-panel / кнопки в шапке
 *
 * Использование:
 *   window.tickAnalytics.open()   — открыть панель
 *   window.tickAnalytics.analyze() — запустить анализ
 * ══════════════════════════════════════════════════════════════════════
 */

(function () {
    'use strict';

    if (window._tickAnalyticsLoaded) return;
    window._tickAnalyticsLoaded = true;

    // ═══════════════════════════════════════════════════════════════
    // СТИЛИ
    // ═══════════════════════════════════════════════════════════════

    const CSS = `
    <style>
    #ta-overlay {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.75);
        z-index: 9998;
        display: none;
        align-items: center;
        justify-content: center;
        backdrop-filter: blur(4px);
    }
    #ta-overlay.ta-open { display: flex; }

    #ta-panel {
        width: 1160px;
        max-width: 96vw;
        max-height: 90vh;
        background: #0d1117;
        border: 1px solid #21262d;
        border-radius: 12px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        box-shadow: 0 32px 96px rgba(0,0,0,0.8);
    }

    #ta-header {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 16px 20px;
        border-bottom: 1px solid #21262d;
        background: #161b22;
        flex-shrink: 0;
    }
    #ta-header h2 {
        font-size: 15px;
        font-weight: 600;
        color: #e6edf3;
        margin: 0;
        flex: 1;
        font-family: 'SF Mono', 'Fira Code', monospace;
        letter-spacing: 0.5px;
    }
    .ta-badge {
        font-size: 10px;
        padding: 2px 7px;
        border-radius: 20px;
        font-weight: 700;
        letter-spacing: 0.5px;
        font-family: monospace;
    }
    .ta-badge-blue  { background: rgba(41,98,255,0.2); color: #58a6ff; border: 1px solid rgba(88,166,255,0.3); }
    .ta-badge-green { background: rgba(46,160,67,0.2); color: #3fb950; border: 1px solid rgba(63,185,80,0.3); }
    .ta-badge-gold  { background: rgba(210,153,34,0.2); color: #d2a520; border: 1px solid rgba(210,165,32,0.3); }

    .ta-tab-bar {
        display: flex;
        gap: 2px;
        padding: 8px 20px 0;
        background: #161b22;
        border-bottom: 1px solid #21262d;
        flex-shrink: 0;
    }
    .ta-tab {
        padding: 8px 16px;
        font-size: 12px;
        font-weight: 500;
        color: #8b949e;
        cursor: pointer;
        border: 1px solid transparent;
        border-bottom: none;
        border-radius: 6px 6px 0 0;
        background: transparent;
        display: flex;
        align-items: center;
        gap: 6px;
        transition: all 0.15s;
        font-family: 'SF Mono', monospace;
    }
    .ta-tab:hover { color: #e6edf3; background: #1c2128; }
    .ta-tab.active {
        color: #58a6ff;
        background: #0d1117;
        border-color: #21262d;
        border-bottom-color: #0d1117;
        margin-bottom: -1px;
    }
    .ta-tab .ta-dot {
        width: 6px; height: 6px;
        border-radius: 50%;
        background: currentColor;
    }

    #ta-body {
        flex: 1;
        overflow-y: auto;
        padding: 20px;
        scrollbar-width: thin;
        scrollbar-color: #30363d transparent;
    }

    .ta-section {
        display: none;
    }
    .ta-section.active { display: block; }

    .ta-toolbar {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 20px;
        flex-wrap: wrap;
    }
    .ta-btn {
        padding: 7px 16px;
        font-size: 12px;
        font-weight: 600;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        transition: all 0.15s;
        font-family: 'SF Mono', monospace;
        letter-spacing: 0.3px;
    }
    .ta-btn-primary { background: #238636; color: #fff; }
    .ta-btn-primary:hover { background: #2ea043; }
    .ta-btn-secondary { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; }
    .ta-btn-secondary:hover { background: #30363d; }
    .ta-btn-blue { background: rgba(41,98,255,0.15); color: #58a6ff; border: 1px solid rgba(88,166,255,0.3); }
    .ta-btn-blue:hover { background: rgba(41,98,255,0.3); }
    .ta-btn-gold { background: rgba(210,153,34,0.15); color: #d2a520; border: 1px solid rgba(210,165,32,0.3); }
    .ta-btn-gold:hover { background: rgba(210,153,34,0.3); }

    .ta-label {
        font-size: 11px;
        color: #8b949e;
        font-family: monospace;
    }
    .ta-select {
        background: #21262d;
        color: #c9d1d9;
        border: 1px solid #30363d;
        border-radius: 6px;
        padding: 6px 10px;
        font-size: 12px;
        font-family: monospace;
        cursor: pointer;
    }
    .ta-input {
        background: #21262d;
        color: #c9d1d9;
        border: 1px solid #30363d;
        border-radius: 6px;
        padding: 6px 10px;
        font-size: 12px;
        font-family: monospace;
        width: 80px;
    }

    /* STAT CARDS */
    .ta-cards {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
        gap: 10px;
        margin-bottom: 20px;
    }
    .ta-card {
        background: #161b22;
        border: 1px solid #21262d;
        border-radius: 8px;
        padding: 12px 14px;
    }
    .ta-card-label {
        font-size: 10px;
        color: #8b949e;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        margin-bottom: 6px;
        font-family: monospace;
    }
    .ta-card-value {
        font-size: 20px;
        font-weight: 700;
        color: #e6edf3;
        font-family: 'SF Mono', monospace;
    }
    .ta-card-sub {
        font-size: 10px;
        color: #8b949e;
        margin-top: 3px;
        font-family: monospace;
    }
    .ta-card-value.pos { color: #3fb950; }
    .ta-card-value.neg { color: #f85149; }
    .ta-card-value.neu { color: #d2a520; }

    /* CHARTS */
    .ta-chart-wrap {
        background: #161b22;
        border: 1px solid #21262d;
        border-radius: 8px;
        padding: 16px;
        margin-bottom: 16px;
    }
    .ta-chart-title {
        font-size: 11px;
        font-weight: 600;
        color: #8b949e;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        margin-bottom: 12px;
        font-family: monospace;
    }
    canvas.ta-canvas {
        width: 100% !important;
        display: block;
    }

    /* GRID */
    .ta-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .ta-grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }

    /* HEATMAP */
    .ta-heatmap {
        display: grid;
        gap: 2px;
    }
    .ta-hm-cell {
        border-radius: 3px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 9px;
        font-family: monospace;
        color: rgba(255,255,255,0.7);
        cursor: pointer;
        transition: transform 0.1s;
    }
    .ta-hm-cell:hover { transform: scale(1.1); z-index: 1; }

    /* PROGRESS / LOG */
    .ta-progress {
        height: 4px;
        background: #21262d;
        border-radius: 2px;
        margin: 8px 0 16px;
        overflow: hidden;
    }
    .ta-progress-bar {
        height: 100%;
        background: linear-gradient(90deg, #2962ff, #58a6ff);
        border-radius: 2px;
        transition: width 0.3s;
    }
    .ta-log {
        background: #0a0e14;
        border: 1px solid #21262d;
        border-radius: 6px;
        padding: 12px;
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 11px;
        color: #8b949e;
        max-height: 120px;
        overflow-y: auto;
        margin-bottom: 16px;
    }
    .ta-log .ok  { color: #3fb950; }
    .ta-log .err { color: #f85149; }
    .ta-log .inf { color: #58a6ff; }
    .ta-log .neu { color: #d2a520; }

    /* NEURAL WEIGHTS VIZ */
    .ta-weight-bar {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
    }
    .ta-weight-name {
        font-size: 10px;
        font-family: monospace;
        color: #8b949e;
        width: 120px;
        flex-shrink: 0;
    }
    .ta-weight-track {
        flex: 1;
        height: 14px;
        background: #21262d;
        border-radius: 7px;
        overflow: hidden;
        position: relative;
    }
    .ta-weight-fill {
        height: 100%;
        border-radius: 7px;
        transition: width 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    .ta-weight-val {
        font-size: 10px;
        font-family: monospace;
        color: #e6edf3;
        width: 50px;
        text-align: right;
    }

    /* TABLE */
    .ta-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 11px;
        font-family: monospace;
    }
    .ta-table th {
        color: #8b949e;
        text-align: left;
        padding: 8px 10px;
        border-bottom: 1px solid #21262d;
        font-weight: 600;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }
    .ta-table td {
        padding: 7px 10px;
        border-bottom: 1px solid #161b22;
        color: #c9d1d9;
    }
    .ta-table tr:hover td { background: #161b22; }
    .ta-table .pos { color: #3fb950; }
    .ta-table .neg { color: #f85149; }
    .ta-table .neu { color: #d2a520; }

    /* CLUSTER DOTS */
    .ta-scatter-wrap { position: relative; }
    
    /* CLOSE BTN */
    .ta-close {
        width: 28px; height: 28px;
        border: 1px solid #30363d;
        border-radius: 6px;
        background: transparent;
        color: #8b949e;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        transition: all 0.15s;
    }
    .ta-close:hover { color: #f85149; border-color: #f85149; }

    /* PREDICTION GAUGE */
    .ta-gauge-wrap {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
    }
    .ta-gauge-label {
        font-size: 11px;
        font-family: monospace;
        color: #8b949e;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }
    .ta-gauge-value {
        font-size: 36px;
        font-weight: 800;
        font-family: 'SF Mono', monospace;
    }
    .ta-gauge-sub {
        font-size: 11px;
        color: #8b949e;
        font-family: monospace;
    }

    /* ANOMALY ROW */
    .ta-anomaly-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px;
        border-bottom: 1px solid #161b22;
        cursor: pointer;
        transition: background 0.1s;
    }
    .ta-anomaly-row:hover { background: #161b22; }
    .ta-anomaly-icon {
        font-size: 16px;
        width: 24px;
        text-align: center;
    }
    .ta-anomaly-info { flex: 1; }
    .ta-anomaly-ts {
        font-size: 10px;
        color: #8b949e;
        font-family: monospace;
    }
    .ta-anomaly-desc {
        font-size: 12px;
        color: #e6edf3;
        font-family: monospace;
    }
    .ta-anomaly-score {
        font-size: 13px;
        font-weight: 700;
        font-family: monospace;
        padding: 3px 8px;
        border-radius: 4px;
    }
    .ta-empty {
        text-align: center;
        color: #8b949e;
        font-family: monospace;
        font-size: 13px;
        padding: 40px;
    }
    </style>`;

    // ═══════════════════════════════════════════════════════════════
    // HTML ШАБЛОН
    // ═══════════════════════════════════════════════════════════════

    function buildHTML() {
        return `
        ${CSS}
        <div id="ta-overlay">
        <div id="ta-panel">

            <!-- HEADER -->
            <div id="ta-header">
                <h2>⚡ TICK ANALYTICS</h2>
                <span class="ta-badge ta-badge-blue">ML-POWERED</span>
                <span class="ta-badge ta-badge-green" id="ta-bars-badge">0 bars</span>
                <span class="ta-badge ta-badge-gold" id="ta-ticks-badge">0 ticks</span>
                <button class="ta-close" id="ta-close-btn">✕</button>
            </div>

            <!-- TABS -->
            <div class="ta-tab-bar">
                <button class="ta-tab active" data-tab="flow">
                    <span class="ta-dot"></span> Flow Analyzer
                </button>
                <button class="ta-tab" data-tab="neural">
                    <span class="ta-dot"></span> Neural Fingerprint
                </button>
                <button class="ta-tab" data-tab="predict">
                    <span class="ta-dot"></span> Predictive Engine
                </button>
            </div>

            <!-- BODY -->
            <div id="ta-body">

                <!-- ═══ TAB 1: FLOW ANALYZER ═══════════════════════════ -->
                <div class="ta-section active" id="ta-sec-flow">
                    <div class="ta-toolbar">
                        <button class="ta-btn ta-btn-primary" id="ta-flow-run">▶ Run Flow Analysis</button>
                        <label class="ta-label">Bars:</label>
                        <input class="ta-input" id="ta-flow-bars" type="number" value="200" min="10" max="2000">
                        <label class="ta-label">Min ticks/bar:</label>
                        <input class="ta-input" id="ta-flow-min-ticks" type="number" value="3" min="1" max="100">
                        <div style="flex:1"></div>
                        <button class="ta-btn ta-btn-secondary" id="ta-flow-export">↓ Export CSV</button>
                    </div>
                    <div class="ta-log" id="ta-flow-log"><span class="ta-inf">Ready. Click "Run Flow Analysis".</span></div>

                    <div class="ta-cards" id="ta-flow-cards" style="display:none">
                        <div class="ta-card">
                            <div class="ta-card-label">Avg OFI</div>
                            <div class="ta-card-value" id="fc-ofi">—</div>
                            <div class="ta-card-sub">order flow imbalance</div>
                        </div>
                        <div class="ta-card">
                            <div class="ta-card-label">Avg Spread</div>
                            <div class="ta-card-value" id="fc-spread">—</div>
                            <div class="ta-card-sub">pips average</div>
                        </div>
                        <div class="ta-card">
                            <div class="ta-card-label">Spread Volatility</div>
                            <div class="ta-card-value" id="fc-spread-vol">—</div>
                            <div class="ta-card-sub">σ spread</div>
                        </div>
                        <div class="ta-card">
                            <div class="ta-card-label">Tick Velocity</div>
                            <div class="ta-card-value" id="fc-velocity">—</div>
                            <div class="ta-card-sub">avg ticks/min</div>
                        </div>
                        <div class="ta-card">
                            <div class="ta-card-label">Buy Pressure</div>
                            <div class="ta-card-value pos" id="fc-buy-press">—</div>
                            <div class="ta-card-sub">% bars upward</div>
                        </div>
                        <div class="ta-card">
                            <div class="ta-card-label">Intra-bar Range</div>
                            <div class="ta-card-value neu" id="fc-range">—</div>
                            <div class="ta-card-sub">avg tick range</div>
                        </div>
                    </div>

                    <div id="ta-flow-charts" style="display:none">
                        <div class="ta-grid-2">
                            <div class="ta-chart-wrap">
                                <div class="ta-chart-title">Order Flow Imbalance</div>
                                <canvas class="ta-canvas" id="c-ofi" height="140"></canvas>
                            </div>
                            <div class="ta-chart-wrap">
                                <div class="ta-chart-title">Spread Pressure (pips)</div>
                                <canvas class="ta-canvas" id="c-spread" height="140"></canvas>
                            </div>
                        </div>
                        <div class="ta-grid-2">
                            <div class="ta-chart-wrap">
                                <div class="ta-chart-title">Tick Velocity (ticks/min)</div>
                                <canvas class="ta-canvas" id="c-velocity" height="140"></canvas>
                            </div>
                            <div class="ta-chart-wrap">
                                <div class="ta-chart-title">Intra-bar Volatility</div>
                                <canvas class="ta-canvas" id="c-ibvol" height="140"></canvas>
                            </div>
                        </div>
                        <div class="ta-chart-wrap">
                            <div class="ta-chart-title">Buy/Sell Heatmap (OFI intensity by bar)</div>
                            <div id="ta-heatmap"></div>
                        </div>
                    </div>
                </div>

                <!-- ═══ TAB 2: NEURAL FINGERPRINT ══════════════════════ -->
                <div class="ta-section" id="ta-sec-neural">
                    <div class="ta-toolbar">
                        <button class="ta-btn ta-btn-primary" id="ta-nn-run">▶ Train Neural Net</button>
                        <label class="ta-label">Hidden layers:</label>
                        <select class="ta-select" id="ta-nn-arch">
                            <option value="8-4">8→4 (fast)</option>
                            <option value="16-8" selected>16→8 (balanced)</option>
                            <option value="32-16">32→16 (deep)</option>
                        </select>
                        <label class="ta-label">Epochs:</label>
                        <input class="ta-input" id="ta-nn-epochs" type="number" value="150" min="50" max="500">
                        <label class="ta-label">Clusters K:</label>
                        <input class="ta-input" id="ta-nn-k" type="number" value="5" min="2" max="10" style="width:60px">
                    </div>
                    <div class="ta-progress"><div class="ta-progress-bar" id="ta-nn-prog" style="width:0%"></div></div>
                    <div class="ta-log" id="ta-nn-log"><span class="ta-inf">Ready. Click "Train Neural Net" to run autoencoder + clustering.</span></div>

                    <div id="ta-nn-results" style="display:none">
                        <div class="ta-cards">
                            <div class="ta-card">
                                <div class="ta-card-label">Reconstruction Error</div>
                                <div class="ta-card-value" id="nn-recon-err">—</div>
                                <div class="ta-card-sub">final MSE</div>
                            </div>
                            <div class="ta-card">
                                <div class="ta-card-label">Anomalies Found</div>
                                <div class="ta-card-value neg" id="nn-anomalies">—</div>
                                <div class="ta-card-sub">> 3σ error</div>
                            </div>
                            <div class="ta-card">
                                <div class="ta-card-label">Clusters</div>
                                <div class="ta-card-value neu" id="nn-clusters">—</div>
                                <div class="ta-card-sub">k-means</div>
                            </div>
                            <div class="ta-card">
                                <div class="ta-card-label">Silhouette</div>
                                <div class="ta-card-value" id="nn-silhouette">—</div>
                                <div class="ta-card-sub">cluster quality</div>
                            </div>
                        </div>

                        <div class="ta-grid-2">
                            <div class="ta-chart-wrap">
                                <div class="ta-chart-title">Training Loss</div>
                                <canvas class="ta-canvas" id="c-loss" height="160"></canvas>
                            </div>
                            <div class="ta-chart-wrap">
                                <div class="ta-chart-title">Latent Space (2D projection)</div>
                                <canvas class="ta-canvas" id="c-latent" height="160"></canvas>
                            </div>
                        </div>

                        <div class="ta-grid-2">
                            <div class="ta-chart-wrap">
                                <div class="ta-chart-title">Feature Importance (Encoder Weights)</div>
                                <div id="ta-weights"></div>
                            </div>
                            <div class="ta-chart-wrap">
                                <div class="ta-chart-title">Cluster Distribution</div>
                                <canvas class="ta-canvas" id="c-clusters" height="160"></canvas>
                            </div>
                        </div>

                        <div class="ta-chart-wrap">
                            <div class="ta-chart-title">🚨 Anomalous Bars (top 20 by reconstruction error)</div>
                            <div id="ta-anomaly-list"></div>
                        </div>
                    </div>
                </div>

                <!-- ═══ TAB 3: PREDICTIVE ENGINE ════════════════════════ -->
                <div class="ta-section" id="ta-sec-predict">
                    <div class="ta-toolbar">
                        <button class="ta-btn ta-btn-primary" id="ta-pred-run">▶ Train Predictor</button>
                        <label class="ta-label">Train/Test split:</label>
                        <select class="ta-select" id="ta-pred-split">
                            <option value="0.7">70% / 30%</option>
                            <option value="0.8" selected>80% / 20%</option>
                            <option value="0.9">90% / 10%</option>
                        </select>
                        <label class="ta-label">LR:</label>
                        <input class="ta-input" id="ta-pred-lr" type="number" value="0.05" step="0.01" min="0.001" max="0.5">
                        <label class="ta-label">Epochs:</label>
                        <input class="ta-input" id="ta-pred-epochs" type="number" value="200" min="50" max="1000">
                    </div>
                    <div class="ta-progress"><div class="ta-progress-bar" id="ta-pred-prog" style="width:0%"></div></div>
                    <div class="ta-log" id="ta-pred-log"><span class="ta-inf">Ready. Trains logistic regression on 12 tick-derived features to predict next-bar direction.</span></div>

                    <div id="ta-pred-results" style="display:none">
                        <div class="ta-cards">
                            <div class="ta-card">
                                <div class="ta-card-label">Test Accuracy</div>
                                <div class="ta-card-value pos" id="pr-acc">—</div>
                                <div class="ta-card-sub">correct direction</div>
                            </div>
                            <div class="ta-card">
                                <div class="ta-card-label">AUC-ROC</div>
                                <div class="ta-card-value" id="pr-auc">—</div>
                                <div class="ta-card-sub">discrimination</div>
                            </div>
                            <div class="ta-card">
                                <div class="ta-card-label">Precision</div>
                                <div class="ta-card-value" id="pr-prec">—</div>
                                <div class="ta-card-sub">bull predictions</div>
                            </div>
                            <div class="ta-card">
                                <div class="ta-card-label">Recall</div>
                                <div class="ta-card-value" id="pr-rec">—</div>
                                <div class="ta-card-sub">bull recall</div>
                            </div>
                            <div class="ta-card">
                                <div class="ta-card-label">F1 Score</div>
                                <div class="ta-card-value" id="pr-f1">—</div>
                                <div class="ta-card-sub">harmonic mean</div>
                            </div>
                            <div class="ta-card">
                                <div class="ta-card-label">Log Loss</div>
                                <div class="ta-card-value neg" id="pr-loss">—</div>
                                <div class="ta-card-sub">cross-entropy</div>
                            </div>
                        </div>

                        <!-- LIVE PREDICTION for latest bar -->
                        <div class="ta-chart-wrap" style="text-align:center; padding: 24px;">
                            <div class="ta-chart-title">🔮 CURRENT BAR PREDICTION</div>
                            <div style="display:flex; justify-content:center; gap:48px; align-items:center; margin-top:16px;">
                                <div class="ta-gauge-wrap">
                                    <div class="ta-gauge-label">Bull Probability</div>
                                    <div class="ta-gauge-value pos" id="pr-bull-prob">—</div>
                                    <div class="ta-gauge-sub">next bar up</div>
                                </div>
                                <div class="ta-gauge-wrap">
                                    <div class="ta-gauge-label">Signal</div>
                                    <div class="ta-gauge-value neu" id="pr-signal">—</div>
                                    <div class="ta-gauge-sub">direction</div>
                                </div>
                                <div class="ta-gauge-wrap">
                                    <div class="ta-gauge-label">Confidence</div>
                                    <div class="ta-gauge-value" id="pr-confidence">—</div>
                                    <div class="ta-gauge-sub">certainty</div>
                                </div>
                            </div>
                        </div>

                        <div class="ta-grid-2">
                            <div class="ta-chart-wrap">
                                <div class="ta-chart-title">Training Loss Curve</div>
                                <canvas class="ta-canvas" id="c-pred-loss" height="160"></canvas>
                            </div>
                            <div class="ta-chart-wrap">
                                <div class="ta-chart-title">Feature Importance</div>
                                <div id="ta-pred-weights"></div>
                            </div>
                        </div>

                        <div class="ta-grid-2">
                            <div class="ta-chart-wrap">
                                <div class="ta-chart-title">Prediction vs Actual (last 80 bars)</div>
                                <canvas class="ta-canvas" id="c-pred-vs-actual" height="160"></canvas>
                            </div>
                            <div class="ta-chart-wrap">
                                <div class="ta-chart-title">Calibration Curve</div>
                                <canvas class="ta-canvas" id="c-calibration" height="160"></canvas>
                            </div>
                        </div>
                    </div>
                </div>

            </div><!-- /ta-body -->
        </div><!-- /ta-panel -->
        </div><!-- /ta-overlay -->`;
    }

    // ═══════════════════════════════════════════════════════════════
    // MATH / UTILS
    // ═══════════════════════════════════════════════════════════════

    const M = {
        mean: a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0,
        std:  a => { const m = M.mean(a); return Math.sqrt(M.mean(a.map(x => (x-m)**2))); },
        min:  a => Math.min(...a),
        max:  a => Math.max(...a),
        clamp: (v,lo,hi) => Math.max(lo, Math.min(hi, v)),
        norm: (v,lo,hi) => hi===lo ? 0 : (v-lo)/(hi-lo),
        sigmoid: x => 1 / (1 + Math.exp(-x)),
        relu: x => Math.max(0, x),
        dot: (a,b) => a.reduce((s,v,i) => s + v*(b[i]||0), 0),
        fmt: (v, d=4) => isNaN(v) ? '—' : v.toFixed(d),
        fmtPct: v => isNaN(v) ? '—' : (v*100).toFixed(1)+'%',
    };

    // ─── Рисовалка графиков (без Chart.js — чистый Canvas) ──────────

    const C = {
        // Линейный график
        line(canvas, data, opts = {}) {
            const ctx  = canvas.getContext('2d');
            const W    = canvas.parentElement.clientWidth - 32;
            const H    = canvas.height || 140;
            canvas.width = W;
            ctx.clearRect(0, 0, W, H);

            if (!data || data.length < 2) return;

            const pad   = { t:10, r:10, b:24, l:48 };
            const iW    = W - pad.l - pad.r;
            const iH    = H - pad.t - pad.b;
            const vals  = data.map(d => Array.isArray(d) ? d : [d]);
            const colors = opts.colors || ['#2962ff','#ff6b35','#3fb950','#d2a520','#ff79c6'];

            const allVals = vals.flat();
            let lo = opts.yMin ?? M.min(allVals);
            let hi = opts.yMax ?? M.max(allVals);
            if (lo === hi) { lo -= 1; hi += 1; }

            const x = i => pad.l + (i / (data.length - 1)) * iW;
            const y = v => pad.t + iH - M.norm(v, lo, hi) * iH;

            // Grid
            ctx.strokeStyle = '#21262d';
            ctx.lineWidth   = 1;
            for (let i = 0; i <= 4; i++) {
                const yv = pad.t + (iH / 4) * i;
                ctx.beginPath(); ctx.moveTo(pad.l, yv); ctx.lineTo(pad.l + iW, yv); ctx.stroke();
                const lbl = (hi - (hi - lo) * i / 4).toFixed(opts.decimals ?? 2);
                ctx.fillStyle = '#8b949e'; ctx.font = '9px monospace';
                ctx.textAlign = 'right';
                ctx.fillText(lbl, pad.l - 4, yv + 3);
            }

            // Zero line
            if (opts.zeroLine && lo < 0 && hi > 0) {
                ctx.strokeStyle = '#444c56';
                ctx.lineWidth   = 1;
                ctx.setLineDash([3, 3]);
                const yv = y(0);
                ctx.beginPath(); ctx.moveTo(pad.l, yv); ctx.lineTo(pad.l + iW, yv); ctx.stroke();
                ctx.setLineDash([]);
            }

            // Lines (each column in vals is a series)
            const seriesCount = vals[0].length;
            for (let s = 0; s < seriesCount; s++) {
                const col = colors[s % colors.length];
                if (opts.fill && s === 0) {
                    ctx.beginPath();
                    ctx.moveTo(x(0), y(0));
                    vals.forEach((row, i) => {
                        i === 0 ? ctx.moveTo(x(i), y(row[s]||0)) : ctx.lineTo(x(i), y(row[s]||0));
                    });
                    ctx.lineTo(x(vals.length - 1), pad.t + iH);
                    ctx.lineTo(pad.l, pad.t + iH);
                    ctx.closePath();
                    ctx.fillStyle = col + '22';
                    ctx.fill();
                }
                ctx.beginPath();
                ctx.strokeStyle = col;
                ctx.lineWidth   = opts.lineWidth || 1.5;
                vals.forEach((row, i) => {
                    const v = row[s] ?? row;
                    i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v));
                });
                ctx.stroke();
            }

            // X labels
            const step = Math.max(1, Math.floor(data.length / 8));
            ctx.fillStyle = '#8b949e'; ctx.font = '9px monospace'; ctx.textAlign = 'center';
            data.forEach((_, i) => {
                if (i % step === 0) {
                    ctx.fillText(i, x(i), H - 6);
                }
            });
        },

        // Bar (histogram)
        bars(canvas, data, opts = {}) {
            const ctx = canvas.getContext('2d');
            const W   = canvas.parentElement.clientWidth - 32;
            const H   = canvas.height || 140;
            canvas.width = W;
            ctx.clearRect(0, 0, W, H);

            if (!data || !data.length) return;
            const pad  = { t:10, r:10, b:24, l:48 };
            const iW   = W - pad.l - pad.r;
            const iH   = H - pad.t - pad.b;
            const lo   = opts.yMin ?? Math.min(0, M.min(data));
            const hi   = opts.yMax ?? M.max(data);
            if (lo === hi) return;

            const bw   = Math.max(1, iW / data.length - 1);
            const zero = pad.t + iH - M.norm(0, lo, hi) * iH;

            // Grid
            ctx.strokeStyle = '#21262d'; ctx.lineWidth = 1;
            for (let i = 0; i <= 4; i++) {
                const yv = pad.t + (iH / 4) * i;
                ctx.beginPath(); ctx.moveTo(pad.l, yv); ctx.lineTo(pad.l + iW, yv); ctx.stroke();
                const lbl = (hi - (hi - lo) * i / 4).toFixed(opts.decimals ?? 2);
                ctx.fillStyle = '#8b949e'; ctx.font = '9px monospace'; ctx.textAlign = 'right';
                ctx.fillText(lbl, pad.l - 4, yv + 3);
            }

            data.forEach((v, i) => {
                const bx  = pad.l + (i / data.length) * iW;
                const barH = Math.abs(M.norm(v, lo, hi) - M.norm(0, lo, hi)) * iH;
                const by  = v >= 0 ? zero - barH : zero;
                ctx.fillStyle = opts.colorFn ? opts.colorFn(v, i) : (v >= 0 ? '#2ea043' : '#f85149');
                ctx.fillRect(bx, by, bw, barH);
            });

            // Zero line
            if (lo < 0) {
                ctx.strokeStyle = '#555'; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(pad.l, zero); ctx.lineTo(pad.l + iW, zero); ctx.stroke();
            }
        },

        // Scatter
        scatter(canvas, points, opts = {}) {
            const ctx = canvas.getContext('2d');
            const W   = canvas.parentElement.clientWidth - 32;
            const H   = canvas.height || 160;
            canvas.width = W;
            ctx.clearRect(0, 0, W, H);

            if (!points || !points.length) return;

            const xs = points.map(p => p.x);
            const ys = points.map(p => p.y);
            const xlo = M.min(xs), xhi = M.max(xs);
            const ylo = M.min(ys), yhi = M.max(ys);
            const pad = 20;
            const mapX = v => pad + M.norm(v, xlo, xhi) * (W - 2*pad);
            const mapY = v => H - pad - M.norm(v, ylo, yhi) * (H - 2*pad);

            const palette = ['#2962ff','#3fb950','#f85149','#d2a520','#ff79c6',
                             '#58a6ff','#56d364','#ff6b35','#a371f7'];

            points.forEach(p => {
                ctx.beginPath();
                ctx.arc(mapX(p.x), mapY(p.y), opts.r || 4, 0, 2*Math.PI);
                ctx.fillStyle = palette[(p.c || 0) % palette.length] + '99';
                ctx.fill();
                ctx.strokeStyle = palette[(p.c || 0) % palette.length];
                ctx.lineWidth = 1;
                ctx.stroke();
            });
        },

        // Pie
        pie(canvas, data, labels, opts = {}) {
            const ctx = canvas.getContext('2d');
            const W   = canvas.parentElement.clientWidth - 32;
            const H   = canvas.height || 160;
            canvas.width = W;
            ctx.clearRect(0, 0, W, H);

            const total = data.reduce((s,v) => s+v, 0);
            if (!total) return;

            const colors = ['#2962ff','#3fb950','#f85149','#d2a520','#ff79c6',
                            '#58a6ff','#56d364','#ff6b35','#a371f7'];
            const cx = W * 0.4, cy = H / 2, r = Math.min(cx, cy) - 10;

            let angle = -Math.PI / 2;
            data.forEach((v, i) => {
                const slice = (v / total) * 2 * Math.PI;
                ctx.beginPath();
                ctx.moveTo(cx, cy);
                ctx.arc(cx, cy, r, angle, angle + slice);
                ctx.closePath();
                ctx.fillStyle = colors[i % colors.length];
                ctx.fill();
                ctx.strokeStyle = '#0d1117';
                ctx.lineWidth = 2;
                ctx.stroke();
                angle += slice;
            });

            // Legend
            labels.forEach((lbl, i) => {
                const ly = 20 + i * 22;
                ctx.fillStyle = colors[i % colors.length];
                ctx.fillRect(W * 0.82, ly - 8, 12, 12);
                ctx.fillStyle = '#c9d1d9';
                ctx.font = '11px monospace';
                ctx.textAlign = 'left';
                ctx.fillText(`${lbl} (${data[i]})`, W * 0.84 + 14, ly + 2);
            });
        },
    };

    // ═══════════════════════════════════════════════════════════════
    // TICK FEATURE EXTRACTION
    // ═══════════════════════════════════════════════════════════════

    function extractTickFeatures(bar) {
        const ticks = bar.ticks;
        if (!ticks || ticks.length < 2) return null;

        const mids   = ticks.map(t => t.mid || (t.ask + t.bid) / 2);
        const spreads= ticks.map(t => t.ask - t.bid);
        const times  = ticks.map(t => new Date(t.ts).getTime());

        // OFI — direction of consecutive mid price changes weighted by spread
        let ofi = 0;
        for (let i = 1; i < mids.length; i++) {
            const dm  = mids[i] - mids[i-1];
            const spd = spreads[i];
            ofi += spd > 0 ? dm / spd : dm;
        }
        ofi /= (mids.length - 1);

        // Spread features
        const spreadMean  = M.mean(spreads);
        const spreadStd   = M.std(spreads);
        const spreadMin   = M.min(spreads);
        const spreadMax   = M.max(spreads);
        const spreadTrend = spreads.length > 4
            ? M.mean(spreads.slice(-3)) - M.mean(spreads.slice(0, 3))
            : 0;

        // Velocity (ticks per second)
        const durSec = times.length > 1 ? (times[times.length-1] - times[0]) / 1000 : 0;
        const velocity = durSec > 0 ? ticks.length / durSec * 60 : 0; // per minute

        // Intra-bar price range
        const midRange  = M.max(mids) - M.min(mids);
        const midStd    = M.std(mids);

        // Buy/sell pressure
        let upCount = 0, downCount = 0;
        for (let i = 1; i < mids.length; i++) {
            if (mids[i] > mids[i-1]) upCount++;
            else if (mids[i] < mids[i-1]) downCount++;
        }
        const buySellRatio = (upCount + downCount) > 0
            ? (upCount - downCount) / (upCount + downCount) : 0;

        // Price acceleration (2nd derivative of mid)
        let accel = 0;
        if (mids.length >= 4) {
            const firstHalf  = mids.slice(0, Math.floor(mids.length/2));
            const secondHalf = mids.slice(Math.floor(mids.length/2));
            const vFirst  = (firstHalf[firstHalf.length-1] - firstHalf[0]);
            const vSecond = (secondHalf[secondHalf.length-1] - secondHalf[0]);
            accel = vSecond - vFirst;
        }

        // Clustering of ticks in time (are they evenly spread or burst?)
        let timeCluster = 0;
        if (times.length > 2) {
            const gaps = [];
            for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i-1]);
            timeCluster = M.std(gaps) / (M.mean(gaps) + 1); // CV of inter-tick gaps
        }

        // First tick vs last tick mid-price momentum
        const firstToLast = mids.length > 1 ? (mids[mids.length-1] - mids[0]) / (spreadMean || 1) : 0;

        return {
            ofi, spreadMean, spreadStd, spreadMin, spreadMax, spreadTrend,
            velocity, midRange, midStd, buySellRatio, accel, timeCluster, firstToLast,
            tickCount: ticks.length
        };
    }

    function normFeatures(features, stats) {
        const keys = Object.keys(stats);
        return keys.map(k => {
            const v   = features[k] ?? 0;
            const { mean, std } = stats[k];
            return std > 1e-10 ? (v - mean) / std : 0;
        });
    }

    function computeFeatureStats(featuresList) {
        const keys = Object.keys(featuresList[0]);
        const stats = {};
        keys.forEach(k => {
            const vals  = featuresList.map(f => f[k] ?? 0);
            stats[k] = { mean: M.mean(vals), std: M.std(vals) };
        });
        return stats;
    }

    // ═══════════════════════════════════════════════════════════════
    // MODULE 1: FLOW ANALYZER
    // ═══════════════════════════════════════════════════════════════

    async function runFlowAnalysis() {
        const maxBars = parseInt(document.getElementById('ta-flow-bars').value) || 200;
        const minTicks= parseInt(document.getElementById('ta-flow-min-ticks').value) || 3;
        const log     = makeLog('ta-flow-log');

        log.inf(`Starting Flow Analysis...`);
        log.inf(`Parameters: ${maxBars} bars, min ${minTicks} ticks/bar`);

        const data = (window.app?.activedata || []).slice(-maxBars).filter(b => {
            const t = b.ticks;
            return t && t.length >= minTicks;
        });

        if (data.length < 10) {
            log.err(`Not enough bars with ticks (found ${data.length}, need ≥10). Load more data.`);
            return;
        }

        log.ok(`Processing ${data.length} bars with ticks...`);
        await sleep(10);

        // Extract features for each bar
        const features = data.map(b => extractTickFeatures(b)).filter(Boolean);
        log.ok(`Extracted features from ${features.length} bars`);

        // Aggregate stats
        const ofis       = features.map(f => f.ofi);
        const spreads    = features.map(f => f.spreadMean);
        const velocities = features.map(f => f.velocity);
        const ranges     = features.map(f => f.midRange);
        const bsratios   = features.map(f => f.buySellRatio);

        // Update cards
        const avgOFI       = M.mean(ofis);
        const avgSpread    = M.mean(spreads);
        const spreadVol    = M.std(spreads);
        const avgVelocity  = M.mean(velocities);
        const buyPressure  = bsratios.filter(v => v > 0.1).length / bsratios.length;
        const avgRange     = M.mean(ranges);

        // Detect pip size
        const pipSize = detectPipSize(avgSpread);
        const spreadPips = avgSpread / pipSize;

        document.getElementById('fc-ofi').textContent      = avgOFI.toFixed(5);
        document.getElementById('fc-ofi').className        = 'ta-card-value ' + (avgOFI > 0 ? 'pos' : 'neg');
        document.getElementById('fc-spread').textContent   = spreadPips.toFixed(2);
        document.getElementById('fc-spread-vol').textContent = (M.std(spreads) / pipSize).toFixed(2);
        document.getElementById('fc-velocity').textContent = avgVelocity.toFixed(1);
        document.getElementById('fc-buy-press').textContent = (buyPressure * 100).toFixed(1) + '%';
        document.getElementById('fc-range').textContent    = (avgRange / pipSize).toFixed(2);

        document.getElementById('ta-flow-cards').style.display = '';
        document.getElementById('ta-flow-charts').style.display = '';

        await sleep(10);

        // Draw charts
        const barLabels = data.map((b, i) => i);

        // OFI chart
        C.bars(document.getElementById('c-ofi'), ofis, {
            colorFn: (v) => v > 0 ? '#2ea04399' : '#f8514999'
        });

        // Spread
        C.line(document.getElementById('c-spread'), spreads.map(v => v / pipSize), {
            colors: ['#d2a520'], fill: true, decimals: 2
        });

        // Velocity
        C.bars(document.getElementById('c-velocity'), velocities, {
            colorFn: (v, i) => `hsl(${M.clamp(v/5*60, 0, 120)}, 80%, 50%)99`
        });

        // Intra-bar vol
        C.line(document.getElementById('c-ibvol'), ranges.map(v => v / pipSize), {
            colors: ['#58a6ff'], fill: true, decimals: 4
        });

        // Heatmap
        buildHeatmap(data, features);

        log.ok(`✓ Flow analysis complete. ${features.length} bars analyzed.`);

        // Store for export
        window._taFlowData = features.map((f, i) => ({ bar: i, ...f }));
    }

    function buildHeatmap(data, features) {
        const container = document.getElementById('ta-heatmap');
        const n         = Math.min(features.length, 200);
        const cols       = Math.min(n, 50);
        const rows       = Math.ceil(n / cols);

        const ofis   = features.slice(0, n).map(f => f.ofi);
        const ofiMax = Math.max(Math.abs(M.min(ofis)), Math.abs(M.max(ofis))) || 1;

        container.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
        container.className = 'ta-heatmap';
        container.innerHTML = '';

        const cellH = Math.max(14, Math.min(28, Math.floor(200 / rows)));

        features.slice(0, n).forEach((f, i) => {
            const v   = f.ofi / ofiMax;
            const cell = document.createElement('div');
            cell.className = 'ta-hm-cell';
            cell.style.height = cellH + 'px';

            if (v > 0) {
                const g = Math.floor(M.clamp(v, 0, 1) * 255);
                cell.style.background = `rgb(0,${g},60)`;
            } else {
                const r = Math.floor(M.clamp(-v, 0, 1) * 255);
                cell.style.background = `rgb(${r},0,40)`;
            }

            cell.title = `Bar ${i}: OFI=${f.ofi.toFixed(5)}, spread=${f.spreadMean.toFixed(5)}, vel=${f.velocity.toFixed(1)}`;
            container.appendChild(cell);
        });
    }

    function detectPipSize(avgSpread) {
        if (avgSpread < 0.0001) return 0.00001;
        if (avgSpread < 0.01)   return 0.0001;
        if (avgSpread < 0.1)    return 0.01;
        return 1;
    }

    // ═══════════════════════════════════════════════════════════════
    // MODULE 2: NEURAL FINGERPRINT (Autoencoder + K-Means)
    // ═══════════════════════════════════════════════════════════════

    let _nnModel = null;

    async function runNeuralFingerprint() {
        const archStr  = document.getElementById('ta-nn-arch').value;
        const epochs   = parseInt(document.getElementById('ta-nn-epochs').value) || 150;
        const K        = parseInt(document.getElementById('ta-nn-k').value) || 5;
        const log      = makeLog('ta-nn-log');
        const progEl   = document.getElementById('ta-nn-prog');

        log.inf(`Preparing tick features...`);
        setProgress(progEl, 0);

        const data = (window.app?.activedata || []).slice(-1000).filter(b =>
            b.ticks && b.ticks.length >= 3
        );

        if (data.length < 30) {
            log.err(`Need ≥30 bars with ticks. Found: ${data.length}`);
            return;
        }

        log.inf(`Extracting features from ${data.length} bars...`);
        await sleep(20);

        const rawFeatures = data.map(b => extractTickFeatures(b)).filter(Boolean);
        const featureStats = computeFeatureStats(rawFeatures);

        // Normalize features
        const featureKeys = Object.keys(featureStats);
        const X = rawFeatures.map(f => normFeatures(f, featureStats));
        const inputDim = X[0].length;

        log.inf(`Feature dim: ${inputDim}, samples: ${X.length}`);
        log.inf(`Architecture: ${inputDim}→${archStr}→${inputDim} autoencoder`);
        await sleep(20);

        // Parse arch
        const hiddenSizes = archStr.split('-').map(Number);
        const latentDim   = hiddenSizes[hiddenSizes.length - 1];
        const encoderSizes = [inputDim, ...hiddenSizes];
        const decoderSizes = [...hiddenSizes].reverse();
        decoderSizes.push(inputDim);

        // Init weights (Xavier)
        function initWeights(n, m) {
            const w = [];
            const scale = Math.sqrt(2 / (n + m));
            for (let i = 0; i < m; i++) {
                const row = [];
                for (let j = 0; j < n; j++) row.push((Math.random() * 2 - 1) * scale);
                w.push(row);
            }
            return w;
        }
        function initBias(m) { return new Array(m).fill(0); }

        // Encoder layers
        const encW = [], encB = [];
        for (let i = 0; i < encoderSizes.length - 1; i++) {
            encW.push(initWeights(encoderSizes[i], encoderSizes[i+1]));
            encB.push(initBias(encoderSizes[i+1]));
        }
        // Decoder layers
        const decW = [], decB = [];
        for (let i = 0; i < decoderSizes.length - 1; i++) {
            decW.push(initWeights(decoderSizes[i], decoderSizes[i+1]));
            decB.push(initBias(decoderSizes[i+1]));
        }

        function forward(x) {
            let h = [...x];
            const encActs = [h];
            for (let l = 0; l < encW.length; l++) {
                const next = encB[l].map((b, i) => {
                    let s = b;
                    for (let j = 0; j < h.length; j++) s += encW[l][i][j] * h[j];
                    return l < encW.length - 1 ? M.relu(s) : s; // latent: linear
                });
                h = next;
                encActs.push(h);
            }
            const latent = h;

            let d = [...latent];
            const decActs = [d];
            for (let l = 0; l < decW.length; l++) {
                const next = decB[l].map((b, i) => {
                    let s = b;
                    for (let j = 0; j < d.length; j++) s += decW[l][i][j] * d[j];
                    return l < decW.length - 1 ? M.relu(s) : s; // output: linear
                });
                d = next;
                decActs.push(d);
            }
            return { latent, output: d, encActs, decActs };
        }

        const lr = 0.01;
        const lossHistory = [];

        log.inf(`Training ${epochs} epochs...`);
        await sleep(10);

        // Mini-batch SGD
        const batchSize = Math.min(32, X.length);

        for (let ep = 0; ep < epochs; ep++) {
            let totalLoss = 0;

            // Shuffle
            const idx = shuffle(X.map((_,i) => i));
            const batch = idx.slice(0, batchSize);

            for (const bi of batch) {
                const { latent, output, encActs, decActs } = forward(X[bi]);

                // MSE loss
                let loss = 0;
                const outGrad = output.map((v, i) => {
                    const e = v - X[bi][i];
                    loss += e * e;
                    return 2 * e / output.length;
                });
                totalLoss += loss / output.length;

                // Backprop decoder
                let dL = [...outGrad];
                for (let l = decW.length - 1; l >= 0; l--) {
                    const prevAct = decActs[l];
                    const curAct  = decActs[l + 1];
                    const dPrev   = new Array(prevAct.length).fill(0);

                    for (let i = 0; i < decW[l].length; i++) {
                        const g = dL[i] * (l < decW.length - 1 ? (curAct[i] > 0 ? 1 : 0) : 1);
                        decB[l][i] -= lr * g;
                        for (let j = 0; j < decW[l][i].length; j++) {
                            decW[l][i][j] -= lr * g * prevAct[j];
                            dPrev[j] += g * decW[l][i][j];
                        }
                    }
                    dL = dPrev;
                }

                // Backprop encoder
                for (let l = encW.length - 1; l >= 0; l--) {
                    const prevAct = encActs[l];
                    const curAct  = encActs[l + 1];
                    const dPrev   = new Array(prevAct.length).fill(0);

                    for (let i = 0; i < encW[l].length; i++) {
                        const g = dL[i] * (l < encW.length - 1 ? (curAct[i] > 0 ? 1 : 0) : 1);
                        encB[l][i] -= lr * g;
                        for (let j = 0; j < encW[l][i].length; j++) {
                            encW[l][i][j] -= lr * g * prevAct[j];
                            dPrev[j] += g * encW[l][i][j];
                        }
                    }
                    dL = dPrev;
                }
            }

            lossHistory.push(totalLoss / batchSize);

            if (ep % 10 === 0 || ep === epochs - 1) {
                setProgress(progEl, Math.round((ep + 1) / epochs * 80));
                if (ep % 30 === 0) {
                    log.inf(`Epoch ${ep+1}/${epochs} — Loss: ${(totalLoss / batchSize).toFixed(6)}`);
                    await sleep(0);
                }
            }
        }

        log.inf(`Training complete. Computing latents & errors...`);
        await sleep(10);

        // Compute latents and reconstruction errors
        const latents = [];
        const errors  = [];
        X.forEach((x, i) => {
            const { latent, output } = forward(x);
            latents.push(latent);
            const err = M.mean(output.map((v, j) => (v - x[j]) ** 2));
            errors.push(err);
        });

        const errMean = M.mean(errors);
        const errStd  = M.std(errors);
        const anomalies = errors
            .map((e, i) => ({ e, i, zscore: (e - errMean) / (errStd + 1e-10) }))
            .filter(a => a.zscore > 3)
            .sort((a, b) => b.zscore - a.zscore);

        log.ok(`Reconstruction MSE: ${errMean.toFixed(6)} ± ${errStd.toFixed(6)}`);
        log.inf(`Anomalies (>3σ): ${anomalies.length} bars`);

        // K-Means on 2D latent (use first 2 dims)
        setProgress(progEl, 85);
        const pts2D = latents.map(l => [l[0] || 0, l[1] || 0]);
        const { labels: clusterLabels, centroids, silhouette } = kmeans(pts2D, K);

        log.ok(`K-means clustering done. Silhouette: ${silhouette.toFixed(3)}`);
        setProgress(progEl, 100);

        // Save model
        _nnModel = { encW, encB, decW, decB, featureStats, featureKeys,
                     errMean, errStd, clusterLabels, centroids };

        // Update UI
        document.getElementById('nn-recon-err').textContent   = errMean.toFixed(6);
        document.getElementById('nn-anomalies').textContent   = anomalies.length;
        document.getElementById('nn-clusters').textContent    = K;
        document.getElementById('nn-silhouette').textContent  = silhouette.toFixed(3);
        document.getElementById('nn-silhouette').className    =
            'ta-card-value ' + (silhouette > 0.5 ? 'pos' : silhouette > 0.25 ? 'neu' : 'neg');

        document.getElementById('ta-nn-results').style.display = '';

        await sleep(10);

        // Draw loss
        C.line(document.getElementById('c-loss'), lossHistory, {
            colors: ['#f85149'], fill: true, decimals: 6
        });

        // Draw latent space scatter
        const scatterPts = pts2D.map((p, i) => ({
            x: p[0], y: p[1], c: clusterLabels[i]
        }));
        C.scatter(document.getElementById('c-latent'), scatterPts);

        // Draw cluster distribution
        const clusterCounts = Array.from({ length: K }, (_, k) =>
            clusterLabels.filter(l => l === k).length
        );
        C.pie(document.getElementById('c-clusters'), clusterCounts,
            clusterCounts.map((_, k) => `Cluster ${k}`));

        // Draw feature importance (encoder first layer weights L2 norm per input)
        const importances = featureKeys.map((key, j) => {
            const norm = Math.sqrt(encW[0].reduce((s, row) => s + (row[j] || 0) ** 2, 0));
            return { key, norm };
        }).sort((a, b) => b.norm - a.norm);

        renderWeightBars('ta-weights', importances.slice(0, 10), importances[0].norm, '#58a6ff');

        // Draw anomaly list
        renderAnomalyList(anomalies, data, errors);

        log.ok(`✓ Neural Fingerprint complete.`);
    }

    function renderWeightBars(containerId, items, maxVal, color) {
        const el = document.getElementById(containerId);
        el.innerHTML = items.map(item => `
            <div class="ta-weight-bar">
                <div class="ta-weight-name">${item.key}</div>
                <div class="ta-weight-track">
                    <div class="ta-weight-fill" style="width:${M.clamp(item.norm/maxVal*100,0,100).toFixed(1)}%;background:${color}"></div>
                </div>
                <div class="ta-weight-val">${item.norm.toFixed(4)}</div>
            </div>
        `).join('');
    }

    function renderAnomalyList(anomalies, data, errors) {
        const el = document.getElementById('ta-anomaly-list');
        if (!anomalies.length) {
            el.innerHTML = '<div class="ta-empty">No anomalies detected (all bars within 3σ)</div>';
            return;
        }
        const top20 = anomalies.slice(0, 20);
        el.innerHTML = top20.map(a => {
            const bar = data[a.i];
            const ts  = bar?.timestamp ? new Date(bar.timestamp).toLocaleString() : `Bar #${a.i}`;
            const icon = a.zscore > 5 ? '🔴' : a.zscore > 4 ? '🟠' : '🟡';
            const c  = a.zscore > 5 ? '#f85149' : a.zscore > 4 ? '#ff6b35' : '#d2a520';
            return `
                <div class="ta-anomaly-row" onclick="window.tickAnalytics.jumpToBar(${a.i})">
                    <div class="ta-anomaly-icon">${icon}</div>
                    <div class="ta-anomaly-info">
                        <div class="ta-anomaly-ts">${ts}</div>
                        <div class="ta-anomaly-desc">Error: ${errors[a.i].toFixed(6)} | Ticks: ${data[a.i]?.ticks?.length||0}</div>
                    </div>
                    <div class="ta-anomaly-score" style="color:${c};background:${c}22">${a.zscore.toFixed(2)}σ</div>
                </div>`;
        }).join('');
    }

    // K-Means
    function kmeans(pts, K, maxIter = 50) {
        let centroids = pts.slice(0, K).map(p => [...p]);
        let labels    = new Array(pts.length).fill(0);

        for (let iter = 0; iter < maxIter; iter++) {
            // Assign
            let changed = false;
            pts.forEach((p, i) => {
                let minD = Infinity, best = 0;
                centroids.forEach((c, k) => {
                    const d = p.reduce((s, v, j) => s + (v - c[j]) ** 2, 0);
                    if (d < minD) { minD = d; best = k; }
                });
                if (labels[i] !== best) { labels[i] = best; changed = true; }
            });
            if (!changed) break;

            // Update centroids
            centroids = Array.from({ length: K }, (_, k) => {
                const members = pts.filter((_, i) => labels[i] === k);
                if (!members.length) return centroids[k];
                return pts[0].map((_, j) => M.mean(members.map(p => p[j])));
            });
        }

        // Silhouette score (simplified)
        const sils = pts.map((p, i) => {
            const k = labels[i];
            const same = pts.filter((_, j) => labels[j] === k && j !== i);
            if (!same.length) return 0;
            const a = M.mean(same.map(q => Math.sqrt(p.reduce((s,v,j) => s+(v-q[j])**2, 0))));
            let b = Infinity;
            for (let k2 = 0; k2 < K; k2++) {
                if (k2 === k) continue;
                const other = pts.filter((_, j) => labels[j] === k2);
                if (!other.length) continue;
                const d = M.mean(other.map(q => Math.sqrt(p.reduce((s,v,j) => s+(v-q[j])**2, 0))));
                if (d < b) b = d;
            }
            return b === Infinity ? 0 : (b - a) / Math.max(a, b);
        });

        return { labels, centroids, silhouette: M.mean(sils) };
    }

    function shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    // ═══════════════════════════════════════════════════════════════
    // MODULE 3: PREDICTIVE SPREAD ENGINE (Logistic Regression)
    // ═══════════════════════════════════════════════════════════════

    let _predModel = null;

    async function runPredictiveEngine() {
        const splitRatio = parseFloat(document.getElementById('ta-pred-split').value) || 0.8;
        const lr         = parseFloat(document.getElementById('ta-pred-lr').value) || 0.05;
        const epochs     = parseInt(document.getElementById('ta-pred-epochs').value) || 200;
        const log        = makeLog('ta-pred-log');
        const progEl     = document.getElementById('ta-pred-prog');

        log.inf(`Preparing training data...`);
        setProgress(progEl, 0);

        const data = (window.app?.activedata || []).filter(b => b.ticks && b.ticks.length >= 3);

        if (data.length < 50) {
            log.err(`Need ≥50 bars with ticks. Found: ${data.length}`);
            return;
        }

        // Build (X, y) pairs: features from bar[i] → label from bar[i+1] direction
        const pairs = [];
        for (let i = 0; i < data.length - 1; i++) {
            const f = extractTickFeatures(data[i]);
            if (!f) continue;
            const nextClose = parseFloat(data[i+1].close);
            const curClose  = parseFloat(data[i].close);
            const y = nextClose > curClose ? 1 : 0;
            pairs.push({ f, y, bar: data[i], idx: i });
        }

        log.inf(`${pairs.length} labeled samples prepared`);
        await sleep(10);

        // Normalize
        const featureStats = computeFeatureStats(pairs.map(p => p.f));
        const FEAT_KEYS     = Object.keys(featureStats);
        const X = pairs.map(p => normFeatures(p.f, featureStats));
        const Y = pairs.map(p => p.y);

        // Train/test split
        const splitIdx = Math.floor(pairs.length * splitRatio);
        const Xtr = X.slice(0, splitIdx), Ytr = Y.slice(0, splitIdx);
        const Xte = X.slice(splitIdx),    Yte = Y.slice(splitIdx);

        log.inf(`Train: ${Xtr.length}, Test: ${Xte.length}`);

        // Logistic Regression with L2
        const dim = X[0].length;
        let W = new Array(dim).fill(0).map(() => (Math.random() - 0.5) * 0.1);
        let b = 0;
        const lambda = 0.001;
        const lossHistory = [];

        for (let ep = 0; ep < epochs; ep++) {
            const idx = shuffle(Xtr.map((_, i) => i));
            const batch = idx.slice(0, Math.min(64, Xtr.length));
            let totalLoss = 0;

            for (const bi of batch) {
                const x = Xtr[bi], y = Ytr[bi];
                const logit = M.dot(W, x) + b;
                const p     = M.sigmoid(logit);
                const err   = p - y;
                totalLoss  -= y * Math.log(p + 1e-10) + (1-y) * Math.log(1-p + 1e-10);

                // Gradient
                W = W.map((w, j) => w - lr * (err * x[j] + lambda * w));
                b -= lr * err;
            }

            lossHistory.push(totalLoss / batch.length);

            if (ep % 20 === 0 || ep === epochs - 1) {
                setProgress(progEl, Math.round((ep+1) / epochs * 90));
                await sleep(0);
            }
        }

        log.inf(`Training done. Evaluating on test set...`);
        await sleep(10);

        // Evaluate
        const probs = Xte.map(x => M.sigmoid(M.dot(W, x) + b));
        const preds = probs.map(p => p >= 0.5 ? 1 : 0);

        let tp=0, fp=0, tn=0, fn=0;
        Yte.forEach((y, i) => {
            if (y===1 && preds[i]===1) tp++;
            else if (y===0 && preds[i]===1) fp++;
            else if (y===0 && preds[i]===0) tn++;
            else fn++;
        });

        const acc       = (tp+tn) / Yte.length;
        const precision = tp/(tp+fp+1e-10);
        const recall    = tp/(tp+fn+1e-10);
        const f1        = 2*precision*recall/(precision+recall+1e-10);
        const logLoss   = -M.mean(Yte.map((y,i) => y*Math.log(probs[i]+1e-10)+(1-y)*Math.log(1-probs[i]+1e-10)));

        // AUC (trapezoid)
        const auc = computeAUC(Yte, probs);

        log.ok(`Accuracy: ${(acc*100).toFixed(1)}% | AUC: ${auc.toFixed(3)} | F1: ${f1.toFixed(3)}`);
        setProgress(progEl, 100);

        // Predict current bar
        const lastBar = data[data.length - 1];
        const lastF   = extractTickFeatures(lastBar);
        let currentPred = null;
        if (lastF) {
            const xNorm  = normFeatures(lastF, featureStats);
            const prob   = M.sigmoid(M.dot(W, xNorm) + b);
            currentPred  = { prob, signal: prob >= 0.5 ? '▲ BULL' : '▼ BEAR',
                             confidence: Math.abs(prob - 0.5) * 2 };
        }

        // Save model
        _predModel = { W, b, featureStats, FEAT_KEYS };

        // Update cards
        document.getElementById('pr-acc').textContent    = (acc * 100).toFixed(1) + '%';
        document.getElementById('pr-auc').textContent    = auc.toFixed(3);
        document.getElementById('pr-prec').textContent   = (precision*100).toFixed(1)+'%';
        document.getElementById('pr-rec').textContent    = (recall*100).toFixed(1)+'%';
        document.getElementById('pr-f1').textContent     = f1.toFixed(3);
        document.getElementById('pr-loss').textContent   = logLoss.toFixed(4);

        ['pr-acc','pr-auc','pr-prec','pr-rec','pr-f1'].forEach(id => {
            const el = document.getElementById(id);
            const val = parseFloat(el.textContent);
            el.className = 'ta-card-value ' + (val > 55 ? 'pos' : val > 45 ? 'neu' : 'neg');
        });

        if (currentPred) {
            const bullEl = document.getElementById('pr-bull-prob');
            const sigEl  = document.getElementById('pr-signal');
            const confEl = document.getElementById('pr-confidence');
            bullEl.textContent  = (currentPred.prob * 100).toFixed(1) + '%';
            bullEl.className    = 'ta-gauge-value ' + (currentPred.prob > 0.5 ? 'pos' : 'neg');
            sigEl.textContent   = currentPred.signal;
            sigEl.className     = 'ta-gauge-value ' + (currentPred.prob > 0.5 ? 'pos' : 'neg');
            confEl.textContent  = (currentPred.confidence * 100).toFixed(1) + '%';
            confEl.className    = 'ta-gauge-value ' + (currentPred.confidence > 0.6 ? 'pos' : 'neu');
        }

        document.getElementById('ta-pred-results').style.display = '';
        await sleep(10);

        // Feature importance
        const absW = FEAT_KEYS.map((k, j) => ({ key: k, norm: Math.abs(W[j]) }))
            .sort((a,b) => b.norm - a.norm);
        renderWeightBars('ta-pred-weights', absW.slice(0, 10), absW[0].norm, '#d2a520');

        // Loss curve
        C.line(document.getElementById('c-pred-loss'), lossHistory, {
            colors: ['#f85149'], fill: true, decimals: 4
        });

        // Pred vs actual (last 80 test samples)
        const last80 = probs.slice(-80);
        const last80Y = Yte.slice(-80);
        C.line(document.getElementById('c-pred-vs-actual'),
            last80.map((p, i) => [p, last80Y[i]]), {
                colors: ['#2962ff', '#3fb950'],
                decimals: 2,
                yMin: 0, yMax: 1
            });

        // Calibration curve
        const calBuckets = 10;
        const calData = Array.from({ length: calBuckets }, (_, k) => {
            const lo = k / calBuckets, hi = (k + 1) / calBuckets;
            const bucket = probs.map((p, i) => ({ p, y: Yte[i] })).filter(d => d.p >= lo && d.p < hi);
            return bucket.length ? M.mean(bucket.map(d => d.y)) : k / calBuckets;
        });
        C.line(document.getElementById('c-calibration'), calData, {
            colors: ['#58a6ff'], decimals: 2, yMin: 0, yMax: 1
        });

        log.ok(`✓ Predictive Engine trained. Test accuracy: ${(acc*100).toFixed(1)}%.`);
    }

    function computeAUC(y, probs) {
        const pairs = probs.map((p, i) => ({ p, y: y[i] })).sort((a,b) => b.p - a.p);
        let tp = 0, fp = 0, prevTp = 0, prevFp = 0, auc = 0;
        const pos = y.filter(v => v===1).length, neg = y.length - pos;
        if (!pos || !neg) return 0.5;
        pairs.forEach(({p, y}) => {
            if (y===1) tp++; else fp++;
            auc += (fp - prevFp) * (tp + prevTp) / 2;
            prevTp = tp; prevFp = fp;
        });
        return auc / (pos * neg);
    }

    // ═══════════════════════════════════════════════════════════════
    // UI HELPERS
    // ═══════════════════════════════════════════════════════════════

    function makeLog(id) {
        const el = document.getElementById(id);
        el.innerHTML = '';
        return {
            inf: m => { el.innerHTML += `<div class="inf">[INFO] ${m}</div>`; el.scrollTop = 9999; },
            ok:  m => { el.innerHTML += `<div class="ok">[OK] ${m}</div>`;   el.scrollTop = 9999; },
            err: m => { el.innerHTML += `<div class="err">[ERR] ${m}</div>`; el.scrollTop = 9999; },
            neu: m => { el.innerHTML += `<div class="neu">[LOG] ${m}</div>`; el.scrollTop = 9999; },
        };
    }

    function setProgress(el, pct) {
        if (el) el.style.width = pct + '%';
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ═══════════════════════════════════════════════════════════════
    // INIT & MOUNT
    // ═══════════════════════════════════════════════════════════════

    function mount() {
        const div = document.createElement('div');
        div.innerHTML = buildHTML();
        document.body.appendChild(div);

        // Tabs
        document.querySelectorAll('.ta-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.ta-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.ta-section').forEach(s => s.classList.remove('active'));
                tab.classList.add('active');
                const sec = document.getElementById('ta-sec-' + tab.dataset.tab);
                if (sec) sec.classList.add('active');
            });
        });

        // Close
        document.getElementById('ta-close-btn').addEventListener('click', close);
        document.getElementById('ta-overlay').addEventListener('click', e => {
            if (e.target === document.getElementById('ta-overlay')) close();
        });

        // Buttons
        document.getElementById('ta-flow-run').addEventListener('click', runFlowAnalysis);
        document.getElementById('ta-nn-run').addEventListener('click', runNeuralFingerprint);
        document.getElementById('ta-pred-run').addEventListener('click', runPredictiveEngine);

        // Export
        document.getElementById('ta-flow-export').addEventListener('click', exportFlowCSV);

        // Update badges on open
        updateBadges();
    }

    function updateBadges() {
        const data = window.app?.activedata || [];
        const withTicks = data.filter(b => b.ticks && b.ticks.length > 0);
        const totalTicks = withTicks.reduce((s, b) => s + b.ticks.length, 0);

        const bEl = document.getElementById('ta-bars-badge');
        const tEl = document.getElementById('ta-ticks-badge');
        if (bEl) bEl.textContent = `${withTicks.length} bars`;
        if (tEl) tEl.textContent = `${totalTicks.toLocaleString()} ticks`;
    }

    function open() {
        document.getElementById('ta-overlay').classList.add('ta-open');
        updateBadges();
    }

    function close() {
        document.getElementById('ta-overlay').classList.remove('ta-open');
    }

    function exportFlowCSV() {
        if (!window._taFlowData) { alert('Run Flow Analysis first.'); return; }
        const keys = Object.keys(window._taFlowData[0]);
        const csv  = [keys.join(','), ...window._taFlowData.map(r =>
            keys.map(k => r[k]).join(',')
        )].join('\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
        a.download = 'tick_flow_analysis.csv';
        a.click();
    }

    // Jump to bar on chart
    function jumpToBar(idx) {
        const data = (window.app?.activedata || []).filter(b => b.ticks && b.ticks.length >= 3);
        const bar  = data[idx];
        if (!bar) return;
        try {
            const chart = window.app?.widget?.activeChart();
            const ts    = Math.floor(new Date(bar.timestamp).getTime() / 1000);
            if (chart && ts) chart.setVisibleRange({ from: ts - 3600, to: ts + 3600 });
        } catch (_) {}
    }

    // ─── ADD TOOLBAR BUTTON ──────────────────────────────────────────
    function addToolbarButton() {
        // Try to add after DOM ready
        const tryAdd = () => {
            const toolbar = document.querySelector('.header-actions, .app-header, #app-toolbar, .toolbar-right');
            if (toolbar) {
                const btn = document.createElement('button');
                btn.innerHTML = '⚡ Tick Analytics';
                btn.style.cssText = `
                    background: rgba(41,98,255,0.15);
                    color: #58a6ff;
                    border: 1px solid rgba(88,166,255,0.3);
                    border-radius: 6px;
                    padding: 6px 14px;
                    font-size: 12px;
                    font-family: monospace;
                    cursor: pointer;
                    margin-left: 8px;
                    font-weight: 600;
                    transition: all 0.15s;
                `;
                btn.onmouseenter = () => btn.style.background = 'rgba(41,98,255,0.3)';
                btn.onmouseleave = () => btn.style.background = 'rgba(41,98,255,0.15)';
                btn.addEventListener('click', open);
                toolbar.appendChild(btn);
                return true;
            }
            return false;
        };

        if (!tryAdd()) {
            const observer = new MutationObserver(() => {
                if (tryAdd()) observer.disconnect();
            });
            observer.observe(document.body, { childList: true, subtree: true });
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════

    window.tickAnalytics = {
        open,
        close,
        analyze: runFlowAnalysis,
        trainNeural: runNeuralFingerprint,
        trainPredictor: runPredictiveEngine,
        jumpToBar,
        // Predict single bar from outside
        predict(bar) {
            if (!_predModel) return null;
            const f = extractTickFeatures(bar);
            if (!f) return null;
            const x = normFeatures(f, _predModel.featureStats);
            const p = M.sigmoid(M.dot(_predModel.W, x) + _predModel.b);
            return { prob: p, bull: p >= 0.5, confidence: Math.abs(p - 0.5) * 2 };
        },
        // Get anomaly score for a bar
        anomalyScore(bar) {
            if (!_nnModel) return null;
            const f = extractTickFeatures(bar);
            if (!f) return null;
            // Forward pass encoder+decoder
            let h = normFeatures(f, _nnModel.featureStats);
            for (let l = 0; l < _nnModel.encW.length; l++) {
                const next = _nnModel.encB[l].map((bv, i) => {
                    let s = bv;
                    for (let j = 0; j < h.length; j++) s += _nnModel.encW[l][i][j] * h[j];
                    return l < _nnModel.encW.length - 1 ? Math.max(0, s) : s;
                });
                h = next;
            }
            for (let l = 0; l < _nnModel.decW.length; l++) {
                const next = _nnModel.decB[l].map((bv, i) => {
                    let s = bv;
                    for (let j = 0; j < h.length; j++) s += _nnModel.decW[l][i][j] * h[j];
                    return l < _nnModel.decW.length - 1 ? Math.max(0, s) : s;
                });
                h = next;
            }
            const orig = normFeatures(f, _nnModel.featureStats);
            const err = M.mean(h.map((v, i) => (v - orig[i]) ** 2));
            const z   = (err - _nnModel.errMean) / (_nnModel.errStd + 1e-10);
            return { error: err, zscore: z, isAnomaly: z > 3 };
        }
    };

    // Mount on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { mount(); addToolbarButton(); });
    } else {
        mount();
        addToolbarButton();
    }

})();