

class TradingApp {
    constructor() {
        this.widget = null;
        this.datafeed = null;
        this.currentUser = null;
        this.isAuthenticated = false;
        this.isInitialized = false;
        this.intervals = [];
    }

    async loadIntervals() {
        try {
            const response = await fetch('/api/intervals', { credentials: 'include' });
            const intervals = await response.json();
            window.app.intervals_obj = intervals;

            // Фильтруем только активные
            const activeIntervals = intervals
                .filter(i => i.is_active)
                .map(i => i.tradingview_code)
                .filter(Boolean);

            return activeIntervals;
        } catch (error) {
            console.error('Failed to load intervals:', error);
            return ['1T', '1', '5', '15', '30', '60', '240', '1D', '1W'];
        }
    }

    getDefaultInterval() {
        // 1. Проверяем localStorage (предпочтение пользователя)
        const savedInterval = localStorage.getItem('tradingview_interval');
        if (savedInterval) {
            return savedInterval;
        }

        // 2. Проверяем настройки в базе данных (можно добавить позже)
        // const userSettings = await apiClient.getUserSettings();
        // if (userSettings.default_interval) return userSettings.default_interval;

        // 3. Используем дефолтный интервал из intervals (первый активный)
        if (this.intervals && this.intervals.length > 0) {
            return this.intervals[0];
        }

        // 4. Fallback
        return '1';
    }

    saveCurrentInterval(interval) {
        // Сохраняем текущий интервал в localStorage
        localStorage.setItem('tradingview_interval', interval);
    }

    // Хелпер для названий интервалов
    getIntervalName(code) {
        const names = {
            '1': '1m',
            '1t': '1t',
            '3': '3m',
            '5': '5m',
            '15': '15m',
            '30': '30m',
            '60': '1h',
            '180': '3h',
            '240': '4h',
            '1D': '1D',
            '1W': '1W',
            '1M': '1M'
        };
        return names[code] || code;
    }

    async init(userFromLogin = null) {

        try {
            let authStatus;

            if (userFromLogin) {
                authStatus = {
                    authenticated: true,
                    username: userFromLogin.username,
                    userId: userFromLogin.id,
                    isAdmin: userFromLogin.isAdmin || false
                };
            } else {
                await new Promise(resolve => setTimeout(resolve, 100));
                authStatus = await this.checkAuth();
            }

            if (!authStatus.authenticated) {
                this.showAuthContainer();
                return;
            }

            this.currentUser = authStatus;
            this.isAuthenticated = true;

            this.showAppContainer();
            this.updateUserInfo();

            // Pre-load layouts from DB if localStorage is empty (new browser)
            await this.preloadLayoutsFromDB();

            // Initialize TradingView
            await this.initTradingView();

            // Initialize managers
            await this.initializeManagers();

            this.isInitialized = true;

        } catch (error) {
            console.error('❌ Application initialization failed:', error);
            this.showError('Failed to initialize application: ' + error.message);
        }
    }

    async checkAuth() {
        try {
            // Use early pre-fetched auth if available (fired in <head> before scripts loaded)
            if (window._earlyAuth) {
                const result = await window._earlyAuth;
                window._earlyAuth = null;
                return result;
            }
            const response = await fetch('/api/auth/status', {
                credentials: 'include'
            });

            if (!response.ok) {
                return { authenticated: false };
            }

            const data = await response.json();
            return data;

        } catch (error) {
            console.error('Auth check failed:', error);
            return { authenticated: false };
        }
    }

    showAuthContainer() {
        const authContainer = document.getElementById('authContainer');
        const appContainer = document.getElementById('appContainer');

        document.title = 'magic'
        if (authContainer) authContainer.style.display = 'block';
        if (appContainer) appContainer.style.display = 'none';
        var lo = document.getElementById('loading-overlay'); if (lo) lo.style.display = 'none';
    }

