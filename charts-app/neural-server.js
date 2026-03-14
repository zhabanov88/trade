
'use strict';

const https = require('https');

// ═══════════════════════════════════════════════════════════════════
// MATH UTILITIES (без внешних зависимостей)
// ═══════════════════════════════════════════════════════════════════

const M = {
    mean: a => a.length ? a.reduce((s,x)=>s+x,0)/a.length : 0,
    std:  a => { const m=M.mean(a); return Math.sqrt(M.mean(a.map(x=>(x-m)**2))||0); },
    min:  a => Math.min(...a),
    max:  a => Math.max(...a),
    clamp:(v,lo,hi)=>Math.max(lo,Math.min(hi,v)),
    norm: (v,lo,hi)=>hi===lo?0:(v-lo)/(hi-lo),
    sigmoid: x=>1/(1+Math.exp(-Math.max(-500,Math.min(500,x)))),
    relu:    x=>Math.max(0,x),
    tanh:    x=>Math.tanh(x),
    dot:  (a,b)=>a.reduce((s,v,i)=>s+v*(b[i]||0),0),
    softmax: a=>{ const e=a.map(x=>Math.exp(x-Math.max(...a))); const s=e.reduce((t,v)=>t+v,0); return e.map(v=>v/s); },
};

// ═══════════════════════════════════════════════════════════════════
// FEATURE ENGINEERING — 25 признаков из OHLCV + тики
// ═══════════════════════════════════════════════════════════════════

function engineerFeatures(bars, idx) {
    if (idx < 20) return null;
    const b  = bars[idx];
    const p1 = bars[idx-1];
    const p5 = bars[idx-5];
    const window14 = bars.slice(Math.max(0,idx-14), idx+1);
    const window20 = bars.slice(Math.max(0,idx-20), idx+1);
    const window5  = bars.slice(Math.max(0,idx-5),  idx+1);

    const closes = window20.map(b=>parseFloat(b.close));
    const highs  = window20.map(b=>parseFloat(b.high));
    const lows   = window20.map(b=>parseFloat(b.low));
    const vols   = window20.map(b=>parseFloat(b.volume||0));
    const close  = parseFloat(b.close);
    const open   = parseFloat(b.open);
    const high   = parseFloat(b.high);
    const low    = parseFloat(b.low);
    const vol    = parseFloat(b.volume||0);

    // ── Trend features ─────────────────────────────────────────────
    const sma5  = M.mean(closes.slice(-5));
    const sma10 = M.mean(closes.slice(-10));
    const sma20 = M.mean(closes);
    const ema12 = calcEMA(closes, 12);
    const ema26 = calcEMA(closes, 26);

    // ── Momentum ───────────────────────────────────────────────────
    const roc5  = p5 ? (close - parseFloat(p5.close)) / parseFloat(p5.close) : 0;
    const roc1  = p1 ? (close - parseFloat(p1.close)) / parseFloat(p1.close) : 0;

    // ── RSI ────────────────────────────────────────────────────────
    const rsi14 = calcRSI(bars.slice(Math.max(0,idx-15), idx+1).map(b=>parseFloat(b.close)), 14);

    // ── Bollinger ─────────────────────────────────────────────────
    const bbMid = sma20;
    const bbStd = M.std(closes);
    const bbUpp = bbMid + 2 * bbStd;
    const bbLow = bbMid - 2 * bbStd;
    const bbPos = bbStd > 0 ? (close - bbLow) / (bbUpp - bbLow) : 0.5;
    const bbW   = bbStd > 0 ? (bbUpp - bbLow) / bbMid : 0;

    // ── ATR ────────────────────────────────────────────────────────
    const atr14 = calcATR(window14);
    const atrPct = close > 0 ? atr14 / close : 0;

    // ── Volume ────────────────────────────────────────────────────
    const volMa  = M.mean(vols.slice(-10));
    const volRel = volMa > 0 ? vol / volMa : 1;

    // ── Candle structure ──────────────────────────────────────────
    const candleRange = high - low;
    const body        = Math.abs(close - open);
    const bodyPct     = candleRange > 0 ? body / candleRange : 0;
    const upperWick   = high - Math.max(open, close);
    const lowerWick   = Math.min(open, close) - low;
    const wickRatio   = candleRange > 0 ? (upperWick - lowerWick) / candleRange : 0;
    const bullCandle  = close > open ? 1 : 0;

    // ── MACD ──────────────────────────────────────────────────────
    const macdLine  = ema12 - ema26;
    const macdNorm  = atr14 > 0 ? macdLine / atr14 : 0;

    // ── Stochastic ────────────────────────────────────────────────
    const h14 = Math.max(...highs);
    const l14 = Math.min(...lows);
    const stoch = h14 !== l14 ? (close - l14) / (h14 - l14) : 0.5;

    // ── Price position ────────────────────────────────────────────
    const pricePos20 = M.norm(close, Math.min(...closes), Math.max(...closes));

    // ── Tick features (если есть) ─────────────────────────────────
    let tickOFI=0, tickSpread=0, tickVelocity=0, tickBuySell=0;
    if (b.ticks && Array.isArray(b.ticks) && b.ticks.length > 2) {
        const ticks = b.ticks;
        const mids  = ticks.map(t=>t.mid||(t.ask+t.bid)/2);
        const spreads = ticks.map(t=>t.ask-t.bid);
        let up=0,dn=0;
        for(let i=1;i<mids.length;i++){
            const dm=mids[i]-mids[i-1],sp=spreads[i]||0.0001;
            tickOFI += sp>0?dm/sp:dm;
            if(mids[i]>mids[i-1]) up++; else dn++;
        }
        tickOFI /= (mids.length-1);
        tickSpread   = M.mean(spreads);
        tickVelocity = ticks.length;
        tickBuySell  = (up+dn)>0?(up-dn)/(up+dn):0;
    }

    return [
        // 0-3: Trend
        (close - sma5) / (atr14||1),
        (sma5  - sma20) / (atr14||1),
        (ema12 - ema26) / (atr14||1),
        pricePos20,
        // 4-6: Momentum
        M.clamp(roc1 * 100, -10, 10),
        M.clamp(roc5 * 100, -10, 10),
        M.clamp((rsi14 - 50) / 50, -1, 1),
        // 7-9: Volatility
        M.clamp(bbPos * 2 - 1, -1, 1),
        M.clamp(bbW * 10, 0, 5),
        M.clamp(atrPct * 1000, 0, 10),
        // 10-12: Volume
        M.clamp(Math.log(volRel+0.01), -3, 3),
        M.clamp(volRel - 1, -1, 3),
        0, // placeholder
        // 13-16: Candle
        bodyPct * 2 - 1,
        M.clamp(wickRatio, -1, 1),
        bullCandle * 2 - 1,
        M.clamp(macdNorm, -3, 3),
        // 17-18: Oscillators
        M.clamp(stoch * 2 - 1, -1, 1),
        M.clamp(atrPct / (M.mean(bars.slice(Math.max(0,idx-5),idx+1).map(b=>parseFloat(b.close)>0?(parseFloat(b.high)-parseFloat(b.low))/parseFloat(b.close):0))||atrPct||0.001) - 1, -3, 3),
        // 19-22: Tick features
        M.clamp(tickOFI * 10000, -5, 5),
        M.clamp(tickSpread * 10000, 0, 5),
        M.clamp(tickVelocity / 100, 0, 5),
        M.clamp(tickBuySell, -1, 1),
        // 23-24: Time context
        0, // будет заполнено
        0, // будет заполнено
    ];
}

