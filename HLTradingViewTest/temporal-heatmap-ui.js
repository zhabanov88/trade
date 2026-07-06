/**
 * temporal-heatmap-ui.js  v1.0
 *
 * Temporal Analysis — "Лучшее время для сетапа".
 * Добавляет вкладку "🕐 Temporal" в панель 🧠 AI.
 *
 * Полностью клиентский — никаких API вызовов.
 * Подключение в index.html ПОСЛЕ alpha-decay-ui.js:
 *   <script src="temporal-heatmap-ui.js"></script>
 */

if (window._temporalUILoaded) {} else { window._temporalUILoaded = true; (function () {
    'use strict';
    
    const TH = {
        result: null,
        cfg: {
            metric:      'winRate',
            setupFilter: '',
            timezone:    'UTC',
            minTrades:   2,
        },
        charts: {},
    };
    
    const DAYS  = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const HOURS = Array.from({length:24}, (_,i) => String(i).padStart(2,'0')+':00');
    const SESSIONS = [
        { name:'Asia',     start:0,  end:9,  color:'rgba(74,158,255,0.55)'  },
        { name:'London',   start:7,  end:16, color:'rgba(76,175,80,0.55)'   },
        { name:'New York', start:13, end:22, color:'rgba(255,152,0,0.55)'   },
    ];
    
    // ── TAB INJECT ──────────────────────────────────────────────────
    
    function injectTab() {
        const t = setInterval(() => {
            const vtabs = document.querySelector('.ai-tabs-vert');
            if (!vtabs) return;
            clearInterval(t);
            if (document.querySelector('[data-aitab="temporal"]')) return;
            injectCSS();
            const btn = document.createElement('button');
            btn.className = 'ai-vtab';
            btn.dataset.aitab = 'temporal';
            btn.textContent = '🕐 Temporal';
            vtabs.appendChild(btn);
            btn.addEventListener('click', () => {
                document.querySelectorAll('.ai-vtab').forEach(b => b.classList.remove('ai-vtab-a'));
                btn.classList.add('ai-vtab-a');
                renderSidebar();
                renderMain();
            });
        }, 300);
    }
    
    // ── SIDEBAR ─────────────────────────────────────────────────────
    
    function renderSidebar() {
        const sb = document.getElementById('ai-sidebar');
        if (!sb) return;
        const logo  = sb.querySelector('.ai-logo');
        const vtabs = sb.querySelector('.ai-tabs-vert');
        sb.innerHTML = '';
        if (logo)  sb.appendChild(logo);
        if (vtabs) sb.appendChild(vtabs);
    
        const trades = getTrades();
        const setupNames = trades.length ? [...new Set(trades.map(t => t.setupName).filter(Boolean))] : [];
        let setupOpts = '<option value="">All setups</option>';
        for (const n of setupNames) {
            setupOpts += `<option value="${esc(n)}" ${TH.cfg.setupFilter===n?'selected':''}>${esc(n)}</option>`;
        }
    
        const sect = document.createElement('div');
        sect.className = 'ai-sb-sect';
        sect.innerHTML = `
            <div class="ai-sb-h">Settings</div>
            <div class="ai-sb-row">
                <label class="ai-sb-lbl">Metric</label>
                <select class="ai-sb-inp" id="th-metric" style="width:105px">
                    <option value="winRate"  ${TH.cfg.metric==='winRate' ?'selected':''}>Win Rate %</option>
                    <option value="avgPnl"   ${TH.cfg.metric==='avgPnl'  ?'selected':''}>Avg PnL</option>
                    <option value="totalPnl" ${TH.cfg.metric==='totalPnl'?'selected':''}>Total PnL</option>
                    <option value="count"    ${TH.cfg.metric==='count'   ?'selected':''}>Trade Count</option>
                </select>
            </div>
            <div class="ai-sb-row">
                <label class="ai-sb-lbl">Setup</label>
                <select class="ai-sb-inp" id="th-setup" style="width:105px">${setupOpts}</select>
            </div>
            <div class="ai-sb-row">
                <label class="ai-sb-lbl">Timezone</label>
                <select class="ai-sb-inp" id="th-tz" style="width:105px">
                    <option value="UTC"              ${TH.cfg.timezone==='UTC'              ?'selected':''}>UTC</option>
                    <option value="Europe/Moscow"    ${TH.cfg.timezone==='Europe/Moscow'    ?'selected':''}>Moscow</option>
                    <option value="America/New_York" ${TH.cfg.timezone==='America/New_York' ?'selected':''}>New York</option>
                    <option value="Europe/London"    ${TH.cfg.timezone==='Europe/London'    ?'selected':''}>London</option>
                    <option value="Asia/Tokyo"       ${TH.cfg.timezone==='Asia/Tokyo'       ?'selected':''}>Tokyo</option>
                </select>
            </div>
            <div class="ai-sb-row">
                <label class="ai-sb-lbl">Min trades/cell</label>
                <input class="ai-sb-inp ai-sb-inp-sm" id="th-min-trades" type="number" min="1" max="20" value="${TH.cfg.minTrades}">
            </div>
            <div class="ai-sb-h" style="margin-top:10px">Data</div>
            <div style="font-size:11px;padding:2px 0;color:${trades.length?'#4caf50':'#ef5350'}">
                ${trades.length ? '✓ ' + trades.length + ' trades loaded' : '⚠️ No trades. Run Server BT first.'}
            </div>
            <button class="sb-btn sb-btn-srv ai-run-btn" id="th-run-btn" style="margin-top:10px">🕐 Build Heatmap</button>
            <div class="ai-hint">Shows Win Rate & PnL by hour and day of week.</div>
        `;
        sb.appendChild(sect);
    
        document.getElementById('th-metric')?.addEventListener('change', e => {
            TH.cfg.metric = e.target.value;
            if (TH.result && !TH.result.error) renderMain();
        });
        document.getElementById('th-setup')?.addEventListener('change',     e => { TH.cfg.setupFilter = e.target.value; });
        document.getElementById('th-tz')?.addEventListener('change',        e => { TH.cfg.timezone = e.target.value; });
        document.getElementById('th-min-trades')?.addEventListener('change',e => { TH.cfg.minTrades = parseInt(e.target.value)||1; if (TH.result && !TH.result.error) renderMain(); });
        document.getElementById('th-run-btn')?.addEventListener('click', runAnalysis);
    }
    
    // ── ENGINE ──────────────────────────────────────────────────────
    
    function toLocalHourDay(ts, tz) {
        try {
            const ms = typeof ts === 'number' ? (ts < 2e12 ? ts*1000 : ts) : new Date(ts).getTime();
            if (!ms || isNaN(ms)) return null;
            const fmt = new Intl.DateTimeFormat('en-US', { timeZone:tz, weekday:'short', hour:'numeric', hour12:false });
            const parts = fmt.formatToParts(new Date(ms));
            const hour = parseInt(parts.find(p => p.type==='hour')?.value ?? '0', 10) % 24;
            const wdRaw = parts.find(p => p.type==='weekday')?.value ?? 'Mon';
            const dayMap = { Mon:0, Tue:1, Wed:2, Thu:3, Fri:4, Sat:5, Sun:6 };
            return { hour, day: dayMap[wdRaw] ?? 0 };
        } catch(_) {
            const ms = typeof ts === 'number' ? (ts < 2e12 ? ts*1000 : ts) : new Date(ts).getTime();
            const d = new Date(ms);
            const raw = d.getUTCDay();
            return { hour: d.getUTCHours(), day: raw === 0 ? 6 : raw - 1 };
        }
    }
    
    function runAnalysis() {
        const trades = getTrades();
        if (!trades.length) { alert('No trades found. Run a Server Backtest first.'); return; }
        const btn = document.getElementById('th-run-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Computing…'; }
        setTimeout(() => {
            try { TH.result = computeHeatmap(trades, TH.cfg); }
            catch(e) { TH.result = { error: e.message }; console.error('[TemporalHeatmap]', e); }
            if (btn) { btn.disabled = false; btn.textContent = '🕐 Build Heatmap'; }
            renderMain();
        }, 20);
    }
    
    function computeHeatmap(allTrades, cfg) {
        const trades = cfg.setupFilter ? allTrades.filter(t => t.setupName === cfg.setupFilter) : allTrades;
        if (trades.length < 3) return { error: 'Not enough trades (need at least 3).' };
    
        // grid[day][hour]
        const grid = Array.from({length:7}, () =>
            Array.from({length:24}, () => ({ wins:0, total:0, pnl:0 }))
        );
        let parsed = 0;
        for (const t of trades) {
            const slot = toLocalHourDay(t.entryTs, cfg.timezone);
            if (!slot) continue;
            const c = grid[slot.day][slot.hour];
            c.total++; if (t.pnl > 0) c.wins++; c.pnl += (t.pnl || 0);
            parsed++;
        }
        if (parsed < 3) return { error: `Could not parse timestamps (parsed ${parsed}/${trades.length}). Check entryTs format.` };
    
        const cells = [];
        for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
            const c = grid[d][h];
            cells.push({
                day:d, hour:h, total:c.total, wins:c.wins,
                winRate:  c.total > 0 ? +(c.wins/c.total*100).toFixed(1) : null,
                avgPnl:   c.total > 0 ? +(c.pnl/c.total).toFixed(2)      : null,
                totalPnl: +c.pnl.toFixed(2),
                count:    c.total,
            });
        }
    
        const agg = (filterFn, key) => {
            return Array.from({length:key==='hour'?24:7}, (_, i) => {
                const cs = cells.filter(c => c[key]===i && c.total>0);
                if (!cs.length) return { [key]:i, total:0, wins:0, winRate:null, avgPnl:null, totalPnl:0 };
                const total = cs.reduce((s,c)=>s+c.total,0);
                const wins  = cs.reduce((s,c)=>s+c.wins, 0);
                const pnl   = cs.reduce((s,c)=>s+c.totalPnl, 0);
                return { [key]:i, total, wins, winRate:+(wins/total*100).toFixed(1), avgPnl:+(pnl/total).toFixed(2), totalPnl:+pnl.toFixed(2) };
            });
        };
    
        const byHour = agg(null, 'hour');
        const byDay  = agg(null, 'day');
    
        const valid  = cells.filter(c => c.total >= cfg.minTrades && c.winRate !== null);
        const srtd   = [...valid].sort((a,b)=>(b.winRate||0)-(a.winRate||0));
        const mapSlot = c => ({ day:DAYS[c.day], hour:HOURS[c.hour], total:c.total, winRate:c.winRate, avgPnl:c.avgPnl, totalPnl:c.totalPnl });
        const bestSlots  = srtd.slice(0,5).map(mapSlot);
        const worstSlots = srtd.slice(-5).reverse().map(mapSlot);
    
        const totalWins = trades.filter(t=>t.pnl>0).length;
        const overallPnl = +trades.reduce((s,t)=>s+(t.pnl||0),0).toFixed(2);
    
        return {
            cells, byHour, byDay, bestSlots, worstSlots,
            totalTrades: trades.length, totalWins,
            overallWR:  +(totalWins/trades.length*100).toFixed(1),
            overallPnl, timezone: cfg.timezone,
            setupFilter: cfg.setupFilter || 'All', parsed,
        };
    }
    
    // ── RENDER MAIN ─────────────────────────────────────────────────
    
    function renderMain() {
        destroyCharts();
        const main = document.getElementById('ai-main');
        if (!main) return;
    
        if (!TH.result) { main.innerHTML = emptyState(); return; }
        if (TH.result.error) {
            main.innerHTML = `<div class="ai-empty"><div style="font-size:28px">⚠️</div><div class="ai-empty-t">Analysis Failed</div><div class="ai-empty-s">${esc(TH.result.error)}</div></div>`;
            return;
        }
    
        const r = TH.result;
        const metricLabel = {winRate:'Win Rate %',avgPnl:'Avg PnL',totalPnl:'Total PnL',count:'Trade Count'}[TH.cfg.metric];
    
        main.innerHTML = `
        <div class="ai-block">
            <div class="ai-bh">
                <span class="ai-bt">🕐 Temporal Analysis</span>
                <span class="ai-bsub">${r.totalTrades} trades · ${esc(r.setupFilter)} · ${esc(r.timezone)}</span>
            </div>
            <div class="ai-kpi5" style="grid-template-columns:repeat(4,1fr)">
                ${kpi('Trades',   r.totalTrades)}
                ${kpi('Win Rate', r.overallWR+'%')}
                ${kpi('Total PnL',`<span class="${r.overallPnl>=0?'ai-pos':'ai-neg'}">${r.overallPnl>=0?'+':''}${r.overallPnl}</span>`)}
                ${kpi('Parsed',   r.parsed+'/'+r.totalTrades)}
            </div>
        </div>
    
        <div class="ai-block">
            <div class="ai-bh">
                <span class="ai-bt">📊 ${esc(metricLabel)} — Hour × Day of Week</span>
                <span class="ai-bsub">hover for details · colored bars = sessions</span>
            </div>
            <div class="th-heatmap-wrap">
                <div class="th-heatmap" id="th-heatmap-grid"></div>
            </div>
            <div class="th-color-scale">
                <span class="th-scale-lo">Low</span>
                <div class="th-scale-bar" id="th-scale-bar"></div>
                <span class="th-scale-hi">High</span>
                <div class="th-legend-sessions">
                    ${SESSIONS.map(s=>`<span class="th-sess-dot" style="border-color:${s.color}">${s.name}</span>`).join('')}
                </div>
                <span class="th-scale-empty">□ &lt;${TH.cfg.minTrades} trades</span>
            </div>
        </div>
    
        <div class="th-bw-grid">
            <div class="ai-block">
                <div class="ai-bh"><span class="ai-bt">🏆 Best Time Slots</span><span class="ai-bsub">by Win Rate</span></div>
                ${slotsTable(r.bestSlots, 'best')}
            </div>
            <div class="ai-block">
                <div class="ai-bh"><span class="ai-bt">💀 Worst Time Slots</span><span class="ai-bsub">by Win Rate</span></div>
                ${slotsTable(r.worstSlots, 'worst')}
            </div>
        </div>
    
        <div class="ai-block">
            <div class="ai-bh"><span class="ai-bt">📈 Win Rate by Hour</span><span class="ai-bsub">all days combined</span></div>
            <div class="ai-chart-wrap" style="height:190px"><canvas id="th-hour-chart"></canvas></div>
        </div>
        <div class="ai-block">
            <div class="ai-bh"><span class="ai-bt">📅 Win Rate by Day of Week</span></div>
            <div class="ai-chart-wrap" style="height:160px"><canvas id="th-day-chart"></canvas></div>
        </div>
    
        <div class="ai-block">
            <div class="ai-bh"><span class="ai-bt">🌍 Session Breakdown (UTC)</span></div>
            <div class="th-sessions" id="th-sessions"></div>
        </div>
    
        <div class="th-tooltip" id="th-tooltip" style="display:none"></div>`;
    
        setTimeout(() => {
            buildHeatmapGrid(r);
            buildScaleBar();
            buildSessionBreakdown(r);
            drawHourChart(r);
            drawDayChart(r);
        }, 30);
    }
    
    function emptyState() {
        return `<div class="ai-empty">
            <div style="font-size:40px;opacity:.25">🕐</div>
            <div class="ai-empty-t">Temporal Heatmap</div>
            <div class="ai-empty-s">
                Reveals the best and worst hours &amp; days to trade your setup.<br><br>
                <strong>Outputs:</strong><br>
                Win Rate heatmap: Hour × Day of Week<br>
                Best / Worst time slots with stats<br>
                Bar charts by hour and weekday<br>
                Asia / London / New York session overlay<br><br>
                Run a Server Backtest first, then click<br>
                <strong>🕐 Build Heatmap</strong>
            </div>
        </div>`;
    }
    
    // ── HEATMAP GRID ────────────────────────────────────────────────
    
    function getCellValue(cell) {
        const m = TH.cfg.metric;
        if (m === 'winRate')   return cell.winRate;
        if (m === 'avgPnl')    return cell.avgPnl;
        if (m === 'totalPnl')  return cell.totalPnl;
        if (m === 'count')     return cell.count;
        return cell.winRate;
    }
    
    function valToColor(norm, metric) {
        if (metric === 'count') {
            return `rgba(74,158,${Math.round(50+norm*180)},${(0.2+norm*0.6).toFixed(2)})`;
        }
        if (norm < 0.5) {
            const t = norm*2;
            return `rgba(239,${Math.round(83+t*69)},80,${(0.2+t*0.45).toFixed(2)})`;
        }
        const t = (norm-0.5)*2;
        return `rgba(${Math.round(255-t*179)},${Math.round(152+t*23)},${Math.round(t*80)},${(0.4+t*0.3).toFixed(2)})`;
    }
    
    function buildHeatmapGrid(r) {
        const container = document.getElementById('th-heatmap-grid');
        if (!container) return;
        const minT = TH.cfg.minTrades;
        const metric = TH.cfg.metric;
    
        const vals = r.cells.filter(c=>c.total>=minT).map(c=>getCellValue(c)).filter(v=>v!==null);
        const vMin = vals.length ? Math.min(...vals) : 0;
        const vMax = vals.length ? Math.max(...vals) : 1;
    
        let html = '<table class="th-grid-table"><thead><tr><th class="th-th-hour"></th>';
        for (const d of DAYS) html += `<th class="th-th-day">${d}</th>`;
        html += '</tr></thead><tbody>';
    
        for (let h = 0; h < 24; h++) {
            // Сессионные цвета для часа
            const sess = SESSIONS.find(s => h >= s.start && h < s.end);
            const hourBorderStyle = sess ? `border-left:3px solid ${sess.color};` : 'border-left:3px solid transparent;';
    
            html += `<tr><td class="th-td-hour" style="${hourBorderStyle}">${HOURS[h]}</td>`;
            for (let d = 0; d < 7; d++) {
                const cell = r.cells.find(c=>c.day===d&&c.hour===h);
                if (!cell || cell.total < minT) {
                    html += `<td class="th-cell th-cell-empty"></td>`;
                    continue;
                }
                const val  = getCellValue(cell);
                const norm = vMax > vMin ? (val - vMin)/(vMax - vMin) : 0.5;
                const bg   = valToColor(norm, metric);
                const lbl  = metric==='winRate'  ? (val?.toFixed(0)+'%') :
                             metric==='count'    ? cell.total :
                             (val >= 0 ? '+' : '') + val?.toFixed(0);
                html += `<td class="th-cell" style="background:${bg}"
                    data-d="${d}" data-h="${h}"
                    data-total="${cell.total}" data-wr="${cell.winRate}"
                    data-avgpnl="${cell.avgPnl}" data-totalpnl="${cell.totalPnl}">
                    <span class="th-cell-val">${lbl}</span>
                </td>`;
            }
            html += '</tr>';
        }
        html += '</tbody></table>';
        container.innerHTML = html;
    
        // Tooltip
        container.addEventListener('mouseover', e => {
            const td = e.target.closest('.th-cell:not(.th-cell-empty)');
            if (!td) return;
            const h = parseInt(td.dataset.h);
            const d = parseInt(td.dataset.d);
            const sess = SESSIONS.find(s => h >= s.start && h < s.end);
            const tip  = document.getElementById('th-tooltip');
            if (!tip) return;
            tip.innerHTML = `
                <div class="th-tip-title">${DAYS[d]} ${HOURS[h]}</div>
                ${sess?`<div class="th-tip-session">${sess.name} session</div>`:''}
                <div class="th-tip-row"><span>Trades</span><span><b>${td.dataset.total}</b></span></div>
                <div class="th-tip-row"><span>Win Rate</span><span class="${parseFloat(td.dataset.wr)>=50?'ai-pos':'ai-neg'}">${td.dataset.wr}%</span></div>
                <div class="th-tip-row"><span>Avg PnL</span><span class="${parseFloat(td.dataset.avgpnl)>=0?'ai-pos':'ai-neg'}">${parseFloat(td.dataset.avgpnl)>=0?'+':''}${td.dataset.avgpnl}</span></div>
                <div class="th-tip-row"><span>Total PnL</span><span class="${parseFloat(td.dataset.totalpnl)>=0?'ai-pos':'ai-neg'}">${parseFloat(td.dataset.totalpnl)>=0?'+':''}${td.dataset.totalpnl}</span></div>`;
            tip.style.display='block';
            tip.style.left=(e.clientX+14)+'px';
            tip.style.top=(e.clientY-10)+'px';
        });
        container.addEventListener('mousemove', e => {
            const tip=document.getElementById('th-tooltip');
            if(tip&&tip.style.display!=='none'){tip.style.left=(e.clientX+14)+'px';tip.style.top=(e.clientY-10)+'px';}
        });
        container.addEventListener('mouseout', e => {
            if(!e.target.closest('.th-cell')){const tip=document.getElementById('th-tooltip');if(tip)tip.style.display='none';}
        });
    }
    
    function buildScaleBar() {
        const bar = document.getElementById('th-scale-bar');
        if (!bar) return;
        bar.style.background = TH.cfg.metric === 'count'
            ? 'linear-gradient(90deg,rgba(74,158,50,.3),rgba(74,158,230,.8))'
            : 'linear-gradient(90deg,rgba(239,83,80,.6),rgba(255,152,0,.6),rgba(76,175,80,.7))';
    }
    
    function buildSessionBreakdown(r) {
        const el = document.getElementById('th-sessions');
        if (!el) return;
        const minT = TH.cfg.minTrades;
        const html = SESSIONS.map(s => {
            const cs = r.cells.filter(c => c.hour>=s.start && c.hour<s.end && c.total>=minT);
            if (!cs.length) return '';
            const total = cs.reduce((a,c)=>a+c.total,0);
            const wins  = cs.reduce((a,c)=>a+c.wins, 0);
            const pnl   = cs.reduce((a,c)=>a+c.totalPnl,0);
            const wr    = total ? +(wins/total*100).toFixed(1) : 0;
            return `<div class="th-sess-card">
                <div class="th-sess-name" style="border-bottom:2px solid ${s.color}">${s.name}</div>
                <div class="th-sess-hours">${String(s.start).padStart(2,'0')}:00 – ${String(s.end).padStart(2,'0')}:00 UTC</div>
                <div class="th-sess-row"><span>Trades</span><strong>${total}</strong></div>
                <div class="th-sess-row"><span>Win Rate</span><strong class="${wr>=50?'ai-pos':'ai-neg'}">${wr}%</strong></div>
                <div class="th-sess-row"><span>Total PnL</span><strong class="${pnl>=0?'ai-pos':'ai-neg'}">${pnl>=0?'+':''}${pnl.toFixed(0)}</strong></div>
            </div>`;
        }).join('');
        el.innerHTML = html || '<div class="ai-nodata">No session data.</div>';
    }
    
    // ── CHARTS ──────────────────────────────────────────────────────
    
    function destroyCharts() {
        Object.values(TH.charts).forEach(c => { try { c.destroy(); } catch(_) {} });
        TH.charts = {};
    }
    
    function ensureChart(cb) {
        if (window.Chart) { cb(); return; }
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
        s.onload = cb; document.head.appendChild(s);
    }
    
    function barColor(wr) {
        if (wr === null) return 'rgba(255,255,255,0.05)';
        return wr>=60?'rgba(76,175,80,0.75)':wr>=50?'rgba(139,195,74,0.75)':wr>=40?'rgba(255,152,0,0.7)':'rgba(239,83,80,0.7)';
    }
    
    function drawHourChart(r) {
        ensureChart(() => {
            const canvas = document.getElementById('th-hour-chart');
            if (!canvas) return;
            TH.charts['hour'] = new Chart(canvas, {
                type: 'bar',
                data: {
                    labels: HOURS,
                    datasets: [
                        { label:'Win Rate %', data:r.byHour.map(h=>h.winRate), backgroundColor:r.byHour.map(h=>barColor(h.winRate)), borderRadius:2, yAxisID:'y', order:2 },
                        { label:'Trades', data:r.byHour.map(h=>h.total), type:'line', borderColor:'rgba(74,158,255,0.5)', backgroundColor:'transparent', borderWidth:1.5, pointRadius:2, fill:false, yAxisID:'y2', order:1 },
                    ],
                },
                options: {
                    responsive:true, maintainAspectRatio:false,
                    interaction:{ mode:'index', intersect:false },
                    plugins:{ legend:{ labels:{ color:'#787b86',boxWidth:12,font:{size:10} } } },
                    scales:{
                        x:{ ticks:{ color:'#787b86',font:{size:9},maxRotation:0 }, grid:{ display:false } },
                        y:{ position:'left', min:0, max:100, ticks:{ color:'#787b86' }, grid:{ color:'rgba(255,255,255,.05)' } },
                        y2:{ position:'right', ticks:{ color:'#4a9eff' }, grid:{ display:false } },
                    },
                },
            });
        });
    }
    
    function drawDayChart(r) {
        ensureChart(() => {
            const canvas = document.getElementById('th-day-chart');
            if (!canvas) return;
            TH.charts['day'] = new Chart(canvas, {
                type: 'bar',
                data: {
                    labels: DAYS,
                    datasets: [
                        { label:'Win Rate %', data:r.byDay.map(d=>d.winRate), backgroundColor:r.byDay.map(d=>barColor(d.winRate)), borderRadius:3, yAxisID:'y', order:2 },
                        { label:'Trades', data:r.byDay.map(d=>d.total), type:'line', borderColor:'rgba(74,158,255,0.5)', backgroundColor:'transparent', borderWidth:1.5, pointRadius:3, fill:false, yAxisID:'y2', order:1 },
                    ],
                },
                options: {
                    responsive:true, maintainAspectRatio:false,
                    interaction:{ mode:'index', intersect:false },
                    plugins:{ legend:{ labels:{ color:'#787b86',boxWidth:12,font:{size:10} } } },
                    scales:{
                        x:{ ticks:{ color:'#787b86' }, grid:{ display:false } },
                        y:{ position:'left', min:0, max:100, ticks:{ color:'#787b86' }, grid:{ color:'rgba(255,255,255,.05)' } },
                        y2:{ position:'right', ticks:{ color:'#4a9eff' }, grid:{ display:false } },
                    },
                },
            });
        });
    }
    
    // ── HELPERS ─────────────────────────────────────────────────────
    
    function getTrades() {
        if (window.SB_TRADES){ const t=window.SB_TRADES(); if(t?.length) return t; }
        if (window._lastBacktestTrades?.length) return window._lastBacktestTrades;
        if (window._sbState?.trades?.length)    return window._sbState.trades;
        return [];
    }
    function esc(s){ return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    function kpi(label,value){ return `<div class="ai-kpi"><div class="ai-kpi-l">${label}</div><div class="ai-kpi-v">${value}</div></div>`; }
    function slotsTable(slots, type) {
        if (!slots?.length) return '<div class="ai-nodata">—</div>';
        return `<div style="overflow-x:auto;padding:4px 6px"><table class="ai-tbl">
            <thead><tr><th>Day</th><th>Hour</th><th>Trades</th><th>Win Rate</th><th>Avg PnL</th></tr></thead>
            <tbody>${slots.map(s=>`<tr>
                <td><strong>${esc(s.day)}</strong></td>
                <td style="font-family:monospace;font-size:11px">${esc(s.hour)}</td>
                <td>${s.total}</td>
                <td class="${type==='best'?'ai-pos':'ai-neg'}">${s.winRate}%</td>
                <td class="${s.avgPnl>=0?'ai-pos':'ai-neg'}">${s.avgPnl>=0?'+':''}${s.avgPnl}</td>
            </tr>`).join('')}</tbody>
        </table></div>`;
    }
    
    // ── CSS ─────────────────────────────────────────────────────────
    
    function injectCSS() {
        if (document.getElementById('th-css')) return;
        const s = document.createElement('style');
        s.id = 'th-css';
        s.textContent = `
    .th-heatmap-wrap{padding:4px 8px 0;overflow-x:auto}
    .th-grid-table{border-collapse:collapse;font-size:10px;width:100%;table-layout:fixed}
    .th-th-hour{width:44px;font-size:8px;color:#2a3050;padding:2px 3px}
    .th-th-day{font-size:9px;font-weight:700;color:#787b86;text-align:center;padding:3px 0}
    .th-td-hour{font-size:9px;color:#6a7090;text-align:right;padding:1px 5px 1px 0;white-space:nowrap;font-family:monospace}
    .th-cell{text-align:center;padding:0;height:17px;cursor:default;transition:filter .1s;border:1px solid rgba(0,0,0,.2);position:relative}
    .th-cell:hover{filter:brightness(1.35);outline:1px solid rgba(255,255,255,.4);z-index:2}
    .th-cell-empty{background:rgba(255,255,255,.02)}
    .th-cell-val{font-size:8px;line-height:17px;font-weight:700;color:rgba(255,255,255,.9);display:block;pointer-events:none;text-shadow:0 0 3px rgba(0,0,0,.8)}
    .th-color-scale{display:flex;align-items:center;gap:8px;padding:5px 12px 10px;font-size:9px;color:#6a7090;flex-wrap:wrap}
    .th-scale-bar{width:100px;height:5px;border-radius:3px;flex-shrink:0}
    .th-scale-empty{color:#2a3050}
    .th-legend-sessions{display:flex;gap:6px;margin-left:auto}
    .th-sess-dot{padding:1px 6px;border-radius:9px;border:1px solid;font-size:9px}
    .th-bw-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
    .th-sessions{display:flex;gap:8px;padding:8px 12px 12px;flex-wrap:wrap}
    .th-sess-card{background:#111320;border:1px solid #1a1e30;border-radius:6px;padding:10px 14px;flex:1;min-width:130px}
    .th-sess-name{font-size:12px;font-weight:700;color:#c8ccd8;margin-bottom:4px;padding-bottom:4px}
    .th-sess-hours{font-size:9px;color:#444c70;margin-bottom:6px;font-family:monospace}
    .th-sess-row{display:flex;justify-content:space-between;font-size:11px;color:#6a7090;margin-bottom:3px}
    .th-sess-row strong{color:#c8ccd8}
    .th-tooltip{position:fixed;z-index:9999;background:#0d0f1a;border:1px solid #1a1e30;border-radius:6px;padding:8px 12px;font-size:11px;color:#c8ccd8;pointer-events:none;min-width:150px;box-shadow:0 4px 20px rgba(0,0,0,.6)}
    .th-tip-title{font-weight:700;font-size:13px;margin-bottom:4px;color:#fff}
    .th-tip-session{font-size:9px;color:#444c70;margin-bottom:5px;text-transform:uppercase;letter-spacing:.06em}
    .th-tip-row{display:flex;justify-content:space-between;gap:16px;margin-bottom:2px}
    .th-tip-row span:first-child{color:#6a7090}
    `;
        document.head.appendChild(s);
    }
    
    // ── INIT ────────────────────────────────────────────────────────
    
    injectTab();
    console.log('[TemporalHeatmap] v1.0 loaded');
    
    })(); }