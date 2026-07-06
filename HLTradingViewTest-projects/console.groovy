console.log('🔍 Начинаем анализ FVG на ВСЕХ загруженных данных...');

// Проверка доступности chart и widget
if (typeof chart === 'undefined' || typeof widget === 'undefined') {

    chart = window.app.widget.activeChart()
}

// Конфигурация
const CONFIG = {
    bullish: {
        fill: 'rgba(76, 175, 80, 0.35)',
        border: '#4CAF50',
        borderWidth: 3,
        label: 'FVG'
    },
    bearish: {
        fill: 'rgba(244, 67, 54, 0.35)',
        border: '#F44336',
        borderWidth: 3,
        label: 'FVG'
    },
    minLength: 0,
    onlyActive: false,  // Показывать ВСЕ FVG
    maxBarsToAnalyze: 10000  // Анализируем до 10000 баров
};

// Класс для FVG
class FVG {
    constructor(data) {
        this.candleIndex = data.candleIndex;
        this.direction = data.direction;
        this.top = data.top;
        this.bottom = data.bottom;
        this.length = Math.abs(data.top - data.bottom);
        this.timeStart = data.timeStart;
        this.timeEnd = data.timeEnd;
        this.status = 'active';
        this.touchCandle = null;
        this.fillCandle = null;
        this.isMonochrome = data.isMonochrome;
        this.shapeId = null;
        this.candlePrev = data.candlePrev;
        this.candleNext = data.candleNext;
    }
    
    getDisplayTop() {
        if (this.direction === 'bullish') {
            return Math.max(this.top, this.candleNext ? this.candleNext.high : this.top);
        } else {
            return Math.max(this.top, this.candlePrev ? this.candlePrev.high : this.top);
        }
    }
    
    getDisplayBottom() {
        if (this.direction === 'bullish') {
            return Math.min(this.bottom, this.candlePrev ? this.candlePrev.low : this.bottom);
        } else {
            return Math.min(this.bottom, this.candleNext ? this.candleNext.low : this.bottom);
        }
    }
    
    checkTouch(candle, index) {
        if (this.status === 'filled') return;
        
        let touched = false;
        
        if (this.direction === 'bullish') {
            if (candle.low < this.top && candle.low > this.bottom) {
                touched = true;
            }
        } else {
            if (candle.high > this.bottom && candle.high < this.top) {
                touched = true;
            }
        }
        
        if (touched && this.status === 'active') {
            this.status = 'touched';
            this.touchCandle = index;
        }
    }
    
    checkFill(candle, index) {
        if (this.status === 'filled') return;
        
        let filled = false;
        
        if (this.direction === 'bullish') {
            if (candle.close <= this.bottom || candle.low <= this.bottom) {
                filled = true;
            }
        } else {
            if (candle.close >= this.top || candle.high >= this.top) {
                filled = true;
            }
        }
        
        if (filled) {
            this.status = 'filled';
            this.fillCandle = index;
        }
    }
}

// Функция обнаружения FVG
function detectFVG(bars) {
    const fvgList = [];
    
    if (bars.length < 3) {
        console.warn('Недостаточно данных для анализа FVG');
        return fvgList;
    }
    
    for (let i = 1; i < bars.length - 1; i++) {
        const prev = bars[i - 1];
        const curr = bars[i];
        const next = bars[i + 1];
        
        // Бычий FVG
        if (prev.high < next.low) {
            const fvg = new FVG({
                candleIndex: i,
                direction: 'bullish',
                top: next.low,
                bottom: prev.high,
                timeStart: prev.time / 1000,
                timeEnd: curr.time / 1000,
                isMonochrome: (prev.close > prev.open) && (next.close > next.open),
                candlePrev: prev,
                candleNext: next
            });
            
            if (fvg.length >= CONFIG.minLength) {
                fvgList.push(fvg);
            }
        }
        
        // Медвежий FVG
        if (prev.low > next.high) {
            const fvg = new FVG({
                candleIndex: i,
                direction: 'bearish',
                top: prev.low,
                bottom: next.high,
                timeStart: prev.time / 1000,
                timeEnd: curr.time / 1000,
                isMonochrome: (prev.close < prev.open) && (next.close < next.open),
                candlePrev: prev,
                candleNext: next
            });
            
            if (fvg.length >= CONFIG.minLength) {
                fvgList.push(fvg);
            }
        }
    }
    
    return fvgList;
}

