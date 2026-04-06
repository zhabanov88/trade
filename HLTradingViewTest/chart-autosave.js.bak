/**
 * chart-autosave.js  v2
 *
 * 1. Автосохранение — всегда в ТЕКУЩИЙ активный layout (не создаёт новых)
 * 2. Отображает имя активного layout рядом с кнопкой Save в TV header
 * 3. Кнопка Save патчится — при клике обновляет текущий layout, а не создаёт новый
 *
 * Подключение в index.html ПОСЛЕ app.js:
 *   <script src="chart-autosave.js"></script>
 */

(function () {
    'use strict';

    const LS_SESSION   = 'tv_session';
    const LS_FALLBACK  = 'tv_autosave_data';
    const DEBOUNCE_MS  = 5000;   // увеличен для снижения нагрузки
    const HEARTBEAT_S  = 60;    // heartbeat раз в минуту

    let _widget    = null;
    let _debTimer  = null;
    let _heartbeat = null;
    let _isSaving  = false;
    let _nameEl    = null;

    // ════════════════════════════════════════════════════════════════
    // СЕССИЯ
    // ════════════════════════════════════════════════════════════════

    function _readSession() {
        try { return JSON.parse(localStorage.getItem(LS_SESSION) || 'null') || {}; }
        catch (_) { return {}; }
    }
    function _writeSession(patch) {
        try {
            const cur = _readSession();
            localStorage.setItem(LS_SESSION, JSON.stringify({ ...cur, ...patch }));
        } catch (_) {}
    }
    function _getActiveLayoutId()   { return _readSession().layoutId   || null; }
    function _getActiveLayoutName() { return _readSession().layoutName || null; }

    // ════════════════════════════════════════════════════════════════
    // СОХРАНЕНИЕ
    // ════════════════════════════════════════════════════════════════

    function _scheduleSave(reason) {
        if (_debTimer) clearTimeout(_debTimer);
        _debTimer = setTimeout(() => { _debTimer = null; _save(reason); }, DEBOUNCE_MS);
    }

    // Cooldown — не сохраняем чаще раза в 10 секунд
    let _lastSaveAt = 0;
    const SAVE_COOLDOWN_MS = 10000;

    // Сжимает строку убирая лишние данные источников (sources) из layout_data
    function _compressLayoutData(data) {
        if (!data || typeof data !== 'object') return data;
        try {
            const compressed = JSON.parse(JSON.stringify(data));
            // Удаляем charts[].panes[].sources[].state.data (тяжёлые данные баров)
            if (Array.isArray(compressed.charts)) {
                compressed.charts.forEach(chart => {
                    if (!Array.isArray(chart.panes)) return;
                    chart.panes.forEach(pane => {
                        if (!Array.isArray(pane.sources)) return;
                        pane.sources.forEach(source => {
                            // Убираем кэшированные данные, оставляем только метаданные
                            if (source.state) {
                                delete source.state.data;
                                delete source.state.metaInfo;
                                delete source.state.loadedFrom;
                                delete source.state.loadedTo;
                            }
                        });
                    });
                });
            }
            return compressed;
        } catch (_) { return data; }
    }

    async function _save(reason) {
        if (_isSaving || !_widget) return;

        // Cooldown — не сохраняем чаще SAVE_COOLDOWN_MS
        const now = Date.now();
        if (now - _lastSaveAt < SAVE_COOLDOWN_MS && reason !== 'manual') {
            // Перепланируем через оставшееся время
            if (!_debTimer) {
                const remaining = SAVE_COOLDOWN_MS - (now - _lastSaveAt);
                _debTimer = setTimeout(() => { _debTimer = null; _save(reason); }, remaining);
            }
            return;
        }
        _isSaving = true;
        _lastSaveAt = Date.now();
        try {
            const layoutData = await new Promise((resolve, reject) => {
                try { _widget.save(d => resolve(d)); }
                catch (e) { reject(e); }
            });
            if (!layoutData) return;

            const chart    = _widget.activeChart();
            const symbol   = chart.symbol();
            const interval = chart.resolution();
            const layoutId   = _getActiveLayoutId();
            const layoutName = _getActiveLayoutName();

            if (layoutId) {
                // Обновляем существующий layout
                const compressedData = _compressLayoutData(layoutData);
                try {
                    await apiClient.updateLayout(parseInt(layoutId), {
                        layout_data: compressedData,
                        symbol,
                        interval,
                    });
                    _writeSession({ symbol, interval });
                    console.log(`[Autosave] ✅ "${layoutName}" (id=${layoutId}) — ${reason}`);
                } catch (e) {
                    console.warn('[Autosave] Server save failed → localStorage:', e.message);
                    _saveFallback(layoutData);
                }
            } else {
                _saveFallback(layoutData);
                console.log(`[Autosave] 📦 No active layout → localStorage (${reason})`);
            }
        } catch (e) {
            console.error('[Autosave] Save error:', e);
        } finally {
            _isSaving = false;
        }
    }

    function _saveFallback(data) {
        try { localStorage.setItem(LS_FALLBACK, JSON.stringify({ layoutData: data, savedAt: Date.now() })); }
        catch (_) {}
    }

    // ════════════════════════════════════════════════════════════════
    // ВОССТАНОВЛЕНИЕ
    // ════════════════════════════════════════════════════════════════

    async function _restore() {
        if (!_widget) return;
        const layoutId = _getActiveLayoutId();

        if (layoutId) {
            try {
                const adapter = _widget._options?.save_load_adapter || _widget.options?.save_load_adapter;
                if (adapter?.getChartContent) {
                    const content = await adapter.getChartContent(String(layoutId));
                    if (content) {
                        const data = typeof content === 'string' ? JSON.parse(content) : content;
                        _widget.load(data);
                        console.log(`[Autosave] ✅ Restored "${_getActiveLayoutName()}" from server`);
                        return;
                    }
                }
            } catch (e) {
                console.warn('[Autosave] Server restore failed:', e.message);
            }
        }

        // Fallback localStorage
        try {
            const raw = localStorage.getItem(LS_FALLBACK);
            if (raw) {
                const { layoutData, savedAt } = JSON.parse(raw);
                if (layoutData) {
                    _widget.load(layoutData);
                    console.log(`[Autosave] ✅ Restored from localStorage (${Math.round((Date.now()-savedAt)/1000)}s ago)`);
                }
            }
        } catch (e) {
            console.warn('[Autosave] localStorage restore failed:', e.message);
        }
    }

    // ════════════════════════════════════════════════════════════════
    // BADGE С ИМЕНЕМ LAYOUT РЯДОМ С КНОПКОЙ SAVE
    // ════════════════════════════════════════════════════════════════

    /** Получаем document внутри TV iframe */
    function _getTVDoc() {
        // TV рисует UI в iframe — перебираем все iframes
        const iframes = document.querySelectorAll('iframe');
        for (const f of iframes) {
            try {
                const doc = f.contentDocument || f.contentWindow?.document;
                if (doc && doc.getElementById('header-toolbar-save-load')) return doc;
            } catch (_) {}
        }
        // Fallback — вдруг рендерит прямо в document
        if (document.getElementById('header-toolbar-save-load')) return document;
        return null;
    }

    function _injectLayoutName() {
        const doc = _getTVDoc();
        if (!doc) return; // iframe ещё не готов

        // Не дублируем
        if (doc.getElementById('lm-layout-name-badge')) return;

        // Контейнер кнопки Save — #header-toolbar-save-load
        const saveContainer = doc.getElementById('header-toolbar-save-load');
        if (!saveContainer) return;

        // Создаём badge
        const badge = doc.createElement('span');
        badge.id = 'lm-layout-name-badge';
        badge.style.cssText = `
            display:inline-flex; align-items:center;
            margin-left:6px; padding:1px 8px;
            background:rgba(41,98,255,0.13);
            border:1px solid rgba(41,98,255,0.4);
            border-radius:3px;
            font-size:11px; font-weight:500; color:#5c9bff;
            max-width:160px; overflow:hidden;
            text-overflow:ellipsis; white-space:nowrap;
            cursor:default; vertical-align:middle;
            line-height:18px;
        `;

        const name = _getActiveLayoutName();
        badge.textContent = name || '—';
        badge.title = name ? `Active: ${name}` : 'No layout selected';

        // Вставляем внутрь контейнера после последнего дочернего элемента
        saveContainer.appendChild(badge);
        _nameEl = badge;
        console.log('[Autosave] ✅ Badge injected into #header-toolbar-save-load:', name || '—');
    }

    function _updateBadge() {
        const name = _getActiveLayoutName();
        // Ищем badge в TV doc (iframe мог перерисовать шапку)
        const doc = _getTVDoc();
        const existing = doc?.getElementById('lm-layout-name-badge');
        if (existing) {
            _nameEl = existing;
            existing.textContent = name || '\u2014';
            existing.title = name ? `Active: ${name}` : 'No layout selected';
        } else {
            _nameEl = null;
            _injectLayoutName();
        }
    }

    // ════════════════════════════════════════════════════════════════
    // ПАТЧ save_load_adapter — Save в текущий, не создаём новый
    // ════════════════════════════════════════════════════════════════

    function _patchAdapter(widget) {
        const adapter = widget._options?.save_load_adapter || widget.options?.save_load_adapter;
        if (!adapter || adapter._autosavePatchedV2) return;

        // saveChart — нажата кнопка Save
        const _origSave = adapter.saveChart.bind(adapter);
        adapter.saveChart = async function (chartData) {
            const currentId   = _getActiveLayoutId();
            const currentName = _getActiveLayoutName();

            // Если есть активный layout — обновляем его
            if (currentId) {
                try {
                    let content = chartData.content;
                    if (typeof content === 'string') {
                        try { content = JSON.parse(content); } catch (_) {}
                    }
                    await apiClient.updateLayout(parseInt(currentId), {
                        layout_data: content,
                        symbol:      chartData.symbol,
                        interval:    chartData.resolution,
                        name:        currentName, // имя не меняем
                    });
                    _writeSession({ symbol: chartData.symbol, interval: chartData.resolution });
                    console.log(`[Autosave] 💾 Saved → "${currentName}" (id=${currentId})`);
                    _updateBadge();
                    return currentId.toString();
                } catch (e) {
                    console.warn('[Autosave] Update failed, creating new:', e.message);
                }
            }

            // Нет активного или ошибка → создаём новый
            const newId = await _origSave(chartData);
            _writeSession({ layoutId: newId, layoutName: chartData.name, symbol: chartData.symbol, interval: chartData.resolution });
            _updateBadge();
            console.log(`[Autosave] 💾 New layout created: "${chartData.name}" (id=${newId})`);
            return newId;
        };

        // getChartContent — пользователь открыл layout из списка
        const _origGet = adapter.getChartContent.bind(adapter);
        adapter.getChartContent = async function (id) {
            const content = await _origGet(id);
            try {
                const all   = await adapter.getAllCharts();
                const found = all.find(c => String(c.id) === String(id));
                if (found) {
                    _writeSession({ layoutId: id, layoutName: found.name, symbol: found.symbol, interval: found.resolution });
                    _updateBadge();
                    console.log(`[Autosave] 📂 Loaded: "${found.name}" (id=${id})`);
                } else {
                    // id есть но не нашли в списке — сохраняем хотя бы id
                    _writeSession({ layoutId: id });
                    // Попробуем получить имя позже
                    setTimeout(() => _syncLayoutNameFromServer(id, adapter), 500);
                }
            } catch (_) {}
            return content;
        };

        // Перехватываем loadChartFromServer если TV использует его вместо getChartContent
        const _origLoadFromServer = widget.loadChartFromServer?.bind(widget);
        if (_origLoadFromServer) {
            widget.loadChartFromServer = function (params) {
                const id = params?.id || params;
                if (id) {
                    setTimeout(() => _syncLayoutNameFromServer(String(id), adapter), 300);
                }
                return _origLoadFromServer(params);
            };
        }

        adapter._autosavePatchedV2 = true;
        console.log('[Autosave] ✅ save_load_adapter patched');
    }

    /**
     * Читает имя текущего layout прямо из DOM TradingView iframe.
     * TV показывает имя активного layout в заголовке меню Save.
     * Если имя изменилось — обновляем сессию и badge.
     */
    function _detectLayoutChangeFromDOM() {
        try {
            const doc = _getTVDoc();
            if (!doc) return;

            // TV показывает имя текущего layout в кнопке Save
            // Ищем текстовый узел внутри #header-toolbar-save-load
            const saveContainer = doc.getElementById('header-toolbar-save-load');
            if (!saveContainer) return;

            // Ищем span или button с текстом — это и есть имя layout
            // TV рендерит имя layout как текст рядом с иконкой Save
            let tvLayoutName = null;

            // Способ 1: data-name="save-button" содержит текст
            const saveBtn = saveContainer.querySelector('[data-name="save-button"]')
                         || saveContainer.querySelector('button');
            if (saveBtn) {
                // Ищем текстовый узел (не иконку)
                const textNodes = [...saveBtn.childNodes].filter(n =>
                    n.nodeType === 3 && n.textContent.trim()
                );
                if (textNodes.length) {
                    tvLayoutName = textNodes[0].textContent.trim();
                } else {
                    // Ищем span с текстом
                    const spans = saveBtn.querySelectorAll('span');
                    for (const s of spans) {
                        const t = s.textContent.trim();
                        if (t && t !== 'Save' && t.length > 0) {
                            tvLayoutName = t;
                            break;
                        }
                    }
                }
            }

            // Способ 2: ищем элемент с классом содержащим "title" или "name"
            if (!tvLayoutName) {
                const titleEl = saveContainer.querySelector('[class*="title"], [class*="name"], [class*="label"]');
                if (titleEl) tvLayoutName = titleEl.textContent.trim();
            }

            if (!tvLayoutName || tvLayoutName === 'Save') return;

            // Если имя изменилось относительно сохранённого в сессии
            const currentName = _getActiveLayoutName();
            if (tvLayoutName !== currentName && tvLayoutName !== '—') {
                console.log(`[Autosave] 🔄 Layout name changed in TV DOM: "${currentName}" → "${tvLayoutName}"`);
                // Ищем layout с таким именем на сервере
                _resolveLayoutByName(tvLayoutName);
            }
        } catch (_) {}
    }

    /** Находит layout по имени и обновляет сессию + badge */
    async function _resolveLayoutByName(name) {
        try {
            const adapter = _widget?._options?.save_load_adapter || _widget?.options?.save_load_adapter;
            if (!adapter?.getAllCharts) return;
            const all = await adapter.getAllCharts();
            const found = all.find(c => c.name === name);
            if (found) {
                _writeSession({ layoutId: found.id, layoutName: found.name });
                _updateBadge();
                console.log(`[Autosave] ✅ Active layout resolved: "${found.name}" (id=${found.id})`);
            }
        } catch (_) {}
    }

    /** Получает имя layout с сервера и обновляет badge */
    async function _syncLayoutNameFromServer(id, adapter) {
        try {
            const all   = adapter?.getAllCharts ? await adapter.getAllCharts() : [];
            const found = all.find(c => String(c.id) === String(id));
            if (found) {
                _writeSession({ layoutId: id, layoutName: found.name, symbol: found.symbol, interval: found.resolution });
                _updateBadge();
                console.log(`[Autosave] 🔄 Name synced: "${found.name}" (id=${id})`);
            }
        } catch (_) {}
    }

    // ════════════════════════════════════════════════════════════════
    // ПАТЧ chart — отслеживаем добавление/удаление индикаторов
    // ════════════════════════════════════════════════════════════════

    function _patchChart(chart) {
        if (chart._autosavePatched) return;

        // НЕ патчим createStudy/removeEntity — они вызываются слишком часто
        // (FVG перерисовывает десятки shapes → спам сохранений)
        // Сохранение происходит по heartbeat и при смене символа/интервала

        chart._autosavePatched = true;
        console.log('[Autosave] ✅ chart patched (study hooks disabled to prevent spam)');
    }

    // ════════════════════════════════════════════════════════════════
    // СТАРТ
    // ════════════════════════════════════════════════════════════════

    function _subscribe(widget) {
        _widget = widget;
        widget.onChartReady(() => {
            const chart = widget.activeChart();

            chart.onSymbolChanged().subscribe(null, () => _scheduleSave('symbol_changed'));
            chart.onIntervalChanged().subscribe(null, () => _scheduleSave('interval_changed'));

            _patchChart(chart);
            _patchAdapter(widget);

            // Подписываемся на смену layout через TV API (если доступно)
            // TV иногда предоставляет chart.onChartLoaded — используем его
            try {
                if (typeof widget.subscribe === 'function') {
                    widget.subscribe('onAutoSaveNeeded', () => _scheduleSave('tv_autosave'));
                }
            } catch (_) {}

            // Polling — проверяем каждые 2с не поменялся ли layout в TV
            // TV хранит имя текущего layout в DOM внутри iframe
            setInterval(() => _detectLayoutChangeFromDOM(), 2000);

            // Heartbeat
            if (_heartbeat) clearInterval(_heartbeat);
            _heartbeat = setInterval(() => _save('heartbeat'), HEARTBEAT_S * 1000);

            // Badge — несколько попыток (TV iframe рендерится асинхронно)
            [1000, 2500, 5000, 8000, 15000].forEach(t => setTimeout(_injectLayoutName, t));

            // MutationObserver — следим за основным doc и за TV iframe
            const _observeDoc = (doc) => {
                if (!doc || doc._autosaveObserved) return;
                doc._autosaveObserved = true;
                new MutationObserver(() => {
                    const tvDoc = _getTVDoc() || doc;
                    if (!tvDoc.getElementById('lm-layout-name-badge')) {
                        _injectLayoutName();
                    }
                }).observe(doc.body || doc.documentElement, { childList: true, subtree: false });
            };

            _observeDoc(document);

            // Когда iframe загрузится — вешаем observer и на него
            document.querySelectorAll('iframe').forEach(f => {
                const attachToIframe = () => {
                    try {
                        const iDoc = f.contentDocument || f.contentWindow?.document;
                        if (iDoc) _observeDoc(iDoc);
                    } catch (_) {}
                };
                f.addEventListener('load', attachToIframe);
                attachToIframe();
            });

            // Восстановление
            setTimeout(_restore, 800);

            console.log('[Autosave] ✅ Ready | Active layout:', _getActiveLayoutName() || 'none');
        });
    }

    // ════════════════════════════════════════════════════════════════
    // ПУБЛИЧНЫЙ API
    // ════════════════════════════════════════════════════════════════
    window.chartAutosave = {
        save:    () => _save('manual'),
        restore: () => _restore(),
        getActive: () => ({ id: _getActiveLayoutId(), name: _getActiveLayoutName() }),
        setActive: (id, name) => { _writeSession({ layoutId: id, layoutName: name }); _updateBadge(); },
        clear:   () => { localStorage.removeItem(LS_FALLBACK); console.log('[Autosave] Fallback cleared'); },
    };

    // Ждём widget
    let _n = 0;
    const _poll = setInterval(() => {
        const w = window.app?.widget;
        if (w && !_widget) { clearInterval(_poll); _subscribe(w); }
        else if (++_n > 150) { clearInterval(_poll); console.warn('[Autosave] Widget not found'); }
    }, 100);

    console.log('[Autosave] 📦 chart-autosave.js v2 loaded');
})();