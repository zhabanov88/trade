/**
 * alert-ui.js  v1.0
 *
 * UI умных алертов с контекстом.
 *
 * ══════════════════════════════════════════════════════════════════
 * АРХИТЕКТУРА
 * ══════════════════════════════════════════════════════════════════
 *
 * 1. Вкладка "🔔 Alerts" в #sb-tabbar (рядом с Data/Setups/Backtest/WF/AI)
 *    — CRUD алертов (создать / вкл-выкл / удалить)
 *    — Конструктор условий: price_cross_above/below, setup_signal, pct_change, atr_spike
 *    — История сработок с контекстом
 *
 * 2. Интеграция с backtest-player.js
 *    — Хук на каждый шаг replay (customNext / customPrev / play)
 *    — При срабатывании алерта → всплывающая контекстная карточка над графиком
 *    — Карточка показывает: активные сетапы + WR, режим рынка, уровни ликвидности,
 *      рекомендацию лучшего сетапа для текущего режима
 *
 * 3. Кнопка "⚡ Live Context" в replay-баре
 *    — Показывает контекст для текущего бара без условия алерта
 *
 * Подключение в index.html ПОСЛЕ ai-ui.js:
 *   <script src="alert-ui.js"></script>
 *
 * Требует: setups-backtest.js (window.SB_CFG, window.SB_TRADES)
 *          backtest-player.js (window.backtestPlayer)
 */