// Функция обновления статусов FVG
function updateFVGStatus(fvgList, bars) {
    for (const fvg of fvgList) {
        for (let i = fvg.candleIndex + 2; i < bars.length; i++) {
            const candle = bars[i];
            fvg.checkTouch(candle, i);
            fvg.checkFill(candle, i);
            
            if (fvg.status === 'filled') {
                break;
            }
        }
        
        if (fvg.status === 'filled' && fvg.fillCandle) {
            fvg.timeEnd = bars[fvg.fillCandle].time / 1000;
        } else {
            fvg.timeEnd = bars[bars.length - 1].time / 1000;
        }
    }
}

// Функция отрисовки FVG
function drawFVG(fvg) {
    if (CONFIG.onlyActive && fvg.status === 'filled') {
        return null;
    }
    
    const config = fvg.direction === 'bullish' ? CONFIG.bullish : CONFIG.bearish;
    const displayTop = fvg.getDisplayTop();
    const displayBottom = fvg.getDisplayBottom();
    
    try {
        const shapeId = chart.createMultipointShape(
            [
                { time: fvg.timeStart, price: displayBottom },
                { time: fvg.timeEnd, price: displayTop }
            ],
            {
                shape: 'rectangle',
                lock: false,
                disableSelection: false,
                overrides: {
                    backgroundColor: config.fill,
                    borderColor: config.border,
                    borderWidth: config.borderWidth,
                    fillBackground: true,
                    transparency: 65,
                    showLabel: true,
                    text: config.label,
                    textColor: config.border,
                    fontSize: 12
                },
                zOrder: 'top',
                showInObjectsTree: true
            }
        );
        
        return shapeId;
    } catch (error) {
        console.error('Ошибка отрисовки FVG:', error);
        return null;
    }
}

// ГЛАВНАЯ ФУНКЦИЯ: Получение ВСЕХ загруженных данных
async function getAllLoadedBars() {
    console.log('📊 Получение ВСЕХ загруженных баров через TradingView API...');
    
    // Получаем символ
    const symbolInfo = chart.symbolExt();
    let symbol = symbolInfo.symbol || symbolInfo.name || symbolInfo.ticker;
    
    if (!symbol || symbol === 'undefined') {
        const parts = (symbolInfo.full_name || '').split(':');
        symbol = parts[parts.length - 1].replace('USD', '').replace('-USD', '');
    }
    
    if (!symbol || symbol === 'undefined') {
        symbol = 'EUR';
    }
    
    const resolution = chart.resolution();
    
    console.log('✓ Символ:', symbol);
    console.log('✓ Интервал:', resolution);
    
    // Определяем таблицу
    let table = 'market_data_minute';
    if (window.app.defaultInterval == "1h") {
        table = 'market_data_hourly';
    } else if (resolution === '1d') {
        table = 'market_data'; 
    } else{
        table = "market_data_"+ window.app.defaultInterval +"min";
    }
    
    const ticker = `C:${symbol}-USD`;
    
    console.log('🔍 Получаем последние данные из базы...');
    
    // Получаем последнюю дату в базе
    const latestResponse = await fetch(
        `/api/market-data/latest?ticker=${ticker}&table=${table}`,
        { credentials: 'include' }
    );
    
    if (!latestResponse.ok) {
        throw new Error('Failed to get latest timestamp');
    }
    
    const latestData = await latestResponse.json();
    const latestTimestamp = Math.floor(new Date(latestData.latest_timestamp).getTime() / 1000);
    
    console.log(`✅ Последняя дата в базе: ${new Date(latestTimestamp * 1000).toISOString()}`);
    
    // Рассчитываем диапазон для загрузки МАКСИМУМ данных
    const intervalSeconds = {
        '1T': 1, '1': 60, '2': 120, '3': 180, '4': 240, '5': 300, '10': 600, '15': 900, '30': 1800,
        '60': 3600, '240': 14400, '1D': 86400, '2D': 86400 * 2, '3D': 86400 * 3, '1W': 604800
    }[resolution] || 60;
    
    // Грузим максимум баров (ограничено CONFIG.maxBarsToAnalyze)
    const timeSpan = CONFIG.maxBarsToAnalyze * intervalSeconds;
    const fromTimestamp = latestTimestamp - timeSpan;
    
    console.log(`📡 Загружаем ${CONFIG.maxBarsToAnalyze} баров:`);
    console.log(`   От: ${new Date(fromTimestamp * 1000).toISOString()}`);
    console.log(`   До: ${new Date(latestTimestamp * 1000).toISOString()}`);
    console.log(`   Период: ${Math.floor(timeSpan / 86400)} дней`);
    
    // Запрашиваем данные
    const url = `/api/market-data?ticker=${ticker}&table=${table}&from=${fromTimestamp}&to=${latestTimestamp}`;
    const response = await fetch(url, { credentials: 'include' });
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    
    if (!data || data.length === 0) {
        throw new Error('No data received');
    }
    
    console.log(`✅ Загружено ${data.length} баров из базы`);
    
    // Преобразуем в формат свечей
    const bars = data.map(bar => ({
        time: new Date(bar.timestamp).getTime(),
        open: parseFloat(bar.open),
        high: parseFloat(bar.high),
        low: parseFloat(bar.low),
        close: parseFloat(bar.close),
        volume: parseFloat(bar.volume || 0)
    })).sort((a, b) => a.time - b.time);
    
    console.log(`   Первый бар: ${new Date(bars[0].time).toISOString()}`);
    console.log(`   Последний бар: ${new Date(bars[bars.length - 1].time).toISOString()}`);
    
    return bars;
}

