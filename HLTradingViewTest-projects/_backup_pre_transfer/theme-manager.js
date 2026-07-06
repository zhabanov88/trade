/**
 * theme-manager.js  v2
 *
 * Управление темой БЕЗ перезагрузки страницы:
 *  - UI (body class, CSS-переменные) — мгновенно
 *  - TradingView виджет — через widget.changeTheme() + applyOverrides()
 *
 * Защита темы при загрузке layout:
 *  - Перехватывает widget.load() и save_load_adapter.getChartContent()
 *  - После загрузки любого layout принудительно восстанавливает тему сайта
 */

class ThemeManager {

    // Полные наборы overrides для каждой темы
    static DARK_OVERRIDES = {
        'paneProperties.background':                       '#131722',
        'paneProperties.backgroundType':                   'solid',
        'paneProperties.backgroundGradientStartColor':     '#131722',
        'paneProperties.backgroundGradientEndColor':       '#131722',
        'paneProperties.vertGridProperties.color':         '#1e2433',
        'paneProperties.horzGridProperties.color':         '#1e2433',
        'paneProperties.crossHairProperties.color':        '#9598a1',
        'scalesProperties.textColor':                      '#b2b5be',
        'scalesProperties.lineColor':                      '#2a2e39',
        'scalesProperties.backgroundColor':                '#131722',
        'mainSeriesProperties.candleStyle.upColor':        '#26a69a',
        'mainSeriesProperties.candleStyle.downColor':      '#ef5350',
        'mainSeriesProperties.candleStyle.borderUpColor':  '#26a69a',
        'mainSeriesProperties.candleStyle.borderDownColor':'#ef5350',
        'mainSeriesProperties.candleStyle.wickUpColor':    '#26a69a',
        'mainSeriesProperties.candleStyle.wickDownColor':  '#ef5350',
    };

    static LIGHT_OVERRIDES = {
        'paneProperties.background':                       '#ffffff',
        'paneProperties.backgroundType':                   'solid',
        'paneProperties.backgroundGradientStartColor':     '#ffffff',
        'paneProperties.backgroundGradientEndColor':       '#f8f9fd',
        'paneProperties.vertGridProperties.color':         '#e8edf2',
        'paneProperties.horzGridProperties.color':         '#e8edf2',
        'paneProperties.crossHairProperties.color':        '#758696',
        'scalesProperties.textColor':                      '#131722',
        'scalesProperties.lineColor':                      '#d1d4dc',
        'scalesProperties.backgroundColor':                '#ffffff',
        'mainSeriesProperties.candleStyle.upColor':        '#26a69a',
        'mainSeriesProperties.candleStyle.downColor':      '#ef5350',
        'mainSeriesProperties.candleStyle.borderUpColor':  '#26a69a',
        'mainSeriesProperties.candleStyle.borderDownColor':'#ef5350',
        'mainSeriesProperties.candleStyle.wickUpColor':    '#26a69a',
        'mainSeriesProperties.candleStyle.wickDownColor':  '#ef5350',
    };

    constructor() {
        this.currentTheme = localStorage.getItem('tradingview_theme') || 'dark';
        this._widgetPatched = false;

        // Применяем UI-тему сразу
        this._applyUITheme(this.currentTheme);

        // Ждём виджет и патчим его
        this._waitForWidget();
    }

    // ════════════════════════════════════════════════════════════════
    // ПЕРЕКЛЮЧЕНИЕ ТЕМЫ
    // ════════════════════════════════════════════════════════════════

    toggle() {
        const newTheme = this.currentTheme === 'dark' ? 'light' : 'dark';
        this.applyTheme(newTheme);
    }

    applyTheme(theme) {
        this.currentTheme = theme;

        // 1. Сохраняем
        localStorage.setItem('tradingview_theme', theme);
        localStorage.setItem('app_theme', theme);

        // 2. UI — мгновенно (body class, кнопка)
        this._applyUITheme(theme);

        // 3. TradingView виджет — без перезагрузки
        this._applyWidgetTheme(theme);

        console.log(`[ThemeManager] ✅ Theme changed to: ${theme}`);
    }

    // ════════════════════════════════════════════════════════════════
    // UI ТЕМА (body class, кнопка)
    // ════════════════════════════════════════════════════════════════

