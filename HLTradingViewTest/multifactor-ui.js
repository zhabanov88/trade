/**
 * multifactor-ui.js  v1.0
 *
 * Multi-Factor Alpha Engine.
 * Добавляет вкладку "⚡ Alpha" в панель 🧠 AI.
 *
 * Что делает:
 *   1. Извлекает факторы из трейдов (время, R:R, direction, session, barsHeld, streak)
 *   2. Обучает логистическую регрессию (gradient descent, без зависимостей)
 *   3. Показывает factor importance, распределение P(win) по трейдам
 *   4. Строит ожидаемый Win Rate при применении фильтров
 *   5. Даёт рекомендации — какие факторы улучшают результат
 *
 * Полностью клиентский — никаких API вызовов.
 * Подключение в index.html ПОСЛЕ temporal-heatmap-ui.js:
 *   <script src="multifactor-ui.js"></script>
 */

if (window._mfaLoaded) {} else { window._mfaLoaded = true; (function () {
    'use strict';
    
    // ════════════════════════════════════════════════════════════════
    // STATE
    // ════════════════════════════════════════════════════════════════
    
    const MFA = {
        result:  null,
        running: false,
        cfg: {
            setupFilter:  '',
            threshold:    0.55,   // P(win) > threshold → trade
            lr:           0.05,   // learning rate
            epochs:       500,
            l2:           0.01,   // L2 регуляризация
            testSplit:    0.2,    // 20% holdout
        },
        charts: {},
    };
    
    // ════════════════════════════════════════════════════════════════
    // FACTOR DEFINITIONS
    // Все факторы извлекаются из полей трейда без доступа к барам
    // ════════════════════════════════════════════════════════════════
    
    const FACTORS = [
        {
            id: 'hour_sin', label: 'Hour (sin)',
            desc: 'Sine encoding of entry hour — captures cyclical time pattern',
            extract: t => Math.sin(2 * Math.PI * getHour(t.entryTs) / 24),
        },
        {
            id: 'hour_cos', label: 'Hour (cos)',
            desc: 'Cosine encoding of entry hour',
            extract: t => Math.cos(2 * Math.PI * getHour(t.entryTs) / 24),
        },
        {
            id: 'dow_sin', label: 'Weekday (sin)',
            desc: 'Sine encoding of day of week',
            extract: t => Math.sin(2 * Math.PI * getDow(t.entryTs) / 7),
        },
        {
            id: 'dow_cos', label: 'Weekday (cos)',
            desc: 'Cosine encoding of day of week',
            extract: t => Math.cos(2 * Math.PI * getDow(t.entryTs) / 7),
        },
        {
            id: 'rr_planned', label: 'Planned R:R',
            desc: 'Risk-reward ratio at entry: |TP-entry| / |SL-entry|',
            extract: t => {
                if (!t.sl || !t.tp || !t.entry) return 0;
                const risk   = Math.abs(t.entry - t.sl);
                const reward = Math.abs(t.tp    - t.entry);
                return risk > 0 ? Math.min(reward / risk, 10) : 0;
            },
        },
        {
            id: 'sl_dist_pct', label: 'SL Distance %',
            desc: 'Stop-loss distance as % of entry price',
            extract: t => {
                if (!t.sl || !t.entry) return 0;
                return Math.min(Math.abs(t.entry - t.sl) / t.entry * 100, 5);
            },
        },
        {
            id: 'is_long', label: 'Direction (Long)',
            desc: '1 if long trade, 0 if short',
            extract: t => t.dir === 'long' ? 1 : 0,
        },
        {
            id: 'session_asia', label: 'Asia Session',
            desc: '1 if entry during Asia session (UTC 00-09)',
            extract: t => { const h = getHour(t.entryTs); return (h >= 0  && h < 9)  ? 1 : 0; },
        },
        {
            id: 'session_london', label: 'London Session',
            desc: '1 if entry during London session (UTC 07-16)',
            extract: t => { const h = getHour(t.entryTs); return (h >= 7  && h < 16) ? 1 : 0; },
        },
        {
            id: 'session_ny', label: 'NY Session',
            desc: '1 if entry during NY session (UTC 13-22)',
            extract: t => { const h = getHour(t.entryTs); return (h >= 13 && h < 22) ? 1 : 0; },
        },
        {
            id: 'bars_held_log', label: 'Bars Held (log)',
            desc: 'Log of bars held — captures trade duration non-linearly',
            extract: t => t.barsHeld > 0 ? Math.log(t.barsHeld + 1) : 0,
        },
        {
            id: 'win_streak', label: 'Win Streak',
            desc: 'Consecutive wins before this trade (momentum)',
            extract: (t, ctx) => Math.min(ctx.winStreak, 5),
        },
        {
            id: 'loss_streak', label: 'Loss Streak',
            desc: 'Consecutive losses before this trade (tilt factor)',
            extract: (t, ctx) => Math.min(ctx.lossStreak, 5),
        },
        {
            id: 'capital_drawdown', label: 'Capital DD%',
            desc: 'Current drawdown from peak capital at entry',
            extract: (t, ctx) => Math.min(ctx.drawdownPct, 20),
        },
        {
            id: 'trade_idx_norm', label: 'Trade Age',
            desc: 'Normalized trade index — captures whether edge degrades over time',
            extract: (t, ctx) => ctx.totalN > 1 ? ctx.idx / (ctx.totalN - 1) : 0,
        },
        {
            id: 'tp_hit', label: 'TP Exit',
            desc: '1 if trade exited via TP (lagged signal — info only)',
            extract: t => t.exitReason === 'TP' ? 1 : 0,
            isLeaky: true,   // знаем только постфактум — используем как аналитический фактор
        },
    ];
    
    // ════════════════════════════════════════════════════════════════
    // FEATURE EXTRACTION
    // ════════════════════════════════════════════════════════════════
    
    function getHour(ts) {
        if (!ts) return 0;
        const ms = typeof ts === 'number' ? (ts < 2e12 ? ts * 1000 : ts) : new Date(ts).getTime();
        return new Date(ms).getUTCHours();
    }
    function getDow(ts) {
        if (!ts) return 0;
        const ms = typeof ts === 'number' ? (ts < 2e12 ? ts * 1000 : ts) : new Date(ts).getTime();
        const d  = new Date(ms).getUTCDay(); // 0=Sun
        return d === 0 ? 6 : d - 1;         // Mon=0..Sun=6
    }
    
    function extractFeatures(trades) {
        // Строим контекстный вектор для каждого трейда
        let winStreak = 0, lossStreak = 0;
        let peakCapital = trades[0]?.capitalBefore || 10000;
        const totalN = trades.length;
    
        const rows = [];
        trades.forEach((t, idx) => {
            const curCap = t.capitalBefore || peakCapital;
            if (curCap > peakCapital) peakCapital = curCap;
            const drawdownPct = peakCapital > 0
                ? Math.max(0, (peakCapital - curCap) / peakCapital * 100)
                : 0;
    
            const ctx = { winStreak, lossStreak, drawdownPct, idx, totalN };
    
            // Извлекаем только не-leaky факторы для обучения
            const trainFactors = FACTORS.filter(f => !f.isLeaky);
            const xVec = trainFactors.map(f => {
                try { return f.extract(t, ctx); }
                catch(_) { return 0; }
            });
    
            const y = t.pnl > 0 ? 1 : 0;
    
            rows.push({ t, xVec, y, ctx, idx });
    
            // Обновляем streak
            if (t.pnl > 0) { winStreak++;  lossStreak = 0; }
            else            { lossStreak++; winStreak  = 0; }
        });
    
        return { rows, factorDefs: FACTORS.filter(f => !f.isLeaky) };
    }
    
    // ════════════════════════════════════════════════════════════════
    // NORMALIZATION
    // ════════════════════════════════════════════════════════════════
    
    function normalizeFeatures(rows, factorDefs) {
        const n = factorDefs.length;
        const means = new Array(n).fill(0);
        const stds  = new Array(n).fill(1);
    
        // Mean
        for (const r of rows) for (let j = 0; j < n; j++) means[j] += r.xVec[j];
        for (let j = 0; j < n; j++) means[j] /= rows.length;
    
        // Std
        for (const r of rows) for (let j = 0; j < n; j++) stds[j] += (r.xVec[j] - means[j]) ** 2;
        for (let j = 0; j < n; j++) {
            stds[j] = Math.sqrt(stds[j] / rows.length);
            if (stds[j] < 1e-8) stds[j] = 1;
        }
    
        // Normalize in-place
        for (const r of rows) {
            r.xNorm = r.xVec.map((v, j) => (v - means[j]) / stds[j]);
        }
    
        return { means, stds };
    }
    
    // ════════════════════════════════════════════════════════════════
    // LOGISTIC REGRESSION (gradient descent + L2)
    // ════════════════════════════════════════════════════════════════
    
    function sigmoid(z) {
        return z >= 0
            ? 1 / (1 + Math.exp(-z))
            : Math.exp(z) / (1 + Math.exp(z));
    }
    
    function logisticTrain(rows, nFeatures, cfg) {
        const { lr, epochs, l2 } = cfg;
        let w = new Array(nFeatures).fill(0);
        let b = 0;
    
        const lossHistory = [];
    
        for (let ep = 0; ep < epochs; ep++) {
            let dw = new Array(nFeatures).fill(0);
            let db = 0;
            let loss = 0;
    
            for (const r of rows) {
                const x = r.xNorm;
                let z = b;
                for (let j = 0; j < nFeatures; j++) z += w[j] * x[j];
                const p   = sigmoid(z);
                const err = p - r.y;
    
                // BCE loss
                loss += -(r.y * Math.log(p + 1e-15) + (1 - r.y) * Math.log(1 - p + 1e-15));
    
                for (let j = 0; j < nFeatures; j++) dw[j] += err * x[j];
                db += err;
            }
    
            const m = rows.length;
            for (let j = 0; j < nFeatures; j++) {
                w[j] -= lr * (dw[j] / m + l2 * w[j]);
            }
            b -= lr * (db / m);
    
            if (ep % 50 === 0) lossHistory.push(+(loss / m).toFixed(4));
        }
    
        return { w, b, lossHistory };
    }
    
    function predict(xNorm, w, b) {
        let z = b;
        for (let j = 0; j < w.length; j++) z += w[j] * xNorm[j];
        return sigmoid(z);
    }
    
    // ════════════════════════════════════════════════════════════════
    // MODEL EVALUATION
    // ════════════════════════════════════════════════════════════════
    
    function evaluate(rows, w, b, threshold) {
        let tp = 0, fp = 0, tn = 0, fn = 0;
        let pnlFiltered = 0, pnlAll = 0;
        let filteredCount = 0;
    
        const scored = rows.map(r => {
            const p   = predict(r.xNorm, w, b);
            const pred = p >= threshold ? 1 : 0;
            if (r.y === 1 && pred === 1) tp++;
            if (r.y === 0 && pred === 1) fp++;
            if (r.y === 0 && pred === 0) tn++;
            if (r.y === 1 && pred === 0) fn++;
            if (pred === 1) { pnlFiltered += r.t.pnl || 0; filteredCount++; }
            pnlAll += r.t.pnl || 0;
            return { ...r, pWin: +p.toFixed(4), pred };
        });
    
        const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
        const recall    = (tp + fn) > 0 ? tp / (tp + fn) : 0;
        const f1        = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;
        const accuracy  = (tp + tn + fp + fn) > 0 ? (tp + tn) / (tp + tn + fp + fn) : 0;
    
        // AUC (approx via Wilcoxon-Mann-Whitney)
        const pos = scored.filter(r => r.y === 1);
        const neg = scored.filter(r => r.y === 0);
        let auc = 0;
        if (pos.length && neg.length) {
            let correct = 0;
            // Sample to avoid O(n²) when large
            const maxSample = 200;
            const posS = pos.length > maxSample ? pos.sort(() => Math.random()-0.5).slice(0, maxSample) : pos;
            const negS = neg.length > maxSample ? neg.sort(() => Math.random()-0.5).slice(0, maxSample) : neg;
            for (const p of posS) for (const n of negS) if (p.pWin > n.pWin) correct++;
            auc = correct / (posS.length * negS.length);
        }
    
        return {
            accuracy: +accuracy.toFixed(4),
            precision: +precision.toFixed(4),
            recall:    +recall.toFixed(4),
            f1:        +f1.toFixed(4),
            auc:       +auc.toFixed(4),
            tp, fp, tn, fn,
            pnlFiltered: +pnlFiltered.toFixed(2),
            pnlAll:      +pnlAll.toFixed(2),
            filteredCount,
            totalCount: rows.length,
            retentionRate: +( filteredCount / rows.length * 100 ).toFixed(1),
            pnlImprovement: pnlAll !== 0 ? +((pnlFiltered - pnlAll) / Math.abs(pnlAll) * 100).toFixed(1) : 0,
            scored,
        };
    }
    
    // ════════════════════════════════════════════════════════════════
    // FACTOR IMPORTANCE
    // ════════════════════════════════════════════════════════════════
    
    function factorImportance(w, factorDefs) {
        const absW = w.map(Math.abs);
        const total = absW.reduce((s, v) => s + v, 0) || 1;
        return factorDefs.map((f, i) => ({
            id:          f.id,
            label:       f.label,
            desc:        f.desc,
            weight:      +w[i].toFixed(4),
            absWeight:   +absW[i].toFixed(4),
            importance:  +(absW[i] / total * 100).toFixed(1),
            direction:   w[i] > 0 ? 'positive' : 'negative',
        })).sort((a, b) => b.absWeight - a.absWeight);
    }
    
    // ════════════════════════════════════════════════════════════════
    // MAIN ENGINE
    // ════════════════════════════════════════════════════════════════
    
    function runEngine(allTrades, cfg) {
        const trades = cfg.setupFilter
            ? allTrades.filter(t => t.setupName === cfg.setupFilter)
            : allTrades;
    
        if (trades.length < 20) return { error: 'Need at least 20 trades for factor analysis.' };
    
        // Сортируем по времени
        const sorted = [...trades].sort((a, b) => {
            const ta = typeof a.entryTs === 'number' ? a.entryTs : new Date(a.entryTs).getTime();
            const tb = typeof b.entryTs === 'number' ? b.entryTs : new Date(b.entryTs).getTime();
            return ta - tb;
        });
    
        // Train/test split (временной — не случайный, чтобы избежать look-ahead)
        const splitIdx  = Math.floor(sorted.length * (1 - cfg.testSplit));
        const trainSet  = sorted.slice(0, splitIdx);
        const testSet   = sorted.slice(splitIdx);
    
        if (trainSet.length < 15) return { error: 'Not enough training data. Reduce testSplit or add more trades.' };
    
        // Извлекаем фичи
        const { rows: trainRows, factorDefs } = extractFeatures(trainSet);
        const { rows: testRows }              = extractFeatures(testSet);
    
        // Нормализация по тренировочным данным
        const { means, stds } = normalizeFeatures(trainRows, factorDefs);
    
        // Нормализуем тест теми же параметрами
        for (const r of testRows) {
            r.xNorm = r.xVec.map((v, j) => (v - means[j]) / stds[j]);
        }
    
        // Обучение
        const t0 = performance.now();
        const { w, b, lossHistory } = logisticTrain(trainRows, factorDefs.length, cfg);
        const trainMs = +(performance.now() - t0).toFixed(1);
    
        // Метрики на train и test
        const trainEval = evaluate(trainRows, w, b, cfg.threshold);
        const testEval  = evaluate(testRows,  w, b, cfg.threshold);
    
        // Factor importance
        const importance = factorImportance(w, factorDefs);
    
        // P(win) распределение по всем трейдам
        const { rows: allRows } = extractFeatures(sorted);
        normalizeFeatures(allRows, factorDefs);
        for (const r of allRows) r.xNorm = r.xVec.map((v,j) => (v - means[j]) / stds[j]);
        const allEval  = evaluate(allRows, w, b, cfg.threshold);
    
        // Гистограмма P(win)
        const pwinHist = buildPwinHistogram(allEval.scored);
    
        // Threshold sweep
        const thresholdSweep = sweepThreshold(testRows, w, b);
    
        return {
            setup:       cfg.setupFilter || 'All',
            totalTrades: sorted.length,
            trainN:      trainSet.length,
            testN:       testSet.length,
            trainMs,
            factorDefs,
            importance,
            lossHistory,
            train:       trainEval,
            test:        testEval,
            all:         allEval,
            pwinHist,
            thresholdSweep,
            threshold:   cfg.threshold,
            w, b, means, stds,
        };
    }
    
    function buildPwinHistogram(scored) {
        const bins = 10;
        const hist = Array.from({length:bins}, (_,i) => ({
            bin: `${i*10}–${(i+1)*10}%`,
            lo:  i/bins, hi: (i+1)/bins,
            count: 0, wins: 0,
        }));
        for (const r of scored) {
            const idx = Math.min(Math.floor(r.pWin * bins), bins - 1);
            hist[idx].count++;
            if (r.y === 1) hist[idx].wins++;
        }
        return hist.map(h => ({
            ...h,
            actualWR: h.count > 0 ? +(h.wins / h.count * 100).toFixed(1) : null,
        }));
    }
    
    function sweepThreshold(rows, w, b) {
        const steps = [0.40, 0.45, 0.50, 0.52, 0.55, 0.57, 0.60, 0.63, 0.65, 0.70, 0.75];
        return steps.map(thr => {
            const ev = evaluate(rows, w, b, thr);
            return {
                threshold:  thr,
                accuracy:   ev.accuracy,
                precision:  ev.precision,
                recall:     ev.recall,
                f1:         ev.f1,
                retained:   ev.retentionRate,
                pnlFiltered: ev.pnlFiltered,
            };
        });
    }
    
    // ════════════════════════════════════════════════════════════════
    // TAB INJECT
    // ════════════════════════════════════════════════════════════════
    
    function injectTab() {
        const t = setInterval(() => {
            const vtabs = document.querySelector('.ai-tabs-vert');
            if (!vtabs) return;
            clearInterval(t);
            if (document.querySelector('[data-aitab="mfa"]')) return;
            injectCSS();
            const btn = document.createElement('button');
            btn.className = 'ai-vtab';
            btn.dataset.aitab = 'mfa';
            btn.textContent = '⚡ Alpha Engine';
            vtabs.appendChild(btn);
            btn.addEventListener('click', () => {
                document.querySelectorAll('.ai-vtab').forEach(b => b.classList.remove('ai-vtab-a'));
                btn.classList.add('ai-vtab-a');
                renderSidebar();
                renderMain();
            });
        }, 300);
    }
    
    // ════════════════════════════════════════════════════════════════
    // SIDEBAR
    // ════════════════════════════════════════════════════════════════
    
    function renderSidebar() {
        const sb = document.getElementById('ai-sidebar');
        if (!sb) return;
        const logo  = sb.querySelector('.ai-logo');
        const vtabs = sb.querySelector('.ai-tabs-vert');
        sb.innerHTML = '';
        if (logo)  sb.appendChild(logo);
        if (vtabs) sb.appendChild(vtabs);
    
        const trades = getTrades();
        const setupNames = trades.length ? [...new Set(trades.map(t => t.setupName).filter(Boolean))] : [];
        let setupOpts = '<option value="">All setups</option>';
        for (const n of setupNames) {
            setupOpts += `<option value="${esc(n)}" ${MFA.cfg.setupFilter===n?'selected':''}>${esc(n)}</option>`;
        }
    
        const sect = document.createElement('div');
        sect.className = 'ai-sb-sect';
        sect.innerHTML = `
            <div class="ai-sb-h">Model Settings</div>
    
            <div class="ai-sb-row">
                <label class="ai-sb-lbl">Setup</label>
                <select class="ai-sb-inp" id="mfa-setup" style="width:105px">${setupOpts}</select>
            </div>
            <div class="ai-sb-row">
                <label class="ai-sb-lbl">P(win) threshold</label>
                <input class="ai-sb-inp ai-sb-inp-sm" id="mfa-thr" type="number" min="0.4" max="0.9" step="0.01" value="${MFA.cfg.threshold}">
            </div>
            <div class="ai-sb-row">
                <label class="ai-sb-lbl">Epochs</label>
                <input class="ai-sb-inp ai-sb-inp-sm" id="mfa-epochs" type="number" min="100" max="2000" step="100" value="${MFA.cfg.epochs}">
            </div>
            <div class="ai-sb-row">
                <label class="ai-sb-lbl">Learning rate</label>
                <input class="ai-sb-inp ai-sb-inp-sm" id="mfa-lr" type="number" min="0.001" max="0.5" step="0.005" value="${MFA.cfg.lr}">
            </div>
            <div class="ai-sb-row">
                <label class="ai-sb-lbl">L2 reg</label>
                <input class="ai-sb-inp ai-sb-inp-sm" id="mfa-l2" type="number" min="0" max="0.5" step="0.005" value="${MFA.cfg.l2}">
            </div>
            <div class="ai-sb-row">
                <label class="ai-sb-lbl">Test split</label>
                <input class="ai-sb-inp ai-sb-inp-sm" id="mfa-split" type="number" min="0.1" max="0.4" step="0.05" value="${MFA.cfg.testSplit}">
            </div>
    
            <div class="ai-sb-h" style="margin-top:10px">Data</div>
            <div style="font-size:11px;color:${trades.length?'#4caf50':'#ef5350'}">
                ${trades.length ? '✓ ' + trades.length + ' trades' : '⚠️ No trades. Run BT first.'}
            </div>
    
            <button class="sb-btn sb-btn-srv ai-run-btn" id="mfa-run-btn" style="margin-top:10px">
                ${MFA.running ? '<span class="ai-spin"></span> Training…' : '⚡ Train Model'}
            </button>
            <div class="ai-hint">
                Logistic regression on ${FACTORS.filter(f=>!f.isLeaky).length} factors extracted from trade data.
                Train/test split preserves time order.
            </div>
        `;
        sb.appendChild(sect);
    
        document.getElementById('mfa-setup')?.addEventListener('change',  e => { MFA.cfg.setupFilter = e.target.value; });
        document.getElementById('mfa-thr')?.addEventListener('change',    e => { MFA.cfg.threshold  = parseFloat(e.target.value)||0.55; if(MFA.result&&!MFA.result.error) renderMain(); });
        document.getElementById('mfa-epochs')?.addEventListener('change', e => { MFA.cfg.epochs     = parseInt(e.target.value)||500; });
        document.getElementById('mfa-lr')?.addEventListener('change',     e => { MFA.cfg.lr         = parseFloat(e.target.value)||0.05; });
        document.getElementById('mfa-l2')?.addEventListener('change',     e => { MFA.cfg.l2         = parseFloat(e.target.value)||0.01; });
        document.getElementById('mfa-split')?.addEventListener('change',  e => { MFA.cfg.testSplit  = parseFloat(e.target.value)||0.2; });
        document.getElementById('mfa-run-btn')?.addEventListener('click', runModel);
    }
    
    // ════════════════════════════════════════════════════════════════
    // RUN
    // ════════════════════════════════════════════════════════════════
    
    function runModel() {
        if (MFA.running) return;
        const trades = getTrades();
        if (!trades.length) { alert('No trades found. Run a Server Backtest first.'); return; }
    
        MFA.running = true;
        const btn = document.getElementById('mfa-run-btn');
        if (btn) { btn.disabled = true; btn.innerHTML = '<span class="ai-spin"></span> Training…'; }
    
        setTimeout(() => {
            try {
                MFA.result = runEngine(trades, { ...MFA.cfg });
            } catch(e) {
                MFA.result = { error: e.message };
                console.error('[MFA]', e);
            }
            MFA.running = false;
            renderSidebar();
            renderMain();
        }, 30);
    }
    
    // ════════════════════════════════════════════════════════════════
    // RENDER MAIN
    // ════════════════════════════════════════════════════════════════
    
    function renderMain() {
        destroyCharts();
        const main = document.getElementById('ai-main');
        if (!main) return;
    
        if (!MFA.result) { main.innerHTML = emptyState(); return; }
        if (MFA.result.error) {
            main.innerHTML = `<div class="ai-empty"><div style="font-size:28px">⚠️</div>
                <div class="ai-empty-t">Model Error</div>
                <div class="ai-empty-s">${esc(MFA.result.error)}</div></div>`;
            return;
        }
    
        const r = MFA.result;
        const thr = MFA.cfg.threshold;
    
        main.innerHTML = `
        <!-- SUMMARY -->
        <div class="ai-block">
            <div class="ai-bh">
                <span class="ai-bt">⚡ Multi-Factor Alpha Engine</span>
                <span class="ai-bsub">${r.totalTrades} trades · ${r.trainMs}ms training · setup: ${esc(r.setup)}</span>
            </div>
            <div class="ai-kpi5">
                ${kpi('AUC',       auc_badge(r.test.auc))}
                ${kpi('Accuracy',  pct(r.test.accuracy*100))}
                ${kpi('Precision', pct(r.test.precision*100))}
                ${kpi('Recall',    pct(r.test.recall*100))}
                ${kpi('F1',        pct(r.test.f1*100))}
            </div>
            <div class="ai-kpi5">
                ${kpi('Train N',   r.trainN)}
                ${kpi('Test N',    r.testN)}
                ${kpi('Threshold', thr)}
                ${kpi('Retained',  `<span class="${r.all.retentionRate > 50 ? '' : 'ai-neg'}">${r.all.retentionRate}%</span>`)}
                ${kpi('PnL Δ',     `<span class="${r.all.pnlImprovement>=0?'ai-pos':'ai-neg'}">${r.all.pnlImprovement>=0?'+':''}${r.all.pnlImprovement}%</span>`)}
            </div>
        </div>
    
        <!-- FACTOR IMPORTANCE -->
        <div class="ai-block">
            <div class="ai-bh"><span class="ai-bt">🔍 Factor Importance</span><span class="ai-bsub">sorted by |weight|</span></div>
            <div class="mfa-factor-list" id="mfa-factors"></div>
        </div>
    
        <!-- TRAIN VS TEST -->
        <div class="ai-block">
            <div class="ai-bh"><span class="ai-bt">📊 Train vs Test Metrics</span></div>
            ${trainTestTable(r)}
        </div>
    
        <!-- P(WIN) CALIBRATION -->
        <div class="ai-block">
            <div class="ai-bh"><span class="ai-bt">📈 P(win) Calibration</span><span class="ai-bsub">predicted vs actual win rate by probability bin</span></div>
            <div class="ai-chart-wrap" style="height:200px"><canvas id="mfa-calib-chart"></canvas></div>
        </div>
    
        <!-- THRESHOLD SWEEP -->
        <div class="ai-block">
            <div class="ai-bh"><span class="ai-bt">🎯 Threshold Sweep</span><span class="ai-bsub">precision · retention vs threshold (test set)</span></div>
            <div class="ai-chart-wrap" style="height:200px"><canvas id="mfa-sweep-chart"></canvas></div>
            ${sweepTable(r.thresholdSweep, thr)}
        </div>
    
        <!-- LOSS CURVE -->
        <div class="ai-block">
            <div class="ai-bh"><span class="ai-bt">📉 Training Loss</span></div>
            <div class="ai-chart-wrap" style="height:150px"><canvas id="mfa-loss-chart"></canvas></div>
        </div>
    
        <!-- CONFUSION MATRIX -->
        <div class="mfa-cm-row">
            <div class="ai-block" style="flex:1">
                <div class="ai-bh"><span class="ai-bt">🔢 Confusion Matrix (test)</span></div>
                ${confusionMatrix(r.test)}
            </div>
            <div class="ai-block" style="flex:1">
                <div class="ai-bh"><span class="ai-bt">💡 Filter Impact (all trades)</span></div>
                ${filterImpact(r)}
            </div>
        </div>
        `;
    
        buildFactorBars(r.importance);
        setTimeout(() => {
            drawCalibChart(r);
            drawSweepChart(r);
            drawLossChart(r);
        }, 40);
    }
    
    function emptyState() {
        return `<div class="ai-empty">
            <div style="font-size:40px;opacity:.25">⚡</div>
            <div class="ai-empty-t">Multi-Factor Alpha Engine</div>
            <div class="ai-empty-s">
                Trains a logistic regression model on your trades.<br>
                Learns which factors predict winning trades.<br><br>
                <strong>${FACTORS.filter(f=>!f.isLeaky).length} factors extracted from trade data:</strong><br>
                Entry hour, weekday (cyclic encoding)<br>
                Planned R:R, SL distance<br>
                Direction, trading session<br>
                Win/loss streak, drawdown %<br>
                Bars held, trade age<br><br>
                Run a Server Backtest first, then click<br>
                <strong>⚡ Train Model</strong>
            </div>
        </div>`;
    }
    
    // ════════════════════════════════════════════════════════════════
    // HTML COMPONENTS
    // ════════════════════════════════════════════════════════════════
    
    function buildFactorBars(importance) {
        const el = document.getElementById('mfa-factors');
        if (!el) return;
        const maxImp = importance[0]?.importance || 1;
        el.innerHTML = importance.map(f => {
            const barW  = (f.importance / maxImp * 100).toFixed(1);
            const color = f.direction === 'positive' ? '#4caf50' : '#ef5350';
            const sign  = f.direction === 'positive' ? '+' : '−';
            return `<div class="mfa-factor-row">
                <div class="mfa-factor-lbl" title="${esc(f.desc)}">${esc(f.label)}</div>
                <div class="mfa-factor-bar-bg">
                    <div class="mfa-factor-bar" style="width:${barW}%;background:${color}"></div>
                </div>
                <div class="mfa-factor-imp">${f.importance}%</div>
                <div class="mfa-factor-w" style="color:${color}">${sign}${Math.abs(f.weight).toFixed(3)}</div>
            </div>`;
        }).join('');
    }
    
    function trainTestTable(r) {
        const metrics = [
            { name:'Accuracy',  train: pct(r.train.accuracy*100),  test: pct(r.test.accuracy*100)  },
            { name:'Precision', train: pct(r.train.precision*100), test: pct(r.test.precision*100) },
            { name:'Recall',    train: pct(r.train.recall*100),    test: pct(r.test.recall*100)    },
            { name:'F1',        train: pct(r.train.f1*100),        test: pct(r.test.f1*100)        },
            { name:'AUC',       train: auc_badge(r.train.auc),     test: auc_badge(r.test.auc)     },
            { name:'Retained',  train: r.train.retentionRate+'%',  test: r.test.retentionRate+'%'  },
            { name:'PnL filtered', train: money(r.train.pnlFiltered), test: money(r.test.pnlFiltered) },
            { name:'PnL all',   train: money(r.train.pnlAll),      test: money(r.test.pnlAll)      },
        ];
        return `<div style="overflow-x:auto;padding:4px 6px">
        <table class="ai-tbl">
            <thead><tr><th>Metric</th><th>Train (${r.trainN})</th><th>Test (${r.testN})</th><th>Gap</th></tr></thead>
            <tbody>${metrics.map(m => `<tr>
                <td style="color:#9598a1;font-weight:600">${m.name}</td>
                <td>${m.train}</td>
                <td>${m.test}</td>
                <td></td>
            </tr>`).join('')}</tbody>
        </table></div>`;
    }
    
    function sweepTable(sweep, activeThr) {
        return `<div style="overflow-x:auto;padding:4px 6px;margin-top:6px">
        <table class="ai-tbl">
            <thead><tr><th>Threshold</th><th>Precision</th><th>Recall</th><th>F1</th><th>Retained%</th><th>PnL filtered</th></tr></thead>
            <tbody>${sweep.map(s => `<tr ${s.threshold === activeThr ? 'style="background:rgba(74,158,255,.07);font-weight:700"' : ''}>
                <td style="font-family:monospace">${s.threshold.toFixed(2)}</td>
                <td>${pct(s.precision*100)}</td>
                <td>${pct(s.recall*100)}</td>
                <td>${pct(s.f1*100)}</td>
                <td>${s.retained}%</td>
                <td>${money(s.pnlFiltered)}</td>
            </tr>`).join('')}</tbody>
        </table></div>`;
    }
    
    function confusionMatrix(ev) {
        return `<div class="mfa-cm">
            <div class="mfa-cm-grid">
                <div class="mfa-cm-corner"></div>
                <div class="mfa-cm-hdr">Pred: Win</div>
                <div class="mfa-cm-hdr">Pred: Loss</div>
                <div class="mfa-cm-hdr mfa-cm-row-hdr">Act: Win</div>
                <div class="mfa-cm-cell mfa-tp">
                    <div class="mfa-cm-n">${ev.tp}</div>
                    <div class="mfa-cm-lbl">TP</div>
                </div>
                <div class="mfa-cm-cell mfa-fn">
                    <div class="mfa-cm-n">${ev.fn}</div>
                    <div class="mfa-cm-lbl">FN</div>
                </div>
                <div class="mfa-cm-hdr mfa-cm-row-hdr">Act: Loss</div>
                <div class="mfa-cm-cell mfa-fp">
                    <div class="mfa-cm-n">${ev.fp}</div>
                    <div class="mfa-cm-lbl">FP</div>
                </div>
                <div class="mfa-cm-cell mfa-tn">
                    <div class="mfa-cm-n">${ev.tn}</div>
                    <div class="mfa-cm-lbl">TN</div>
                </div>
            </div>
        </div>`;
    }
    
    function filterImpact(r) {
        const ev = r.all;
        const better = ev.pnlImprovement > 0;
        return `<div style="padding:10px 14px">
            <div class="ai-kpi5" style="grid-template-columns:1fr 1fr;margin-bottom:8px">
                ${kpi('All trades PnL',      money(ev.pnlAll))}
                ${kpi('Filtered trades PnL', money(ev.pnlFiltered))}
            </div>
            <div class="ai-kpi5" style="grid-template-columns:1fr 1fr">
                ${kpi('Trades kept', `${ev.filteredCount} / ${ev.totalCount} (${ev.retentionRate}%)`)}
                ${kpi('PnL change',  `<span class="${better?'ai-pos':'ai-neg'}">${ev.pnlImprovement>=0?'+':''}${ev.pnlImprovement}%</span>`)}
            </div>
            <div style="font-size:10px;color:#6a7090;padding:8px 0;line-height:1.7">
                ${better
                    ? `✅ Filtering by P(win) > ${r.threshold} improves total PnL by ${ev.pnlImprovement}% while keeping ${ev.retentionRate}% of trades.`
                    : `⚠️ Filter at threshold ${r.threshold} reduces PnL. Try lowering threshold or check AUC — model may need more data.`}
            </div>
        </div>`;
    }
    
    // ════════════════════════════════════════════════════════════════
    // CHARTS
    // ════════════════════════════════════════════════════════════════
    
    function destroyCharts() {
        Object.values(MFA.charts).forEach(c => { try { c.destroy(); } catch(_) {} });
        MFA.charts = {};
    }
    
    function ensureChart(cb) {
        if (window.Chart) { cb(); return; }
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
        s.onload = cb; document.head.appendChild(s);
    }
    
    function drawCalibChart(r) {
        ensureChart(() => {
            const canvas = document.getElementById('mfa-calib-chart');
            if (!canvas) return;
            const h = r.pwinHist;
            MFA.charts['calib'] = new Chart(canvas, {
                type: 'bar',
                data: {
                    labels: h.map(b => b.bin),
                    datasets: [
                        {
                            label: 'Actual Win Rate %',
                            data: h.map(b => b.actualWR),
                            backgroundColor: h.map(b => b.actualWR === null ? 'rgba(255,255,255,.05)' :
                                b.actualWR >= 60 ? 'rgba(76,175,80,.7)' :
                                b.actualWR >= 50 ? 'rgba(139,195,74,.7)' :
                                b.actualWR >= 40 ? 'rgba(255,152,0,.7)' :
                                                   'rgba(239,83,80,.7)'),
                            borderRadius: 3, yAxisID: 'y', order: 2,
                        },
                        {
                            label: 'Perfect calibration',
                            data: [5,15,25,35,45,55,65,75,85,95],
                            type: 'line', borderColor: 'rgba(255,255,255,.2)',
                            borderWidth: 1.5, borderDash: [4,4], pointRadius: 0,
                            fill: false, yAxisID: 'y', order: 1,
                        },
                        {
                            label: 'Trade count',
                            data: h.map(b => b.count),
                            type: 'line', borderColor: 'rgba(74,158,255,.5)',
                            backgroundColor: 'transparent', borderWidth: 1.5,
                            pointRadius: 2, fill: false, yAxisID: 'y2', order: 0,
                        },
                    ],
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    interaction: { mode:'index', intersect:false },
                    plugins: { legend: { labels: { color:'#787b86', boxWidth:12, font:{size:10} } } },
                    scales: {
                        x:  { ticks:{ color:'#787b86', font:{size:9} }, grid:{ display:false } },
                        y:  { position:'left',  min:0, max:100, ticks:{ color:'#787b86' }, grid:{ color:'rgba(255,255,255,.05)' } },
                        y2: { position:'right', ticks:{ color:'#4a9eff' }, grid:{ display:false } },
                    },
                },
            });
        });
    }
    
    function drawSweepChart(r) {
        ensureChart(() => {
            const canvas = document.getElementById('mfa-sweep-chart');
            if (!canvas) return;
            const sw = r.thresholdSweep;
            MFA.charts['sweep'] = new Chart(canvas, {
                type: 'line',
                data: {
                    labels: sw.map(s => s.threshold.toFixed(2)),
                    datasets: [
                        { label:'Precision', data:sw.map(s=>+(s.precision*100).toFixed(1)), borderColor:'#4caf50', borderWidth:2, pointRadius:3, fill:false, tension:0.3, yAxisID:'y' },
                        { label:'Recall',    data:sw.map(s=>+(s.recall*100).toFixed(1)),    borderColor:'#ff9800', borderWidth:2, pointRadius:3, fill:false, tension:0.3, yAxisID:'y' },
                        { label:'F1',        data:sw.map(s=>+(s.f1*100).toFixed(1)),        borderColor:'#4a9eff', borderWidth:2, pointRadius:3, fill:false, tension:0.3, yAxisID:'y' },
                        { label:'Retained%', data:sw.map(s=>s.retained), borderColor:'rgba(255,255,255,.3)', borderWidth:1.5, borderDash:[4,4], pointRadius:2, fill:false, tension:0.3, yAxisID:'y' },
                    ],
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    interaction: { mode:'index', intersect:false },
                    plugins: { legend: { labels: { color:'#787b86', boxWidth:12, font:{size:10} } } },
                    scales: {
                        x: { ticks:{ color:'#787b86', font:{size:9} }, grid:{ display:false } },
                        y: { min:0, max:100, ticks:{ color:'#787b86' }, grid:{ color:'rgba(255,255,255,.05)' } },
                    },
                },
            });
        });
    }
    
    function drawLossChart(r) {
        ensureChart(() => {
            const canvas = document.getElementById('mfa-loss-chart');
            if (!canvas) return;
            const lh = r.lossHistory;
            MFA.charts['loss'] = new Chart(canvas, {
                type: 'line',
                data: {
                    labels: lh.map((_,i)=>(i*50)+''),
                    datasets: [{ label:'BCE Loss', data:lh, borderColor:'#7b4fff', backgroundColor:'rgba(123,79,255,.08)', borderWidth:2, pointRadius:0, fill:true, tension:0.4 }],
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { labels: { color:'#787b86', boxWidth:12, font:{size:10} } } },
                    scales: {
                        x: { ticks:{ color:'#787b86', font:{size:9} }, grid:{ display:false } },
                        y: { ticks:{ color:'#787b86' }, grid:{ color:'rgba(255,255,255,.05)' } },
                    },
                },
            });
        });
    }
    
    // ════════════════════════════════════════════════════════════════
    // HELPERS
    // ════════════════════════════════════════════════════════════════
    
    function getTrades() {
        if (window.SB_TRADES){ const t=window.SB_TRADES(); if(t?.length) return t; }
        if (window._lastBacktestTrades?.length) return window._lastBacktestTrades;
        if (window._sbState?.trades?.length)    return window._sbState.trades;
        return [];
    }
    function esc(s){ return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    function kpi(l,v){ return `<div class="ai-kpi"><div class="ai-kpi-l">${l}</div><div class="ai-kpi-v">${v}</div></div>`; }
    function pct(v){ const n=+v; return `<span class="${n>=60?'ai-pos':n>=50?'':'ai-neg'}">${isNaN(n)?'—':n.toFixed(1)+'%'}</span>`; }
    function money(v){ const n=+v; return `<span class="${n>=0?'ai-pos':'ai-neg'}">${n>=0?'+':''}$${Math.abs(n).toFixed(0)}</span>`; }
    function auc_badge(v) {
        const color = v >= 0.7 ? '#4caf50' : v >= 0.6 ? '#ff9800' : '#ef5350';
        const label = v >= 0.7 ? 'Good' : v >= 0.6 ? 'Fair' : 'Weak';
        return `<span style="color:${color};font-weight:700">${v.toFixed(3)}</span> <span style="font-size:9px;color:${color}">${label}</span>`;
    }
    
    // ════════════════════════════════════════════════════════════════
    // CSS
    // ════════════════════════════════════════════════════════════════
    
    function injectCSS() {
        if (document.getElementById('mfa-css')) return;
        const s = document.createElement('style');
        s.id = 'mfa-css';
        s.textContent = `
    /* ── FACTOR BARS ── */
    .mfa-factor-list{padding:8px 12px 12px}
    .mfa-factor-row{display:flex;align-items:center;gap:8px;margin-bottom:5px}
    .mfa-factor-lbl{font-size:10px;color:#9598a1;width:120px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:help}
    .mfa-factor-bar-bg{flex:1;height:8px;background:#1a1e30;border-radius:4px;overflow:hidden}
    .mfa-factor-bar{height:100%;border-radius:4px;transition:width .4s}
    .mfa-factor-imp{font-size:10px;color:#6a7090;width:36px;text-align:right;flex-shrink:0}
    .mfa-factor-w{font-size:10px;font-family:monospace;width:52px;text-align:right;flex-shrink:0}
    
    /* ── CONFUSION MATRIX ── */
    .mfa-cm{padding:10px 14px 14px}
    .mfa-cm-grid{display:grid;grid-template-columns:80px 1fr 1fr;grid-template-rows:28px 1fr 1fr;gap:4px;max-width:260px}
    .mfa-cm-corner{background:transparent}
    .mfa-cm-hdr{font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#444c70;display:flex;align-items:center;justify-content:center;font-weight:700}
    .mfa-cm-row-hdr{justify-content:flex-end;padding-right:6px}
    .mfa-cm-cell{border-radius:4px;padding:10px;text-align:center}
    .mfa-tp{background:rgba(76,175,80,.25);border:1px solid rgba(76,175,80,.3)}
    .mfa-tn{background:rgba(76,175,80,.15);border:1px solid rgba(76,175,80,.2)}
    .mfa-fp{background:rgba(239,83,80,.2);border:1px solid rgba(239,83,80,.3)}
    .mfa-fn{background:rgba(255,152,0,.15);border:1px solid rgba(255,152,0,.25)}
    .mfa-cm-n{font-size:22px;font-weight:700;color:#c8ccd8}
    .mfa-cm-lbl{font-size:9px;color:#444c70;text-transform:uppercase;letter-spacing:.06em;margin-top:2px}
    
    /* ── LAYOUT ── */
    .mfa-cm-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
    `;
        document.head.appendChild(s);
    }
    
    // ════════════════════════════════════════════════════════════════
    // INIT
    // ════════════════════════════════════════════════════════════════
    
    injectTab();
    console.log('[MultiFactorAlpha] v1.0 loaded');
    
    })(); }