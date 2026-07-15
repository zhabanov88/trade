/**
 * backtest-page.js  v5.0
 * v4.1 base + Range-Bar backtest support
 */

(function () {
    'use strict';
  
    const BP = {
      setups:        [],
      instruments:   [],
      intervals:     [],
      strategies:    [],
      strategyTypeId: null,
      view: 'configure',
      cfg: defaultCfg(),
      session: null,
      sessionFilter: defaultSessionFilter(),
      sessionPage:   0,
      SESSION_PAGE:  50,
      loading: false,
      error:   null,
    };
  
    function defaultCfg() {
      return {
        setupId:          null,
        setupName:        '',
        setupMeta:        null,
        selectedInstruments: [],
        selectedIntervals:   [],
        periodMode:  'all',
        inSamplePct: 70,
        fromDate:    '',
        toDate:      '',
        commission:  0.1,
        paramMatrix: {},
        entryFilter: '',
        exitFilter:  '',
        // ── Range-Bar ──────────────────────────────────────────────
        backtestType:      'standard',  // 'standard' | 'rangebar'
        rb_ticker:         'ESU6',
        rb_gex_ticker:     'SPX_classic_gex_zero',
        rb_range_pts:      10,
        rb_delta:          95,
        rb_gex_vol:        4000,
        rb_zgamma_offset:  5,
        rb_branch_a:       true,
        rb_branch_b:       true,
        rb_limit_offset:   0.25,
        rb_sl_ticks:       11,
        rb_tp_ticks:       19,
        rb_cancel_ticks:   10,
      };
    }
  
    function defaultSessionFilter() {
      return {
        search: '', minTrades: '', maxTrades: '',
        minWinRate: '', maxWinRate: '', minPnl: '', maxPnl: '',
        instrument: '', interval: '', sortField: 'pnl', sortDir: 'desc',
      };
    }
  
    // ════════════════════════════════════════════════════════════
    // API
    // ════════════════════════════════════════════════════════════
  
    async function apiFetch(url, opts = {}) {
      const r = await fetch(url, { credentials: 'include', ...opts });
      if (!r.ok) {
        const e = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(e.error || r.statusText);
      }
      return r.json();
    }
  
    function parseMeta(raw) {
      if (!raw) return {};
      if (typeof raw === 'object') return raw;
      try { return JSON.parse(raw); } catch (_) { return {}; }
    }
  
    async function loadAll() {
      BP.loading = true;
      if (BP.view !== 'session' && BP.view !== 'running') renderPage();
      try {
        const [typesR, scriptsR, instR, intR] = await Promise.allSettled([
          apiFetch('/api/script-types'),
          apiFetch('/api/javascript-scripts'),
          apiFetch('/api/instruments'),
          apiFetch('/api/intervals'),
        ]);
        if (typesR.status === 'fulfilled')
          BP.strategyTypeId = typesR.value.find(x => x.code === 'strategy')?.id ?? null;
        if (scriptsR.status === 'fulfilled') {
          const all = scriptsR.value;
          BP.setups     = all.filter(s => s.type_code === 'setup').map(s => ({ ...s, _meta: parseMeta(s.meta) }));
          BP.strategies = all.filter(s => s.type_code === 'strategy').map(s => ({ ...s, _meta: parseMeta(s.meta) }));
        }
        if (instR.status === 'fulfilled')
          BP.instruments = (instR.value || []).filter(i => i.clickhouse_ticker && i.is_active !== false);
        if (intR.status === 'fulfilled')
          BP.intervals = (intR.value || []).filter(i => i.clickhouse_table && i.is_active !== false);
      } catch (e) { BP.error = e.message; }
      finally {
        BP.loading = false;
        if (BP.view !== 'session' && BP.view !== 'running') renderPage();
      }
    }
  
    // ════════════════════════════════════════════════════════════
    // BUILD RUNS
    // ════════════════════════════════════════════════════════════
  
    function buildRuns(cfg) {
      const insts = cfg.selectedInstruments, ivals = cfg.selectedIntervals;
      const paramCombos = buildParamCombos(cfg.paramMatrix);
      if (!insts.length || !ivals.length) return [];
      const runs = [];
      for (const inst of insts) for (const ival of ivals) for (const params of paramCombos)
        runs.push({ inst, ival, params });
      return runs;
    }
  
    function buildParamCombos(matrix) {
      const keys = Object.keys(matrix).filter(k => matrix[k]?.length);
      if (!keys.length) return [{}];
      let combos = [{}];
      for (const key of keys) {
        const next = [];
        for (const combo of combos) for (const val of matrix[key])
          next.push({ ...combo, [key]: val });
        combos = next;
      }
      return combos;
    }
  
    function dateRangeFromPeriod(cfg) {
      if (cfg.periodMode === 'all') return { fromDate: null, toDate: null };
      if (cfg.periodMode === 'custom') return { fromDate: cfg.fromDate || null, toDate: cfg.toDate || null };
      const pct = (cfg.inSamplePct || 70) / 100;
      if (!cfg.fromDate || !cfg.toDate) return { fromDate: null, toDate: null };
      const from = new Date(cfg.fromDate).getTime(), to = new Date(cfg.toDate).getTime();
      const mid  = new Date(from + (to - from) * pct).toISOString().slice(0, 10);
      if (cfg.periodMode === 'in_sample')     return { fromDate: cfg.fromDate, toDate: mid };
      if (cfg.periodMode === 'out_of_sample') return { fromDate: mid, toDate: cfg.toDate };
      return { fromDate: null, toDate: null };
    }
  
    function buildSetupCols(setup, paramOverrides) {
      const meta = setup._meta || {}, criteria = meta.criteria || {}, cols = {};
      criteria.filter && criteria.filter(c => c.enabled !== false).forEach((c, i) => {
        const params = { ...(c.params || {}) };
        if (paramOverrides) Object.entries(paramOverrides).forEach(([k, v]) => { if (k in params) params[k] = v; });
        cols[`crit_${i}`] = {
          scriptId: c.scriptId, scriptName: c.scriptName || c.label,
          dir: 'long', params,
          entryExpression: meta.entry_expression || null,
          exitExpression:  meta.exit_expression  || null,
        };
      });
      return cols;
    }
  
    // ════════════════════════════════════════════════════════════
    // SSE RUNNER
    // ════════════════════════════════════════════════════════════
  
    function runWithSSE(url, body, runIdx) {
      return new Promise((resolve, reject) => {
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                     credentials: 'include', body: JSON.stringify(body) })
        .then(resp => {
          if (!resp.ok) return resp.json().then(e => { throw new Error(e.error || `HTTP ${resp.status}`); });
          const ct = resp.headers.get('content-type') || '';
          if (!ct.includes('text/event-stream')) return resp.json().then(d => d.error ? Promise.reject(new Error(d.error)) : d);
  
          const reader = resp.body.getReader(), dec = new TextDecoder();
          let buf = '', settled = false, curEvt = null, curData = null;
          const done_ = fn => { if (!settled) { settled = true; fn(); } };
  
          const read = () => {
            if (settled) return;
            reader.read().then(({ done, value }) => {
              if (settled) return;
              if (done) {
                const rem = buf.trim();
                if (rem) {
                  const ls = rem.split('\n'); let ev = null, da = null;
                  for (const l of ls) {
                    if (l.startsWith('event: ')) ev = l.slice(7).trim();
                    else if (l.startsWith('data: ')) da = l.slice(6);
                  }
                  if (ev === 'result' && da) try { done_(() => resolve(JSON.parse(da))); return; } catch(_){}
                  if (ev === 'error'  && da) try { done_(() => reject(new Error(JSON.parse(da).error))); return; } catch(_){}
                }
                done_(() => reject(new Error('SSE ended without result')));
                return;
              }
              buf += dec.decode(value, { stream: true });
              const lines = buf.split('\n');
              buf = lines.pop() || '';
              for (const line of lines) {
                if (line.startsWith('event: '))      { curEvt = line.slice(7).trim(); curData = null; }
                else if (line.startsWith('data: '))  { curData = (curData ?? '') + line.slice(6); }
                else if (line === '') {
                  if (curEvt && curData != null) {
                    let d = null;
                    try { d = JSON.parse(curData); } catch(_){}
                    if (d) {
                      if (curEvt === 'progress') updateScriptProgress(runIdx, d);
                      else if (curEvt === 'result') { done_(() => resolve(d)); return; }
                      else if (curEvt === 'error')  { done_(() => reject(new Error(d.error || 'error'))); return; }
                    }
                  }
                  curEvt = null; curData = null;
                }
              }
              read();
            }).catch(e => done_(() => reject(e)));
          };
          read();
        }).catch(reject);
      });
    }
  
    // ════════════════════════════════════════════════════════════
    // STANDARD SESSION
    // ════════════════════════════════════════════════════════════
  
    async function runSession() {
      const cfg = BP.cfg;
      const setup = BP.setups.find(s => s.id === cfg.setupId);
      if (!setup)                          { alert('Выберите сетап'); return; }
      if (!cfg.selectedInstruments.length) { alert('Выберите хотя бы 1 инструмент'); return; }
      if (!cfg.selectedIntervals.length)   { alert('Выберите хотя бы 1 таймфрейм'); return; }
      const runs = buildRuns(cfg);
      if (!runs.length) { alert('Нет комбинаций'); return; }
  
      BP.session = {
        id: Date.now(), name: `${setup.display_name} · ${new Date().toLocaleString('ru')}`,
        setupId: setup.id, setupName: setup.display_name, type: 'standard',
        runs: runs.map(r => ({ ...r, status: 'pending', result: null, error: null })),
        totalRuns: runs.length, doneRuns: 0, errorRuns: 0, startedAt: new Date().toISOString(),
      };
      BP.view = 'running'; renderPage();
  
      for (let i = 0; i < BP.session.runs.length; i++) {
        if (BP._cancelRequested) break;
        const run = BP.session.runs[i];
        run.status = 'running'; updateRunProgressUI(i);
        try {
          const { fromDate, toDate } = dateRangeFromPeriod(cfg);
          const setupMeta   = setup._meta || null;
          const mtfUpTables = setupMeta?.mtf_up_tables || [];
          // Для тикового таймфрейма передаём raw_config
          const isRawTicks = run.ival.clickhouse_table === 'raw_market_data';
          const setupMeta2 = setup._meta || {};
          const rbCrit     = isRawTicks && (setupMeta2.criteria || []).find(c => c.scriptName === 'RangeBar Engine');
          const rawConfig  = isRawTicks ? {
            ticker:       run.inst.clickhouse_ticker,
            provider_id:  200,
            gex_ticker:   rbCrit?.params?.gex_ticker || 'SPX_classic_gex_zero',
            gex_provider: 100,
          } : null;
  
          const body = {
            ticker:    run.inst.clickhouse_ticker, table: run.ival.clickhouse_table,
            fromDate:  fromDate || undefined, toDate: toDate || undefined,
            commission: cfg.commission, capital: 10000, riskPct: 1, leverage: 1, direction: 'both',
            setupCols: buildSetupCols(setup, run.params),
            entryFilter: cfg.entryFilter || undefined, exitFilter: cfg.exitFilter || undefined,
            setupMeta, mtfUpTables,
            raw_config: rawConfig || undefined,
          };
          run.result = await runWithSSE('/api/backtest/run', body, i);
          run.status = 'done';
        } catch (e) {
          run.status = 'error'; run.error = e.message; BP.session.errorRuns++;
        }
        BP.session.doneRuns++; updateRunProgressUI(i);
        await new Promise(r => setTimeout(r, 10));
      }
      BP._cancelRequested = false;
      BP.view = 'session'; renderPage();
      saveSession(BP.session).catch(e => console.warn('Save failed:', e));
    }
  
    // ════════════════════════════════════════════════════════════
    // RANGE-BAR SESSION
    // ════════════════════════════════════════════════════════════
  
    async function runRangeBarSession() {
      const cfg = BP.cfg;
      if (!cfg.fromDate || !cfg.toDate) { alert('Укажите диапазон дат (от / до)'); return; }
      if (!cfg.rb_branch_a && !cfg.rb_branch_b) { alert('Выберите хотя бы одну ветку (A или B)'); return; }
  
      BP.session = {
        id: Date.now(),
        name: `RangeBar ${cfg.rb_ticker} ${cfg.rb_range_pts}pts · ${cfg.fromDate}–${cfg.toDate} · ${new Date().toLocaleString('ru')}`,
        setupId: null, setupName: `Range-Bar ${cfg.rb_range_pts}pts`, type: 'rangebar',
        runs: [{ status: 'running', result: null, error: null,
                 inst: { symbol: cfg.rb_ticker, clickhouse_ticker: cfg.rb_ticker },
                 ival: { name: `RB-${cfg.rb_range_pts}pts`, clickhouse_table: '' },
                 params: {} }],
        totalRuns: 1, doneRuns: 0, errorRuns: 0, startedAt: new Date().toISOString(),
      };
      BP.view = 'running'; renderPage();
  
      try {
        const body = {
          ticker:            cfg.rb_ticker,
          gex_ticker:        cfg.rb_gex_ticker,
          from_date:         cfg.fromDate,
          to_date:           cfg.toDate,
          range_pts:         cfg.rb_range_pts,
          delta_threshold:   cfg.rb_delta,
          gex_vol_max:       cfg.rb_gex_vol,
          zero_gamma_offset: cfg.rb_zgamma_offset,
          limit_offset:      cfg.rb_limit_offset,
          sl_ticks:          cfg.rb_sl_ticks,
          tp_ticks:          cfg.rb_tp_ticks,
          cancel_ticks:      cfg.rb_cancel_ticks,
          branch_a:          cfg.rb_branch_a,
          branch_b:          cfg.rb_branch_b,
        };
        const result = await runWithSSE('/api/backtest/rangebar', body, 0);
        BP.session.runs[0].status = 'done';
        BP.session.runs[0].result = result;
        BP.session.doneRuns = 1;
      } catch (e) {
        BP.session.runs[0].status = 'error';
        BP.session.runs[0].error  = e.message;
        BP.session.errorRuns = 1;
        BP.session.doneRuns  = 1;
      }
      BP.view = 'session'; renderPage();
      saveRangeBarSession(BP.session).catch(e => console.warn('Save failed:', e));
    }
  
    async function saveRangeBarSession(session) {
      if (!BP.strategyTypeId) return;
      const run = session.runs[0], res = run?.result;
      const meta = {
        session_summary: {
          name: session.name, setupName: session.setupName,
          startedAt: session.startedAt, totalRuns: 1, doneRuns: session.doneRuns,
          errorRuns: session.errorRuns, type: 'rangebar',
        },
        runs: [{
          instrument: session.runs[0].inst?.symbol,
          ticker: session.runs[0].inst?.symbol,
          interval: session.runs[0].ival?.name,
          params: res?.cfg || {},
          status: run?.status,
          trades_a: res?.branch_a?.trades?.length || 0,
          trades_b: res?.branch_b?.trades?.length || 0,
          stats_a:  res?.branch_a?.stats || null,
          stats_b:  res?.branch_b?.stats || null,
          total_bars: res?.total_bars || 0,
          total_ticks: res?.total_ticks || 0,
        }],
        rangebar_result: res,
      };
      await apiFetch('/api/javascript-scripts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: session.name, system_name: 'strategy_rb_' + session.id,
          type_id: BP.strategyTypeId, code: '{}', meta,
          is_public: false, inputs_schema: [], is_overlay: false,
        }),
      });
    }
  
    async function saveSession(session) {
      if (!BP.strategyTypeId) return;
      const meta = {
        session_summary: {
          name: session.name, setupId: session.setupId, setupName: session.setupName,
          startedAt: session.startedAt, totalRuns: session.totalRuns,
          doneRuns: session.doneRuns, errorRuns: session.errorRuns,
        },
        runs: session.runs.map(r => ({
          instrument: r.inst.symbol, ticker: r.inst.clickhouse_ticker,
          interval: r.ival.name, table: r.ival.clickhouse_table,
          params: r.params, status: r.status, error: r.error || undefined,
          trades: r.result?.trades?.length || 0,
          trades_data: r.result?.trades || [],   // ← сохраняем полные данные сделок
          stats: r.result?.stats || null,
        })),
      };
      await apiFetch('/api/javascript-scripts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: session.name, system_name: 'strategy_' + session.id,
          type_id: BP.strategyTypeId, code: '{}', meta,
          is_public: false, inputs_schema: [], is_overlay: false,
        }),
      });
    }
  
    // ════════════════════════════════════════════════════════════
    // PROGRESS HELPERS
    // ════════════════════════════════════════════════════════════
  
    function updateScriptProgress(runIdx, progress) {
      const root = getRoot(); if (!root) return;
      const pct  = BP.session
        ? Math.round((BP.session.doneRuns / BP.session.totalRuns * 100) + (progress.pct || 0) / BP.session.totalRuns)
        : (progress.pct || 0);
      const fill = root.querySelector('.bp-running-progress-fill');
      const pctEl = root.querySelector('.bp-running-pct');
      const curEl  = root.querySelector('.bp-running-current');
      const run    = BP.session?.runs?.[runIdx];
      if (fill)  fill.style.width  = Math.min(pct, 99) + '%';
      if (pctEl) pctEl.textContent = Math.min(pct, 99) + '%';
      if (curEl && run) curEl.textContent = `${run.inst?.symbol} · ${run.ival?.name} — ${progress.message || ''}`;
    }
  
    function updateRunProgressUI(idx) {
      const root = getRoot(); if (!root || BP.view !== 'running') return;
      const s = BP.session; if (!s) return;
      const pct = s.totalRuns ? Math.round(s.doneRuns / s.totalRuns * 100) : 0;
      const fill = root.querySelector('.bp-running-progress-fill');
      const pctEl = root.querySelector('.bp-running-pct');
      const statsEl = root.querySelector('.bp-running-stats');
      const curEl   = root.querySelector('.bp-running-current');
      if (fill)  fill.style.width  = pct + '%';
      if (pctEl) pctEl.textContent = pct + '%';
      const done = s.runs.filter(r => r.status === 'done').length;
      const err  = s.runs.filter(r => r.status === 'error').length;
      if (statsEl) statsEl.innerHTML =
        `<span class="bp-rs-item"><b>${s.doneRuns}</b> / ${s.totalRuns} запусков</span>` +
        `<span class="bp-rs-item bp-pos"><b>${done}</b> успешно</span>` +
        (err ? `<span class="bp-rs-item bp-neg"><b>${err}</b> ошибок</span>` : '');
      const run = s.runs.find(r => r.status === 'running');
      if (curEl && run) curEl.textContent = `${run.inst?.symbol} · ${run.ival?.name}`;
    }
  
    // ════════════════════════════════════════════════════════════
    // HELPERS
    // ════════════════════════════════════════════════════════════
  
    function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function fmtPct(v) { if (v == null) return '—'; const n = parseFloat(v); return (n >= 0 ? '+' : '') + n.toFixed(1) + '%'; }
    function fmtPnl(v) { if (v == null) return '—'; const n = parseFloat(v); return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(0); }
    function fmtN(v, dec=2) { if (v == null || v === '') return '—'; return parseFloat(v).toFixed(dec); }
    function getRoot() { return document.getElementById('backtest-page-root'); }
  
    // ════════════════════════════════════════════════════════════
    // RENDER
    // ════════════════════════════════════════════════════════════
  
    function renderPage() {
      const root = getRoot(); if (!root) return;
      if (BP.loading && BP.view !== 'session' && BP.view !== 'running') {
        root.innerHTML = '<div class="bp-loading-full">Загрузка...</div>'; return;
      }
      if      (BP.view === 'configure') root.innerHTML = buildConfigureHTML();
      else if (BP.view === 'running')   root.innerHTML = buildRunningHTML();
      else if (BP.view === 'session')   root.innerHTML = buildSessionHTML(BP.session);
      else if (BP.view === 'history')   root.innerHTML = buildHistoryHTML();
      bindEvents();
    }
  
    // ─────────────────────────────────────────────
    // CONFIGURE HTML
    // ─────────────────────────────────────────────
  
    function buildConfigureHTML() {
      const cfg   = BP.cfg;
      const setup = BP.setups.find(s => s.id === cfg.setupId);
      const meta  = setup?._meta || {};
      const criteria = meta.criteria || [];
      const runs  = buildRuns(cfg);
      const isRB  = cfg.backtestType === 'rangebar';
  
      return `
      <div class="bp-page">
        <div class="bp-page-header">
          <h1 class="bp-title">Бэктест</h1>
          <div class="bp-header-actions">
            <button class="bp-btn bp-btn-ghost" id="bp-open-history">📁 История</button>
          </div>
        </div>
        <div class="bp-configure">
  
          <!-- Тип бэктеста -->
          <div class="bp-card">
            <div class="bp-card-section-title">Тип бэктеста</div>
            <div class="bp-bt-type-row">
              <button class="bp-bt-type-btn ${!isRB?'bp-bt-type-active':''}" id="bp-bt-standard">
                📊 Стандартный (индикаторы)
              </button>
              <button class="bp-bt-type-btn ${isRB?'bp-bt-type-active':''}" id="bp-bt-rangebar">
                📈 Range-Bar (ESU6/SPX)
              </button>
            </div>
          </div>
  
          ${isRB ? buildRangeBarConfigCard(cfg) : buildStandardConfigCards(cfg, setup, meta, criteria, runs)}
  
          <!-- Run footer -->
          <div class="bp-run-footer">
            <div class="bp-run-summary">
              ${isRB
                ? (cfg.fromDate && cfg.toDate
                    ? `<span class="bp-run-count">${(cfg.rb_branch_a?1:0)+(cfg.rb_branch_b?1:0)}</span> ветки · ${esc(cfg.rb_ticker)} · ${esc(cfg.fromDate)} → ${esc(cfg.toDate)}`
                    : '<span class="bp-run-count-zero">0</span> — укажите даты')
                : (runs.length
                    ? `<span class="bp-run-count">${runs.length}</span> запусков · ${cfg.selectedInstruments.length} инстр. × ${cfg.selectedIntervals.length} ТФ${Object.keys(cfg.paramMatrix).filter(k=>cfg.paramMatrix[k]?.length).length?' × параметры':''}`
                    : '<span class="bp-run-count-zero">0</span> — выберите инструменты и ТФ')}
            </div>
            <button class="bp-btn bp-btn-run" id="bp-run-btn"
              ${isRB
                ? (!cfg.fromDate||!cfg.toDate||(!cfg.rb_branch_a&&!cfg.rb_branch_b)?'disabled':'')
                : (!setup||!runs.length?'disabled':'')}>
              ▶ Запустить бэктест
            </button>
          </div>
        </div>
      </div>`;
    }
  
    function buildStandardConfigCards(cfg, setup, meta, criteria, runs) {
      return `
        ${setup ? `
        <div class="bp-card">
          <div class="bp-card-section-title">Сетап</div>
          <select class="bp-select bp-select-lg" id="bp-setup-sel">
            <option value="">Выберите сетап</option>
            ${BP.setups.map(s => `<option value="${s.id}" ${cfg.setupId===s.id?'selected':''}>${esc(s.display_name)}</option>`).join('')}
          </select>
        </div>
        <div class="bp-card">
          <div class="bp-card-section-title">Критерии сетапа <span class="bp-section-hint">Матрица параметров</span></div>
          ${criteria.length ? `
          <div class="bp-criteria-grid">
            ${criteria.filter(c=>c.enabled!==false).map(c => {
              const inputs = c.inputs_schema || [];
              return `<div class="bp-crit-card">
                <div class="bp-crit-card-name">${esc(c.label||c.scriptName||'Критерий')}</div>
                ${inputs.map(inp => {
                  const mk  = c.id+':'+inp.id;
                  const mv  = (cfg.paramMatrix[mk]||[]).join(', ');
                  const def = c.params?.[inp.id]??inp.defval??'';
                  return `<div class="bp-crit-param">
                    <label class="bp-label">${esc(inp.name||inp.id)}</label>
                    <div class="bp-param-row">
                      <input class="bp-input bp-input-sm" type="text" value="${esc(def)}" readonly style="flex:0 0 80px;color:#9aa0b2">
                      <span class="bp-param-sep">→</span>
                      <input class="bp-input bp-matrix-inp" type="text" data-matrix-key="${esc(mk)}" placeholder="10, 20, 30" value="${esc(mv)}">
                    </div></div>`;
                }).join('')}
              </div>`;
            }).join('')}
          </div>` : '<div class="bp-hint-empty">Нет критериев с параметрами</div>'}
          <div class="bp-expr-block">
            <div class="bp-expr-label">Условие входа</div>
            <pre class="bp-expr-ro">${esc(meta.entry_expression||'— не задано —')}</pre>
          </div>
          <div class="bp-expr-block">
            <div class="bp-expr-label">Фильтр входа <span class="bp-section-hint">AND к условию</span></div>
            <textarea class="bp-expr-ta" id="bp-entry-filter" rows="2" placeholder="bar.volume > bar.avg_volume * 1.5">${esc(cfg.entryFilter||'')}</textarea>
          </div>
          <div class="bp-expr-block" style="margin-top:12px">
            <div class="bp-expr-label">Условие выхода</div>
            <pre class="bp-expr-ro">${esc(meta.exit_expression||'— не задано —')}</pre>
          </div>
          <div class="bp-expr-block">
            <div class="bp-expr-label">Фильтр выхода <span class="bp-section-hint">AND к условию</span></div>
            <textarea class="bp-expr-ta" id="bp-exit-filter" rows="2" placeholder="bar.rsi_14 > 80">${esc(cfg.exitFilter||'')}</textarea>
          </div>
        </div>` : `
        <div class="bp-card">
          <div class="bp-card-section-title">Сетап</div>
          <select class="bp-select bp-select-lg" id="bp-setup-sel">
            <option value="">Выберите сетап</option>
            ${BP.setups.map(s => `<option value="${s.id}" ${cfg.setupId===s.id?'selected':''}>${esc(s.display_name)}</option>`).join('')}
          </select>
        </div>`}
  
        <div class="bp-card">
          <div class="bp-card-section-title">Параметры запуска</div>
          <div class="bp-params-grid-4">
            <div class="bp-field">
              <label class="bp-label">Период</label>
              <select class="bp-select" id="bp-period-sel">
                <option value="all"           ${cfg.periodMode==='all'?'selected':''}>Весь</option>
                <option value="in_sample"     ${cfg.periodMode==='in_sample'?'selected':''}>In-Sample</option>
                <option value="out_of_sample" ${cfg.periodMode==='out_of_sample'?'selected':''}>Out-Of-Sample</option>
                <option value="custom"        ${cfg.periodMode==='custom'?'selected':''}>Свой период</option>
              </select>
            </div>
            ${cfg.periodMode==='in_sample'||cfg.periodMode==='out_of_sample' ? `
            <div class="bp-field"><label class="bp-label">In-Sample %</label>
              <input class="bp-input" id="bp-insample-pct" type="number" min="10" max="95" step="5" value="${cfg.inSamplePct}"></div>` : ''}
            ${cfg.periodMode==='custom' ? `
            <div class="bp-field"><label class="bp-label">Дата от</label><input class="bp-input" id="bp-from-date" type="date" value="${esc(cfg.fromDate)}"></div>
            <div class="bp-field"><label class="bp-label">Дата до</label><input class="bp-input" id="bp-to-date" type="date" value="${esc(cfg.toDate)}"></div>` : ''}
            <div class="bp-field"><label class="bp-label">Комиссия (%)</label>
              <input class="bp-input" id="bp-commission" type="number" step="0.01" min="0" value="${cfg.commission}"></div>
          </div>
        </div>
  
        <div class="bp-card">
          <div class="bp-card-section-title">Инструменты и таймфреймы <span class="bp-section-hint">Cartesian product</span></div>
          <div class="bp-two-cols">
            <div class="bp-multi-col">
              <div class="bp-multi-header">
                <span class="bp-label">Инструменты</span>
                <button class="bp-link-btn" id="bp-inst-all">все</button>
                <button class="bp-link-btn" id="bp-inst-none">сброс</button>
              </div>
              <input class="bp-input bp-multi-search" id="bp-inst-search" type="text"
                placeholder="Поиск: ESU6, EUR..." autocomplete="off">
              <div class="bp-multi-list" id="bp-inst-list">
                ${BP.instruments.map(i => {
                  const sel = cfg.selectedInstruments.some(s => s.id === i.id);
                  const searchBlob = esc(`${i.symbol} ${i.name||''} ${i.clickhouse_ticker||''}`.toLowerCase());
                  return `<label class="bp-multi-item ${sel?'bp-multi-item-on':''}" data-search="${searchBlob}">
                    <input type="checkbox" class="bp-inst-cb"
                      data-id="${i.id}" data-symbol="${esc(i.symbol)}" data-ticker="${esc(i.clickhouse_ticker)}" ${sel?'checked':''}>
                    <span class="bp-multi-label">${esc(i.symbol)}</span>
                    ${i.name?`<span class="bp-multi-sub">${esc(i.name)}</span>`:''}
                  </label>`;
                }).join('')}
                <div class="bp-multi-empty" id="bp-inst-empty" style="display:none">Ничего не найдено</div>
              </div>
            </div>
            <div class="bp-multi-col">
              <div class="bp-multi-header">
                <span class="bp-label">Таймфреймы</span>
                <button class="bp-link-btn" id="bp-ival-all">все</button>
                <button class="bp-link-btn" id="bp-ival-none">сброс</button>
              </div>
              <input class="bp-input bp-multi-search" id="bp-ival-search" type="text"
                placeholder="Поиск: tick, minute..." autocomplete="off">
              <div class="bp-multi-list" id="bp-ival-list">
                ${BP.intervals.map(i => {
                  const sel = cfg.selectedIntervals.some(s => s.id === i.id);
                  const searchBlob = esc(`${i.name} ${i.code||''} ${i.clickhouse_table||''}`.toLowerCase());
                  return `<label class="bp-multi-item ${sel?'bp-multi-item-on':''}" data-search="${searchBlob}">
                    <input type="checkbox" class="bp-ival-cb"
                      data-id="${i.id}" data-code="${esc(i.code)}" data-name="${esc(i.name)}" data-table="${esc(i.clickhouse_table)}" ${sel?'checked':''}>
                    <span class="bp-multi-label">${esc(i.name)}</span>
                  </label>`;
                }).join('')}
                <div class="bp-multi-empty" id="bp-ival-empty" style="display:none">Ничего не найдено</div>
              </div>
            </div>
          </div>
        </div>`;
    }
  
    function buildRangeBarConfigCard(cfg) {
      const sl_pts = (cfg.rb_sl_ticks * 0.25).toFixed(2);
      const tp_pts = (cfg.rb_tp_ticks * 0.25).toFixed(2);
      const cx_pts = (cfg.rb_cancel_ticks * 0.25).toFixed(2);
      const sl_usd = (cfg.rb_sl_ticks * 12.5).toFixed(0);
      const tp_usd = (cfg.rb_tp_ticks * 12.5).toFixed(0);
  
      return `
      <div class="bp-card">
        <div class="bp-card-section-title">
          Параметры Range-Bar бэктеста
          <span class="bp-section-hint">E-mini S&P 500 · тик = 0.25 pts = $12.50 · 1 пункт = $50</span>
        </div>
  
        <!-- Строка 1: тикеры + диапазон дат -->
        <div class="bp-params-grid-4" style="margin-bottom:14px">
          <div class="bp-field">
            <label class="bp-label">Тикер (Massive)</label>
            <input class="bp-input" id="rb-ticker" type="text" value="${esc(cfg.rb_ticker)}" placeholder="ESU6">
          </div>
          <div class="bp-field">
            <label class="bp-label">GEX тикер</label>
            <input class="bp-input" id="rb-gex-ticker" type="text" value="${esc(cfg.rb_gex_ticker)}" placeholder="SPX_classic_gex_zero">
          </div>
          <div class="bp-field">
            <label class="bp-label">Дата от</label>
            <input class="bp-input" id="rb-from-date" type="date" value="${esc(cfg.fromDate)}">
          </div>
          <div class="bp-field">
            <label class="bp-label">Дата до</label>
            <input class="bp-input" id="rb-to-date" type="date" value="${esc(cfg.toDate)}">
          </div>
        </div>
  
        <!-- Строка 2: параметры баров и условий -->
        <div class="bp-params-grid-4" style="margin-bottom:14px">
          <div class="bp-field">
            <label class="bp-label">Range (пунктов)</label>
            <input class="bp-input" id="rb-range-pts" type="number" min="1" max="50" value="${cfg.rb_range_pts}">
          </div>
          <div class="bp-field">
            <label class="bp-label">Delta порог ②</label>
            <input class="bp-input" id="rb-delta" type="number" min="0" value="${cfg.rb_delta}">
          </div>
          <div class="bp-field">
            <label class="bp-label">GEX vol макс ④</label>
            <input class="bp-input" id="rb-gex-vol" type="number" min="0" value="${cfg.rb_gex_vol}">
          </div>
          <div class="bp-field">
            <label class="bp-label">Zero-gamma отступ ⑤</label>
            <input class="bp-input" id="rb-zgamma" type="number" value="${cfg.rb_zgamma_offset}">
          </div>
        </div>
  
        <!-- Строка 3: ордер -->
        <div class="bp-params-grid-4" style="margin-bottom:14px">
          <div class="bp-field">
            <label class="bp-label">SL тиков</label>
            <input class="bp-input" id="rb-sl-ticks" type="number" min="1" value="${cfg.rb_sl_ticks}">
            <span class="bp-field-hint">+${sl_pts} pts · $${sl_usd}</span>
          </div>
          <div class="bp-field">
            <label class="bp-label">TP тиков</label>
            <input class="bp-input" id="rb-tp-ticks" type="number" min="1" value="${cfg.rb_tp_ticks}">
            <span class="bp-field-hint">−${tp_pts} pts · $${tp_usd}</span>
          </div>
          <div class="bp-field">
            <label class="bp-label">Отмена лимитки (тиков вниз)</label>
            <input class="bp-input" id="rb-cancel-ticks" type="number" min="1" value="${cfg.rb_cancel_ticks}">
            <span class="bp-field-hint">−${cx_pts} pts</span>
          </div>
        </div>
  
        <!-- Ветки -->
        <div class="bp-rb-branches">
          <span class="bp-label">Ветки запуска:</span>
          <label class="bp-rb-branch-cb">
            <input type="checkbox" id="rb-branch-a" ${cfg.rb_branch_a?'checked':''}>
            Ветка A — с условием price &gt; major_neg_vol
          </label>
          <label class="bp-rb-branch-cb">
            <input type="checkbox" id="rb-branch-b" ${cfg.rb_branch_b?'checked':''}>
            Ветка B — без условия major_neg_vol
          </label>
        </div>
  
        <!-- Условия входа справка -->
        <div class="bp-rb-conditions">
          <div class="bp-label" style="margin-bottom:8px">Условия входа (AND):</div>
          <div class="bp-rb-cond-list">
            <div class="bp-rb-cond">① Бар медвежий: close = low = open − ${cfg.rb_range_pts} pts</div>
            <div class="bp-rb-cond">② Delta бара &gt; ${cfg.rb_delta} (Lee-Ready: uptick=+1, downtick=−1)</div>
            <div class="bp-rb-cond">③ Есть GEX данные для текущего момента</div>
            <div class="bp-rb-cond">④ sum_gex_vol ≥ −${cfg.rb_gex_vol}</div>
            <div class="bp-rb-cond">⑤ price &lt; zero_gamma − ${cfg.rb_zgamma_offset}</div>
            <div class="bp-rb-cond bp-rb-cond-branch-a">⑥ [Ветка A] price &gt; major_neg_vol</div>
          </div>
          <div class="bp-rb-order-summary">
            SHORT лимит: close + ${cfg.rb_limit_offset} ·
            SL: +${sl_pts} pts ($${sl_usd}) ·
            TP: −${tp_pts} pts ($${tp_usd}) ·
            Отмена лимитки: −${cx_pts} pts без заполнения
          </div>
        </div>
      </div>`;
    }
  
    // ─────────────────────────────────────────────
    // RUNNING HTML
    // ─────────────────────────────────────────────
  
    function buildRunningHTML() {
      const s = BP.session; if (!s) return '';
      const pct  = s.totalRuns ? Math.round(s.doneRuns / s.totalRuns * 100) : 0;
      const done = s.runs.filter(r => r.status === 'done').length;
      const err  = s.runs.filter(r => r.status === 'error').length;
      const run  = s.runs.find(r => r.status === 'running');
      return `
      <div class="bp-page bp-page-running">
        <div class="bp-running-box">
          <div class="bp-running-title">⚙ Выполняется бэктест</div>
          <div class="bp-running-name">${esc(s.name)}</div>
          <div class="bp-running-progress-wrap">
            <div class="bp-running-progress-bar">
              <div class="bp-running-progress-fill" style="width:${pct}%"></div>
            </div>
            <div class="bp-running-pct">${pct}%</div>
          </div>
          <div class="bp-running-stats">
            <span class="bp-rs-item"><b>${s.doneRuns}</b> / ${s.totalRuns} запусков</span>
            <span class="bp-rs-item bp-pos"><b>${done}</b> успешно</span>
            ${err ? `<span class="bp-rs-item bp-neg"><b>${err}</b> ошибок</span>` : ''}
          </div>
          ${run ? `<div class="bp-running-current">Сейчас: ${esc(run.inst.symbol)} · ${esc(run.ival.name)}</div>` : ''}
          <button class="bp-btn bp-btn-ghost" id="bp-cancel-run">Отменить</button>
        </div>
      </div>`;
    }
  
    // ─────────────────────────────────────────────
    // SESSION HTML
    // ─────────────────────────────────────────────
  
    function buildSessionHTML(session) {
      if (!session) return '<div class="bp-loading-full">Нет данных</div>';
      // Range-bar session — отдельный view
      if (session.type === 'rangebar') return buildRangeBarSessionHTML(session);
  
      const { runs } = session, f = BP.sessionFilter;
      let filtered = runs.filter(r => {
        const s = r.result?.stats || {};
        if (f.search && !`${r.inst?.symbol} ${r.ival?.name}`.toLowerCase().includes(f.search.toLowerCase())) return false;
        if (f.instrument && r.inst?.symbol !== f.instrument) return false;
        if (f.interval   && r.ival?.name   !== f.interval)   return false;
        const trades = r.result?.trades?.length || 0;
        const wr = parseFloat(s.winRate||0), pnl = parseFloat(s.totalPnl||0);
        if (f.minTrades  && trades < +f.minTrades)  return false;
        if (f.maxTrades  && trades > +f.maxTrades)  return false;
        if (f.minWinRate && wr    < +f.minWinRate)  return false;
        if (f.maxWinRate && wr    > +f.maxWinRate)  return false;
        if (f.minPnl     && pnl   < +f.minPnl)      return false;
        if (f.maxPnl     && pnl   > +f.maxPnl)      return false;
        return true;
      });
  
      const sf = f.sortField, sd = f.sortDir === 'asc' ? 1 : -1;
      filtered.sort((a, b) => {
        const sa = a.result?.stats||{}, sb = b.result?.stats||{};
        if (sf==='trades')  return sd*((a.result?.trades?.length||0)-(b.result?.trades?.length||0));
        if (sf==='winRate') return sd*(parseFloat(sa.winRate||0)-parseFloat(sb.winRate||0));
        if (sf==='pnl')     return sd*(parseFloat(sa.totalPnl||0)-parseFloat(sb.totalPnl||0));
        if (sf==='pf')      return sd*(parseFloat(sa.profitFactor||0)-parseFloat(sb.profitFactor||0));
        if (sf==='dd')      return sd*(parseFloat(sa.maxDrawdown||0)-parseFloat(sb.maxDrawdown||0));
        // Новые колонки
        if (sf==='ev') {
          const getEV = r => { const s=r.result?.stats||{}; const wr=parseFloat(s.winRate||0)/100; return wr*parseFloat(s.avgWin||0)-(1-wr)*Math.abs(parseFloat(s.avgLoss||0)); };
          return sd*(getEV(a)-getEV(b));
        }
        if (sf==='tpm') {
          const getTPM = r => { const t=r.result?.trades; if(!t||t.length<2)return 0; const span=(t[t.length-1].exitTs-t[0].entryTs)/(1000*60*60*24*30.5); return span>0?t.length/span:0; };
          return sd*(getTPM(a)-getTPM(b));
        }
        if (sf==='ppm') {
          const getPPM = r => { const t=r.result?.trades,s=r.result?.stats||{}; if(!t||t.length<2)return 0; const span=(t[t.length-1].exitTs-t[0].entryTs)/(1000*60*60*24*30.5); const cap=t[0]?.capitalBefore||10000; return span>0?(parseFloat(s.totalPnl||0)/cap*100/span):0; };
          return sd*(getPPM(a)-getPPM(b));
        }
        if (sf==='std') {
          const getSTD = r => { const t=r.result?.trades; if(!t||t.length<2)return 0; const pnls=t.map(x=>parseFloat(x.pnl||0)); const mean=pnls.reduce((a,b)=>a+b,0)/pnls.length; return Math.sqrt(pnls.reduce((a,b)=>a+(b-mean)**2,0)/pnls.length); };
          return sd*(getSTD(a)-getSTD(b));
        }
        return 0;
      });
  
      const PAGE=BP.SESSION_PAGE, total=filtered.length, pages=Math.ceil(total/PAGE);
      const page=Math.max(0,Math.min(BP.sessionPage,pages-1));
      const rows=filtered.slice(page*PAGE,(page+1)*PAGE);
  
      const done=runs.filter(r=>r.status==='done');
      const sumTrades=done.reduce((s,r)=>s+(r.result?.trades?.length||0),0);
      const avgPnl=done.length?done.reduce((s,r)=>s+parseFloat(r.result?.stats?.totalPnl||0),0)/done.length:null;
      const uInsts=[...new Set(runs.map(r=>r.inst?.symbol).filter(Boolean))];
      const uIvals=[...new Set(runs.map(r=>r.ival?.name).filter(Boolean))];
  
      const thSort=(label,field)=>{
        const active=sf===field, arrow=active?(sd===1?' ↑':' ↓'):'';
        return `<th class="bp-th ${active?'bp-th-active':''}" data-sort="${field}" style="cursor:pointer">${label}${arrow}</th>`;
      };
  
      return `
      <div class="bp-page">
        <div class="bp-session-header">
          <button class="bp-back-btn" id="bp-back-to-config">← Назад</button>
          <div class="bp-session-title">${esc(session.setupName||'Бэктест')}</div>
          <div class="bp-session-meta">${esc(session.startedAt?new Date(session.startedAt).toLocaleString('ru'):'')}</div>
          <div class="bp-session-open-all"><button class="bp-btn bp-btn-ghost bp-btn-sm" id="bp-open-history">📁 Все сессии</button></div>
        </div>
        <div class="bp-session-summary">
          ${sumCard('Запусков',session.totalRuns,'')}
          ${sumCard('Успешно',session.doneRuns,'bp-pos')}
          ${sumCard('Ошибок',session.errorRuns||0,session.errorRuns?'bp-neg':'')}
          ${sumCard('Сделок',sumTrades,'')}
          ${sumCard('Avg P&L',avgPnl!=null?fmtPnl(avgPnl):'—',avgPnl!=null&&avgPnl>=0?'bp-pos':'bp-neg')}
        </div>
        <div class="bp-session-filters">
          <input class="bp-input bp-filter-search" id="bp-sf-search" type="text" placeholder="Поиск..." value="${esc(f.search)}">
          <select class="bp-select" id="bp-sf-inst">
            <option value="">Все инструменты</option>
            ${uInsts.map(i=>`<option value="${esc(i)}" ${f.instrument===i?'selected':''}>${esc(i)}</option>`).join('')}
          </select>
          <select class="bp-select" id="bp-sf-ival">
            <option value="">Все ТФ</option>
            ${uIvals.map(i=>`<option value="${esc(i)}" ${f.interval===i?'selected':''}>${esc(i)}</option>`).join('')}
          </select>
          <div class="bp-filter-range-group"><span class="bp-label">Сделок:</span>
            <input class="bp-input bp-input-sm" id="bp-sf-min-trades" type="number" placeholder="от" value="${esc(f.minTrades)}">
            <input class="bp-input bp-input-sm" id="bp-sf-max-trades" type="number" placeholder="до" value="${esc(f.maxTrades)}">
          </div>
          <div class="bp-filter-range-group"><span class="bp-label">Win%:</span>
            <input class="bp-input bp-input-sm" id="bp-sf-min-wr" type="number" placeholder="от" value="${esc(f.minWinRate)}">
            <input class="bp-input bp-input-sm" id="bp-sf-max-wr" type="number" placeholder="до" value="${esc(f.maxWinRate)}">
          </div>
          <div class="bp-filter-range-group"><span class="bp-label">P&amp;L:</span>
            <input class="bp-input bp-input-sm" id="bp-sf-min-pnl" type="number" placeholder="от" value="${esc(f.minPnl)}">
            <input class="bp-input bp-input-sm" id="bp-sf-max-pnl" type="number" placeholder="до" value="${esc(f.maxPnl)}">
          </div>
          <button class="bp-btn bp-btn-ghost bp-btn-sm" id="bp-sf-reset">Сбросить</button>
        </div>
        <div class="bp-session-table-wrap">
          <table class="bp-session-tbl">
            <thead><tr>
              <th class="bp-th">Инструмент</th><th class="bp-th">ТФ</th><th class="bp-th">Параметры</th>
              ${thSort('Сделок','trades')}${thSort('Win%','winRate')}${thSort('P&L','pnl')}
              ${thSort('МО','ev')}${thSort('Сд/мес','tpm')}${thSort('% об/мес','ppm')}
              ${thSort('P.F','pf')}${thSort('DD','dd')}${thSort('σ','std')}<th class="bp-th">Статус</th><th class="bp-th">📈</th>
            </tr></thead>
            <tbody>
              ${!rows.length?`<tr><td colspan="12" style="text-align:center;padding:32px;color:#9aa0b2">Нет данных</td></tr>`:''}
              ${rows.map(r=>{
                const s=r.result?.stats||{}, trades=r.result?.trades?.length||0;
                const idx=BP.session?.runs?.indexOf(r)??-1;
                const clickable=r.status==='done'&&trades>0;
                const paramsStr=Object.entries(r.params||{}).map(([k,v])=>`${k.split(':').pop()}=${v}`).join(', ');
                return `<tr class="bp-session-row ${r.status==='error'?'bp-row-error':''} ${clickable?'bp-row-clickable':''}"
                  data-run-idx="${idx}" style="${clickable?'cursor:pointer':''}">
                  <td class="bp-td"><b>${esc(r.inst?.symbol||'—')}</b></td>
                  <td class="bp-td">${esc(r.ival?.name||'—')}</td>
                  <td class="bp-td"><span class="bp-params-cell">${esc(paramsStr||'—')}</span></td>
                  <td class="bp-td bp-num">${trades}</td>
                  <td class="bp-td bp-num ${parseFloat(s.winRate||0)>=50?'bp-pos':'bp-neg'}">${fmtN(s.winRate,1)}%</td>
                  <td class="bp-td bp-num ${parseFloat(s.totalPnl||0)>=0?'bp-pos':'bp-neg'}">${fmtPnl(s.totalPnl)}</td>
                  <td class="bp-td bp-num ${parseFloat(s.profitFactor||0)>=1?'bp-pos':'bp-neg'}">${fmtN(s.profitFactor,2)}</td>
                  <td class="bp-td bp-num bp-neg">${fmtPct(s.maxDrawdown)}</td>
                  <td class="bp-td bp-num">${(()=>{
                    const trades=r.result?.trades||[];
                    if(!trades.length||!s.winRate)return'—';
                    const wr=parseFloat(s.winRate)/100;
                    const avgW=parseFloat(s.avgWin||0), avgL=Math.abs(parseFloat(s.avgLoss||0));
                    const ev=wr*avgW-(1-wr)*avgL;
                    return(ev>=0?'+$':'-$')+Math.abs(ev).toFixed(0);
                  })()}</td>
                  <td class="bp-td bp-num">${(()=>{
                    const trades=r.result?.trades||[];
                    if(!trades.length)return'—';
                    const t=r.result?.trades;
                    if(!t||t.length<2)return'—';
                    const span=(t[t.length-1].exitTs-t[0].entryTs)/(1000*60*60*24*30.5);
                    return span>0?fmtN(trades.length/span,1):'—';
                  })()}</td>
                  <td class="bp-td bp-num">${(()=>{
                    const trades=r.result?.trades||[];
                    if(!trades.length)return'—';
                    const t=r.result?.trades;
                    if(!t||t.length<2)return'—';
                    const span=(t[t.length-1].exitTs-t[0].entryTs)/(1000*60*60*24*30.5);
                    const capital=t[0].capitalBefore||10000;
                    const totalPnl=parseFloat(s.totalPnl||0);
                    const ppm=span>0?(totalPnl/capital*100/span):0;
                    return(ppm>=0?'+':'')+ppm.toFixed(2)+'%';
                  })()}</td>
                  <td class="bp-td bp-num">${(()=>{
                    const trades=r.result?.trades||[];
                    if(trades.length<2)return'—';
                    const pnls=trades.map(t=>parseFloat(t.pnl||0));
                    const mean=pnls.reduce((a,b)=>a+b,0)/pnls.length;
                    const std=Math.sqrt(pnls.reduce((a,b)=>a+(b-mean)**2,0)/pnls.length);
                    return std.toFixed(1);
                  })()}</td>
                  <td class="bp-td">${r.status==='done'?'<span class="bp-status-ok">✓</span>':r.status==='error'?`<span class="bp-status-err" title="${esc(r.error||'')}">✕</span>`:'<span class="bp-status-pend">—</span>'}</td>
                  <td class="bp-td">${r.status==='done'&&(r.result?.trades?.length||r.trades_data?.length)?`<button class="bp-chart-indicator-btn bp-btn bp-btn-ghost bp-btn-sm" data-run="${runs.indexOf(r)}" data-sid="${session?.id||''}" title="Добавить на график как индикатор">📈</button>`:'—'}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
        ${pages>1?`
        <div class="bp-pagination">
          <button class="bp-btn bp-btn-ghost bp-btn-sm" id="bp-page-prev" ${page===0?'disabled':''}>← Пред.</button>
          <span class="bp-page-info">${page+1} / ${pages} (${total} записей)</span>
          <button class="bp-btn bp-btn-ghost bp-btn-sm" id="bp-page-next" ${page>=pages-1?'disabled':''}>След. →</button>
        </div>`:
        `<div class="bp-pagination"><span class="bp-page-info">${total} записей</span></div>`}
      </div>`;
    }
  
    function sumCard(label, value, cls) {
      return `<div class="bp-sum-card"><div class="bp-sum-label">${esc(label)}</div><div class="bp-sum-value ${esc(cls)}">${esc(String(value??'—'))}</div></div>`;
    }
  
    // ─────────────────────────────────────────────
    // RANGE-BAR SESSION HTML
    // ─────────────────────────────────────────────
  
    function buildRangeBarSessionHTML(session) {
      const run = session.runs?.[0], res = run?.result;
      const cfg = res?.cfg || {};
  
      const header = `
        <div class="bp-session-header">
          <button class="bp-back-btn" id="bp-back-to-config">← Назад</button>
          <div class="bp-session-title">${esc(session.name)}</div>
          <div class="bp-session-meta">${esc(session.startedAt?new Date(session.startedAt).toLocaleString('ru'):'')}</div>
          <div class="bp-session-open-all"><button class="bp-btn bp-btn-ghost bp-btn-sm" id="bp-open-history">📁 Все сессии</button></div>
        </div>`;
  
      if (run?.status === 'error') return `<div class="bp-page">${header}
        <div class="bp-rb-branch" style="border-color:#ef4444">
          <div class="bp-rb-branch-title" style="color:#ef4444">Ошибка выполнения</div>
          <div style="color:#ef4444;font-family:monospace;font-size:13px">${esc(run.error||'Unknown error')}</div>
        </div></div>`;
  
      if (!res) return `<div class="bp-page">${header}<div class="bp-hint-empty">Нет данных</div></div>`;
  
      const meta = `
        <div class="bp-rb-meta-row">
          <div class="bp-rb-meta-item"><span>Тикер</span><b>${esc(res.ticker||'—')}</b></div>
          <div class="bp-rb-meta-item"><span>Тиков</span><b>${(res.total_ticks||0).toLocaleString()}</b></div>
          <div class="bp-rb-meta-item"><span>Range-баров</span><b>${(res.total_bars||0).toLocaleString()}</b></div>
          <div class="bp-rb-meta-item"><span>GEX записей</span><b>${(res.gex_records||0).toLocaleString()}</b></div>
          <div class="bp-rb-meta-item"><span>Range</span><b>${cfg.range_pts||10} pts</b></div>
          <div class="bp-rb-meta-item"><span>Период</span><b>${esc(res.from_date||'')} – ${esc(res.to_date||'')}</b></div>
        </div>`;
  
      const branches = [
        { key:'branch_a', label:'Ветка A', sub:'С условием price > major_neg_vol', data: res.branch_a },
        { key:'branch_b', label:'Ветка B', sub:'Без условия major_neg_vol',         data: res.branch_b },
      ].filter(b => b.data);
  
      const branchHTML = branches.map(b => {
        const s = b.data?.stats, trades = b.data?.trades || [];
        if (!s || !s.total) return `
          <div class="bp-rb-branch">
            <div class="bp-rb-branch-title">${esc(b.label)} <span class="bp-rb-branch-sub">${esc(b.sub)}</span></div>
            <div class="bp-hint-empty">Нет сделок — условия не сработали</div>
          </div>`;
  
        const pnlCls  = s.total_pnl >= 0 ? 'bp-pos' : 'bp-neg';
        const wrCls   = s.win_rate  >= 50 ? 'bp-pos' : 'bp-neg';
  
        const cards = `<div class="bp-session-summary" style="margin-bottom:16px">
          ${sumCard('Сделок',      s.total,                    '')}
          ${sumCard('Win%',        s.win_rate+'%',             wrCls)}
          ${sumCard('P&L',         fmtPnl(s.total_pnl),        pnlCls)}
          ${sumCard('Avg Win',     '+$'+Math.abs(s.avg_win||0).toFixed(0), 'bp-pos')}
          ${sumCard('Avg Loss',    '-$'+Math.abs(s.avg_loss||0).toFixed(0),'bp-neg')}
          ${sumCard('P.Factor',    s.profit_factor||'—',       (s.profit_factor||0)>=1?'bp-pos':'bp-neg')}
          ${sumCard('Max DD',      s.max_drawdown+'%',         'bp-neg')}
          ${sumCard('EV/сделку',  '$'+s.ev_per_trade,         s.ev_per_trade>=0?'bp-pos':'bp-neg')}
        </div>`;
  
        const hourRows = Object.entries(s.by_hour||{}).sort((a,b)=>+a[0]-+b[0]).map(([h,hd])=>
          `<tr>
            <td class="bp-td">${h}:00</td>
            <td class="bp-td bp-num">${hd.trades}</td>
            <td class="bp-td bp-num ${hd.trades>0&&hd.wins/hd.trades>=0.5?'bp-pos':'bp-neg'}">${hd.trades>0?(hd.wins/hd.trades*100).toFixed(0):0}%</td>
            <td class="bp-td bp-num ${hd.pnl>=0?'bp-pos':'bp-neg'}">${hd.pnl>=0?'+$':'-$'}${Math.abs(hd.pnl).toFixed(0)}</td>
          </tr>`
        ).join('');
  
        const dayRows = Object.entries(s.by_day||{}).map(([d,dd])=>
          `<tr>
            <td class="bp-td">${d}</td>
            <td class="bp-td bp-num">${dd.trades}</td>
            <td class="bp-td bp-num ${dd.trades>0&&dd.wins/dd.trades>=0.5?'bp-pos':'bp-neg'}">${dd.trades>0?(dd.wins/dd.trades*100).toFixed(0):0}%</td>
            <td class="bp-td bp-num ${dd.pnl>=0?'bp-pos':'bp-neg'}">${dd.pnl>=0?'+$':'-$'}${Math.abs(dd.pnl).toFixed(0)}</td>
          </tr>`
        ).join('');
  
        const exitRows = Object.entries(s.by_exit||{}).map(([r,cnt])=>
          `<tr>
            <td class="bp-td"><span class="bp-exit-${r}">${r}</span></td>
            <td class="bp-td bp-num">${cnt}</td>
            <td class="bp-td bp-num">${(cnt/(s.total||1)*100).toFixed(1)}%</td>
          </tr>`
        ).join('');
  
        const lastTrades = trades.slice(-20).reverse().map((t,i)=>{
          const win = t.pnl_usd >= 0;
          return `<tr class="${win?'bp-trade-win':'bp-trade-loss'}">
            <td class="bp-td" style="color:#9aa0b2;font-size:10px">${t.fill_ts?.slice(0,16).replace('T',' ')||'—'}</td>
            <td class="bp-td bp-num">${t.entry_price}</td>
            <td class="bp-td bp-num">${t.exit_price}</td>
            <td class="bp-td"><span class="bp-exit-${t.exit_reason}">${t.exit_reason}</span></td>
            <td class="bp-td bp-num ${win?'bp-pos':'bp-neg'}">${win?'+$':'-$'}${Math.abs(t.pnl_usd).toFixed(2)}</td>
            <td class="bp-td bp-num">${t.pnl_ticks>0?'+':''}${t.pnl_ticks}</td>
            <td class="bp-td bp-num" style="font-size:10px">${t.bar_delta}</td>
            <td class="bp-td bp-num" style="font-size:10px">${(t.gex_zero_gamma||0).toFixed(0)}</td>
            <td class="bp-td bp-num" style="font-size:10px">${(t.gex_sum_vol||0).toFixed(0)}</td>
          </tr>`;
        }).join('');
  
        return `
          <div class="bp-rb-branch">
            <div class="bp-rb-branch-title">
              ${esc(b.label)}
              <span class="bp-rb-branch-sub">${esc(b.sub)}</span>
              <button class="bp-btn bp-btn-ghost bp-btn-sm"
                style="margin-left:auto"
                onclick="window._bpRBDownloadCSV('${b.key}')">⬇ CSV (${trades.length})</button>
            </div>
            ${cards}
            <div class="bp-rb-tables">
              <div class="bp-rb-sub-tbl">
                <div class="bp-rb-sub-title">По часам UTC</div>
                <table class="bp-session-tbl">
                  <thead><tr><th class="bp-th">Час</th><th class="bp-th">Сделок</th><th class="bp-th">Win%</th><th class="bp-th">P&L</th></tr></thead>
                  <tbody>${hourRows}</tbody>
                </table>
              </div>
              <div class="bp-rb-sub-tbl">
                <div class="bp-rb-sub-title">По дням недели</div>
                <table class="bp-session-tbl">
                  <thead><tr><th class="bp-th">День</th><th class="bp-th">Сделок</th><th class="bp-th">Win%</th><th class="bp-th">P&L</th></tr></thead>
                  <tbody>${dayRows}</tbody>
                </table>
              </div>
              <div class="bp-rb-sub-tbl">
                <div class="bp-rb-sub-title">Причины выхода</div>
                <table class="bp-session-tbl">
                  <thead><tr><th class="bp-th">Причина</th><th class="bp-th">Кол-во</th><th class="bp-th">%</th></tr></thead>
                  <tbody>${exitRows}</tbody>
                </table>
              </div>
            </div>
            <div class="bp-rb-sub-title" style="margin-top:14px">Последние 20 сделок</div>
            <div class="bp-session-table-wrap">
              <table class="bp-session-tbl">
                <thead><tr>
                  <th class="bp-th">Вход</th><th class="bp-th">Entry</th><th class="bp-th">Exit</th>
                  <th class="bp-th">Причина</th><th class="bp-th">P&L $</th><th class="bp-th">Тиков</th>
                  <th class="bp-th">Delta</th><th class="bp-th">0-γ</th><th class="bp-th">GEX vol</th>
                </tr></thead>
                <tbody>${lastTrades}</tbody>
              </table>
            </div>
          </div>`;
      }).join('');
  
      // Register CSV download
      window._bpRBDownloadCSV = function(branchKey) {
        const trades = res[branchKey]?.trades;
        if (!trades?.length) return;
        const headers = Object.keys(trades[0]);
        const csv = [headers.join(','),
          ...trades.map(t => headers.map(h => {
            const v = t[h]; return typeof v==='string'&&v.includes(',')?`"${v}"`:v??'';
          }).join(','))
        ].join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = `rb_${branchKey}_${res.from_date}_${res.to_date}.csv`;
        a.click(); URL.revokeObjectURL(url);
      };
  
      return `<div class="bp-page">${header}${meta}${branchHTML}</div>`;
    }
  
    // ─────────────────────────────────────────────
    // HISTORY HTML
    // ─────────────────────────────────────────────
  
    function buildHistoryHTML() {
      return `
      <div class="bp-page">
        <div class="bp-page-header">
          <button class="bp-back-btn" id="bp-back-to-config">← Назад</button>
          <h1 class="bp-title">Все бэктесты</h1>
        </div>
        <div class="bp-history-list">
          ${!BP.strategies.length ? '<div class="bp-hint-empty">Нет сохранённых бэктестов</div>' : ''}
          ${BP.strategies.map(s => {
            const sm = s._meta?.session_summary || {}, runs = s._meta?.runs || [];
            const isRB = sm.type === 'rangebar';
            const done = runs.filter(r => r.status==='done').length;
            const totalPnl = isRB
              ? (parseFloat(runs[0]?.stats_a?.total_pnl||0) + parseFloat(runs[0]?.stats_b?.total_pnl||0))
              : runs.reduce((acc, r) => acc + parseFloat(r.stats?.totalPnl||0), 0);
            return `<div class="bp-hist-card">
              <div class="bp-hist-left">
                <div class="bp-hist-name">${esc(sm.name||s.display_name)} ${isRB?'<span style="font-size:10px;background:#4f6df520;color:#4f6df5;padding:2px 6px;border-radius:4px;margin-left:6px">Range-Bar</span>':''}</div>
                <div class="bp-hist-meta">
                  <span>${esc(sm.setupName||'—')}</span>
                  <span>${esc(sm.startedAt?new Date(sm.startedAt).toLocaleString('ru'):'')}</span>
                </div>
              </div>
              <div class="bp-hist-stats">
                ${sumCard('Запусков', sm.totalRuns||runs.length, '')}
                ${isRB
                  ? sumCard('Сделок', (runs[0]?.trades_a||0)+(runs[0]?.trades_b||0), '')
                  : sumCard('Успешно', done, 'bp-pos')}
                ${sumCard('P&L', fmtPnl(totalPnl), totalPnl>=0?'bp-pos':'bp-neg')}
              </div>
              <div class="bp-hist-actions">
                <button class="bp-btn bp-btn-ghost bp-btn-sm bp-hist-open" data-sid="${s.id}">Открыть</button>
                <button class="bp-btn bp-btn-ghost bp-btn-sm bp-hist-del" data-sid="${s.id}">Удалить</button>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>`;
    }
  
    // ════════════════════════════════════════════════════════════
    // EVENTS
    // ════════════════════════════════════════════════════════════
  
    function bindEvents() {
      const root = getRoot(); if (!root) return;
      const cfg  = BP.cfg;
      // Кнопка 📈 — отправить run на график
      root.querySelectorAll('.bp-chart-indicator-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const runIdx = +btn.dataset.run;
          const sid    = btn.dataset.sid;
          const run    = BP.session?.runs?.[runIdx];
          if (run) await sendBacktestToChart(run, sid);
        });
      });
  
      root.querySelector('#bp-open-history')?.addEventListener('click', () => {
        loadAll().then(() => { BP.view = 'history'; renderPage(); });
      });
      root.querySelector('#bp-back-to-config')?.addEventListener('click', () => { BP.view = 'configure'; renderPage(); });
      root.querySelector('#bp-cancel-run')?.addEventListener('click', () => { BP._cancelRequested = true; BP.view = 'configure'; renderPage(); });
  
      if (BP.view === 'configure') bindConfigureEvents(root, cfg);
      if (BP.view === 'session' && BP.session?.type !== 'rangebar') bindSessionEvents(root);
      if (BP.view === 'session' && BP.session?.type === 'rangebar') bindRangeBarSessionEvents(root);
      if (BP.view === 'history')  bindHistoryEvents(root);
    }
  
    function bindConfigureEvents(root, cfg) {
      // Type toggle
      root.querySelector('#bp-bt-standard')?.addEventListener('click', () => { cfg.backtestType = 'standard'; renderPage(); });
      root.querySelector('#bp-bt-rangebar')?.addEventListener('click', () => { cfg.backtestType = 'rangebar'; renderPage(); });
  
      // Standard
      root.querySelector('#bp-setup-sel')?.addEventListener('change', e => {
        const id = +e.target.value||null;
        cfg.setupId = id;
        cfg.setupName = BP.setups.find(s=>s.id===id)?.display_name||'';
        cfg.setupMeta = BP.setups.find(s=>s.id===id)?._meta||null;
        cfg.paramMatrix = {};
        renderPage();
      });
  
      root.querySelector('#bp-inst-all')?.addEventListener('click', () => {
        cfg.selectedInstruments = BP.instruments.map(i=>({id:i.id,symbol:i.symbol,clickhouse_ticker:i.clickhouse_ticker}));
        root.querySelectorAll('.bp-inst-cb').forEach(cb=>cb.checked=true);
        updateRunSummary(root,cfg);
      });
      root.querySelector('#bp-inst-none')?.addEventListener('click', () => {
        cfg.selectedInstruments=[];
        root.querySelectorAll('.bp-inst-cb').forEach(cb=>cb.checked=false);
        updateRunSummary(root,cfg);
      });
      root.querySelectorAll('.bp-inst-cb').forEach(cb => {
        cb.addEventListener('change', () => {
          const id=+cb.dataset.id, sym=cb.dataset.symbol, tk=cb.dataset.ticker;
          if (cb.checked) { if (!cfg.selectedInstruments.some(s=>s.id===id)) cfg.selectedInstruments.push({id,symbol:sym,clickhouse_ticker:tk}); }
          else cfg.selectedInstruments=cfg.selectedInstruments.filter(s=>s.id!==id);
          cb.closest('.bp-multi-item')?.classList.toggle('bp-multi-item-on',cb.checked);
          updateRunSummary(root,cfg);
        });
      });
      root.querySelector('#bp-ival-all')?.addEventListener('click', () => {
        cfg.selectedIntervals=BP.intervals.map(i=>({id:i.id,code:i.code,name:i.name,clickhouse_table:i.clickhouse_table}));
        root.querySelectorAll('.bp-ival-cb').forEach(cb=>cb.checked=true);
        updateRunSummary(root,cfg);
      });
      root.querySelector('#bp-ival-none')?.addEventListener('click', () => {
        cfg.selectedIntervals=[];
        root.querySelectorAll('.bp-ival-cb').forEach(cb=>cb.checked=false);
        updateRunSummary(root,cfg);
      });
      root.querySelectorAll('.bp-ival-cb').forEach(cb => {
        cb.addEventListener('change', () => {
          const id=+cb.dataset.id, code=cb.dataset.code, name=cb.dataset.name, table=cb.dataset.table;
          if (cb.checked) { if (!cfg.selectedIntervals.some(s=>s.id===id)) cfg.selectedIntervals.push({id,code,name,clickhouse_table:table}); }
          else cfg.selectedIntervals=cfg.selectedIntervals.filter(s=>s.id!==id);
          cb.closest('.bp-multi-item')?.classList.toggle('bp-multi-item-on',cb.checked);
          updateRunSummary(root,cfg);
        });
      });
  
      // Поиск по инструментам / таймфреймам (чистый JS-фильтр без перерисовки)
      function filterMultiList(listId, emptyId, query) {
        const list  = root.querySelector('#'+listId);
        const empty = root.querySelector('#'+emptyId);
        if (!list) return;
        const q = query.trim().toLowerCase();
        let visibleCount = 0;
        list.querySelectorAll('.bp-multi-item').forEach(item => {
          const match = !q || (item.dataset.search || '').includes(q);
          item.style.display = match ? '' : 'none';
          if (match) visibleCount++;
        });
        if (empty) empty.style.display = visibleCount === 0 ? '' : 'none';
      }
      root.querySelector('#bp-inst-search')?.addEventListener('input', e => {
        filterMultiList('bp-inst-list', 'bp-inst-empty', e.target.value);
      });
      root.querySelector('#bp-ival-search')?.addEventListener('input', e => {
        filterMultiList('bp-ival-list', 'bp-ival-empty', e.target.value);
      });
  
      root.querySelector('#bp-period-sel')?.addEventListener('change', e => { cfg.periodMode=e.target.value; renderPage(); });
      root.querySelector('#bp-insample-pct')?.addEventListener('input', e => { cfg.inSamplePct=+e.target.value; });
      root.querySelector('#bp-from-date')?.addEventListener('change', e => { cfg.fromDate=e.target.value; });
      root.querySelector('#bp-to-date')?.addEventListener('change', e => { cfg.toDate=e.target.value; });
      root.querySelector('#bp-commission')?.addEventListener('input', e => { cfg.commission=parseFloat(e.target.value)||0; });
      root.querySelectorAll('.bp-matrix-inp').forEach(inp => {
        inp.addEventListener('input', () => {
          const vals=inp.value.split(',').map(v=>v.trim()).filter(Boolean);
          cfg.paramMatrix[inp.dataset.matrixKey]=vals.length?vals:[];
          updateRunSummary(root,cfg);
        });
      });
      root.querySelector('#bp-entry-filter')?.addEventListener('input', e => { cfg.entryFilter=e.target.value; });
      root.querySelector('#bp-exit-filter')?.addEventListener('input', e => { cfg.exitFilter=e.target.value; });
  
      // Range-bar fields
      const rb = (id, prop, parse) => root.querySelector(id)?.addEventListener(
        id.endsWith('date')?'change':'input', e => { cfg[prop]=parse?parse(e.target.value):e.target.value; }
      );
      rb('#rb-ticker',       'rb_ticker');
      rb('#rb-gex-ticker',   'rb_gex_ticker');
      rb('#rb-range-pts',    'rb_range_pts',    Number);
      rb('#rb-delta',        'rb_delta',        Number);
      rb('#rb-gex-vol',      'rb_gex_vol',      Number);
      rb('#rb-zgamma',       'rb_zgamma_offset',Number);
      rb('#rb-sl-ticks',     'rb_sl_ticks',     Number);
      rb('#rb-tp-ticks',     'rb_tp_ticks',     Number);
      rb('#rb-cancel-ticks', 'rb_cancel_ticks', Number);
      root.querySelector('#rb-from-date')?.addEventListener('change', e => {
        cfg.fromDate = e.target.value;
        updateRBRunButton(root, cfg);
      });
      root.querySelector('#rb-to-date')?.addEventListener('change', e => {
        cfg.toDate = e.target.value;
        updateRBRunButton(root, cfg);
      });
      root.querySelector('#rb-branch-a')?.addEventListener('change', e => { cfg.rb_branch_a=e.target.checked; updateRBRunButton(root,cfg); });
      root.querySelector('#rb-branch-b')?.addEventListener('change', e => { cfg.rb_branch_b=e.target.checked; updateRBRunButton(root,cfg); });
  
      // Run button
      root.querySelector('#bp-run-btn')?.addEventListener('click', () => {
        if (cfg.backtestType==='rangebar') runRangeBarSession();
        else runSession();
      });
    }
  
    function updateRunSummary(root, cfg) {
      const runs=buildRuns(cfg), btn=root.querySelector('#bp-run-btn'), sumEl=root.querySelector('.bp-run-summary');
      const setup=BP.setups.find(s=>s.id===cfg.setupId);
      if (btn) btn.disabled=!setup||!runs.length;
      if (sumEl) sumEl.innerHTML=runs.length
        ?`<span class="bp-run-count">${runs.length}</span> запусков · ${cfg.selectedInstruments.length} инстр. × ${cfg.selectedIntervals.length} ТФ${Object.keys(cfg.paramMatrix).filter(k=>cfg.paramMatrix[k]?.length).length?' × параметры':''}`
        :'<span class="bp-run-count-zero">0</span> — выберите инструменты и ТФ';
    }
  
    function updateRBRunButton(root, cfg) {
      const btn   = root.querySelector('#bp-run-btn');
      const sumEl = root.querySelector('.bp-run-summary');
      if (!btn || !sumEl) return;
      const hasDate  = !!(cfg.fromDate && cfg.toDate);
      const hasBranch = cfg.rb_branch_a || cfg.rb_branch_b;
      btn.disabled = !hasDate || !hasBranch;
      const branches = (cfg.rb_branch_a ? 1 : 0) + (cfg.rb_branch_b ? 1 : 0);
      sumEl.innerHTML = hasDate
        ? `<span class="bp-run-count">${branches}</span> ветки · ${esc(cfg.rb_ticker)} · ${esc(cfg.fromDate)} → ${esc(cfg.toDate)}`
        : '<span class="bp-run-count-zero">0</span> — укажите даты';
    }
  
    function bindSessionEvents(root) {
      const f = BP.sessionFilter, apply = () => { BP.sessionPage=0; renderPage(); };
      root.querySelector('#bp-sf-search')?.addEventListener('input',  e => { f.search=e.target.value;     apply(); });
      root.querySelector('#bp-sf-inst')?.addEventListener('change',   e => { f.instrument=e.target.value; apply(); });
      root.querySelector('#bp-sf-ival')?.addEventListener('change',   e => { f.interval=e.target.value;   apply(); });
      root.querySelector('#bp-sf-min-trades')?.addEventListener('input', e => { f.minTrades=e.target.value;  apply(); });
      root.querySelector('#bp-sf-max-trades')?.addEventListener('input', e => { f.maxTrades=e.target.value;  apply(); });
      root.querySelector('#bp-sf-min-wr')?.addEventListener('input',     e => { f.minWinRate=e.target.value; apply(); });
      root.querySelector('#bp-sf-max-wr')?.addEventListener('input',     e => { f.maxWinRate=e.target.value; apply(); });
      root.querySelector('#bp-sf-min-pnl')?.addEventListener('input',    e => { f.minPnl=e.target.value;     apply(); });
      root.querySelector('#bp-sf-max-pnl')?.addEventListener('input',    e => { f.maxPnl=e.target.value;     apply(); });
      root.querySelector('#bp-sf-reset')?.addEventListener('click', () => { BP.sessionFilter=defaultSessionFilter(); renderPage(); });
      root.querySelectorAll('.bp-th[data-sort]').forEach(th => {
        th.addEventListener('click', () => {
          const field=th.dataset.sort;
          if (f.sortField===field) f.sortDir=f.sortDir==='desc'?'asc':'desc'; else { f.sortField=field; f.sortDir='desc'; }
          BP.sessionPage=0; renderPage();
        });
      });
      root.querySelector('#bp-page-prev')?.addEventListener('click', () => { BP.sessionPage=Math.max(0,BP.sessionPage-1); renderPage(); });
      root.querySelector('#bp-page-next')?.addEventListener('click', () => { BP.sessionPage++; renderPage(); });
      root.querySelectorAll('.bp-session-row').forEach(tr => {
        tr.addEventListener('click', () => {
          const idx=parseInt(tr.dataset.runIdx), run=BP.session?.runs?.[idx];
          if (run?.status==='done'&&run.result?.trades?.length) showTradesModal(run);
        });
      });
    }
  
    function bindRangeBarSessionEvents(root) {
      // back/history handled in bindEvents
    }
  
    // ── BT: боковая панель сделок + попап деталей + подписи дельты ────────────
  
  function btRemoveUI() {
    document.getElementById('bt-trades-panel')?.remove();
    document.getElementById('bt-trade-popup')?.remove();
  }
  
  function btRenderTradesSidePanel(trades) {
    document.getElementById('bt-trades-panel')?.remove();
  
    const panel = document.createElement('div');
    panel.id = 'bt-trades-panel';
    panel.style.cssText = `
      position: fixed; top: 60px; right: 0; width: 300px;
      max-height: calc(100vh - 80px); overflow-y: auto;
      background: #131722; border-left: 1px solid #2a2e39; z-index: 9999;
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, sans-serif;
      color: #d1d4dc; box-shadow: -2px 0 12px rgba(0,0,0,.35);
    `;
  
    const header = document.createElement('div');
    header.style.cssText = `
      padding: 10px 12px; border-bottom: 1px solid #2a2e39; font-weight: 600;
      display: flex; justify-content: space-between; align-items: center;
      position: sticky; top: 0; background: #131722;
    `;
    header.innerHTML = `<span>Сделки (${trades.filter(t=>t.entryTs).length})</span>`;
    const closeBtn = document.createElement('span');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'cursor:pointer; opacity:.6; padding:2px 6px;';
    closeBtn.onmouseenter = () => closeBtn.style.opacity = '1';
    closeBtn.onmouseleave = () => closeBtn.style.opacity = '.6';
    closeBtn.onclick = () => panel.remove();
    header.appendChild(closeBtn);
    panel.appendChild(header);
  
    const list = document.createElement('div');
    trades.forEach((t, idx) => {
      if (!t.entryTs) return;
      const isShort = t.dir === 'short';
      const pnl = t.pnl || 0;
      const row = document.createElement('div');
      row.style.cssText = `
        padding: 8px 12px; border-bottom: 1px solid #1e222d; cursor: pointer;
        display: flex; justify-content: space-between; gap: 6px; align-items: center;
      `;
      row.innerHTML = `
        <span style="color:${isShort ? '#ef5350' : '#26a69a'}; font-weight:600; width:46px;">${isShort ? 'SHORT' : 'LONG'}</span>
        <span style="flex:1; opacity:.85;">${new Date(t.entryTs).toISOString().slice(0,16).replace('T',' ')}</span>
        <span style="color:${pnl >= 0 ? '#26a69a' : '#ef5350'}; font-weight:600;">${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}</span>
      `;
      row.onmouseenter = () => row.style.background = '#1e222d';
      row.onmouseleave = () => row.style.background = '';
      row.onclick = () => btOnTradeClick(t, idx);
      list.appendChild(row);
    });
    panel.appendChild(list);
    document.body.appendChild(panel);
  }
  
  async function btOnTradeClick(t, idx) {
    try {
      const widget = window.app?.widget;
      const c = widget?.activeChart?.();
      if (!c) return;
      const tEntrySec = Math.floor(t.entryTs / 1000);
      await c.setVisibleRange({ from: tEntrySec - 900, to: tEntrySec + 1800 });
  
      // Убираем предыдущий маркер входа (если был)
      if (window._btHighlightMarkerId != null) {
        try { c.removeEntity(window._btHighlightMarkerId); } catch(_) {}
        window._btHighlightMarkerId = null;
      }
  
      // Возвращаем предыдущую подсвеченную сделку в обычный вид (перерисовкой)
      if (window._btHighlightedIdx != null && window._btHighlightedIdx !== idx) {
        const prevIdx = window._btHighlightedIdx;
        const prevTrade = window._btLastTrades?.[prevIdx];
        const prevShapeId = window._btTradeShapeIds?.[prevIdx];
        if (prevTrade && prevShapeId != null) {
          try { c.removeEntity(prevShapeId); } catch(_) {}
          try {
            const pEntrySec = Math.floor(prevTrade.entryTs / 1000);
            const pExitSec  = prevTrade.exitTs ? Math.floor(prevTrade.exitTs / 1000) : pEntrySec + 600;
            const pIsShort  = prevTrade.dir === 'short';
            const newId = await c.createMultipointShape(
              [
                { time: pEntrySec, price: prevTrade.entry },
                { time: pExitSec,  price: prevTrade.sl    },
              ],
              {
                shape: pIsShort ? 'short_position' : 'long_position',
                lock: false, disableSelection: false, zOrder: 'top',
                overrides: { stopLevel: prevTrade.sl, profitLevel: prevTrade.tp, linewidth: 1 },
              }
            );
            window._btTradeShapeIds[prevIdx] = newId;
          } catch(e) { console.warn('[BT] unhighlight redraw error:', e.message); }
        }
      }
  
      // Перерисовываем ТЕКУЩУЮ сделку с жирной обводкой
      const curShapeId = window._btTradeShapeIds?.[idx];
      if (curShapeId != null) {
        try { c.removeEntity(curShapeId); } catch(_) {}
        try {
          const tExitSec = t.exitTs ? Math.floor(t.exitTs / 1000) : tEntrySec + 600;
          const isShort  = t.dir === 'short';
          const boldId = await c.createMultipointShape(
            [
              { time: tEntrySec, price: t.entry },
              { time: tExitSec,  price: t.sl    },
            ],
            {
              shape: isShort ? 'short_position' : 'long_position',
              lock: false, disableSelection: false, zOrder: 'top',
              overrides: { stopLevel: t.sl, profitLevel: t.tp, linewidth: 4 },
            }
          );
          window._btTradeShapeIds[idx] = boldId;
          window._btHighlightedIdx = idx;
        } catch(e) { console.warn('[BT] highlight redraw error:', e.message); }
      }
  
      // Яркая вертикальная линия точно на входе
      try {
        const markerId = await c.createShape(
          { time: tEntrySec, price: t.entry },
          {
            shape: 'vertical_line',
            lock: true, disableSelection: true, disableSave: true,
            overrides: { linecolor: '#ffeb3b', linewidth: 2, linestyle: 2 },
          }
        );
        window._btHighlightMarkerId = markerId;
      } catch(e) { console.warn('[BT] highlight marker error:', e.message); }
  
    } catch(e) {
      console.warn('[BT] trade nav error:', e.message);
    }
    btShowTradePopup(t);
  }
  
  function btShowTradePopup(t) {
    document.getElementById('bt-trade-popup')?.remove();
    const isShort = t.dir === 'short';
    const pnl = t.pnl || 0;
    const fmt = (v, d=1) => (typeof v === 'number' ? v.toFixed(d) : '—');
  
    const box = document.createElement('div');
    box.id = 'bt-trade-popup';
    box.style.cssText = `
      position: fixed; top: 70px; right: 312px; width: 260px;
      background: #1e222d; border: 1px solid #2a2e39; border-radius: 6px;
      padding: 12px; z-index: 10000;
      font: 12px/1.6 -apple-system, BlinkMacSystemFont, sans-serif;
      color: #d1d4dc; box-shadow: 0 4px 16px rgba(0,0,0,.45);
    `;
    box.innerHTML = `
      <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
        <b style="color:${isShort ? '#ef5350' : '#26a69a'}">${isShort ? 'SHORT' : 'LONG'} · ${t.exitReason || '—'}</b>
        <span style="cursor:pointer; opacity:.6;" id="bt-popup-close">✕</span>
      </div>
      <div>Вход: <b>${fmt(t.entry, 2)}</b> → Выход: <b>${fmt(t.exitPrice, 2)}</b></div>
      <div>SL: ${fmt(t.sl, 2)} · TP: ${fmt(t.tp, 2)}</div>
      <div>P&amp;L: <b style="color:${pnl >= 0 ? '#26a69a' : '#ef5350'}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}</b></div>
      <hr style="border-color:#2a2e39; margin:6px 0;">
      <div>Delta бара: ${t.rb_delta ?? '—'} · <b>Prev Δ: ${t.rb_prev_delta ?? '—'}</b> · тиков: ${t.rb_ticks ?? '—'}</div>
      <div>GEX spot: ${fmt(t.gex_spot)}</div>
      <div>GEX zero_gamma: ${fmt(t.gex_zero_gamma)}</div>
      <div>GEX sum_vol: ${fmt(t.gex_sum_vol, 0)} · GEX sum_oi: ${fmt(t.gex_sum_oi, 0)}</div>
      <div>GEX major_neg: ${fmt(t.gex_major_neg)} · GEX major_pos: ${fmt(t.gex_major_pos)}</div>
    `;
    document.body.appendChild(box);
    document.getElementById('bt-popup-close').onclick = () => box.remove();
  }
  
  // Подписи дельты рисуются через createShape (тот же API что и сделки), но
  // ТОЛЬКО для видимой области графика (+15% запас по краям) — иначе на
  // 10-15 тыс. range-баров вкладка подвиснет на десятки секунд. Перерисовываются
  // автоматически при скролле/зуме графика.
  
  window._btDeltaShapeIds = window._btDeltaShapeIds || [];
  window._btDeltaSubscribed = window._btDeltaSubscribed || false;
  window._btDeltaRedrawTimer = null;
  
  async function btRedrawDeltaLabelsInViewport() {
    const widget = window.app?.widget;
    const c = widget?.activeChart?.();
    const all = window._btRangeBars || [];
    if (!c || !all.length) return;
  
    for (const id of window._btDeltaShapeIds) {
      try { c.removeEntity(id); } catch(_) {}
    }
    window._btDeltaShapeIds = [];
  
    let range;
    try { range = c.getVisibleRange(); } catch(e) { return; }
    if (!range || !range.from || !range.to) return;
  
    const buf = (range.to - range.from) * 0.15;
    const from = range.from - buf, to = range.to + buf;
    const visible = all.filter(b => b.t >= from && b.t <= to && b.delta != null);
  
    const BATCH = 150;
    for (let i = 0; i < visible.length; i += BATCH) {
      const chunk = visible.slice(i, i + BATCH);
      await Promise.all(chunk.map(async (b) => {
        const isBear = b.dir === 1;
        const span = (b.high - b.low) || (b.high * 0.001);
        const y = isBear ? b.high + span * 0.4 : b.low - span * 0.4;
        try {
          const id = await c.createShape(
            { time: b.t, price: y },
            {
              shape: 'text',
              text: (b.delta > 0 ? '+' : '') + b.delta,
              lock: true,
              disableSelection: true,
              disableSave: true,
              overrides: { color: isBear ? '#ef5350' : '#26a69a', fontsize: 10 },
            }
          );
          window._btDeltaShapeIds.push(id);
        } catch(e) { /* пропускаем единичные сбои */ }
      }));
    }
    console.log(`[BT] delta labels (viewport): ${visible.length} of ${all.length} total bars`);
  }
  
  function btScheduleDeltaRedraw() {
    clearTimeout(window._btDeltaRedrawTimer);
    window._btDeltaRedrawTimer = setTimeout(btRedrawDeltaLabelsInViewport, 300);
  }
  
  window.btDrawDeltaLabels = async function() {
    const widget = window.app?.widget;
    const c = widget?.activeChart?.();
    if (!c) { console.warn('[BT] Нет графика'); return; }
    await btRedrawDeltaLabelsInViewport();
    if (!window._btDeltaSubscribed) {
      try {
        c.onVisibleRangeChanged().subscribe(null, btScheduleDeltaRedraw);
        window._btDeltaSubscribed = true;
        console.log('[BT] delta labels: подписка на скролл/зум включена');
      } catch(e) {
        console.warn('[BT] onVisibleRangeChanged subscribe failed:', e.message);
      }
    }
  };
  
  
    // ── Отправить бэктест на график как TVEngine индикатор ──────
    async function sendBacktestToChart(run, sessionId) {
      const trades = run.result?.trades || run.trades_data || [];
      if (!trades.length) { alert('Нет сделок для отображения'); return; }
  
      const name = `BT: ${run.inst?.symbol||run.instrument||'?'} ${run.ival?.name||run.interval||''} (${trades.length} сд.)`;
  
      // Генерируем TVEngine скрипт
      const tradesJson = JSON.stringify(trades.map(t => ({
        dir: t.dir, entry: t.entry, exit: t.exitPrice, sl: t.sl, tp: t.tp,
        reason: t.exitReason, pnl: t.pnl, entryTs: t.entryTs, exitTs: t.exitTs,
        delta: t.rb_delta, pdelta: t.rb_prev_delta, rb_close: t.rb_close,
        zgamma: t.gex_zero_gamma, gvol: t.gex_sum_vol, mneg: t.gex_major_neg,
        mpos: t.gex_major_pos, goi: t.gex_sum_oi, spot: t.gex_spot,
      })));
  
      const totalPnl = trades.reduce((s,t)=>s+(t.pnl||0),0).toFixed(0);
      const wr = Math.round(trades.filter(t=>(t.pnl||0)>0).length/trades.length*100);
  
      // Рисуем shapes напрямую через TV Chart API без TVEngine
      const drawTradesOnChart = async () => {
        try {
          const widget = window.app?.widget;
          if (!widget) { alert('График недоступен'); return; }
          const firstTrade = trades.find(t => t.entryTs);
          if (!firstTrade) { alert('Нет сделок для отображения'); return; }
      
          const entrySec = Math.floor(firstTrade.entryTs / 1000);
          const baseSymbol = run.inst?.symbol || run.instrument || 'ESU6';
          const btSymbol = baseSymbol + '__BT';
      
          const c = widget.activeChart();
      
          // Кладём ВСЕ range-бары в память ДО переключения символа.
          // Синтетический символ "<TICKER>__BT" отдаёт их статично, целиком,
          // независимо от resolution — TV не валидирует ФОРМАТ имени символа
          // (в отличие от resolution, где кастомные коды типа 'RB'/'1RB'
          // молча отклоняются), поэтому этот путь надёжен.
          window._btRangeBars = run.result?.barsForChart || [];
          if (!window._btRangeBars.length) {
            console.warn('[BT] barsForChart пуст — проверьте что backtest-engine-server.js/server.js обновлены, либо это старый результат без этого поля');
          }
      
          window.app.activedata = [];
          window.app._activeDataIndex = new Set();
      
          console.log('[BT] switching to synthetic BT symbol:', btSymbol);
          await new Promise(resolve => c.setSymbol(btSymbol, resolve));
          await new Promise(r => setTimeout(r, 200));
      
          // Двойной тоггл резолюции форсирует у TV настоящую перезагрузку серии
          // (даже если символ формально "тот же" при повторном запуске бэктеста)
          await new Promise(resolve => c.setResolution('5', resolve));
          await new Promise(r => setTimeout(r, 200));
          window.app.activedata = [];
          window.app._activeDataIndex = new Set();
          await new Promise(resolve => c.setResolution('1', resolve));
      
          // Ждём фактического появления данных (все бары должны появиться разом)
          for (let i = 0; i < 50; i++) {           // до ~5с
            if ((window.app.activedata?.length || 0) >= window._btRangeBars.length) break;
            await new Promise(r => setTimeout(r, 100));
          }
          console.log('[BT] symbol:', c.symbol(), 'resolution:', c.resolution?.(), 'bars loaded:', window.app.activedata?.length, '(expected', window._btRangeBars.length, ')');
      
          // Скроллим к первой сделке — данные уже все в памяти, одной попытки хватает.
          try {
            await c.setVisibleRange({ from: entrySec - 1800, to: entrySec + 3600 });
            console.log('[BT] scrolled to', new Date(entrySec * 1000).toISOString());
          } catch(e) {
            console.warn('[BT] scroll error:', e.message);
          }
      
          // Удаляем старые shapes
          try { widget.activeChart().removeAllShapes(); } catch(_) {}
      
          // Рисуем ВСЕ сделки (range-бары уже видны как сама серия — символ __BT)
          window._btTradeShapeIds = {};
          window._btHighlightedIdx = null;
          window._btHighlightMarkerId = null;
  
          let drawn = 0;
          for (let i = 0; i < trades.length; i++) {
            const t = trades[i];
            if (!t.entryTs || !t.entry || !t.sl || !t.tp) continue;
            const tEntrySec = Math.floor(t.entryTs / 1000);
            const tExitSec  = t.exitTs ? Math.floor(t.exitTs / 1000) : tEntrySec + 600;
            const isShort   = t.dir === 'short';
            try {
              const shapeId = await widget.activeChart().createMultipointShape(
                [
                  { time: tEntrySec, price: t.entry },
                  { time: tExitSec,  price: t.sl    },
                ],
                {
                  shape: isShort ? 'short_position' : 'long_position',
                  lock: false,
                  disableSelection: false,
                  zOrder: 'top',
                  overrides: {
                    stopLevel:   t.sl,
                    profitLevel: t.tp,
                  },
                }
              );
              window._btTradeShapeIds[i] = shapeId;
              drawn++;
            } catch(e) {
              console.warn('[BT] shape error:', e.message);
            }
          }
      
          window._btLastTrades = trades;
          console.log('[BT] drawn:', drawn, 'of', trades.length);
  
          // Боковая панель сделок (клик → переход + попап с деталями)
          btRenderTradesSidePanel(trades);
  
          // Подписи дельты — теперь только для видимой области (+автообновление
          // при скролле/зуме), поэтому безопасно включать всегда.
          await window.btDrawDeltaLabels();
        } catch(err) {
          alert('Ошибка: ' + err.message);
        }
      };
  
      // Сохраняем скрипт в БД (для истории) и сразу рисуем
      const scriptCode = `// ${name} — сохранено в библиотеке`;
  
      // Сохраняем скрипт в БД как индикатор (type_id=2)
      const systemName = 'bt_indicator_' + Date.now();
      try {
        const resp = await apiFetch('/api/javascript-scripts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            display_name: name,
            system_name: systemName,
            type_id: 2,
            code: scriptCode,
            description: `Бэктест ${run.inst?.symbol||''} ${run.ival?.name||''}: ${trades.length} сделок, WR ${wr}%, P&L $${totalPnl}`,
            is_public: false,
            is_overlay: true,
            inputs_schema: [],
            meta: { backtest_session_id: sessionId, run_instrument: run.inst?.symbol||run.instrument },
          }),
        });
        // Запускаем индикатор на чарте через TVEngine
        // Рисуем напрямую через Chart API
        await drawTradesOnChart();
        return;
  
        const scriptId = resp?.id; // unreachable — kept for reference
        if (window.app?.addIndicatorToChart) {
          window.app.addIndicatorToChart(scriptId);
        } else if (window._tve || window.TVEngine) {
          try {
            // Внедряем TVEngine в контекст скрипта
            const tve = window.TVEngine || window._tve;
            // Оборачиваем скрипт чтобы TVEngine был доступен
            const wrappedCode = `(function(TVEngine){ ${scriptCode} })(arguments[0])`;
            const fn = new Function(wrappedCode);
            fn.call(window, tve);
            alert('Индикатор добавлен на график! Также сохранён в библиотеке как «' + name + '»');
          } catch(err) {
            console.error('[BT] TVEngine run error:', err);
            alert('Ошибка отрисовки: ' + err.message + '\nСкрипт сохранён в библиотеке как «' + name + '»');
          }
        } else {
          alert('Скрипт сохранён в библиотеке индикаторов как «' + name + '». Добавьте его через кнопку Indicators на графике.');
        }
      } catch(e) {
        alert('Ошибка: ' + e.message);
      }
    }
  
    function bindHistoryEvents(root) {
      root.querySelectorAll('.bp-hist-open').forEach(btn => {
        btn.addEventListener('click', () => {
          const sid=+btn.dataset.sid, s=BP.strategies.find(x=>x.id===sid);
          if (!s) return;
          const meta=s._meta||{}, sm=meta.session_summary||{};
          const isRB = sm.type==='rangebar';
          if (isRB) {
            // Restore range-bar session from stored meta
            BP.session = {
              id: s.id, name: sm.name||s.display_name, type: 'rangebar',
              setupName: sm.setupName||'Range-Bar',
              startedAt: sm.startedAt||s.created_at,
              totalRuns: 1, doneRuns: sm.doneRuns||1, errorRuns: sm.errorRuns||0,
              runs: [{ status:'done', result: meta.rangebar_result||null,
                       inst:{symbol:(meta.runs?.[0]?.ticker||'ESU6')}, ival:{name:'1RB'}, params:{} }],
            };
          } else {
            const runs=(meta.runs||[]).map(r=>({
              inst:{symbol:r.instrument,clickhouse_ticker:r.ticker},
              ival:{name:r.interval,clickhouse_table:r.table},
              params:r.params||{}, status:r.status||'done', error:r.error||null,
              result:r.stats?{stats:r.stats,trades:r.trades_data||Array(r.trades||0)}:null,
            }));
            BP.session={
              id:s.id, name:sm.name||s.display_name, type:'standard',
              setupId:sm.setupId, setupName:sm.setupName||'—', runs,
              totalRuns:sm.totalRuns||runs.length, doneRuns:sm.doneRuns||runs.filter(r=>r.status==='done').length,
              errorRuns:sm.errorRuns||0, startedAt:sm.startedAt||s.created_at,
            };
          }
          BP.sessionFilter=defaultSessionFilter(); BP.sessionPage=0;
          BP.view='session'; renderPage();
        });
      });
      root.querySelectorAll('.bp-hist-del').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Удалить сессию?')) return;
          try { await apiFetch(`/api/javascript-scripts/${btn.dataset.sid}`,{method:'DELETE'}); await loadAll(); }
          catch(e) { alert('Ошибка: '+e.message); }
        });
      });
    }
  
    // ════════════════════════════════════════════════════════════
    // TRADES MODAL (standard backtest)
    // ════════════════════════════════════════════════════════════
  
    function showTradesModal(run) {
      const trades=run.result?.trades||[], stats=run.result?.stats||{};
      const symbol = run.inst?.symbol || '';
      const title=`${symbol} · ${run.ival?.name} — сделки (${trades.length})`;
      const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      const fmtDate=ts=>{ if(!ts)return'—'; const d=new Date(ts); return d.toISOString().slice(0,10); };
      const fmtTime=ts=>{ if(!ts)return'—'; const d=new Date(ts); return d.toISOString().slice(11,19); };
      const fmtDow =ts=>{ if(!ts)return'—'; return DAYS[new Date(ts).getUTCDay()]; };
      const fp4=v=>v!=null?parseFloat(v).toFixed(4):'—';
      const fp2=v=>v!=null?parseFloat(v).toFixed(2):'—';
      const fp0=v=>v!=null?Math.round(parseFloat(v)):'—';
      const fd=v=>v!=null?Math.abs(parseFloat(v)).toFixed(2):'—';
      const sign=v=>parseFloat(v)>=0?'+':'-';
  
      const statItems=[
        ['Сделок',trades.length,''],['Побед',stats.wins??'—','bp-pos'],['Поражений',stats.losses??'—','bp-neg'],
        ['Win%',fmtN(stats.winRate,1)+'%',parseFloat(stats.winRate||0)>=50?'bp-pos':'bp-neg'],
        ['P&L',fmtPnl(stats.totalPnl),parseFloat(stats.totalPnl||0)>=0?'bp-pos':'bp-neg'],
        ['+Avg Win','+$'+fd(stats.avgWin),'bp-pos'],['-Avg Loss','-$'+fd(stats.avgLoss),'bp-neg'],
        ['P.Factor',fmtN(stats.profitFactor,2),parseFloat(stats.profitFactor||0)>=1?'bp-pos':'bp-neg'],
        ['Max DD',fmtPct(stats.maxDrawdown),'bp-neg'],['RR',fmtN(stats.rr,2),''],['EV','$'+fd(stats.expectancy),''],
      ];
      const statsHTML=statItems.map(([l,v,c])=>
        `<div class="bp-sum-card"><div class="bp-sum-label">${l}</div><div class="bp-sum-value ${c}" style="font-size:14px">${v??'—'}</div></div>`
      ).join('');
      const byExit=stats.byExit||{};
      const exitHTML=Object.entries(byExit).map(([k,v])=>
        `<span class="bp-exit-${k}" style="font-size:12px;margin-right:14px">${k}: <b>${v}</b></span>`
      ).join('');
  
      // Кнопка экспорта CSV
      const exportCSV = () => {
        const COLS = ['#','entry_date','entry_time','day_of_week','exit_time','instrument','direction',
          'entry_price','quantity','exit_reason','exit_price','pnl_usd','price_ticks','ruleset',
          'delta','prev_delta','rb_ticks','rb_open','rb_close','rb_high','rb_low',
          'gex_spot','gex_zero_gamma','gex_sum_vol','gex_sum_oi','gex_major_neg','gex_major_pos','gex_has_data'];
        const rows = trades.map((t,i) => [
          i+1, fmtDate(t.entryTs), fmtTime(t.entryTs), fmtDow(t.entryTs), fmtTime(t.exitTs),
          symbol, t.dir||'—', fp4(t.entry), t.qty?.toFixed(4)||'—',
          t.exitReason||'—', fp4(t.exitPrice), t.pnl?.toFixed(2)||'—',
          t.priceTicks??'—', t.setupName||'—',
          t.rb_delta??'—', t.rb_prev_delta??'—', t.rb_ticks??'—', fp2(t.rb_open), fp2(t.rb_close), fp2(t.rb_high), fp2(t.rb_low),
          fp2(t.gex_spot), fp2(t.gex_zero_gamma), fp0(t.gex_sum_vol), fp0(t.gex_sum_oi), fp0(t.gex_major_neg), fp0(t.gex_major_pos), t.gex_has_data??'—',
        ].map(v => String(v).includes(',') ? '"'+v+'"' : v).join(','));
        const csv = [COLS.join(','), ...rows].join('\n');
        const a = document.createElement('a');
        a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
        a.download = `trades_${symbol}_${fmtDate(trades[0]?.entryTs||Date.now())}.csv`;
        a.click();
      };
  
      const rowsHTML=trades.map((t,i)=>{
        const win=(t.pnl??0)>=0;
        const entryTs = t.entryTs || 0;
        return `<tr class="${win?'bp-trade-win':'bp-trade-loss'}">
          <td style="color:#9aa0b2">${i+1}</td>
          <td>${fmtDate(t.entryTs)}</td>
          <td>${fmtTime(t.entryTs)}</td>
          <td>${fmtDow(t.entryTs)}</td>
          <td>${fmtTime(t.exitTs)}</td>
          <td><b>${esc(symbol)}</b></td>
          <td>${t.dir||'—'}</td>
          <td style="font-family:monospace">${fp4(t.entry)}</td>
          <td>${t.qty?.toFixed(2)||'—'}</td>
          <td><span class="bp-exit-${t.exitReason}">${t.exitReason||'—'}</span></td>
          <td style="font-family:monospace">${fp4(t.exitPrice)}</td>
          <td class="${win?'bp-pos':'bp-neg'}" style="text-align:right">${sign(t.pnl)}$${fd(t.pnl)}</td>
          <td style="text-align:right">${t.priceTicks??'—'}</td>
          <td style="color:#9aa0b2;font-size:11px">${esc(t.setupName||'—')}</td>
          <td style="text-align:right">${t.rb_delta??'—'}</td>
          <td style="text-align:right">${t.rb_ticks??'—'}</td>
          <td style="font-family:monospace">${fp2(t.rb_open)}</td>
          <td style="font-family:monospace">${fp2(t.rb_close)}</td>
          <td style="font-family:monospace">${fp2(t.gex_zero_gamma)}</td>
          <td style="text-align:right">${fp0(t.gex_sum_vol)}</td>
          <td style="text-align:right">${fp0(t.gex_major_neg)}</td>
          <td><button class="bp-chart-btn" data-entry="${entryTs}" data-exit="${t.exitTs||0}" title="Показать на графике">📊</button></td>
        </tr>`;
      }).join('');
  
      document.body.insertAdjacentHTML('beforeend',`
      <div class="bp-modal-overlay" id="bp-trades-modal">
        <div class="bp-modal bp-modal-wide">
          <div class="bp-modal-head">
            <div class="bp-modal-title">${esc(title)}</div>
            <div style="flex:0 0 auto;display:flex;align-items:center;gap:12px">
              ${exitHTML}
              <button class="bp-btn bp-btn-ghost bp-btn-sm" id="bp-export-csv">⬇ CSV</button>
            </div>
            <button class="bp-modal-close" id="bp-modal-close-btn">✕</button>
          </div>
          <div class="bp-modal-stats">${statsHTML}</div>
          <div class="bp-modal-body">
            <table class="bp-trades-tbl">
              <thead><tr>
                <th>#</th><th>Дата</th><th>Время вх.</th><th>День</th><th>Время вых.</th>
                <th>Инстр.</th><th>Напр.</th><th>Вход</th><th>Кол-во</th>
                <th>Причина</th><th>Выход</th><th>P&L $</th><th>Тиков</th><th>Сетап</th>
                <th>Delta</th><th>RB тиков</th><th>RB Open</th><th>RB Close</th>
                <th>Zero Gamma</th><th>GEX Vol</th><th>Neg Vol</th><th></th>
              </tr></thead>
              <tbody>${rowsHTML}</tbody>
            </table>
          </div>
        </div>
      </div>`);
      document.getElementById('bp-export-csv')?.addEventListener('click', exportCSV);
      const overlay=document.getElementById('bp-trades-modal');
      document.getElementById('bp-modal-close-btn').addEventListener('click',()=>overlay.remove());
      overlay.addEventListener('click',e=>{ if(e.target===overlay)overlay.remove(); });
      const esc_=e=>{ if(e.key==='Escape'){overlay.remove();document.removeEventListener('keydown',esc_);} };
      document.addEventListener('keydown',esc_);
  
      // Навигация к сделке на графике TradingView
      overlay.querySelectorAll('.bp-chart-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const entryTs  = +btn.dataset.entry;   // milliseconds
          const exitTs   = +btn.dataset.exit;    // milliseconds
          if (!entryTs) return;
          const entrySec = Math.floor(entryTs / 1000);
  
          // Извлекаем тикер из заголовка модала "ESU6 · 1 tick — сделки (26)"
          const titleEl   = document.querySelector('#bp-trades-modal .bp-modal-title');
          const tickerMatch = (titleEl?.textContent || '').match(/^([A-Z0-9]+)/);
          const targetSymbol = tickerMatch?.[1] || '';
  
          overlay.remove();
          document.removeEventListener('keydown', esc_);
  
          try {
            const widget   = window.app?.widget;
            const datafeed = window.app?.datafeed;
            if (!widget || !datafeed) { console.warn('[BT] widget/datafeed not available'); return; }
  
            const chart         = widget.activeChart();
            const currentSymbol = chart.symbol?.() || '';
            const currentRes    = chart.resolution?.() || '';
  
            const needSymbol = targetSymbol && targetSymbol !== currentSymbol;
            const needRes    = currentRes !== '1T';
  
            // После переключения символа/ТФ — navigateToTime
            const doNavigate = () => {
              setTimeout(() => {
                try {
                  const c = widget.activeChart();
                  // gotoTick устанавливает точку загрузки данных в datafeed
                  datafeed.gotoTick(entrySec);
                  // setVisibleRange заставляет datafeed подгрузить нужный диапазон
                  const from = entrySec - 900;   // -15 минут
                  const to   = entrySec + 900;   // +15 минут
                  c.setVisibleRange({ from, to }).then(() => {
                    console.log('[BT] navigated to', new Date(entrySec * 1000).toISOString());
                  }).catch(e => {
                    console.warn('[BT] setVisibleRange error:', e?.message);
                  });
                } catch(err) {
                  console.warn('[BT] navigate error:', err.message);
                }
              }, 500);
            };
  
            if (needSymbol && needRes) {
              chart.setSymbol(targetSymbol, () => {
                widget.activeChart().setResolution('1T', doNavigate);
              });
            } else if (needSymbol) {
              chart.setSymbol(targetSymbol, doNavigate);
            } else if (needRes) {
              chart.setResolution('1T', doNavigate);
            } else {
              doNavigate();
            }
  
          } catch(err) {
            console.error('[BT] Chart navigation error:', err);
          }
        });
      });
    }
  
    // ════════════════════════════════════════════════════════════
    // CSS
    // ════════════════════════════════════════════════════════════
  
    function injectCSS() {
      if (document.getElementById('bp-styles')) return;
      const s = document.createElement('style'); s.id='bp-styles';
      s.textContent = `
  #backtest-page-root{height:100%;overflow:auto;background:var(--bp-bg,#f8f9fc);font-family:-apple-system,'Segoe UI',sans-serif}
  .bp-page{max-width:1100px;margin:0 auto;padding:32px 24px}
  .bp-page-header{display:flex;align-items:center;gap:16px;margin-bottom:28px}
  .bp-title{font-size:26px;font-weight:700;color:var(--bp-text,#1a1d2e);margin:0;letter-spacing:-.5px;flex:1}
  .bp-header-actions{display:flex;gap:8px}
  .bp-loading-full{display:flex;align-items:center;justify-content:center;height:200px;color:#9aa0b2;font-size:15px}
  .bp-configure{display:flex;flex-direction:column;gap:16px}
  .bp-card{background:var(--bp-card,#fff);border:1.5px solid var(--bp-border,#e2e6f0);border-radius:14px;padding:22px 24px}
  .bp-card-section-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;color:var(--bp-text,#1a1d2e);margin-bottom:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .bp-section-hint{font-size:11px;font-weight:400;text-transform:none;letter-spacing:0;color:#9aa0b2}
  .bp-field{display:flex;flex-direction:column;gap:5px}
  .bp-field-hint{font-size:11px;color:#9aa0b2}
  .bp-label{font-size:12px;font-weight:500;color:#6b7280}
  .bp-input{padding:9px 12px;border:1.5px solid var(--bp-border,#e2e6f0);border-radius:8px;font-size:14px;color:var(--bp-text,#1a1d2e);background:var(--bp-input,#f8f9fc);outline:none;transition:border-color .15s;box-sizing:border-box;width:100%}
  .bp-input:focus{border-color:#4f6df5;background:var(--bp-card,#fff)}
  .bp-input-sm{padding:5px 8px;font-size:12px;width:70px}
  .bp-select{padding:9px 12px;border:1.5px solid var(--bp-border,#e2e6f0);border-radius:8px;font-size:14px;color:var(--bp-text,#1a1d2e);background:var(--bp-card,#fff);cursor:pointer;outline:none;width:100%}
  .bp-select-lg{max-width:400px}
  .bp-params-grid-4{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}
  .bp-btn{padding:8px 18px;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:all .15s}
  .bp-btn-ghost{background:transparent;color:#6b7280;border:1.5px solid var(--bp-border,#e2e6f0)}
  .bp-btn-ghost:hover{background:#f0f4ff;color:#4f6df5;border-color:#4f6df5}
  .bp-btn-ghost:disabled{opacity:.4;cursor:default}
  .bp-btn-sm{padding:5px 12px;font-size:12px}
  .bp-btn-run{padding:12px 36px;background:#1a1d2e;color:#fff;font-size:15px;font-weight:700;border-radius:10px;border:none;cursor:pointer;transition:all .15s}
  .bp-btn-run:hover{background:#2d3250}
  .bp-btn-run:disabled{opacity:.4;cursor:default}
  .bp-back-btn{background:none;border:none;font-size:14px;color:#4f6df5;cursor:pointer;padding:6px 10px;border-radius:7px;font-weight:500;flex-shrink:0}
  .bp-back-btn:hover{background:#f0f4ff}
  .bp-link-btn{background:none;border:none;font-size:11px;color:#4f6df5;cursor:pointer;padding:0;text-decoration:underline}
  .bp-criteria-grid{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:18px}
  .bp-crit-card{background:var(--bp-input,#f8f9fc);border:1.5px solid var(--bp-border,#e2e6f0);border-radius:10px;padding:14px;flex:1;min-width:220px;max-width:340px}
  .bp-crit-card-name{font-size:13px;font-weight:600;color:var(--bp-text,#1a1d2e);margin-bottom:10px}
  .bp-crit-param{margin-bottom:8px}
  .bp-param-row{display:flex;align-items:center;gap:6px;margin-top:4px}
  .bp-param-sep{color:#9aa0b2;font-size:16px}
  .bp-hint-empty{color:#9aa0b2;font-style:italic;font-size:13px;padding:12px 0}
  .bp-expr-block{margin-top:14px}
  .bp-expr-label{font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.3px;margin-bottom:6px;display:flex;align-items:center;gap:8px}
  .bp-expr-ro{background:var(--bp-input,#f8f9fc);border:1px solid var(--bp-border,#e2e6f0);border-radius:8px;padding:8px 12px;font-family:monospace;font-size:12px;color:#9aa0b2;margin:0;white-space:pre-wrap;word-break:break-all}
  .bp-expr-ta{width:100%;padding:8px 10px;border:1.5px solid var(--bp-border,#e2e6f0);border-radius:8px;font-size:12px;font-family:'Consolas',monospace;color:var(--bp-text,#1a1d2e);background:var(--bp-input,#f8f9fc);outline:none;resize:vertical;box-sizing:border-box}
  .bp-expr-ta:focus{border-color:#4f6df5;background:var(--bp-card,#fff)}
  .bp-two-cols{display:grid;grid-template-columns:1fr 1fr;gap:20px}
  .bp-multi-col{display:flex;flex-direction:column;gap:8px}
  .bp-multi-header{display:flex;align-items:center;gap:8px}
  .bp-multi-list{border:1.5px solid var(--bp-border,#e2e6f0);border-radius:10px;overflow-y:auto;max-height:240px;display:flex;flex-direction:column}
  .bp-multi-search{margin-bottom:2px;padding:7px 10px;font-size:12px}
  .bp-multi-empty{padding:16px;text-align:center;color:#9aa0b2;font-size:12px;font-style:italic}
  .bp-multi-item{display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer;border-bottom:1px solid var(--bp-border,#e2e6f0);transition:background .12s;user-select:none}
  .bp-multi-item:last-child{border-bottom:none}
  .bp-multi-item:hover{background:#f0f4ff}
  .bp-multi-item-on{background:color-mix(in srgb,#4f6df5 8%,transparent)}
  .bp-multi-item input{width:15px;height:15px;accent-color:#4f6df5;flex-shrink:0}
  .bp-multi-label{font-size:13px;font-weight:600;color:var(--bp-text,#1a1d2e);flex:1}
  .bp-multi-sub{font-size:11px;color:#9aa0b2}
  .bp-run-footer{display:flex;align-items:center;justify-content:space-between;padding:16px 24px;background:var(--bp-card,#fff);border:1.5px solid var(--bp-border,#e2e6f0);border-radius:14px}
  .bp-run-summary{font-size:14px;color:#6b7280}
  .bp-run-count{font-size:20px;font-weight:700;color:#4f6df5}
  .bp-run-count-zero{font-size:20px;font-weight:700;color:#d1d5db}
  .bp-page-running{display:flex;align-items:center;justify-content:center;min-height:400px}
  .bp-running-box{background:var(--bp-card,#fff);border:1.5px solid var(--bp-border,#e2e6f0);border-radius:16px;padding:40px 48px;text-align:center;max-width:500px;width:100%}
  .bp-running-title{font-size:18px;font-weight:700;color:var(--bp-text,#1a1d2e);margin-bottom:6px}
  .bp-running-name{font-size:13px;color:#9aa0b2;margin-bottom:24px}
  .bp-running-progress-wrap{display:flex;align-items:center;gap:12px;margin-bottom:16px}
  .bp-running-progress-bar{flex:1;height:8px;background:var(--bp-border,#e2e6f0);border-radius:4px;overflow:hidden}
  .bp-running-progress-fill{height:100%;background:#4f6df5;border-radius:4px;transition:width .3s}
  .bp-running-pct{font-size:14px;font-weight:700;color:#4f6df5;min-width:36px;text-align:right}
  .bp-running-stats{display:flex;justify-content:center;gap:20px;margin-bottom:12px;font-size:13px;color:#6b7280}
  .bp-rs-item b{color:var(--bp-text,#1a1d2e)}
  .bp-running-current{font-size:12px;color:#9aa0b2;font-style:italic;margin-bottom:20px}
  .bp-session-header{display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap}
  .bp-session-title{font-size:20px;font-weight:700;color:var(--bp-text,#1a1d2e);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bp-session-meta{font-size:12px;color:#9aa0b2}
  .bp-session-open-all{margin-left:auto}
  .bp-session-summary{display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap}
  .bp-sum-card{background:var(--bp-card,#fff);border:1.5px solid var(--bp-border,#e2e6f0);border-radius:10px;padding:14px 20px;text-align:center;min-width:100px}
  .bp-sum-label{font-size:10px;text-transform:uppercase;letter-spacing:.3px;color:#9aa0b2;margin-bottom:4px}
  .bp-sum-value{font-size:20px;font-weight:700;color:var(--bp-text,#1a1d2e)}
  .bp-pos{color:#22c55e!important}.bp-neg{color:#ef4444!important}
  .bp-session-filters{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:16px;padding:16px 20px;background:var(--bp-card,#fff);border:1.5px solid var(--bp-border,#e2e6f0);border-radius:12px}
  .bp-filter-search{flex:1;min-width:150px;max-width:220px}
  .bp-filter-range-group{display:flex;align-items:center;gap:6px}
  .bp-session-table-wrap{overflow-x:auto;background:var(--bp-card,#fff);border:1.5px solid var(--bp-border,#e2e6f0);border-radius:12px}
  .bp-session-tbl{width:100%;border-collapse:collapse}
  .bp-th{padding:10px 14px;background:var(--bp-input,#f8f9fc);color:#9aa0b2;font-size:10px;text-transform:uppercase;letter-spacing:.3px;text-align:left;border-bottom:1.5px solid var(--bp-border,#e2e6f0);white-space:nowrap}
  .bp-th-active{color:#4f6df5;background:#f0f4ff}
  .bp-td{padding:10px 14px;font-size:12px;color:#6b7280;border-bottom:1px solid var(--bp-border,#e2e6f0)}
  .bp-session-row:hover .bp-td{background:#f8f9fc}
  .bp-row-error .bp-td{opacity:.6}
  .bp-row-clickable:hover .bp-td{background:color-mix(in srgb,#4f6df5 6%,transparent)!important;cursor:pointer}
  .bp-num{text-align:right;font-variant-numeric:tabular-nums;font-family:'Consolas',monospace}
  .bp-params-cell{font-family:monospace;font-size:11px;color:#9aa0b2}
  .bp-status-ok{color:#22c55e;font-size:14px}
  .bp-status-err{color:#ef4444;font-size:14px;cursor:help}
  .bp-status-pend{color:#d1d5db}
  .bp-pagination{display:flex;align-items:center;justify-content:center;gap:16px;padding:16px;background:var(--bp-card,#fff);border:1.5px solid var(--bp-border,#e2e6f0);border-top:none;border-radius:0 0 12px 12px}
  .bp-page-info{font-size:12px;color:#9aa0b2}
  .bp-history-list{display:flex;flex-direction:column;gap:10px}
  .bp-hist-card{background:var(--bp-card,#fff);border:1.5px solid var(--bp-border,#e2e6f0);border-radius:14px;padding:18px 22px;display:flex;align-items:center;gap:20px;transition:border-color .15s}
  .bp-hist-card:hover{border-color:#4f6df5}
  .bp-hist-left{flex:1;min-width:0}
  .bp-hist-name{font-size:15px;font-weight:600;color:var(--bp-text,#1a1d2e);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bp-hist-meta{display:flex;gap:12px;font-size:12px;color:#9aa0b2}
  .bp-hist-stats{display:flex;gap:10px}
  .bp-hist-actions{display:flex;gap:8px;flex-shrink:0}
  /* Trades modal */
  .bp-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:32px 16px;overflow-y:auto}
  .bp-modal-wide{max-width:95vw!important;width:95vw!important}
  .bp-modal{background:var(--bp-card,#fff);border:1.5px solid var(--bp-border,#e2e6f0);border-radius:16px;width:100%;max-width:1140px;display:flex;flex-direction:column;max-height:88vh}
  .bp-modal-head{display:flex;align-items:center;gap:12px;padding:18px 24px;border-bottom:1.5px solid var(--bp-border,#e2e6f0);flex-shrink:0}
  .bp-modal-title{font-size:15px;font-weight:700;color:var(--bp-text,#1a1d2e);flex:1}
  .bp-modal-close{background:none;border:none;font-size:20px;color:#9aa0b2;cursor:pointer;padding:2px 8px;border-radius:6px;line-height:1}
  .bp-modal-close:hover{background:#f0f4ff;color:#4f6df5}
  .bp-modal-stats{display:flex;flex-wrap:wrap;gap:8px;padding:14px 24px;border-bottom:1.5px solid var(--bp-border,#e2e6f0);flex-shrink:0}
  .bp-modal-body{overflow-y:auto;flex:1}
  .bp-trades-tbl{width:100%;border-collapse:collapse}
  .bp-trades-tbl th{padding:8px 12px;background:var(--bp-input,#f8f9fc);color:#9aa0b2;font-size:10px;text-transform:uppercase;letter-spacing:.3px;text-align:left;border-bottom:1.5px solid var(--bp-border,#e2e6f0);white-space:nowrap;position:sticky;top:0;z-index:2}
  .bp-trades-tbl td{padding:7px 12px;font-size:12px;color:#6b7280;border-bottom:1px solid var(--bp-border,#e2e6f0);font-variant-numeric:tabular-nums;font-family:"Consolas",monospace}
  .bp-trades-tbl tr:hover td{background:#f8f9fc}
  .bp-trade-win td:first-child{border-left:3px solid #22c55e}
  .bp-trade-loss td:first-child{border-left:3px solid #ef4444}
  .bp-chart-btn{background:none;border:1px solid var(--bp-border,#e2e6f0);border-radius:5px;cursor:pointer;font-size:12px;padding:2px 6px;opacity:.6;transition:opacity .15s}
  .bp-chart-btn:hover{opacity:1;border-color:#4f6df5}
  .bp-exit-SL{color:#ef4444;font-weight:600}
  .bp-exit-TP{color:#22c55e;font-weight:600}
  .bp-exit-TIMEOUT,.bp-exit-CANCEL{color:#9aa0b2}
  /* Range-Bar UI */
  .bp-bt-type-row{display:flex;gap:10px;flex-wrap:wrap}
  .bp-bt-type-btn{padding:10px 22px;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;border:1.5px solid var(--bp-border,#e2e6f0);background:transparent;color:#6b7280;transition:all .15s}
  .bp-bt-type-btn:hover{border-color:#4f6df5;color:#4f6df5}
  .bp-bt-type-active{background:#1a1d2e!important;color:#fff!important;border-color:#1a1d2e!important}
  .bp-rb-branches{display:flex;align-items:center;gap:16px;margin-top:16px;flex-wrap:wrap}
  .bp-rb-branch-cb{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--bp-text,#1a1d2e);cursor:pointer}
  .bp-rb-branch-cb input{accent-color:#4f6df5;width:15px;height:15px}
  .bp-rb-conditions{margin-top:14px}
  .bp-rb-cond-list{display:flex;flex-direction:column;gap:5px;margin-bottom:10px}
  .bp-rb-cond{font-size:12px;color:#6b7280;padding:5px 10px;background:var(--bp-input,#f8f9fc);border-radius:6px;border:1px solid var(--bp-border,#e2e6f0)}
  .bp-rb-cond-branch-a{border-color:#4f6df5;color:#4f6df5;background:color-mix(in srgb,#4f6df5 8%,transparent)}
  .bp-rb-order-summary{font-size:11px;color:#9aa0b2;padding:8px 10px;background:var(--bp-input,#f8f9fc);border-radius:6px;border:1px solid var(--bp-border,#e2e6f0)}
  .bp-rb-meta-row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
  .bp-rb-meta-item{background:var(--bp-card,#fff);border:1.5px solid var(--bp-border,#e2e6f0);border-radius:8px;padding:10px 16px;display:flex;flex-direction:column;gap:3px}
  .bp-rb-meta-item span{font-size:10px;text-transform:uppercase;letter-spacing:.3px;color:#9aa0b2}
  .bp-rb-meta-item b{font-size:16px;font-weight:700;color:var(--bp-text,#1a1d2e)}
  .bp-rb-branch{background:var(--bp-card,#fff);border:1.5px solid var(--bp-border,#e2e6f0);border-radius:12px;padding:18px 20px;margin-bottom:14px}
  .bp-rb-branch-title{font-size:16px;font-weight:700;color:var(--bp-text,#1a1d2e);margin-bottom:14px;display:flex;align-items:center;flex-wrap:wrap;gap:8px}
  .bp-rb-branch-sub{font-size:12px;font-weight:400;color:#9aa0b2}
  .bp-rb-tables{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;margin-bottom:14px}
  .bp-rb-sub-tbl{overflow-x:auto}
  .bp-rb-sub-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;color:#9aa0b2;margin-bottom:8px}
  .bp-row-tp .bp-td{background:color-mix(in srgb,#22c55e 5%,transparent)}
  .bp-row-sl .bp-td{background:color-mix(in srgb,#ef4444 5%,transparent)}
  /* Dark */
  body.dark-theme{--bp-bg:#060810;--bp-card:#0c0e1a;--bp-border:#1a1e34;--bp-text:#d1d4dc;--bp-input:#080a14}
  body.dark-theme .bp-card,body.dark-theme .bp-run-footer,body.dark-theme .bp-session-filters,
  body.dark-theme .bp-session-table-wrap,body.dark-theme .bp-pagination,body.dark-theme .bp-sum-card,
  body.dark-theme .bp-hist-card,body.dark-theme .bp-running-box,body.dark-theme .bp-rb-branch,
  body.dark-theme .bp-rb-meta-item,body.dark-theme .bp-modal{background:#0c0e1a;border-color:#1a1e34}
  body.dark-theme .bp-input,body.dark-theme .bp-select{background:#080a14;border-color:#1a1e34;color:#d1d4dc}
  body.dark-theme .bp-input:focus{background:#0c0e1a;border-color:#4f6df5}
  body.dark-theme .bp-crit-card{background:#080a14;border-color:#1a1e34}
  body.dark-theme .bp-multi-list{border-color:#1a1e34}
  body.dark-theme .bp-multi-item{border-color:#1a1e34}
  body.dark-theme .bp-multi-item:hover{background:#141826}
  body.dark-theme .bp-multi-item-on{background:color-mix(in srgb,#4f6df5 15%,transparent)}
  body.dark-theme .bp-multi-label{color:#d1d4dc}
  body.dark-theme .bp-th{background:#080a14;border-color:#1a1e34}
  body.dark-theme .bp-th-active{background:#0a1230;color:#4f9df5}
  body.dark-theme .bp-td,body.dark-theme .bp-trades-tbl td{border-color:#1a1e34;color:#8a90a8}
  body.dark-theme .bp-session-row:hover .bp-td,body.dark-theme .bp-trades-tbl tr:hover td{background:#0d0f1e}
  body.dark-theme .bp-expr-ro{background:#080a14;border-color:#1a1e34}
  body.dark-theme .bp-expr-ta{background:#080a14;border-color:#1a1e34;color:#d1d4dc}
  body.dark-theme .bp-running-progress-bar{background:#1a1e34}
  body.dark-theme .bp-sum-value,body.dark-theme .bp-session-title,body.dark-theme .bp-title,
  body.dark-theme .bp-hist-name,body.dark-theme .bp-rb-branch-title,body.dark-theme .bp-rb-meta-item b,
  body.dark-theme .bp-modal-title{color:#d1d4dc}
  body.dark-theme .bp-bt-type-active{background:#4f6df5!important;border-color:#4f6df5!important}
  body.dark-theme .bp-rb-cond{background:#080a14;border-color:#1a1e34;color:#8a90a8}
  body.dark-theme .bp-rb-order-summary{background:#080a14;border-color:#1a1e34;color:#4a5068}
  body.dark-theme .bp-trades-tbl th{background:#080a14;border-color:#1a1e34}
  body.dark-theme .bp-modal-head,.bp-modal-stats{border-color:#1a1e34}
      `;
      document.head.appendChild(s);
    }
  
    // ════════════════════════════════════════════════════════════
    // INIT
    // ════════════════════════════════════════════════════════════
  
    async function init() {
      injectCSS();
      await loadAll();
    }
  
    window.backtestPage = {
      init,
      reload: loadAll,
      preselect: (id, name) => {
        BP.cfg.setupId   = id;
        BP.cfg.setupName = name;
        BP.cfg.setupMeta = BP.setups.find(s => s.id === id)?._meta || null;
        BP.cfg.backtestType = 'standard';
        BP.view = 'configure';
        renderPage();
      },
    };
  
  })();