    _applyUITheme(theme) {
        document.body.className = theme + '-theme';

        const btn = document.querySelector('.theme-toggle');
        if (btn) {
            btn.innerHTML = theme === 'dark' ? '☀️' : '🌙';
            btn.title = theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme';
        }
    }

    // Алиас для обратной совместимости
    applyThemeImmediately(theme) {
        this._applyUITheme(theme);
    }

    // ════════════════════════════════════════════════════════════════
    // ВИДЖЕТ ТЕМА
    // ════════════════════════════════════════════════════════════════

    _applyWidgetTheme(theme) {
        const widget = window.app?.widget;
        if (!widget) {
            console.log('[ThemeManager] Widget not ready yet, theme will apply on init');
            return;
        }

        const isLight = theme === 'light';
        const tvTheme = isLight ? 'Light' : 'Dark';

        // Способ 1: changeTheme (TradingView Charting Library v25+)
        if (typeof widget.changeTheme === 'function') {
            try {
                widget.changeTheme(tvTheme);
                // После смены темы применяем overrides поверх
                setTimeout(() => this._applyOverrides(theme), 300);
                console.log(`[ThemeManager] ✅ widget.changeTheme("${tvTheme}") called`);
                return;
            } catch (e) {
                console.warn('[ThemeManager] changeTheme failed:', e.message);
            }
        }

        // Способ 2: applyOverrides (работает всегда)
        this._applyOverrides(theme);
    }

    _applyOverrides(theme) {
        const widget = window.app?.widget;
        if (!widget) return;

        const overrides = theme === 'light'
            ? ThemeManager.LIGHT_OVERRIDES
            : ThemeManager.DARK_OVERRIDES;

        try {
            widget.applyOverrides(overrides);
            console.log(`[ThemeManager] ✅ applyOverrides applied for theme: ${theme}`);
        } catch (e) {
            console.warn('[ThemeManager] applyOverrides failed:', e.message);
        }
    }

    // ════════════════════════════════════════════════════════════════
    // ЗАЩИТА ТЕМЫ ПРИ ЗАГРУЗКЕ LAYOUT
    // Layout хранит внутри себя настройки цветов — при загрузке
    // они перезаписывают тему. Патчим widget.load() и getChartContent()
    // ════════════════════════════════════════════════════════════════

    _waitForWidget() {
        let attempts = 0;
        const poll = setInterval(() => {
            attempts++;
            const widget = window.app?.widget;
            if (widget) {
                clearInterval(poll);
                this._patchWidget(widget);
            } else if (attempts > 150) {
                clearInterval(poll);
                console.warn('[ThemeManager] Widget not found after 15s');
            }
        }, 100);
    }

    _patchWidget(widget) {
        if (this._widgetPatched) return;
        this._widgetPatched = true;

        // Патчим widget.load() — вызывается при загрузке layout
        if (typeof widget.load === 'function') {
            const _origLoad = widget.load.bind(widget);
            widget.load = (data) => {
                const result = _origLoad(data);
                // После загрузки layout восстанавливаем тему
                setTimeout(() => {
                    this._applyOverrides(this.currentTheme);
                    console.log('[ThemeManager] 🎨 Theme reapplied after widget.load()');
                }, 200);
                return result;
            };
        }

        // Патчим save_load_adapter.getChartContent()
        const adapter = widget._options?.save_load_adapter || widget.options?.save_load_adapter;
        if (adapter && !adapter._themePatched) {
            const _origGet = adapter.getChartContent.bind(adapter);
            adapter.getChartContent = async (id) => {
                const content = await _origGet(id);
                // Восстанавливаем тему после загрузки
                setTimeout(() => {
                    this._applyOverrides(this.currentTheme);
                    console.log('[ThemeManager] 🎨 Theme reapplied after getChartContent()');
                }, 400);
                return content;
            };
            adapter._themePatched = true;
        }

        // Применяем тему сразу после инициализации виджета
        widget.onChartReady(() => {
            setTimeout(() => this._applyOverrides(this.currentTheme), 100);
        });

        console.log('[ThemeManager] ✅ Widget patched for theme protection');
    }
}

// ════════════════════════════════════════════════════════════════
// ИНИЦИАЛИЗАЦИЯ
// ════════════════════════════════════════════════════════════════

const themeManager = new ThemeManager();
window.themeManager = themeManager;

function toggleTheme() {
    if (window.themeManager) {
        window.themeManager.toggle();
    }
}