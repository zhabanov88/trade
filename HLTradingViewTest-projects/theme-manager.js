/**
 * theme-manager.js  v4
 *
 * Управление темой БЕЗ перезагрузки страницы:
 *  - UI (body class, CSS-переменные) — мгновенно
 *  - TradingView виджет — через widget.changeTheme() + applyOverrides()
 *
 * Защита темы при загрузке layout:
 *  - Перехватывает widget.load()
 *  - После загрузки layout восстанавливает СТРУКТУРНЫЕ свойства темы
 *    (фон, сетка, шкалы), но НЕ трогает пользовательские (цвета свечей)
 */

class ThemeManager {

    // ── ПОЛНЫЕ overrides — для переключения темы (toggle) ────────
    // Включают цвета свечей — при смене темы нужно установить всё
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
        // Candles
        'mainSeriesProperties.candleStyle.upColor':        '#648fff',
        'mainSeriesProperties.candleStyle.downColor':      '#fe6100',
        'mainSeriesProperties.candleStyle.borderUpColor':  '#648fff',
        'mainSeriesProperties.candleStyle.borderDownColor':'#fe6100',
        'mainSeriesProperties.candleStyle.wickUpColor':    '#648fff',
        'mainSeriesProperties.candleStyle.wickDownColor':  '#fe6100',
        // Hollow candles
        'mainSeriesProperties.hollowCandleStyle.upColor':        '#648fff',
        'mainSeriesProperties.hollowCandleStyle.downColor':      '#fe6100',
        'mainSeriesProperties.hollowCandleStyle.borderUpColor':  '#648fff',
        'mainSeriesProperties.hollowCandleStyle.borderDownColor':'#fe6100',
        'mainSeriesProperties.hollowCandleStyle.wickUpColor':    '#648fff',
        'mainSeriesProperties.hollowCandleStyle.wickDownColor':  '#fe6100',
        // Bars
        'mainSeriesProperties.barStyle.upColor':           '#648fff',
        'mainSeriesProperties.barStyle.downColor':         '#fe6100',
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
        // Candles
        'mainSeriesProperties.candleStyle.upColor':        '#ffffff',
        'mainSeriesProperties.candleStyle.downColor':      '#000000',
        'mainSeriesProperties.candleStyle.borderUpColor':  '#000000',
        'mainSeriesProperties.candleStyle.borderDownColor':'#000000',
        'mainSeriesProperties.candleStyle.wickUpColor':    '#000000',
        'mainSeriesProperties.candleStyle.wickDownColor':  '#000000',
        // Hollow candles
        'mainSeriesProperties.hollowCandleStyle.upColor':        '#ffffff',
        'mainSeriesProperties.hollowCandleStyle.downColor':      '#000000',
        'mainSeriesProperties.hollowCandleStyle.borderUpColor':  '#000000',
        'mainSeriesProperties.hollowCandleStyle.borderDownColor':'#000000',
        'mainSeriesProperties.hollowCandleStyle.wickUpColor':    '#000000',
        'mainSeriesProperties.hollowCandleStyle.wickDownColor':  '#000000',
        // Bars
        'mainSeriesProperties.barStyle.upColor':           '#000000',
        'mainSeriesProperties.barStyle.downColor':         '#000000',
    };

    // ── СТРУКТУРНЫЕ overrides — для защиты при загрузке layout ───
    // НЕ включают цвета свечей — сохраняют пользовательские настройки
    static DARK_STRUCTURAL = {
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
    };

    static LIGHT_STRUCTURAL = {
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
                this._applyOverrides(theme);
                setTimeout(() => this._applyOverrides(theme), 50);
                return;
            } catch (e) {
                console.warn('[ThemeManager] changeTheme failed:', e.message);
            }
        }

        // Способ 2: applyOverrides (работает всегда)
        this._applyOverrides(theme);
    }

    _applyOverrides(theme) {
        this._doApplyOverrides(theme, false);
    }

    _applyStructuralOverrides(theme) {
        this._doApplyOverrides(theme, true);
    }

    _doApplyOverrides(theme, structuralOnly) {
        const widget = window.app?.widget;
        if (!widget) return;

        var overrides;
        if (structuralOnly) {
            overrides = theme === 'light'
                ? ThemeManager.LIGHT_STRUCTURAL
                : ThemeManager.DARK_STRUCTURAL;
        } else {
            overrides = theme === 'light'
                ? ThemeManager.LIGHT_OVERRIDES
                : ThemeManager.DARK_OVERRIDES;
        }

        try {
            widget.applyOverrides(overrides);
        } catch (e) {
            console.warn('[ThemeManager] applyOverrides failed:', e.message);
        }

        if (window.TVEngine && typeof window.TVEngine.updateLegendColor === 'function') {
            window.TVEngine.updateLegendColor(theme);
        }
    }

    // ════════════════════════════════════════════════════════════════
    // ЗАЩИТА ТЕМЫ ПРИ ЗАГРУЗКЕ LAYOUT
    // Layout хранит внутри себя настройки цветов — при загрузке
    // они перезаписывают тему. Патчим widget.load()
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

        if (typeof widget.load === 'function') {
            const _origLoad = widget.load.bind(widget);
            widget.load = (data) => {
                const result = _origLoad(data);
                setTimeout(() => {
                    this._applyStructuralOverrides(this.currentTheme);
                }, 200);
                return result;
            };
        }

        widget.onChartReady(() => {
            setTimeout(() => this._applyStructuralOverrides(this.currentTheme), 100);
        });
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