    showAppContainer() {
        const authContainer = document.getElementById('authContainer');
        const appContainer = document.getElementById('appContainer');
        const loadingOverlay = document.getElementById('loading-overlay');

        document.title = 'Bot32 dashboard'
        if (authContainer) authContainer.style.display = 'none';
        if (loadingOverlay) loadingOverlay.style.display = 'flex';
        if (appContainer) {
            appContainer.style.display = 'flex';
            appContainer.style.visibility = 'hidden';
        }
    }

    updateUserInfo() {
        const usernameEl = document.getElementById('username');
        if (usernameEl && this.currentUser) {
            usernameEl.textContent = this.currentUser.username;

            if (this.currentUser.isAdmin) {
                const safeUsername = (this.currentUser.username || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
                usernameEl.innerHTML = safeUsername + ' <span style="background: #ffa726; color: white; padding: 2px 6px; border-radius: 3px; font-size: 10px; margin-left: 5px;">ADMIN</span>';
            }
        }
    }


    /**
     * Pre-load layouts from DB when localStorage is empty (new browser).
     * Populates tv_session and tv_recent_layouts so initTradingView()
     * can restore the user's default layout instead of showing defaults.
     */
    async preloadLayoutsFromDB() {
        try {
            const cs = window.chartSession;
            const existingSession = cs ? cs.readSession() : {};
            if (existingSession.layoutId) {
                return;
            }


            const layouts = await apiClient.getLayouts();
            if (!layouts || layouts.length === 0) {
                return;
            }


            // API returns: is_default DESC, updated_at DESC — layouts[0] is the best choice
            const layout = layouts[0];

            // Populate session so initTradingView reads layoutId, symbol, interval
            if (cs) {
                cs.writeSession({
                    layoutId: layout.id,
                    layoutName: layout.name,
                    symbol: layout.symbol || 'EUR',
                    interval: layout.interval || '1'
                }, 'preloadFromDB');
            } else {
                localStorage.setItem('tv_session', JSON.stringify({
                    layoutId: layout.id,
                    layoutName: layout.name,
                    symbol: layout.symbol || 'EUR',
                    interval: layout.interval || '1'
                }));
            }

            // Populate recent layouts (push in reverse so first layout lands on top)
            var recent = layouts.slice(0, 5);
            for (var i = recent.length - 1; i >= 0; i--) {
                var l = recent[i];
                if (cs) {
                    cs.pushRecent({ id: l.id, name: l.name, symbol: l.symbol || '', interval: l.interval || '' });
                }
            }

            // Pre-fetch layout data so initTradingView can use _earlyLayout
            window._earlyLayout = fetch('/api/layouts/' + layout.id, { credentials: 'include' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .catch(function () { return null; });


        } catch (error) {
            console.error('[preload] preloadLayoutsFromDB failed:', error);
            // Non-fatal: app continues with defaults
        }
    }

    /**
     * Initialize TradingView widget
     */
    async initTradingView() {

        try {
            this.datafeed = new DatabaseIntegratedDatafeed();

            // Инициализируем datafeed
            await this.datafeed.initialize();

            // Получаем дефолтный символ
            const _savedSession = window.chartSession ? window.chartSession.readSession() : {};

            // Загружаем интервалы
            this.intervals = await this.loadIntervals();

            let defaultSymbol = _savedSession?.symbol || 'EUR';
            if (!_savedSession?.symbol && this.datafeed.instruments?.length > 0) {
                defaultSymbol = this.datafeed.instruments[0].symbol;
            }
            let defaultInterval = _savedSession?.interval || this.getDefaultInterval() || '1';


            // Получаем дефолтный или сохранённый интервал
            //defaultInterval = this.getDefaultInterval();

            // Создаём виджет
            const currentTheme = localStorage.getItem('tradingview_theme') || 'dark';

            let _savedData = null;
            if (_savedSession?.layoutId) {
                try {
                    let _row = null;
                    if (window._earlyLayout) {
                        _row = await window._earlyLayout;
                        window._earlyLayout = null;
                    } else {
                        const _resp = await fetch('/api/layouts/' + _savedSession.layoutId, { credentials: 'include' });
                        if (_resp.ok) _row = await _resp.json();
                    }
                    if (_row) {
                        let _ld = _row.layout_data;
                        if (typeof _ld === 'string') _ld = JSON.parse(_ld);
                        if (_ld && typeof _ld === 'object') {
                            if (_ld._appState) delete _ld._appState;
                            if (_ld.name) delete _ld.name;
                            if (_ld.content && typeof _ld.content === 'string') {
                                _savedData = JSON.parse(_ld.content);
                            } else if (_ld.charts) {
                                _savedData = _ld;
                            }
                        }
                    }
                } catch (_) { }
            }

            if (_savedData) {
            } else {
            }
            this.widget = new TradingView.widget({
                debug: false,
                symbol: _savedData ? undefined : defaultSymbol,
                interval: _savedData ? undefined : defaultInterval,
                saved_data: _savedData,
                auto_save_delay: 5,
                container: 'tv_chart_container',
                datafeed: this.datafeed,
                library_path: 'charting_library/charting_library/',
                locale: 'en',
                theme: currentTheme === 'light' || currentTheme === 'Light' ? 'Light' : 'Dark',

                disabled_features: [
                    "header_resolutions"
                    //'use_localstorage_for_settings'
                ],

                enabled_features: [
                    'study_templates',
                    'chart_template_storage',
                    'side_toolbar_in_fullscreen_mode',
                    'drawing_templates'
                ],
                custom_formatters: {
                    priceFormatterFactory: function (symbolInfo) {
                        var decimals = symbolInfo && symbolInfo.pricescale
                            ? Math.round(Math.log10(symbolInfo.pricescale))
                            : 5;
                        return {
                            format: function (price) {
                                if (!isFinite(price)) return '';
                                return parseFloat(price.toFixed(decimals)).toString();
                            }
                        };
                    },
                    dateFormatter: {
                        format: function (date) {
                            var D = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                            var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                            var dd = ('0' + date.getUTCDate()).slice(-2);
                            var yy = ('0' + (date.getUTCFullYear() % 100)).slice(-2);
                            return D[date.getUTCDay()] + ' ' + dd + ' ' + M[date.getUTCMonth()] + " '" + yy;
                        },
                        formatLocal: function (date) {
                            var D = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                            var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                            var dd = ('0' + date.getDate()).slice(-2);
                            var yy = ('0' + (date.getFullYear() % 100)).slice(-2);
                            return D[date.getDay()] + ' ' + dd + ' ' + M[date.getMonth()] + " '" + yy;
                        }
                    }
                },
                fullscreen: false,
                autosize: true,
                theme: currentTheme,
                timezone: 'America/New_York',

                //custom_indicators_getter: function(PineJS) {
                //    return Promise.resolve([]);
                //},

                custom_indicators_getter: async function (PineJS) {
                    window.PineJS = PineJS;

                    // ── Загружаем скрипты из БД ──────────────────────────────────────────
                    let dbScripts = [];
                    try {
                        const resp = await fetch('/api/javascript-scripts', { credentials: 'include' });
                        if (resp.ok) {
                            const all = await resp.json();
                            dbScripts = all.filter(s => (s.type_code === 'indicator' || s.type_code === 'instrument'));
                        }
                    } catch (e) {
                        console.error('[CIG] Fetch error:', e);
                    }

                    // ── Хелперы для парсинга inputs ──────────────────────────────────────
                    function parseInputs(script) {
                        // default_inputs может быть строкой JSON или объектом
                        let raw = script.default_inputs || script.inputs_schema || {};
                        if (typeof raw === 'string') {
                            try { raw = JSON.parse(raw); } catch (_) { raw = {}; }
                        }

                        // Поддерживаем два формата:
                        // 1. Массив: [{id, name, type, defval, ...}]
                        // 2. Объект: { length: 14, source: "close" }
                        if (Array.isArray(raw)) return raw;

                        return Object.entries(raw).map(([key, val], i) => ({
                            id: `in_${i}`,
                            name: key,
                            defval: val,
                            type: typeof val === 'number'
                                ? (Number.isInteger(val) ? 'integer' : 'float')
                                : typeof val === 'boolean'
                                    ? 'bool'
                                    : 'text',
                        }));
                    }

                    function buildDefaultInputs(inputsArr) {
                        const obj = {};
                        inputsArr.forEach(inp => { obj[inp.id] = inp.defval; });
                        return obj;
                    }

                    // ── Строим определения ───────────────────────────────────────────────
                    const result = [];

                    for (const script of dbScripts) {
                        const id = script.system_name || `indicator_${script.id}`;
                        const name = script.display_name || id;
                        const desc = script.description || name;
                        const overlay = !!(script.is_overlay);
                        const inputs = parseInputs(script);
                        const tvId = `${id}@tv-basicstudies-1`;

                        // ── Попытка 1: код скрипта возвращает готовый TV-объект ───────────
                        if (script.code && script.code.trim()) {
                            if (script.code && script.code.trim()) {
                                try {
                                    // Выполняем код напрямую: new Function('PineJS', code)(PineJS)
                                    // Код должен содержать return { name, metainfo, constructor }
                                    // БЕЗ лишней IIFE обёртки
                                    const factory = new Function('PineJS', script.code);
                                    const built = factory(PineJS);
                                    if (built && built.metainfo && built.constructor) {
                                        built.metainfo.id = tvId;
                                        built.metainfo.isCustomIndicator = true;
                                        result.push(built);
                                        continue;
                                    }
                                } catch (e) {
                                    console.warn(`[CIG] Ошибка кода "${name}":`, e.message);
                                }
                            }
                        }

                        // ── Попытка 2: минимальная заглушка с параметрами из БД ──────────
                        // КРИТИЧНО: компилируем функцию main ОДИН РАЗ, не на каждом баре!
                        let mainFn;
                        if (script.code && script.code.trim()) {
                            try {
                                // Код скрипта может быть телом функции main(ctx, inputCallback)
                                // Компилируем один раз здесь
                                // eslint-disable-next-line no-new-func
                                mainFn = new Function('PineJS', 'ctx', 'inputCallback', `
                                    "use strict";
                                    try {
                                        ${script.code}
                                    } catch(e) {
                                        return [0];
                                    }
                                `).bind(null, PineJS);
                            } catch (_) {
                                mainFn = null;
                            }
                        }

                        const capturedMainFn = mainFn; // замыкание

                        result.push({
                            name: name,
                            metainfo: {
                                _metainfoVersion: 53,
                                id: tvId,
                                description: desc,
                                shortDescription: name.substring(0, 24),
                                is_price_study: overlay,
                                isCustomIndicator: true,
                                format: { type: overlay ? 'inherit' : 'price', precision: 4 },

                                // ── Параметры из БД ──────────────────────────────────────
                                inputs: inputs.map(inp => ({
                                    id: inp.id,
                                    name: inp.name || inp.id,
                                    defval: inp.defval !== undefined ? inp.defval : 0,
                                    type: inp.type || 'integer',
                                    ...(inp.min !== undefined ? { min: inp.min } : {}),
                                    ...(inp.max !== undefined ? { max: inp.max } : {}),
                                    ...(inp.step !== undefined ? { step: inp.step } : {}),
                                    ...(inp.options ? { options: inp.options } : {}),
                                    ...(inp.tooltip ? { tooltip: inp.tooltip } : {}),
                                })),

                                plots: [{ id: 'plot_0', type: 'line' }],

                                defaults: {
                                    styles: {
                                        plot_0: {
                                            linestyle: 0,
                                            linewidth: 2,
                                            plottype: 0,
                                            trackPrice: false,
                                            transparency: 0,
                                            visible: true,
                                            color: '#2962FF',
                                        },
                                    },
                                    precision: 4,
                                    inputs: buildDefaultInputs(inputs),
                                },

                                styles: { plot_0: { title: 'Value', histogramBase: 0 } },
                            },

                            constructor: function () {
                                this.main = function (ctx, inputCallback) {
                                    if (capturedMainFn) {
                                        try {
                                            const r = capturedMainFn(ctx, inputCallback);
                                            if (Array.isArray(r)) return r;
                                            if (typeof r === 'number') return [r];
                                        } catch (_) { }
                                    }
                                    return [0];
                                };
                            },
                        });

                    }

                    // Добавляем то что добавили через Pine Editor
                    const fromRegistry = (window.customPineIndicators || []).filter(Boolean);
                    const all = [...result, ...fromRegistry];
                    return all;
                },

                save_load_adapter: window.chartSession.adapter,

                context_menu: {
                    items_processor: function (items, actionsFactory, params) {
                        if (window.drawingTemplateManager) {
                            return window.drawingTemplateManager.processContextMenu(items, actionsFactory, params);
                        }
                        return Promise.resolve(items);
                    }
                },

                overrides: currentTheme === 'light'
                    ? ThemeManager.LIGHT_STRUCTURAL
                    : ThemeManager.DARK_STRUCTURAL,

                loading_screen: {
                    backgroundColor: currentTheme === 'light' || currentTheme === 'Light' ? '#ffffff' : '#131722',
                    foregroundColor: '#2962FF'
                },
            });

            // Store widget globally
            window.app.widget = this.widget;
            if (window.chartSession) window.chartSession.subscribe(this.widget);
            window.app.defaultInterval = defaultInterval
            window.app.activeTimeFrame = defaultInterval

            // Wait for chart ready
            await new Promise((resolve) => {
                this.widget.onChartReady(() => {

                    // Подписываемся на изменение интервала
                    const chart = this.widget.activeChart();

                    chart.onIntervalChanged().subscribe(null, (interval) => {
                        this.saveCurrentInterval(interval);
                    });

                    if (window.intervalSelector) {
                        window.intervalSelector.init(this.widget);
                    }

                    if (window.drawingTemplateManager) {
                        window.drawingTemplateManager.init(this.widget);
                    }

                    // Hide loading overlay
                    const loadingOverlay = document.getElementById('loading-overlay');
                    const appContainer = document.getElementById('appContainer');

                    if (loadingOverlay) {
                        loadingOverlay.style.display = 'none';
                    }
                    if (appContainer) {
                        appContainer.style.visibility = 'visible';
                    }

                    window.indicatorHelpers = {
                        // Найти study по имени (частичное совпадение)
                        findByName(name) {
                            const chart = window.app?.widget?.activeChart();
                            if (!chart) return [];
                            try {
                                return chart.getAllStudies().filter(s =>
                                    s.name?.toLowerCase().includes(name.toLowerCase())
                                );
                            } catch (_) { return []; }
                        },

                        // Скрыть индикатор
                        hideByName(name) {
                            const chart = window.app?.widget?.activeChart();
                            if (!chart) return;
                            this.findByName(name).forEach(s => {
                                try {
                                    const entity = chart.getStudyById(s.entityId);
                                    entity?.setVisible(false);
                                } catch (_) {
                                    try { chart.setEntityVisibility(s.entityId, false); } catch (__) { }
                                }
                            });
                        },

                        // Показать индикатор
                        showByName(name) {
                            const chart = window.app?.widget?.activeChart();
                            if (!chart) return;
                            this.findByName(name).forEach(s => {
                                try {
                                    const entity = chart.getStudyById(s.entityId);
                                    entity?.setVisible(true);
                                } catch (_) {
                                    try { chart.setEntityVisibility(s.entityId, true); } catch (__) { }
                                }
                            });
                        },

                        // Удалить индикатор с графика
                        removeByName(name) {
                            const chart = window.app?.widget?.activeChart();
                            if (!chart) return;
                            this.findByName(name).forEach(s => {
                                try { chart.removeStudy(s.entityId); } catch (_) { }
                            });
                        },

                        // Список всех активных индикаторов
                        listAll() {
                            const chart = window.app?.widget?.activeChart();
                            if (!chart) return [];
                            try { return chart.getAllStudies(); } catch (_) { return []; }
                        },
                    };

                    resolve();
                });


            });

        } catch (error) {
            console.error('❌ TradingView initialization failed:', error);
            throw error;
        }
    }

    async initializeManagers() {

        try {
            if (window.layoutManager) {
                window.layoutManager.init(this.widget);
            }

            if (window.indicatorsMenuIntegration) {
                window.indicatorsMenuIntegration.init(this.widget);
            }

            if (window.codePanelManager) {
                window.codePanelManager.init(this.widget);
            }

            if (window.currencySelector && this.datafeed) {
                window.currencySelector.init(this.widget);
            }

        } catch (error) {
            console.error('⚠️ Manager initialization error:', error);
        }
    }

    async logout() {
        try {
            await fetch('/api/auth/logout', {
                method: 'POST',
                credentials: 'include'
            });

            window.location.reload();

        } catch (error) {
            console.error('Logout failed:', error);
            alert('Failed to logout');
        }
    }

    showError(message) {
        const loadingOverlay = document.getElementById('loading-overlay');
        if (loadingOverlay) {
            const safeMsg = String(message || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
            loadingOverlay.innerHTML = `
                <div style="text-align: center;">
                    <div style="color: #f44336; font-size: 48px; margin-bottom: 20px;">⚠️</div>
                    <div style="color: #d4d4d4; font-size: 18px; margin-bottom: 10px;">Error</div>
                    <div style="color: #858585; font-size: 14px; max-width: 400px;">${safeMsg}</div>
                    <button onclick="window.location.reload()" style="margin-top: 20px; padding: 10px 20px; background: #2962FF; color: white; border: none; border-radius: 4px; cursor: pointer;">
                        Reload Page
                    </button>
                </div>
            `;
        }
    }
}

// Create global app instance
const app = new TradingApp();
window.app = app;

// Theme toggle function — делегируем в ThemeManager
function toggleTheme() {
    if (window.themeManager) {
        window.themeManager.toggle();
    } else {
        // Fallback если themeManager не загружен
        const currentTheme = localStorage.getItem('tradingview_theme') || 'dark';
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        localStorage.setItem('tradingview_theme', newTheme);
        localStorage.setItem('app_theme', newTheme);
        window.location.reload();
    }
}

// Auth handlers
async function handleLogin(event) {
    event.preventDefault();

    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;
    const errorDiv = document.getElementById('loginError');

    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            await app.init(data.user);
            // Перезагружаем скрипты в code panel после логина
            if (window.codePanelManager) {
                await window.codePanelManager.loadExamplesFromDatabase();
            }
        } else {
            errorDiv.textContent = data.error || 'Login failed';
            errorDiv.style.display = 'block';
        }
    } catch (error) {
        console.error('Login error:', error);
        errorDiv.textContent = 'Login failed. Please try again.';
        errorDiv.style.display = 'block';
    }
}

async function handleRegister(event) {
    event.preventDefault();

    const username = document.getElementById('registerUsername').value;
    const email = document.getElementById('registerEmail').value;
    const password = document.getElementById('registerPassword').value;
    const errorDiv = document.getElementById('registerError');

    try {
        const response = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ username, email, password })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            await app.init(data.user);
            if (window.codePanelManager) {
                await window.codePanelManager.loadExamplesFromDatabase();
            }
        } else {
            errorDiv.textContent = data.error || 'Registration failed';
            errorDiv.style.display = 'block';
        }
    } catch (error) {
        console.error('Registration error:', error);
        errorDiv.textContent = 'Registration failed. Please try again.';
        errorDiv.style.display = 'block';
    }
}

function toggleAuthForm() {
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');

    if (loginForm.style.display === 'none') {
        loginForm.style.display = 'block';
        registerForm.style.display = 'none';
    } else {
        loginForm.style.display = 'none';
        registerForm.style.display = 'block';
    }
}

// Auto-initialize on page load
document.addEventListener('DOMContentLoaded', async () => {

    const authStatus = await app.checkAuth();

    if (authStatus.authenticated) {
        await app.init();
    } else {
        app.showAuthContainer();
    }
});