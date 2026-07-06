/**
 * walkforward-ui.js  v2.0
 *
 * Walk-Forward Analysis + Monte Carlo Simulation
 * Встраивается в #sb-tabbar как 4-я вкладка "⚗ WF/MC"
 * (рядом с Data / Setups / Backtest из setups-backtest.js)
 *
 * Подключение в index.html ПОСЛЕ setups-backtest.js:
 *   <script src="walkforward-ui.js"></script>
 */

if (window._wfLoaded) {} else { window._wfLoaded = true; (function () {
    'use strict';
    
    const WF = {
        wfRunning: false, wfResult: null, wfTab: 'overview',
        mcRunning: false, mcResult: null, mcTab: 'equity',
        progress: 0, progressMsg: '',
        cfg: loadCfg(),
        charts: {},
    };
    
    function loadCfg() {
        try { return Object.assign(defaultCfg(), JSON.parse(localStorage.getItem('wf_cfg') || '{}')); }
        catch(_) { return defaultCfg(); }
    }
    function saveCfg(c) { try { localStorage.setItem('wf_cfg', JSON.stringify(c)); } catch(_) {} }
    function defaultCfg() {
        return { wfWindows:5, inSamplePct:70, anchoredStart:false, opt_slValue:true, opt_tpValue:true, opt_riskPct:false, slValueRange:'0.5,1,1.5,2', tpValueRange:'1.5,2,3', riskPctRange:'0.5,1,2', mcSimulations:1000 };
    }
    
    function esc(s) { return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    function fmtDate(ts) { if(!ts) return '—'; try{return new Date(ts).toISOString().slice(0,10);}catch(_){return String(ts).slice(0,10);} }
    function fmtPct(v) { const n=parseFloat(v); if(isNaN(n)) return '<span class="wf-na">—</span>'; return `<span class="${n>=0?'wf-pos':'wf-neg'}">${n>=0?'+':''}${n.toFixed(1)}%</span>`; }
    function fmtMoney(v) { const n=parseFloat(v); if(isNaN(n)) return '<span class="wf-na">—</span>'; return `<span class="${n>=0?'wf-pos':'wf-neg'}">${n>=0?'+':''}$${Math.abs(n).toFixed(0)}</span>`; }
    
    function getBTCfg() {
        // Приоритет 1: правильный экспорт из setups-backtest.js (если патч применён)
        if (window.SB_CFG) return window.SB_CFG();
    
        // Приоритет 2: читаем напрямую из widget + datafeed (как в setups-backtest.js строки 1084-1085)
        const chart      = window.app?.widget?.activeChart?.();
        const symbol     = chart?.symbol?.() || '';
        const resolution = chart?.resolution?.() || '1';
        const datafeed   = window.app?.datafeed;
    
        // ticker: symbol → clickhouse_ticker через datafeed.symbols
        let ticker = symbol;
        if (datafeed?.symbols) {
            const sym  = symbol.split(':').pop().replace('USD','').replace('-USD','');
            const info = datafeed.symbols?.get?.(sym);
            if (info?.clickhouse_ticker) ticker = info.clickhouse_ticker;
        }
    
        // table: через datafeed.getClickHouseTable
        let table = 'market_data_minute';
        if (datafeed?.getClickHouseTable) {
            table = datafeed.getClickHouseTable(resolution);
        }
    
        return { ticker, table, capital:10000, riskPct:1, leverage:1, slMode:'pct', slValue:1, tpMode:'rr', tpValue:2, maxBars:50, direction:'both', useColExit:true, setupCols:{}, fromDate:null, toDate:null };
    }
    function getTrades() { return window.SB_TRADES ? window.SB_TRADES() : []; }
    function validateCfg(cfg) {
        if (!cfg.ticker) return 'Ticker not found. Open the chart and make sure data is loading (check Data tab).';
        if (!cfg.table)  return 'Table not found. Make sure the chart has loaded data.';
        if (!cfg.setupCols || !Object.keys(cfg.setupCols).length) return 'No setups found. Run a script in the Code panel first, then check Setups tab.';
        return null;
    }
    
    // ════════════════════════════════════════════════════════════════
    // INJECT TAB INTO #sb-tabbar (same pattern as setups-backtest.js)
    // ════════════════════════════════════════════════════════════════
    
    function injectTab() {
        const timer = setInterval(() => {
            const tabbar = document.getElementById('sb-tabbar');
            const body   = document.getElementById('sb-tab-body');
            if (!tabbar || !body) return;
            clearInterval(timer);
            if (document.getElementById('sb-tab-wf')) return;
    
            injectCSS();
    
            const btn = document.createElement('button');
            btn.id = 'sb-tab-wf';
            btn.className = 'sb-tab sb-tab-wfmc';
            btn.dataset.tab = 'wfmc';
            btn.textContent = '⚗ WF / MC';
            tabbar.appendChild(btn);
    
            btn.addEventListener('click', () => {
                const twrap = document.getElementById('dt-twrap');
                tabbar.querySelectorAll('.sb-tab').forEach(b => b.classList.remove('sb-tab-active'));
                btn.classList.add('sb-tab-active');
                if (twrap) twrap.style.display = 'none';
                body.style.display = 'flex';
                renderWFPanel(body);
            });
        }, 200);
    }
    
    // ════════════════════════════════════════════════════════════════
    // RENDER
    // ════════════════════════════════════════════════════════════════
    
    function renderWFPanel(body) {
        Object.values(WF.charts).forEach(c => { try{c.destroy();}catch(_){} });
        WF.charts = {};
        body.innerHTML = `<div class="wf-root"><div class="wf-sidebar" id="wf-sidebar">${renderSidebar()}</div><div class="wf-main" id="wf-main">${renderMain()}</div></div>`;
        bindEvents(body);
        setTimeout(() => drawCharts(), 80);
    }
    
    function renderSidebar() {
        const c = WF.cfg;
        return `
        <div class="wf-sb-logo">⚗ WF / MC</div>
        <div class="wf-sb-sect">
            <div class="wf-sb-h">📊 Walk-Forward</div>
            <div class="wf-sb-row"><span class="wf-sb-lbl">Windows</span><input class="wf-sb-inp" id="wf-windows" type="number" min="3" max="20" value="${c.wfWindows}"></div>
            <div class="wf-sb-row"><span class="wf-sb-lbl">In-Sample %</span><input class="wf-sb-inp" id="wf-ispct" type="number" min="50" max="90" value="${c.inSamplePct}"></div>
            <div class="wf-sb-row"><span class="wf-sb-lbl">Mode</span>
                <select class="wf-sb-sel" id="wf-mode">
                    <option value="rolling"  ${!c.anchoredStart?'selected':''}>Rolling</option>
                    <option value="anchored" ${ c.anchoredStart?'selected':''}>Anchored</option>
                </select>
            </div>
            <div class="wf-sb-h2">🔧 Optimize</div>
            <label class="wf-sb-chk"><input type="checkbox" id="wf-opt-sl" ${c.opt_slValue?'checked':''}> SL values</label>
            <input class="wf-sb-inp wf-sb-inp-full ${c.opt_slValue?'':'wf-dim'}" id="wf-sl-range" value="${c.slValueRange}" placeholder="0.5,1,1.5,2">
            <label class="wf-sb-chk" style="margin-top:5px"><input type="checkbox" id="wf-opt-tp" ${c.opt_tpValue?'checked':''}> TP values</label>
            <input class="wf-sb-inp wf-sb-inp-full ${c.opt_tpValue?'':'wf-dim'}" id="wf-tp-range" value="${c.tpValueRange}" placeholder="1.5,2,3">
            <label class="wf-sb-chk" style="margin-top:5px"><input type="checkbox" id="wf-opt-risk" ${c.opt_riskPct?'checked':''}> Risk % values</label>
            <input class="wf-sb-inp wf-sb-inp-full ${c.opt_riskPct?'':'wf-dim'}" id="wf-risk-range" value="${c.riskPctRange}" placeholder="0.5,1,2">
            <button class="sb-btn sb-btn-srv wf-run-btn" id="wf-run-btn" ${WF.wfRunning?'disabled':''}>
                ${WF.wfRunning?'<span class="wf-spin"></span> Running...':'▶ Run Walk-Forward'}
            </button>
        </div>
        <div class="wf-sb-div"></div>
        <div class="wf-sb-sect">
            <div class="wf-sb-h">🎲 Monte Carlo</div>
            <div class="wf-sb-row"><span class="wf-sb-lbl">Simulations</span>
                <select class="wf-sb-sel" id="wf-sims">
                    <option value="500"  ${c.mcSimulations==500 ?'selected':''}>500</option>
                    <option value="1000" ${c.mcSimulations==1000?'selected':''}>1 000</option>
                    <option value="3000" ${c.mcSimulations==3000?'selected':''}>3 000</option>
                    <option value="5000" ${c.mcSimulations==5000?'selected':''}>5 000</option>
                </select>
            </div>
            <div class="wf-hint">Uses current backtest trades</div>
            <button class="sb-btn sb-btn-run wf-run-btn" id="wf-mc-btn" ${WF.mcRunning?'disabled':''}>
                ${WF.mcRunning?'<span class="wf-spin"></span> Simulating...':'🎲 Run Monte Carlo'}
            </button>
        </div>
        ${WF.wfRunning||WF.mcRunning?`<div class="wf-sb-sect"><div class="wf-pbar"><div class="wf-pbar-fill" style="width:${WF.progress}%"></div></div><div class="wf-pmsg">${esc(WF.progressMsg)}</div></div>`:''}`;
    }
    
    function renderMain() {
        if (!WF.wfResult && !WF.mcResult) return `<div class="wf-empty"><div style="font-size:36px;opacity:.3">⚗</div><div class="wf-empty-t">Walk-Forward & Monte Carlo</div><div class="wf-empty-s">Configure and run Walk-Forward to validate strategy across time windows.<br><br>Run Backtest first, then Monte Carlo for risk distribution across 1000+ scenarios.</div></div>`;
        return `${WF.wfResult?renderWFBlock():''}${WF.mcResult?renderMCBlock():''}`;
    }
    
    function renderWFBlock() {
        const r=WF.wfResult, s=r.summary, agg=r.aggregatedStats;
        const effC = s.avgEfficiency===null?'':s.avgEfficiency>=50?'wf-pos':s.avgEfficiency>=25?'wf-warn':'wf-neg';
        const stabC= s.stabilityPct>=60?'wf-pos':s.stabilityPct>=40?'wf-warn':'wf-neg';
        return `
        <div class="wf-block">
            <div class="wf-bh">
                <span class="wf-bt">📊 Walk-Forward</span>
                <div class="wf-tabs-row">
                    <button class="wf-tbtn ${WF.wfTab==='overview'?'wf-tbtn-a':''}" data-wftab="overview">Overview</button>
                    <button class="wf-tbtn ${WF.wfTab==='windows' ?'wf-tbtn-a':''}" data-wftab="windows">Windows</button>
                    <button class="wf-tbtn ${WF.wfTab==='params'  ?'wf-tbtn-a':''}" data-wftab="params">Best Params</button>
                </div>
            </div>
            ${WF.wfTab==='overview'?`
                <div class="wf-kpi4">
                    ${kpi('WF Efficiency',s.avgEfficiency!==null?s.avgEfficiency.toFixed(1)+'%':'—',effC,'OOS / IS return ratio')}
                    ${kpi('Stability',s.stabilityPct!==null?s.stabilityPct+'%':'—',stabC,'Positive OOS windows')}
                    ${kpi('OOS Trades',s.totalOosTrades,'','All windows combined')}
                    ${kpi('Windows',s.validWindows+' / '+s.totalWindows,'','Valid / Total')}
                </div>
                ${agg?`<div class="wf-agg-hdr">Aggregated Out-of-Sample</div>
                <div class="wf-kpi6">
                    ${kpiSm('Net PnL',fmtMoney(agg.totalPnl))}${kpiSm('Return',fmtPct(agg.totalPnlPct))}${kpiSm('Win Rate',agg.winRate+'%')}${kpiSm('Profit F',agg.profitFactor)}${kpiSm('Max DD','<span class="wf-neg">'+agg.maxDD+'%</span>')}${kpiSm('Expectancy',fmtMoney(agg.expectancy))}
                </div>`:'<div class="wf-nodata">Not enough OOS trades.</div>'}
                <div class="wf-chart-wrap"><canvas id="wf-eq-chart"></canvas></div>
            `:''}
            ${WF.wfTab==='windows'?`
            <div class="wf-scroll-x"><table class="wf-tbl">
                <thead><tr><th>#</th><th>IS Period</th><th>OOS Period</th><th>IS Bars</th><th>OOS Bars</th><th>Best SL</th><th>Best TP</th><th>IS Ret</th><th>OOS Ret</th><th>OOS WR</th><th>OOS PF</th><th>Efficiency</th></tr></thead>
                <tbody>${r.windows.map(w=>{
                    const eff=w.efficiency; const ec=eff===null?'':eff>=50?'wf-pos':eff>=25?'wf-warn':'wf-neg';
                    return `<tr><td>${w.window}</td><td class="wf-mono">${fmtDate(w.isRange?.[0])}→${fmtDate(w.isRange?.[1])}</td><td class="wf-mono">${fmtDate(w.oosRange?.[0])}→${fmtDate(w.oosRange?.[1])}</td><td>${(w.isBars||0).toLocaleString()}</td><td>${(w.oosBars||0).toLocaleString()}</td><td><span class="wf-badge">${w.bestParams?.slValue??'—'}</span></td><td><span class="wf-badge">${w.bestParams?.tpValue??'—'}</span></td><td>${fmtPct(w.isStats?.totalPnlPct)}</td><td>${fmtPct(w.oosStats?.totalPnlPct)}</td><td>${w.oosStats?w.oosStats.winRate+'%':'—'}</td><td>${w.oosStats?w.oosStats.profitFactor:'—'}</td><td class="${ec}" style="font-weight:700">${eff!==null?eff.toFixed(0)+'%':'—'}</td></tr>`;
                }).join('')}</tbody>
            </table></div>`:''}
            ${WF.wfTab==='params'?renderParamsTab(r):''}
        </div>`;
    }
    
    function renderParamsTab(r) {
        const slF={},tpF={},rkF={};
        r.windows.forEach(w=>{if(!w.bestParams)return;const{slValue:sl,tpValue:tp,riskPct:rp}=w.bestParams;if(sl!==undefined)slF[sl]=(slF[sl]||0)+1;if(tp!==undefined)tpF[tp]=(tpF[tp]||0)+1;if(rp!==undefined)rkF[rp]=(rkF[rp]||0)+1;});
        const fB=(t,freq,u='')=>{const e=Object.entries(freq).sort((a,b)=>b[1]-a[1]);if(!e.length)return'';const m=Math.max(...e.map(x=>x[1]));return`<div class="wf-freq"><div class="wf-freq-t">${t}</div>${e.map(([v,c])=>`<div class="wf-freq-row"><span class="wf-freq-v">${v}${u}</span><div class="wf-freq-bw"><div class="wf-freq-b" style="width:${c/m*100}%"></div></div><span class="wf-freq-c">${c}×</span></div>`).join('')}</div>`;};
        return `<div class="wf-params-wrap"><div class="wf-params-hint">Parameters chosen most often as optimal. Higher frequency = more robust.</div><div class="wf-freq-grid">${fB('Stop Loss',slF)}${fB('Take Profit',tpF)}${fB('Risk %',rkF,'%')}</div>${r.windows.filter(w=>w.topParams?.length).slice(0,3).map(w=>`<div class="wf-top5"><div class="wf-top5-hdr">Window ${w.window} — OOS: ${fmtPct(w.oosStats?.totalPnlPct)}</div><table class="wf-tbl wf-tbl-sm"><thead><tr><th>SL</th><th>TP</th><th>Risk%</th><th>Score</th><th>Trades</th></tr></thead><tbody>${(w.topParams||[]).slice(0,5).map((p,i)=>`<tr ${i===0?'class="wf-best"':''}><td>${p.slValue??'—'}</td><td>${p.tpValue??'—'}</td><td>${p.riskPct??'—'}</td><td>${p.score}</td><td>${p.trades??'—'}</td></tr>`).join('')}</tbody></table></div>`).join('')}</div>`;
    }
    
    function renderMCBlock() {
        const r=WF.mcResult;
        return `
        <div class="wf-block">
            <div class="wf-bh">
                <span class="wf-bt">🎲 Monte Carlo <span class="wf-bt-sub">${r.simulations.toLocaleString()} sims × ${r.trades} trades</span></span>
                <div class="wf-tabs-row">
                    <button class="wf-tbtn ${WF.mcTab==='equity'   ?'wf-tbtn-a':''}" data-mctab="equity">Equity Bands</button>
                    <button class="wf-tbtn ${WF.mcTab==='histogram'?'wf-tbtn-a':''}" data-mctab="histogram">Distribution</button>
                    <button class="wf-tbtn ${WF.mcTab==='risk'     ?'wf-tbtn-a':''}" data-mctab="risk">Risk Report</button>
                </div>
            </div>
            ${WF.mcTab==='equity'?`
                <div class="wf-mc-legend"><span class="wf-leg wf-lg-p95">P95</span><span class="wf-leg wf-lg-p75">P75</span><span class="wf-leg wf-lg-p50">Median</span><span class="wf-leg wf-lg-p25">P25</span><span class="wf-leg wf-lg-p5">P5</span></div>
                <div class="wf-chart-wrap"><canvas id="mc-eq-chart" style="max-height:200px"></canvas></div>
                <div class="wf-kpi5">
                    ${kpiSm('P95 (best 5%)','<span class="wf-pos">+'+r.percentiles.return.p95+'%</span>')}
                    ${kpiSm('P75','<span class="wf-pos">+'+r.percentiles.return.p75+'%</span>')}
                    ${kpiSm('Median',fmtPct(r.percentiles.return.p50))}
                    ${kpiSm('P25',fmtPct(r.percentiles.return.p25))}
                    ${kpiSm('P5 (worst)','<span class="wf-neg">'+r.percentiles.return.p5+'%</span>')}
                </div>
            `:''}
            ${WF.mcTab==='histogram'?`
                <div class="wf-hist-grid">
                    <div><div class="wf-hist-t">Return Distribution (%)</div><div class="wf-chart-wrap"><canvas id="mc-hist-ret"></canvas></div></div>
                    <div><div class="wf-hist-t">Max Drawdown Distribution (%)</div><div class="wf-chart-wrap"><canvas id="mc-hist-dd"></canvas></div></div>
                </div>
                <table class="wf-tbl wf-tbl-sm" style="margin:8px 12px">
                    <thead><tr><th>Percentile</th><th>Return</th><th>Max DD</th></tr></thead>
                    <tbody>
                        <tr><td>P5  (worst)</td><td class="wf-neg">${r.percentiles.return.p5}%</td><td class="wf-neg">${r.percentiles.maxDD.p95}%</td></tr>
                        <tr><td>P25</td><td>${fmtPct(r.percentiles.return.p25)}</td><td class="wf-neg">${r.percentiles.maxDD.p75}%</td></tr>
                        <tr class="wf-med"><td>P50 (median)</td><td>${fmtPct(r.percentiles.return.p50)}</td><td class="wf-neg">${r.percentiles.maxDD.p50}%</td></tr>
                        <tr><td>P75</td><td class="wf-pos">+${r.percentiles.return.p75}%</td><td class="wf-neg">${r.percentiles.maxDD.p25}%</td></tr>
                        <tr><td>P95 (best)</td><td class="wf-pos">+${r.percentiles.return.p95}%</td><td class="wf-neg">${r.percentiles.maxDD.p5}%</td></tr>
                    </tbody>
                </table>
            `:''}
            ${WF.mcTab==='risk'?`
                <div class="wf-risk-grid">
                    <div class="wf-risk-card" style="border-top-color:${r.risk.ruinProb<5?'#4caf50':r.risk.ruinProb<15?'#ff9800':'#ef5350'}">
                        <div class="wf-risk-ico">💀</div><div class="wf-risk-v" style="color:${r.risk.ruinProb<5?'#4caf50':r.risk.ruinProb<15?'#ff9800':'#ef5350'}">${r.risk.ruinProb}%</div>
                        <div class="wf-risk-l">Probability of Ruin</div><div class="wf-risk-h">Capital drops below 50%</div>
                    </div>
                    <div class="wf-risk-card" style="border-top-color:${r.risk.targetProb>50?'#4caf50':r.risk.targetProb>25?'#ff9800':'#444c70'}">
                        <div class="wf-risk-ico">🎯</div><div class="wf-risk-v" style="color:${r.risk.targetProb>50?'#4caf50':r.risk.targetProb>25?'#ff9800':'#8a90a8'}">${r.risk.targetProb}%</div>
                        <div class="wf-risk-l">Probability of +50%</div><div class="wf-risk-h">Reaching return target</div>
                    </div>
                    <div class="wf-risk-card"><div class="wf-risk-ico">📊</div><div class="wf-risk-v">${fmtPct(r.risk.medianReturn)}</div><div class="wf-risk-l">Median Return</div><div class="wf-risk-h">50% of simulations</div></div>
                    <div class="wf-risk-card"><div class="wf-risk-ico">📉</div><div class="wf-risk-v wf-neg">${r.risk.medianMaxDD}%</div><div class="wf-risk-l">Median Max DD</div><div class="wf-risk-h">Expected drawdown</div></div>
                </div>
                <div class="wf-interp"><div class="wf-interp-t">📋 Interpretation</div><ul class="wf-interp-ul">
                    ${r.risk.ruinProb<5?`<li class="wf-ig">✅ Low ruin probability (${r.risk.ruinProb}%) — risk is well-controlled</li>`:r.risk.ruinProb<15?`<li class="wf-iw">⚠️ Moderate ruin probability (${r.risk.ruinProb}%) — consider reducing position size</li>`:`<li class="wf-ib">❌ High ruin probability (${r.risk.ruinProb}%) — reduce risk per trade immediately</li>`}
                    ${r.risk.medianMaxDD>30?`<li class="wf-ib">❌ Expected drawdown ${r.risk.medianMaxDD}% — very high for most traders</li>`:r.risk.medianMaxDD>15?`<li class="wf-iw">⚠️ Expected drawdown ${r.risk.medianMaxDD}% — significant but manageable</li>`:`<li class="wf-ig">✅ Expected drawdown ${r.risk.medianMaxDD}% — manageable</li>`}
                    ${r.percentiles.return.p5>0?`<li class="wf-ig">✅ Even worst-case 5% scenario is profitable (+${r.percentiles.return.p5}%)</li>`:`<li class="wf-iw">ℹ️ Worst 5% scenario: ${r.percentiles.return.p5}% return</li>`}
                    ${r.risk.targetProb>50?`<li class="wf-ig">✅ >50% chance of reaching +50% return target</li>`:`<li class="wf-iw">ℹ️ ${r.risk.targetProb}% probability of reaching +50% target</li>`}
                </ul></div>
            `:''}
        </div>`;
    }
    
    function kpi(l,v,cls,h){return `<div class="wf-kpi"><div class="wf-kpi-l">${l}</div><div class="wf-kpi-v ${cls||''}">${v}</div><div class="wf-kpi-h">${h||''}</div></div>`;}
    function kpiSm(l,v){return `<div class="wf-kpi wf-kpi-sm"><div class="wf-kpi-l">${l}</div><div class="wf-kpi-v">${v}</div></div>`;}
    
    // ════════════════════════════════════════════════════════════════
    // EVENTS
    // ════════════════════════════════════════════════════════════════
    
    function bindEvents(root) {
        root.querySelector('#wf-run-btn')?.addEventListener('click', runWalkForward);
        root.querySelector('#wf-mc-btn')?.addEventListener('click', runMonteCarlo);
        root.querySelectorAll('[data-wftab]').forEach(btn => btn.addEventListener('click', ()=>{ WF.wfTab=btn.dataset.wftab; refreshMain(); }));
        root.querySelectorAll('[data-mctab]').forEach(btn => btn.addEventListener('click', ()=>{ WF.mcTab=btn.dataset.mctab; refreshMain(); }));
        ['sl','tp','risk'].forEach(k => root.querySelector(`#wf-opt-${k}`)?.addEventListener('change', e=>{ const inp=root.querySelector(`#wf-${k}-range`); if(inp) inp.classList.toggle('wf-dim',!e.target.checked); }));
    }
    
    function refreshMain() {
        const main=document.getElementById('wf-main'); if(!main)return;
        Object.values(WF.charts).forEach(c=>{try{c.destroy();}catch(_){}});WF.charts={};
        main.innerHTML=renderMain();
        const body=document.getElementById('sb-tab-body'); if(body) bindEvents(body);
        setTimeout(()=>drawCharts(),80);
    }
    function updateSidebar() {
        const sb=document.getElementById('wf-sidebar'); if(!sb)return;
        sb.innerHTML=renderSidebar();
        const body=document.getElementById('sb-tab-body'); if(body) bindEvents(body);
    }
    
    // ════════════════════════════════════════════════════════════════
    // API CALLS
    // ════════════════════════════════════════════════════════════════
    
    async function runWalkForward() {
        if (WF.wfRunning) return;
        const btCfg = getBTCfg();
    
        // Валидация перед запуском
        const validErr = validateCfg(btCfg);
        if (validErr) { alert('⚠️ ' + validErr); return; }
    
        const parseRange = s => s.split(',').map(v=>parseFloat(v.trim())).filter(v=>!isNaN(v));
        const paramRanges = {};
        if (document.getElementById('wf-opt-sl')?.checked) paramRanges.slValue = parseRange(document.getElementById('wf-sl-range')?.value||'0.5,1,1.5,2');
        if (document.getElementById('wf-opt-tp')?.checked) paramRanges.tpValue = parseRange(document.getElementById('wf-tp-range')?.value||'1.5,2,3');
        if (document.getElementById('wf-opt-risk')?.checked) paramRanges.riskPct = parseRange(document.getElementById('wf-risk-range')?.value||'0.5,1,2');
        if (!Object.keys(paramRanges).length) { alert('Select at least one parameter to optimize.'); return; }
    
        const c=WF.cfg;
        c.wfWindows=parseInt(document.getElementById('wf-windows')?.value||c.wfWindows);
        c.inSamplePct=parseInt(document.getElementById('wf-ispct')?.value||c.inSamplePct);
        c.anchoredStart=document.getElementById('wf-mode')?.value==='anchored';
        c.opt_slValue=!!document.getElementById('wf-opt-sl')?.checked;
        c.opt_tpValue=!!document.getElementById('wf-opt-tp')?.checked;
        c.opt_riskPct=!!document.getElementById('wf-opt-risk')?.checked;
        c.slValueRange=document.getElementById('wf-sl-range')?.value||c.slValueRange;
        c.tpValueRange=document.getElementById('wf-tp-range')?.value||c.tpValueRange;
        c.riskPctRange=document.getElementById('wf-risk-range')?.value||c.riskPctRange;
        saveCfg(c);
    
        WF.wfRunning=true; WF.wfResult=null; WF.progress=5; WF.progressMsg='Loading bars from ClickHouse...';
        updateSidebar();
    
        try {
            const resp = await fetch('/api/backtest/walkforward', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include',
                body: JSON.stringify({...btCfg, wfWindows:c.wfWindows, inSamplePct:c.inSamplePct, anchoredStart:c.anchoredStart, paramRanges}) });
            if (!resp.ok) { const e=await resp.json().catch(()=>({error:resp.statusText})); throw new Error(e.error||resp.statusText); }
            WF.wfResult=await resp.json(); WF.wfTab='overview';
        } catch(err) { alert('Walk-Forward error: '+err.message); console.error('[WF]',err); }
        finally {
            WF.wfRunning=false; WF.progress=0;
            const body=document.getElementById('sb-tab-body');
            if(body && document.getElementById('sb-tab-wf')?.classList.contains('sb-tab-active')) renderWFPanel(body);
        }
    }
    
    async function runMonteCarlo() {
        if (WF.mcRunning) return;
        const trades = getTrades();
        if (!trades || trades.length < 2) { alert('Run a backtest first (Backtest tab → Run Server BT), then come back here.'); return; }
        const sims    = parseInt(document.getElementById('wf-sims')?.value || WF.cfg.mcSimulations);
        const capital = getBTCfg().capital || 10000;
        WF.cfg.mcSimulations = sims; saveCfg(WF.cfg);
        WF.mcRunning = true; WF.mcResult = null; WF.progress = 5; WF.progressMsg = `Running ${sims.toLocaleString()} simulations...`;
        updateSidebar();
    
        try {
            // Отправляем только pnl — остальные поля не нужны серверу
            // Это резко уменьшает размер запроса
            const slimTrades = trades.map(t => ({ pnl: t.pnl }));
    
            const resp = await fetch('/api/backtest/montecarlo', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include',
                body: JSON.stringify({ trades: slimTrades, capital, simulations: sims }) });
            if (!resp.ok) { const e=await resp.json().catch(()=>({error:resp.statusText})); throw new Error(e.error||resp.statusText); }
            WF.mcResult=await resp.json(); WF.mcTab='equity';
        } catch(err) { alert('Monte Carlo error: '+err.message); console.error('[MC]',err); }
        finally {
            WF.mcRunning=false; WF.progress=0;
            const body=document.getElementById('sb-tab-body');
            if(body && document.getElementById('sb-tab-wf')?.classList.contains('sb-tab-active')) renderWFPanel(body);
        }
    }
    
    // ════════════════════════════════════════════════════════════════
    // CHARTS
    // ════════════════════════════════════════════════════════════════
    
    function ensureChartJS(cb) { if(window.Chart){cb();return;} const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';s.onload=cb;document.head.appendChild(s); }
    function destroyChart(id) { if(WF.charts[id]){try{WF.charts[id].destroy();}catch(_){}delete WF.charts[id];} }
    
    function drawCharts() {
        ensureChartJS(()=>{
            if(WF.wfResult && WF.wfTab==='overview') drawWFEquity();
            if(WF.mcResult && WF.mcTab==='equity')   drawMCBands();
            if(WF.mcResult && WF.mcTab==='histogram'){drawHistogram('mc-hist-ret',WF.mcResult.histogram.returns,'Return %','#4a9eff');drawHistogram('mc-hist-dd',WF.mcResult.histogram.maxDDs,'Max DD %','#ef5350');}
        });
    }
    
    function drawWFEquity() {
        const canvas=document.getElementById('wf-eq-chart'); if(!canvas||!WF.wfResult?.allOosTrades?.length)return; destroyChart('wf-eq');
        const trades=WF.wfResult.allOosTrades, capital=getBTCfg().capital||10000; let cap=capital; const data=[cap],labels=[''];
        trades.forEach((t,i)=>{cap+=t.pnl;data.push(+cap.toFixed(2));labels.push(i+1);});
        const color=cap>=capital?'#4caf50':'#ef5350';
        WF.charts['wf-eq']=new Chart(canvas,{type:'line',data:{labels,datasets:[{label:'OOS Equity',data,borderColor:color,backgroundColor:color+'18',borderWidth:2,pointRadius:0,fill:true,tension:0.3}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{x:{display:false},y:{grid:{color:'rgba(255,255,255,.07)'},ticks:{color:'#787b86',callback:v=>'$'+v.toFixed(0)}}}}});
    }
    
    function drawMCBands() {
        const canvas=document.getElementById('mc-eq-chart'); if(!canvas||!WF.mcResult?.bands)return; destroyChart('mc-eq');
        const b=WF.mcResult.bands, labels=b.p50.map((_,i)=>i);
        WF.charts['mc-eq']=new Chart(canvas,{type:'line',data:{labels,datasets:[
            {label:'P95',data:b.p95,borderColor:'rgba(76,175,80,.9)', backgroundColor:'rgba(76,175,80,.1)', borderWidth:1.5,pointRadius:0,fill:'+1',tension:0.4},
            {label:'P75',data:b.p75,borderColor:'rgba(74,158,255,.7)',backgroundColor:'rgba(74,158,255,.1)',borderWidth:1.5,pointRadius:0,fill:'+1',tension:0.4},
            {label:'P50',data:b.p50,borderColor:'#ffffff',backgroundColor:'transparent',borderWidth:2.5,pointRadius:0,fill:false,tension:0.4},
            {label:'P25',data:b.p25,borderColor:'rgba(255,152,0,.7)',backgroundColor:'rgba(255,152,0,.08)',borderWidth:1.5,pointRadius:0,fill:'+1',tension:0.4},
            {label:'P5', data:b.p5, borderColor:'rgba(239,83,80,.9)',backgroundColor:'rgba(239,83,80,.08)',borderWidth:1.5,pointRadius:0,fill:false,tension:0.4},
        ]},options:{responsive:true,interaction:{mode:'index',intersect:false},plugins:{legend:{labels:{color:'#787b86',boxWidth:12,font:{size:11}}},tooltip:{callbacks:{label:c=>`${c.dataset.label}: $${c.parsed.y.toFixed(0)}`}}},scales:{x:{display:false},y:{grid:{color:'rgba(255,255,255,.06)'},ticks:{color:'#787b86',callback:v=>'$'+v.toFixed(0)}}}}});
    }
    
    function drawHistogram(id,data,label,color) {
        const canvas=document.getElementById(id); if(!canvas||!data?.length)return; destroyChart(id);
        const max=Math.max(...data.map(d=>d.count));
        WF.charts[id]=new Chart(canvas,{type:'bar',data:{labels:data.map(b=>b.x.toFixed(1)),datasets:[{label,data:data.map(b=>b.count),backgroundColor:data.map(b=>color+Math.floor((0.3+b.count/max*0.7)*255).toString(16).padStart(2,'0')),borderColor:color,borderWidth:1}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#787b86',maxTicksLimit:8},grid:{display:false}},y:{ticks:{color:'#787b86'},grid:{color:'rgba(255,255,255,.05)'}}}}});
    }
    
    // ════════════════════════════════════════════════════════════════
    // CSS
    // ════════════════════════════════════════════════════════════════
    
    function injectCSS() {
        if(document.getElementById('wf-css'))return;
        const s=document.createElement('style');s.id='wf-css';
        s.textContent=`
    .sb-tab-wfmc.sb-tab-active{color:#7b4fff;border-bottom-color:#7b4fff}
    .wf-root{display:flex;height:100%;min-height:0;font-size:12px;color:#c8ccd8;background:#080a12}
    .wf-sidebar{width:210px;min-width:210px;border-right:1px solid #141826;overflow-y:auto;padding:8px 0;background:#0b0d16;flex-shrink:0}
    .wf-sb-logo{padding:6px 12px 8px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#7b4fff;border-bottom:1px solid #141826;margin-bottom:6px}
    .wf-sb-sect{padding:4px 10px 8px}
    .wf-sb-h{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#444c70;margin:8px 0 6px}
    .wf-sb-h2{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#444c70;margin:8px 0 4px}
    .wf-sb-row{display:flex;align-items:center;gap:6px;margin-bottom:4px}
    .wf-sb-lbl{flex:1;font-size:11px;color:#6a7090}
    .wf-sb-inp{background:#111320;border:1px solid #1a1e30;color:#c8ccd8;padding:3px 6px;border-radius:3px;font-size:11px;width:68px;outline:none;font-family:inherit}
    .wf-sb-inp:focus{border-color:#7b4fff}
    .wf-sb-inp-full{width:100%;box-sizing:border-box;margin:3px 0 2px}
    .wf-sb-sel{background:#111320;border:1px solid #1a1e30;color:#c8ccd8;padding:3px 5px;border-radius:3px;font-size:11px;outline:none}
    .wf-sb-chk{display:flex;align-items:center;gap:5px;font-size:11px;color:#8a90a8;cursor:pointer}
    .wf-dim{opacity:.35}
    .wf-run-btn{width:100%;margin-top:8px}
    .wf-sb-div{height:1px;background:#141826;margin:4px 0}
    .wf-hint{font-size:10px;color:#444c70;margin-top:2px}
    .wf-spin{display:inline-block;width:9px;height:9px;border:2px solid rgba(255,255,255,.2);border-top-color:#fff;border-radius:50%;animation:wf-s .7s linear infinite;vertical-align:middle;margin-right:3px}
    @keyframes wf-s{to{transform:rotate(360deg)}}
    .wf-pbar{height:3px;background:#1a1e30;border-radius:2px;overflow:hidden;margin-bottom:4px}
    .wf-pbar-fill{height:100%;background:linear-gradient(90deg,#7b4fff,#4a9eff);transition:width .3s}
    .wf-pmsg{font-size:10px;color:#444c70}
    .wf-main{flex:1;overflow-y:auto;padding:10px;min-height:0}
    .wf-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;min-height:250px;text-align:center;gap:10px}
    .wf-empty-t{font-size:15px;font-weight:700;color:#444c70}
    .wf-empty-s{font-size:11px;color:#2a3050;line-height:1.8}
    .wf-block{background:#0d0f1a;border:1px solid #141826;border-radius:6px;margin-bottom:12px;overflow:hidden}
    .wf-bh{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #141826;background:#0b0d16}
    .wf-bt{font-weight:700;font-size:12px}
    .wf-bt-sub{font-size:10px;font-weight:400;color:#444c70;margin-left:8px}
    .wf-tabs-row{display:flex;gap:2px}
    .wf-tbtn{padding:3px 9px;background:transparent;border:1px solid #1a1e30;color:#444c70;font-size:10px;border-radius:3px;cursor:pointer;font-family:inherit;transition:all .12s}
    .wf-tbtn:hover{color:#c8ccd8}
    .wf-tbtn-a{background:#151826;color:#7b4fff;border-color:#7b4fff}
    .wf-kpi4{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#141826;margin:1px}
    .wf-kpi5{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:#141826;margin:1px}
    .wf-kpi6{display:grid;grid-template-columns:repeat(6,1fr);gap:1px;background:#141826;margin:1px}
    .wf-kpi{padding:10px;background:#0d0f1a}
    .wf-kpi-sm{padding:7px 10px}
    .wf-kpi-l{font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:#444c70;margin-bottom:3px}
    .wf-kpi-v{font-size:17px;font-weight:700}
    .wf-kpi-sm .wf-kpi-v{font-size:13px}
    .wf-kpi-h{font-size:10px;color:#2a3050;margin-top:2px}
    .wf-pos{color:#4caf50}.wf-neg{color:#ef5350}.wf-warn{color:#ff9800}.wf-na{color:#2a3050}
    .wf-mono{font-family:'JetBrains Mono',monospace;font-size:10px}
    .wf-badge{background:rgba(74,158,255,.12);color:#4a9eff;padding:1px 5px;border-radius:9px;font-size:10px}
    .wf-agg-hdr{padding:8px 12px 3px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#444c70}
    .wf-nodata{padding:14px;color:#2a3050;text-align:center;font-size:11px}
    .wf-chart-wrap{padding:6px 10px}
    .wf-scroll-x{overflow-x:auto;padding:6px}
    .wf-tbl{width:100%;border-collapse:collapse;font-size:11px}
    .wf-tbl-sm{font-size:11px}
    .wf-tbl th{padding:5px 7px;text-align:left;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#444c70;border-bottom:1px solid #141826;white-space:nowrap}
    .wf-tbl td{padding:4px 7px;border-bottom:1px solid rgba(255,255,255,.03);white-space:nowrap}
    .wf-tbl tr:hover td{background:rgba(255,255,255,.02)}
    .wf-med td{background:rgba(74,158,255,.06);font-weight:700}
    .wf-best td{background:rgba(74,158,255,.08)}
    .wf-params-wrap{padding:10px 12px}
    .wf-params-hint{font-size:11px;color:#444c70;margin-bottom:12px;line-height:1.6}
    .wf-freq-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px}
    .wf-freq-t{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#444c70;margin-bottom:6px}
    .wf-freq-row{display:flex;align-items:center;gap:5px;margin-bottom:3px}
    .wf-freq-v{width:32px;font-size:11px;font-weight:600;color:#4a9eff}
    .wf-freq-bw{flex:1;height:5px;background:#141826;border-radius:3px;overflow:hidden}
    .wf-freq-b{height:100%;background:linear-gradient(90deg,#7b4fff,#4a9eff);border-radius:3px}
    .wf-freq-c{font-size:10px;color:#444c70;width:18px;text-align:right}
    .wf-top5{margin-bottom:12px}
    .wf-top5-hdr{font-size:11px;font-weight:600;color:#8a90a8;margin-bottom:5px}
    .wf-mc-legend{display:flex;gap:10px;padding:7px 12px 3px;flex-wrap:wrap}
    .wf-leg{font-size:10px;display:flex;align-items:center;gap:4px;color:#6a7090}
    .wf-leg::before{content:'';width:18px;height:3px;display:inline-block;border-radius:2px}
    .wf-lg-p95::before{background:rgba(76,175,80,.9)}.wf-lg-p75::before{background:rgba(74,158,255,.7)}.wf-lg-p50::before{background:#fff}.wf-lg-p25::before{background:rgba(255,152,0,.7)}.wf-lg-p5::before{background:rgba(239,83,80,.9)}
    .wf-hist-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:8px 10px 0}
    .wf-hist-t{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#444c70;margin-bottom:4px}
    .wf-risk-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;padding:10px}
    .wf-risk-card{background:#0b0d16;border:1px solid #141826;border-top-width:2px;border-radius:6px;padding:12px 10px;text-align:center}
    .wf-risk-ico{font-size:18px;margin-bottom:4px}
    .wf-risk-v{font-size:20px;font-weight:700;margin-bottom:3px}
    .wf-risk-l{font-size:11px;font-weight:600;color:#8a90a8;margin-bottom:2px}
    .wf-risk-h{font-size:10px;color:#444c70}
    .wf-interp{padding:0 10px 10px}
    .wf-interp-t{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#444c70;margin-bottom:7px}
    .wf-interp-ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}
    .wf-interp-ul li{font-size:11px;padding:5px 9px;border-radius:4px}
    .wf-ig{background:rgba(76,175,80,.09);color:#81c784}.wf-iw{background:rgba(255,152,0,.09);color:#ffb74d}.wf-ib{background:rgba(239,83,80,.09);color:#ef9a9a}
        `;
        document.head.appendChild(s);
    }
    
    // ════════════════════════════════════════════════════════════════
    // INIT
    // ════════════════════════════════════════════════════════════════
    
    injectTab();
    window.wfPanel = { open: ()=>document.getElementById('sb-tab-wf')?.click() };
    console.log('[WF/MC] v2.0 loaded — injecting into #sb-tabbar...');
    
    })(); }