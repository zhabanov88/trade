
class LayoutManager {

    // ── Ключи localStorage ─────────────────────────────────────────────────
    static LS_SESSION   = 'tv_session';       // { symbol, interval, layoutId, layoutName }
    static LS_RECENT    = 'tv_recent_layouts'; // [ { id, name, symbol, interval, usedAt }, ... ]
    static MAX_RECENT   = 5;

    constructor() {
        this.widget      = null;
        this.layouts     = [];
        this.currentUser = null;
        this._menuEl     = null;    // DOM элемент выпадающего меню
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INIT
    // ─────────────────────────────────────────────────────────────────────────

    init(widget) {
        this.widget = widget;
        this.checkAuthStatus();

        this.widget.onChartReady(() => {
            console.log('✓ Layout Manager v2 ready');

            // Восстанавливаем сессию
            this._restoreSession();

            // Подписываемся на изменения символа и интервала — сохраняем сессию
            this._subscribeToChanges();

            // Встраиваем меню последних layouts рядом с "Open layout..."
            this._injectRecentMenu();
        });
    }

    async checkAuthStatus() {
        try {
            this.currentUser = await apiClient.checkAuthStatus();
        } catch (e) {
            console.error('Failed to get auth status:', e);
        }
    }

    /** Читает сессию из localStorage */
    _loadSession() {
        try {
            const raw = localStorage.getItem(LayoutManager.LS_SESSION);
            return raw ? JSON.parse(raw) : null;
        } catch (_) { return null; }
    }

    /** Записывает сессию в localStorage */
    _saveSession(patch) {
        try {
            const current = this._loadSession() || {};
            const updated = { ...current, ...patch, savedAt: Date.now() };
            localStorage.setItem(LayoutManager.LS_SESSION, JSON.stringify(updated));
        } catch (e) {
            console.warn('_saveSession error:', e);
        }
    }

    /** Восстанавливает символ, интервал и layout после перезагрузки */
    async _restoreSession() {
        const session = this._loadSession();
        if (!session) {
            console.log('[LayoutMgr] No saved session');
            return;
        }

        console.log('[LayoutMgr] Restoring session:', session);

        const chart = this.widget.activeChart();

        // Восстанавливаем символ
        if (session.symbol) {
            try {
                chart.setSymbol(session.symbol, () => {
                    console.log(`[LayoutMgr] ✓ Symbol restored: ${session.symbol}`);
                });
            } catch (e) {
                console.warn('[LayoutMgr] Could not restore symbol:', e);
            }
        }

        // Восстанавливаем интервал
        if (session.interval) {
            try {
                chart.setResolution(session.interval, () => {
                    console.log(`[LayoutMgr] ✓ Interval restored: ${session.interval}`);
                });
            } catch (e) {
                console.warn('[LayoutMgr] Could not restore interval:', e);
            }
        }

        // Восстанавливаем layout (через save_load_adapter TradingView)
        if (session.layoutId) {
            try {
                await this._loadLayoutById(session.layoutId, false);
                console.log(`[LayoutMgr] ✓ Layout restored: ${session.layoutName}`);
            } catch (e) {
                console.warn('[LayoutMgr] Could not restore layout:', e);
                this._saveSession({ layoutId: null, layoutName: null });
                // Layout удалён — восстанавливаем хотя бы состояние таблицы
                if (session.appState) this._restoreAppState(session.appState);
            }
        } else if (session.appState) {
            // Нет сохранённого layout, но есть состояние таблицы
            this._restoreAppState(session.appState);
        }
    }

    /** Подписывается на изменения символа и интервала */
    _subscribeToChanges() {
        const chart = this.widget.activeChart();

        // Символ изменился
        chart.onSymbolChanged().subscribe(null, () => {
            const symbol = chart.symbol();
            this._saveSession({ symbol });
            console.log(`[LayoutMgr] Symbol saved: ${symbol}`);
        });

        // Интервал изменился
        chart.onIntervalChanged().subscribe(null, (interval) => {
            this._saveSession({ interval });
            console.log(`[LayoutMgr] Interval saved: ${interval}`);

            // Обновляем кнопки кастомного селектора интервалов
            if (window.intervalSelector) {
                window.intervalSelector.currentInterval = interval;
                window.intervalSelector.updateActiveButton();
            }
        });

        // Сохраняем начальное состояние
        try {
            const symbol   = chart.symbol();
            const interval = chart.resolution();
            this._saveSession({ symbol, interval });
        } catch (e) {}
        // Автосохранение состояния таблицы каждые 30 секунд
        setInterval(() => {
            try {
                const appState = {
                    activeDataKey: window.app?._activeDataKey || null,
                    tableState:    window.dataTable?.getState ? window.dataTable.getState() : null,
                    savedAt:       Date.now(),
                };
                this._saveSession({ appState });
            } catch (e) {}
        }, 30000);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ЗАДАЧА 2: 5 ПОСЛЕДНИХ LAYOUTS
    // ─────────────────────────────────────────────────────────────────────────

    /** Читает список последних layouts */
    _loadRecent() {
        try {
            const raw = localStorage.getItem(LayoutManager.LS_RECENT);
            return raw ? JSON.parse(raw) : [];
        } catch (_) { return []; }
    }

    /** Добавляет layout в список последних */
    _pushRecent(layout) {
        try {
            let recent = this._loadRecent();

            // Убираем дубль
            recent = recent.filter(r => r.id !== layout.id);

            // Добавляем в начало
            recent.unshift({
                id:       layout.id,
                name:     layout.name,
                symbol:   layout.symbol   || '',
                interval: layout.interval || '',
                usedAt:   Date.now()
            });

            // Оставляем только MAX_RECENT
            recent = recent.slice(0, LayoutManager.MAX_RECENT);

            localStorage.setItem(LayoutManager.LS_RECENT, JSON.stringify(recent));
        } catch (e) {
            console.warn('_pushRecent error:', e);
        }
    }

    /**
     * Загружает layout по ID, обновляет сессию и recent
     * @param {number|string} id
     * @param {boolean} updateRecent - добавить в recent (по умолчанию true)
     */
    async _loadLayoutById(id, updateRecent = true) {
        const layout = await apiClient.getLayout(parseInt(id));

       // Применяем layout данные
       if (layout.layout_data) {
        await new Promise((resolve) => {
            if (this.widget.load) {
                let tvData = layout.layout_data;

                // Если пришла строка — парсим
                if (typeof tvData === 'string') {
                    try { tvData = JSON.parse(tvData); } catch(_) {}
                }

                // Вырезаем _appState — TV его не понимает и падает на panes
                if (tvData && typeof tvData === 'object' && tvData._appState) {
                    const { _appState, ...pureTvData } = tvData;
                    tvData = pureTvData;
                }

                // Восстанавливаем appState вручную
                if (layout.layout_data?._appState && window.layoutManager?._restoreAppState) {
                    window.layoutManager._restoreAppState(layout.layout_data._appState);
                }

                // Проверяем что layout валиден (есть panes) перед передачей в TV
                if (!tvData || typeof tvData !== 'object' || !Array.isArray(tvData.panes)) {
                    console.warn('[LayoutMgr] layout_data missing panes, skipping load');
                    setTimeout(resolve, 300);
                    return;
                }

                this.widget.load(tvData);
            }
            setTimeout(resolve, 300);
        });
    }

        // Применяем символ и интервал из layout
        if (layout.symbol)   this.widget.activeChart().setSymbol(layout.symbol);
        if (layout.interval) this.widget.activeChart().setResolution(layout.interval);

        // Сохраняем в сессию
        this._saveSession({
            layoutId:   layout.id,
            layoutName: layout.name,
            symbol:     layout.symbol,
            interval:   layout.interval
        });

        // Добавляем в recent
        if (updateRecent) this._pushRecent(layout);

        // Обновляем меню
        this._renderRecentMenu();

        console.log(`[LayoutMgr] ✓ Layout loaded: ${layout.name}`);
        return layout;
    }

    _restoreAppState(appState) {
        if (!appState) return;
    
        // Восстанавливаем состояние таблицы
        if (appState.tableState && window.dataTable?.restoreState) {
            setTimeout(() => {
                window.dataTable.restoreState(appState.tableState);
                console.log('[LayoutMgr] ✓ Table state restored');
            }, 800);
        }
    
        // activedata восстановится автоматически через datafeed при загрузке символа/интервала.
        // Если ключ уже совпадает — данные в памяти, просто обновляем таблицу.
        if (appState.activeDataKey) {
            const currentKey = window.app?._activeDataKey;
            if (currentKey === appState.activeDataKey) {
                setTimeout(() => window.dataTable?.refresh?.(), 1000);
                console.log('[LayoutMgr] ✓ activedata key matches, refreshing table');
            } else {
                console.log(`[LayoutMgr] activedata will reload: [${currentKey}] → [${appState.activeDataKey}]`);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // МЕНЮ ПОСЛЕДНИХ LAYOUTS
    // ─────────────────────────────────────────────────────────────────────────

    _injectRecentMenu() {
        if (document.getElementById('lm-recent-guard')) return;
        const guard = document.createElement('div');
        guard.id = 'lm-recent-guard';
        guard.style.display = 'none';
        document.body.appendChild(guard);
        this._waitForIframeAndObserve();
    }
    
    _getIframeDoc() {
        try {
            const iframe = document.querySelector('#tv_chart_container iframe');
            return iframe?.contentDocument || iframe?.contentWindow?.document || null;
        } catch (e) { return null; }
    }
    
    _waitForIframeAndObserve() {
        const tryObserve = () => {
            const iframeDoc = this._getIframeDoc();
            if (!iframeDoc || !iframeDoc.body) { setTimeout(tryObserve, 300); return; }
            this._observeIframeMenu(iframeDoc);
            console.log('[LayoutMgr] ✓ iframe observer started');
        };
        tryObserve();
    }
    
    _observeIframeMenu(iframeDoc) {
        this._injectIframeStyles(iframeDoc);
        const ANCHOR   = '[data-name="save-load-menu-item-load"]';
        const INJECTED = 'lm-recently-used-section';
        const tryInject = () => {
            const anchor = iframeDoc.querySelector(ANCHOR);
            if (!anchor) return;
            if (anchor.parentNode?.querySelector('#' + INJECTED)) return;
            this._buildRecentSection(iframeDoc, anchor);
        };
        tryInject();
        this._iframeObserver = new MutationObserver(tryInject);
        this._iframeObserver.observe(iframeDoc.body, { childList: true, subtree: true });
    }
    
    _buildRecentSection(iframeDoc, anchor) {
        const recent  = this._loadRecent();
        const session = this._loadSession();
    
        const section = iframeDoc.createElement('div');
        section.id = 'lm-recently-used-section';
    
        const divider = iframeDoc.createElement('div');
        divider.className = 'lm-tv-divider';
        section.appendChild(divider);
    
        const header = iframeDoc.createElement('div');
        header.className = 'lm-tv-section-header';
        header.textContent = 'RECENTLY USED';
        section.appendChild(header);
    
        if (recent.length === 0) {
            const empty = iframeDoc.createElement('div');
            empty.className = 'lm-tv-empty';
            empty.textContent = 'No recent layouts';
            section.appendChild(empty);
        } else {
            recent.forEach(r => {
                const item = iframeDoc.createElement('div');
                item.className = 'lm-tv-item' + (session?.layoutId == r.id ? ' lm-tv-item--active' : '');
    
                const nameEl = iframeDoc.createElement('div');
                nameEl.className = 'lm-tv-item-name';
                nameEl.textContent = r.name;
    
                const metaEl = iframeDoc.createElement('div');
                metaEl.className = 'lm-tv-item-meta';
                metaEl.textContent = [r.symbol, r.interval].filter(Boolean).join(', ');
    
                item.appendChild(nameEl);
                item.appendChild(metaEl);
                item.addEventListener('click', async () => {
                    try {
                        iframeDoc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                        await this._loadLayoutById(r.id);
                        this._showToast(`Layout loaded: ${r.name}`);
                    } catch (err) {
                        this._showToast('Failed to load layout: ' + err.message, 'error');
                    }
                });
                section.appendChild(item);
            });
        }
    
        anchor.parentNode.insertBefore(section, anchor.nextSibling);
    }
    
    _renderRecentMenu() {
        const iframeDoc = this._getIframeDoc();
        if (!iframeDoc) return;
        const existing = iframeDoc.getElementById('lm-recently-used-section');
        if (!existing) return;
        const anchor = iframeDoc.querySelector('[data-name="save-load-menu-item-load"]');
        if (!anchor) return;
        existing.remove();
        this._buildRecentSection(iframeDoc, anchor);
    }
    
    _injectIframeStyles(iframeDoc) {
        if (iframeDoc.getElementById('lm-iframe-styles')) return;
        const style = iframeDoc.createElement('style');
        style.id = 'lm-iframe-styles';
        style.textContent = `
            .lm-tv-divider {
                height: 1px;
                background: var(--tv-color-popup-element-secondary-text, rgba(255,255,255,0.12));
                margin: 4px 0;
            }
            .lm-tv-section-header {
                padding: 4px 12px 2px;
                font-size: 11px;
                font-weight: 600;
                color: var(--tv-color-popup-element-secondary-text, #787b86);
                letter-spacing: 0.04em;
                text-transform: uppercase;
                user-select: none;
            }
            .lm-tv-empty {
                padding: 6px 12px;
                font-size: 12px;
                color: var(--tv-color-popup-element-secondary-text, #787b86);
            }
            .lm-tv-item {
                display: flex;
                flex-direction: column;
                padding: 6px 12px;
                cursor: pointer;
                border-radius: 4px;
                margin: 0 4px;
                transition: background 0.1s;
            }
            .lm-tv-item:hover {
                background: var(--tv-color-popup-element-hover-bg, rgba(255,255,255,0.06));
            }
            .lm-tv-item--active {
                background: rgba(41,98,255,0.15);
            }
            .lm-tv-item-name {
                font-size: 13px;
                color: var(--tv-color-popup-element-text, #d1d4dc);
                font-weight: 400;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .lm-tv-item-meta {
                font-size: 11px;
                color: var(--tv-color-popup-element-secondary-text, #787b86);
                margin-top: 1px;
            }
        `;
        iframeDoc.head.appendChild(style);
    }

    _formatRelativeTime(ts) {
        if (!ts) return '';
        const diff = Date.now() - ts;
        const m = Math.floor(diff / 60000);
        const h = Math.floor(diff / 3600000);
        const d = Math.floor(diff / 86400000);
        if (m < 1)  return 'just now';
        if (m < 60) return `${m}m ago`;
        if (h < 24) return `${h}h ago`;
        return `${d}d ago`;
    }

    _escape(s) {
        return String(s || '').replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
        );
    }

    _showToast(msg, type = 'success') {
        const t = document.createElement('div');
        t.className = `lm-toast lm-toast-${type}`;
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => t.classList.add('lm-toast-show'), 10);
        setTimeout(() => { t.classList.remove('lm-toast-show'); setTimeout(() => t.remove(), 300); }, 3000);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SAVE / LOAD / DELETE (оригинальная логика сохранена)
    // ─────────────────────────────────────────────────────────────────────────

    async saveLayout(name, description = '', isDefault = false) {
        if (!this.widget) throw new Error('Widget not initialized');
    
        const layoutData = await this.getCurrentLayoutData();
        const chart      = this.widget.activeChart();
        const symbol     = chart.symbol();
        const interval   = chart.resolution();
    
        const appState = {
            activeDataKey: window.app?._activeDataKey || null,
            tableState:    window.dataTable?.getState ? window.dataTable.getState() : null,
            savedAt:       Date.now(),
        };
    
        const extendedLayoutData = {
            ...(typeof layoutData === 'object' && layoutData !== null ? layoutData : { tvData: layoutData }),
            _appState: appState,
        };
    
        const result = await apiClient.createLayout({
            name, description, layout_data: extendedLayoutData,
            symbol, interval, is_default: isDefault
        });
    
        this._saveSession({ layoutId: result.id, layoutName: name, symbol, interval, appState });
        this._pushRecent({ id: result.id, name, symbol, interval });
        this._renderRecentMenu();
    
        console.log('✓ Layout saved:', result);
        return result;
    }

    async loadLayout(layoutId) {
        return this._loadLayoutById(layoutId);
    }

    async getCurrentLayoutData() {
        return new Promise((resolve) => {
            if (this.widget.save) {
                this.widget.save(resolve);
            } else {
                const chart = this.widget.activeChart();
                resolve({ symbol: chart.symbol(), resolution: chart.resolution(), timestamp: Date.now() });
            }
        });
    }

    async applyLayoutData(layoutData) {
        return new Promise((resolve) => {
            if (this.widget.load && layoutData) { this.widget.load(layoutData); }
            setTimeout(resolve, 300);
        });
    }

    async getLayouts() {
        try {
            this.layouts = await apiClient.getLayouts();
            return this.layouts;
        } catch (e) {
            console.error('Failed to get layouts:', e);
            return [];
        }
    }

    async deleteLayout(layoutId) {
        await apiClient.deleteLayout(layoutId);
        console.log('✓ Layout deleted');
        this._renderRecentMenu();
    }

    async openSaveDialog() {
        const name = prompt('Layout name:', 'My Layout');
        if (!name) return;
        const desc = prompt('Description (optional):', '') || '';
        try {
            await this.saveLayout(name, desc);
            this._showToast(`Layout "${name}" saved!`);
        } catch (e) {
            this._showToast('Failed to save: ' + e.message, 'error');
        }
    }

    async openLoadDialog() {
        try {
            const layouts = await this.getLayouts();
            if (!layouts.length) { alert('No saved layouts found.'); return; }

            const list = layouts.map((l, i) =>
                `${i + 1}. ${l.name}  (${l.symbol || '—'} / ${l.interval || '—'})`
            ).join('\n');

            const choice = prompt('Select layout:\n\n' + list + '\n\nEnter number:', '1');
            if (!choice) return;

            const idx = parseInt(choice) - 1;
            if (idx >= 0 && idx < layouts.length) {
                await this._loadLayoutById(layouts[idx].id);
                this._showToast(`Layout "${layouts[idx].name}" loaded!`);
            } else {
                alert('Invalid selection.');
            }
        } catch (e) {
            alert('Failed to load: ' + e.message);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Initialize
// ─────────────────────────────────────────────────────────────────────────────

const layoutManager = new LayoutManager();
window.layoutManager = layoutManager;