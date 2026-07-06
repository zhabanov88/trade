let chart;
let candlestickSeries;
let volumeSeries;
let currentTicker = 'C:EUR-USD';
let allData = [];
let loadedTimeRange = { from: 0, to: 0 };
let isLoading = false;

// ==================== AUTH FUNCTIONS ====================

async function checkAuthStatus() {
    try {
        const response = await fetch('/api/auth/status');
        const data = await response.json();
        
        if (data.authenticated) {
            document.getElementById('authContainer').style.display = 'none';
            document.getElementById('appContainer').style.display = 'block';
            document.getElementById('username').textContent = data.username;
            await initApp();
        } else {
            document.getElementById('authContainer').style.display = 'block';
            document.getElementById('appContainer').style.display = 'none';
            document.getElementById('code-panel-container').style.display = 'none';
            
        }
    } catch (error) {
        console.error('Auth check error:', error);
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

// Market data endpoint
app.get('/api/market-data', requireAuth, async (req, res) => {
    const { ticker, table, from, to } = req.query;
    
    try {
        // Запрос к ClickHouse
        const query = `
            SELECT 
                timestamp,
                open,
                high,
                low,
                close,
                volume
            FROM ${table}
            WHERE ticker = {ticker:String}
              AND toUnixTimestamp(timestamp) >= {from:UInt32}
              AND toUnixTimestamp(timestamp) <= {to:UInt32}
            ORDER BY timestamp ASC
            LIMIT 5000
        `;
        
        const resultSet = await clickhouse.query({
            query: query,
            format: 'JSONEachRow',
            query_params: {
                ticker: ticker,
                from: parseInt(from),
                to: parseInt(to)
            }
        });
        
        const data = await resultSet.json();
        res.json(data);
        
    } catch (error) {
        console.error('Market data error:', error);
        res.status(500).json({ error: 'Failed to fetch market data' });
    }
});

async function handleLogin(event) {
    event.preventDefault();
    
    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;
    const errorDiv = document.getElementById('loginError');
    
    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            await checkAuthStatus();
        } else {
            errorDiv.textContent = data.error;
            errorDiv.style.display = 'block';
        }
    } catch (error) {
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
            body: JSON.stringify({ username, email, password })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            await checkAuthStatus();
        } else {
            errorDiv.textContent = data.error;
            errorDiv.style.display = 'block';
        }
    } catch (error) {
        errorDiv.textContent = 'Registration failed. Please try again.';
        errorDiv.style.display = 'block';
    }
}

async function handleLogout() {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
        location.reload();
    } catch (error) {
        console.error('Logout error:', error);
    }
}

// ==================== CHART FUNCTIONS ====================

function initChart() {
    const chartContainer = document.getElementById('chart');
    
    chart = LightweightCharts.createChart(chartContainer, {
        width: chartContainer.clientWidth,
        height: 600,
        layout: {
            background: { color: '#ffffff' },
            textColor: '#333',
        },
        grid: {
            vertLines: { color: '#e1e1e1' },
            horzLines: { color: '#e1e1e1' },
        },
        timeScale: {
            timeVisible: true,
            secondsVisible: true,
        },
        crosshair: {
            mode: LightweightCharts.CrosshairMode.Normal,
        },
    });

    candlestickSeries = chart.addCandlestickSeries({
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderVisible: false,
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350',
    });

    volumeSeries = chart.addHistogramSeries({
        color: '#26a69a',
        priceFormat: {
            type: 'volume',
        },
        priceScaleId: '',
        scaleMargins: {
            top: 0.8,
            bottom: 0,
        },
    });

    // Handle resize
    window.addEventListener('resize', () => {
        chart.applyOptions({ width: chartContainer.clientWidth });
    });

    // Handle visible range changes for lazy loading
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRangeChange);
}

