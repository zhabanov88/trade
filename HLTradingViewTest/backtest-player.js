/**
 * backtest-player.js  v2
 *
 * Bar Replay / Бэктест
 *
 * Механизм:
 *   1. Пробуем chart.startReplay() — нативный TradingView API
 *   2. Если недоступен — кастомный replay:
 *      - Останавливаем setInterval у каждого subscriber в datafeed.subscribers (Map)
 *      - Пушим бары из activedata через subscriber.onRealtimeCallback
 *      - При Exit — восстанавливаем intervalId у каждого subscriber
 *
 * UI:
 *   - Кнопка "📽 Replay" в navbar → показывает/скрывает строку управления
 *   - Строка под navbar: [дата] [▶ Start] | [⏮][◀][▶/⏸][▶|][⏭] [скорость] [прогресс] [✕ Exit]
 *   - Клавиши: Пробел = play/pause, ← → = prev/next
 */
if (window._btLoaded) {} else { window._btLoaded = true; (function () {
    'use strict';
    
    // ════════════════════════════════════════════════════════
    // СОСТОЯНИЕ
    // ════════════════════════════════════════════════════════
    
    const BT = {
        mode:    null,   // 'native' | 'custom' | null
        active:  false,
        playing: false,
        cursor:  0,
        speed:   1,
        data:    [],     // полная копия activedata на момент старта
        _orig:   null,   // оригинальный массив activedata (для восстановления)
        _ivId:   null,   // replay setInterval
    };
    
    // ════════════════════════════════════════════════════════
    // DATAFEED HELPERS
    // Subscribers — Map<uid, { onRealtimeCallback, intervalId, ... }>
    // ════════════════════════════════════════════════════════
    
    function getSubscribersMap() {
        // DatabaseIntegratedDatafeed хранит subscribers как this.subscribers
        // Он доступен через window.app.datafeed (если прокинуть) или через widget
        return window.app?.datafeed?.subscribers   // если прокинули datafeed в app
            || window._datafeed?.subscribers       // альтернатива
            || null;
    }
    
    /** Останавливаем realtime polling во всех subscribers */
    function pauseSubscribers() {
        const subs = getSubscribersMap();
        if (!subs) return;
        subs.forEach((sub, uid) => {
            if (sub.intervalId != null) {
                clearInterval(sub.intervalId);
                sub._btSavedIv = sub.intervalId;  // запоминаем чтобы восстановить
                sub.intervalId = null;
                console.log(`[backtest] paused subscriber ${uid}`);
            }
        });
    }
    
    /** Восстанавливаем realtime polling (перезапускаем с тем же интервалом 5000ms) */
    function resumeSubscribers() {
        const subs = getSubscribersMap();
        if (!subs) return;
        // Перезапускать setInterval напрямую не можем (замыкание внутри datafeed),
        // поэтому триггерим onResetCacheNeededCallback чтобы TV переподписался
        subs.forEach((sub, uid) => {
            if (sub._btSavedIv != null) {
                sub._btSavedIv = null;
                // Вызываем reset — TV сам заново вызовет subscribeBars
                try { sub.onResetCacheNeededCallback?.(); } catch(_) {}
                console.log(`[backtest] resumed subscriber ${uid}`);
            }
        });
    }
    
    /** Пушим один бар во все subscribers */
    function pushBar(bar) {
        const tvBar = {
            time:   new Date(bar.timestamp).getTime(),
            open:   parseFloat(bar.open),
            high:   parseFloat(bar.high),
            low:    parseFloat(bar.low),
            close:  parseFloat(bar.close),
            volume: parseFloat(bar.volume || 0),
        };
        const subs = getSubscribersMap();
        if (subs) {
            subs.forEach(sub => {
                try { sub.onRealtimeCallback(tvBar); } catch(e) {}
            });
        }
        return tvBar;
    }
    
    // ════════════════════════════════════════════════════════
    // НАТИВНЫЙ TV REPLAY
    // ════════════════════════════════════════════════════════
    
    function tryNative(startMs) {
        try {
            const chart = window.app?.widget?.activeChart();
            if (!chart || typeof chart.startReplay !== 'function') return false;
            chart.startReplay(Math.floor(startMs / 1000));
            window._btChart = chart;
            BT.mode = 'native';
            console.log('[backtest] Native TV replay started');
            return true;
        } catch(e) {
            console.warn('[backtest] Native replay unavailable:', e.message);
            return false;
        }
    }
    
    // ════════════════════════════════════════════════════════
    // КАСТОМНЫЙ REPLAY
    // ════════════════════════════════════════════════════════
    
    function startCustom(startMs) {
        const all = window.app?.activedata;
        if (!all?.length) { toast('Нет данных. Подождите загрузки графика.'); return false; }
    
        // Ищем первый бар >= startDate
        const idx = all.findIndex(r => new Date(r.timestamp).getTime() >= startMs);
        if (idx === -1) { toast('Нет данных с выбранной даты — попробуйте позже.'); return false; }
    
        // Сохраняем оригинал и делаем рабочую копию
        BT._orig  = [...all];
        BT.data   = [...all];
        BT.cursor = idx;
        BT.mode   = 'custom';
    
        // Останавливаем realtime
        pauseSubscribers();
    
        // Обрезаем activedata до стартового бара
        window.app.activedata = BT.data.slice(0, idx + 1);
    
        // Пушим стартовый бар в TV
        const tvBar = pushBar(BT.data[idx]);
        scrollTo(tvBar.time);
        updateProgress();
    
        console.log(`[backtest] Custom replay: bar ${idx+1}/${all.length} | ${BT.data[idx].timestamp}`);
        return true;
    }
    
    // ── Управление воспроизведением ───────────────────────────────────────────
    
    function customNext(count = 1) {
        for (let i = 0; i < count; i++) {
            if (BT.cursor >= BT.data.length - 1) { customPause(); return; }
            BT.cursor++;
            const tvBar = pushBar(BT.data[BT.cursor]);
            if (i === count - 1) scrollTo(tvBar.time);
        }
        // Обновляем activedata
        window.app.activedata = BT.data.slice(0, BT.cursor + 1);
        window.dataTable?.refresh();
        window.dataTable?.highlight(new Date(BT.data[BT.cursor].timestamp).getTime());
        updateProgress();
    }
    
    function customPrev() {
        if (BT.cursor <= 0) return;
        BT.cursor--;
        window.app.activedata = BT.data.slice(0, BT.cursor + 1);
        const tsMs = new Date(BT.data[BT.cursor].timestamp).getTime();
        scrollTo(tsMs);
        window.dataTable?.refresh();
        window.dataTable?.highlight(tsMs);
        updateProgress();
    }
    
    function customPlay() {
        if (BT.cursor >= BT.data.length - 1) return;
        BT.playing = true;
        updatePlayBtn();
        const delay = Math.max(30, Math.round(500 / BT.speed));
        BT._ivId = setInterval(() => {
            if (BT.cursor >= BT.data.length - 1) { customPause(); return; }
            customNext();
        }, delay);
    }
    
    function customPause() {
        BT.playing = false;
        clearInterval(BT._ivId); BT._ivId = null;
        updatePlayBtn();
    }
    
    function customJumpStart() {
        customPause();
        BT.cursor = 0;
        window.app.activedata = BT.data.slice(0, 1);
        const tsMs = new Date(BT.data[0].timestamp).getTime();
        pushBar(BT.data[0]);
        scrollTo(tsMs);
        window.dataTable?.refresh();
        updateProgress();
    }
    
    function customJumpEnd() {
        customPause();
        // Пушим оставшиеся бары батчем (только последний отображается)
        BT.cursor = BT.data.length - 1;
        pushBar(BT.data[BT.cursor]);
        window.app.activedata = [...BT.data];
        const tsMs = new Date(BT.data[BT.cursor].timestamp).getTime();
        scrollTo(tsMs);
        window.dataTable?.refresh();
        updateProgress();
    }
    
    // ════════════════════════════════════════════════════════
    // ДИСПЕТЧЕР — нативный / кастомный
    // ════════════════════════════════════════════════════════
    
    function play() {
        if (BT.mode === 'native') {
            try { window._btChart?.replayPlay?.(BT.speed); BT.playing = true; updatePlayBtn(); } catch(_) {}
        } else { customPlay(); }
    }
    function pause() {
        if (BT.mode === 'native') {
            try { window._btChart?.replayPause?.(); BT.playing = false; updatePlayBtn(); } catch(_) {}
        } else { customPause(); }
    }
    function togglePlay() { BT.playing ? pause() : play(); }
    function stepNext()   { BT.mode === 'native' ? (()=>{ try{window._btChart?.replayStep?.(1);}catch(_){} })() : customNext(); }
    function stepPrev()   { BT.mode === 'native' ? (()=>{ try{window._btChart?.replayStep?.(-1);}catch(_){} })() : customPrev(); }
    function jumpStart()  { BT.mode === 'native' ? null : customJumpStart(); }
    function jumpEnd()    { BT.mode === 'native' ? (()=>{ try{window._btChart?.stopReplay?.();}catch(_){} exitReplay(); })() : customJumpEnd(); }
    
    // ════════════════════════════════════════════════════════
    // СТАРТ / ВЫХОД
    // ════════════════════════════════════════════════════════
    
    function startReplay() {
        const dateVal = document.getElementById('bt-date')?.value;
        if (!dateVal) { toast('Выберите дату старта'); return; }
    
        const startMs = new Date(dateVal).getTime();
        if (isNaN(startMs)) { toast('Некорректная дата'); return; }
    
        // Пробуем нативный, затем кастомный
        const ok = tryNative(startMs) || startCustom(startMs);
        if (!ok) return;
    
        BT.active = true;
        setUIActive(true);
        document.getElementById('tv_chart_container')?.classList.add('bt-border');
    }
    
    function exitReplay() {
        pause();
        BT.active  = false;
    
        if (BT.mode === 'native') {
            try { window._btChart?.stopReplay?.(); } catch(_) {}
        } else if (BT.mode === 'custom') {
            // Восстанавливаем оригинальные данные
            if (BT._orig) { window.app.activedata = BT._orig; BT._orig = null; }
            // Возобновляем realtime
            resumeSubscribers();
            window.dataTable?.refresh();
        }
    
        BT.mode = null; BT.data = []; BT.cursor = 0;
        setUIActive(false);
        document.getElementById('tv_chart_container')?.classList.remove('bt-border');
        document.getElementById('bt-prog').textContent = '';
        console.log('[backtest] Exited');
    }
    
    // ════════════════════════════════════════════════════════
    // UI
    // ════════════════════════════════════════════════════════
    
    function buildUI() {
        if (document.getElementById('bt-bar')) return;
    
        // Кнопка в navbar
        const navBtn = document.createElement('button');
        navBtn.id        = 'bt-nav-btn';
        navBtn.className = 'nav-btn';
        navBtn.textContent = '📽 Replay';
        navBtn.title = 'Bar Replay / Backtest';
        navBtn.addEventListener('click', toggleBar);
        const nav = document.querySelector('.navbar-right');
        if (nav) nav.insertBefore(navBtn, nav.firstChild);
    
        // Бар управления (скрыт по умолчанию)
        const bar = document.createElement('div');
        bar.id = 'bt-bar';
    
        // Дата по умолчанию: -30 дней
        const def = new Date(); def.setDate(def.getDate() - 30);
        const defStr = def.toISOString().slice(0, 10);
    
        bar.innerHTML = `
            <span class="bt-lbl">📽 Replay</span>
            <input  type="date" id="bt-date" value="${defStr}" title="Дата старта">
            <button class="bt-btn bt-green" id="bt-start">▶ Start</button>
            <div id="bt-ctrls">
                <button class="bt-ctrl" id="bt-reset" title="В начало">⏮</button>
                <button class="bt-ctrl" id="bt-prev"  title="Предыдущий бар">◀</button>
                <button class="bt-ctrl" id="bt-play"  title="Play / Pause">▶</button>
                <button class="bt-ctrl" id="bt-next"  title="Следующий бар">▶|</button>
                <button class="bt-ctrl" id="bt-end"   title="В конец">⏭</button>
                <select id="bt-spd" title="Скорость">
                    <option value="1">1×</option>
                    <option value="2">2×</option>
                    <option value="5">5×</option>
                    <option value="10">10×</option>
                    <option value="20">20×</option>
                </select>
                <span id="bt-prog"></span>
            </div>
            <button class="bt-btn bt-red" id="bt-exit">✕ Exit</button>`;
    
        // Вставляем после interval-selector-panel
        const isp = document.querySelector('.interval-selector-panel');
        if (isp?.parentNode) isp.parentNode.insertBefore(bar, isp.nextSibling);
        else {
            const cc = document.getElementById('tv_chart_container');
            (cc?.parentNode || document.body).insertBefore(bar, cc);
        }
    
        // События
        document.getElementById('bt-start').onclick = startReplay;
        document.getElementById('bt-exit').onclick  = exitReplay;
        document.getElementById('bt-reset').onclick = jumpStart;
        document.getElementById('bt-prev').onclick  = stepPrev;
        document.getElementById('bt-play').onclick  = togglePlay;
        document.getElementById('bt-next').onclick  = stepNext;
        document.getElementById('bt-end').onclick   = jumpEnd;
        document.getElementById('bt-spd').onchange  = e => {
            BT.speed = +e.target.value;
            if (BT.playing) { pause(); play(); }
        };
    
        // Клавиши
        document.addEventListener('keydown', e => {
            if (!BT.active) return;
            if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return;
            if (e.code === 'Space')      { e.preventDefault(); togglePlay(); }
            if (e.code === 'ArrowRight') { e.preventDefault(); stepNext();   }
            if (e.code === 'ArrowLeft')  { e.preventDefault(); stepPrev();   }
        });
    
        setUIActive(false);
        injectCSS();
    }
    
    function toggleBar() {
        const bar = document.getElementById('bt-bar');
        if (!bar) return;
        const show = bar.style.display === 'none' || !bar.style.display;
        bar.style.display = show ? 'flex' : 'none';
        const btn = document.getElementById('bt-nav-btn');
        if (btn) btn.classList.toggle('nav-btn-active', show);
    }
    
    function setUIActive(active) {
        const ctrls = document.getElementById('bt-ctrls');
        const exit  = document.getElementById('bt-exit');
        const start = document.getElementById('bt-start');
        const date  = document.getElementById('bt-date');
        if (ctrls) ctrls.style.display = active ? 'flex' : 'none';
        if (exit)  exit.style.display  = active ? 'inline-flex' : 'none';
        if (start) start.style.display = active ? 'none' : 'inline-flex';
        if (date)  date.disabled       = active;
    }
    
    // ── Helpers ───────────────────────────────────────────────────────────────
    
    function scrollTo(tsMs) {
        try {
            const chart = window.app?.widget?.activeChart();
            if (!chart) return;
            const unix = Math.floor(tsMs / 1000);
            // Пробуем разные методы в зависимости от версии TV
            if (typeof chart.scrollToPosition === 'function') chart.scrollToPosition(unix);
            else if (typeof chart.setVisibleRange === 'function') {
                const ivSec = getIntervalSeconds();
                chart.setVisibleRange({ from: unix - ivSec * 100, to: unix + ivSec * 20 });
            }
        } catch(_) {}
    }
    
    function getIntervalSeconds() {
        const iv = window.app?.widget?.activeChart?.()?.resolution?.() || '1';
        const m = { '1T':1,'1t':1,'1':60,'3':180,'5':300,'15':900,'30':1800,'60':3600,'240':14400,'1D':86400,'1W':604800 };
        return m[iv] || 60;
    }
    
    function updateProgress() {
        const el = document.getElementById('bt-prog');
        if (!el || BT.mode !== 'custom') return;
        const bar = BT.data[BT.cursor];
        if (!bar) return;
        const ts  = new Date(bar.timestamp).toISOString().replace('T',' ').slice(0,19);
        const pct = BT.data.length > 1 ? Math.round(BT.cursor / (BT.data.length-1) * 100) : 0;
        el.textContent = `${ts}  ·  #${BT.cursor+1}/${BT.data.length}  (${pct}%)`;
    }
    
    function updatePlayBtn() {
        const btn = document.getElementById('bt-play');
        if (btn) btn.textContent = BT.playing ? '⏸' : '▶';
    }
    
    function toast(msg) {
        let el = document.getElementById('bt-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'bt-toast';
            el.style.cssText = [
                'position:fixed','bottom:70px','left:50%',
                'transform:translateX(-50%) translateY(8px)',
                'z-index:100000','max-width:440px','text-align:center',
                'padding:10px 20px','border-radius:6px',
                'background:#3a1010','border-left:3px solid #ef5350',
                'color:#fff','font-size:13px','font-family:system-ui',
                'box-shadow:0 4px 20px rgba(0,0,0,.6)',
                'transition:opacity .25s,transform .25s',
                'opacity:0','pointer-events:none'
            ].join(';');
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.style.opacity = '1';
        el.style.transform = 'translateX(-50%) translateY(0)';
        clearTimeout(el._t);
        el._t = setTimeout(() => {
            el.style.opacity = '0';
            el.style.transform = 'translateX(-50%) translateY(8px)';
        }, 5000);
    }
    
    // ════════════════════════════════════════════════════════
    // CSS
    // ════════════════════════════════════════════════════════
    
    function injectCSS() {
        if (document.getElementById('bt-css')) return;
        const s = document.createElement('style');
        s.id = 'bt-css';
        s.textContent = `
    /* Nav button */
    #bt-nav-btn { font-size:12px; padding:3px 10px; margin-right:6px; transition:background .15s; }
    #bt-nav-btn.nav-btn-active { background:#f5a62333; color:#f5a623; }
    
    /* Bar управления */
    #bt-bar {
        display:none;
        align-items:center;
        gap:6px;
        padding:4px 10px;
        background:#0f1117;
        border-bottom:2px solid #f5a62355;
        flex-shrink:0;
        font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        overflow:hidden;
    }
    .bt-lbl { font-size:12px; font-weight:700; color:#f5a623; white-space:nowrap; flex-shrink:0; }
    
    /* Date input */
    #bt-date {
        background:#1a1d27; border:1px solid #2a2e39; border-radius:3px;
        color:#d1d4dc; font-size:12px; padding:2px 6px; cursor:pointer;
        flex-shrink:0;
    }
    #bt-date:focus   { outline:none; border-color:#f5a623; }
    #bt-date:disabled { opacity:.45; cursor:not-allowed; }
    
    /* Buttons */
    .bt-btn {
        display:inline-flex; align-items:center;
        padding:3px 10px;
        background:#2a2e39; border:1px solid #363a45;
        border-radius:3px; color:#9598a1;
        font-size:12px; font-weight:500;
        cursor:pointer; white-space:nowrap; flex-shrink:0;
    }
    .bt-btn:hover { background:#363a45; color:#d1d4dc; }
    .bt-green { background:#162b18; border-color:#4caf50; color:#4caf50; }
    .bt-green:hover { background:#1e3d20; }
    .bt-red   { background:#2b1616; border-color:#ef5350; color:#ef5350; }
    .bt-red:hover { background:#3d1e1e; }
    
    /* Control buttons */
    #bt-ctrls {
        display:flex; align-items:center; gap:3px;
        border-left:1px solid #2a2e39;
        margin-left:4px; padding-left:8px;
    }
    .bt-ctrl {
        min-width:28px; text-align:center;
        padding:3px 5px;
        background:#1a1d27; border:1px solid #2a2e39; border-radius:3px;
        color:#9598a1; font-size:13px; cursor:pointer;
        transition:background .12s;
    }
    .bt-ctrl:hover { background:#252836; color:#d1d4dc; }
    
    /* Speed select */
    #bt-spd {
        background:#1a1d27; border:1px solid #2a2e39; border-radius:3px;
        color:#9598a1; font-size:12px; padding:2px 4px;
        cursor:pointer; margin-left:2px;
    }
    
    /* Progress */
    #bt-prog {
        font-size:11px; color:#f5a623;
        font-variant-numeric:tabular-nums; white-space:nowrap;
        margin-left:6px; font-family:monospace;
        flex:1;
    }
    
    /* Рамка на графике во время replay */
    #tv_chart_container.bt-border {
        outline:2px solid #f5a62344;
        outline-offset:-2px;
    }
    
    /* Светлая тема */
    body.light-theme #bt-bar    { background:#f8f9fd; border-bottom-color:#f5a62366; }
    body.light-theme #bt-date   { background:#fff; border-color:#d0d3db; color:#131722; }
    body.light-theme .bt-btn    { background:#f0f3fa; border-color:#d0d3db; color:#555; }
    body.light-theme .bt-ctrl   { background:#f0f3fa; border-color:#d0d3db; color:#555; }
    body.light-theme #bt-spd    { background:#f0f3fa; border-color:#d0d3db; color:#555; }
    body.light-theme #bt-ctrls  { border-left-color:#d0d3db; }
        `;
        document.head.appendChild(s);
    }
    
    // ════════════════════════════════════════════════════════
    // ТАКЖЕ: прокидываем datafeed в window.app для доступа к subscribers
    // Патч применяется к DatabaseIntegratedDatafeed после его создания
    // ════════════════════════════════════════════════════════
    
    function patchDatafeedAccess() {
        // Ждём пока datafeed будет создан и прокинут в window.app
        // В app.js должна быть строка: window.app.datafeed = datafeed;
        // Если её нет — добавим патч здесь
        const orig = window.DatabaseIntegratedDatafeed;
        if (!orig) return false;
    
        const OrigProto = orig.prototype;
        const origInit = OrigProto.initialize;
        if (!origInit || OrigProto._btPatched) return true;
        OrigProto._btPatched = true;
    
        OrigProto.initialize = async function(...args) {
            const result = await origInit.apply(this, args);
            // Прокидываем себя в window.app.datafeed
            if (!window.app) window.app = {};
            window.app.datafeed = this;
            console.log('[backtest] datafeed accessible at window.app.datafeed');
            return result;
        };
    
        return true;
    }
    
    // ════════════════════════════════════════════════════════
    // СТАРТ
    // ════════════════════════════════════════════════════════
    
    function start() {
        // Патч datafeed до создания экземпляра
        patchDatafeedAccess();
    
        // Строим UI когда navbar появится
        let n = 0;
        const t = setInterval(() => {
            if (++n > 150) clearInterval(t);
            if (document.querySelector('.navbar-right')) {
                clearInterval(t);
                buildUI();
            }
        }, 200);
    }
    
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
    
    // Public API
    window.backtestPlayer = {
        start: startReplay, exit: exitReplay,
        play, pause, next: stepNext, prev: stepPrev,
        state: BT,
    };
    
    })(); }