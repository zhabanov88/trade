/**
 * backtest-page.js  v3.0
 *
 * Страница настройки и запуска бэктеста.
 *
 * Источники данных:
 *   GET /api/instruments  → instruments (symbol, name, clickhouse_ticker, is_active)
 *   GET /api/intervals    → time_intervals (code, name, clickhouse_table, is_active)
 *   GET /api/javascript-scripts → сетапы (type_code='setup')
 *   POST /api/backtest/run → запуск бэктеста
 *
 * Ключевые поля:
 *   instrument.clickhouse_ticker → передаётся как ticker в /api/backtest/run
 *   interval.clickhouse_table    → передаётся как table  в /api/backtest/run
 *
 * Результат сохраняется как javascript_scripts с type_code='strategy'.
 */

(function () {
    'use strict';
  
    // ═══════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════
  
    const BP = {
      setups:      [],   // javascript_scripts WHERE type_code='setup'
      strategies:  [],   // javascript_scripts WHERE type_code='strategy'
      instruments: [],   // из /api/instruments — { id, symbol, name, clickhouse_ticker, type }
      intervals:   [],   // из /api/intervals  — { id, code, name, clickhouse_table, tradingview_code }
      strategyTypeId: null,
  
      cfg: defaultCfg(),
  
      tab:         'configure',  // 'configure' | 'results' | 'history'
      running:     false,
      progress:    0,
      progressMsg: '',
      results:     null,
      error:       null,
      histSearch:  '',
    };
  
    function defaultCfg() {
      return {
        setupId:   null,
        setupName: '',
  
        // instrument
        instrumentId:       null,
        instrumentSymbol:   '',
        instrumentName:     '',
        clickhouseTicker:   '',   // ← реальный тикер в ClickHouse
  
        // interval
        intervalId:         null,
        intervalCode:       '',
        clickhouseTable:    '',   // ← реальная таблица в ClickHouse
  
        // period
        period:     'all',
        fromDate:   '',
        toDate:     '',
  
        commission: 0.1,
        capital:    10000,
        riskPct:    1,
        leverage:   1,
        direction:  'long',
        slMode:     'pct',
        slValue:    1,
        tpMode:     'rr',
        tpValue:    2,
        maxBars:    50,
  
        extraEntryConditions: [],
        extraExitConditions:  [],
        paramOverrides:       {},
      };
    }
  
    // ═══════════════════════════════════════════════════════
    // API
    // ═══════════════════════════════════════════════════════
  
    async function apiFetch(url, opts = {}) {
      const r = await fetch(url, { credentials: 'include', ...opts });
      if (!r.ok) {
        const e = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(e.error || r.statusText);
      }
      return r.json();
    }
  
    async function loadAll() {
      const [scriptTypes, scripts, instruments, intervals] = await Promise.allSettled([
        apiFetch('/api/script-types'),
        apiFetch('/api/javascript-scripts'),
        apiFetch('/api/instruments'),
        apiFetch('/api/intervals'),
      ]);
  
      // strategy type_id
      if (scriptTypes.status === 'fulfilled') {
        const t = scriptTypes.value.find(x => x.code === 'strategy');
        BP.strategyTypeId = t?.id ?? null;
      }
  
      // setups + strategies
      if (scripts.status === 'fulfilled') {
        BP.setups     = scripts.value.filter(s => s.type_code === 'setup');
        BP.strategies = scripts.value
          .filter(s => s.type_code === 'strategy')
          .map(s => ({ ...s, _code: parseSafe(s.code), _meta: parseSafe(s.meta) }));
      }
  
      // instruments — только активные, у которых есть clickhouse_ticker
      if (instruments.status === 'fulfilled') {
        BP.instruments = instruments.value.filter(i => i.is_active && i.clickhouse_ticker);
      }
  
      // intervals — только активные, у которых есть clickhouse_table
      if (intervals.status === 'fulfilled') {
        BP.intervals = intervals.value.filter(i => i.is_active && i.clickhouse_table);
      }
  
      renderPage();
    }
  
    async function loadStrategies() {
      try {
        const all = await apiFetch('/api/javascript-scripts');
        BP.strategies = all
          .filter(s => s.type_code === 'strategy')
          .map(s => ({ ...s, _code: parseSafe(s.code), _meta: parseSafe(s.meta) }));
      } catch (_) {}
    }
  
    function parseSafe(raw) {
      if (!raw) return {};
      if (typeof raw === 'object') return raw;
      try { return JSON.parse(raw); } catch (_) { return {}; }
    }
  
    async function saveStrategy(cfg, stats) {
      if (!BP.strategyTypeId) return;
  
      const code = JSON.stringify({
        setupId:              cfg.setupId,
        setupName:            cfg.setupName,
        instrumentId:         cfg.instrumentId,
        instrumentSymbol:     cfg.instrumentSymbol,
        clickhouseTicker:     cfg.clickhouseTicker,
        intervalId:           cfg.intervalId,
        intervalCode:         cfg.intervalCode,
        clickhouseTable:      cfg.clickhouseTable,
        period:               cfg.period,
        fromDate:             cfg.fromDate,
        toDate:               cfg.toDate,
        commission:           cfg.commission,
        capital:              cfg.capital,
        riskPct:              cfg.riskPct,
        leverage:             cfg.leverage,
        direction:            cfg.direction,
        slMode:               cfg.slMode,
        slValue:              cfg.slValue,
        tpMode:               cfg.tpMode,
        tpValue:              cfg.tpValue,
        maxBars:              cfg.maxBars,
        extraEntryConditions: cfg.extraEntryConditions,
        extraExitConditions:  cfg.extraExitConditions,
        paramOverrides:       cfg.paramOverrides,
      });
  
      const name = [
        cfg.setupName || 'Setup',
        cfg.instrumentSymbol || cfg.clickhouseTicker || '—',
        cfg.intervalCode || '—',
        new Date().toLocaleDateString('ru'),
      ].join(' · ');
  
      return apiFetch('/api/javascript-scripts', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          display_name:  name,
          system_name:   'strategy_' + Date.now(),
          type_id:       BP.strategyTypeId,
          code,
          meta:          { backtest_stats: stats || null },
          is_public:     false,
          is_overlay:    false,
          inputs_schema: [],
        }),
      });
    }
  
    async function runBacktest() {
      const cfg = BP.cfg;
  
      if (!cfg.setupId)         { alert('Выберите сетап');              return; }
      if (!cfg.clickhouseTicker){ alert('Выберите торговый инструмент');return; }
      if (!cfg.clickhouseTable) { alert('Выберите таймфрейм');          return; }
  
      BP.running     = true;
      BP.error       = null;
      BP.results     = null;
      BP.progress    = 5;
      BP.progressMsg = '⚙ Подготовка...';
      BP.tab         = 'results';
      renderPage();
  
      try {
        const setup = BP.setups.find(s => s.id === cfg.setupId);
        if (!setup) throw new Error('Сетап не найден');
  
        const setupMeta = parseSafe(setup.meta);
  
        // Собираем setupCols из entry_indicators сетапа
        const setupCols = buildSetupCols(setup, setupMeta, cfg);
  
        const body = {
          ticker:    cfg.clickhouseTicker,
          table:     cfg.clickhouseTable,
          fromDate:  cfg.fromDate  || undefined,
          toDate:    cfg.toDate    || undefined,
          capital:   cfg.capital,
          riskPct:   cfg.riskPct,
          leverage:  cfg.leverage,
          slMode:    cfg.slMode,
          slValue:   cfg.slValue,
          tpMode:    cfg.tpMode,
          tpValue:   cfg.tpValue,
          maxBars:   cfg.maxBars,
          direction: cfg.direction,
          setupCols,
          extraEntryConditions: cfg.extraEntryConditions,
          extraExitConditions:  cfg.extraExitConditions,
        };
  
        BP.progressMsg = `⏳ Запуск: ${cfg.clickhouseTicker} @ ${cfg.clickhouseTable}...`;
        renderPage();
  
        const data = await apiFetch('/api/backtest/run', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
        });
  
        BP.results     = data;
        BP.progress    = 100;
        BP.progressMsg = `✅ Завершено: ${(data.trades || []).length} сделок`;
  
        // Автосохранение стратегии
        try { await saveStrategy(cfg, data.stats); } catch (_) {}
        await loadStrategies();
  
      } catch (e) {
        BP.error = e.message;
      } finally {
        BP.running = false;
        renderPage();
      }
    }
  
    function buildSetupCols(setup, meta, cfg) {
      const entryInds = meta.entry_indicators || [];
      const cols = {};
  
      entryInds.forEach((ind, i) => {
        const colName = `setup_${setup.system_name}_${i}`;
        const params  = { ...(ind.params || {}) };
  
        // Применяем переопределения параметров
        Object.entries(ind.paramBindings || {}).forEach(([inpId, paramId]) => {
          if (cfg.paramOverrides[paramId] !== undefined) {
            params[inpId] = cfg.paramOverrides[paramId];
          }
        });
  
        cols[colName] = {
          scriptId:   ind.scriptId,
          scriptName: ind.scriptName,
          dir:        cfg.direction,
          params,
        };
      });
  
      // Если индикаторов нет — используем сам сетап как скрипт
      if (!Object.keys(cols).length && setup.id) {
        cols[setup.system_name] = {
          scriptId:   setup.id,
          dir:        cfg.direction,
        };
      }
  
      return cols;
    }
  
    // ═══════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════
  
    function esc(s) {
      return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
  
    function getRoot() { return document.getElementById('backtest-page-root'); }
  
    function fmtUsd(v) {
      if (v == null) return '—';
      const n = parseFloat(v);
      return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2);
    }
  
    function fmtPct(v) {
      if (v == null) return '—';
      const n = parseFloat(v);
      return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
    }
  
    // ═══════════════════════════════════════════════════════
    // RENDER
    // ═══════════════════════════════════════════════════════
  
    function renderPage() {
      const root = getRoot();
      if (!root) return;
  
      root.innerHTML = `
        <div class="bp-page">
          <div class="bp-tab-bar">
            ${[
              { id: 'configure', label: '⚙ Настройка'  },
              { id: 'results',   label: '📊 Результаты' },
              { id: 'history',   label: '📁 История'    },
            ].map(t => `
              <button class="bp-tab ${BP.tab === t.id ? 'bp-tab-active' : ''}" data-tab="${t.id}">
                ${t.label}
              </button>`
            ).join('')}
            <div class="bp-tab-spacer"></div>
            <button class="bp-run-btn ${BP.running ? 'bp-run-running' : ''}"
              id="bp-run-btn" ${BP.running ? 'disabled' : ''}>
              ${BP.running
                ? '<span class="bp-spin"></span> Запуск...'
                : '▶ Запустить бэктест'}
            </button>
          </div>
          <div class="bp-content">
            ${BP.tab === 'configure' ? renderConfigure()
            : BP.tab === 'results'   ? renderResults()
            : renderHistory()}
          </div>
        </div>`;
  
      bindEvents();
    }
  
    // ── Configure ────────────────────────────────────────
  
    function renderConfigure() {
      const cfg   = BP.cfg;
      const setup = BP.setups.find(s => s.id === cfg.setupId);
      const paramsSchema = setup ? parseSafe(setup.meta)?.params_schema || [] : [];
  
      return `
        <div class="bp-configure">
  
          <!-- Основные настройки -->
          <div class="bp-card">
            <div class="bp-card-grid bp-card-grid-4">
  
              <div class="bp-field">
                <label class="bp-label">Сетап</label>
                <select class="bp-select" id="bp-setup-sel">
                  <option value="">Выберите сетап</option>
                  ${BP.setups.map(s =>
                    `<option value="${s.id}" ${cfg.setupId===s.id?'selected':''}>${esc(s.display_name)}</option>`
                  ).join('')}
                </select>
              </div>
  
              <div class="bp-field">
                <label class="bp-label">Торговый инструмент</label>
                <select class="bp-select" id="bp-instrument-sel">
                  <option value="">Выберите инструмент</option>
                  ${BP.instruments.length === 0
                    ? '<option disabled>Нет активных инструментов в БД</option>'
                    : BP.instruments.map(i => `
                      <option value="${i.id}"
                        data-ticker="${esc(i.clickhouse_ticker)}"
                        data-symbol="${esc(i.symbol)}"
                        data-name="${esc(i.name)}"
                        ${cfg.instrumentId===i.id?'selected':''}>
                        ${esc(i.symbol)} — ${esc(i.name)}
                      </option>`
                    ).join('')}
                </select>
                ${cfg.clickhouseTicker
                  ? `<div class="bp-field-hint">ClickHouse: <code>${esc(cfg.clickhouseTicker)}</code></div>`
                  : ''}
              </div>
  
              <div class="bp-field">
                <label class="bp-label">Таймфрейм</label>
                <select class="bp-select" id="bp-interval-sel">
                  <option value="">Выберите таймфрейм</option>
                  ${BP.intervals.length === 0
                    ? '<option disabled>Нет активных интервалов в БД</option>'
                    : BP.intervals.map(i => `
                      <option value="${i.id}"
                        data-table="${esc(i.clickhouse_table)}"
                        data-code="${esc(i.code)}"
                        ${cfg.intervalId===i.id?'selected':''}>
                        ${esc(i.name)}
                      </option>`
                    ).join('')}
                </select>
                ${cfg.clickhouseTable
                  ? `<div class="bp-field-hint">Таблица: <code>${esc(cfg.clickhouseTable)}</code></div>`
                  : ''}
              </div>
  
              <div class="bp-field">
                <label class="bp-label">Комиссия (%)</label>
                <input class="bp-input" id="bp-commission" type="number"
                  step="0.01" min="0" value="${cfg.commission}" placeholder="0.1">
              </div>
            </div>
  
            <!-- Период -->
            <div class="bp-period-row">
              <div class="bp-field">
                <label class="bp-label">Период тестирования</label>
                <select class="bp-select" id="bp-period-sel" style="min-width:160px">
                  <option value="all"    ${cfg.period==='all'   ?'selected':''}>Весь доступный</option>
                  <option value="1y"     ${cfg.period==='1y'    ?'selected':''}>1 год</option>
                  <option value="2y"     ${cfg.period==='2y'    ?'selected':''}>2 года</option>
                  <option value="3y"     ${cfg.period==='3y'    ?'selected':''}>3 года</option>
                  <option value="custom" ${cfg.period==='custom'?'selected':''}>Свой период</option>
                </select>
              </div>
              ${cfg.period === 'custom' ? `
                <div class="bp-field">
                  <label class="bp-label">От</label>
                  <input class="bp-input" id="bp-from-date" type="date" value="${esc(cfg.fromDate)}">
                </div>
                <div class="bp-field">
                  <label class="bp-label">До</label>
                  <input class="bp-input" id="bp-to-date"   type="date" value="${esc(cfg.toDate)}">
                </div>
              ` : ''}
            </div>
          </div>
  
          ${setup ? `
          <!-- Параметры сетапа (override) -->
          ${paramsSchema.length ? `
          <div class="bp-card">
            <div class="bp-card-title">
              Параметры сетапа
              <span class="bp-card-hint">Переопределить значения из сетапа «${esc(setup.display_name)}»</span>
            </div>
            <div class="bp-params-grid">
              ${paramsSchema.map(p => `
                <div class="bp-field">
                  <label class="bp-label">${esc(p.name || p.id)}</label>
                  <input class="bp-input bp-param-ov" type="text"
                    data-param-id="${esc(p.id)}"
                    placeholder="По умолчанию: ${esc(String(p.defval ?? ''))}"
                    value="${esc(cfg.paramOverrides[p.id] ?? '')}">
                </div>`
              ).join('')}
            </div>
          </div>` : ''}
  
          <!-- Расширение условий входа -->
          <div class="bp-card">
            <div class="bp-card-title">
              Расширение условий входа
              <span class="bp-card-hint">Дополнительные фильтры поверх сетапа</span>
            </div>
            <div class="bp-cond-list" id="bp-entry-conds">
              ${cfg.extraEntryConditions.map((c, i) => renderCondRow(c, i, 'entry')).join('')}
            </div>
            <button class="bp-btn bp-btn-ghost bp-btn-sm" id="bp-add-entry-cond">＋ Условие входа</button>
          </div>
  
          <!-- Расширение условий выхода -->
          <div class="bp-card">
            <div class="bp-card-title">
              Расширение условий выхода
              <span class="bp-card-hint">Дополнительные правила закрытия позиции</span>
            </div>
            <div class="bp-cond-list" id="bp-exit-conds">
              ${cfg.extraExitConditions.map((c, i) => renderCondRow(c, i, 'exit')).join('')}
            </div>
            <button class="bp-btn bp-btn-ghost bp-btn-sm" id="bp-add-exit-cond">＋ Условие выхода</button>
          </div>
          ` : `
          <div class="bp-empty-card">
            <div class="bp-empty-icon">📋</div>
            <div>Выберите сетап для настройки расширенных параметров</div>
          </div>`}
        </div>`;
    }
  
    function renderCondRow(c, i, type) {
      return `
        <div class="bp-cond-row" data-idx="${i}" data-type="${type}">
          <input class="bp-input bp-cond-field" type="text"
            placeholder="Поле из activedata (напр. rsi_14)"
            data-field="field" data-idx="${i}" data-type="${type}"
            value="${esc(c.field||'')}">
          <select class="bp-select bp-cond-op"
            data-field="op" data-idx="${i}" data-type="${type}">
            ${['>', '<', '>=', '<=', '==', '!=', 'crosses_above', 'crosses_below'].map(op =>
              `<option value="${op}" ${c.op===op?'selected':''}>${op}</option>`
            ).join('')}
          </select>
          <input class="bp-input bp-cond-value" type="text"
            placeholder="Значение или формула"
            data-field="value" data-idx="${i}" data-type="${type}"
            value="${esc(c.value||'')}">
          <button class="bp-cond-del" data-idx="${i}" data-type="${type}">✕</button>
        </div>`;
    }
  
    // ── Results ──────────────────────────────────────────
  
    function renderResults() {
      if (BP.running) return `
        <div class="bp-center-box">
          <div class="bp-big-spin"></div>
          <div class="bp-progress-msg">${esc(BP.progressMsg)}</div>
          <div class="bp-progress-bar">
            <div class="bp-progress-fill" style="width:${BP.progress}%"></div>
          </div>
        </div>`;
  
      if (BP.error) return `
        <div class="bp-center-box">
          <div style="font-size:32px">⚠</div>
          <div class="bp-error-msg">${esc(BP.error)}</div>
          <button class="bp-btn bp-btn-primary" id="bp-retry-btn">Повторить</button>
        </div>`;
  
      if (!BP.results) return `
        <div class="bp-center-box">
          <div style="font-size:40px;opacity:.3">📊</div>
          <div style="color:#9aa0b2">Настройте параметры и нажмите «Запустить бэктест»</div>
        </div>`;
  
      const { trades = [], stats = {} } = BP.results;
      const wins   = trades.filter(t => parseFloat(t.pnl) > 0).length;
      const winPct = trades.length ? (wins / trades.length * 100).toFixed(1) : '0.0';
  
      return `
        <div class="bp-results">
          <div class="bp-stats-grid">
            ${statCard('Сделок',       trades.length,                       '')}
            ${statCard('Прибыльных',   winPct + '%',                        +winPct >= 50 ? 'bp-pos' : 'bp-neg')}
            ${statCard('Итого P&L',    fmtUsd(stats.totalPnl),              parseFloat(stats.totalPnl||0) >= 0 ? 'bp-pos' : 'bp-neg')}
            ${statCard('Profit F',     (+stats.profitFactor||0).toFixed(2), parseFloat(stats.profitFactor||0) >= 1 ? 'bp-pos' : 'bp-neg')}
            ${statCard('Доходность',   fmtPct(stats.return),                (stats.return||'').includes('-') ? 'bp-neg' : 'bp-pos')}
            ${statCard('Макс. просадка', fmtPct(stats.maxDrawdown),         'bp-neg')}
          </div>
  
          <div class="bp-results-actions">
            <button class="bp-btn bp-btn-secondary" id="bp-save-btn">💾 Сохранить стратегию</button>
          </div>
  
          <div class="bp-card">
            <div class="bp-card-title">Сделки (${trades.length})</div>
            ${trades.length ? `
            <div class="bp-tbl-wrap">
              <table class="bp-tbl">
                <thead><tr>
                  <th>Вход</th><th>Выход</th><th>Направл.</th>
                  <th>Цена вх.</th><th>Цена вых.</th>
                  <th>P&L</th><th>P&L %</th><th>Причина</th>
                </tr></thead>
                <tbody>
                  ${trades.slice(0, 500).map(t => `
                    <tr class="${parseFloat(t.pnl)>=0?'bp-win':'bp-loss'}">
                      <td>${fmtDate(t.entryTs||t.entry_ts)}</td>
                      <td>${fmtDate(t.exitTs ||t.exit_ts)}</td>
                      <td><span class="bp-dir bp-dir-${t.dir||'long'}">${t.dir||'long'}</span></td>
                      <td>${(+t.entry).toFixed(5)}</td>
                      <td>${(+t.exit).toFixed(5)}</td>
                      <td class="${parseFloat(t.pnl)>=0?'bp-pos':'bp-neg'}">${fmtUsd(t.pnl)}</td>
                      <td class="${parseFloat(t.pnlPct||0)>=0?'bp-pos':'bp-neg'}">${fmtPct(t.pnlPct)}</td>
                      <td>${esc(t.exitReason||t.exit_reason||'—')}</td>
                    </tr>`
                  ).join('')}
                </tbody>
              </table>
            </div>` : '<div class="bp-empty-msg">Нет сделок за выбранный период</div>'}
          </div>
        </div>`;
    }
  
    function fmtDate(ts) {
      if (!ts) return '—';
      return new Date(ts).toLocaleDateString('ru', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' });
    }
  
    function statCard(label, value, cls) {
      return `
        <div class="bp-stat-card">
          <div class="bp-stat-label">${esc(label)}</div>
          <div class="bp-stat-value ${esc(cls)}">${esc(String(value ?? '—'))}</div>
        </div>`;
    }
  
    // ── History ──────────────────────────────────────────
  
    function renderHistory() {
      const list = BP.strategies.filter(s =>
        (s.display_name||'').toLowerCase().includes(BP.histSearch.toLowerCase())
      );
      return `
        <div class="bp-history">
          <div style="margin-bottom:16px">
            <input class="bp-input" id="bp-hist-search" type="text"
              placeholder="Поиск по стратегиям..." value="${esc(BP.histSearch)}"
              style="max-width:400px">
          </div>
          ${!list.length ? `
            <div class="bp-center-box">
              <div style="font-size:36px;opacity:.3">📁</div>
              <div style="color:#9aa0b2">Нет сохранённых стратегий</div>
            </div>` : `
            <div class="bp-strategy-list">
              ${list.map(s => {
                const st  = s._meta?.backtest_stats || {};
                const cfg = s._code || {};
                return `
                  <div class="bp-strategy-card">
                    <div class="bp-strategy-left">
                      <div class="bp-strategy-name">${esc(s.display_name)}</div>
                      <div class="bp-strategy-meta">
                        ${cfg.instrumentSymbol ? `<span>${esc(cfg.instrumentSymbol)}</span>` : ''}
                        ${cfg.clickhouseTicker ? `<span><code>${esc(cfg.clickhouseTicker)}</code></span>` : ''}
                        ${cfg.intervalCode     ? `<span>${esc(cfg.intervalCode)}</span>` : ''}
                      </div>
                    </div>
                    <div class="bp-strategy-stats">
                      ${st.trades != null ? `<span>Сделок: <b>${st.trades}</b></span>` : ''}
                      ${st.winRate != null ? `<span class="${+st.winRate>=50?'bp-pos':'bp-neg'}">WR: <b>${st.winRate}%</b></span>` : ''}
                      ${st.totalPnl != null ? `<span class="${+st.totalPnl>=0?'bp-pos':'bp-neg'}">P&L: <b>${fmtUsd(st.totalPnl)}</b></span>` : ''}
                    </div>
                    <div class="bp-strategy-actions">
                      <button class="bp-card-btn bp-hist-load" data-id="${s.id}">Загрузить</button>
                      <button class="bp-card-btn bp-hist-del"  data-id="${s.id}">Удалить</button>
                    </div>
                  </div>`;
              }).join('')}
            </div>`}
        </div>`;
    }
  
    // ═══════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════
  
    function bindEvents() {
      const root = getRoot();
      if (!root) return;
  
      // Tabs
      root.querySelectorAll('.bp-tab').forEach(tab => {
        tab.addEventListener('click', () => { BP.tab = tab.dataset.tab; renderPage(); });
      });
  
      // Run
      root.querySelector('#bp-run-btn')?.addEventListener('click', runBacktest);
      root.querySelector('#bp-retry-btn')?.addEventListener('click', runBacktest);
  
      // Setup
      root.querySelector('#bp-setup-sel')?.addEventListener('change', e => {
        const s = BP.setups.find(x => x.id === +e.target.value);
        BP.cfg.setupId   = s?.id   || null;
        BP.cfg.setupName = s?.display_name || '';
        BP.cfg.paramOverrides = {};
        renderPage();
      });
  
      // Instrument — берём clickhouse_ticker из data-атрибута
      root.querySelector('#bp-instrument-sel')?.addEventListener('change', e => {
        const opt = e.target.selectedOptions[0];
        BP.cfg.instrumentId     = +e.target.value || null;
        BP.cfg.instrumentSymbol = opt?.dataset.symbol || '';
        BP.cfg.instrumentName   = opt?.dataset.name   || '';
        BP.cfg.clickhouseTicker = opt?.dataset.ticker || '';
        renderPage();
      });
  
      // Interval — берём clickhouse_table из data-атрибута
      root.querySelector('#bp-interval-sel')?.addEventListener('change', e => {
        const opt = e.target.selectedOptions[0];
        BP.cfg.intervalId      = +e.target.value || null;
        BP.cfg.intervalCode    = opt?.dataset.code  || '';
        BP.cfg.clickhouseTable = opt?.dataset.table || '';
        renderPage();
      });
  
      // Commission
      root.querySelector('#bp-commission')?.addEventListener('input', e => {
        BP.cfg.commission = parseFloat(e.target.value) || 0;
      });
  
      // Period
      root.querySelector('#bp-period-sel')?.addEventListener('change', e => {
        BP.cfg.period = e.target.value;
        if (e.target.value !== 'custom') {
          BP.cfg.fromDate = '';
          BP.cfg.toDate   = '';
          if (e.target.value === '1y') BP.cfg.fromDate = new Date(Date.now() - 365*86400*1000).toISOString().slice(0,10);
          if (e.target.value === '2y') BP.cfg.fromDate = new Date(Date.now() - 730*86400*1000).toISOString().slice(0,10);
          if (e.target.value === '3y') BP.cfg.fromDate = new Date(Date.now() - 1095*86400*1000).toISOString().slice(0,10);
          if (e.target.value !== 'all') BP.cfg.toDate = new Date().toISOString().slice(0,10);
        }
        renderPage();
      });
      root.querySelector('#bp-from-date')?.addEventListener('change', e => { BP.cfg.fromDate = e.target.value; });
      root.querySelector('#bp-to-date')?.addEventListener('change',   e => { BP.cfg.toDate   = e.target.value; });
  
      // Param overrides
      root.querySelectorAll('.bp-param-ov').forEach(inp => {
        inp.addEventListener('input', () => {
          BP.cfg.paramOverrides[inp.dataset.paramId] = inp.value;
        });
      });
  
      // Entry conditions
      root.querySelector('#bp-add-entry-cond')?.addEventListener('click', () => {
        BP.cfg.extraEntryConditions.push({ field:'', op:'>', value:'' });
        reRenderConds('entry');
      });
  
      // Exit conditions
      root.querySelector('#bp-add-exit-cond')?.addEventListener('click', () => {
        BP.cfg.extraExitConditions.push({ field:'', op:'>', value:'' });
        reRenderConds('exit');
      });
  
      // Conditions delegation
      ['#bp-entry-conds','#bp-exit-conds'].forEach(sel => {
        const el = root.querySelector(sel);
        if (!el) return;
  
        el.addEventListener('input', e => {
          const fld  = e.target.dataset.field;
          const idx  = +e.target.dataset.idx;
          const type = e.target.dataset.type;
          if (!fld) return;
          const arr = type === 'entry' ? BP.cfg.extraEntryConditions : BP.cfg.extraExitConditions;
          if (arr[idx]) arr[idx][fld] = e.target.value;
        });
  
        el.addEventListener('change', e => {
          const fld  = e.target.dataset.field;
          const idx  = +e.target.dataset.idx;
          const type = e.target.dataset.type;
          if (!fld) return;
          const arr = type === 'entry' ? BP.cfg.extraEntryConditions : BP.cfg.extraExitConditions;
          if (arr[idx]) arr[idx][fld] = e.target.value;
        });
  
        el.addEventListener('click', e => {
          const del = e.target.closest('.bp-cond-del');
          if (!del) return;
          const arr = del.dataset.type === 'entry' ? BP.cfg.extraEntryConditions : BP.cfg.extraExitConditions;
          arr.splice(+del.dataset.idx, 1);
          reRenderConds(del.dataset.type);
        });
      });
  
      // Save strategy
      root.querySelector('#bp-save-btn')?.addEventListener('click', async () => {
        try {
          await saveStrategy(BP.cfg, BP.results?.stats);
          await loadStrategies();
          alert('Стратегия сохранена');
        } catch (e) { alert('Ошибка: ' + e.message); }
      });
  
      // History
      root.querySelector('#bp-hist-search')?.addEventListener('input', e => {
        BP.histSearch = e.target.value;
        reRenderHistory();
      });
  
      root.querySelectorAll('.bp-hist-load').forEach(btn => {
        btn.addEventListener('click', () => {
          const s = BP.strategies.find(x => x.id === +btn.dataset.id);
          if (!s) return;
          Object.assign(BP.cfg, s._code || {});
          BP.tab = 'configure';
          renderPage();
        });
      });
  
      root.querySelectorAll('.bp-hist-del').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Удалить стратегию?')) return;
          try {
            await apiFetch(`/api/javascript-scripts/${btn.dataset.id}`, { method: 'DELETE' });
            await loadStrategies();
            reRenderHistory();
          } catch (e) { alert('Ошибка: ' + e.message); }
        });
      });
    }
  
    function reRenderConds(type) {
      const root = getRoot();
      const id   = type === 'entry' ? '#bp-entry-conds' : '#bp-exit-conds';
      const el   = root?.querySelector(id);
      if (!el) return;
      const arr  = type === 'entry' ? BP.cfg.extraEntryConditions : BP.cfg.extraExitConditions;
      el.innerHTML = arr.map((c, i) => renderCondRow(c, i, type)).join('');
    }
  
    function reRenderHistory() {
      const root = getRoot();
      const el   = root?.querySelector('.bp-history');
      if (el) el.outerHTML = renderHistory();
      bindEvents();
    }
  
    // ═══════════════════════════════════════════════════════
    // CSS
    // ═══════════════════════════════════════════════════════
  
    function injectCSS() {
      if (document.getElementById('bp-styles')) return;
      const style = document.createElement('style');
      style.id = 'bp-styles';
      style.textContent = `
  /* ── Backtest Page ───────────────────────────────────────────── */
  #backtest-page-root{height:100%;overflow:hidden;display:flex;flex-direction:column;background:var(--bp-bg,#f8f9fc);font-family:-apple-system,'Segoe UI',sans-serif}
  .bp-page{display:flex;flex-direction:column;height:100%}
  /* Tab bar */
  .bp-tab-bar{display:flex;align-items:center;gap:4px;padding:10px 20px;border-bottom:1.5px solid var(--bp-border,#e2e6f0);background:var(--bp-card,#fff);flex-shrink:0}
  .bp-tab{padding:7px 16px;border-radius:8px;border:1.5px solid transparent;font-size:13px;font-weight:600;cursor:pointer;background:transparent;color:#6b7280;transition:all .15s}
  .bp-tab:hover{background:#f5f5f5;color:var(--bp-text,#1a1d2e)}
  .bp-tab-active{background:#1a1d2e;color:#fff}
  .bp-tab-spacer{flex:1}
  .bp-run-btn{padding:8px 20px;border-radius:9px;background:#1a1d2e;color:#fff;font-size:13px;font-weight:700;border:none;cursor:pointer;display:flex;align-items:center;gap:7px;transition:background .15s}
  .bp-run-btn:hover{background:#2d3250}.bp-run-btn:disabled{opacity:.6;cursor:default}
  .bp-run-running{background:#4f6df5}
  /* Content */
  .bp-content{flex:1;overflow-y:auto;padding:20px}
  /* Configure */
  .bp-configure{display:flex;flex-direction:column;gap:14px;max-width:960px;margin:0 auto}
  .bp-card{background:var(--bp-card,#fff);border:1.5px solid var(--bp-border,#e2e6f0);border-radius:12px;padding:18px 20px}
  .bp-card-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;color:var(--bp-text,#1a1d2e);margin-bottom:14px;display:flex;align-items:center;gap:10px}
  .bp-card-hint{font-size:11px;font-weight:400;color:#9aa0b2;text-transform:none;letter-spacing:0}
  .bp-card-grid{display:grid;gap:14px}
  .bp-card-grid-4{grid-template-columns:repeat(4,1fr)}
  .bp-period-row{display:flex;gap:14px;margin-top:14px;flex-wrap:wrap;align-items:flex-end}
  .bp-params-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
  .bp-field{display:flex;flex-direction:column;gap:5px}
  .bp-label{font-size:12px;font-weight:500;color:#6b7280}
  .bp-field-hint{font-size:11px;color:#9aa0b2;margin-top:3px}
  .bp-field-hint code{background:var(--bp-input,#f8f9fc);padding:1px 5px;border-radius:4px;font-size:10px;color:#4f6df5}
  .bp-input{padding:8px 11px;border:1.5px solid var(--bp-border,#e2e6f0);border-radius:8px;font-size:13px;color:var(--bp-text,#1a1d2e);background:var(--bp-input,#f8f9fc);outline:none;width:100%;box-sizing:border-box;transition:border-color .15s}
  .bp-input:focus{border-color:#4f6df5;background:var(--bp-card,#fff)}
  .bp-select{padding:8px 11px;border:1.5px solid var(--bp-border,#e2e6f0);border-radius:8px;font-size:13px;color:var(--bp-text,#1a1d2e);background:var(--bp-card,#fff);outline:none;cursor:pointer;width:100%}
  /* Conditions */
  .bp-cond-list{display:flex;flex-direction:column;gap:7px;margin-bottom:10px}
  .bp-cond-row{display:flex;gap:7px;align-items:center}
  .bp-cond-field{flex:2}.bp-cond-op{flex:1;min-width:110px}.bp-cond-value{flex:2}
  .bp-cond-del{padding:6px 9px;background:none;border:1px solid #ffd0d0;color:#e53935;border-radius:6px;cursor:pointer;font-size:11px;flex-shrink:0}.bp-cond-del:hover{background:#e53935;color:#fff}
  /* Empty */
  .bp-empty-card{background:var(--bp-card,#fff);border:1.5px solid var(--bp-border,#e2e6f0);border-radius:12px;padding:40px;text-align:center;color:#9aa0b2;display:flex;flex-direction:column;align-items:center;gap:10px}
  .bp-empty-icon{font-size:36px;opacity:.4}
  /* Results */
  .bp-results{display:flex;flex-direction:column;gap:14px;max-width:1100px;margin:0 auto}
  .bp-center-box{display:flex;flex-direction:column;align-items:center;padding:80px 24px;gap:16px;color:#9aa0b2}
  .bp-error-msg{color:#e53935;font-size:14px;text-align:center}
  .bp-empty-msg{text-align:center;color:#9aa0b2;font-size:13px;padding:24px}
  .bp-big-spin{width:40px;height:40px;border:3px solid var(--bp-border,#e2e6f0);border-top-color:#4f6df5;border-radius:50%;animation:bpspin .8s linear infinite}
  .bp-progress-msg{font-size:13px;color:#6b7280}
  .bp-progress-bar{width:280px;height:4px;background:var(--bp-border,#e2e6f0);border-radius:2px;overflow:hidden}
  .bp-progress-fill{height:100%;background:#4f6df5;border-radius:2px;transition:width .3s}
  @keyframes bpspin{to{transform:rotate(360deg)}}
  .bp-spin{width:13px;height:13px;border:2px solid #fff6;border-top-color:#fff;border-radius:50%;animation:bpspin .8s linear infinite;display:inline-block}
  .bp-stats-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:10px}
  .bp-stat-card{background:var(--bp-card,#fff);border:1.5px solid var(--bp-border,#e2e6f0);border-radius:11px;padding:14px;text-align:center}
  .bp-stat-label{font-size:10px;color:#9aa0b2;text-transform:uppercase;letter-spacing:.3px;margin-bottom:5px}
  .bp-stat-value{font-size:19px;font-weight:700;color:var(--bp-text,#1a1d2e)}
  .bp-pos{color:#22c55e!important}.bp-neg{color:#ef4444!important}
  .bp-results-actions{display:flex;justify-content:flex-end}
  .bp-tbl-wrap{overflow-x:auto}
  .bp-tbl{width:100%;border-collapse:collapse;font-size:12px}
  .bp-tbl th{padding:7px 10px;background:var(--bp-input,#f8f9fc);color:#9aa0b2;font-size:10px;text-transform:uppercase;letter-spacing:.3px;text-align:left;white-space:nowrap;position:sticky;top:0}
  .bp-tbl td{padding:5px 10px;border-bottom:1px solid var(--bp-border,#e2e6f0);color:#6b7280;white-space:nowrap}
  .bp-win td:first-child{border-left:2px solid #22c55e44}
  .bp-loss td:first-child{border-left:2px solid #ef444444}
  .bp-dir{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700}
  .bp-dir-long{background:#dcfce7;color:#16a34a}.bp-dir-short{background:#fee2e2;color:#dc2626}
  /* History */
  .bp-history{max-width:960px;margin:0 auto}
  .bp-strategy-list{display:flex;flex-direction:column;gap:8px}
  .bp-strategy-card{background:var(--bp-card,#fff);border:1.5px solid var(--bp-border,#e2e6f0);border-radius:11px;padding:14px 18px;display:flex;align-items:center;gap:14px;transition:border-color .15s}
  .bp-strategy-card:hover{border-color:#4f6df5}
  .bp-strategy-left{flex:1}
  .bp-strategy-name{font-size:14px;font-weight:600;color:var(--bp-text,#1a1d2e);margin-bottom:3px}
  .bp-strategy-meta{display:flex;gap:10px;font-size:11px;color:#9aa0b2;flex-wrap:wrap}
  .bp-strategy-meta code{background:var(--bp-input,#f8f9fc);padding:1px 5px;border-radius:3px;font-size:10px;color:#4f6df5}
  .bp-strategy-stats{display:flex;gap:12px;font-size:12px;color:#6b7280;flex-wrap:wrap}
  .bp-strategy-stats b{color:var(--bp-text,#1a1d2e)}
  .bp-strategy-actions{display:flex;gap:7px;flex-shrink:0}
  .bp-card-btn{padding:5px 12px;border-radius:7px;font-size:12px;font-weight:500;cursor:pointer;border:1.5px solid transparent;transition:all .15s}
  .bp-hist-load{background:#f0f4ff;color:#4f6df5;border-color:#d5deff}.bp-hist-load:hover{background:#4f6df5;color:#fff}
  .bp-hist-del{background:#fff0f0;color:#e53935;border-color:#ffd0d0}.bp-hist-del:hover{background:#e53935;color:#fff}
  /* Buttons */
  .bp-btn{padding:8px 18px;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:all .15s}
  .bp-btn-primary{background:#1a1d2e;color:#fff}.bp-btn-primary:hover{background:#2d3250}
  .bp-btn-secondary{background:#f0f4ff;color:#4f6df5;border:1.5px solid #d5deff}.bp-btn-secondary:hover{background:#4f6df5;color:#fff}
  .bp-btn-ghost{background:transparent;color:#6b7280;border:1.5px solid var(--bp-border,#e2e6f0)}.bp-btn-ghost:hover{background:#f5f5f5}
  .bp-btn-sm{padding:5px 11px;font-size:12px}
  /* Dark */
  body.dark-theme{--bp-bg:#060810;--bp-card:#0c0e1a;--bp-border:#1a1e34;--bp-text:#d1d4dc;--bp-input:#080a14}
  body.dark-theme .bp-tab-bar,body.dark-theme .bp-card,body.dark-theme .bp-stat-card,body.dark-theme .bp-strategy-card{background:#0c0e1a;border-color:#1a1e34}
  body.dark-theme .bp-tab:hover{background:#141826;color:#d1d4dc}
  body.dark-theme .bp-tab-active{background:#4f6df5}
  body.dark-theme .bp-run-btn{background:#4f6df5}.dark-theme .bp-run-btn:hover{background:#6b84ff}
  body.dark-theme .bp-input,body.dark-theme .bp-select{background:#080a14;border-color:#1a1e34;color:#d1d4dc}
  body.dark-theme .bp-input:focus{background:#0c0e1a}
  body.dark-theme .bp-tbl th{background:#080a14}
  body.dark-theme .bp-tbl td{border-color:#1a1e3440;color:#8a90a8}
  body.dark-theme .bp-stat-value,body.dark-theme .bp-strategy-name{color:#d1d4dc}
  body.dark-theme .bp-strategy-card:hover{border-color:#4f6df5}
  body.dark-theme .bp-dir-long{background:#0a1c0f;color:#4caf50}
  body.dark-theme .bp-dir-short{background:#1c0a0f;color:#ef5350}
  body.dark-theme .bp-btn-primary{background:#4f6df5}
  @media(max-width:900px){.bp-stats-grid{grid-template-columns:repeat(3,1fr)}.bp-card-grid-4{grid-template-columns:repeat(2,1fr)}}
  @media(max-width:600px){.bp-stats-grid{grid-template-columns:repeat(2,1fr)}.bp-card-grid-4{grid-template-columns:1fr}}
      `;
      document.head.appendChild(style);
    }
  
    // ═══════════════════════════════════════════════════════
    // INIT
    // ═══════════════════════════════════════════════════════
  
    async function init() {
      injectCSS();
      await loadAll();
    }
  
    window.backtestPage = {
      init,
      reload: loadAll,
      preselect(setupId, setupName) {
        BP.cfg.setupId   = setupId;
        BP.cfg.setupName = setupName;
        BP.cfg.paramOverrides = {};
        BP.tab = 'configure';
        renderPage();
      },
    };
  
    window.setupsBacktestPage = window.backtestPage;
  
  })();