// ========================================
// ADVANCED EXAMPLE: Calculate and Draw FVG from Real Chart Data
// ========================================
// This example shows how to:
// 1. Get real OHLC data from the chart
// 2. Calculate Bullish and Bearish FVG
// 3. Draw them on the chart
// 4. Track their status (active/touched/filled)

async function detectAndDrawFVG() {
    const chart = window.app.widget.activeChart();
    
    console.log('🔍 Starting FVG Detection...');
    
    // Get current symbol and timeframe
    const symbol = chart.symbol();
    const resolution = chart.resolution();
    console.log(`Symbol: ${symbol}, Timeframe: ${resolution}`);
    
    // Get bars data (last 100 bars)
    // Note: This requires access to datafeed or stored data
    // For demo, we'll use mock data. In production, access real bars:
    
    // Method 1: Via datafeed
    // const bars = await getBarsFromDatafeed(symbol, resolution, 100);
    
    // Method 2: Via widget API (if available)
    // const bars = await chart.getBars();
    
    // For this example, let's use mock calculation
    const bars = generateMockBars(100);
    
    console.log(`📊 Analyzing ${bars.length} bars...`);
    
    // Detect FVGs
    const fvgs = detectFVGs(bars);
    
    console.log(`✓ Found ${fvgs.bullish.length} bullish FVGs`);
    console.log(`✓ Found ${fvgs.bearish.length} bearish FVGs`);
    
    // Draw FVGs on chart
    fvgs.bullish.forEach((fvg, index) => {
        drawBullishFVG(chart, fvg, index);
    });
    
    fvgs.bearish.forEach((fvg, index) => {
        drawBearishFVG(chart, fvg, index);
    });
    
    console.log('✓ FVGs drawn on chart');
    
    return fvgs;
}

// FVG Detection Algorithm
function detectFVGs(bars) {
    const bullishFVGs = [];
    const bearishFVGs = [];
    
    // Need at least 3 bars (i-1, i, i+1)
    for (let i = 1; i < bars.length - 1; i++) {
        const prev = bars[i - 1];  // i-1
        const curr = bars[i];      // i
        const next = bars[i + 1];  // i+1
        
        // Bullish FVG: High[i-1] < Low[i+1]
        if (prev.high < next.low) {
            const fvg = {
                index: i,
                direction: 'bullish',
                bottom: prev.high,
                top: next.low,
                length: next.low - prev.high,
                time_start: prev.time,
                time_end: next.time,
                status: 'active',
                // Chromatic consistency
                monochrome: (prev.close > prev.open) && (next.close > next.open)
            };
            
            // Check if touched or filled by subsequent bars
            for (let n = i + 2; n < bars.length; n++) {
                const bar = bars[n];
                
                // Touch event: Low[n] < FVG_top && Low[n] > FVG_bottom
                if (bar.low < fvg.top && bar.low > fvg.bottom) {
                    if (fvg.status === 'active') {
                        fvg.status = 'touched';
                        fvg.touch_candle = n;
                        fvg.touch_period = n - i;
                    }
                }
                
                // Fill event: Low[n] <= FVG_bottom
                if (bar.low <= fvg.bottom) {
                    fvg.status = 'filled';
                    fvg.fill_candle = n;
                    fvg.fill_period = n - i;
                    fvg.filled_by_body = bar.close <= fvg.bottom;
                    break;
                }
            }
            
            bullishFVGs.push(fvg);
        }
        
        // Bearish FVG: Low[i-1] > High[i+1]
        if (prev.low > next.high) {
            const fvg = {
                index: i,
                direction: 'bearish',
                top: prev.low,
                bottom: next.high,
                length: prev.low - next.high,
                time_start: prev.time,
                time_end: next.time,
                status: 'active',
                // Chromatic consistency
                monochrome: (prev.close < prev.open) && (next.close < next.open)
            };
            
            // Check if touched or filled by subsequent bars
            for (let n = i + 2; n < bars.length; n++) {
                const bar = bars[n];
                
                // Touch event: High[n] > FVG_bottom && High[n] < FVG_top
                if (bar.high > fvg.bottom && bar.high < fvg.top) {
                    if (fvg.status === 'active') {
                        fvg.status = 'touched';
                        fvg.touch_candle = n;
                        fvg.touch_period = n - i;
                    }
                }
                
                // Fill event: High[n] >= FVG_top
                if (bar.high >= fvg.top) {
                    fvg.status = 'filled';
                    fvg.fill_candle = n;
                    fvg.fill_period = n - i;
                    fvg.filled_by_body = bar.close >= fvg.top;
                    break;
                }
            }
            
            bearishFVGs.push(fvg);
        }
    }
    
    return {
        bullish: bullishFVGs,
        bearish: bearishFVGs
    };
}