let rangeChangeTimeout;
function handleVisibleRangeChange() {
    if (rangeChangeTimeout) {
        clearTimeout(rangeChangeTimeout);
    }
    
    rangeChangeTimeout = setTimeout(async () => {
        const logicalRange = chart.timeScale().getVisibleLogicalRange();
        if (!logicalRange) return;

        const barsInfo = candlestickSeries.barsInLogicalRange(logicalRange);
        if (!barsInfo || isLoading) return;

        // Load more data if we're near the edges
        if (barsInfo.barsBefore < 50) {
            await loadMoreData('before');
        } else if (barsInfo.barsAfter < 50) {
            await loadMoreData('after');
        }
    }, 300);
}

async function loadMoreData1(direction) {
    if (isLoading) return;
    
    isLoading = true;
    document.getElementById('loadingIndicator').style.display = 'inline';

    try {
        let from, to;
        
        if (direction === 'before') {
            to = loadedTimeRange.from;
            from = to - (30 * 24 * 60 * 60); // 30 days before
        } else {
            from = loadedTimeRange.to;
            to = from + (30 * 24 * 60 * 60); // 30 days after
        }

        const response = await fetch(
            `/api/clickhouse/candles?ticker=${currentTicker}&from=${from}&to=${to}&limit=20000`
        );
        
        const newData = await response.json();
        
        if (newData.length > 0) {
            
            const candleData = newData.map(d => ({
                time: d.time,
                open: parseFloat(d.open),
                high: parseFloat(d.high),
                low: parseFloat(d.low),
                close: parseFloat(d.close),
            })).sort((a, b) => a.time - b.time);

            console.log("candleData", newData, candleData);
            const volumeData = newData.map(d => ({
                time: d.time,
                value: parseFloat(d.volume),
                color: parseFloat(d.close) >= parseFloat(d.open) ? '#26a69a' : '#ef5350',
            }));

            // Update loaded range
            if (direction === 'before') {
                loadedTimeRange.from = Math.min(...newData.map(d => d.time));
                allData = [...candleData, ...allData];
            } else {
                loadedTimeRange.to = Math.max(...newData.map(d => d.time));
                allData = [...allData, ...candleData];
            }

            candlestickSeries.update(candleData[candleData.length - 1]);
            volumeSeries.update(volumeData[volumeData.length - 1]); 
        }
    } catch (error) {
        console.error('Error loading more data:', error);
    } finally {
        isLoading = false;
        document.getElementById('loadingIndicator').style.display = 'none';
    }
}
// ... (предыдущий код остается прежним)

// Функция обработки изменения видимого диапазона
//let rangeChangeTimeout;
function handleVisibleRangeChange() {
    if (rangeChangeTimeout) {
        clearTimeout(rangeChangeTimeout);
    }

    rangeChangeTimeout = setTimeout(async () => {
        const logicalRange = chart.timeScale().getVisibleLogicalRange();
        if (!logicalRange) return;

        const barsInfo = candlestickSeries.barsInLogicalRange(logicalRange);
        if (!barsInfo || isLoading) return;

        // Загрузка дополнительных данных при приближении к краям
        if (barsInfo.barsBefore < 50 && loadedTimeRange.from !== 0) {
            await loadMoreData('before');
        } else if (barsInfo.barsAfter < 50 && loadedTimeRange.to !== 0) {
            await loadMoreData('after');
        }
    }, 300);
}

