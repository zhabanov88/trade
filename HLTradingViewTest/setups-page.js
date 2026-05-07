/**
 * setups-page.js  v6.0
 *
 * Правильная архитектура сетапа:
 *
 *   criteria[] — список подключённых индикаторов/критериев
 *     Каждый критерий:
 *       - scriptId, scriptName
 *       - inputs_schema → параметры (настраиваются здесь)
 *       - outputs_schema → свойства бара (bar.rsi_14, bar.sr_zone...)
 *         которые доступны в формулах
 *
 *   entry_expression — одна JS-формула для условия входа (→ boolean)
 *   exit_expression  — одна JS-формула для условия выхода (→ boolean)
 *
 * При составлении формулы можно кликнуть на property-пилюлю
 * любого критерия и она вставится в активный textarea.
 *
 * meta структура:
 * {
 *   categories: [],
 *   params_schema: [],          // глобальные параметры сетапа
 *   criteria: [
 *     {
 *       id: "uid",
 *       type: "indicator" | "custom",
 *       scriptId: 42,
 *       scriptName: "RSI",
 *       inputs_schema: [...],
 *       outputs_schema: [...],  // [{ id: "rsi_14", name: "RSI(14)" }]
 *       params: { length: 14 },
 *       enabled: true,
 *       label: "RSI"
 *     }
 *   ],
 *   entry_expression: "bar.rsi_14 < 30 && bar.close > bar.open",
 *   exit_expression:  "bar.rsi_14 > 70 || bar.low <= params.sl_level"
 * }
 */

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════

  const SP = {
    setups:        [],
    indicators:    [],
    categories:    [],
    setupTypeId:   null,

    searchQuery:      '',
    activeCategories: [],
    currentSetup:     null,
    editMode:         false,
    loading:          false,
    saving:           false,
    error:            null,

    // Какой textarea сейчас активен ('entry' или 'exit')
    activeExprSide: 'entry',
  };

  // ═══════════════════════════════════════════════════════
  // EMPTY SETUP
  // ═══════════════════════════════════════════════════════

  function emptySetup() {
    return {
      id: null, display_name: '', system_name: '', description: '',
      meta: {
        categories:       [],
        params_schema:    [],
        criteria:         [],
        entry_expression: '// Условие входа\n// Используйте свойства подключённых критериев\n// Пример: bar.rsi_14 < 30 && bar.close > bar.open\ntrue',
        exit_expression:  '// Условие выхода\n// Пример: bar.rsi_14 > 70 || bar.low <= params.sl_level\ntrue',
        // Стоп-лосс
        sl_mode:       'level',
        sl_value:      '',
        sl_atr_mult:   1.5,
        // Тейк-профит
        tp_mode:       'fixed',
        tp_multiplier: 2.0,
        tp_condition:  '',
        // Выход по времени
        time_exit_mode:  'end_of_day',
        time_exit_value: '',
      }
    };
  }

  function makeCriterion(ind) {
    return {
      id:             uid(),
      type:           'indicator',
      scriptId:       ind.id,
      scriptName:     ind.display_name,
      label:          ind.display_name,
      inputs_schema:  ind.inputs_schema  || [],
      outputs_schema: ind.outputs_schema || [],
      params:         buildDefaultParams(ind.inputs_schema || []),
      enabled:        true,
    };
  }

  function makeCustomCriterion() {
    return {
      id:             uid(),
      type:           'custom',
      scriptId:       null,
      scriptName:     null,
      label:          'Кастомный критерий',
      inputs_schema:  [],
      outputs_schema: [],
      params:         {},
      enabled:        true,
    };
  }

  function buildDefaultParams(inputs_schema) {
    const p = {};
    inputs_schema.forEach(inp => { p[inp.id] = inp.defval !== undefined ? inp.defval : ''; });
    return p;
  }

  function uid() { return Math.random().toString(36).slice(2, 10); }

  // ═══════════════════════════════════════════════════════
  // API
  // ═══════════════════════════════════════════════════════

  async function apiFetch(url, opts = {}) {
    const r = await fetch(url, { credentials: 'include', ...opts });
    if (!r.ok) { const e = await r.json().catch(() => ({ error: r.statusText })); throw new Error(e.error || r.statusText); }
    return r.json();
  }

  async function loadDictionaries() {
    const [typesR, catsR] = await Promise.allSettled([
      apiFetch('/api/script-types'),
      apiFetch('/api/setup-categories'),
    ]);
    if (typesR.status === 'fulfilled') {
      SP.setupTypeId = typesR.value.find(x => x.code === 'setup')?.id ?? null;
    }
    SP.categories = catsR.status === 'fulfilled' ? catsR.value : [];
  }

  async function loadScriptsData() {
    SP.loading = true; renderPage();
    try {
      const all = await apiFetch('/api/javascript-scripts');
      SP.indicators = all.filter(s => s.type_code === 'indicator' || s.type_id === 2);
      SP.setups = all.filter(s => s.type_code === 'setup').map(s => ({ ...s, _meta: parseMeta(s.meta) }));
    } catch (e) { SP.error = e.message; }
    finally { SP.loading = false; renderPage(); }
  }

  function parseMeta(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch (_) { return {}; }
  }

  /**
   * Читает актуальные значения из DOM и записывает в объект meta.
   * Вызывается перед сохранением, чтобы не потерять данные которые
   * пользователь ввёл но которые могли не попасть в модель через events.
   */
  function syncDOMToMeta(m) {
    const root = getRoot(); if (!root || !m) return;

    // Название и описание (на случай если не прошли через input event)
    const nameEl = root.querySelector('#sp-name');
    const descEl = root.querySelector('#sp-desc');
    if (nameEl) SP.currentSetup.display_name = nameEl.value;
    if (descEl) SP.currentSetup.description  = descEl.value;

    // Entry / exit expressions
    const entryTa = root.querySelector('#sp-entry-expr');
    const exitTa  = root.querySelector('#sp-exit-expr');
    if (entryTa) m.entry_expression = entryTa.value;
    if (exitTa)  m.exit_expression  = exitTa.value;

    // Глобальные параметры — синхронизируем каждое поле
    root.querySelectorAll('#sp-global-params .sp-param-row').forEach(row => {
      const idx = +row.dataset.idx;
      if (!m.params_schema?.[idx]) return;
      const p = m.params_schema[idx];
      row.querySelectorAll('[data-field]').forEach(el => {
        p[el.dataset.field] = el.value;
      });
    });

    // Критерии — параметры индикаторов
    if (!m.criteria) m.criteria = [];
    root.querySelectorAll('#sp-criteria-list .sp-crit-row').forEach(row => {
      const cid  = row.dataset.cid; if (!cid) return;
      const crit = m.criteria.find(c => c.id === cid); if (!crit) return;

      // label
      const labelEl = row.querySelector('.sp-crit-label');
      if (labelEl) crit.label = labelEl.value;

      // inputs (параметры индикатора)
      row.querySelectorAll('[data-param]').forEach(inp => {
        if (!crit.params) crit.params = {};
        crit.params[inp.dataset.param] = inp.value;
      });

      // кастомные outputs
      row.querySelectorAll('.sp-custom-out-row').forEach(outRow => {
        const oi = +outRow.dataset.oi;
        if (!crit.outputs_schema) crit.outputs_schema = [];
        if (!crit.outputs_schema[oi]) crit.outputs_schema[oi] = {};
        const idEl   = outRow.querySelector('[data-field="id"]');
        const nameEl = outRow.querySelector('[data-field="name"]');
        if (idEl)   crit.outputs_schema[oi].id   = idEl.value;
        if (nameEl) crit.outputs_schema[oi].name = nameEl.value;
      });
    });

    // SL / TP / Time exit inputs
    const v = id => root.querySelector('#' + id)?.value;
    const f = id => parseFloat(root.querySelector('#' + id)?.value);

    if (v('sp-sl-value')    !== undefined && v('sp-sl-value')    !== null) m.sl_value        = v('sp-sl-value')    ?? m.sl_value;
    if (!isNaN(f('sp-sl-atr')))                                             m.sl_atr_mult     = f('sp-sl-atr')      ?? m.sl_atr_mult;
    if (!isNaN(f('sp-tp-mult')))                                            m.tp_multiplier   = f('sp-tp-mult')     ?? m.tp_multiplier;
    if (v('sp-tp-cond')     !== undefined)                                  m.tp_condition    = v('sp-tp-cond')     ?? m.tp_condition;
    if (v('sp-time-minutes') !== undefined && v('sp-time-minutes') !== null) m.time_exit_value = v('sp-time-minutes') ?? m.time_exit_value;
    if (v('sp-time-hours')   !== undefined && v('sp-time-hours')   !== null) m.time_exit_value = v('sp-time-hours')   ?? m.time_exit_value;
    if (v('sp-time-days')    !== undefined && v('sp-time-days')    !== null) m.time_exit_value = v('sp-time-days')    ?? m.time_exit_value;
  }

  async function saveSetup(setup) {
    if (!SP.setupTypeId) { await loadDictionaries(); if (!SP.setupTypeId) { SP.error = 'Тип "setup" не найден.'; renderEditor(); return; } }

    // Sync всех DOM-значений в модель перед сохранением
    syncDOMToMeta(setup.meta);

    SP.saving = true;
    // Обновляем только кнопку, не перерисовываем весь редактор
    const saveBtn = getRoot()?.querySelector('#sp-save');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Сохранение...'; }

    const sysName = setup.system_name || (autoSlug(setup.display_name) + '_' + Date.now());
    try {
      const payload = {
        display_name: setup.display_name, system_name: sysName,
        description: setup.description || '', code: '{}',
        type_id: SP.setupTypeId, is_public: false,
        inputs_schema: [], is_overlay: false, meta: setup.meta,
      };
      if (SP.editMode && setup.id) {
        await apiFetch(`/api/javascript-scripts/${setup.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      } else {
        await apiFetch('/api/javascript-scripts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      }
      SP.error = null; SP.currentSetup = null;
      await loadScriptsData();
    } catch (e) {
      SP.error = e.message; SP.saving = false;
      const btn = getRoot()?.querySelector('#sp-save');
      if (btn) { btn.disabled = false; btn.textContent = 'Сохранить'; }
      const banner = getRoot()?.querySelector('.sp-error-banner');
      if (banner) { banner.textContent = SP.error; banner.style.display = ''; }
      else {
        const h = getRoot()?.querySelector('.sp-editor-header');
        if (h) { const b = document.createElement('div'); b.className='sp-error-banner'; b.textContent=SP.error; h.after(b); }
      }
    }
    finally { SP.saving = false; }
  }

  async function deleteSetup(id) {
    if (!confirm('Удалить сетап?')) return;
    try { await apiFetch(`/api/javascript-scripts/${id}`, { method: 'DELETE' }); await loadScriptsData(); }
    catch (e) { alert('Ошибка: ' + e.message); }
  }

  // ═══════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════

  function autoSlug(s) { return (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'')||'setup'; }
  function esc(s) { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function getRoot() { return document.getElementById('setups-page-root'); }
  function getCat(code) { return SP.categories.find(c => c.code === code); }

  // ═══════════════════════════════════════════════════════
  // RENDER — LIST
  // ═══════════════════════════════════════════════════════

  function renderPage() {
    const root = getRoot(); if (!root) return;
    if (SP.currentSetup) { root.innerHTML = buildEditorHTML(); bindEditorEvents(); return; }

    const q = SP.searchQuery.toLowerCase();
    const filtered = SP.setups.filter(s => {
      const nameOk = (s.display_name||'').toLowerCase().includes(q);
      const catOk  = SP.activeCategories.length === 0 || SP.activeCategories.some(ac => (s._meta?.categories||[]).includes(ac));
      return nameOk && catOk;
    });

    root.innerHTML = `
      <div class="sp-page">
        <div class="sp-page-header">
          <h1 class="sp-title">Сетапы</h1>
          <button class="sp-btn sp-btn-primary" id="sp-add-btn">добавить</button>
        </div>
        <div class="sp-toolbar">
          <div class="sp-search-wrap">
            <svg class="sp-search-icon" viewBox="0 0 20 20" fill="none"><circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" stroke-width="1.5"/><path d="M13 13l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            <input class="sp-search" id="sp-search" type="text" placeholder="Поиск по названию..." value="${esc(SP.searchQuery)}">
          </div>
        </div>
        ${SP.categories.length ? `
        <div class="sp-filter-tags">
          <span class="sp-filter-label">Теги:</span>
          <button class="sp-filter-tag ${SP.activeCategories.length===0?'sp-ftag-all':''}" id="sp-filter-all">Все</button>
          ${SP.categories.map(c => {
            const a = SP.activeCategories.includes(c.code);
            return '<button class="sp-filter-tag '+(a?'sp-ftag-on':'')+'" data-cat="'+esc(c.code)+'" style="'+(a?'--tc:'+esc(c.color)+';':'')+'" title="'+esc(c.description||'')+'">'+esc(c.name)+'</button>';
          }).join('')}
          ${SP.activeCategories.length ? '<button class="sp-filter-clear" id="sp-fclear">✕</button>' : ''}
        </div>` : ''}
        <div class="sp-list">
          ${SP.loading ? '<div class="sp-loading">Загрузка...</div>' : ''}
          ${SP.error   ? '<div class="sp-error">'+esc(SP.error)+'</div>' : ''}
          ${!SP.loading && !SP.error && !filtered.length ? '<div class="sp-empty">'+(SP.activeCategories.length?'Нет сетапов с выбранными тегами.':'Нет сетапов. Нажмите «добавить».')+'</div>' : ''}
          ${filtered.map(s => {
            const cats = (s._meta?.categories||[]).map(code => {
              const c = getCat(code);
              return c ? '<span class="sp-tag" style="--tc:'+esc(c.color)+'">'+esc(c.name)+'</span>' : '<span class="sp-tag">'+esc(code)+'</span>';
            }).join('');
            const criteriaCount = (s._meta?.criteria||[]).length;
            return '<div class="sp-card"><div class="sp-card-body"><div class="sp-card-name">'+esc(s.display_name)+'</div>'+(cats?'<div class="sp-card-tags">'+cats+'</div>':'')+(s.description?'<div class="sp-card-desc">'+esc(s.description)+'</div>':'')+'<div class="sp-card-meta">Критериев: '+criteriaCount+'</div></div><div class="sp-card-actions"><button class="sp-card-btn sp-card-edit" data-id="'+s.id+'">Редактировать</button><button class="sp-card-btn sp-card-del" data-id="'+s.id+'">Удалить</button></div></div>';
          }).join('')}
        </div>
      </div>`;

    root.querySelector('#sp-add-btn')?.addEventListener('click', () => {
      SP.currentSetup = emptySetup(); SP.editMode = false; SP.error = null; SP.activeExprSide = 'entry'; renderPage();
    });
    root.querySelector('#sp-search')?.addEventListener('input', e => { SP.searchQuery = e.target.value; renderPage(); });
    root.querySelector('#sp-filter-all')?.addEventListener('click', () => { SP.activeCategories = []; renderPage(); });
    root.querySelector('#sp-fclear')?.addEventListener('click', () => { SP.activeCategories = []; renderPage(); });
    root.querySelectorAll('.sp-filter-tag[data-cat]').forEach(btn => {
      btn.addEventListener('click', () => {
        const code = btn.dataset.cat; const idx = SP.activeCategories.indexOf(code);
        if (idx >= 0) SP.activeCategories.splice(idx, 1); else SP.activeCategories.push(code);
        renderPage();
      });
    });
    root.querySelectorAll('.sp-card-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const s = SP.setups.find(x => x.id === +btn.dataset.id); if (!s) return;
        SP.currentSetup = { ...s, meta: JSON.parse(JSON.stringify(s._meta||{})) };
        SP.editMode = true; SP.error = null; renderPage();
      });
    });
    root.querySelectorAll('.sp-card-del').forEach(btn => { btn.addEventListener('click', () => deleteSetup(+btn.dataset.id)); });
  }

  // ═══════════════════════════════════════════════════════
  // RENDER — EDITOR
  // ═══════════════════════════════════════════════════════

  function buildEditorHTML() {
    const s = SP.currentSetup; const m = s.meta || {};
    const selCats  = m.categories    || [];
    const params   = m.params_schema || [];
    const criteria = m.criteria      || [];
    const entryExpr = m.entry_expression || '';
    const exitExpr  = m.exit_expression  || '';

    // Все доступные свойства из всех enabled-критериев
    const allProps = collectAllProps(criteria);

    return `
    <div class="sp-editor">
      <!-- HEADER -->
      <div class="sp-editor-header">
        <button class="sp-back-btn" id="sp-back">← Назад</button>
        <h2 class="sp-editor-title" id="sp-ed-title">${esc(s.display_name||'Новый сетап')}</h2>
        <div class="sp-editor-actions">
          <button class="sp-btn sp-btn-ghost" id="sp-cancel">Отмена</button>
          ${SP.editMode && s.id ? '<button class="sp-btn sp-btn-secondary" id="sp-run-bt">▶ Бэктест</button>' : ''}
          <button class="sp-btn sp-btn-primary" id="sp-save" ${SP.saving?'disabled':''}>${SP.saving?'Сохранение...':'Сохранить'}</button>
        </div>
      </div>
      ${SP.error ? '<div class="sp-error-banner">'+esc(SP.error)+'</div>' : ''}

      <div class="sp-editor-body">
        <!-- MAIN -->
        <div class="sp-editor-main">

          <!-- INFO -->
          <div class="sp-section sp-section-info">
            <input class="sp-input sp-input-name" id="sp-name" type="text" placeholder="Название сетапа..." value="${esc(s.display_name)}">
            <textarea class="sp-textarea" id="sp-desc" rows="2" placeholder="Описание...">${esc(s.description||'')}</textarea>
            ${SP.categories.length ? `
            <div class="sp-tags-row">
              <span class="sp-label">Теги:</span>
              <div class="sp-tags-list">
                ${SP.categories.map(c => {
                  const a = selCats.includes(c.code);
                  return '<button class="sp-chip '+(a?'sp-chip-on':'')+'" data-cat="'+esc(c.code)+'" style="'+(a?'--tc:'+esc(c.color)+';':'')+'" title="'+esc(c.description||'')+'">'+esc(c.name)+'</button>';
                }).join('')}
              </div>
            </div>` : ''}
          </div>

          <!-- GLOBAL PARAMS -->
          <div class="sp-section">
            <div class="sp-section-title">
              Параметры сетапа
              <span class="sp-section-hint">Глобальные константы, доступны как <code>params.name</code></span>
            </div>
            <div id="sp-global-params">
              ${params.map((p, i) => buildGlobalParamRow(p, i)).join('')}
            </div>
            <button class="sp-btn sp-btn-ghost sp-btn-sm" id="sp-add-global-param">＋ Добавить параметр</button>
          </div>

          <!-- CRITERIA -->
          <div class="sp-section">
            <div class="sp-section-title">
              Критерии
              <span class="sp-section-hint">Источники свойств бара для использования в условиях</span>
            </div>
            <div class="sp-criteria-list" id="sp-criteria-list"
              ondragover="event.preventDefault()"
              ondrop="window._spDropCriterion(event)">
              ${criteria.length === 0 ? '<div class="sp-criteria-empty">Перетащите индикатор из правого списка или нажмите «＋ Кастомный»</div>' : ''}
              ${criteria.map((c, i) => buildCriterionRow(c, i, params)).join('')}
            </div>
            <div class="sp-criteria-actions">
              <button class="sp-btn sp-btn-ghost sp-btn-sm" id="sp-add-custom-crit">＋ Кастомный критерий</button>
            </div>
          </div>

          <!-- PROPERTY PALETTE -->
          ${allProps.length ? `
          <div class="sp-palette-section">
            <div class="sp-palette-title">Доступные свойства бара — кликните чтобы вставить в активное условие</div>
            <div class="sp-palette">
              ${allProps.map(p => `
                <button class="sp-prop-pill" data-prop="${esc(p.prop)}" title="${esc(p.label)} из «${esc(p.from)}»">
                  <span class="sp-prop-from">${esc(p.from)}</span>
                  <span class="sp-prop-name">bar.${esc(p.id)}</span>
                </button>`).join('')}
              ${params.map(p => p.id ? `
                <button class="sp-prop-pill sp-prop-pill-param" data-prop="params.${esc(p.id)}" title="${esc(p.name||p.id)} — параметр сетапа">
                  <span class="sp-prop-from">params</span>
                  <span class="sp-prop-name">.${esc(p.id)}</span>
                </button>` : '').join('')}
            </div>
          </div>` : ''}

          <!-- ENTRY EXPRESSION -->
          <div class="sp-section sp-expr-section ${SP.activeExprSide==='entry'?'sp-expr-active':''}">
            <div class="sp-section-title">
              Условие входа
              <span class="sp-section-hint">JS-выражение → boolean. true = сигнал входа</span>
            </div>
            <div class="sp-expr-wrap">
              <div class="sp-expr-toolbar">
                <span class="sp-expr-lang">JS</span>
                <span class="sp-expr-hint-sm">Доступны: <code>bar</code>, <code>bars</code>, <code>index</code>${params.length?', <code>params</code>':''}</span>
              </div>
              <textarea class="sp-expr-ta" id="sp-entry-expr"
                placeholder="bar.rsi_14 < 30 && bar.close > bar.open"
                rows="5">${esc(entryExpr)}</textarea>
            </div>
          </div>

          <!-- EXIT EXPRESSION -->
          <div class="sp-section sp-expr-section ${SP.activeExprSide==='exit'?'sp-expr-active':''}">
            <div class="sp-section-title">
              Условие выхода
              <span class="sp-section-hint">JS-выражение → boolean. true = сигнал выхода</span>
            </div>
            <div class="sp-expr-wrap">
              <div class="sp-expr-toolbar">
                <span class="sp-expr-lang">JS</span>
                <span class="sp-expr-hint-sm">Доступны: <code>bar</code>, <code>bars</code>, <code>index</code>${params.length?', <code>params</code>':''}</span>
              </div>
              <textarea class="sp-expr-ta" id="sp-exit-expr"
                placeholder="bar.rsi_14 > 70 || bar.low <= params.sl_level"
                rows="5">${esc(exitExpr)}</textarea>
            </div>
          </div>

          <!-- STOP LOSS -->
          <div class="sp-section sp-exit-section">
            <div class="sp-exit-section-title">Стоп-лосс</div>
            <div class="sp-exit-cards" data-group="sl">
              ${buildExitCard('sl','level','По уровню', m.sl_mode, `
                <div class="sp-exit-card-field">
                  <div class="sp-exit-card-label">Уровень стоп-лосса</div>
                  <input class="sp-exit-inp" id="sp-sl-value" type="number" step="any"
                    placeholder="Введите уровень" value="${esc(m.sl_value||'')}">
                </div>`)}
              ${buildExitCard('sl','atr','По ATR', m.sl_mode, `
                <div class="sp-exit-card-field">
                  <div class="sp-exit-card-label">Множитель ATR</div>
                  <input class="sp-exit-inp" id="sp-sl-atr" type="number" step="0.1"
                    placeholder="1.5" value="${esc(m.sl_atr_mult||1.5)}">
                </div>`)}
            </div>
          </div>

          <!-- TAKE PROFIT -->
          <div class="sp-section sp-exit-section">
            <div class="sp-exit-section-title">Тейк-профит</div>
            <div class="sp-exit-cards" data-group="tp">
              ${buildExitCard('tp','fixed','Фиксированный', m.tp_mode, `
                <div class="sp-exit-card-sub">n × стоп</div>
                <div class="sp-exit-card-field">
                  <div class="sp-exit-card-label">Множитель стопа</div>
                  <input class="sp-exit-inp" id="sp-tp-mult" type="number" step="0.1"
                    placeholder="2.0" value="${esc(m.tp_multiplier||2.0)}">
                </div>`)}
              ${buildExitCard('tp','trailing','Трейлинг-стоп', m.tp_mode, `
                <div class="sp-exit-card-sub">Следует за ценой</div>`)}
              ${buildExitCard('tp','condition','По условию', m.tp_mode, `
                <div class="sp-exit-card-sub">Индикатор или паттерн</div>
                <div class="sp-exit-card-field">
                  <input class="sp-exit-inp" id="sp-tp-cond" type="text"
                    placeholder="Условие или свойство бара" value="${esc(m.tp_condition||'')}">
                </div>`)}
            </div>
          </div>

          <!-- TIME EXIT -->
          <div class="sp-section sp-exit-section">
            <div class="sp-exit-section-title">Выход по времени</div>
            <div class="sp-exit-cards" data-group="time">
              ${buildExitCard('time','end_of_day','Конец дня', m.time_exit_mode, '')}
              ${buildExitCard('time','minutes','Минут', m.time_exit_mode, `
                <div class="sp-exit-card-field">
                  <input class="sp-exit-inp" id="sp-time-minutes" type="number" step="1"
                    placeholder="60" value="${esc(m.time_exit_mode==='minutes'?m.time_exit_value||'':'')}">
                </div>`)}
              ${buildExitCard('time','hours','Часов', m.time_exit_mode, `
                <div class="sp-exit-card-field">
                  <input class="sp-exit-inp" id="sp-time-hours" type="number" step="1"
                    placeholder="4" value="${esc(m.time_exit_mode==='hours'?m.time_exit_value||'':'')}">
                </div>`)}
              ${buildExitCard('time','days','Дней', m.time_exit_mode, `
                <div class="sp-exit-card-field">
                  <input class="sp-exit-inp" id="sp-time-days" type="number" step="1"
                    placeholder="1" value="${esc(m.time_exit_mode==='days'?m.time_exit_value||'':'')}">
                </div>`)}
            </div>
          </div>

        </div><!-- /sp-editor-main -->

        <!-- SIDEBAR -->
        <div class="sp-editor-sidebar">
          <div class="sp-sidebar-title">Доступные критерии</div>
          <div class="sp-sidebar-hint">Перетащите или кликните для добавления</div>
          ${SP.indicators.length === 0 ? '<div class="sp-sidebar-empty">Нет индикаторов с type_id=2</div>' : ''}
          <div class="sp-sidebar-list">
            ${SP.indicators.map(ind => {
              const outs = (ind.outputs_schema||[]).map(o => o.id||o.name).slice(0,4).join(', ');
              return '<div class="sp-sidebar-item" draggable="true"'+
                ' data-ind-id="'+ind.id+'"'+
                ' data-ind-name="'+esc(ind.display_name)+'"'+
                ' data-ind-inputs="'+esc(JSON.stringify(ind.inputs_schema||[]))+'"'+
                ' data-ind-outputs="'+esc(JSON.stringify(ind.outputs_schema||[]))+'"'+
                ' ondragstart="window._spCritDragStart(event)"'+
                '>'+
                '<div class="sp-sidebar-item-name">'+esc(ind.display_name)+'</div>'+
                (outs?'<div class="sp-sidebar-item-out">'+esc(outs)+'</div>':'')+
                '</div>';
            }).join('')}
          </div>
        </div>
      </div>
    </div>`;
  }

  // ── Helpers ──────────────────────────────────────────

  function collectAllProps(criteria) {
    const props = [];
    // Стандартные свойства бара всегда доступны
    ['open','high','low','close','volume'].forEach(f => {
      props.push({ prop: 'bar.'+f, id: f, label: f, from: 'bar' });
    });
    criteria.filter(c => c.enabled).forEach(c => {
      (c.outputs_schema||[]).forEach(o => {
        props.push({ prop: 'bar.'+o.id, id: o.id, label: o.name||o.id, from: c.label||c.scriptName||'?' });
      });
    });
    return props;
  }

  // ── Exit card builder ────────────────────────────────

  function buildExitCard(group, mode, title, currentMode, innerHtml) {
    const active = currentMode === mode;
    return `<div class="sp-exit-card ${active?'sp-exit-card-active':''}"
      data-group="${group}" data-mode="${mode}" role="button" tabindex="0">
      <div class="sp-exit-card-title">${title}</div>
      ${active ? innerHtml : ''}
    </div>`;
  }

  function buildCriterionRow(c, i, globalParams) {
    const isCustom = c.type === 'custom';
    const outs = c.outputs_schema || [];
    const inputs = c.inputs_schema || [];

    return `
    <div class="sp-crit-row ${c.enabled?'':'sp-crit-disabled'}" data-cid="${esc(c.id)}"
      draggable="true" ondragstart="window._spCritReorder(event,'${esc(c.id)}')">
      <div class="sp-crit-header">
        <span class="sp-crit-drag">⠿</span>
        <span class="sp-crit-badge ${isCustom?'sp-badge-custom':'sp-badge-indicator'}">${isCustom?'Кастом':'Индикатор'}</span>
        <input class="sp-crit-label" type="text"
          value="${esc(c.label)}"
          data-cid="${esc(c.id)}" data-field="label"
          placeholder="Название критерия">
        <div class="sp-crit-ctrl">
          <button class="sp-crit-toggle ${c.enabled?'sp-ton':'sp-toff'}"
            data-cid="${esc(c.id)}" title="${c.enabled?'Отключить':'Включить'}">
            ${c.enabled?'●':'○'}
          </button>
          <button class="sp-crit-del" data-cid="${esc(c.id)}" title="Удалить">✕</button>
        </div>
      </div>

      <!-- Параметры индикатора (inputs) -->
      ${inputs.length ? `
      <div class="sp-crit-inputs">
        <div class="sp-crit-sub-title">Параметры:</div>
        <div class="sp-crit-inputs-grid">
          ${inputs.map(inp => `
            <div class="sp-crit-input">
              <label class="sp-crit-input-label" title="${esc(inp.name||inp.id)}">${esc(inp.name||inp.id)}</label>
              <input class="sp-input sp-crit-inp-val"
                type="${inp.type==='integer'||inp.type==='float'?'number':'text'}"
                data-cid="${esc(c.id)}" data-param="${esc(inp.id)}"
                placeholder="${esc(String(inp.defval??''))}"
                value="${esc(c.params?.[inp.id]??inp.defval??'')}">
            </div>`).join('')}
        </div>
      </div>` : ''}

      <!-- Outputs — свойства бара которые добавляет этот критерий -->
      ${outs.length ? `
      <div class="sp-crit-outputs">
        <div class="sp-crit-sub-title">Добавляет свойства:</div>
        <div class="sp-crit-outs-list">
          ${outs.map(o => `
            <span class="sp-out-chip" title="${esc(o.name||o.id)}">bar.${esc(o.id)}</span>
          `).join('')}
        </div>
      </div>` : ''}

      <!-- Для кастомного: добавить свои outputs -->
      ${isCustom ? `
      <div class="sp-crit-custom-outs">
        <div class="sp-crit-sub-title">Кастомные свойства:</div>
        <div id="sp-crit-custom-outs-${esc(c.id)}">
          ${(c.outputs_schema||[]).map((o, oi) => buildCustomOutRow(c.id, o, oi)).join('')}
        </div>
        <button class="sp-btn sp-btn-ghost sp-btn-xs" data-cid="${esc(c.id)}" data-action="add-out">＋ Свойство</button>
      </div>` : ''}
    </div>`;
  }

  function buildCustomOutRow(cid, o, i) {
    return `<div class="sp-custom-out-row" data-cid="${esc(cid)}" data-oi="${i}">
      <input class="sp-input sp-cout-id" type="text" placeholder="id (напр. my_signal)"
        data-cid="${esc(cid)}" data-oi="${i}" data-field="id" value="${esc(o.id||'')}">
      <input class="sp-input sp-cout-name" type="text" placeholder="Название"
        data-cid="${esc(cid)}" data-oi="${i}" data-field="name" value="${esc(o.name||'')}">
      <button class="sp-param-del" data-cid="${esc(cid)}" data-oi="${i}" data-action="del-out">✕</button>
    </div>`;
  }

  function buildGlobalParamRow(p, i) {
    return `<div class="sp-param-row" data-idx="${i}">
      <input class="sp-input sp-p-id" type="text" placeholder="id" data-field="id" value="${esc(p.id||'')}">
      <input class="sp-input sp-p-name" type="text" placeholder="Название" data-field="name" value="${esc(p.name||'')}">
      <select class="sp-select sp-p-type" data-field="type">${['integer','float','string','bool'].map(t=>'<option value="'+t+'" '+(p.type===t?'selected':'')+'>'+t+'</option>').join('')}</select>
      <input class="sp-input sp-p-defval" type="text" placeholder="По умолчанию" data-field="defval" value="${esc(p.defval??'')}">
      <button class="sp-param-del" data-idx="${i}" data-action="del-param">✕</button>
    </div>`;
  }

  // ═══════════════════════════════════════════════════════
  // DRAG & DROP
  // ═══════════════════════════════════════════════════════

  window._spCritDragStart = function(e) {
    const item = e.currentTarget;
    e.dataTransfer.effectAllowed = 'copy';
    // Храним только id — остальное возьмём из SP.indicators
    e.dataTransfer.setData('text/plain', 'new:' + item.dataset.indId);
  };

  window._spDropCriterion = function(e) {
    e.preventDefault();
    const data = e.dataTransfer.getData('text/plain'); if (!data) return;
    const m = SP.currentSetup?.meta; if (!m) return;

    if (data.startsWith('new:')) {
      const indId = +data.slice('new:'.length);
      const ind   = SP.indicators.find(x => x.id === indId);
      if (ind) {
        if (!m.criteria) m.criteria = [];
        m.criteria.push(makeCriterion(ind));
        reRenderCriteria();
      }
    } else if (data.startsWith('reorder:')) {
      const cid    = data.slice('reorder:'.length);
      const target = e.target.closest('.sp-crit-row');
      if (target && target.dataset.cid !== cid) {
        const a = m.criteria || [];
        const fromIdx = a.findIndex(c => c.id === cid);
        const toIdx   = a.findIndex(c => c.id === target.dataset.cid);
        if (fromIdx >= 0 && toIdx >= 0) {
          const [item] = a.splice(fromIdx, 1);
          a.splice(toIdx, 0, item);
          reRenderCriteria();
        }
      }
    }
  };

  window._spCritReorder = function(e, cid) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'reorder:' + cid);
    e.stopPropagation();
  };

  // ═══════════════════════════════════════════════════════
  // BIND EDITOR EVENTS
  // ═══════════════════════════════════════════════════════

  function bindEditorEvents() {
    const root = getRoot(); if (!root) return;
    const s = SP.currentSetup; const m = s.meta = s.meta || {};

    // Back / cancel
    const goBack = () => { SP.currentSetup = null; SP.error = null; renderPage(); };
    root.querySelector('#sp-back')?.addEventListener('click', goBack);
    root.querySelector('#sp-cancel')?.addEventListener('click', goBack);
    root.querySelector('#sp-run-bt')?.addEventListener('click', () => {
      if (window.backtestPage) window.backtestPage.preselect(s.id, s.display_name);
      if (window.spRouter) window.spRouter.navigate('backtest');
    });

    // Название / описание
    root.querySelector('#sp-name')?.addEventListener('input', e => {
      s.display_name = e.target.value;
      root.querySelector('#sp-ed-title').textContent = e.target.value || 'Новый сетап';
      if (!SP.editMode) s.system_name = autoSlug(e.target.value);
    });
    root.querySelector('#sp-desc')?.addEventListener('input', e => { s.description = e.target.value; });

    // Теги
    root.querySelectorAll('.sp-chip[data-cat]').forEach(chip => {
      chip.addEventListener('click', () => {
        if (!m.categories) m.categories = [];
        const code = chip.dataset.cat; const cat = getCat(code); const idx = m.categories.indexOf(code);
        if (idx >= 0) { m.categories.splice(idx,1); chip.classList.remove('sp-chip-on'); chip.style.removeProperty('--tc'); }
        else { m.categories.push(code); chip.classList.add('sp-chip-on'); if (cat?.color) chip.style.setProperty('--tc', cat.color); }
      });
    });

    // Глобальные параметры
    root.querySelector('#sp-add-global-param')?.addEventListener('click', () => {
      if (!m.params_schema) m.params_schema = [];
      m.params_schema.push({ id:'', name:'', type:'integer', defval:'' });
      reRenderGlobalParams();
    });
    bindGlobalParamList();

    // Expressions — отслеживаем фокус чтобы знать в какой вставлять свойства
    const entryTa = root.querySelector('#sp-entry-expr');
    const exitTa  = root.querySelector('#sp-exit-expr');

    if (entryTa) {
      entryTa.addEventListener('focus', () => {
        SP.activeExprSide = 'entry';
        root.querySelectorAll('.sp-expr-section').forEach(el => el.classList.remove('sp-expr-active'));
        entryTa.closest('.sp-expr-section')?.classList.add('sp-expr-active');
      });
      entryTa.addEventListener('input', e => { m.entry_expression = e.target.value; });
      // Восстанавливаем правильную высоту
      entryTa.style.height = 'auto';
      entryTa.style.height = Math.max(120, entryTa.scrollHeight) + 'px';
      entryTa.addEventListener('input', () => { entryTa.style.height = 'auto'; entryTa.style.height = Math.max(120, entryTa.scrollHeight) + 'px'; });
    }
    if (exitTa) {
      exitTa.addEventListener('focus', () => {
        SP.activeExprSide = 'exit';
        root.querySelectorAll('.sp-expr-section').forEach(el => el.classList.remove('sp-expr-active'));
        exitTa.closest('.sp-expr-section')?.classList.add('sp-expr-active');
      });
      exitTa.addEventListener('input', e => { m.exit_expression = e.target.value; });
      exitTa.style.height = 'auto';
      exitTa.style.height = Math.max(120, exitTa.scrollHeight) + 'px';
      exitTa.addEventListener('input', () => { exitTa.style.height = 'auto'; exitTa.style.height = Math.max(120, exitTa.scrollHeight) + 'px'; });
    }

    // Property palette — клик вставляет в активный textarea
    root.querySelectorAll('.sp-prop-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        const prop = pill.dataset.prop;
        const ta = SP.activeExprSide === 'entry' ? entryTa : exitTa;
        if (!ta) return;
        insertAtCursor(ta, prop);
        // Обновляем модель
        if (SP.activeExprSide === 'entry') m.entry_expression = ta.value;
        else m.exit_expression = ta.value;
      });
    });

    // Add custom criterion
    root.querySelector('#sp-add-custom-crit')?.addEventListener('click', () => {
      if (!m.criteria) m.criteria = [];
      m.criteria.push(makeCustomCriterion());
      reRenderCriteria();
    });

    // Sidebar click — add to criteria
    root.querySelectorAll('.sp-sidebar-item').forEach(item => {
      item.addEventListener('click', () => {
        const ind = SP.indicators.find(x => x.id === +item.dataset.indId);
        if (!ind) return;
        if (!m.criteria) m.criteria = [];
        m.criteria.push(makeCriterion(ind));
        reRenderCriteria();
      });
    });

    // Criteria list delegation
    bindCriteriaList();

    // ── EXIT CARDS ─────────────────────────────────────
    bindExitCards(root, m);
    bindExitInputs(root, m);

    // Save
    root.querySelector('#sp-save')?.addEventListener('click', () => {
      if (!s.display_name.trim()) { alert('Введите название сетапа'); return; }
      // Сохраняем актуальные выражения
      // syncDOMToMeta вызывается внутри saveSetup
      saveSetup(s);
    });
  }

  function insertAtCursor(ta, text) {
    ta.focus();
    const start = ta.selectionStart;
    const end   = ta.selectionEnd;
    ta.value = ta.value.substring(0, start) + text + ta.value.substring(end);
    ta.selectionStart = ta.selectionEnd = start + text.length;
    ta.dispatchEvent(new Event('input'));
  }

  function bindExitCards(root, m) {
    root.querySelectorAll('.sp-exit-card').forEach(card => {
      card.addEventListener('click', () => {
        const group = card.dataset.group;
        const mode  = card.dataset.mode;
        if (group === 'sl')   m.sl_mode        = mode;
        if (group === 'tp')   m.tp_mode        = mode;
        if (group === 'time') m.time_exit_mode = mode;
        reRenderExitSection(root, m, group);
      });
    });
  }

  function reRenderExitSection(root, m, group) {
    const container = root.querySelector(`.sp-exit-cards[data-group="${group}"]`);
    if (!container) return;
    if (group === 'sl') {
      container.innerHTML =
        buildExitCard('sl','level','По уровню', m.sl_mode, '<div class="sp-exit-card-field"><div class="sp-exit-card-label">Уровень стоп-лосса</div><input class="sp-exit-inp" id="sp-sl-value" type="number" step="any" placeholder="Введите уровень" value="'+(m.sl_value||'')+'"></div>') +
        buildExitCard('sl','atr','По ATR', m.sl_mode, '<div class="sp-exit-card-field"><div class="sp-exit-card-label">Множитель ATR</div><input class="sp-exit-inp" id="sp-sl-atr" type="number" step="0.1" placeholder="1.5" value="'+(m.sl_atr_mult||1.5)+'"></div>');
    }
    if (group === 'tp') {
      container.innerHTML =
        buildExitCard('tp','fixed','Фиксированный', m.tp_mode, '<div class="sp-exit-card-sub">n × стоп</div><div class="sp-exit-card-field"><div class="sp-exit-card-label">Множитель стопа</div><input class="sp-exit-inp" id="sp-tp-mult" type="number" step="0.1" placeholder="2.0" value="'+(m.tp_multiplier||2.0)+'"></div>') +
        buildExitCard('tp','trailing','Трейлинг-стоп', m.tp_mode, '<div class="sp-exit-card-sub">Следует за ценой</div>') +
        buildExitCard('tp','condition','По условию', m.tp_mode, '<div class="sp-exit-card-sub">Индикатор или паттерн</div><div class="sp-exit-card-field"><input class="sp-exit-inp" id="sp-tp-cond" type="text" placeholder="Условие или свойство бара" value="'+(m.tp_condition||'')+'"></div>');
    }
    if (group === 'time') {
      const tv = m.time_exit_value || '';
      container.innerHTML =
        buildExitCard('time','end_of_day','Конец дня', m.time_exit_mode, '') +
        buildExitCard('time','minutes','Минут', m.time_exit_mode, '<div class="sp-exit-card-field"><input class="sp-exit-inp" id="sp-time-minutes" type="number" step="1" placeholder="60" value="'+(m.time_exit_mode==='minutes'?tv:'')+'"></div>') +
        buildExitCard('time','hours','Часов', m.time_exit_mode, '<div class="sp-exit-card-field"><input class="sp-exit-inp" id="sp-time-hours" type="number" step="1" placeholder="4" value="'+(m.time_exit_mode==='hours'?tv:'')+'"></div>') +
        buildExitCard('time','days','Дней', m.time_exit_mode, '<div class="sp-exit-card-field"><input class="sp-exit-inp" id="sp-time-days" type="number" step="1" placeholder="1" value="'+(m.time_exit_mode==='days'?tv:'')+'"></div>');
    }
    // Re-bind new cards and inputs
    bindExitCards(root, m);
    bindExitInputs(root, m);
  }

  function bindExitInputs(rootEl, meta) {
    const root = rootEl || getRoot();
    const m    = meta   || SP.currentSetup?.meta;
    if (!root || !m) return;

    const bind = (id, setter) => {
      root.querySelector('#'+id)?.addEventListener('input', e => setter(e.target.value));
    };
    bind('sp-sl-value',    v => { m.sl_value      = v; });
    bind('sp-sl-atr',      v => { m.sl_atr_mult   = parseFloat(v); });
    bind('sp-tp-mult',     v => { m.tp_multiplier = parseFloat(v); });
    bind('sp-tp-cond',     v => { m.tp_condition  = v; });
    bind('sp-time-minutes',v => { m.time_exit_value = v; });
    bind('sp-time-hours',  v => { m.time_exit_value = v; });
    bind('sp-time-days',   v => { m.time_exit_value = v; });
  }

  function bindGlobalParamList() {
    const root = getRoot(); const el = root?.querySelector('#sp-global-params'); if (!el) return;
    el.addEventListener('input', e => {
      const row = e.target.closest('.sp-param-row'); if (!row) return;
      const m = SP.currentSetup?.meta; const idx = +row.dataset.idx; const fld = e.target.dataset.field;
      if (m?.params_schema?.[idx] !== undefined && fld) m.params_schema[idx][fld] = e.target.value;
    });
    el.addEventListener('click', e => {
      const del = e.target.closest('[data-action="del-param"]'); if (!del) return;
      SP.currentSetup?.meta?.params_schema?.splice(+del.dataset.idx, 1);
      reRenderGlobalParams();
      reRenderPalette();
    });
  }

  function bindCriteriaList() {
    const root = getRoot(); const list = root?.querySelector('#sp-criteria-list'); if (!list) return;
    const m = () => SP.currentSetup?.meta;

    list.addEventListener('input', e => {
      const cid  = e.target.dataset.cid; if (!cid) return;
      const crit = m()?.criteria?.find(c => c.id === cid); if (!crit) return;

      const field = e.target.dataset.field;
      const param = e.target.dataset.param;
      const oi    = e.target.dataset.oi;

      if (field === 'label') { crit.label = e.target.value; }
      if (param)             { if (!crit.params) crit.params={}; crit.params[param] = e.target.value; }
      if (field === 'id' && oi !== undefined) {
        if (!crit.outputs_schema) crit.outputs_schema=[];
        if (!crit.outputs_schema[+oi]) crit.outputs_schema[+oi]={};
        crit.outputs_schema[+oi].id = e.target.value;
        reRenderPalette();
      }
      if (field === 'name' && oi !== undefined) {
        if (!crit.outputs_schema) crit.outputs_schema=[];
        if (!crit.outputs_schema[+oi]) crit.outputs_schema[+oi]={};
        crit.outputs_schema[+oi].name = e.target.value;
      }
    });

    list.addEventListener('click', e => {
      const crit = (cid => m()?.criteria?.find(c => c.id === cid));

      // Toggle enabled
      const tog = e.target.closest('.sp-crit-toggle');
      if (tog) {
        const c = crit(tog.dataset.cid); if (!c) return;
        c.enabled = !c.enabled;
        tog.textContent  = c.enabled ? '●' : '○';
        tog.classList.toggle('sp-ton',  c.enabled);
        tog.classList.toggle('sp-toff', !c.enabled);
        tog.closest('.sp-crit-row')?.classList.toggle('sp-crit-disabled', !c.enabled);
        reRenderPalette();
        return;
      }

      // Delete criterion
      const del = e.target.closest('.sp-crit-del');
      if (del) {
        const arr = m()?.criteria; if (!arr) return;
        const idx = arr.findIndex(c => c.id === del.dataset.cid);
        if (idx >= 0) { arr.splice(idx, 1); reRenderCriteria(); }
        return;
      }

      // Add custom output
      const addOut = e.target.closest('[data-action="add-out"]');
      if (addOut) {
        const c = crit(addOut.dataset.cid); if (!c) return;
        if (!c.outputs_schema) c.outputs_schema=[];
        c.outputs_schema.push({ id:'', name:'' });
        reRenderCriteria();
        return;
      }

      // Delete custom output
      const delOut = e.target.closest('[data-action="del-out"]');
      if (delOut) {
        const c = crit(delOut.dataset.cid); if (!c) return;
        c.outputs_schema?.splice(+delOut.dataset.oi, 1);
        reRenderCriteria();
        return;
      }
    });
  }

  function reRenderGlobalParams() {
    const root = getRoot(); const m = SP.currentSetup?.meta;
    if (!root || !m) return;
    syncDOMToMeta(m);
    const el = root.querySelector('#sp-global-params'); if (!el) return;
    el.innerHTML = (m.params_schema||[]).map((p,i) => buildGlobalParamRow(p,i)).join('');
    bindGlobalParamList();
    reRenderPalette();
  }

  function reRenderCriteria() {
    const root = getRoot(); const m = SP.currentSetup?.meta; if (!root||!m) return;
    // Sync текущих DOM-значений перед перерисовкой
    syncDOMToMeta(m);
    const el = root.querySelector('#sp-criteria-list'); if (!el) return;
    const criteria = m.criteria||[];
    el.innerHTML = criteria.length
      ? criteria.map((c,i) => buildCriterionRow(c, i, m.params_schema||[])).join('')
      : '<div class="sp-criteria-empty">Перетащите индикатор из правого списка или нажмите «＋ Кастомный»</div>';
    bindCriteriaList();
    reRenderPalette();
  }

  function reRenderPalette() {
    const root = getRoot(); const m = SP.currentSetup?.meta; if (!root||!m) return;
    const allProps = collectAllProps(m.criteria||[]);
    const params   = m.params_schema||[];
    // Find palette or insert after criteria section
    let palette = root.querySelector('.sp-palette-section');
    if (!allProps.length && !params.filter(p=>p.id).length) {
      if (palette) palette.style.display = 'none';
      return;
    }
    if (palette) {
      palette.style.display = '';
      palette.querySelector('.sp-palette').innerHTML =
        allProps.map(p => `<button class="sp-prop-pill" data-prop="${esc(p.prop)}" title="${esc(p.label)} из «${esc(p.from)}»"><span class="sp-prop-from">${esc(p.from)}</span><span class="sp-prop-name">bar.${esc(p.id)}</span></button>`).join('') +
        params.filter(p=>p.id).map(p => `<button class="sp-prop-pill sp-prop-pill-param" data-prop="params.${esc(p.id)}" title="${esc(p.name||p.id)}"><span class="sp-prop-from">params</span><span class="sp-prop-name">.${esc(p.id)}</span></button>`).join('');
      // Rebind
      const entryTa = root.querySelector('#sp-entry-expr');
      const exitTa  = root.querySelector('#sp-exit-expr');
      const mm = m;
      palette.querySelectorAll('.sp-prop-pill').forEach(pill => {
        pill.addEventListener('click', () => {
          const prop = pill.dataset.prop;
          const ta   = SP.activeExprSide === 'entry' ? entryTa : exitTa;
          if (!ta) return;
          insertAtCursor(ta, prop);
          if (SP.activeExprSide === 'entry') mm.entry_expression = ta.value;
          else mm.exit_expression = ta.value;
        });
      });
    }
  }

  function renderEditor() {
    const root = getRoot(); if (!root||!SP.currentSetup) return;
    root.innerHTML = buildEditorHTML(); bindEditorEvents();
  }

  // ═══════════════════════════════════════════════════════
  // CSS
  // ═══════════════════════════════════════════════════════

  function injectCSS() {
    if (document.getElementById('sp-styles')) return;
    const s = document.createElement('style'); s.id = 'sp-styles';
    s.textContent = `
/* ── Base ────────────────────────────────────────────── */
#setups-page-root{height:100%;overflow:auto;background:var(--sp-bg,#f8f9fc);font-family:-apple-system,'Segoe UI',sans-serif}
.sp-page{max-width:1000px;margin:0 auto;padding:36px 24px}
.sp-page-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px}
.sp-title{font-size:28px;font-weight:700;color:var(--sp-text,#1a1d2e);margin:0;letter-spacing:-.5px}

/* Search + filter */
.sp-toolbar{margin-bottom:12px}
.sp-search-wrap{position:relative}
.sp-search-icon{position:absolute;left:12px;top:50%;transform:translateY(-50%);width:16px;height:16px;color:#9aa0b2;pointer-events:none}
.sp-search{width:100%;padding:10px 12px 10px 36px;border:1.5px solid var(--sp-border,#e2e6f0);border-radius:10px;background:var(--sp-card-bg,#fff);color:var(--sp-text,#1a1d2e);font-size:14px;outline:none;box-sizing:border-box;transition:border-color .15s}
.sp-search:focus{border-color:#4f6df5}
.sp-filter-tags{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:20px;padding-bottom:14px;border-bottom:1px solid var(--sp-border,#e2e6f0)}
.sp-filter-label{font-size:12px;color:#9aa0b2;flex-shrink:0}
.sp-filter-tag{padding:5px 13px;border-radius:20px;font-size:12px;font-weight:500;border:1.5px solid var(--sp-border,#e2e6f0);background:transparent;color:#6b7280;cursor:pointer;transition:all .12s}
.sp-filter-tag:hover{border-color:#4f6df5;color:#4f6df5}
.sp-ftag-all{background:#1a1d2e;color:#fff;border-color:#1a1d2e}
.sp-ftag-on{background:var(--tc,#4f6df5);color:#fff;border-color:var(--tc,#4f6df5)}
.sp-filter-clear{padding:5px 12px;border-radius:20px;font-size:12px;border:1px solid #ffd0d0;color:#e53935;background:transparent;cursor:pointer}.sp-filter-clear:hover{background:#e53935;color:#fff}

/* List cards */
.sp-list{display:flex;flex-direction:column;gap:10px}
.sp-loading,.sp-empty{text-align:center;color:#9aa0b2;padding:48px 24px;font-size:15px}
.sp-error{color:#c62828;background:#fce4ec;border-radius:8px;padding:12px 16px;font-size:13px}
.sp-card{background:var(--sp-card-bg,#fff);border:1.5px solid var(--sp-border,#e2e6f0);border-radius:14px;padding:18px 20px;display:flex;align-items:center;gap:16px;transition:border-color .15s,box-shadow .15s}
.sp-card:hover{border-color:#4f6df5;box-shadow:0 4px 18px #4f6df514}
.sp-card-body{flex:1}.sp-card-name{font-size:16px;font-weight:600;color:var(--sp-text,#1a1d2e);margin-bottom:6px}
.sp-card-tags{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:5px}
.sp-card-desc{font-size:13px;color:#6b7280;margin-top:3px}.sp-card-meta{font-size:12px;color:#9aa0b2;margin-top:6px}
.sp-card-actions{display:flex;gap:8px;flex-shrink:0}
.sp-card-btn{padding:6px 14px;border-radius:7px;font-size:12px;font-weight:500;cursor:pointer;border:1.5px solid transparent;transition:all .15s}
.sp-card-edit{background:#f0f4ff;color:#4f6df5;border-color:#d5deff}.sp-card-edit:hover{background:#4f6df5;color:#fff}
.sp-card-del{background:#fff0f0;color:#e53935;border-color:#ffd0d0}.sp-card-del:hover{background:#e53935;color:#fff}
.sp-tag{display:inline-block;padding:2px 10px;background:color-mix(in srgb,var(--tc,#4f6df5) 12%,transparent);color:var(--tc,#4f6df5);border:1px solid color-mix(in srgb,var(--tc,#4f6df5) 30%,transparent);border-radius:20px;font-size:11px;font-weight:600}

/* Buttons */
.sp-btn{padding:9px 20px;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;border:none;transition:all .15s}
.sp-btn-primary{background:#1a1d2e;color:#fff}.sp-btn-primary:hover{background:#2d3250}.sp-btn-primary:disabled{opacity:.5;cursor:default}
.sp-btn-secondary{background:#f0f4ff;color:#4f6df5;border:1.5px solid #d5deff}.sp-btn-secondary:hover{background:#4f6df5;color:#fff}
.sp-btn-ghost{background:transparent;color:#6b7280;border:1.5px solid var(--sp-border,#e2e6f0)}.sp-btn-ghost:hover{background:#f0f4ff;color:#4f6df5;border-color:#4f6df5}
.sp-btn-sm{padding:5px 12px;font-size:12px}
.sp-btn-xs{padding:3px 9px;font-size:11px;border-radius:6px}

/* Editor layout */
.sp-editor{display:flex;flex-direction:column;height:100%}
.sp-editor-header{display:flex;align-items:center;gap:12px;padding:14px 24px;border-bottom:1.5px solid var(--sp-border,#e2e6f0);background:var(--sp-card-bg,#fff);flex-shrink:0}
.sp-back-btn{background:none;border:none;font-size:14px;color:#4f6df5;cursor:pointer;padding:5px 10px;border-radius:7px;font-weight:500}.sp-back-btn:hover{background:#f0f4ff}
.sp-editor-title{flex:1;font-size:18px;font-weight:700;color:var(--sp-text,#1a1d2e);margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sp-editor-actions{display:flex;gap:8px;flex-shrink:0}
.sp-error-banner{background:#fce4ec;color:#c62828;padding:10px 24px;font-size:13px;flex-shrink:0}
.sp-editor-body{display:flex;flex:1;overflow:hidden}
.sp-editor-main{flex:1;overflow-y:auto;padding:20px 24px;display:flex;flex-direction:column;gap:14px}

/* Sidebar */
.sp-editor-sidebar{width:240px;flex-shrink:0;border-left:1.5px solid var(--sp-border,#e2e6f0);background:var(--sp-card-bg,#fff);overflow-y:auto;display:flex;flex-direction:column}
.sp-sidebar-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#9aa0b2;padding:16px 16px 4px}
.sp-sidebar-hint{font-size:11px;color:#9aa0b2;padding:0 16px 10px;font-style:italic;line-height:1.5}
.sp-sidebar-empty{font-size:12px;color:#9aa0b2;padding:0 16px 12px;font-style:italic;line-height:1.6}
.sp-sidebar-list{display:flex;flex-direction:column}
.sp-sidebar-item{padding:10px 16px;cursor:grab;border-bottom:1px solid var(--sp-border,#e2e6f0);transition:background .12s;user-select:none}
.sp-sidebar-item:hover{background:#f0f4ff}
.sp-sidebar-item:active{cursor:grabbing}
.sp-sidebar-item-name{display:block;font-size:13px;font-weight:500;color:var(--sp-text,#1a1d2e)}
.sp-sidebar-item-out{display:block;font-size:10px;color:#9aa0b2;margin-top:2px;font-family:monospace}

/* Section */
.sp-section{background:var(--sp-card-bg,#fff);border:1.5px solid var(--sp-border,#e2e6f0);border-radius:12px;padding:18px 20px}
.sp-section-info{display:flex;flex-direction:column;gap:10px}
.sp-section-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;color:var(--sp-text,#1a1d2e);margin-bottom:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sp-section-hint{font-size:11px;font-weight:400;text-transform:none;letter-spacing:0;color:#9aa0b2}
.sp-section-hint code{font-family:monospace;background:var(--sp-input-bg,#f8f9fc);padding:1px 4px;border-radius:3px;font-size:10px}

/* Inputs */
.sp-input{padding:9px 12px;border:1.5px solid var(--sp-border,#e2e6f0);border-radius:8px;font-size:14px;color:var(--sp-text,#1a1d2e);background:var(--sp-input-bg,#f8f9fc);outline:none;transition:border-color .15s;box-sizing:border-box;width:100%}
.sp-input:focus{border-color:#4f6df5;background:var(--sp-card-bg,#fff)}
.sp-input-name{font-size:20px;font-weight:700;border-color:transparent;background:transparent;padding-left:0}
.sp-input-name:focus{border-color:#4f6df5;background:var(--sp-card-bg,#fff);padding-left:12px}
.sp-textarea{width:100%;padding:9px 12px;border:1.5px solid var(--sp-border,#e2e6f0);border-radius:8px;font-size:13px;color:var(--sp-text,#1a1d2e);background:var(--sp-input-bg,#f8f9fc);outline:none;resize:vertical;box-sizing:border-box}
.sp-textarea:focus{border-color:#4f6df5}
.sp-select{padding:7px 10px;border:1.5px solid var(--sp-border,#e2e6f0);border-radius:8px;font-size:13px;background:var(--sp-card-bg,#fff);color:var(--sp-text,#1a1d2e);cursor:pointer;outline:none}
.sp-label{font-size:12px;color:#6b7280;flex-shrink:0}

/* Tags */
.sp-tags-row{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap}
.sp-tags-list{display:flex;gap:6px;flex-wrap:wrap;flex:1}
.sp-chip{padding:4px 12px;border-radius:20px;font-size:12px;font-weight:500;border:1.5px solid var(--sp-border,#e2e6f0);background:transparent;color:#6b7280;cursor:pointer;transition:all .12s}
.sp-chip-on{background:var(--tc,#4f6df5);color:#fff;border-color:var(--tc,#4f6df5)}
.sp-chip:not(.sp-chip-on):hover{border-color:#4f6df5;color:#4f6df5}

/* Global params */
.sp-param-row{display:flex;gap:6px;align-items:center;margin-bottom:6px}
.sp-p-id,.sp-p-defval{flex:1}.sp-p-name{flex:1.5}.sp-p-type{flex:1;min-width:80px}
.sp-param-del{background:none;border:1px solid #ffd0d0;color:#e53935;border-radius:6px;padding:5px 8px;cursor:pointer;font-size:11px;flex-shrink:0}.sp-param-del:hover{background:#e53935;color:#fff}

/* Criteria */
.sp-criteria-list{display:flex;flex-direction:column;gap:8px;min-height:50px;padding:2px}
.sp-criteria-empty{text-align:center;padding:20px;color:#9aa0b2;font-style:italic;font-size:12px;border:1.5px dashed var(--sp-border,#e2e6f0);border-radius:8px}
.sp-criteria-actions{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;padding-top:10px;border-top:1px dashed var(--sp-border,#e2e6f0)}
.sp-crit-row{background:var(--sp-input-bg,#f8f9fc);border:1.5px solid var(--sp-border,#e2e6f0);border-radius:10px;padding:12px 14px;transition:border-color .15s;position:relative}
.sp-crit-row:hover{border-color:#4f6df5}
.sp-crit-disabled{opacity:.4}
.sp-crit-header{display:flex;align-items:center;gap:8px}
.sp-crit-drag{color:#c0c4d0;cursor:grab;font-size:16px;flex-shrink:0}.sp-crit-drag:active{cursor:grabbing}
.sp-crit-badge{font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;white-space:nowrap;flex-shrink:0}
.sp-badge-indicator{background:#e0f0ff;color:#2962FF}
.sp-badge-custom{background:#f3f0ff;color:#7c3aed}
.sp-crit-label{flex:1;font-size:13px;font-weight:600;border:none;background:transparent;color:var(--sp-text,#1a1d2e);outline:none;min-width:0}
.sp-crit-label:focus{border-bottom:1.5px solid #4f6df5}
.sp-crit-ctrl{display:flex;align-items:center;gap:6px;flex-shrink:0}
.sp-crit-toggle{background:none;border:1.5px solid var(--sp-border,#e2e6f0);border-radius:50%;width:24px;height:24px;font-size:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .12s;color:#9aa0b2;padding:0}
.sp-ton{border-color:#22c55e;color:#22c55e}.sp-ton:hover{background:#dcfce7}
.sp-toff{border-color:#d1d5db;color:#d1d5db}.sp-toff:hover{background:#f9fafb}
.sp-crit-del{background:none;border:1px solid #ffd0d0;border-radius:6px;color:#e53935;cursor:pointer;font-size:11px;padding:3px 7px;transition:all .12s}.sp-crit-del:hover{background:#e53935;color:#fff}

/* Criterion sub-sections */
.sp-crit-inputs,.sp-crit-outputs,.sp-crit-custom-outs{margin-top:10px;padding-top:10px;border-top:1px solid var(--sp-border,#e2e6f0)}
.sp-crit-sub-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;color:#9aa0b2;margin-bottom:6px}
.sp-crit-inputs-grid{display:flex;flex-wrap:wrap;gap:8px}
.sp-crit-input{display:flex;flex-direction:column;gap:3px;min-width:90px;flex:1}
.sp-crit-input-label{font-size:11px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sp-crit-inp-val{padding:5px 8px;font-size:12px}
.sp-crit-outs-list{display:flex;flex-wrap:wrap;gap:5px}
.sp-out-chip{display:inline-block;padding:3px 9px;background:#e0f0ff;color:#2962FF;border-radius:5px;font-size:11px;font-family:monospace}
.sp-custom-out-row{display:flex;gap:6px;align-items:center;margin-bottom:5px}
.sp-cout-id{flex:1;font-family:monospace}.sp-cout-name{flex:1.5}

/* Property palette */
.sp-palette-section{background:var(--sp-card-bg,#fff);border:1.5px solid #d5deff;border-radius:12px;padding:14px 18px}
.sp-palette-title{font-size:11px;font-weight:600;color:#4f6df5;margin-bottom:10px;text-transform:uppercase;letter-spacing:.3px}
.sp-palette{display:flex;flex-wrap:wrap;gap:6px}
.sp-prop-pill{display:inline-flex;align-items:center;gap:0;padding:0;border:1.5px solid #d5deff;border-radius:6px;background:transparent;cursor:pointer;overflow:hidden;transition:all .12s;font-size:11px;font-family:monospace}
.sp-prop-pill:hover{border-color:#4f6df5;box-shadow:0 2px 6px #4f6df520}
.sp-prop-from{background:#e0f0ff;color:#4f6df5;padding:4px 7px;font-weight:700;font-size:10px;font-family:-apple-system,sans-serif;white-space:nowrap;border-right:1px solid #d5deff}
.sp-prop-name{padding:4px 7px;color:var(--sp-text,#1a1d2e)}
.sp-prop-pill-param .sp-prop-from{background:#f3f0ff;color:#7c3aed;border-right-color:#ddd0ff}
.sp-prop-pill-param{border-color:#ddd0ff}
.sp-prop-pill-param:hover{border-color:#7c3aed}

/* Expression */
.sp-expr-section{transition:border-color .2s,box-shadow .2s}
.sp-expr-active{border-color:#4f6df5!important;box-shadow:0 0 0 3px #4f6df515}
.sp-expr-wrap{}
.sp-expr-toolbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.sp-expr-lang{display:inline-block;padding:2px 7px;background:#1a1d2e;color:#4ec9b0;border-radius:4px;font-size:10px;font-weight:700;font-family:monospace;letter-spacing:.5px}
.sp-expr-hint-sm{font-size:11px;color:#9aa0b2;font-style:italic}
.sp-expr-hint-sm code{font-family:monospace;background:var(--sp-input-bg,#f8f9fc);padding:1px 4px;border-radius:3px;font-size:10px}
.sp-expr-ta{width:100%;padding:10px 12px;border:1.5px solid var(--sp-border,#e2e6f0);border-radius:8px;font-size:12px;font-family:'Consolas','Monaco','Menlo',monospace;line-height:1.6;color:var(--sp-text,#1a1d2e);background:var(--sp-input-bg,#f8f9fc);outline:none;resize:vertical;box-sizing:border-box;min-height:100px;transition:border-color .15s}
.sp-expr-ta:focus{border-color:#4f6df5;background:var(--sp-card-bg,#fff)}

/* Dark */
body.dark-theme{--sp-bg:#060810;--sp-card-bg:#0c0e1a;--sp-border:#1a1e34;--sp-text:#d1d4dc;--sp-input-bg:#080a14}
body.dark-theme .sp-search,body.dark-theme .sp-input,body.dark-theme .sp-textarea,body.dark-theme .sp-select{background:#080a14;border-color:#1a1e34;color:#d1d4dc}
body.dark-theme .sp-input:focus,body.dark-theme .sp-textarea:focus,body.dark-theme .sp-search:focus{background:#0c0e1a;border-color:#4f6df5}
body.dark-theme .sp-input-name{background:transparent;border-color:transparent}
body.dark-theme .sp-input-name:focus{background:#0c0e1a;border-color:#4f6df5;padding-left:12px}
body.dark-theme .sp-card,body.dark-theme .sp-section,body.dark-theme .sp-editor-header,body.dark-theme .sp-editor-sidebar,body.dark-theme .sp-palette-section{background:#0c0e1a;border-color:#1a1e34}
body.dark-theme .sp-palette-section{border-color:#2a2e54}
body.dark-theme .sp-card:hover{border-color:#4f6df5;box-shadow:0 4px 16px #4f6df518}
body.dark-theme .sp-sidebar-item{border-color:#1a1e34}.body.dark-theme .sp-sidebar-item:hover{background:#141826}
body.dark-theme .sp-sidebar-item-name{color:#d1d4dc}
body.dark-theme .sp-crit-row{background:#080a14;border-color:#1a1e34}
body.dark-theme .sp-crit-row:hover{border-color:#4f6df5}
body.dark-theme .sp-crit-inputs,body.dark-theme .sp-crit-outputs,body.dark-theme .sp-crit-custom-outs{border-top-color:#1a1e34}
body.dark-theme .sp-out-chip{background:#0a1c40;color:#4f9df5}
body.dark-theme .sp-expr-ta{background:#080a14;border-color:#1a1e34;color:#d1d4dc}
body.dark-theme .sp-expr-ta:focus{background:#0c0e1a;border-color:#4f6df5}
body.dark-theme .sp-badge-indicator{background:#0a1c40;color:#4f9df5}
body.dark-theme .sp-badge-custom{background:#1a0a40;color:#a78bfa}
body.dark-theme .sp-crit-label{color:#d1d4dc}
body.dark-theme .sp-prop-pill{border-color:#2a2e54;background:transparent}
body.dark-theme .sp-prop-pill:hover{border-color:#4f6df5}
body.dark-theme .sp-prop-from{background:#0a1c40;color:#4f9df5;border-right-color:#1a1e34}
body.dark-theme .sp-prop-name{color:#d1d4dc}
body.dark-theme .sp-prop-pill-param .sp-prop-from{background:#1a0a40;color:#a78bfa;border-right-color:#1a1e34}
body.dark-theme .sp-chip{border-color:#1a1e34;color:#8a90a8}
body.dark-theme .sp-chip-on{background:var(--tc,#4f6df5);color:#fff;border-color:var(--tc,#4f6df5)}
body.dark-theme .sp-filter-tag{border-color:#1a1e34;color:#8a90a8;background:transparent}
body.dark-theme .sp-filter-tag:hover{border-color:#4f6df5;color:#4f6df5}
body.dark-theme .sp-ftag-all{background:#4f6df5;color:#fff;border-color:#4f6df5}
body.dark-theme .sp-filter-tags{border-bottom-color:#1a1e34}
body.dark-theme .sp-criteria-empty{border-color:#1a1e34}
body.dark-theme .sp-criteria-actions{border-top-color:#1a1e34}
body.dark-theme .sp-palette-title{color:#4f9df5}
body.dark-theme .sp-expr-lang{background:#4f6df5}

/* Exit cards (SL / TP / Time) */
.sp-exit-section{padding:20px 22px}
.sp-exit-section-title{font-size:13px;font-weight:600;color:var(--sp-text,#1a1d2e);margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid var(--sp-border,#e2e6f0)}
.sp-exit-cards{display:flex;gap:12px;flex-wrap:wrap}
.sp-exit-card{flex:1;min-width:160px;max-width:320px;border:1.5px solid var(--sp-border,#e2e6f0);border-radius:12px;padding:16px 18px;cursor:pointer;transition:border-color .15s,box-shadow .15s;background:var(--sp-card-bg,#fff);user-select:none}
.sp-exit-card:hover{border-color:#4f6df5}
.sp-exit-card-active{border-color:var(--sp-text,#1a1d2e)!important;border-width:2px;box-shadow:0 2px 12px #00000012}
.sp-exit-card-title{font-size:15px;font-weight:600;color:var(--sp-text,#1a1d2e);margin-bottom:0}
.sp-exit-card-active .sp-exit-card-title{margin-bottom:12px}
.sp-exit-card-sub{font-size:12px;color:#9aa0b2;margin-bottom:10px;padding-top:8px;border-top:1px solid var(--sp-border,#e2e6f0)}
.sp-exit-card-field{margin-top:0}
.sp-exit-card-label{font-size:11px;color:#9aa0b2;margin-bottom:5px}
.sp-exit-inp{width:100%;padding:8px 10px;border:none;border-bottom:1px solid var(--sp-border,#e2e6f0);background:transparent;color:var(--sp-text,#1a1d2e);font-size:14px;outline:none;box-sizing:border-box;transition:border-color .15s}
.sp-exit-inp:focus{border-bottom-color:#4f6df5}

body.dark-theme .sp-exit-card{background:#0c0e1a;border-color:#1a1e34}
body.dark-theme .sp-exit-card:hover{border-color:#4f6df5}
body.dark-theme .sp-exit-card-active{border-color:#d1d4dc!important}
body.dark-theme .sp-exit-card-title{color:#d1d4dc}
body.dark-theme .sp-exit-card-sub{border-top-color:#1a1e34;color:#4a5068}
body.dark-theme .sp-exit-inp{border-bottom-color:#1a1e34;color:#d1d4dc}
body.dark-theme .sp-exit-inp:focus{border-bottom-color:#4f6df5}
body.dark-theme .sp-exit-section-title{color:#d1d4dc;border-bottom-color:#1a1e34}
    `;
    document.head.appendChild(s);
  }

  // ═══════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════

  async function init() {
    injectCSS();
    await loadDictionaries();
    await loadScriptsData();
  }

  window.setupsPage = { init, reload: loadScriptsData, getSetups: () => SP.setups };

})();