function calcEMA(prices, period) {
    if (prices.length < period) return M.mean(prices);
    const k = 2 / (period + 1);
    let ema = M.mean(prices.slice(0, period));
    for (let i = period; i < prices.length; i++) {
        ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
}

function calcRSI(prices, period=14) {
    if (prices.length < period + 1) return 50;
    let gains=0, losses=0;
    for (let i = 1; i <= period; i++) {
        const d = prices[i] - prices[i-1];
        if (d>0) gains+=d; else losses-=d;
    }
    let avgG = gains/period, avgL = losses/period;
    for (let i = period+1; i < prices.length; i++) {
        const d = prices[i] - prices[i-1];
        avgG = (avgG*(period-1) + Math.max(0,d)) / period;
        avgL = (avgL*(period-1) + Math.max(0,-d)) / period;
    }
    return avgL === 0 ? 100 : 100 - 100 / (1 + avgG/avgL);
}

function calcATR(bars, period=14) {
    if (bars.length < 2) return 0;
    let trs = [];
    for (let i=1;i<bars.length;i++) {
        const h=parseFloat(bars[i].high), l=parseFloat(bars[i].low), pc=parseFloat(bars[i-1].close);
        trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
    }
    return M.mean(trs.slice(-period));
}

// ═══════════════════════════════════════════════════════════════════
// НЕЙРОСЕТЬ (MLP — Multi-Layer Perceptron)
// Архитектура: 25 → 64 → 32 → 16 → 3 (Buy/Hold/Sell)
// ═══════════════════════════════════════════════════════════════════

class NeuralNet {
    constructor(layers = [25, 64, 32, 16, 3]) {
        this.layers = layers;
        this.weights = [];
        this.biases  = [];
        this.init();
    }

    init() {
        for (let i = 0; i < this.layers.length - 1; i++) {
            const n = this.layers[i], m = this.layers[i+1];
            const scale = Math.sqrt(2/n);
            const W = [];
            for (let j = 0; j < m; j++) {
                const row = [];
                for (let k = 0; k < n; k++) row.push((Math.random()*2-1)*scale);
                W.push(row);
            }
            this.weights.push(W);
            this.biases.push(new Array(m).fill(0));
        }
    }

    forward(x) {
        let h = [...x];
        const acts = [h];
        for (let l = 0; l < this.weights.length; l++) {
            const W = this.weights[l], B = this.biases[l];
            const next = B.map((b,i) => {
                let s = b;
                for (let j=0;j<h.length;j++) s += W[i][j]*h[j];
                // ReLU для скрытых, softmax для последнего — обрабатывается снаружи
                return l < this.weights.length-1 ? M.relu(s) : s;
            });
            h = next;
            acts.push(h);
        }
        const probs = M.softmax(h);
        return { logits: h, probs, acts };
    }

    // Mini-batch SGD с momentum и L2
    train(X, Y, opts={}) {
        const lr     = opts.lr     || 0.001;
        const epochs = opts.epochs || 100;
        const bsz    = opts.batch  || 32;
        const lambda = opts.lambda || 0.0001;
        const momentum= opts.momentum || 0.9;

        // Velocity для momentum
        const velW = this.weights.map(W => W.map(row => new Array(row.length).fill(0)));
        const velB = this.biases.map(B => new Array(B.length).fill(0));

        const lossHistory = [];

        for (let ep = 0; ep < epochs; ep++) {
            // Shuffle
            const idx = Array.from({length:X.length},(_,i)=>i);
            for(let i=idx.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[idx[i],idx[j]]=[idx[j],idx[i]];}

            let totalLoss = 0;
            for (let b=0; b<X.length; b+=bsz) {
                const batch = idx.slice(b, b+bsz);
                // Accumulate gradients
                const dW = this.weights.map(W => W.map(row => new Array(row.length).fill(0)));
                const dB = this.biases.map(B => new Array(B.length).fill(0));

                for (const bi of batch) {
                    const x = X[bi], y = Y[bi]; // y = class index (0,1,2)
                    const {probs, acts} = this.forward(x);

                    // Cross-entropy loss
                    totalLoss -= Math.log(probs[y] + 1e-10);

                    // Output gradient
                    let delta = probs.map((p,i) => p - (i===y?1:0));

                    // Backprop
                    for (let l = this.weights.length-1; l >= 0; l--) {
                        const prevAct = acts[l];
                        const curAct  = acts[l+1];
                        const dPrev   = new Array(prevAct.length).fill(0);

                        for (let i=0; i<this.weights[l].length; i++) {
                            const g = delta[i] * (l < this.weights.length-1 ? (curAct[i]>0?1:0) : 1);
                            dB[l][i] += g;
                            for (let j=0; j<this.weights[l][i].length; j++) {
                                dW[l][i][j] += g * prevAct[j];
                                dPrev[j] += g * this.weights[l][i][j];
                            }
                        }
                        delta = dPrev;
                    }
                }

                // Update with momentum + L2
                const bLen = batch.length;
                for (let l=0; l<this.weights.length; l++) {
                    for (let i=0; i<this.weights[l].length; i++) {
                        velB[l][i] = momentum*velB[l][i] - lr*(dB[l][i]/bLen);
                        this.biases[l][i] += velB[l][i];
                        for (let j=0; j<this.weights[l][i].length; j++) {
                            velW[l][i][j] = momentum*velW[l][i][j] - lr*(dW[l][i][j]/bLen + lambda*this.weights[l][i][j]);
                            this.weights[l][i][j] += velW[l][i][j];
                        }
                    }
                }
            }

            lossHistory.push(totalLoss / X.length);
        }

        return lossHistory;
    }

    predict(x) {
        const {probs} = this.forward(x);
        const cls = probs.indexOf(Math.max(...probs));
        return { class: cls, probs, signal: ['BUY','HOLD','SELL'][cls] };
    }

    toJSON() {
        return { layers: this.layers, weights: this.weights, biases: this.biases };
    }

    static fromJSON(data) {
        const net = new NeuralNet(data.layers);
        net.weights = data.weights;
        net.biases  = data.biases;
        return net;
    }
}

// ═══════════════════════════════════════════════════════════════════
// НОРМАЛИЗАЦИЯ (Z-score по обучающей выборке)
// ═══════════════════════════════════════════════════════════════════

function computeNormParams(Xarr) {
    const dim = Xarr[0].length;
    const params = [];
    for (let d=0; d<dim; d++) {
        const col = Xarr.map(x=>x[d]);
        params.push({ mean: M.mean(col), std: M.std(col)||1 });
    }
    return params;
}

function normalize(x, params) {
    return x.map((v,i) => (v - params[i].mean) / params[i].std);
}

// ═══════════════════════════════════════════════════════════════════
// МЕТРИКИ
// ═══════════════════════════════════════════════════════════════════

function calcMetrics(Xte, Yte, net, normParams) {
    let correct=0, tp=0, fp=0, fn=0, tn=0;
    const predictions = [];

    for (let i=0; i<Xte.length; i++) {
        const xn = normalize(Xte[i], normParams);
        const {class:cls, probs} = net.predict(xn);
        const actual = Yte[i];
        if (cls === actual) correct++;

        // Binary: 0=BUY vs rest
        if (actual===0 && cls===0) tp++;
        if (actual!==0 && cls===0) fp++;
        if (actual===0 && cls!==0) fn++;
        if (actual!==0 && cls!==0) tn++;
        predictions.push({cls, probs, actual});
    }

    const acc  = correct / Xte.length;
    const prec = tp/(tp+fp+1e-10);
    const rec  = tp/(tp+fn+1e-10);
    const f1   = 2*prec*rec/(prec+rec+1e-10);

    // Confusion matrix
    const conf = [[0,0,0],[0,0,0],[0,0,0]];
    predictions.forEach(p => { conf[p.actual][p.cls]++; });

    return { acc, prec, rec, f1, conf, predictions };
}

// ═══════════════════════════════════════════════════════════════════
// CLAUDE API HELPER
// ═══════════════════════════════════════════════════════════════════

let _llmRouter = null;

async function callClaude(messages, systemPrompt, maxTokens=4096) {
    if (!_llmRouter) throw new Error('LLM router not initialized');
    if (!_llmRouter.isConfigured()) {
        throw new Error('LLM не настроен. Откройте вкладку ⚙️ LLM и выберите провайдера.');
    }
    return _llmRouter.chat(messages, systemPrompt, { maxTokens });
}

// ═══════════════════════════════════════════════════════════════════
// ХРАНИЛИЩЕ МОДЕЛЕЙ (в памяти, можно добавить PostgreSQL)
// ═══════════════════════════════════════════════════════════════════

const modelStore = {
    model: null,          // текущая нейросеть
    normParams: null,     // параметры нормализации
    trainMeta: null,      // метаданные обучения
    lastAnalysis: null,   // последний анализ данных
};

// ═══════════════════════════════════════════════════════════════════
// INIT — монтирует все роуты
// ═══════════════════════════════════════════════════════════════════

function init(app, clickhouse, pgPool, requireAuth, llmRouter) {
    _llmRouter = llmRouter;

    // ── 1. DEEP DATA ANALYSIS ──────────────────────────────────────

    app.post('/api/neural/analyze', requireAuth, async (req, res) => {
        const { ticker, table, fromDate, toDate, sampleSize = 2000 } = req.body;
        if (!ticker || !table) return res.status(400).json({error:'Missing ticker/table'});

        try {
            const isTicksTable = table.includes('_from_ticks') || table.includes('mv_market_data');
            const ticksSel     = isTicksTable ? ',\n                ticks' : '';

            const q = `
                SELECT window_start as timestamp, open, high, low, close, volume${ticksSel}
                FROM ${table}
                WHERE ticker = {ticker:String}
                ${fromDate ? `AND toDate(window_start) >= '${fromDate}'` : ''}
                ${toDate   ? `AND toDate(window_start) <= '${toDate}'`   : ''}
                ORDER BY window_start ASC
                LIMIT ${sampleSize}
            `;

            const rs   = await clickhouse.query({ query: q, format:'JSONEachRow', query_params:{ticker} });
            const bars = await rs.json();

            if (bars.length < 50) return res.status(400).json({error:`Not enough data (${bars.length} bars)`});

            // Parse ticks if present
            if (isTicksTable) {
                bars.forEach(b => {
                    if (typeof b.ticks === 'string') {
                        try { b.ticks = JSON.parse(b.ticks); } catch(_) { b.ticks = []; }
                    }
                });
            }

            // Extract all features
            const features = [];
            for (let i = 20; i < bars.length; i++) {
                const f = engineerFeatures(bars, i);
                if (f) features.push({ features: f, bar: bars[i], nextReturn: i+1<bars.length ? (parseFloat(bars[i+1].close)-parseFloat(bars[i].close))/parseFloat(bars[i].close) : 0 });
            }

            // Statistical analysis
            const returns    = features.map(f=>f.nextReturn);
            const closes     = bars.map(b=>parseFloat(b.close));
            const volumes    = bars.map(b=>parseFloat(b.volume||0));
            const withTicks  = bars.filter(b=>b.ticks&&Array.isArray(b.ticks)&&b.ticks.length>0);

            // Trend detection
            const last50  = closes.slice(-50);
            const trend50 = (last50[last50.length-1]-last50[0])/last50[0];
            const volatility = M.std(returns) * Math.sqrt(252);
            const sharpe    = M.mean(returns) / (M.std(returns)||0.001) * Math.sqrt(252);
            const maxDD     = calcMaxDrawdown(closes);

            // Feature correlation with returns
            const featNames = ['trend_5_sma','sma_cross','macd_norm','price_pos','roc_1','roc_5','rsi_norm',
                               'bb_pos','bb_width','atr_pct','vol_log','vol_rel','placeholder',
                               'body_pct','wick_ratio','bull_candle','macd_hist','stoch_norm','vol_regime',
                               'tick_ofi','tick_spread','tick_velocity','tick_buysell','time1','time2'];
            const featCorrs = featNames.map((name, fi) => {
                const fvals = features.map(f=>f.features[fi]||0);
                const rets  = features.map(f=>f.nextReturn);
                return { name, corr: pearsonCorr(fvals, rets) };
            }).sort((a,b)=>Math.abs(b.corr)-Math.abs(a.corr));

            // Market regime detection
            const regime = detectRegime(bars.slice(-100));

            // Distribution analysis
            const posRet = returns.filter(r=>r>0).length / returns.length;

            const analysis = {
                ticker, table,
                bars: bars.length,
                withTicks: withTicks.length,
                dateRange: { from: bars[0].timestamp, to: bars[bars.length-1].timestamp },
                stats: {
                    trend50: (trend50*100).toFixed(2)+'%',
                    volatility: (volatility*100).toFixed(1)+'%',
                    sharpe: sharpe.toFixed(3),
                    maxDrawdown: (maxDD*100).toFixed(1)+'%',
                    positiveReturns: (posRet*100).toFixed(1)+'%',
                    meanReturn: (M.mean(returns)*10000).toFixed(2)+'bps',
                    stdReturn: (M.std(returns)*10000).toFixed(2)+'bps',
                },
                regime,
                topFeatures: featCorrs.slice(0,10),
                ticksAvailable: withTicks.length > 0,
                featureCount: features.length,
            };

            modelStore.lastAnalysis = { bars, features, analysis };
            res.json(analysis);
        } catch(e) {
            console.error('[Neural/analyze]', e);
            res.status(500).json({error:e.message});
        }
    });

    // ── 2. TRAIN NEURAL NET ────────────────────────────────────────

    app.post('/api/neural/train', requireAuth, async (req, res) => {
        const { ticker, table, fromDate, toDate, config = {} } = req.body;
        const {
            epochs     = 150,
            batchSize  = 32,
            lr         = 0.001,
            trainSplit = 0.8,
            layers     = [25, 64, 32, 16, 3],
            labelMode  = 'direction', // direction | quantile | combined
            sampleSize = 3000,
        } = config;

        if (!ticker || !table) return res.status(400).json({error:'Missing ticker/table'});

        try {
            // Load data
            const isTicksTable = table.includes('_from_ticks') || table.includes('mv_market_data');
            const ticksSel     = isTicksTable ? ',\n                ticks' : '';
            const q = `
                SELECT window_start as timestamp, open, high, low, close, volume${ticksSel}
                FROM ${table}
                WHERE ticker = {ticker:String}
                ${fromDate ? `AND toDate(window_start) >= '${fromDate}'` : ''}
                ${toDate   ? `AND toDate(window_start) <= '${toDate}'`   : ''}
                ORDER BY window_start ASC
                LIMIT ${sampleSize}
            `;
            const rs   = await clickhouse.query({query:q, format:'JSONEachRow', query_params:{ticker}});
            const bars = await rs.json();

            if (bars.length < 100) return res.status(400).json({error:'Not enough data'});

            if (isTicksTable) {
                bars.forEach(b=>{ if(typeof b.ticks==='string'){try{b.ticks=JSON.parse(b.ticks);}catch(_){b.ticks=[];}} });
            }

            // Build dataset
            const X=[],Y=[];
            for (let i=20; i<bars.length-1; i++) {
                const f = engineerFeatures(bars, i);
                if (!f) continue;
                const nextClose = parseFloat(bars[i+1].close);
                const curClose  = parseFloat(bars[i].close);
                const ret = (nextClose - curClose) / curClose;

                let label;
                if (labelMode === 'direction') {
                    label = ret > 0.0002 ? 0 : ret < -0.0002 ? 2 : 1; // BUY/HOLD/SELL
                } else if (labelMode === 'quantile') {
                    // Will compute after collecting all returns
                    label = ret;
                } else {
                    label = ret > 0.001 ? 0 : ret < -0.001 ? 2 : 1;
                }

                X.push(f);
                Y.push(label);
            }

            // Quantile labeling
            if (labelMode === 'quantile') {
                const rets = [...Y].sort((a,b)=>a-b);
                const q33  = rets[Math.floor(rets.length*0.33)];
                const q67  = rets[Math.floor(rets.length*0.67)];
                Y.forEach((r,i)=>{ Y[i] = r > q67 ? 0 : r < q33 ? 2 : 1; });
            }

            // Normalize features
            const normParams = computeNormParams(X);
            const Xn = X.map(x => normalize(x, normParams));

            // Split
            const si  = Math.floor(Xn.length * trainSplit);
            const Xtr = Xn.slice(0, si), Ytr = Y.slice(0, si);
            const Xte = Xn.slice(si),    Yte = Y.slice(si);

            // Class balance
            const classCounts = [0,0,0];
            Ytr.forEach(y=>classCounts[y]++);

            // Train
            const net      = new NeuralNet(layers);
            const t0       = Date.now();
            const lossHist = net.train(Xtr, Ytr, {lr, epochs, batch:batchSize, lambda:0.0001, momentum:0.9});
            const trainMs  = Date.now() - t0;

            // Evaluate
            const metrics  = calcMetrics(Xte, Yte, net, normParams);

            // Save model
            modelStore.model      = net;
            modelStore.normParams = normParams;
            modelStore.trainMeta  = {
                ticker, table, layers, epochs, lr, batchSize,
                trainSplit, labelMode, sampleSize,
                bars: bars.length, features: X.length,
                classCounts, trainMs,
                trainedAt: new Date().toISOString(),
            };

            // Save to PostgreSQL (Greenplum-compatible: DELETE+INSERT instead of ON CONFLICT)
            try {
                await pgPool.query(
                    `DELETE FROM neural_models WHERE ticker=$1 AND table_name=$2`,
                    [ticker, table]
                );
                await pgPool.query(
                    `INSERT INTO neural_models (ticker, table_name, config, weights_json, metrics, trained_at)
                     VALUES ($1, $2, $3, $4, $5, NOW())`,
                    [ticker, table, JSON.stringify({layers,epochs,lr,labelMode}),
                     JSON.stringify(net.toJSON()), JSON.stringify(metrics)]
                );
            } catch(pgErr) {
                console.warn('[Neural/train] PG save skipped:', pgErr.message);
            }

            res.json({
                success: true,
                meta:    modelStore.trainMeta,
                metrics: { acc: metrics.acc, prec: metrics.prec, rec: metrics.rec, f1: metrics.f1, conf: metrics.conf },
                lossHistory: lossHistory.filter((_,i)=>i%5===0), // каждый 5-й epoch
                classCounts,
            });
        } catch(e) {
            console.error('[Neural/train]', e);
            res.status(500).json({error:e.message});
        }
    });

    // ── 3. PREDICT ─────────────────────────────────────────────────

    app.post('/api/neural/predict', requireAuth, async (req, res) => {
        const { bars } = req.body; // последние N баров с клиента
        if (!modelStore.model) return res.status(400).json({error:'Model not trained yet'});
        if (!bars || bars.length < 25) return res.status(400).json({error:'Need at least 25 bars'});

        try {
            const f   = engineerFeatures(bars, bars.length-1);
            if (!f) return res.status(400).json({error:'Cannot extract features'});
            const xn  = normalize(f, modelStore.normParams);
            const pred = modelStore.model.predict(xn);

            // Feature importance (SHAP-like: ablation)
            const baseline = modelStore.model.forward(xn).probs;
            const shap = f.map((_,fi) => {
                const xp  = [...xn]; xp[fi] = 0;
                const fp  = modelStore.model.forward(xp).probs;
                return baseline[pred.class] - fp[pred.class];
            });

            res.json({
                signal:   pred.signal,
                class:    pred.class,
                probs:    { buy: pred.probs[0], hold: pred.probs[1], sell: pred.probs[2] },
                confidence: Math.max(...pred.probs),
                features: f,
                featureImportance: shap,
                meta: modelStore.trainMeta,
            });
        } catch(e) {
            console.error('[Neural/predict]', e);
            res.status(500).json({error:e.message});
        }
    });

    // ── 4. GENERATE STRATEGY (Claude API) ─────────────────────────

    app.post('/api/neural/generate', requireAuth, async (req, res) => {
        const { prompt, analysisContext, tradeHistory, preferences } = req.body;

        try {
            const analysis = analysisContext || modelStore.lastAnalysis?.analysis;

            const systemPrompt = `You are an expert quantitative trading strategist and JavaScript developer.
You specialize in creating algorithmic trading strategies for Forex markets.

Your task is to generate complete, executable JavaScript trading strategy code.

The code runs in a context where:
- window.app.activedata = array of OHLCV bars with optional .ticks array
- Each bar: { timestamp, open, high, low, close, volume, ticks: [{ts, ask, bid, mid},...] }
- window.app.setups = {} // you fill this with your setup definitions
- Signals: bar['strategy_name'] = 0 (no signal), 1 (entry), 2 (hold), 3 (TP exit), 4 (SL exit)

ALWAYS output ONLY valid JavaScript code wrapped in:
\`\`\`javascript
// code here
\`\`\`

Strategy must:
1. Loop through window.app.activedata
2. Calculate indicators
3. Set signal values on each bar
4. Register window.app.setups with the strategy name
5. Use only native JS (no external libraries)
6. Work efficiently (avoid O(n²) where possible)

Available tick data per bar (if loaded): bar.ticks = [{ts, ask, bid, mid, ask_ex, bid_ex}]
Use tick data for: spread analysis, order flow imbalance, velocity, buy/sell pressure`;

            const userMessage = `
Market context:
${analysis ? JSON.stringify({
    ticker:    analysis.ticker,
    regime:    analysis.regime,
    stats:     analysis.stats,
    topFeatures: analysis.topFeatures?.slice(0,5),
    ticksAvailable: analysis.ticksAvailable,
}, null, 2) : 'No analysis available yet'}

${tradeHistory ? `Recent backtest results: ${JSON.stringify(tradeHistory, null, 2)}` : ''}

User request: ${prompt || 'Generate a robust mean-reversion strategy using tick data and OHLCV indicators'}

Preferences: ${preferences ? JSON.stringify(preferences) : 'No specific preferences'}

Generate a complete trading strategy. Include:
1. Strategy name and description in comments
2. All indicator calculations
3. Entry/exit signal logic
4. Explanation of the logic in comments
5. What market conditions it works best in`;

            const response = await callClaude(
                [{ role:'user', content: userMessage }],
                systemPrompt,
                4096
            );

            // Extract code block
            const codeMatch = response.match(/```(?:javascript|js)?\n([\s\S]+?)```/);
            const code      = codeMatch ? codeMatch[1].trim() : response;

            // Extract description
            const descLines = response.split('\n').filter(l=>l.startsWith('//') && !l.includes('==='));
            const description = descLines.slice(0,3).join('\n') || 'AI Generated Strategy';

            // Extract strategy name from code
            const nameMatch = code.match(/['"]([^'"]{3,50})['"]\s*:/);
            const stratName = nameMatch ? nameMatch[1] : 'ai_strategy_' + Date.now();

            res.json({ code, description, strategyName: stratName, fullResponse: response });
        } catch(e) {
            console.error('[Neural/generate]', e);
            res.status(500).json({error: e.message});
        }
    });

    // ── 5. BACKTEST GENERATED STRATEGY ────────────────────────────

    app.post('/api/neural/backtest-strategy', requireAuth, async (req, res) => {
        const { code, ticker, table, fromDate, toDate, capital=10000, riskPct=1, leverage=1 } = req.body;
        if (!code || !ticker || !table) return res.status(400).json({error:'Missing params'});

        try {
            const q = `
                SELECT window_start as timestamp, open, high, low, close, volume
                FROM ${table}
                WHERE ticker = {ticker:String}
                ${fromDate ? `AND toDate(window_start) >= '${fromDate}'` : ''}
                ${toDate   ? `AND toDate(window_start) <= '${toDate}'`   : ''}
                ORDER BY window_start ASC
                LIMIT 5000
            `;
            const rs   = await clickhouse.query({query:q, format:'JSONEachRow', query_params:{ticker}});
            const bars = await rs.json();

            if (bars.length < 50) return res.status(400).json({error:'Not enough data'});

            // Run JS code in sandbox
            const vm = require('vm');
            const sandbox = {
                window: { app: { activedata: bars, setups: {} } },
                console: { log:()=>{}, warn:()=>{}, error:()=>{} },
                Math, Date, JSON, parseInt, parseFloat, isNaN, Number, String, Array, Object, Infinity,
            };

            try {
                vm.runInNewContext(code, sandbox, { timeout: 10000 });
            } catch(vmErr) {
                return res.status(400).json({error:'Strategy code error: '+vmErr.message});
            }

            const setups = sandbox.window.app.setups;
            if (!Object.keys(setups).length) {
                return res.status(400).json({error:'Strategy did not register any setups in window.app.setups'});
            }

            // Simple backtest
            const trades    = [];
            let   cap       = capital;
            const setupName = Object.keys(setups)[0];
            const colName   = setups[setupName]?.column || setupName;

            let   position  = null;
            bars.forEach((bar, i) => {
                const sig = bar[colName];
                const close = parseFloat(bar.close);
                if (!position && sig === 1) {
                    const risk  = cap * (riskPct/100) * leverage;
                    const sl    = close * 0.99;
                    const tp    = close * 1.02;
                    position    = { entry: close, sl, tp, risk, bars: 0, ts: bar.timestamp };
                } else if (position) {
                    position.bars++;
                    let exitPrice = null, exitReason = '';
                    if (close <= position.sl)                          { exitPrice=position.sl; exitReason='SL'; }
                    else if (close >= position.tp)                     { exitPrice=position.tp; exitReason='TP'; }
                    else if (sig === 3 || sig === 4)                   { exitPrice=close; exitReason='Signal'; }
                    else if (position.bars >= 20)                      { exitPrice=close; exitReason='Timeout'; }

                    if (exitPrice) {
                        const pnlPct = (exitPrice - position.entry) / position.entry;
                        const pnl    = position.risk * pnlPct * leverage;
                        cap         += pnl;
                        trades.push({ entry: position.entry, exit: exitPrice, pnl, pnlPct, exitReason,
                                      entryTs: position.ts, exitTs: bar.timestamp, bars: position.bars, capital: cap });
                        position    = null;
                    }
                }
            });

            // Stats
            const wins   = trades.filter(t=>t.pnl>0);
            const losses = trades.filter(t=>t.pnl<=0);
            const totalPnl = trades.reduce((s,t)=>s+t.pnl,0);
            const winRate  = trades.length ? (wins.length/trades.length*100).toFixed(1) : 0;
            const avgWin   = wins.length   ? M.mean(wins.map(t=>t.pnl)).toFixed(2) : 0;
            const avgLoss  = losses.length ? M.mean(losses.map(t=>t.pnl)).toFixed(2) : 0;
            const pf       = losses.length && Math.abs(avgLoss)>0 ? (Math.abs(wins.reduce((s,t)=>s+t.pnl,0))/Math.abs(losses.reduce((s,t)=>s+t.pnl,0))).toFixed(2) : '∞';

            res.json({
                stats: { trades: trades.length, winRate, totalPnl: totalPnl.toFixed(2),
                         avgWin, avgLoss, profitFactor: pf,
                         endCapital: cap.toFixed(2), return: ((cap-capital)/capital*100).toFixed(2)+'%' },
                trades: trades.slice(-50),
                setupName,
            });
        } catch(e) {
            console.error('[Neural/backtest-strategy]', e);
            res.status(500).json({error:e.message});
        }
    });

    // ── 6. STRATEGIES CRUD ─────────────────────────────────────────

    app.get('/api/neural/strategies', requireAuth, async (req, res) => {
        try {
            const r = await pgPool.query(
                `SELECT id, name, description, code, backtest_stats, rating, created_at, updated_at
                 FROM neural_strategies ORDER BY rating DESC NULLS LAST, created_at DESC LIMIT 50`
            );
            res.json(r.rows);
        } catch(e) { res.status(500).json({error:e.message}); }
    });

    app.post('/api/neural/strategies', requireAuth, async (req, res) => {
        const { name, description, code, backtestStats, source='manual' } = req.body;
        if (!name || !code) return res.status(400).json({error:'name and code required'});
        try {
            const r = await pgPool.query(
                `INSERT INTO neural_strategies (name, description, code, backtest_stats, source, created_by)
                 VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
                [name, description||'', code, JSON.stringify(backtestStats||{}), source, req.session.userId]
            );
            res.json(r.rows[0]);
        } catch(e) { res.status(500).json({error:e.message}); }
    });

    app.put('/api/neural/strategies/:id', requireAuth, async (req, res) => {
        const { rating, name, description, code } = req.body;
        try {
            const r = await pgPool.query(
                `UPDATE neural_strategies SET rating=$1, name=COALESCE($2,name), description=COALESCE($3,description),
                 code=COALESCE($4,code), updated_at=NOW() WHERE id=$5 RETURNING *`,
                [rating, name, description, code, req.params.id]
            );
            res.json(r.rows[0]);
        } catch(e) { res.status(500).json({error:e.message}); }
    });

    app.delete('/api/neural/strategies/:id', requireAuth, async (req, res) => {
        try {
            await pgPool.query('DELETE FROM neural_strategies WHERE id=$1', [req.params.id]);
            res.json({success:true});
        } catch(e) { res.status(500).json({error:e.message}); }
    });

    // ── 7. INDICATOR DISCOVERY ─────────────────────────────────────

    app.post('/api/neural/indicators', requireAuth, async (req, res) => {
        const { context, currentIndicators } = req.body;
        try {
            const analysis = modelStore.lastAnalysis?.analysis;
            const response = await callClaude([{
                role:'user',
                content:`
Based on this market analysis:
${JSON.stringify(analysis?.stats||{}, null, 2)}
Current regime: ${JSON.stringify(analysis?.regime||{}, null, 2)}
Top correlated features: ${JSON.stringify(analysis?.topFeatures?.slice(0,5)||[], null, 2)}
Tick data available: ${analysis?.ticksAvailable ? 'YES' : 'NO'}
Current indicators used: ${currentIndicators || 'standard OHLCV'}
User context: ${context || 'Looking for alpha signals'}

Suggest 5 innovative, non-standard trading indicators. For each:
1. Name and mathematical formula
2. Why it might have edge in current market conditions
3. JavaScript implementation (function that takes bars array, returns value)
4. Expected signal type (momentum/mean-reversion/volatility/tick-based)

Focus on lesser-known indicators that could provide genuine alpha.`
            }],
            `You are a quantitative researcher specializing in technical analysis and market microstructure.
You create novel trading indicators. Always provide complete JavaScript implementations.`
            );
            res.json({ response, suggestions: response });
        } catch(e) {
            console.error('[Neural/indicators]', e);
            res.status(500).json({error:e.message});
        }
    });

    // ── 8. AI CHAT ─────────────────────────────────────────────────

    app.post('/api/neural/chat', requireAuth, async (req, res) => {
        const { messages, appContext } = req.body;
        if (!messages?.length) return res.status(400).json({error:'messages required'});

        try {
            const analysis = modelStore.lastAnalysis?.analysis;
            const ctx = appContext || {};

            function line(label, val) { return val != null ? label + ': ' + val : ''; }
            function section(title, lines) {
                const content = lines.filter(Boolean).join('\n');
                return content ? '\n=== ' + title + ' ===\n' + content : '';
            }

            const parts = [
                'Ты — экспертный AI-аналитик профессиональной Forex торговой платформы.',
                'Отвечай на русском языке. Будь конкретен — ссылайся на реальные числа из данных ниже.',
                'Когда предлагаешь стратегии — давай полные рабочие JavaScript реализации.',
            ];

            if (ctx.ticker) {
                parts.push(section('АКТИВНЫЙ ИНСТРУМЕНТ', [
                    line('Тикер', ctx.ticker),
                    line('ClickHouse тикер', ctx.chTicker),
                    line('Интервал', ctx.intervalCode),
                    line('Таблица', ctx.table),
                    line('Текущая цена', ctx.currentPrice),
                ]));
            }

            if (ctx.barsTotal) {
                const barsLines = [
                    line('Загружено баров', ctx.barsTotal),
                    line('Период', ctx.barsFrom + ' → ' + ctx.barsTo),
                    'Последние бары (O/H/L/C):',
                ];
                (ctx.lastBars || []).forEach(function(b) {
                    barsLines.push('  ' + b.ts + ': O=' + b.o + ' H=' + b.h + ' L=' + b.l + ' C=' + b.c + ' V=' + b.v);
                });
                parts.push(section('ДАННЫЕ НА ГРАФИКЕ', barsLines));
            }

            if (ctx.activeSetups && ctx.activeSetups.length) {
                const setupLines = ['Количество: ' + ctx.activeSetups.length];
                ctx.activeSetups.forEach(function(s) {
                    setupLines.push('  • ' + s.name + ' (колонка: ' + s.column + ')' + (s.description ? ' — ' + s.description : ''));
                });
                parts.push(section('АКТИВНЫЕ СЕТАПЫ', setupLines));
            }

            if (ctx.backtest) {
                const bt = ctx.backtest;
                const st = bt.stats || {};
                const btLines = [
                    line('Инструмент', bt.ticker),
                    line('Период', (bt.fromDate || '?') + ' → ' + (bt.toDate || '?')),
                    line('Всего сделок', bt.trades),
                    line('Win Rate', st.winRate + '%'),
                    line('Total PnL', '$' + st.totalPnl),
                    line('Profit Factor', st.profitFactor),
                    line('Max Drawdown', st.maxDrawdown),
                    line('Avg Win / Avg Loss', '$' + st.avgWin + ' / $' + st.avgLoss),
                    line('Return', st.return),
                ];
                if (bt.lastTrades && bt.lastTrades.length) {
                    btLines.push('Последние ' + bt.lastTrades.length + ' сделок:');
                    bt.lastTrades.forEach(function(t) {
                        btLines.push('  ' + (t.setup||'?') + ': ' + t.entry + '→' + t.exit +
                            ' PnL=$' + t.pnl + ' (' + t.pnlPct + ') ' + t.reason + ' ' + t.bars + 'баров');
                    });
                }
                parts.push(section('РЕЗУЛЬТАТЫ БЭКТЕСТА', btLines));
            }

            if (ctx.walkForward) {
                const wf = ctx.walkForward;
                parts.push(section('WALK-FORWARD', [
                    line('Окон', wf.windows),
                    line('OOS Win Rate', wf.oosWinRate + '%'),
                    line('OOS Profit Factor', wf.oosPf),
                    line('Стабильность', wf.stability),
                ]));
            }

            if (ctx.neuralAnalysis) {
                const na = ctx.neuralAnalysis;
                const naLines = [
                    line('Тикер', na.ticker),
                    line('Режим рынка', na.regime && na.regime.type + ' (conf: ' + Math.round((na.regime.confidence||0)*100) + '%)'),
                    line('Тренд 50 баров', na.stats && na.stats.trend50),
                    line('Волатильность', na.stats && na.stats.volatility),
                    line('Sharpe', na.stats && na.stats.sharpe),
                    line('Max Drawdown', na.stats && na.stats.maxDrawdown),
                    line('Win Rate исторический', na.stats && na.stats.positiveReturns),
                    line('Тик-данные', na.ticksAvail ? 'ДА' : 'НЕТ'),
                ];
                if (na.topFeatures && na.topFeatures.length) {
                    naLines.push('Топ признаки (корреляция с доходностью):');
                    na.topFeatures.forEach(function(f) {
                        naLines.push('  ' + f.name + ': ' + (f.corr||0).toFixed(4));
                    });
                }
                parts.push(section('NEURAL DEEP ANALYSIS', naLines));
            }

            if (ctx.neuralModel) {
                parts.push(section('НЕЙРОСЕТЕВАЯ МОДЕЛЬ', [
                    line('Обучена на', ctx.neuralModel.trainedOn),
                    line('Режим меток', ctx.neuralModel.labelMode),
                    line('Дата', ctx.neuralModel.trainedAt),
                ]));
            }

            if (ctx.lastPrediction) {
                const p = ctx.lastPrediction;
                parts.push(section('ПОСЛЕДНИЙ ПРОГНОЗ', [
                    line('Сигнал', p.signal + ' (уверенность: ' + p.confidence + ')'),
                    p.probs ? 'BUY=' + Math.round((p.probs.buy||0)*100) + '% HOLD=' + Math.round((p.probs.hold||0)*100) + '% SELL=' + Math.round((p.probs.sell||0)*100) + '%' : '',
                ]));
            }

            // Серверный анализ из modelStore
            if (analysis) {
                parts.push(section('СЕРВЕРНЫЙ АНАЛИЗ (Neural)', [
                    line('Режим', analysis.regime && analysis.regime.type),
                    analysis.stats ? JSON.stringify(analysis.stats) : '',
                ]));
            }

            const systemPrompt = parts.join('\n');

            const response = await callClaude(messages, systemPrompt, 3000);
            res.json({ response });
        } catch(e) {
            console.error('[Neural/chat]', e);
            res.status(500).json({error:e.message});
        }
    });

    // ── 9. MODEL STATUS ────────────────────────────────────────────

    app.get('/api/neural/status', requireAuth, (req, res) => {
        res.json({
            modelLoaded:  !!modelStore.model,
            trainMeta:     modelStore.trainMeta,
            hasAnalysis:   !!modelStore.lastAnalysis,
            analysisStats: modelStore.lastAnalysis?.analysis?.stats || null,
        });
    });

    console.log('[NeuralSystem] ✅ Routes mounted: /api/neural/*');
}

// ═══════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

function detectRegime(bars) {
    if (bars.length < 20) return {type:'unknown', confidence:0};
    const closes = bars.map(b=>parseFloat(b.close));
    const returns = closes.slice(1).map((c,i)=>(c-closes[i])/closes[i]);
    const sma20   = M.mean(closes);
    const last    = closes[closes.length-1];
    const vol20   = M.std(returns) * Math.sqrt(252);
    const trend   = (last - closes[0]) / closes[0];
    const atrs    = bars.slice(1).map((b,i)=>parseFloat(b.high)-parseFloat(b.low));
    const atrRel  = M.mean(atrs) / (M.mean(closes)||1);

    if (Math.abs(trend) > 0.02 && vol20 < 0.3) {
        return { type: trend>0?'trending_up':'trending_down', confidence:0.75, trend, volatility:vol20 };
    } else if (vol20 > 0.4) {
        return { type:'volatile', confidence:0.8, trend, volatility:vol20 };
    } else if (Math.abs(trend) < 0.005) {
        return { type:'ranging', confidence:0.7, trend, volatility:vol20 };
    }
    return { type:'neutral', confidence:0.5, trend, volatility:vol20 };
}

function calcMaxDrawdown(prices) {
    let peak = prices[0], maxDD = 0;
    for (const p of prices) {
        if (p > peak) peak = p;
        const dd = (peak - p) / peak;
        if (dd > maxDD) maxDD = dd;
    }
    return maxDD;
}

function pearsonCorr(x, y) {
    const mx=M.mean(x), my=M.mean(y);
    const num=x.reduce((s,xi,i)=>s+(xi-mx)*(y[i]-my),0);
    const den=Math.sqrt(x.reduce((s,xi)=>s+(xi-mx)**2,0)*y.reduce((s,yi)=>s+(yi-my)**2,0));
    return den>0 ? num/den : 0;
}

function lossHistory() { return []; } // placeholder

module.exports = { init };