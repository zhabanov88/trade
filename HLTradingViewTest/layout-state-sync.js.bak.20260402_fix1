
(function () {
    'use strict';

    const LS_ACTIVEDATA = 'tv_activedata_cache';
    const LS_DT_COLUMNS = 'dt_columns_cache';
    const LS_DT_META    = 'dt_meta_cache';

    // ─────────────────────────────────────────────────────────────────────────
    // УТИЛИТЫ
    // ─────────────────────────────────────────────────────────────────────────

    function lsGet(key) {
        try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : null; }
        catch (_) { return null; }
    }
    function lsSet(key, val) {
        try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {}
    }

    // ─────────────────────────────────────────────────────────────────────────
    // МЕТА-СОСТОЯНИЕ DATA-TABLE
    // data-table хранит S внутри IIFE, не экспортируя sortKey и т.д.
    // Мы перехватываем события DOM чтобы сохранять их самостоятельно.
    // ─────────────────────────────────────────────────────────────────────────

    const _dtMeta = lsGet(LS_DT_META) || {
        sortKey: 'timestamp', sortDir: 'desc',
        groupKey: null,
        filters: {},
        panelH: 220,
    };

    function saveDtMeta(patch) {
        Object.assign(_dtMeta, patch);
        lsSet(LS_DT_META, _dtMeta);
    }

    function patchDataTable() {
        if (!window.dataTable) return;
        if (window.dataTable._stateSyncDone) return;
        window.dataTable._stateSyncDone = true;

        // Обёртка refresh — после каждого рендера сохраняем колонки
        const _origRefresh = window.dataTable.refresh;
        window.dataTable.refresh = function () {
            const r = _origRefresh?.apply(this, arguments);
            _autosaveColumns();
            return r;
        };

        _watchPanel();
        console.log('[StateSync] data-table patched');
    }

    function _autosaveColumns() {
        try {
            const cols = window.dataTable.getColumns();
            if (!cols?.length) return;
            lsSet(LS_DT_COLUMNS, cols.map(c => ({
                key: c.key, label: c.label, visible: c.visible,
                width: c.width, type: c.type,
            })));
        } catch (_) {}
    }

    function _watchPanel() {
        const panel = document.getElementById('dt-panel');
        if (!panel) return;

        // Высота панели
        new ResizeObserver(() => {
            const h = panel.offsetHeight;
            if (h > 0) saveDtMeta({ panelH: h });
        }).observe(panel);

        // Сортировка — клик по th
        panel.addEventListener('click', e => {
            const th = e.target.closest('th[data-key]');
            if (!th) return;
            setTimeout(() => {
                const sorted = panel.querySelector('th[data-key].dt-sort-asc, th[data-key].dt-sort-desc');
                if (sorted) {
                    saveDtMeta({
                        sortKey: sorted.dataset.key,
                        sortDir: sorted.classList.contains('dt-sort-asc') ? 'asc' : 'desc',
                    });
                }
            }, 50);
        });

        // Фильтры
        panel.addEventListener('input', e => {
            if (e.target.matches('.dt-filt')) {
                const key = e.target.dataset.key;
                if (!key) return;
                const f = _dtMeta.filters || {};
                if (e.target.value) f[key] = { raw: e.target.value };
                else delete f[key];
                saveDtMeta({ filters: f });
            }
        });

        // Группировка
        const toolbar = document.getElementById('dt-toolbar');
        if (toolbar) {
            new MutationObserver(() => {
                const btn = panel.querySelector('#dt-btn-grp');
                if (!btn) return;
                const m = btn.textContent.match(/:\s*(.+)/);
                saveDtMeta({ groupKey: m ? m[1].trim() : null });
            }).observe(toolbar, { childList: true, subtree: true, characterData: true });
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // СБОР ПОЛНОГО СОСТОЯНИЯ
    // ─────────────────────────────────────────────────────────────────────────

    function collectAppState() {
        const state = {};

        // 1. Data-table
        try {
            const cols = window.dataTable?.getColumns?.();
            state.table = {
                columns: cols
                    ? cols.map(c => ({ key: c.key, label: c.label, visible: c.visible, width: c.width, type: c.type }))
                    : (lsGet(LS_DT_COLUMNS) || []),
                ..._dtMeta,
            };
        } catch (_) {
            state.table = { columns: lsGet(LS_DT_COLUMNS) || [], ..._dtMeta };
        }

        // 2. Backtest config
        const sbCfg = lsGet('sb_bt_cfg');
        if (sbCfg) state.backtestCfg = sbCfg;

        // 3. Зарегистрированные сетапы
        try {
            if (window.app?.setups && Object.keys(window.app.setups).length > 0) {
                state.setups = JSON.parse(JSON.stringify(window.app.setups));
            }
        } catch (_) {}

        // 4. activedata
        try {
            const ad = window.app?.activedata;
            if (Array.isArray(ad) && ad.length > 0) state.activedata = ad;
        } catch (_) {}

        return state;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ВОССТАНОВЛЕНИЕ СОСТОЯНИЯ
    // ─────────────────────────────────────────────────────────────────────────

    function applyAppState(appState) {
        if (!appState) return;
        console.log('[StateSync] Restoring app state, keys:', Object.keys(appState));

        // 1. activedata
        if (Array.isArray(appState.activedata) && appState.activedata.length > 0) {
            try {
                if (!window.app) window.app = {};
                window.app.activedata = appState.activedata;
                lsSet(LS_ACTIVEDATA, appState.activedata);
                setTimeout(() => {
                    window.dataTable?.refresh?.();
                    console.log('[StateSync] ✓ activedata:', appState.activedata.length, 'bars');
                }, 300);
            } catch (e) { console.warn('[StateSync] activedata err:', e); }
        }

        // 2. Setups
        if (appState.setups) {
            try {
                if (!window.app) window.app = {};
                window.app.setups = appState.setups;
                console.log('[StateSync] ✓ setups:', Object.keys(appState.setups));
            } catch (e) { console.warn('[StateSync] setups err:', e); }
        }

        // 3. Backtest config
        if (appState.backtestCfg) {
            try {
                lsSet('sb_bt_cfg', appState.backtestCfg);
                console.log('[StateSync] ✓ backtest cfg restored');
            } catch (e) { console.warn('[StateSync] bt cfg err:', e); }
        }

        // 4. Data-table
        if (appState.table) {
            try {
                if (appState.table.columns?.length) lsSet(LS_DT_COLUMNS, appState.table.columns);
                const { columns, ...meta } = appState.table;
                Object.assign(_dtMeta, meta);
                lsSet(LS_DT_META, _dtMeta);
                setTimeout(() => _applyTableStateNow(appState.table), 400);
            } catch (e) { console.warn('[StateSync] table err:', e); }
        }
    }

    function _applyTableStateNow(tableState) {
        if (!window.dataTable) return;

        // Колонки
        if (tableState.columns?.length) {
            try {
                const current = window.dataTable.getColumns();
                const saved   = tableState.columns;
                const curMap  = new Map(current.map(c => [c.key, c]));

                saved.forEach(sc => {
                    if (curMap.has(sc.key)) {
                        const c = curMap.get(sc.key);
                        c.visible = sc.visible;
                        c.label   = sc.label;
                        c.width   = sc.width;
                    } else {
                        window.dataTable.addColumn(sc.key, sc.label, sc.type || 'num');
                        const nc = current.find(c => c.key === sc.key);
                        if (nc) { nc.visible = sc.visible; nc.width = sc.width; }
                    }
                });

                // Восстанавливаем порядок
                const order = saved.map(sc => sc.key);
                current.sort((a, b) => {
                    const ai = order.indexOf(a.key);
                    const bi = order.indexOf(b.key);
                    if (ai === -1 && bi === -1) return 0;
                    if (ai === -1) return 1;
                    if (bi === -1) return -1;
                    return ai - bi;
                });

                window.dataTable.refresh();
                console.log('[StateSync] ✓ table columns applied');
            } catch (e) { console.warn('[StateSync] columns apply err:', e); }
        }

        // Высота панели
        if (tableState.panelH) {
            const panel = document.getElementById('dt-panel');
            if (panel) panel.style.height = tableState.panelH + 'px';
        }

        // Фильтры
        if (tableState.filters && Object.keys(tableState.filters).length > 0) {
            setTimeout(() => {
                Object.entries(tableState.filters).forEach(([key, f]) => {
                    const inp = document.querySelector(`.dt-filt[data-key="${key}"]`);
                    if (inp && f.raw) {
                        inp.value = f.raw;
                        inp.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                });
                console.log('[StateSync] ✓ filters applied');
            }, 200);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PATCH LAYOUT MANAGER
    // ─────────────────────────────────────────────────────────────────────────

    function patchLayoutManager(lm) {
        if (lm._stateSyncDone) return;
        lm._stateSyncDone = true;

        // saveLayout — после сохранения пушим appState на сервер
        const _origSave = lm.saveLayout.bind(lm);
        lm.saveLayout = async function (name, description = '', isDefault = false) {
            const result = await _origSave(name, description, isDefault);
            try {
                const appState = collectAppState();
                await _serverPatchAppState(result.id, appState);
                console.log('[StateSync] ✓ appState saved with layout:', name);
            } catch (e) {
                console.warn('[StateSync] server patch failed, using localStorage:', e.message);
                lsSet('tv_app_state_' + result.id, collectAppState());
            }
            return result;
        };

        // _loadLayoutById — после загрузки восстанавливаем appState
        const _origLoad = lm._loadLayoutById.bind(lm);
        lm._loadLayoutById = async function (id, updateRecent = true) {
            const layout = await _origLoad(id, updateRecent);
            try {
                applyAppState(_extractAppState(layout));
            } catch (e) { console.warn('[StateSync] applyAppState error:', e); }
            return layout;
        };

        // getCurrentLayoutData — встраиваем appState в данные TradingView
        const _origGetData = lm.getCurrentLayoutData.bind(lm);
        lm.getCurrentLayoutData = async function () {
            const chartData = await _origGetData();
            try {
                if (chartData && typeof chartData === 'object') {
                    chartData._appState = collectAppState();
                }
            } catch (_) {}
            return chartData;
        };

        console.log('[StateSync] ✓ layoutManager patched');
    }

    async function _serverPatchAppState(layoutId, appState) {
        const layout     = await apiClient.getLayout(layoutId);
        let   layoutData = layout.layout_data || {};
        if (typeof layoutData === 'string') {
            try { layoutData = JSON.parse(layoutData); } catch (_) { layoutData = {}; }
        }
        layoutData._appState = appState;
        await apiClient.updateLayout(layoutId, { layout_data: layoutData });
    }

    function _extractAppState(layout) {
        // Из layout_data
        try {
            let ld = layout.layout_data;
            if (typeof ld === 'string') ld = JSON.parse(ld);
            if (ld?._appState) {
                console.log('[StateSync] appState found in layout_data');
                return ld._appState;
            }
        } catch (_) {}

        // Fallback localStorage
        const cached = lsGet('tv_app_state_' + layout.id);
        if (cached) {
            console.log('[StateSync] appState found in localStorage fallback');
            return cached;
        }

        return null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ПРОКСИ НА window.app.activedata
    // Автоматически кэшируем activedata при каждом присваивании
    // ─────────────────────────────────────────────────────────────────────────

    function installActivedataProxy() {
        function tryProxy() {
            if (!window.app) return false;
            if (window.app._adProxied) return true;
            window.app._adProxied = true;

            let _ad = window.app.activedata || null;
            Object.defineProperty(window.app, 'activedata', {
                get()    { return _ad; },
                set(val) {
                    _ad = val;
                    if (Array.isArray(val) && val.length > 0) {
                        lsSet(LS_ACTIVEDATA, val);
                    }
                },
                configurable: true,
            });
            // Применяем текущее значение чтобы тригернуть сохранение
            if (_ad) window.app.activedata = _ad;

            console.log('[StateSync] ✓ activedata proxy installed');
            return true;
        }

        let n = 0;
        const t = setInterval(() => {
            if (++n > 200 || tryProxy()) clearInterval(t);
        }, 100);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ВОССТАНОВЛЕНИЕ activedata ПРИ СТАРТЕ (refresh страницы)
    // ─────────────────────────────────────────────────────────────────────────

    function restoreActivedataOnStart() {
        const cached = lsGet(LS_ACTIVEDATA);
        if (!cached?.length) return;

        let n = 0;
        const t = setInterval(() => {
            if (++n > 100) { clearInterval(t); return; }
            if (!window.app) return;
            if (!window.app.activedata?.length) {
                window.app.activedata = cached;
                clearInterval(t);
                setTimeout(() => {
                    window.dataTable?.refresh?.();
                    console.log('[StateSync] ✓ activedata from cache:', cached.length, 'bars');
                }, 300);
            } else {
                clearInterval(t); // уже заполнен
            }
        }, 200);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ПУБЛИЧНЫЙ API
    // ─────────────────────────────────────────────────────────────────────────

    window.layoutStateSync = {
        /** Показать текущее состояние (для отладки) */
        inspect() {
            const s = collectAppState();
            console.log('[StateSync] Current state:', s);
            return s;
        },
        /** Принудительно закэшировать activedata */
        cacheActivedata() {
            const ad = window.app?.activedata;
            if (Array.isArray(ad) && ad.length) {
                lsSet(LS_ACTIVEDATA, ad);
                console.log('[StateSync] activedata cached:', ad.length);
            }
        },
        /** Восстановить из кэша вручную */
        restoreFromCache() {
            const c = lsGet(LS_ACTIVEDATA);
            if (c?.length) {
                if (!window.app) window.app = {};
                window.app.activedata = c;
                window.dataTable?.refresh?.();
                console.log('[StateSync] Restored:', c.length, 'bars');
            }
        },
    };

    // ─────────────────────────────────────────────────────────────────────────
    // ИНИЦИАЛИЗАЦИЯ
    // ─────────────────────────────────────────────────────────────────────────

    function init() {
        // 1. Восстановить activedata при старте
        restoreActivedataOnStart();

        // 2. Установить прокси на activedata
        installActivedataProxy();

        // 3. Патч layoutManager
        let lmN = 0;
        const lmT = setInterval(() => {
            if (++lmN > 100) { clearInterval(lmT); return; }
            if (window.layoutManager?.saveLayout) {
                clearInterval(lmT);
                patchLayoutManager(window.layoutManager);
            }
        }, 100);

        // 4. Патч data-table + восстановление настроек таблицы
        let dtN = 0;
        const dtT = setInterval(() => {
            if (++dtN > 200) { clearInterval(dtT); return; }
            if (window.dataTable) {
                clearInterval(dtT);
                patchDataTable();
                // Восстанавливаем сохранённые настройки таблицы
                const savedCols = lsGet(LS_DT_COLUMNS);
                const savedMeta = lsGet(LS_DT_META);
                if (savedCols?.length || savedMeta) {
                    setTimeout(() => _applyTableStateNow({
                        columns: savedCols || [],
                        ...(savedMeta || {}),
                    }), 600);
                }
            }
        }, 100);

        console.log('[StateSync] layout-state-sync.js v1.0 ready');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();