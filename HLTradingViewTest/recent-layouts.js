

if (window._rlLoaded) { /* skip */ } else {
    window._rlLoaded = true;
    

        // ── localStorage ─────────────────────────────────────────────────────
    
        function readSession() {
            try { return JSON.parse(localStorage.getItem(LS_SESSION) || 'null'); } catch(_) { return null; }
        }
        function writeSession(patch) {
            try {
                const cur = readSession() || {};
                localStorage.setItem(LS_SESSION, JSON.stringify({ ...cur, ...patch }));
            } catch(_) {}
        }
        function readRecent() {
            try { return JSON.parse(localStorage.getItem(LS_RECENT) || '[]'); } catch(_) { return []; }
        }
        function pushRecent(item) {
            try {
                let list = readRecent().filter(r => String(r.id) !== String(item.id));
                list.unshift({ ...item, usedAt: Date.now() });
                localStorage.setItem(LS_RECENT, JSON.stringify(list.slice(0, 5)));
                console.log('[rl] saved recent:', item.name);
            } catch(_) {}
        }
    
        // ── Ждём виджет ───────────────────────────────────────────────────────
    
        function waitWidget(cb) {
            let n = 0;
            const t = setInterval(() => {
                if (window.app?.widget) { clearInterval(t); cb(window.app.widget); }
                if (++n > 300) clearInterval(t);
            }, 100);
        }
    
        // ── Задача 1: перехват save_load_adapter ──────────────────────────────
    
        function patchAdapter(widget) {
            const a = widget._options?.save_load_adapter || widget.options?.save_load_adapter;
            if (!a || a._rlDone) return;
            a._rlDone = true;
    
            // saveChart — пользователь нажал "Save layout"
            const _save = a.saveChart.bind(a);
            a.saveChart = async function(d) {
                const id = await _save(d);
                writeSession({ layoutId: id, layoutName: d.name, symbol: d.symbol, interval: d.resolution });
                pushRecent({ id, name: d.name, symbol: d.symbol || '', interval: d.resolution || '' });
                return id;
            };
    
            // getChartContent — пользователь открыл layout через "Open layout..."
            const _get = a.getChartContent.bind(a);
            a.getChartContent = async function(id) {
                const content = await _get(id);
                try {
                    const all   = await a.getAllCharts();
                    const found = all.find(c => String(c.id) === String(id));
                    if (found) {
                        writeSession({ layoutId: id, layoutName: found.name, symbol: found.symbol, interval: found.resolution });
                        pushRecent({ id, name: found.name, symbol: found.symbol || '', interval: found.resolution || '' });
                    } else {
                        writeSession({ layoutId: id });
                    }
                } catch(_) { writeSession({ layoutId: id }); }
                return content;
            };
    
            console.log('[rl] adapter patched');
        }
    
        // ── Задача 1: подписка на символ / интервал ───────────────────────────
    
        function subscribeChanges(widget) {
            widget.onChartReady(() => {
                const chart = widget.activeChart();
                chart.onSymbolChanged().subscribe(null, () => {
                    try { writeSession({ symbol: chart.symbol(), interval: chart.resolution() }); } catch(_) {}
                });
                chart.onIntervalChanged().subscribe(null, iv => {
                    try { writeSession({ symbol: chart.symbol(), interval: iv }); } catch(_) {}
                });
                try { writeSession({ symbol: chart.symbol(), interval: chart.resolution() }); } catch(_) {}
    
                patchAdapter(widget);
    
                // Восстанавливаем layout после F5
                const sess = readSession();
                if (sess?.layoutId) {
                    console.log('[rl] restoring layout id=', sess.layoutId);
                    try { widget.loadChartFromServer?.({ id: String(sess.layoutId) }); } catch(_) {}
                }
    
                console.log('[rl] subscribed to changes');
            });
        }
    
        // ── Задача 2: вставка recent layouts в стандартное TV меню ───────────
        //
        // Ищем [data-name="save-load-menu-item-load"] и после него вставляем пункты.
        // MutationObserver запускает проверку при каждом изменении DOM.
        // ─────────────────────────────────────────────────────────────────────
    
        function injectRecentItems() {
            console.log("START___ADD___LAYOUT injectRecentItems")
            // Находим "Open layout..." по data-name
            const anchor = document.querySelector('[data-name="save-load-menu-item-load"]');
            if (!anchor) return;
    
            // Если уже вставляли в этот инстанс меню — не дублируем
            if (anchor.parentElement?.querySelector('[data-rl-injected]')) return;
    
            const recent = readRecent();
            if (recent.length === 0) return;
    
            const session = readSession();
            const parent  = anchor.parentElement;
    
            // Позиция для вставки — сразу после anchor
            let insertRef = anchor.nextSibling;
    
            // Разделитель — копируем стиль у существующих разделителей в меню
            const existingDivider = parent.querySelector('[class*="separator"], [class*="Separator"]');
            const divider = document.createElement('div');
            divider.dataset.rlInjected = 'sep';
            if (existingDivider) {
                divider.className = existingDivider.className;
            } else {
                divider.style.cssText = 'height:1px; background:rgba(255,255,255,.08); margin:4px 0;';
            }
            parent.insertBefore(divider, insertRef);
            insertRef = divider.nextSibling;
    
            // Пункты recent layouts — копируем className с anchor для нативного вида
            recent.forEach(item => {
                const isActive = String(session?.layoutId) === String(item.id);
                const meta     = [item.symbol, item.interval ? item.interval : '']
                                  .filter(Boolean).join(' · ');
    
                const el = document.createElement('div');
                el.dataset.rlInjected = String(item.id);
                el.className = anchor.className; // нативные TV классы
    
                // Внутренняя структура — смотрим что внутри anchor и копируем паттерн
                // anchor содержит иконку + текст, делаем то же самое
                const innerWrap = anchor.firstElementChild;
                if (innerWrap) {
                    // Копируем wrapper div
                    const wrap = document.createElement('div');
                    wrap.className = innerWrap.className;
                    wrap.style.cssText = 'display:flex; align-items:center; gap:6px; width:100%; overflow:hidden;';
    
                    wrap.innerHTML = `
                        <span style="font-size:13px; flex-shrink:0; opacity:.65">🕒</span>
                        <span style="flex:1; min-width:0; overflow:hidden;">
                            <span style="display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
                                         ${isActive ? 'color:#2962FF; font-weight:600;' : ''}">
                                ${esc(item.name)}
                            </span>
                            ${meta ? `<span style="display:block; font-size:11px; opacity:.45; margin-top:1px;">${esc(meta)}</span>` : ''}
                        </span>`;
                    el.appendChild(wrap);
                } else {
                    // Fallback если структура другая
                    el.style.cssText = 'display:flex; align-items:center; gap:6px; cursor:pointer; padding:6px 12px;';
                    el.innerHTML = `
                        <span style="opacity:.65">🕒</span>
                        <span style="${isActive ? 'color:#2962FF;font-weight:600;' : ''}">${esc(item.name)}</span>
                        ${meta ? `<span style="font-size:11px;opacity:.45;margin-left:auto;">${esc(meta)}</span>` : ''}`;
                }
    
                el.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // Закрываем меню
                    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                    // Загружаем layout
                    loadById(item.id);
                });
    
                parent.insertBefore(el, insertRef);
                insertRef = el.nextSibling;
            });
    
            console.log('[rl] injected', recent.length, 'recent items into TV menu');
        }
    
        // ── Загрузка layout по ID ─────────────────────────────────────────────
    
        async function loadById(id) {
            console.log('[rl] loadById:', id);
            try {
                const w = window.app?.widget;
                if (!w) return;
                if (typeof w.loadChartFromServer === 'function') {
                    w.loadChartFromServer({ id: String(id) });
                } else {
                    const a = w._options?.save_load_adapter || w.options?.save_load_adapter;
                    if (a) {
                        const content = await a.getChartContent(String(id));
                        if (content && typeof w.load === 'function') w.load(content);
                    }
                }
            } catch(err) {
                console.error('[rl] loadById error:', err);
            }
        }
    
        // ── MutationObserver — следим за появлением TV меню в DOM ────────────
    
        function startObserver() {
            const observer = new MutationObserver(() => {
                // Вызываем injectRecentItems при каждом изменении DOM
                // Функция сама проверяет наличие anchor и дубликатов
                injectRecentItems();
            });
            observer.observe(document.body, { childList: true, subtree: true });
            console.log('[rl] observer started');
        }
    
        // ── Helpers ───────────────────────────────────────────────────────────
    
        function esc(s) {
            return String(s || '').replace(/[&<>"']/g, c =>
                ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        }
    (function () {
        'use strict';
    
        const LS_SESSION = 'tv_session';
        const LS_RECENT  = 'tv_recent_layouts';
    
    
        // ── Старт ─────────────────────────────────────────────────────────────
    
        function start() {
            console.log("START___ADD___LAYOUT")
            waitWidget(widget => {
                console.log("START___ADD___LAYOUT waitWidget")
                subscribeChanges(widget);
                //startObserver();
            });
        }
    
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start);
        } else {
            start();
        }
    
        // Для отладки в консоли
        window.rlDebug = { readRecent, readSession, pushRecent, loadById };
    
    })();
    }