// Функция для подгрузки дополнительных данных
async function loadMoreData(direction) {
    if (isLoading) return;

    isLoading = true;
    document.getElementById('loadingIndicator').style.display = 'inline';

    try {
        let from, to;

        if (direction === 'before') {
            to = loadedTimeRange.from; // Берём первую загруженную дату
            from = to - (30 * 24 * 60 * 60); // Запрашиваем на 30 дней раньше
        } else {
            from = loadedTimeRange.to; // Берём последнюю загруженную дату
            to = from + (30 * 24 * 60 * 60); // Запрашиваем на 30 дней позже
        }

        const response = await fetch(`/api/clickhouse/candles?ticker=${currentTicker}&from=${from}&to=${to}&limit=20000`);
        const newData = await response.json();

        if (newData.length > 0) {
            const candleData = newData.map(d => ({
                time: d.time,
                open: parseFloat(d.open),
                high: parseFloat(d.high),
                low: parseFloat(d.low),
                close: parseFloat(d.close),
            })).sort((a, b) => a.time - b.time);

            const volumeData = newData.map(d => ({
                time: d.time,
                value: parseFloat(d.volume),
                color: parseFloat(d.close) >= parseFloat(d.open) ? '#26a69a' : '#ef5350',
            }));

            // Обновляем диапазон дат
            if (direction === 'before') {
                loadedTimeRange.from = Math.min(...newData.map(d => d.time));
                allData = [...candleData, ...allData]; // Новые данные идут первыми
            } else {
                loadedTimeRange.to = Math.max(...newData.map(d => d.time));
                allData = [...allData, ...candleData]; // Новые данные добавляются последними
            }

            // Добавляем новую порцию данных
            candlestickSeries.update(candleData[candleData.length - 1]);
            volumeSeries.update(volumeData[volumeData.length - 1]);
        }
    } catch (error) {
        console.error('Ошибка подгрузки данных:', error);
    } finally {
        isLoading = false;
        document.getElementById('loadingIndicator').style.display = 'none';
    }
}

// Добавляем заголовки серии (легенды)
function addLegendTitles() {
    candlestickSeries.setTitle('Японские свечи'); // Название для японских свечей
    volumeSeries.setTitle('Объем торгов');       // Название для объемов
}


async function loadInitialData() {
    document.getElementById('loadingIndicator').style.display = 'inline';
    
    try {
        const response = await fetch(
            `/api/clickhouse/candles?ticker=${currentTicker}&limit=20000`
        );
        
        const data = await response.json();
        
        if (data.length === 0) {
            alert('No data available for this ticker');
            return;
        }

        const candleData = data.map(d => ({
            time: d.time,
            open: parseFloat(d.open),
            high: parseFloat(d.high),
            low: parseFloat(d.low),
            close: parseFloat(d.close),
        }));

        const volumeData = data.map(d => ({
            time: d.time,
            value: parseFloat(d.volume),
            color: parseFloat(d.close) >= parseFloat(d.open) ? '#26a69a' : '#ef5350',
        }));

        allData = candleData;
        loadedTimeRange.from = Math.min(...data.map(d => d.time));
        loadedTimeRange.to = Math.max(...data.map(d => d.time));

        candlestickSeries.setData(candleData);
        volumeSeries.setData(volumeData);

        chart.timeScale().fitContent();
        
        console.log(`Loaded ${data.length} candles for ${currentTicker}`);
    } catch (error) {
        console.error('Error loading data:', error);
        alert('Error loading chart data');
    } finally {
        document.getElementById('loadingIndicator').style.display = 'none';
    }
}

async function loadTickers() {
    try {
        const response = await fetch('/api/clickhouse/tickers');
        const tickers = await response.json();
        
        const select = document.getElementById('tickerSelect');
        select.innerHTML = tickers.map(ticker => 
            `<option value="${ticker}" ${ticker === currentTicker ? 'selected' : ''}>${ticker}</option>`
        ).join('');
    } catch (error) {
        console.error('Error loading tickers:', error);
    }
}

function handleTickerChange() {
    currentTicker = document.getElementById('tickerSelect').value;
    allData = [];
    loadedTimeRange = { from: 0, to: 0 };
    loadInitialData();
}

// Основная инициализация приложения
async function initApp() {
    initChart();          // Создаем сам график
    await loadTickers();  // Получаем список тикеров
    await loadInitialData(); // Загружаем начальные данные
    addLegendTitles();   // Устанавливаем заголовки (легенды)
}


// Проверяем статус аутентификации при загрузке страницы
document.addEventListener('DOMContentLoaded', checkAuthStatus);