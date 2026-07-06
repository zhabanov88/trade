

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
            
            // Фильтруем только активные
            const activeIntervals = intervals
                .filter(i => i.is_active)
                .map(i => i.tradingview_code)
                .filter(Boolean);
            

            console.log("intervals__intervals__intervals__intervals", intervals)
            console.log("activeIntervals__activeIntervals__activeIntervals")
            console.log("activeIntervals__activeIntervals__activeIntervals")
            console.log("activeIntervals", activeIntervals)
            console.log("activeIntervals__activeIntervals__activeIntervals")
            console.log("activeIntervals__activeIntervals__activeIntervals")
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
            console.log(`✓ Using saved interval from localStorage: ${savedInterval}`);
            return savedInterval;
        }
        
        // 2. Проверяем настройки в базе данных (можно добавить позже)
        // const userSettings = await apiClient.getUserSettings();
        // if (userSettings.default_interval) return userSettings.default_interval;
        
        // 3. Используем дефолтный интервал из intervals (первый активный)
        if (this.intervals && this.intervals.length > 0) {
            console.log(`✓ Using first available interval: ${this.intervals[0]}`);
            return this.intervals[0];
        }
        
        // 4. Fallback
        console.log('✓ Using fallback interval: 1');
        return '1';
    }

    saveCurrentInterval(interval) {
        // Сохраняем текущий интервал в localStorage
        localStorage.setItem('tradingview_interval', interval);
        console.log(`✓ Interval saved to localStorage: ${interval}`);
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
        console.log('🚀 Initializing TradingView Advanced Platform...');

        try {
            let authStatus;

            if (userFromLogin) {
                console.log('✅ Using login data:', userFromLogin);
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
                console.log('❌ User not authenticated');
                this.showAuthContainer();
                return;
            }

            console.log('✅ User authenticated:', authStatus.username);
            this.currentUser = authStatus;
            this.isAuthenticated = true;

            this.showAppContainer();
            this.updateUserInfo();

            // Initialize TradingView
            await this.initTradingView();

            // Initialize managers
            await this.initializeManagers();

            console.log('✅ Application initialized successfully');
            this.isInitialized = true;

        } catch (error) {
            console.error('❌ Application initialization failed:', error);
            this.showError('Failed to initialize application: ' + error.message);
        }
    }

    async checkAuth() {
        try {
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
                usernameEl.innerHTML = `${this.currentUser.username} <span style="background: #ffa726; color: white; padding: 2px 6px; border-radius: 3px; font-size: 10px; margin-left: 5px;">ADMIN</span>`;
            }
        }
    }

    /**
     * Initialize TradingView widget
     */
    async initTradingView() {
        console.log('📊 Initializing TradingView widget...');

        try {
            console.log('🔄 Creating DatabaseIntegratedDatafeed...');
            this.datafeed = new DatabaseIntegratedDatafeed();
            
            // Инициализируем datafeed
            await this.datafeed.initialize();
            console.log('✅ Datafeed initialized with ClickHouse data');

            // Получаем дефолтный символ
            let _savedSession = null;

            // Загружаем интервалы
            this.intervals = await this.loadIntervals();
            console.log('✓ Intervals loaded:', this.intervals);

            try {
                const _raw = localStorage.getItem('tv_session');
                if (_raw) _savedSession = JSON.parse(_raw);
            } catch (_) {}

            let defaultSymbol = _savedSession?.symbol || 'EUR';
            if (!_savedSession?.symbol && this.datafeed.instruments?.length > 0) {
                defaultSymbol = this.datafeed.instruments[0].symbol;
            }
            let defaultInterval = _savedSession?.interval || this.getDefaultInterval() || '1';


            // Получаем дефолтный или сохранённый интервал
            //defaultInterval = this.getDefaultInterval();
            console.log('✓ Default interval:', defaultInterval);

            // Создаём виджет
            const currentTheme = localStorage.getItem('tradingview_theme') || 'dark';
            
            this.widget = new TradingView.widget({
                debug: false,
                symbol: defaultSymbol,
                interval: defaultInterval,
                container: 'tv_chart_container',
                datafeed: this.datafeed,
                library_path: 'charting_library/charting_library/',
                locale: 'en',
                
                disabled_features: [
                    "header_resolutions"
                    //'use_localstorage_for_settings'
                ],
                
                enabled_features: [
                    'study_templates',
                    'side_toolbar_in_fullscreen_mode'
                ],
                
                fullscreen: false,
                autosize: true,
                theme: currentTheme, // Используем тему из localStorage 
                timezone: 'America/New_York',
                
                custom_indicators_getter: function(PineJS) {
                    return Promise.resolve([]);
                },
                
                save_load_adapter: {
                    charts: [],
                    studyTemplates: [],
                    
                    getAllCharts: async () => {
                        try {
                            const layouts = await apiClient.getLayouts();
                            return layouts.map(layout => ({
                                id: layout.id.toString(),
                                name: layout.name,
                                symbol: layout.symbol || defaultSymbol,
                                resolution: layout.interval || '1',
                                timestamp: new Date(layout.created_at).getTime() / 1000
                            }));
                        } catch (error) {
                            console.error('Failed to get charts:', error);
                            return [];
                        }
                    },
                    
                    removeChart: async (id) => {
                        try {
                            await apiClient.deleteLayout(parseInt(id));
                        } catch (error) {
                            console.error('Failed to remove chart:', error);
                        }
                    },
                    
                    saveChart: async (chartData) => {
                        try {
                            let content = chartData.content;
                            if (typeof content === 'string') {
                                try { content = JSON.parse(content); } catch(_) {}
                            }
                            const extendedContent = {
                                ...(typeof content === 'object' && content !== null ? content : { raw: content }),
                                _appState: {
                                    activeDataKey: window.app?._activeDataKey || null,
                                    tableState:    window.dataTable?.getState ? window.dataTable.getState() : null,
                                    savedAt:       Date.now(),
                                }
                            };
                            const result = await apiClient.createLayout({
                                name:        chartData.name,
                                layout_data: extendedContent,
                                symbol:      chartData.symbol,
                                interval:    chartData.resolution,
                                is_default:  false
                            });
                            if (window.layoutManager) {
                                window.layoutManager._saveSession({
                                    layoutId:   result.id,
                                    layoutName: chartData.name,
                                    symbol:     chartData.symbol,
                                    interval:   chartData.resolution,
                                    appState:   extendedContent._appState,
                                });
                                window.layoutManager._pushRecent({ id: result.id, name: chartData.name, symbol: chartData.symbol, interval: chartData.resolution });
                                window.layoutManager._renderRecentMenu();
                            }
                            return result.id.toString();
                        } catch (error) {
                            console.error('Failed to save chart:', error);
                            throw error;
                        }
                    },
                    
                    getChartContent: async (id) => {
                        try {
                            const layout = await apiClient.getLayout(parseInt(id));
                            let data = layout.layout_data;
                    
                            if (data && typeof data === 'object' && data._appState) {
                                const appState = data._appState;
                                const { _appState, ...pureTvData } = data;
                                data = pureTvData;
                    
                                if (window.layoutManager) {
                                    window.layoutManager._saveSession({
                                        layoutId:   layout.id,
                                        layoutName: layout.name,
                                        symbol:     layout.symbol,
                                        interval:   layout.interval,
                                        appState,
                                    });
                                    window.layoutManager._restoreAppState(appState);
                                    window.layoutManager._pushRecent(layout);
                                    window.layoutManager._renderRecentMenu();
                                }
                            }
                    
                            return data;
                        } catch (error) {
                            console.error('Failed to get chart content:', error);
                            return null;
                        }
                    },
                    
                    getAllStudyTemplates: () => Promise.resolve([]),
                    removeStudyTemplate: () => Promise.resolve(),
                    saveStudyTemplate: () => Promise.resolve(),
                    getStudyTemplateContent: () => Promise.resolve('')
                },
                
                overrides: {
                    'mainSeriesProperties.candleStyle.upColor': '#26a69a',
                    'mainSeriesProperties.candleStyle.downColor': '#ef5350',
                    'mainSeriesProperties.candleStyle.borderUpColor': '#26a69a',
                    'mainSeriesProperties.candleStyle.borderDownColor': '#ef5350',
                    'mainSeriesProperties.candleStyle.wickUpColor': '#26a69a',
                    'mainSeriesProperties.candleStyle.wickDownColor': '#ef5350'
                },

                loading_screen: {
                    backgroundColor: '#131722',
                    foregroundColor: '#2962FF'
                }
            });

            // Store widget globally
            window.app.widget = this.widget;
            window.app.defaultInterval = defaultInterval
            window.app.activeTimeFrame = defaultInterval

            // Wait for chart ready
            await new Promise((resolve) => {
                this.widget.onChartReady(() => {
                    console.log('✅ TradingView chart ready');
                    
                    // Подписываемся на изменение интервала
                    const chart = this.widget.activeChart();
                    chart.onIntervalChanged().subscribe(null, (interval) => {
                        console.log(`✓ Interval changed to: ${interval}`);
                        this.saveCurrentInterval(interval);
                    });
                    
                    if (window.intervalSelector) {
                        console.log(`✓ Interval changed to !!!!!!!!!!!!!!!!!:`);
                        console.log(`✓ Interval changed to !!!!!!!!!!!!!!!!!:`);
                        console.log(`✓ Interval changed to !!!!!!!!!!!!!!!!!:`);
                        console.log(`✓ Interval changed to !!!!!!!!!!!!!!!!!:`);
                        console.log(`✓ Interval changed to !!!!!!!!!!!!!!!!!:`);
                        console.log(`✓ Interval changed to !!!!!!!!!!!!!!!!!:`);
                        window.intervalSelector.init(this.widget);
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
                    
                    resolve();
                });
            });

        } catch (error) {
            console.error('❌ TradingView initialization failed:', error);
            throw error;
        }
    }

    async initializeManagers() {
        console.log('🔧 Initializing managers...');

        try {
            if (window.layoutManager) {
                window.layoutManager.init(this.widget);
                console.log('✅ Layout Manager initialized');
            }

            if (window.indicatorsMenuIntegration) {
                window.indicatorsMenuIntegration.init(this.widget);
                console.log('✅ Indicators Menu Integration initialized');
            }

            if (window.codePanelManager) {
                window.codePanelManager.init(this.widget);
                console.log('✅ Code Panel Manager initialized');
            }
            
            if (window.currencySelector && this.datafeed) {
                window.currencySelector.init(this.widget);
                console.log('✅ Currency Selector initialized');
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
            loadingOverlay.innerHTML = `
                <div style="text-align: center;">
                    <div style="color: #f44336; font-size: 48px; margin-bottom: 20px;">⚠️</div>
                    <div style="color: #d4d4d4; font-size: 18px; margin-bottom: 10px;">Error</div>
                    <div style="color: #858585; font-size: 14px; max-width: 400px;">${message}</div>
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

// Theme toggle function
function toggleTheme() {
    if (!window.app.widget) {
        console.error('Widget not initialized');
        return;
    }
    
    const currentTheme = localStorage.getItem('tradingview_theme') || 'dark';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    
    localStorage.setItem('tradingview_theme', newTheme);
    
    // Reload page to apply theme
    window.location.reload();
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
            console.log('✅ Login successful:', data.user);
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
            console.log('✅ Registration successful:', data.user);
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
    console.log('📄 DOM Content Loaded');
    
    const authStatus = await app.checkAuth();
    
    if (authStatus.authenticated) {
        console.log('✅ User already authenticated, auto-initializing...');
        await app.init();
    } else {
        console.log('ℹ️ User not authenticated, showing login form');
        app.showAuthContainer();
    }
});