if (window._alertUILoaded) {} else { window._alertUILoaded = true; (function () {
    'use strict';
    
    // ════════════════════════════════════════════════════════════════
    // STATE
    // ════════════════════════════════════════════════════════════════
    
    const AL = {
        alerts:       [],    // загруженные из БД
        history:      [],    // сработки в текущей сессии replay
        loading:      false,
        cardVisible:  false,
        replayHooked: false, // флаг — хук на backtestPlayer уже установлен
        pendingCtx:   null,  // контекст для отображения карточки
    };
    
    // ════════════════════════════════════════════════════════════════
    // HELPERS
    // ════════════════════════════════════════════════════════════════
    
    function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    function getBTCfg()  { return window.SB_CFG  ? window.SB_CFG()  : {}; }
    function getTrades() { return window.SB_TRADES ? window.SB_TRADES() : []; }
    
    const REGIME_ICON = { trending_up:'📈', trending_down:'📉', ranging:'↔️', volatile:'⚡', neutral:'➡️', unknown:'❓' };
    const REGIME_COLOR = { trending_up:'#4caf50', trending_down:'#ef5350', ranging:'#ff9800', volatile:'#9c27b0', neutral:'#607d8b', unknown:'#444c70' };
    const COND_LABELS  = {
        price_cross_above: 'Price crosses above',
        price_cross_below: 'Price crosses below',
        price_above:       'Price is above',
        price_below:       'Price is below',
        setup_signal:      'Setup signal',
        pct_change:        '% change ≥',
        atr_spike:         'ATR spike ≥',
    };
    
    // ════════════════════════════════════════════════════════════════
    // TAB INJECTION
    // ════════════════════════════════════════════════════════════════
    
    function injectTab() {
        const timer = setInterval(() => {
            const tabbar = document.getElementById('sb-tabbar');
            if (!tabbar) return;
            clearInterval(timer);
            if (document.getElementById('sb-tab-alerts')) return;
    
            injectCSS();
    
            const btn = document.createElement('button');
            btn.id = 'sb-tab-alerts';
            btn.className = 'sb-tab sb-tab-alerts';
            btn.dataset.tab = 'alerts';
            btn.textContent = '🔔 Alerts';
            tabbar.appendChild(btn);
    
            btn.addEventListener('click', () => {
                const body  = document.getElementById('sb-tab-body');
                const twrap = document.getElementById('dt-twrap');
                if (!body) return;
                tabbar.querySelectorAll('.sb-tab').forEach(b => b.classList.remove('sb-tab-active'));
                btn.classList.add('sb-tab-active');
                if (twrap) twrap.style.display = 'none';
                body.style.display = 'flex';
                loadAndRender(body);
            });
        }, 300);
    }
    
    // ════════════════════════════════════════════════════════════════
    // LOAD & RENDER
    // ════════════════════════════════════════════════════════════════
    
    async function loadAndRender(body) {
        body.innerHTML = `<div class="alr-loading">Loading alerts…</div>`;
        await loadAlerts();
        renderPanel(body);
        hookReplayPlayer();
    }
    
    async function loadAlerts() {
        try {
            const resp = await fetch('/api/alerts', { credentials: 'include' });
            if (resp.ok) AL.alerts = await resp.json();
        } catch(e) { console.warn('[Alerts] load failed:', e); }
    }
    
    function renderPanel(body) {
        body.innerHTML = `
        <div class="alr-root">
            <div class="alr-sidebar" id="alr-sidebar">${renderSidebar()}</div>
            <div class="alr-main"   id="alr-main">${renderMain()}</div>
        </div>`;
        bindPanelEvents();
    }
    
    // ── SIDEBAR ──────────────────────────────────────────────────────
    
    function renderSidebar() {
        const btCfg = getBTCfg();
        const cols  = Object.keys(btCfg.setupCols || {});
    
        return `
        <div class="alr-logo">🔔 Smart Alerts</div>
    
        <div class="alr-sb-sect">
            <div class="alr-sb-h">New Alert</div>
    
            <div class="alr-field">
                <label class="alr-lbl">Name</label>
                <input class="alr-inp" id="alr-name" type="text" placeholder="e.g. BTC breakout" maxlength="100">
            </div>
    
            <div class="alr-field">
                <label class="alr-lbl">Condition</label>
                <select class="alr-sel" id="alr-cond-type">
                    <option value="price_cross_above">Price crosses above level</option>
                    <option value="price_cross_below">Price crosses below level</option>
                    <option value="price_above">Price is above level</option>
                    <option value="price_below">Price is below level</option>
                    <option value="setup_signal">Setup signal appears</option>
                    <option value="pct_change">Price change % ≥ threshold</option>
                    <option value="atr_spike">ATR spike ≥ value</option>
                </select>
            </div>
    
            <div class="alr-field" id="alr-level-row">
                <label class="alr-lbl">Level / Value</label>
                <input class="alr-inp" id="alr-level" type="number" step="any" placeholder="e.g. 1.1050">
            </div>
    
            <div class="alr-field alr-hide" id="alr-col-row">
                <label class="alr-lbl">Setup column</label>
                <select class="alr-sel" id="alr-col">
                    ${cols.length
                        ? cols.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')
                        : '<option value="">— run a script first —</option>'}
                </select>
            </div>
    
            <div class="alr-field alr-hide" id="alr-trig-row">
                <label class="alr-lbl">Trigger value</label>
                <input class="alr-inp" id="alr-trig-val" type="number" value="1" min="1">
            </div>
    
            <div class="alr-field">
                <label class="alr-lbl">Fire</label>
                <select class="alr-sel" id="alr-once">
                    <option value="0">Every time</option>
                    <option value="1">Once then disable</option>
                </select>
            </div>
    
            <button class="sb-btn sb-btn-srv alr-create-btn" id="alr-create-btn">
                + Create Alert
            </button>
        </div>
    
        <div class="alr-sb-sect">
            <div class="alr-sb-h">Replay Integration</div>
            <div class="alr-hint">
                During Bar Replay, alerts are checked on every bar automatically.
                A context card appears on screen when an alert fires.
            </div>
            <div class="alr-replay-status ${AL.replayHooked ? 'alr-status-ok' : 'alr-status-off'}" id="alr-replay-status">
                ${AL.replayHooked ? '✓ Hooked to Replay' : '○ Replay not active'}
            </div>
            <button class="sb-btn alr-ctx-btn" id="alr-ctx-btn">
                ⚡ Live Context Now
            </button>
            <div class="alr-hint">Shows context for the latest bar without an alert condition.</div>
        </div>
    
        ${AL.history.length ? `
        <div class="alr-sb-sect">
            <div class="alr-sb-h">Session Fires (${AL.history.length})</div>
            ${AL.history.slice(-5).reverse().map(h => `
            <div class="alr-hist-item" data-idx="${AL.history.indexOf(h)}">
                <div class="alr-hist-name">${esc(h.alert.name)}</div>
                <div class="alr-hist-ts">${fmtTs(h.context.triggeredAt)}</div>
                <div class="alr-hist-price">@ ${h.context.price}</div>
            </div>`).join('')}
        </div>` : ''}`;
    }
    
    // ── MAIN ─────────────────────────────────────────────────────────
    
    function renderMain() {
        if (!AL.alerts.length) {
            return `<div class="alr-empty">
                <div style="font-size:36px;opacity:.3">🔔</div>
                <div class="alr-empty-t">No Alerts Yet</div>
                <div class="alr-empty-s">
                    Create an alert using the sidebar.<br><br>
                    When the condition fires during Bar Replay,<br>
                    you'll see a full context card with:<br><br>
                    🎯 Active setups + historical win rate<br>
                    🌊 Current market regime<br>
                    💡 Best setup recommendation<br>
                    📊 Nearest liquidity levels
                </div>
            </div>`;
        }
    
        return `
        <div class="alr-list" id="alr-list">
            <div class="alr-list-hdr">
                <span class="alr-list-title">Your Alerts (${AL.alerts.length})</span>
                <button class="alr-init-btn" id="alr-init-btn" title="Create DB table if missing">⚙ Init DB</button>
            </div>
            ${AL.alerts.map(a => renderAlertCard(a)).join('')}
        </div>`;
    }
    
    function renderAlertCard(a) {
        const cond = typeof a.condition === 'string' ? JSON.parse(a.condition) : a.condition;
        const condLabel = COND_LABELS[cond.type] || cond.type;
        const condVal   = cond.level ?? cond.threshold ?? cond.column ?? '';
        const lastFired = a.last_fired ? fmtTs(a.last_fired) : 'Never';
    
        return `
        <div class="alr-card ${a.active ? '' : 'alr-card-off'}" data-id="${a.id}">
            <div class="alr-card-top">
                <div class="alr-card-name">${esc(a.name)}</div>
                <div class="alr-card-actions">
                    <button class="alr-icon-btn ${a.active ? 'alr-active-btn' : 'alr-inactive-btn'}"
                            data-action="toggle" data-id="${a.id}" title="${a.active ? 'Disable' : 'Enable'}">
                        ${a.active ? '●' : '○'}
                    </button>
                    <button class="alr-icon-btn alr-del-btn" data-action="delete" data-id="${a.id}" title="Delete">✕</button>
                </div>
            </div>
            <div class="alr-card-cond">
                <span class="alr-cond-badge">${condLabel}</span>
                ${condVal !== '' ? `<span class="alr-cond-val">${esc(String(condVal))}</span>` : ''}
            </div>
            <div class="alr-card-meta">
                <span title="Ticker">📍 ${esc(a.ticker)}</span>
                <span title="Fired">🔥 ${a.fire_count}×</span>
                <span title="Last fired">⏱ ${lastFired}</span>
                <span>${a.once ? '🎯 Once' : '🔁 Every time'}</span>
            </div>
            ${a.context ? `
            <button class="alr-show-ctx-btn" data-action="show-ctx" data-id="${a.id}">
                📋 Last context
            </button>` : ''}
        </div>`;
    }
    
    // ════════════════════════════════════════════════════════════════
    // EVENTS
    // ════════════════════════════════════════════════════════════════
    
    function bindPanelEvents() {
        // Условие: показывать/скрывать поля
        document.getElementById('alr-cond-type')?.addEventListener('change', e => {
            const t = e.target.value;
            document.getElementById('alr-level-row')?.classList.toggle('alr-hide', t === 'setup_signal');
            document.getElementById('alr-col-row')?.classList.toggle('alr-hide',   t !== 'setup_signal');
            document.getElementById('alr-trig-row')?.classList.toggle('alr-hide',  t !== 'setup_signal');
        });
    
        // Создать алерт
        document.getElementById('alr-create-btn')?.addEventListener('click', createAlert);
    
        // Live Context
        document.getElementById('alr-ctx-btn')?.addEventListener('click', fetchLiveContext);
    
        // Init DB
        document.getElementById('alr-init-btn')?.addEventListener('click', async () => {
            await fetch('/api/alerts/init', { method:'POST', credentials:'include' });
            alert('DB table ready.');
        });
    
        // Делегированные события на карточках
        document.getElementById('alr-list')?.addEventListener('click', async e => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const { action, id } = btn.dataset;
    
            if (action === 'toggle') {
                const card = AL.alerts.find(a => String(a.id) === id);
                if (!card) return;
                await fetch(`/api/alerts/${id}`, {
                    method: 'PATCH', credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ active: !card.active }),
                });
                await reloadAlerts();
            }
            if (action === 'delete') {
                if (!confirm('Delete this alert?')) return;
                await fetch(`/api/alerts/${id}`, { method: 'DELETE', credentials: 'include' });
                await reloadAlerts();
            }
            if (action === 'show-ctx') {
                const card = AL.alerts.find(a => String(a.id) === id);
                if (card?.context) {
                    const ctx = typeof card.context === 'string' ? JSON.parse(card.context) : card.context;
                    showContextCard(ctx, card.name);
                }
            }
        });
    
        // История — клик на элемент
        document.getElementById('alr-sidebar')?.querySelectorAll('.alr-hist-item').forEach(el => {
            el.addEventListener('click', () => {
                const idx = +el.dataset.idx;
                const h   = AL.history[idx];
                if (h) showContextCard(h.context, h.alert.name);
            });
        });
    }
    
    // ════════════════════════════════════════════════════════════════
    // CRUD
    // ════════════════════════════════════════════════════════════════
    
    async function createAlert() {
        const btCfg = getBTCfg();
        const name  = document.getElementById('alr-name')?.value.trim();
        const type  = document.getElementById('alr-cond-type')?.value;
        const once  = document.getElementById('alr-once')?.value === '1';
    
        if (!name) { alert('Enter alert name'); return; }
        if (!btCfg.ticker) { alert('Ticker not found. Make sure the chart is loaded.'); return; }
    
        const condition = { type };
        if (type === 'setup_signal') {
            condition.column       = document.getElementById('alr-col')?.value;
            condition.triggerValue = parseFloat(document.getElementById('alr-trig-val')?.value) || 1;
            if (!condition.column) { alert('Select a setup column'); return; }
        } else {
            condition.level = parseFloat(document.getElementById('alr-level')?.value);
            if (isNaN(condition.level) && type !== 'pct_change' && type !== 'atr_spike') {
                // для pct_change / atr_spike level это threshold
            }
            if (type === 'pct_change' || type === 'atr_spike') {
                condition.threshold = condition.level;
                delete condition.level;
            }
            if (isNaN(condition.level ?? condition.threshold)) {
                alert('Enter a valid number'); return;
            }
        }
    
        try {
            const resp = await fetch('/api/alerts', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name, ticker: btCfg.ticker, table: btCfg.table, condition, once,
                }),
            });
            if (!resp.ok) {
                const e = await resp.json().catch(() => ({}));
                // Если таблицы нет — инициализируем автоматически
                if (e.error?.includes('does not exist') || e.error?.includes('relation')) {
                    await fetch('/api/alerts/init', { method:'POST', credentials:'include' });
                    await fetch('/api/alerts', {
                        method: 'POST', credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name, ticker: btCfg.ticker, table: btCfg.table, condition, once }),
                    });
                } else {
                    throw new Error(e.error || resp.statusText);
                }
            }
            document.getElementById('alr-name').value  = '';
            document.getElementById('alr-level').value = '';
            await reloadAlerts();
        } catch(e) { alert('Error: ' + e.message); }
    }
    
    async function reloadAlerts() {
        await loadAlerts();
        const body = document.getElementById('sb-tab-body');
        if (body && document.getElementById('sb-tab-alerts')?.classList.contains('sb-tab-active')) {
            renderPanel(body);
        }
    }
    
    // ════════════════════════════════════════════════════════════════
    // REPLAY HOOK — интеграция с backtest-player.js
    // ════════════════════════════════════════════════════════════════
    
    /**
     * Патчим window.backtestPlayer чтобы получать уведомления на каждый шаг.
     * Используем polling + monkey-patch на публичный API.
     */
    function hookReplayPlayer() {
        if (AL.replayHooked) return;
    
        // Ждём когда backtestPlayer появится
        let attempts = 0;
        const timer = setInterval(() => {
            if (++attempts > 100) { clearInterval(timer); return; }
            if (!window.backtestPlayer) return;
            clearInterval(timer);
            patchPlayerMethods();
        }, 200);
    }
    
    function patchPlayerMethods() {
        const player = window.backtestPlayer;
        if (!player || player._alertPatched) return;
        player._alertPatched = true;
    
        // Патчим next — вызывается при каждом шаге вперёд
        const origNext = player.next;
        player.next = function(...args) {
            const result = origNext.apply(this, args);
            onReplayStep();
            return result;
        };
    
        // Патчим prev
        const origPrev = player.prev;
        player.prev = function(...args) {
            const result = origPrev.apply(this, args);
            onReplayStep();
            return result;
        };
    
        // Для play — используем polling пока активен replay
        const origPlay = player.play;
        player.play = function(...args) {
            const result = origPlay.apply(this, args);
            startReplayPolling();
            return result;
        };
    
        const origPause = player.pause;
        player.pause = function(...args) {
            const result = origPause.apply(this, args);
            stopReplayPolling();
            return result;
        };
    
        const origExit = player.exit;
        player.exit = function(...args) {
            stopReplayPolling();
            hideContextCard();
            return origExit.apply(this, args);
        };
    
        AL.replayHooked = true;
        updateReplayStatus(true);
        console.log('[Alerts] Hooked to backtestPlayer');
    }
    
    let _pollingTimer  = null;
    let _lastCheckedCursor = -1;
    
    function startReplayPolling() {
        if (_pollingTimer) return;
        _pollingTimer = setInterval(() => {
            const BT = window.backtestPlayer?.state;
            if (!BT?.active || !BT?.playing) return;
            if (BT.cursor === _lastCheckedCursor) return;
            _lastCheckedCursor = BT.cursor;
            onReplayStep();
        }, 150);
    }
    
    function stopReplayPolling() {
        clearInterval(_pollingTimer);
        _pollingTimer = null;
    }
    
    /**
     * Вызывается на каждый шаг replay.
     * Берём текущий бар из BT.data[BT.cursor], проверяем алерты.
     */
    async function onReplayStep() {
        const BT = window.backtestPlayer?.state;
        if (!BT?.active || !BT?.data?.length) return;
    
        const bar     = BT.data[BT.cursor];
        const prevBar = BT.cursor > 0 ? BT.data[BT.cursor - 1] : null;
        if (!bar) return;
    
        // Фильтруем активные алерты для текущего тикера
        const btCfg = getBTCfg();
        const activeAlerts = AL.alerts.filter(a =>
            a.active && (a.ticker === btCfg.ticker || !a.ticker)
        );
        if (!activeAlerts.length) return;
    
        // Проверяем условия локально (без сервера — мгновенно)
        const triggered = activeAlerts.filter(a => {
            const cond = typeof a.condition === 'string' ? JSON.parse(a.condition) : a.condition;
            return checkConditionClient(cond, bar, prevBar);
        });
    
        if (!triggered.length) return;
    
        // Для каждого сработавшего — получаем контекст с сервера
        for (const alert of triggered) {
            await requestAlertContext(alert, bar, BT);
        }
    }
    
    /**
     * Проверяет условие на клиенте (зеркало alert-engine.js checkCondition)
     */
    function checkConditionClient(cond, bar, prevBar) {
        const price = parseFloat(bar.close);
        const { type, level, column, triggerValue = 1, threshold } = cond;
    
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
                return atr > 0 && atr >= threshold;
            }
            default: return false;
        }
    }
    
    /**
     * Запрашивает у сервера полный контекст и показывает карточку
     */
    async function requestAlertContext(alert, bar, BT) {
        const btCfg  = getBTCfg();
        const trades = getTrades();
    
        // Берём последние 200 баров для контекста
        const barsForCtx = BT.data.slice(Math.max(0, BT.cursor - 200), BT.cursor + 1)
            .map(b => ({ ...b }));
    
        // Слим трейды
        const slimTrades = trades.map(t => ({ pnl: t.pnl, entryTs: t.entryTs, setupName: t.setupName }));
    
        try {
            const resp = await fetch('/api/alerts/check', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ticker:    btCfg.ticker,
                    table:     btCfg.table,
                    bar,
                    prevBar:   BT.cursor > 0 ? BT.data[BT.cursor - 1] : null,
                    bars:      barsForCtx,
                    setupCols: btCfg.setupCols || {},
                    capital:   btCfg.capital   || 10000,
                    trades:    slimTrades,
                }),
            });
    
            if (!resp.ok) return;
            const data = await resp.json();
    
            if (data.triggered?.length) {
                const first = data.triggered[0];
                // Добавляем в историю
                AL.history.push(first);
                // Деактивируем если once
                if (alert.once) {
                    const idx = AL.alerts.findIndex(a => a.id === alert.id);
                    if (idx !== -1) AL.alerts[idx].active = false;
                }
                // Показываем карточку
                showContextCard(first.context, first.alert.name);
                // Пауза replay чтобы пользователь увидел алерт
                window.backtestPlayer?.pause?.();
            }
        } catch(e) { console.warn('[Alerts] check error:', e); }
    }
    
    // ════════════════════════════════════════════════════════════════
    // LIVE CONTEXT (без алерта)
    // ════════════════════════════════════════════════════════════════
    
    async function fetchLiveContext() {
        const btCfg  = getBTCfg();
        const trades = getTrades();
    
        if (!btCfg.ticker) { alert('Ticker not found. Load the chart first.'); return; }
    
        const btn = document.getElementById('alr-ctx-btn');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Loading...'; }
    
        try {
            const slimTrades = trades.map(t => ({ pnl: t.pnl, entryTs: t.entryTs, setupName: t.setupName }));
            const resp = await fetch('/api/alerts/context', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ticker:    btCfg.ticker,
                    table:     btCfg.table,
                    fromDate:  btCfg.fromDate,
                    toDate:    btCfg.toDate,
                    setupCols: btCfg.setupCols || {},
                    capital:   btCfg.capital   || 10000,
                    trades:    slimTrades,
                }),
            });
            if (!resp.ok) { const e=await resp.json().catch(()=>({})); throw new Error(e.error||resp.statusText); }
            const ctx = await resp.json();
            showContextCard(ctx, '⚡ Live Context');
        } catch(e) { alert('Context error: ' + e.message); }
        finally {
            if (btn) { btn.disabled = false; btn.textContent = '⚡ Live Context Now'; }
        }
    }
    
    // ════════════════════════════════════════════════════════════════
    // CONTEXT CARD — всплывающая карточка поверх графика
    // ════════════════════════════════════════════════════════════════
    
    function showContextCard(ctx, title) {
        AL.cardVisible = true;
        let card = document.getElementById('alr-ctx-card');
    
        if (!card) {
            card = document.createElement('div');
            card.id = 'alr-ctx-card';
            document.body.appendChild(card);
        }
    
        const regime      = ctx.regime || 'unknown';
        const regColor    = REGIME_COLOR[regime] || '#444c70';
        const regIcon     = REGIME_ICON[regime]  || '❓';
        const regLabel    = { trending_up:'Trending Up', trending_down:'Trending Down', ranging:'Ranging', volatile:'Volatile', neutral:'Neutral', unknown:'Unknown' }[regime] || regime;
    
        card.innerHTML = `
        <div class="alr-card-inner">
            <!-- Header -->
            <div class="alr-card-hdr">
                <div class="alr-card-htitle">
                    <span class="alr-card-bell">🔔</span>
                    <span>${esc(title)}</span>
                </div>
                <div class="alr-card-hmeta">
                    <span class="alr-card-price">@ ${ctx.price}</span>
                    <span class="alr-card-time">${fmtTs(ctx.triggeredAt)}</span>
                </div>
                <button class="alr-card-close" id="alr-card-close">✕</button>
            </div>
    
            <!-- Sections grid -->
            <div class="alr-card-body">
    
                <!-- 1. Market Regime -->
                <div class="alr-ctx-section">
                    <div class="alr-ctx-sec-hdr">🌊 Market Regime</div>
                    <div class="alr-regime-pill" style="background:${regColor}22;border-color:${regColor};color:${regColor}">
                        ${regIcon} ${regLabel}
                    </div>
                    ${ctx.regimeFeatures ? `
                    <div class="alr-feat-grid">
                        ${featurePill('ADX',      ctx.regimeFeatures.adx)}
                        ${featurePill('ATR%',     ctx.regimeFeatures.atrPct)}
                        ${featurePill('BB Width', ctx.regimeFeatures.bbWidth)}
                        ${featurePill('R²',       ctx.regimeFeatures.r2)}
                    </div>` : '<div class="alr-no-data">Not enough bars for regime analysis</div>'}
                </div>
    
                <!-- 2. Active Setups -->
                <div class="alr-ctx-section">
                    <div class="alr-ctx-sec-hdr">🎯 Active Setups on This Bar</div>
                    ${ctx.activeSetups?.length ? ctx.activeSetups.map(s => `
                    <div class="alr-setup-row">
                        <div class="alr-setup-name">
                            <span class="alr-dir-badge alr-dir-${s.dir}">${s.dir}</span>
                            ${esc(s.name)}
                        </div>
                        <div class="alr-setup-stats">
                            ${s.winRate !== null
                                ? `<span class="alr-wr ${s.winRate>=50?'alr-pos':'alr-neg'}">${s.winRate}% WR</span>`
                                : '<span class="alr-wr-na">no history</span>'}
                            ${s.profitFactor !== null
                                ? `<span class="alr-pf">PF ${s.profitFactor}</span>`
                                : ''}
                            ${s.trades ? `<span class="alr-trd">${s.trades} trades</span>` : ''}
                            ${s.reliable ? '<span class="alr-reliable">✓ reliable</span>' : ''}
                        </div>
                    </div>`).join('')
                    : '<div class="alr-no-data">No setup signals on this bar</div>'}
                </div>
    
                <!-- 3. Recommendation -->
                ${ctx.recommendation ? `
                <div class="alr-ctx-section alr-ctx-rec">
                    <div class="alr-ctx-sec-hdr">💡 Recommendation</div>
                    <div class="alr-rec-body">
                        <div class="alr-rec-setup">${esc(ctx.recommendation.setup)}</div>
                        <div class="alr-rec-stats">
                            <span class="alr-pos">${ctx.recommendation.winRate}% WR</span>
                            · avg PnL $${ctx.recommendation.avgPnl}
                            · <span class="alr-conf alr-conf-${ctx.recommendation.confidence}">${ctx.recommendation.confidence} confidence</span>
                        </div>
                        <div class="alr-rec-reason">${esc(ctx.recommendation.reason)}</div>
                    </div>
                </div>` : ''}
    
                <!-- 4. Liquidity Levels -->
                <div class="alr-ctx-section">
                    <div class="alr-ctx-sec-hdr">📊 Nearest Liquidity Levels</div>
                    <div class="alr-levels-wrap">
                        <div class="alr-levels-col">
                            <div class="alr-levels-side">▲ Resistance</div>
                            ${ctx.levelsAbove?.length
                                ? ctx.levelsAbove.map(l => levelRow(l)).join('')
                                : '<div class="alr-no-data">—</div>'}
                        </div>
                        <div class="alr-price-divider" title="Current price">
                            <div class="alr-price-line"></div>
                            <div class="alr-price-badge">${ctx.price}</div>
                            <div class="alr-price-line"></div>
                        </div>
                        <div class="alr-levels-col">
                            <div class="alr-levels-side">▼ Support</div>
                            ${ctx.levelsBelow?.length
                                ? ctx.levelsBelow.map(l => levelRow(l)).join('')
                                : '<div class="alr-no-data">—</div>'}
                        </div>
                    </div>
                </div>
    
            </div>
    
            <!-- Summary -->
            ${ctx.summary?.length ? `
            <div class="alr-card-summary">
                ${ctx.summary.map(s => `<div class="alr-summary-line">${esc(s)}</div>`).join('')}
            </div>` : ''}
    
            <!-- Footer -->
            <div class="alr-card-footer">
                <button class="alr-footer-btn" id="alr-card-resume">▶ Resume Replay</button>
                <button class="alr-footer-btn alr-footer-dismiss" id="alr-card-close2">Dismiss</button>
            </div>
        </div>`;
    
        // Show with animation
        card.style.display = 'flex';
        setTimeout(() => card.classList.add('alr-card-visible'), 10);
    
        document.getElementById('alr-card-close')?.addEventListener('click',   hideContextCard);
        document.getElementById('alr-card-close2')?.addEventListener('click',  hideContextCard);
        document.getElementById('alr-card-resume')?.addEventListener('click', () => {
            hideContextCard();
            window.backtestPlayer?.play?.();
        });
    }
    
    function levelRow(l) {
        const typeLabel = { swing_high:'Swing H', swing_low:'Swing L', high_volume_node:'HVN', round_number:'Round' }[l.type] || l.type;
        const strength  = '●'.repeat(l.strength) + '○'.repeat(3 - l.strength);
        return `<div class="alr-level-row">
            <span class="alr-level-type">${typeLabel}</span>
            <span class="alr-level-val">${l.level}</span>
            <span class="alr-level-dist ${l.side==='above'?'alr-pos':'alr-neg'}">${l.distancePct > 0 ? '+' : ''}${l.distancePct}%</span>
            <span class="alr-level-str">${strength}</span>
        </div>`;
    }
    
    function featurePill(label, val) {
        return `<div class="alr-feat-pill"><span class="alr-feat-l">${label}</span><span class="alr-feat-v">${val ?? '—'}</span></div>`;
    }
    
    function hideContextCard() {
        AL.cardVisible = false;
        const card = document.getElementById('alr-ctx-card');
        if (!card) return;
        card.classList.remove('alr-card-visible');
        setTimeout(() => { card.style.display = 'none'; }, 300);
    }
    
    // ════════════════════════════════════════════════════════════════
    // UTILS
    // ════════════════════════════════════════════════════════════════
    
    function fmtTs(ts) {
        if (!ts) return '—';
        try { return new Date(ts).toISOString().replace('T', ' ').slice(0, 19); }
        catch(_) { return String(ts).slice(0, 19); }
    }
    
    function updateReplayStatus(ok) {
        const el = document.getElementById('alr-replay-status');
        if (!el) return;
        el.className = `alr-replay-status ${ok ? 'alr-status-ok' : 'alr-status-off'}`;
        el.textContent = ok ? '✓ Hooked to Replay' : '○ Replay not active';
    }
    
    // ════════════════════════════════════════════════════════════════
    // CSS
    // ════════════════════════════════════════════════════════════════
    
    function injectCSS() {
        if (document.getElementById('alr-css')) return;
        const s = document.createElement('style');
        s.id = 'alr-css';
        s.textContent = `
    /* ── Tab button ───────────────────────────────────────── */
    .sb-tab-alerts.sb-tab-active { color:#f5a623; border-bottom-color:#f5a623 }
    
    /* ── Panel layout ─────────────────────────────────────── */
    .alr-root    { display:flex; height:100%; min-height:0; font-size:12px; color:#c8ccd8; background:#080a12 }
    .alr-sidebar { width:220px; min-width:220px; border-right:1px solid #141826; overflow-y:auto; background:#0b0d16; flex-shrink:0 }
    .alr-main    { flex:1; overflow-y:auto; padding:10px }
    .alr-loading { padding:30px; text-align:center; color:#444c70 }
    
    /* ── Sidebar ──────────────────────────────────────────── */
    .alr-logo    { padding:6px 12px 8px; font-size:11px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:#f5a623; border-bottom:1px solid #141826 }
    .alr-sb-sect { padding:8px 10px; border-bottom:1px solid #141826 }
    .alr-sb-h    { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.07em; color:#444c70; margin-bottom:7px }
    .alr-field   { margin-bottom:7px }
    .alr-lbl     { display:block; font-size:10px; color:#6a7090; margin-bottom:3px }
    .alr-inp     { width:100%; box-sizing:border-box; background:#111320; border:1px solid #1a1e30; color:#c8ccd8; padding:4px 7px; border-radius:3px; font-size:11px; outline:none; font-family:inherit }
    .alr-inp:focus { border-color:#f5a623 }
    .alr-sel     { width:100%; box-sizing:border-box; background:#111320; border:1px solid #1a1e30; color:#c8ccd8; padding:4px 5px; border-radius:3px; font-size:11px; outline:none; font-family:inherit }
    .alr-hide    { display:none !important }
    .alr-create-btn { width:100%; margin-top:6px }
    .alr-ctx-btn    { width:100%; margin-top:6px; background:#111320; border-color:#f5a623; color:#f5a623 }
    .alr-ctx-btn:hover { background:#1a1620 }
    .alr-hint    { font-size:10px; color:#2a3050; line-height:1.6; margin-top:4px }
    .alr-replay-status { font-size:10px; padding:4px 8px; border-radius:3px; margin-top:5px; font-weight:600 }
    .alr-status-ok  { color:#4caf50; background:rgba(76,175,80,.1) }
    .alr-status-off { color:#444c70; background:rgba(68,76,112,.1) }
    .alr-hist-item  { padding:5px 0; border-bottom:1px solid #141826; cursor:pointer }
    .alr-hist-item:hover .alr-hist-name { color:#f5a623 }
    .alr-hist-name  { font-size:11px; font-weight:600; color:#c8ccd8 }
    .alr-hist-ts    { font-size:10px; color:#444c70; font-family:monospace }
    .alr-hist-price { font-size:10px; color:#6a7090 }
    
    /* ── Alert cards ──────────────────────────────────────── */
    .alr-empty   { display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; min-height:260px; text-align:center; gap:10px; padding:20px }
    .alr-empty-t { font-size:15px; font-weight:700; color:#444c70 }
    .alr-empty-s { font-size:11px; color:#2a3050; line-height:2 }
    .alr-list     { display:flex; flex-direction:column; gap:8px }
    .alr-list-hdr { display:flex; align-items:center; gap:10px; padding:6px 0 10px }
    .alr-list-title { font-weight:700; font-size:12px }
    .alr-init-btn  { font-size:10px; padding:2px 8px; background:#111320; border:1px solid #1a1e30; border-radius:3px; color:#444c70; cursor:pointer }
    .alr-init-btn:hover { color:#c8ccd8 }
    
    .alr-card     { background:#0d0f1a; border:1px solid #1a1e30; border-radius:6px; padding:10px 12px; transition:opacity .15s }
    .alr-card-off { opacity:.5 }
    .alr-card-top { display:flex; align-items:center; gap:8px; margin-bottom:6px }
    .alr-card-name { flex:1; font-weight:700; font-size:12px }
    .alr-card-actions { display:flex; gap:4px }
    .alr-icon-btn  { width:22px; height:22px; border-radius:50%; border:1px solid; background:transparent; cursor:pointer; font-size:11px; display:flex; align-items:center; justify-content:center }
    .alr-active-btn   { border-color:#4caf50; color:#4caf50 }
    .alr-inactive-btn { border-color:#444c70; color:#444c70 }
    .alr-del-btn  { border-color:#ef5350; color:#ef5350 }
    .alr-card-cond { display:flex; align-items:center; gap:6px; margin-bottom:5px }
    .alr-cond-badge { background:rgba(245,166,35,.12); color:#f5a623; border-radius:9px; padding:2px 7px; font-size:10px; font-weight:600 }
    .alr-cond-val   { font-size:11px; color:#c8ccd8; font-family:monospace }
    .alr-card-meta  { display:flex; gap:10px; font-size:10px; color:#444c70; flex-wrap:wrap }
    .alr-show-ctx-btn { margin-top:7px; font-size:10px; padding:3px 10px; background:#111320; border:1px solid #1a1e30; border-radius:3px; color:#6a7090; cursor:pointer }
    .alr-show-ctx-btn:hover { color:#c8ccd8 }
    
    /* ── Context card overlay ─────────────────────────────── */
    #alr-ctx-card {
        display:none; position:fixed; top:0; left:0; right:0; bottom:0;
        align-items:center; justify-content:center;
        background:rgba(0,0,0,.65); backdrop-filter:blur(4px);
        z-index:99999;
        opacity:0; transition:opacity .25s;
    }
    #alr-ctx-card.alr-card-visible { opacity:1 }
    
    .alr-card-inner {
        background:#0d0f1a; border:1px solid #1a1e30; border-radius:10px;
        width:680px; max-width:96vw; max-height:90vh;
        display:flex; flex-direction:column;
        box-shadow:0 20px 60px rgba(0,0,0,.8);
        transform:translateY(12px); transition:transform .25s;
        overflow:hidden;
    }
    #alr-ctx-card.alr-card-visible .alr-card-inner { transform:translateY(0) }
    
    .alr-card-hdr {
        display:flex; align-items:center; gap:10px; padding:12px 16px;
        background:#111320; border-bottom:1px solid #1a1e30; flex-shrink:0;
    }
    .alr-card-htitle { display:flex; align-items:center; gap:8px; flex:1; font-weight:700; font-size:14px }
    .alr-card-bell   { font-size:18px }
    .alr-card-hmeta  { display:flex; flex-direction:column; align-items:flex-end; gap:2px }
    .alr-card-price  { font-size:13px; font-weight:700; color:#f5a623 }
    .alr-card-time   { font-size:10px; color:#444c70; font-family:monospace }
    .alr-card-close  { background:transparent; border:none; color:#444c70; cursor:pointer; font-size:16px; padding:0 4px; flex-shrink:0 }
    .alr-card-close:hover { color:#ef5350 }
    
    .alr-card-body {
        display:grid; grid-template-columns:1fr 1fr; gap:1px;
        background:#141826; overflow-y:auto; flex:1;
    }
    .alr-ctx-section {
        background:#0d0f1a; padding:12px 14px;
    }
    .alr-ctx-rec { grid-column:1/-1; background:#0b0d14 }
    .alr-ctx-sec-hdr { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.07em; color:#444c70; margin-bottom:8px }
    .alr-no-data { font-size:11px; color:#2a3050 }
    
    /* Regime */
    .alr-regime-pill { display:inline-flex; align-items:center; gap:5px; padding:5px 12px; border:1px solid; border-radius:20px; font-size:13px; font-weight:700; margin-bottom:8px }
    .alr-feat-grid   { display:grid; grid-template-columns:1fr 1fr; gap:4px }
    .alr-feat-pill   { display:flex; justify-content:space-between; background:#111320; border-radius:3px; padding:3px 7px }
    .alr-feat-l      { font-size:10px; color:#444c70 }
    .alr-feat-v      { font-size:11px; font-weight:600; color:#c8ccd8 }
    
    /* Setups */
    .alr-setup-row   { margin-bottom:6px }
    .alr-setup-name  { display:flex; align-items:center; gap:6px; font-size:12px; font-weight:600; margin-bottom:3px }
    .alr-dir-badge   { font-size:9px; padding:1px 5px; border-radius:3px; font-weight:700; text-transform:uppercase }
    .alr-dir-long    { background:rgba(76,175,80,.15); color:#4caf50 }
    .alr-dir-short   { background:rgba(239,83,80,.15); color:#ef5350 }
    .alr-setup-stats { display:flex; gap:6px; flex-wrap:wrap; align-items:center }
    .alr-wr          { font-size:11px; font-weight:700 }
    .alr-wr-na       { font-size:10px; color:#444c70 }
    .alr-pf          { font-size:10px; background:#111320; padding:1px 5px; border-radius:3px; color:#9598a1 }
    .alr-trd         { font-size:10px; color:#444c70 }
    .alr-reliable    { font-size:10px; color:#4caf50 }
    .alr-pos { color:#4caf50 }
    .alr-neg { color:#ef5350 }
    
    /* Recommendation */
    .alr-rec-body    { display:flex; flex-direction:column; gap:4px }
    .alr-rec-setup   { font-size:16px; font-weight:700; color:#f5a623 }
    .alr-rec-stats   { font-size:11px; color:#c8ccd8 }
    .alr-rec-reason  { font-size:10px; color:#444c70 }
    .alr-conf        { font-weight:700 }
    .alr-conf-high   { color:#4caf50 }
    .alr-conf-medium { color:#ff9800 }
    .alr-conf-low    { color:#607d8b }
    
    /* Levels */
    .alr-levels-wrap { display:flex; gap:8px; align-items:center }
    .alr-levels-col  { flex:1 }
    .alr-levels-side { font-size:10px; color:#444c70; margin-bottom:5px; font-weight:600 }
    .alr-level-row   { display:flex; align-items:center; gap:5px; padding:3px 0; border-bottom:1px solid rgba(255,255,255,.03) }
    .alr-level-type  { font-size:9px; color:#444c70; width:48px; flex-shrink:0 }
    .alr-level-val   { font-size:11px; font-weight:600; font-family:monospace; flex:1 }
    .alr-level-dist  { font-size:10px; font-weight:700; width:40px; text-align:right; flex-shrink:0 }
    .alr-level-str   { font-size:9px; color:#444c70; flex-shrink:0; letter-spacing:-2px }
    .alr-price-divider { display:flex; flex-direction:column; align-items:center; gap:4px; flex-shrink:0 }
    .alr-price-line  { width:1px; height:20px; background:#1a1e30 }
    .alr-price-badge { font-size:10px; font-weight:700; color:#f5a623; background:#111320; padding:2px 6px; border-radius:3px; white-space:nowrap; font-family:monospace }
    
    /* Summary */
    .alr-card-summary { padding:10px 16px; background:#0b0d14; border-top:1px solid #141826; flex-shrink:0 }
    .alr-summary-line { font-size:11px; color:#9598a1; margin-bottom:3px; line-height:1.6 }
    
    /* Footer */
    .alr-card-footer { display:flex; gap:8px; padding:10px 16px; border-top:1px solid #141826; flex-shrink:0 }
    .alr-footer-btn  { flex:1; padding:7px; background:#111320; border:1px solid #1a1e30; border-radius:4px; color:#c8ccd8; font-size:12px; cursor:pointer; font-family:inherit }
    .alr-footer-btn:hover { background:#1a2030 }
    .alr-footer-dismiss { color:#444c70 }
    .alr-footer-dismiss:hover { color:#ef5350; border-color:#ef5350 }
    
    /* Light theme */
    body.light-theme .alr-root     { background:#f8f9fd }
    body.light-theme .alr-sidebar  { background:#f0f3fa; border-color:#d0d3db }
    body.light-theme .alr-logo     { border-color:#d0d3db }
    body.light-theme .alr-inp,.alr-sel { background:#fff; border-color:#d0d3db; color:#131722 }
    body.light-theme .alr-card     { background:#fff; border-color:#d0d3db }
    body.light-theme #alr-ctx-card .alr-card-inner { background:#fff; border-color:#d0d3db }
    `;
        document.head.appendChild(s);
    }
    
    // ════════════════════════════════════════════════════════════════
    // INIT
    // ════════════════════════════════════════════════════════════════
    
    injectTab();
    console.log('[SmartAlerts] v1.0 loaded');
    
    // Хукаем player как только он появится (он грузится раньше этого файла)
    setTimeout(() => {
        if (window.backtestPlayer && !window.backtestPlayer._alertPatched) {
            patchPlayerMethods();
        }
    }, 500);
    
    window.smartAlerts = {
        showContext: showContextCard,
        hideContext: hideContextCard,
        reload:      reloadAlerts,
    };
    
    })(); }