/**
 * backtest-page.js  v4.0
 *
 * Полный рефакторинг страницы бэктестов.
 *
 * Ключевые концепции:
 *
 *  1. КОНФИГУРАТОР — выбор сетапа, инструментов (мульти), таймфреймов (мульти),
 *     параметров критериев (матрица значений), фильтров входа/выхода.
 *
 *  2. МАТРИЦА ЗАПУСКОВ — cartesian product:
 *     runs = instruments × timeframes × paramValues
 *
 *  3. ЗАПУСК — последовательное выполнение всех комбинаций через /api/backtest/run.
 *
 *  4. ИСТОРИЯ — сессии бэктестов сохраняются через /api/javascript-scripts (type=strategy).
 *
 *  5. СТРАНИЦА РЕЗУЛЬТАТОВ — таблица всех запусков сессии с фильтрами и пагинацией.
 *
 * POST /api/backtest/run принимает:
 *   { ticker, table, fromDate, toDate, capital, riskPct, leverage,
 *     slMode, slValue, tpMode, tpValue, maxBars, direction, setupCols }
 */

(function () {
  'use strict';

  // ════════════════════════════════════════════════════════════════
  // STATE
  // ════════════════════════════════════════════════════════════════

  const BP = {
    // Справочники
    setups:        [],   // type_code='setup'
    instruments:   [],   // /api/instruments
    intervals:     [],   // /api/intervals
    strategies:    [],   // type_code='strategy' (история)
    strategyTypeId: null,

    // Текущий вид
    view: 'configure',  // 'configure' | 'running' | 'session' | 'history'

    // Конфигурация запуска
    cfg: defaultCfg(),

    // Текущая сессия (набор запусков)
    session: null,   // { id, name, runs: [], totalRuns, doneRuns, startedAt }

    // Для страницы детализации сессии
    sessionFilter: defaultSessionFilter(),
    sessionPage:   0,
    SESSION_PAGE:  50,

    // Глобальные
    loading: false,
    error:   null,
  };

  function defaultCfg() {
    return {
      setupId:          null,
      setupName:        '',
      setupMeta:        null,  // распаршенный meta сетапа

      // Инструменты (массив)
      selectedInstruments: [],  // [{ id, symbol, clickhouse_ticker }]

      // Таймфреймы (массив)
      selectedIntervals:   [],  // [{ id, code, name, clickhouse_table }]

      // Период
      periodMode:  'all',  // 'all' | 'in_sample' | 'out_of_sample' | 'custom'
      inSamplePct: 70,     // для in_sample/out_of_sample
      fromDate:    '',
      toDate:      '',

      // Комиссия
      commission:  0.1,

      // Параметры критериев (матрица значений для grid search)
      // { "paramName": [10, 20, 30] }
      paramMatrix: {},

      // Фильтры (дополнительные AND-условия)
      entryFilter: '',   // JS-выражение
      exitFilter:  '',   // JS-выражение
    };
  }

  function defaultSessionFilter() {
    return {
      search:      '',
      minTrades:   '',
      maxTrades:   '',
      minWinRate:  '',
      maxWinRate:  '',
      minPnl:      '',
      maxPnl:      '',
      instrument:  '',
      interval:    '',
      sortField:   'pnl',
      sortDir:     'desc',
    };
  }

  // ════════════════════════════════════════════════════════════════
  // API
  // ════════════════════════════════════════════════════════════════

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
    BP.loading = true; renderPage();
    try {
      const [typesR, scriptsR, instR, intR] = await Promise.allSettled([
        apiFetch('/api/script-types'),
        apiFetch('/api/javascript-scripts'),
        apiFetch('/api/instruments'),
        apiFetch('/api/intervals'),
      ]);
      if (typesR.status === 'fulfilled') {
        BP.strategyTypeId = typesR.value.find(x => x.code === 'strategy')?.id ?? null;
      }
      if (scriptsR.status === 'fulfilled') {
        const all = scriptsR.value;
        BP.setups     = all.filter(s => s.type_code === 'setup').map(s => ({ ...s, _meta: parseMeta(s.meta) }));
        BP.strategies = all.filter(s => s.type_code === 'strategy').map(s => ({ ...s, _meta: parseMeta(s.meta), _code: parseMeta(s.code) }));
      }
      if (instR.status === 'fulfilled') {
        BP.instruments = (instR.value || []).filter(i => i.clickhouse_ticker && i.is_active !== false);
      }
      if (intR.status === 'fulfilled') {
        BP.intervals = (intR.value || []).filter(i => i.clickhouse_table && i.is_active !== false);
      }
    } catch (e) { BP.error = e.message; }
    finally { BP.loading = false; renderPage(); }
  }

  // ════════════════════════════════════════════════════════════════
  // BUILD RUNS (cartesian product)
  // ════════════════════════════════════════════════════════════════

  function buildRuns(cfg) {
    const insts    = cfg.selectedInstruments.length ? cfg.selectedInstruments : [];
    const ivals    = cfg.selectedIntervals.length   ? cfg.selectedIntervals   : [];
    const paramCombos = buildParamCombos(cfg.paramMatrix);

    if (!insts.length || !ivals.length) return [];

    const runs = [];
    for (const inst of insts) {
      for (const ival of ivals) {
        for (const params of paramCombos) {
          runs.push({ inst, ival, params });
        }
      }
    }
    return runs;
  }

  function buildParamCombos(matrix) {
    const keys = Object.keys(matrix).filter(k => matrix[k]?.length);
    if (!keys.length) return [{}];

    let combos = [{}];
    for (const key of keys) {
      const vals = matrix[key];
      const next = [];
      for (const combo of combos) {
        for (const val of vals) {
          next.push({ ...combo, [key]: val });
        }
      }
      combos = next;
    }
    return combos;
  }

  function dateRangeFromPeriod(cfg, totalFrom, totalTo) {
    // totalFrom/totalTo — начало и конец доступных данных по инструменту
    if (cfg.periodMode === 'all') return { fromDate: null, toDate: null };
    if (cfg.periodMode === 'custom') return { fromDate: cfg.fromDate || null, toDate: cfg.toDate || null };

    const pct = (cfg.inSamplePct || 70) / 100;
    if (!totalFrom || !totalTo) return { fromDate: null, toDate: null };

    const from = new Date(totalFrom).getTime();
    const to   = new Date(totalTo).getTime();
    const mid  = new Date(from + (to - from) * pct);
    const midStr = mid.toISOString().slice(0, 10);

    if (cfg.periodMode === 'in_sample')    return { fromDate: totalFrom, toDate: midStr };
    if (cfg.periodMode === 'out_of_sample') return { fromDate: midStr,    toDate: totalTo };
    return { fromDate: null, toDate: null };
  }

  function buildSetupCols(setup, paramOverrides) {
    const meta     = setup._meta || {};
    const criteria = meta.criteria || [];
    const cols     = {};
    criteria.filter(c => c.enabled !== false).forEach((c, i) => {
      const colName = `crit_${i}`;
      const params  = { ...(c.params || {}) };
      // Apply overrides
      if (paramOverrides) {
        Object.entries(paramOverrides).forEach(([k, v]) => {
          if (params.hasOwnProperty(k)) params[k] = v;
        });
      }
      cols[colName] = {
        scriptId:   c.scriptId,
        scriptName: c.scriptName || c.label,
        dir:        'long',
        params,
        entryExpression: meta.entry_expression || null,
        exitExpression:  meta.exit_expression  || null,
      };
    });
    return cols;
  }

  // ════════════════════════════════════════════════════════════════
  // RUN SESSION
  // ════════════════════════════════════════════════════════════════

  async function runSession() {
    const cfg   = BP.cfg;
    const setup = BP.setups.find(s => s.id === cfg.setupId);
    if (!setup)                            { alert('Выберите сетап');             return; }
    if (!cfg.selectedInstruments.length)   { alert('Выберите хотя бы 1 инструмент'); return; }
    if (!cfg.selectedIntervals.length)     { alert('Выберите хотя бы 1 таймфрейм');  return; }

    const runs = buildRuns(cfg);
    if (!runs.length) { alert('Нет комбинаций для запуска'); return; }

    const sessionName = `${setup.display_name} · ${new Date().toLocaleString('ru')}`;
    BP.session = {
      id:         Date.now(),
      name:       sessionName,
      setupId:    setup.id,
      setupName:  setup.display_name,
      runs:       runs.map(r => ({
        ...r,
        status:   'pending',  // pending | running | done | error
        result:   null,
        error:    null,
      })),
      totalRuns:  runs.length,
      doneRuns:   0,
      errorRuns:  0,
      startedAt:  new Date().toISOString(),
    };

    BP.view = 'running';
    renderPage();

    // Sequential execution (не перегружаем сервер)
    for (let i = 0; i < BP.session.runs.length; i++) {
      const run = BP.session.runs[i];
      run.status = 'running';
      renderRunProgress(i);

      try {
        const { fromDate, toDate } = dateRangeFromPeriod(cfg, null, null);
        const setupCols = buildSetupCols(setup, run.params);

        const body = {
          ticker:    run.inst.clickhouse_ticker,
          table:     run.ival.clickhouse_table,
          fromDate:  fromDate  || undefined,
          toDate:    toDate    || undefined,
          commission: cfg.commission,
          capital:   10000,
          riskPct:   1,
          leverage:  1,
          direction: 'both',
          setupCols,
          entryFilter: cfg.entryFilter || undefined,
          exitFilter:  cfg.exitFilter  || undefined,
        };

        const resp  = await fetch('/api/backtest/run', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body:    JSON.stringify(body),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

        run.status = 'done';
        run.result = data;
      } catch (e) {
        run.status = 'error';
        run.error  = e.message;
        BP.session.errorRuns++;
      }

      BP.session.doneRuns++;
      renderRunProgress(i);

      // Tiny pause to not block UI
      await new Promise(r => setTimeout(r, 20));
    }

    // Save session
    await saveSession(BP.session);
    await loadAll();

    BP.view = 'session';
    renderPage();
  }

  async function saveSession(session) {
    if (!BP.strategyTypeId) return;
    try {
      // Compact results for storage
      const summary = session.runs.map(r => ({
        instrument:   r.inst.symbol,
        ticker:       r.inst.clickhouse_ticker,
        interval:     r.ival.name,
        table:        r.ival.clickhouse_table,
        params:       r.params,
        status:       r.status,
        error:        r.error || undefined,
        trades:       r.result?.trades?.length || 0,
        stats:        r.result?.stats || null,
      }));

      const meta = {
        session_summary: {
          name:       session.name,
          setupId:    session.setupId,
          setupName:  session.setupName,
          startedAt:  session.startedAt,
          totalRuns:  session.totalRuns,
          doneRuns:   session.doneRuns,
          errorRuns:  session.errorRuns,
        },
        runs: summary,
      };

      await apiFetch('/api/javascript-scripts', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          display_name:  session.name,
          system_name:   'strategy_' + session.id,
          type_id:       BP.strategyTypeId,
          code:          '{}',
          meta,
          is_public:     false,
          inputs_schema: [],
          is_overlay:    false,
        }),
      });
    } catch (e) {
      console.warn('Failed to save session:', e.message);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════════════

  function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function fmtPct(v) { if (v == null) return '—'; const n = parseFloat(v); return (n >= 0 ? '+' : '') + n.toFixed(1) + '%'; }
  function fmtPnl(v) { if (v == null) return '—'; const n = parseFloat(v); return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(0); }
  function fmtN(v, dec=2) { if (v == null || v === '') return '—'; return parseFloat(v).toFixed(dec); }
  function getRoot() { return document.getElementById('backtest-page-root'); }

  // ════════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════════

  function renderPage() {
    const root = getRoot(); if (!root) return;

    if (BP.loading) {
      root.innerHTML = '<div class="bp-loading-full">Загрузка...</div>';
      return;
    }

    if      (BP.view === 'configure') root.innerHTML = buildConfigureHTML();
    else if (BP.view === 'running')   root.innerHTML = buildRunningHTML();
    else if (BP.view === 'session')   root.innerHTML = buildSessionHTML(BP.session);
    else if (BP.view === 'history')   root.innerHTML = buildHistoryHTML();

    bindEvents();
  }

  // ─────────────────────────────────────────────
  // CONFIGURE
  // ─────────────────────────────────────────────

  function buildConfigureHTML() {
    const cfg   = BP.cfg;
    const setup = BP.setups.find(s => s.id === cfg.setupId);
    const meta  = setup?._meta || {};
    const criteria = meta.criteria || [];
    const runs  = buildRuns(cfg);

    return `
    <div class="bp-page">
      <div class="bp-page-header">
        <h1 class="bp-title">Бэктест</h1>
        <div class="bp-header-actions">
          <button class="bp-btn bp-btn-ghost" id="bp-open-history">📁 История</button>
        </div>
      </div>

      <div class="bp-configure">

        <!-- Card: Сетап -->
        <div class="bp-card">
          <div class="bp-card-section-title">Сетап</div>
          <select class="bp-select bp-select-lg" id="bp-setup-sel">
            <option value="">Выберите сетап</option>
            ${BP.setups.map(s => `<option value="${s.id}" ${cfg.setupId===s.id?'selected':''}>${esc(s.display_name)}</option>`).join('')}
          </select>
        </div>

        ${setup ? `
        <!-- Card: Критерии сетапа -->
        <div class="bp-card">
          <div class="bp-card-section-title">
            Критерии сетапа
            <span class="bp-section-hint">Параметры критериев для матрицы запусков</span>
          </div>

          ${criteria.length ? `
          <div class="bp-criteria-grid">
            ${criteria.filter(c => c.enabled !== false).map(c => {
              const inputs = c.inputs_schema || [];
              return `
              <div class="bp-crit-card">
                <div class="bp-crit-card-name">${esc(c.label || c.scriptName || 'Критерий')}</div>
                ${inputs.map(inp => {
                  const matrixKey = c.id + ':' + inp.id;
                  const matrixVal = (cfg.paramMatrix[matrixKey] || []).join(', ');
                  const defVal    = c.params?.[inp.id] ?? inp.defval ?? '';
                  return `
                  <div class="bp-crit-param">
                    <label class="bp-label">${esc(inp.name || inp.id)}</label>
                    <div class="bp-param-row">
                      <input class="bp-input bp-input-sm" type="text"
                        placeholder="Значение: ${esc(String(defVal))}"
                        value="${esc(defVal)}"
                        readonly style="flex:0 0 80px;color:#9aa0b2">
                      <span class="bp-param-sep">→</span>
                      <input class="bp-input bp-matrix-inp" type="text"
                        data-matrix-key="${esc(matrixKey)}"
                        placeholder="Матрица: 10, 20, 30"
                        value="${esc(matrixVal)}"
                        title="Перечислите значения через запятую для grid search">
                    </div>
                  </div>`;
                }).join('')}
              </div>`;
            }).join('')}
          </div>` : '<div class="bp-hint-empty">В сетапе нет критериев с параметрами</div>'}

          <!-- Условие входа -->
          <div class="bp-expr-block">
            <div class="bp-expr-label">
              Условие входа из сетапа
              <span class="bp-section-hint">Можно дополнить фильтром ниже (AND)</span>
            </div>
            <pre class="bp-expr-ro">${esc(meta.entry_expression || '— не задано —')}</pre>
          </div>

          <div class="bp-expr-block">
            <div class="bp-expr-label">
              Дополнительный фильтр входа
              <span class="bp-section-hint">Добавляется через AND к условию входа</span>
            </div>
            <textarea class="bp-expr-ta" id="bp-entry-filter"
              placeholder="bar.volume > bar.avg_volume * 1.5"
              rows="2">${esc(cfg.entryFilter || '')}</textarea>
          </div>

          <div class="bp-expr-block" style="margin-top:12px">
            <div class="bp-expr-label">
              Условие выхода из сетапа
              <span class="bp-section-hint">Можно дополнить фильтром ниже (AND)</span>
            </div>
            <pre class="bp-expr-ro">${esc(meta.exit_expression || '— не задано —')}</pre>
          </div>

          <div class="bp-expr-block">
            <div class="bp-expr-label">
              Дополнительный фильтр выхода
              <span class="bp-section-hint">Добавляется через AND к условию выхода</span>
            </div>
            <textarea class="bp-expr-ta" id="bp-exit-filter"
              placeholder="bar.rsi_14 > 80"
              rows="2">${esc(cfg.exitFilter || '')}</textarea>
          </div>
        </div>
        ` : ''}

        <!-- Card: Параметры запуска -->
        <div class="bp-card">
          <div class="bp-card-section-title">Параметры запуска</div>

          <div class="bp-params-grid-4">
            <div class="bp-field">
              <label class="bp-label">Период тестирования</label>
              <select class="bp-select" id="bp-period-sel">
                <option value="all"            ${cfg.periodMode==='all'           ?'selected':''}>Весь</option>
                <option value="in_sample"      ${cfg.periodMode==='in_sample'     ?'selected':''}>In-Sample</option>
                <option value="out_of_sample"  ${cfg.periodMode==='out_of_sample' ?'selected':''}>Out-Of-Sample</option>
                <option value="custom"         ${cfg.periodMode==='custom'        ?'selected':''}>Свой период</option>
              </select>
            </div>

            ${cfg.periodMode === 'in_sample' || cfg.periodMode === 'out_of_sample' ? `
            <div class="bp-field">
              <label class="bp-label">In-Sample %</label>
              <input class="bp-input" id="bp-insample-pct" type="number" min="10" max="95" step="5"
                value="${cfg.inSamplePct}" placeholder="70">
            </div>` : ''}

            ${cfg.periodMode === 'custom' ? `
            <div class="bp-field">
              <label class="bp-label">Дата от</label>
              <input class="bp-input" id="bp-from-date" type="date" value="${esc(cfg.fromDate)}">
            </div>
            <div class="bp-field">
              <label class="bp-label">Дата до</label>
              <input class="bp-input" id="bp-to-date" type="date" value="${esc(cfg.toDate)}">
            </div>` : ''}

            <div class="bp-field">
              <label class="bp-label">Комиссия (%)</label>
              <input class="bp-input" id="bp-commission" type="number" step="0.01" min="0"
                value="${cfg.commission}" placeholder="0.1">
            </div>
          </div>
        </div>

        <!-- Card: Инструменты + Таймфреймы -->
        <div class="bp-card">
          <div class="bp-card-section-title">
            Инструменты и таймфреймы
            <span class="bp-section-hint">Для каждой комбинации будет отдельный бэктест</span>
          </div>

          <div class="bp-two-cols">
            <div class="bp-multi-col">
              <div class="bp-multi-header">
                <span class="bp-label">Торговые инструменты</span>
                <button class="bp-link-btn" id="bp-inst-all">все</button>
                <button class="bp-link-btn" id="bp-inst-none">сбросить</button>
              </div>
              <div class="bp-multi-list" id="bp-inst-list">
                ${BP.instruments.map(i => {
                  const sel = cfg.selectedInstruments.some(s => s.id === i.id);
                  return `<label class="bp-multi-item ${sel?'bp-multi-item-on':''}">
                    <input type="checkbox" class="bp-inst-cb" data-id="${i.id}"
                      data-symbol="${esc(i.symbol)}"
                      data-ticker="${esc(i.clickhouse_ticker)}"
                      ${sel?'checked':''}>
                    <span class="bp-multi-label">${esc(i.symbol)}</span>
                    ${i.name ? `<span class="bp-multi-sub">${esc(i.name)}</span>` : ''}
                  </label>`;
                }).join('')}
              </div>
            </div>

            <div class="bp-multi-col">
              <div class="bp-multi-header">
                <span class="bp-label">Таймфреймы</span>
                <button class="bp-link-btn" id="bp-ival-all">все</button>
                <button class="bp-link-btn" id="bp-ival-none">сбросить</button>
              </div>
              <div class="bp-multi-list" id="bp-ival-list">
                ${BP.intervals.map(i => {
                  const sel = cfg.selectedIntervals.some(s => s.id === i.id);
                  return `<label class="bp-multi-item ${sel?'bp-multi-item-on':''}">
                    <input type="checkbox" class="bp-ival-cb" data-id="${i.id}"
                      data-code="${esc(i.code)}"
                      data-name="${esc(i.name)}"
                      data-table="${esc(i.clickhouse_table)}"
                      ${sel?'checked':''}>
                    <span class="bp-multi-label">${esc(i.name)}</span>
                  </label>`;
                }).join('')}
              </div>
            </div>
          </div>
        </div>

        <!-- Run summary + button -->
        <div class="bp-run-footer">
          <div class="bp-run-summary">
            ${runs.length
              ? `<span class="bp-run-count">${runs.length}</span> запусков · ${cfg.selectedInstruments.length} инструм. × ${cfg.selectedIntervals.length} таймфр.${Object.keys(cfg.paramMatrix).filter(k=>cfg.paramMatrix[k]?.length).length ? ' × параметры' : ''}`
              : '<span class="bp-run-count-zero">0</span> — выберите инструменты и таймфреймы'}
          </div>
          <button class="bp-btn bp-btn-run" id="bp-run-btn"
            ${!setup || !runs.length ? 'disabled' : ''}>
            ▶ Запустить бэктест
          </button>
        </div>

      </div>
    </div>`;
  }

  // ─────────────────────────────────────────────
  // RUNNING (прогресс)
  // ─────────────────────────────────────────────

  function buildRunningHTML() {
    const s = BP.session; if (!s) return '';
    const pct = s.totalRuns ? Math.round(s.doneRuns / s.totalRuns * 100) : 0;
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

  function renderRunProgress(idx) {
    // Partial update without full re-render
    const s = BP.session; if (!s) return;
    const root = getRoot(); if (!root) return;
    if (BP.view !== 'running') { BP.view = 'running'; renderPage(); return; }
    const pct  = s.totalRuns ? Math.round(s.doneRuns / s.totalRuns * 100) : 0;
    const fill = root.querySelector('.bp-running-progress-fill');
    const pctEl = root.querySelector('.bp-running-pct');
    const statsEl = root.querySelector('.bp-running-stats');
    const curEl   = root.querySelector('.bp-running-current');
    if (fill) fill.style.width = pct + '%';
    if (pctEl) pctEl.textContent = pct + '%';
    const done = s.runs.filter(r => r.status === 'done').length;
    const err  = s.runs.filter(r => r.status === 'error').length;
    if (statsEl) statsEl.innerHTML = `
      <span class="bp-rs-item"><b>${s.doneRuns}</b> / ${s.totalRuns} запусков</span>
      <span class="bp-rs-item bp-pos"><b>${done}</b> успешно</span>
      ${err ? `<span class="bp-rs-item bp-neg"><b>${err}</b> ошибок</span>` : ''}`;
    const run = s.runs.find(r => r.status === 'running');
    if (curEl && run) curEl.textContent = `Сейчас: ${run.inst.symbol} · ${run.ival.name}`;
  }

  // ─────────────────────────────────────────────
  // SESSION DETAIL
  // ─────────────────────────────────────────────

  function buildSessionHTML(session) {
    if (!session) return '<div class="bp-loading-full">Нет данных</div>';
    const { runs } = session;
    const sm = session;

    // Apply filters
    const f = BP.sessionFilter;
    let filtered = runs.filter(r => {
      if (r.status !== 'done' && r.status !== 'error') return true;
      const s = r.result?.stats || {};
      if (f.search && !`${r.inst?.symbol} ${r.ival?.name}`.toLowerCase().includes(f.search.toLowerCase())) return false;
      if (f.instrument && r.inst?.symbol !== f.instrument) return false;
      if (f.interval   && r.ival?.name   !== f.interval)   return false;
      const trades  = r.result?.trades?.length || 0;
      const winRate = parseFloat(s.winRate  || 0);
      const pnl     = parseFloat(s.totalPnl || 0);
      if (f.minTrades  && trades  < +f.minTrades)  return false;
      if (f.maxTrades  && trades  > +f.maxTrades)  return false;
      if (f.minWinRate && winRate < +f.minWinRate) return false;
      if (f.maxWinRate && winRate > +f.maxWinRate) return false;
      if (f.minPnl     && pnl    < +f.minPnl)     return false;
      if (f.maxPnl     && pnl    > +f.maxPnl)     return false;
      return true;
    });

    // Sort
    const sf = f.sortField;
    const sd = f.sortDir === 'asc' ? 1 : -1;
    filtered.sort((a, b) => {
      const sa = a.result?.stats || {}, sb = b.result?.stats || {};
      if (sf === 'trades')  return sd * ((a.result?.trades?.length||0) - (b.result?.trades?.length||0));
      if (sf === 'winRate') return sd * (parseFloat(sa.winRate||0) - parseFloat(sb.winRate||0));
      if (sf === 'pnl')     return sd * (parseFloat(sa.totalPnl||0) - parseFloat(sb.totalPnl||0));
      if (sf === 'pf')      return sd * (parseFloat(sa.profitFactor||0) - parseFloat(sb.profitFactor||0));
      if (sf === 'dd')      return sd * (parseFloat(sa.maxDrawdown||0) - parseFloat(sb.maxDrawdown||0));
      return 0;
    });

    // Paginate
    const PAGE  = BP.SESSION_PAGE;
    const total = filtered.length;
    const pages = Math.ceil(total / PAGE);
    const page  = Math.max(0, Math.min(BP.sessionPage, pages - 1));
    const rows  = filtered.slice(page * PAGE, (page + 1) * PAGE);

    // Summary stats
    const done  = runs.filter(r => r.status === 'done');
    const sumTrades = done.reduce((s, r) => s + (r.result?.trades?.length || 0), 0);
    const avgPnl    = done.length
      ? done.reduce((s, r) => s + parseFloat(r.result?.stats?.totalPnl || 0), 0) / done.length
      : null;

    // Unique instruments/intervals for filter dropdowns
    const uniqueInsts = [...new Set(runs.map(r => r.inst?.symbol).filter(Boolean))];
    const uniqueIvals = [...new Set(runs.map(r => r.ival?.name).filter(Boolean))];

    const thSort = (label, field) => {
      const active = sf === field;
      const arrow  = active ? (sd === 1 ? ' ↑' : ' ↓') : '';
      return `<th class="bp-th ${active?'bp-th-active':''}" data-sort="${field}" style="cursor:pointer">${label}${arrow}</th>`;
    };

    return `
    <div class="bp-page">
      <div class="bp-session-header">
        <button class="bp-back-btn" id="bp-back-to-config">← Назад</button>
        <div class="bp-session-title">${esc(sm.setupName || 'Бэктест')}</div>
        <div class="bp-session-meta">${esc(sm.startedAt ? new Date(sm.startedAt).toLocaleString('ru') : '')}</div>
        <div class="bp-session-open-all">
          <button class="bp-btn bp-btn-ghost bp-btn-sm" id="bp-open-history">📁 Все сессии</button>
        </div>
      </div>

      <!-- Summary cards -->
      <div class="bp-session-summary">
        ${sumCard('Запусков', sm.totalRuns, '')}
        ${sumCard('Успешно', sm.doneRuns, 'bp-pos')}
        ${sumCard('Ошибок', sm.errorRuns || 0, sm.errorRuns ? 'bp-neg' : '')}
        ${sumCard('Всего сделок', sumTrades, '')}
        ${sumCard('Средний P&L', avgPnl != null ? fmtPnl(avgPnl) : '—', avgPnl >= 0 ? 'bp-pos' : 'bp-neg')}
      </div>

      <!-- Filters -->
      <div class="bp-session-filters">
        <input class="bp-input bp-filter-search" id="bp-sf-search" type="text"
          placeholder="Поиск..." value="${esc(f.search)}">

        <select class="bp-select" id="bp-sf-inst">
          <option value="">Все инструменты</option>
          ${uniqueInsts.map(i => `<option value="${esc(i)}" ${f.instrument===i?'selected':''}>${esc(i)}</option>`).join('')}
        </select>
        <select class="bp-select" id="bp-sf-ival">
          <option value="">Все таймфреймы</option>
          ${uniqueIvals.map(i => `<option value="${esc(i)}" ${f.interval===i?'selected':''}>${esc(i)}</option>`).join('')}
        </select>

        <div class="bp-filter-range-group">
          <span class="bp-label">Сделок:</span>
          <input class="bp-input bp-input-sm" id="bp-sf-min-trades" type="number" placeholder="от" value="${esc(f.minTrades)}">
          <input class="bp-input bp-input-sm" id="bp-sf-max-trades" type="number" placeholder="до" value="${esc(f.maxTrades)}">
        </div>
        <div class="bp-filter-range-group">
          <span class="bp-label">Win%:</span>
          <input class="bp-input bp-input-sm" id="bp-sf-min-wr" type="number" placeholder="от" value="${esc(f.minWinRate)}">
          <input class="bp-input bp-input-sm" id="bp-sf-max-wr" type="number" placeholder="до" value="${esc(f.maxWinRate)}">
        </div>
        <div class="bp-filter-range-group">
          <span class="bp-label">P&L:</span>
          <input class="bp-input bp-input-sm" id="bp-sf-min-pnl" type="number" placeholder="от" value="${esc(f.minPnl)}">
          <input class="bp-input bp-input-sm" id="bp-sf-max-pnl" type="number" placeholder="до" value="${esc(f.maxPnl)}">
        </div>

        <button class="bp-btn bp-btn-ghost bp-btn-sm" id="bp-sf-reset">Сбросить</button>
      </div>

      <!-- Table -->
      <div class="bp-session-table-wrap">
        <table class="bp-session-tbl">
          <thead>
            <tr>
              <th class="bp-th">Инструмент</th>
              <th class="bp-th">Таймфрейм</th>
              <th class="bp-th">Параметры</th>
              ${thSort('Сделок','trades')}
              ${thSort('Win%','winRate')}
              ${thSort('P&L','pnl')}
              ${thSort('P.Factor','pf')}
              ${thSort('Просадка','dd')}
              <th class="bp-th">Статус</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length === 0 ? `<tr><td colspan="9" style="text-align:center;padding:32px;color:#9aa0b2">Нет данных по выбранным фильтрам</td></tr>` : ''}
            ${rows.map(r => {
              const s = r.result?.stats || {};
              const trades  = r.result?.trades?.length || 0;
              const winRate = fmtN(s.winRate, 1);
              const pnl     = fmtPnl(s.totalPnl);
              const pf      = fmtN(s.profitFactor, 2);
              const dd      = fmtPct(s.maxDrawdown);
              const paramsStr = Object.entries(r.params || {}).map(([k,v]) => {
                const short = k.split(':').pop();
                return `${short}=${v}`;
              }).join(', ');
              return `<tr class="bp-session-row ${r.status==='error'?'bp-row-error':''}">
                <td class="bp-td"><b>${esc(r.inst?.symbol||'—')}</b></td>
                <td class="bp-td">${esc(r.ival?.name||'—')}</td>
                <td class="bp-td"><span class="bp-params-cell">${esc(paramsStr||'—')}</span></td>
                <td class="bp-td bp-num">${trades}</td>
                <td class="bp-td bp-num ${parseFloat(s.winRate||0)>=50?'bp-pos':'bp-neg'}">${winRate}%</td>
                <td class="bp-td bp-num ${parseFloat(s.totalPnl||0)>=0?'bp-pos':'bp-neg'}">${pnl}</td>
                <td class="bp-td bp-num ${parseFloat(s.profitFactor||0)>=1?'bp-pos':'bp-neg'}">${pf}</td>
                <td class="bp-td bp-num bp-neg">${dd}</td>
                <td class="bp-td">${r.status==='done'?'<span class="bp-status-ok">✓</span>':r.status==='error'?'<span class="bp-status-err" title="'+esc(r.error||'')+'">✕</span>':'<span class="bp-status-pend">—</span>'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      ${pages > 1 ? `
      <div class="bp-pagination">
        <button class="bp-btn bp-btn-ghost bp-btn-sm" id="bp-page-prev" ${page===0?'disabled':''}>← Пред.</button>
        <span class="bp-page-info">${page+1} / ${pages} (${total} записей)</span>
        <button class="bp-btn bp-btn-ghost bp-btn-sm" id="bp-page-next" ${page>=pages-1?'disabled':''}>След. →</button>
      </div>` : `
      <div class="bp-pagination">
        <span class="bp-page-info">${total} записей</span>
      </div>`}
    </div>`;
  }

  function sumCard(label, value, cls) {
    return `<div class="bp-sum-card"><div class="bp-sum-label">${esc(label)}</div><div class="bp-sum-value ${esc(cls)}">${esc(String(value ?? '—'))}</div></div>`;
  }

  // ─────────────────────────────────────────────
  // HISTORY
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
          const sm = s._meta?.session_summary || {};
          const runs = s._meta?.runs || [];
          const done = runs.filter(r => r.status === 'done').length;
          const totalPnl = runs.reduce((acc, r) => acc + parseFloat(r.stats?.totalPnl || 0), 0);
          return `<div class="bp-hist-card" data-sid="${s.id}">
            <div class="bp-hist-left">
              <div class="bp-hist-name">${esc(sm.name || s.display_name)}</div>
              <div class="bp-hist-meta">
                <span>${esc(sm.setupName || '—')}</span>
                <span>${esc(sm.startedAt ? new Date(sm.startedAt).toLocaleString('ru') : '')}</span>
              </div>
            </div>
            <div class="bp-hist-stats">
              ${sumCard('Запусков', sm.totalRuns || runs.length, '')}
              ${sumCard('Успешно', done, 'bp-pos')}
              ${sumCard('P&L', fmtPnl(totalPnl), totalPnl >= 0 ? 'bp-pos' : 'bp-neg')}
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

  // ════════════════════════════════════════════════════════════════
  // EVENTS
  // ════════════════════════════════════════════════════════════════

  function bindEvents() {
    const root = getRoot(); if (!root) return;
    const cfg  = BP.cfg;

    // Header nav
    root.querySelector('#bp-open-history')?.addEventListener('click', () => { BP.view = 'history'; renderPage(); });
    root.querySelector('#bp-back-to-config')?.addEventListener('click', () => { BP.view = 'configure'; renderPage(); });
    root.querySelector('#bp-cancel-run')?.addEventListener('click', () => { BP.view = 'configure'; renderPage(); });

    if (BP.view === 'configure') bindConfigureEvents(root, cfg);
    if (BP.view === 'session')   bindSessionEvents(root);
    if (BP.view === 'history')   bindHistoryEvents(root);
  }

  function bindConfigureEvents(root, cfg) {
    // Setup
    root.querySelector('#bp-setup-sel')?.addEventListener('change', e => {
      const id = +e.target.value || null;
      cfg.setupId   = id;
      cfg.setupName = BP.setups.find(s => s.id === id)?.display_name || '';
      cfg.setupMeta = BP.setups.find(s => s.id === id)?._meta || null;
      cfg.paramMatrix = {};
      renderPage();
    });

    // Instruments
    root.querySelector('#bp-inst-all')?.addEventListener('click', () => {
      cfg.selectedInstruments = BP.instruments.map(i => ({ id: i.id, symbol: i.symbol, clickhouse_ticker: i.clickhouse_ticker }));
      root.querySelectorAll('.bp-inst-cb').forEach(cb => cb.checked = true);
      updateRunSummary(root, cfg);
    });
    root.querySelector('#bp-inst-none')?.addEventListener('click', () => {
      cfg.selectedInstruments = [];
      root.querySelectorAll('.bp-inst-cb').forEach(cb => cb.checked = false);
      updateRunSummary(root, cfg);
    });
    root.querySelectorAll('.bp-inst-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const id  = +cb.dataset.id;
        const sym = cb.dataset.symbol;
        const tk  = cb.dataset.ticker;
        if (cb.checked) {
          if (!cfg.selectedInstruments.some(s => s.id === id))
            cfg.selectedInstruments.push({ id, symbol: sym, clickhouse_ticker: tk });
        } else {
          cfg.selectedInstruments = cfg.selectedInstruments.filter(s => s.id !== id);
        }
        cb.closest('.bp-multi-item')?.classList.toggle('bp-multi-item-on', cb.checked);
        updateRunSummary(root, cfg);
      });
    });

    // Intervals
    root.querySelector('#bp-ival-all')?.addEventListener('click', () => {
      cfg.selectedIntervals = BP.intervals.map(i => ({ id: i.id, code: i.code, name: i.name, clickhouse_table: i.clickhouse_table }));
      root.querySelectorAll('.bp-ival-cb').forEach(cb => cb.checked = true);
      updateRunSummary(root, cfg);
    });
    root.querySelector('#bp-ival-none')?.addEventListener('click', () => {
      cfg.selectedIntervals = [];
      root.querySelectorAll('.bp-ival-cb').forEach(cb => cb.checked = false);
      updateRunSummary(root, cfg);
    });
    root.querySelectorAll('.bp-ival-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const id    = +cb.dataset.id;
        const code  = cb.dataset.code;
        const name  = cb.dataset.name;
        const table = cb.dataset.table;
        if (cb.checked) {
          if (!cfg.selectedIntervals.some(s => s.id === id))
            cfg.selectedIntervals.push({ id, code, name, clickhouse_table: table });
        } else {
          cfg.selectedIntervals = cfg.selectedIntervals.filter(s => s.id !== id);
        }
        cb.closest('.bp-multi-item')?.classList.toggle('bp-multi-item-on', cb.checked);
        updateRunSummary(root, cfg);
      });
    });

    // Period
    root.querySelector('#bp-period-sel')?.addEventListener('change', e => {
      cfg.periodMode = e.target.value; renderPage();
    });
    root.querySelector('#bp-insample-pct')?.addEventListener('input', e => { cfg.inSamplePct = +e.target.value; });
    root.querySelector('#bp-from-date')?.addEventListener('change', e => { cfg.fromDate = e.target.value; });
    root.querySelector('#bp-to-date')?.addEventListener('change', e => { cfg.toDate = e.target.value; });
    root.querySelector('#bp-commission')?.addEventListener('input', e => { cfg.commission = parseFloat(e.target.value) || 0; });

    // Param matrix inputs
    root.querySelectorAll('.bp-matrix-inp').forEach(inp => {
      inp.addEventListener('input', () => {
        const key  = inp.dataset.matrixKey;
        const vals = inp.value.split(',').map(v => v.trim()).filter(Boolean);
        cfg.paramMatrix[key] = vals.length ? vals : [];
        updateRunSummary(root, cfg);
      });
    });

    // Filters
    root.querySelector('#bp-entry-filter')?.addEventListener('input', e => { cfg.entryFilter = e.target.value; });
    root.querySelector('#bp-exit-filter')?.addEventListener('input', e => { cfg.exitFilter = e.target.value; });

    // Run
    root.querySelector('#bp-run-btn')?.addEventListener('click', () => runSession());
  }

  function updateRunSummary(root, cfg) {
    const runs    = buildRuns(cfg);
    const btn     = root.querySelector('#bp-run-btn');
    const sumEl   = root.querySelector('.bp-run-summary');
    const setup   = BP.setups.find(s => s.id === cfg.setupId);
    if (btn) btn.disabled = !setup || !runs.length;
    if (sumEl) {
      sumEl.innerHTML = runs.length
        ? `<span class="bp-run-count">${runs.length}</span> запусков · ${cfg.selectedInstruments.length} инструм. × ${cfg.selectedIntervals.length} таймфр.${Object.keys(cfg.paramMatrix).filter(k=>cfg.paramMatrix[k]?.length).length ? ' × параметры' : ''}`
        : '<span class="bp-run-count-zero">0</span> — выберите инструменты и таймфреймы';
    }
  }

  function bindSessionEvents(root) {
    const f = BP.sessionFilter;

    const applyFilter = () => { BP.sessionPage = 0; renderPage(); };

    root.querySelector('#bp-sf-search')?.addEventListener('input', e => { f.search = e.target.value; applyFilter(); });
    root.querySelector('#bp-sf-inst')?.addEventListener('change', e => { f.instrument = e.target.value; applyFilter(); });
    root.querySelector('#bp-sf-ival')?.addEventListener('change', e => { f.interval = e.target.value; applyFilter(); });
    root.querySelector('#bp-sf-min-trades')?.addEventListener('input', e => { f.minTrades = e.target.value; applyFilter(); });
    root.querySelector('#bp-sf-max-trades')?.addEventListener('input', e => { f.maxTrades = e.target.value; applyFilter(); });
    root.querySelector('#bp-sf-min-wr')?.addEventListener('input', e => { f.minWinRate = e.target.value; applyFilter(); });
    root.querySelector('#bp-sf-max-wr')?.addEventListener('input', e => { f.maxWinRate = e.target.value; applyFilter(); });
    root.querySelector('#bp-sf-min-pnl')?.addEventListener('input', e => { f.minPnl = e.target.value; applyFilter(); });
    root.querySelector('#bp-sf-max-pnl')?.addEventListener('input', e => { f.maxPnl = e.target.value; applyFilter(); });
    root.querySelector('#bp-sf-reset')?.addEventListener('click', () => { BP.sessionFilter = defaultSessionFilter(); renderPage(); });

    // Sort header
    root.querySelectorAll('.bp-th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const field = th.dataset.sort;
        if (f.sortField === field) f.sortDir = f.sortDir === 'desc' ? 'asc' : 'desc';
        else { f.sortField = field; f.sortDir = 'desc'; }
        BP.sessionPage = 0;
        renderPage();
      });
    });

    // Pagination
    root.querySelector('#bp-page-prev')?.addEventListener('click', () => { BP.sessionPage = Math.max(0, BP.sessionPage - 1); renderPage(); });
    root.querySelector('#bp-page-next')?.addEventListener('click', () => { BP.sessionPage++; renderPage(); });
  }

  function bindHistoryEvents(root) {
    root.querySelectorAll('.bp-hist-open').forEach(btn => {
      btn.addEventListener('click', () => {
        const sid = +btn.dataset.sid;
        const s   = BP.strategies.find(x => x.id === sid);
        if (!s) return;
        const meta = s._meta || {};
        const sm   = meta.session_summary || {};
        const runs = (meta.runs || []).map(r => ({
          inst:   { symbol: r.instrument, clickhouse_ticker: r.ticker },
          ival:   { name: r.interval, clickhouse_table: r.table },
          params: r.params || {},
          status: r.status || 'done',
          error:  r.error  || null,
          result: r.stats ? { stats: r.stats, trades: Array(r.trades || 0) } : null,
        }));
        BP.session = {
          id:         s.id,
          name:       sm.name || s.display_name,
          setupId:    sm.setupId,
          setupName:  sm.setupName || '—',
          runs,
          totalRuns:  sm.totalRuns || runs.length,
          doneRuns:   sm.doneRuns  || runs.filter(r=>r.status==='done').length,
          errorRuns:  sm.errorRuns || 0,
          startedAt:  sm.startedAt || s.created_at,
        };
        BP.sessionFilter = defaultSessionFilter();
        BP.sessionPage   = 0;
        BP.view = 'session';
        renderPage();
      });
    });

    root.querySelectorAll('.bp-hist-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Удалить сессию?')) return;
        try {
          await apiFetch(`/api/javascript-scripts/${btn.dataset.sid}`, { method: 'DELETE' });
          await loadAll();
        } catch (e) { alert('Ошибка: ' + e.message); }
      });
    });
  }

  // ════════════════════════════════════════════════════════════════
  // CSS
  // ════════════════════════════════════════════════════════════════

  function injectCSS() {
    if (document.getElementById('bp-styles')) return;
    const s = document.createElement('style'); s.id = 'bp-styles';
    s.textContent = `
/* ── Base ─── */
#backtest-page-root{height:100%;overflow:auto;background:var(--bp-bg,#f8f9fc);font-family:-apple-system,'Segoe UI',sans-serif}
.bp-page{max-width:1100px;margin:0 auto;padding:32px 24px}
.bp-page-header{display:flex;align-items:center;gap:16px;margin-bottom:28px}
.bp-title{font-size:26px;font-weight:700;color:var(--bp-text,#1a1d2e);margin:0;letter-spacing:-.5px;flex:1}
.bp-header-actions{display:flex;gap:8px}
.bp-loading-full{display:flex;align-items:center;justify-content:center;height:200px;color:#9aa0b2;font-size:15px}

/* Card */
.bp-configure{display:flex;flex-direction:column;gap:16px}
.bp-card{background:var(--bp-card,#fff);border:1.5px solid var(--bp-border,#e2e6f0);border-radius:14px;padding:22px 24px}
.bp-card-section-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;color:var(--bp-text,#1a1d2e);margin-bottom:16px;display:flex;align-items:center;gap:10px}
.bp-section-hint{font-size:11px;font-weight:400;text-transform:none;letter-spacing:0;color:#9aa0b2}

/* Fields */
.bp-field{display:flex;flex-direction:column;gap:5px}
.bp-label{font-size:12px;font-weight:500;color:#6b7280}
.bp-input{padding:9px 12px;border:1.5px solid var(--bp-border,#e2e6f0);border-radius:8px;font-size:14px;color:var(--bp-text,#1a1d2e);background:var(--bp-input,#f8f9fc);outline:none;transition:border-color .15s;box-sizing:border-box;width:100%}
.bp-input:focus{border-color:#4f6df5;background:var(--bp-card,#fff)}
.bp-input-sm{padding:5px 8px;font-size:12px;width:70px}
.bp-select{padding:9px 12px;border:1.5px solid var(--bp-border,#e2e6f0);border-radius:8px;font-size:14px;color:var(--bp-text,#1a1d2e);background:var(--bp-card,#fff);cursor:pointer;outline:none;width:100%}
.bp-select-lg{max-width:400px}
.bp-params-grid-4{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}

/* Buttons */
.bp-btn{padding:8px 18px;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:all .15s}
.bp-btn-ghost{background:transparent;color:#6b7280;border:1.5px solid var(--bp-border,#e2e6f0)}.bp-btn-ghost:hover{background:#f0f4ff;color:#4f6df5;border-color:#4f6df5}
.bp-btn-ghost:disabled{opacity:.4;cursor:default}
.bp-btn-sm{padding:5px 12px;font-size:12px}
.bp-btn-run{padding:12px 36px;background:#1a1d2e;color:#fff;font-size:15px;font-weight:700;border-radius:10px;border:none;cursor:pointer;transition:all .15s}
.bp-btn-run:hover{background:#2d3250}
.bp-btn-run:disabled{opacity:.4;cursor:default}
.bp-back-btn{background:none;border:none;font-size:14px;color:#4f6df5;cursor:pointer;padding:6px 10px;border-radius:7px;font-weight:500;flex-shrink:0}
.bp-back-btn:hover{background:#f0f4ff}
.bp-link-btn{background:none;border:none;font-size:11px;color:#4f6df5;cursor:pointer;padding:0;text-decoration:underline}

/* Criteria grid */
.bp-criteria-grid{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:18px}
.bp-crit-card{background:var(--bp-input,#f8f9fc);border:1.5px solid var(--bp-border,#e2e6f0);border-radius:10px;padding:14px;flex:1;min-width:220px;max-width:340px}
.bp-crit-card-name{font-size:13px;font-weight:600;color:var(--bp-text,#1a1d2e);margin-bottom:10px}
.bp-crit-param{margin-bottom:8px}
.bp-param-row{display:flex;align-items:center;gap:6px;margin-top:4px}
.bp-param-sep{color:#9aa0b2;font-size:16px}
.bp-hint-empty{color:#9aa0b2;font-style:italic;font-size:13px;padding:12px 0}

/* Expressions */
.bp-expr-block{margin-top:14px}
.bp-expr-label{font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.3px;margin-bottom:6px;display:flex;align-items:center;gap:8px}
.bp-expr-ro{background:var(--bp-input,#f8f9fc);border:1px solid var(--bp-border,#e2e6f0);border-radius:8px;padding:8px 12px;font-family:monospace;font-size:12px;color:#9aa0b2;margin:0;white-space:pre-wrap;word-break:break-all}
.bp-expr-ta{width:100%;padding:8px 10px;border:1.5px solid var(--bp-border,#e2e6f0);border-radius:8px;font-size:12px;font-family:'Consolas',monospace;color:var(--bp-text,#1a1d2e);background:var(--bp-input,#f8f9fc);outline:none;resize:vertical;box-sizing:border-box}
.bp-expr-ta:focus{border-color:#4f6df5;background:var(--bp-card,#fff)}

/* Multi select */
.bp-two-cols{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.bp-multi-col{display:flex;flex-direction:column;gap:8px}
.bp-multi-header{display:flex;align-items:center;gap:8px}
.bp-multi-list{border:1.5px solid var(--bp-border,#e2e6f0);border-radius:10px;overflow-y:auto;max-height:240px;display:flex;flex-direction:column}
.bp-multi-item{display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer;border-bottom:1px solid var(--bp-border,#e2e6f0);transition:background .12s;user-select:none}
.bp-multi-item:last-child{border-bottom:none}
.bp-multi-item:hover{background:#f0f4ff}
.bp-multi-item-on{background:color-mix(in srgb,#4f6df5 8%,transparent)}
.bp-multi-item input{width:15px;height:15px;accent-color:#4f6df5;flex-shrink:0}
.bp-multi-label{font-size:13px;font-weight:600;color:var(--bp-text,#1a1d2e);flex:1}
.bp-multi-sub{font-size:11px;color:#9aa0b2}

/* Run footer */
.bp-run-footer{display:flex;align-items:center;justify-content:space-between;padding:16px 24px;background:var(--bp-card,#fff);border:1.5px solid var(--bp-border,#e2e6f0);border-radius:14px}
.bp-run-summary{font-size:14px;color:#6b7280}
.bp-run-count{font-size:20px;font-weight:700;color:#4f6df5}
.bp-run-count-zero{font-size:20px;font-weight:700;color:#d1d5db}

/* Running */
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

/* Session */
.bp-session-header{display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap}
.bp-session-title{font-size:20px;font-weight:700;color:var(--bp-text,#1a1d2e);flex:1}
.bp-session-meta{font-size:12px;color:#9aa0b2}
.bp-session-open-all{margin-left:auto}
.bp-session-summary{display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap}
.bp-sum-card{background:var(--bp-card,#fff);border:1.5px solid var(--bp-border,#e2e6f0);border-radius:10px;padding:14px 20px;text-align:center;min-width:110px}
.bp-sum-label{font-size:10px;text-transform:uppercase;letter-spacing:.3px;color:#9aa0b2;margin-bottom:4px}
.bp-sum-value{font-size:20px;font-weight:700;color:var(--bp-text,#1a1d2e)}
.bp-pos{color:#22c55e!important}.bp-neg{color:#ef4444!important}

/* Session filters */
.bp-session-filters{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:16px;padding:16px 20px;background:var(--bp-card,#fff);border:1.5px solid var(--bp-border,#e2e6f0);border-radius:12px}
.bp-filter-search{flex:1;min-width:150px;max-width:220px}
.bp-filter-range-group{display:flex;align-items:center;gap:6px}

/* Session table */
.bp-session-table-wrap{overflow-x:auto;background:var(--bp-card,#fff);border:1.5px solid var(--bp-border,#e2e6f0);border-radius:12px}
.bp-session-tbl{width:100%;border-collapse:collapse}
.bp-th{padding:10px 14px;background:var(--bp-input,#f8f9fc);color:#9aa0b2;font-size:10px;text-transform:uppercase;letter-spacing:.3px;text-align:left;border-bottom:1.5px solid var(--bp-border,#e2e6f0);white-space:nowrap}
.bp-th-active{color:#4f6df5;background:#f0f4ff}
.bp-td{padding:10px 14px;font-size:12px;color:#6b7280;border-bottom:1px solid var(--bp-border,#e2e6f0)}
.bp-session-row:hover .bp-td{background:#f8f9fc}
.bp-row-error .bp-td{opacity:.6}
.bp-num{text-align:right;font-variant-numeric:tabular-nums;font-family:'Consolas',monospace}
.bp-params-cell{font-family:monospace;font-size:11px;color:#9aa0b2}
.bp-status-ok{color:#22c55e;font-size:14px}
.bp-status-err{color:#ef4444;font-size:14px;cursor:help}
.bp-status-pend{color:#d1d5db}

/* Pagination */
.bp-pagination{display:flex;align-items:center;justify-content:center;gap:16px;padding:16px;background:var(--bp-card,#fff);border:1.5px solid var(--bp-border,#e2e6f0);border-top:none;border-radius:0 0 12px 12px}
.bp-page-info{font-size:12px;color:#9aa0b2}

/* History */
.bp-history-list{display:flex;flex-direction:column;gap:10px}
.bp-hist-card{background:var(--bp-card,#fff);border:1.5px solid var(--bp-border,#e2e6f0);border-radius:14px;padding:18px 22px;display:flex;align-items:center;gap:20px;transition:border-color .15s}
.bp-hist-card:hover{border-color:#4f6df5}
.bp-hist-left{flex:1;min-width:0}
.bp-hist-name{font-size:15px;font-weight:600;color:var(--bp-text,#1a1d2e);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bp-hist-meta{display:flex;gap:12px;font-size:12px;color:#9aa0b2}
.bp-hist-stats{display:flex;gap:10px}
.bp-hist-actions{display:flex;gap:8px;flex-shrink:0}

/* Dark */
body.dark-theme{--bp-bg:#060810;--bp-card:#0c0e1a;--bp-border:#1a1e34;--bp-text:#d1d4dc;--bp-input:#080a14}
body.dark-theme .bp-card,body.dark-theme .bp-run-footer,body.dark-theme .bp-session-filters,body.dark-theme .bp-session-table-wrap,body.dark-theme .bp-pagination,body.dark-theme .bp-sum-card,body.dark-theme .bp-hist-card,body.dark-theme .bp-running-box{background:#0c0e1a;border-color:#1a1e34}
body.dark-theme .bp-input,body.dark-theme .bp-select{background:#080a14;border-color:#1a1e34;color:#d1d4dc}
body.dark-theme .bp-input:focus{background:#0c0e1a}
body.dark-theme .bp-crit-card{background:#080a14;border-color:#1a1e34}
body.dark-theme .bp-multi-list{border-color:#1a1e34}
body.dark-theme .bp-multi-item{border-color:#1a1e34}
body.dark-theme .bp-multi-item:hover{background:#141826}
body.dark-theme .bp-multi-item-on{background:color-mix(in srgb,#4f6df5 15%,transparent)}
body.dark-theme .bp-multi-label{color:#d1d4dc}
body.dark-theme .bp-th{background:#080a14;border-color:#1a1e34}
body.dark-theme .bp-th-active{background:#0a1230;color:#4f9df5}
body.dark-theme .bp-td{border-color:#1a1e34;color:#8a90a8}
body.dark-theme .bp-session-row:hover .bp-td{background:#0d0f1e}
body.dark-theme .bp-expr-ro{background:#080a14;border-color:#1a1e34}
body.dark-theme .bp-expr-ta{background:#080a14;border-color:#1a1e34;color:#d1d4dc}
body.dark-theme .bp-expr-ta:focus{background:#0c0e1a;border-color:#4f6df5}
body.dark-theme .bp-running-progress-bar{background:#1a1e34}
body.dark-theme .bp-sum-value{color:#d1d4dc}
body.dark-theme .bp-session-title,body.dark-theme .bp-title{color:#d1d4dc}
body.dark-theme .bp-hist-name{color:#d1d4dc}
    `;
    document.head.appendChild(s);
  }

  // ════════════════════════════════════════════════════════════════
  // INIT
  // ════════════════════════════════════════════════════════════════

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
      BP.view = 'configure';
      renderPage();
    },
  };

})();