// Draw Bullish FVG on chart
function drawBullishFVG(chart, fvg, index) {
    const color = fvg.status === 'active' ? 'rgba(76, 175, 80, 0.3)' : 
                  fvg.status === 'touched' ? 'rgba(255, 193, 7, 0.3)' :
                  'rgba(158, 158, 158, 0.2)';
    
    const borderColor = fvg.status === 'active' ? '#4CAF50' : 
                        fvg.status === 'touched' ? '#FFC107' :
                        '#9E9E9E';
    
    chart.createMultipointShape([
        { time: fvg.time_start, price: fvg.bottom },
        { time: fvg.time_end, price: fvg.top }
    ], {
        shape: 'rectangle',
        overrides: {
            backgroundColor: color,
            borderColor: borderColor,
            borderWidth: 1,
            text: `Bull FVG ${index + 1} (${fvg.status})`
        }
    });
}

// Draw Bearish FVG on chart
function drawBearishFVG(chart, fvg, index) {
    const color = fvg.status === 'active' ? 'rgba(244, 67, 54, 0.3)' : 
                  fvg.status === 'touched' ? 'rgba(255, 152, 0, 0.3)' :
                  'rgba(158, 158, 158, 0.2)';
    
    const borderColor = fvg.status === 'active' ? '#F44336' : 
                        fvg.status === 'touched' ? '#FF9800' :
                        '#9E9E9E';
    
    chart.createMultipointShape([
        { time: fvg.time_start, price: fvg.top },
        { time: fvg.time_end, price: fvg.bottom }
    ], {
        shape: 'rectangle',
        overrides: {
            backgroundColor: color,
            borderColor: borderColor,
            borderWidth: 1,
            text: `Bear FVG ${index + 1} (${fvg.status})`
        }
    });
}

// Generate mock bars for demo
function generateMockBars(count) {
    const bars = [];
    const now = Date.now() / 1000;
    const interval = 3600; // 1 hour
    let price = 45000;
    
    for (let i = 0; i < count; i++) {
        const volatility = 200;
        const change = (Math.random() - 0.5) * volatility;
        
        const open = price;
        const close = price + change;
        const high = Math.max(open, close) + Math.random() * 100;
        const low = Math.min(open, close) - Math.random() * 100;
        
        bars.push({
            time: now - (count - i) * interval,
            open: open,
            high: high,
            low: low,
            close: close,
            volume: Math.random() * 1000
        });
        
        price = close;
    }
    
    return bars;
}

// ========================================
// USAGE EXAMPLES
// ========================================

// Example 1: Simple FVG detection
// detectAndDrawFVG();

// Example 2: Filter only active FVGs
// const fvgs = await detectAndDrawFVG();
// const activeFVGs = [...fvgs.bullish, ...fvgs.bearish].filter(f => f.status === 'active');
// console.log('Active FVGs:', activeFVGs);

// Example 3: Find monochrome FVGs only
// const fvgs = await detectAndDrawFVG();
// const monochrome = [...fvgs.bullish, ...fvgs.bearish].filter(f => f.monochrome);
// console.log('Monochrome FVGs:', monochrome);

// RUN THIS:
detectAndDrawFVG();