// Главная функция анализа
async function analyzeFVG() {
    try {
        // ИСПРАВЛЕНО: Получаем ВСЕ загруженные бары, не только видимый диапазон
        const bars = await getAllLoadedBars();
        
        console.log(`\n🔎 Анализируем ${bars.length} свечей...`);
        
        // Обнаруживаем FVG
        const fvgList = detectFVG(bars);
        
        console.log(`📊 Найдено имбалансов: ${fvgList.length}`);
        
        if (fvgList.length === 0) {
            console.log('ℹ️ FVG не обнаружены');
            return;
        }
        
        // Обновляем статусы
        console.log('🔄 Обновление статусов FVG...');
        updateFVGStatus(fvgList, bars);
        
        // Статистика
        const stats = {
            total: fvgList.length,
            bullish: fvgList.filter(f => f.direction === 'bullish').length,
            bearish: fvgList.filter(f => f.direction === 'bearish').length,
            active: fvgList.filter(f => f.status === 'active').length,
            touched: fvgList.filter(f => f.status === 'touched').length,
            filled: fvgList.filter(f => f.status === 'filled').length
        };
        
        console.log('\n📈 Статистика FVG:');
        console.log(`   Всего: ${stats.total}`);
        console.log(`   Бычьих: ${stats.bullish} | Медвежьих: ${stats.bearish}`);
        console.log(`   Активных: ${stats.active} | Касание: ${stats.touched} | Закрытых: ${stats.filled}`);
        
        // Отрисовываем ВСЕ найденные FVG
        console.log('\n🎨 Отрисовка имбалансов...');
        let drawn = 0;
        
        for (const fvg of fvgList) {
            const shapeId = drawFVG(fvg);
            if (shapeId) {
                fvg.shapeId = shapeId;
                drawn++;
            }
        }
        
        console.log(`✅ Отрисовано ${drawn} имбалансов на ВСЁМ диапазоне данных`);
        console.log('✅ Теперь при прокрутке назад вы увидите все FVG!');
        
        // Показываем первые 10 FVG
        console.log('\n📋 Первые 10 FVG:');
        fvgList.slice(0, 10).forEach((fvg, index) => {
            console.log(`${index + 1}. ${fvg.direction.toUpperCase()} | ${new Date(fvg.timeStart * 1000).toLocaleString()} | ${fvg.bottom.toFixed(5)}-${fvg.top.toFixed(5)} | ${fvg.status}`);
        });
        
        console.log('\n✅ Анализ завершен! Прокрутите график чтобы увидеть все FVG.');
        
    } catch (error) {
        console.error('❌ Ошибка анализа FVG:', error);
        console.error('Стек:', error.stack);
        throw error;
    }
}

// Запускаем анализ
analyzeFVG();