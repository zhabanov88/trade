// ========================================
// ADX (Average Directional Index) Calculator
// ========================================
// Calculates ADX to determine trend strength
// ADX < 20: флэт
// ADX 20-25: зарождающийся тренд  
// ADX > 25: тренд
// ADX > 40: сильный тренд

function calculateADX(bars, period = 14) {
    console.log(`📊 Calculating ADX with period ${period}...`);
    
    const tr = [];
    const plusDM = [];
    const minusDM = [];
    const trSmooth = [];
    const plusDMSmooth = [];
    const minusDMSmooth = [];
    const plusDI = [];
    const minusDI = [];
    const dx = [];
    const adx = [];
    
    // Step 1: Calculate True Range (TR)
    for (let i = 0; i < bars.length; i++) {
        if (i === 0) {
            tr[i] = bars[i].high - bars[i].low;
        } else {
            const high_low = bars[i].high - bars[i].low;
            const high_close = Math.abs(bars[i].high - bars[i - 1].close);
            const low_close = Math.abs(bars[i].low - bars[i - 1].close);
            tr[i] = Math.max(high_low, high_close, low_close);
        }
    }
    
    // Step 2: Calculate Directional Movement (+DM and -DM)
    for (let i = 0; i < bars.length; i++) {
        if (i === 0) {
            plusDM[i] = 0;
            minusDM[i] = 0;
        } else {
            const upMove = bars[i].high - bars[i - 1].high;
            const downMove = bars[i - 1].low - bars[i].low;
            
            if (upMove > downMove && upMove > 0) {
                plusDM[i] = upMove;
                minusDM[i] = 0;
            } else if (downMove > upMove && downMove > 0) {
                plusDM[i] = 0;
                minusDM[i] = downMove;
            } else {
                plusDM[i] = 0;
                minusDM[i] = 0;
            }
        }
    }
    
    // Step 3: Smooth TR, +DM, -DM (Wilder smoothing)
    // First N bars: simple sum
    if (bars.length >= period) {
        trSmooth[period - 1] = tr.slice(0, period).reduce((a, b) => a + b, 0);
        plusDMSmooth[period - 1] = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
        minusDMSmooth[period - 1] = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
        
        // Subsequent bars: Wilder smoothing
        for (let i = period; i < bars.length; i++) {
            trSmooth[i] = trSmooth[i - 1] - (trSmooth[i - 1] / period) + tr[i];
            plusDMSmooth[i] = plusDMSmooth[i - 1] - (plusDMSmooth[i - 1] / period) + plusDM[i];
            minusDMSmooth[i] = minusDMSmooth[i - 1] - (minusDMSmooth[i - 1] / period) + minusDM[i];
        }
    }
    
    // Step 4: Calculate Directional Indicators (+DI and -DI)
    for (let i = period - 1; i < bars.length; i++) {
        if (trSmooth[i] === 0) {
            plusDI[i] = 0;
            minusDI[i] = 0;
        } else {
            plusDI[i] = 100 * (plusDMSmooth[i] / trSmooth[i]);
            minusDI[i] = 100 * (minusDMSmooth[i] / trSmooth[i]);
        }
    }
    
    // Step 5: Calculate Directional Index (DX)
    for (let i = period - 1; i < bars.length; i++) {
        const sum = plusDI[i] + minusDI[i];
        if (sum === 0) {
            dx[i] = 0;
        } else {
            dx[i] = 100 * Math.abs(plusDI[i] - minusDI[i]) / sum;
        }
    }
    
    // Step 6: Calculate ADX
    if (bars.length >= 2 * period) {
        // First ADX value: average of DX from period to 2*period
        const firstADX = dx.slice(period, 2 * period).reduce((a, b) => a + b, 0) / period;
        adx[2 * period - 1] = firstADX;
        
        // Subsequent ADX values
        for (let i = 2 * period; i < bars.length; i++) {
            adx[i] = ((adx[i - 1] * (period - 1)) + dx[i]) / period;
        }
    }
    
    console.log('✓ ADX calculation complete');
    
    return {
        tr,
        plusDM,
        minusDM,
        plusDI,
        minusDI,
        dx,
        adx,
        period
    };
}

// Interpret ADX value
function interpretADX(adxValue) {
    if (adxValue < 20) {
        return { status: 'флэт', color: '#9E9E9E', strength: 'weak' };
    } else if (adxValue >= 20 && adxValue < 25) {
        return { status: 'зарождающийся тренд', color: '#FFC107', strength: 'emerging' };
    } else if (adxValue >= 25 && adxValue < 40) {
        return { status: 'тренд', color: '#4CAF50', strength: 'trend' };
    } else {
        return { status: 'сильный тренд', color: '#F44336', strength: 'strong' };
    }
}

// Example usage
async function analyzeADX() {
    console.log('🔍 Starting ADX Analysis...');
    
    // Generate mock data (in production, use real chart data)
    const bars = generateMockBars(100);
    
    // Calculate ADX
    const result = calculateADX(bars, 14);
    
    // Get latest ADX value
    const latestADX = result.adx[result.adx.length - 1];
    const interpretation = interpretADX(latestADX);
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📈 Current ADX: ${latestADX.toFixed(2)}`);
    console.log(`📊 Market Status: ${interpretation.status}`);
    console.log(`💪 Trend Strength: ${interpretation.strength}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    // Show last 5 ADX values
    console.log('Last 5 ADX values:');
    for (let i = Math.max(0, result.adx.length - 5); i < result.adx.length; i++) {
        if (result.adx[i] !== undefined) {
            const interp = interpretADX(result.adx[i]);
            console.log(`  [${i}] ADX: ${result.adx[i].toFixed(2)} - ${interp.status}`);
        }
    }
    
    return result;
}

// Helper function to generate mock bars
function generateMockBars(count) {
    const bars = [];
    const now = Date.now() / 1000;
    const interval = 3600;
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
            close: close
        });
        
        price = close;
    }
    
    return bars;
}

// Add ADX indicator to chart
function addADXToChart() {
    const chart = window.app.widget.activeChart();
    chart.createStudy('Directional Movement Index', false, false, [14, 14]);
    console.log('✓ ADX indicator added to chart');
}

// ========================================
// RUN ANALYSIS
// ========================================

// Option 1: Just add ADX indicator to chart
// addADXToChart();

// Option 2: Calculate ADX from data and show analysis
analyzeADX();