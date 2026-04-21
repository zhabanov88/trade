/**
 * setups-page.js  v4.0
 *
 * Изменения:
 *  - CATEGORIES → GET /api/setup-categories (таблица setup_categories)
 *  - Теги: множественные (meta.categories = ["code1","code2"])
 *  - Фильтр: множественный выбор тегов
 *  - Индикаторы: type_code="indicator" ИЛИ type_id=2
 */

(function () {
    'use strict';
  
    const SP = {
      setups: [], indicators: [], categories: [],
      timeframes: [], slModes: [], tpModes: [], timeExitModes: [],
      setupTypeId: null,
      searchQuery: '', activeCategories: [],
      currentSetup: null, editMode: false,
      loading: false, saving: false, error: null,
    };
  
    function emptySetup() {
      return {
        id: null, display_name: '', system_name: '', description: '',
        meta: {
          categories: [], timeframes: [], params_schema: [],
          entry_indicators: [], exit_indicators: [],
          stop_loss: { mode: '', value: '' },
          take_profit: { mode: '', multiplier: 2.0 },
          time_exit: { mode: '', value: '' },
        }
      };
    }
  
    async function apiFetch(url, opts = {}) {
      const r = await fetch(url, { credentials: 'include', ...opts });
      if (!r.ok) { const e = await r.json().catch(() => ({ error: r.statusText })); throw new Error(e.error || r.statusText); }
      return r.json();
    }
  
    async function loadDictionaries() {
      const [typesR, catsR, tfsR, slR, tpR, teR] = await Promise.allSettled([
        apiFetch('/api/script-types'),
        apiFetch('/api/setup-categories'),
        apiFetch('/api/intervals'),
        apiFetch('/api/sl-modes'),
        apiFetch('/api/tp-modes'),
        apiFetch('/api/time-exit-modes'),
      ]);
      if (typesR.status === 'fulfilled') {
        const t = typesR.value.find(x => x.code === 'setup');
        SP.setupTypeId = t?.id ?? null;
      }
      SP.categories    = catsR.status === 'fulfilled' ? catsR.value : [];
      SP.timeframes    = tfsR.status  === 'fulfilled' ? tfsR.value  : [];
      SP.slModes       = slR.status   === 'fulfilled' ? slR.value   : [];
      SP.tpModes       = tpR.status   === 'fulfilled' ? tpR.value   : [];
      SP.timeExitModes = teR.status   === 'fulfilled' ? teR.value   : [];
      if (!SP.slModes.length)       SP.slModes       = [{ code:'level', name:'\u041f\u043e \u0443\u0440\u043e\u0432\u043d\u044e' }, { code:'atr', name:'\u041f\u043e ATR' }];
      if (!SP.tpModes.length)       SP.tpModes       = [{ code:'fixed', name:'\u0424\u0438\u043a\u0441\u0438\u0440\u043e\u0432\u0430\u043d\u043d\u044b\u0439' }, { code:'trailing', name:'\u0422\u0440\u0435\u0439\u043b\u0438\u043d\u0433-\u0441\u0442\u043e\u043f' }, { code:'condition', name:'\u041f\u043e \u0443\u0441\u043b\u043e\u0432\u0438\u044e' }];
      if (!SP.timeExitModes.length) SP.timeExitModes = [{ code:'end_of_day', name:'\u041a\u043e\u043d\u0435\u0446 \u0434\u043d\u044f', has_value:false }, { code:'minutes', name:'\u041c\u0438\u043d\u0443\u0442', has_value:true, value_label:'\u041c\u0438\u043d\u0443\u0442' }, { code:'hours', name:'\u0427\u0430\u0441\u043e\u0432', has_value:true, value_label:'\u0427\u0430\u0441\u043e\u0432' }, { code:'days', name:'\u0414\u043d\u0435\u0439', has_value:true, value_label:'\u0414\u043d\u0435\u0439' }];
    }
  
    async function loadScriptsData() {
      SP.loading = true; renderPage();
      try {
        const all = await apiFetch('/api/javascript-scripts');
        // ИСПРАВЛЕНИЕ: фильтруем по type_code='indicator' ИЛИ type_id=2
        // Раньше запрос отрезал записи со status_id=NULL из-за AND s.code='active'
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
  
    async function saveSetup(setup) {
      if (!SP.setupTypeId) { await loadDictionaries(); if (!SP.setupTypeId) { SP.error = 'Тип "setup" не найден. Запустите миграцию.'; renderEditor(); return; } }
      SP.saving = true; renderEditor();
      const sysName = setup.system_name || (autoSlug(setup.display_name) + '_' + Date.now());
      try {
        const payload = { display_name: setup.display_name, system_name: sysName, description: setup.description || '', code: '{}', type_id: SP.setupTypeId, is_public: false, inputs_schema: [], is_overlay: false, meta: setup.meta };
        if (SP.editMode && setup.id) {
          await apiFetch(`/api/javascript-scripts/${setup.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        } else {
          await apiFetch('/api/javascript-scripts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        }
        SP.error = null; SP.currentSetup = null;
        await loadScriptsData();
      } catch (e) { SP.error = e.message; SP.saving = false; renderEditor(); }
      finally { SP.saving = false; }
    }
  
    async function deleteSetup(id) {
      if (!confirm('Удалить сетап?')) return;
      try { await apiFetch(`/api/javascript-scripts/${id}`, { method: 'DELETE' }); await loadScriptsData(); }
      catch (e) { alert('Ошибка: ' + e.message); }
    }
  
    function autoSlug(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'setup'; }
    function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function getRoot() { return document.getElementById('setups-page-root'); }
    function getCat(code) { return SP.categories.find(c => c.code === code); }
  
    // ── LIST ────────────────────────────────────────────
  
    function renderPage() {
      const root = getRoot(); if (!root) return;
      if (SP.currentSetup) { root.innerHTML = buildEditorHTML(); bindEditorEvents(); return; }
  
      const q = SP.searchQuery.toLowerCase();
      const filtered = SP.setups.filter(s => {
        const nameOk = (s.display_name || '').toLowerCase().includes(q);
        const catOk  = SP.activeCategories.length === 0 || SP.activeCategories.some(ac => (s._meta?.categories || []).includes(ac));
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
            <span class="sp-filter-label">Фильтр:</span>
            <button class="sp-filter-tag ${SP.activeCategories.length===0?'sp-filter-tag-all-active':''}" id="sp-filter-all">Все</button>
            ${SP.categories.map(c => {
              const active = SP.activeCategories.includes(c.code);
              return '<button class="sp-filter-tag ' + (active?'sp-filter-tag-active':'') + '" data-cat="' + esc(c.code) + '" style="' + (active?'--tag-color:'+esc(c.color)+';':'') + '" title="' + esc(c.description||'') + '">' + esc(c.name) + '</button>';
            }).join('')}
            ${SP.activeCategories.length > 0 ? '<button class="sp-filter-clear" id="sp-filter-clear">✕ Сбросить</button>' : ''}
          </div>` : ''}
          <div class="sp-list">
            ${SP.loading ? '<div class="sp-loading">Загрузка...</div>' : ''}
            ${SP.error   ? '<div class="sp-error">'+esc(SP.error)+'</div>' : ''}
            ${!SP.loading && !SP.error && !filtered.length ? '<div class="sp-empty">'+(SP.activeCategories.length > 0 ? 'Нет сетапов с выбранными тегами.' : 'Нет сетапов. Нажмите «добавить».')+'</div>' : ''}
            ${filtered.map(s => {
              const cats = (s._meta?.categories || []).map(code => {
                const c = getCat(code);
                return c ? '<span class="sp-tag" style="--tag-color:'+esc(c.color)+'">'+esc(c.name)+'</span>' : '<span class="sp-tag">'+esc(code)+'</span>';
              }).join('');
              return '<div class="sp-card"><div class="sp-card-body"><div class="sp-card-name">'+esc(s.display_name)+'</div>'+(cats?'<div class="sp-card-tags">'+cats+'</div>':'')+(s.description?'<div class="sp-card-desc">'+esc(s.description)+'</div>':'')+'<div class="sp-card-meta">Таймфреймы: '+(s._meta?.timeframes?.length ? s._meta.timeframes.join(', ') : 'Все')+'</div></div><div class="sp-card-actions"><button class="sp-card-btn sp-card-edit" data-id="'+s.id+'">Редактировать</button><button class="sp-card-btn sp-card-del" data-id="'+s.id+'">Удалить</button></div></div>';
            }).join('')}
          </div>
        </div>`;
  
      root.querySelector('#sp-add-btn')?.addEventListener('click', () => {
        const s = emptySetup(); s.meta.stop_loss.mode = SP.slModes[0]?.code||''; s.meta.take_profit.mode = SP.tpModes[0]?.code||''; s.meta.time_exit.mode = SP.timeExitModes[0]?.code||'';
        SP.currentSetup = s; SP.editMode = false; SP.error = null; renderPage();
      });
      root.querySelector('#sp-search')?.addEventListener('input', e => { SP.searchQuery = e.target.value; renderPage(); });
      root.querySelector('#sp-filter-all')?.addEventListener('click', () => { SP.activeCategories = []; renderPage(); });
      root.querySelector('#sp-filter-clear')?.addEventListener('click', () => { SP.activeCategories = []; renderPage(); });
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
          SP.currentSetup = { ...s, meta: JSON.parse(JSON.stringify(s._meta || {})) };
          SP.editMode = true; SP.error = null; renderPage();
        });
      });
      root.querySelectorAll('.sp-card-del').forEach(btn => { btn.addEventListener('click', () => deleteSetup(+btn.dataset.id)); });
    }
  
    // ── EDITOR ──────────────────────────────────────────
  
    function buildEditorHTML() {
      const s = SP.currentSetup; const m = s.meta || {};
      const sl = m.stop_loss   || { mode: SP.slModes[0]?.code||'',       value: '' };
      const tp = m.take_profit || { mode: SP.tpModes[0]?.code||'',       multiplier: 2.0 };
      const te = m.time_exit   || { mode: SP.timeExitModes[0]?.code||'', value: '' };
      const params = m.params_schema || []; const entryInd = m.entry_indicators || []; const exitInd = m.exit_indicators || [];
      const selCats = m.categories || [];
      return `
      <div class="sp-editor">
        <div class="sp-editor-header">
          <button class="sp-back-btn" id="sp-back-btn">← Назад</button>
          <h2 class="sp-editor-title" id="sp-editor-title">${esc(s.display_name || 'Новый сетап')}</h2>
          <div class="sp-editor-actions">
            <button class="sp-btn sp-btn-ghost" id="sp-cancel-btn">Отмена</button>
            ${SP.editMode && s.id ? '<button class="sp-btn sp-btn-secondary" id="sp-run-bt-btn">Запустить бэктест</button>' : ''}
            <button class="sp-btn sp-btn-primary" id="sp-save-btn" ${SP.saving?'disabled':''}>${SP.saving ? 'Сохранение...' : 'Сохранить'}</button>
          </div>
        </div>
        ${SP.error ? '<div class="sp-error-banner">'+esc(SP.error)+'</div>' : ''}
        <div class="sp-editor-body">
          <div class="sp-editor-main">
            <div class="sp-section">
              <input class="sp-input sp-input-name" id="sp-name" type="text" placeholder="Название сетапа..." value="${esc(s.display_name)}">
              <textarea class="sp-textarea" id="sp-desc" rows="2" placeholder="Описание...">${esc(s.description||'')}</textarea>
              <div class="sp-tags-row">
                <span class="sp-label">Теги:</span>
                <div class="sp-tags-list">
                  ${SP.categories.length === 0
                    ? '<span class="sp-hint-small">Нет категорий. Запустите миграцию 004.</span>'
                    : SP.categories.map(c => {
                        const active = selCats.includes(c.code);
                        return '<button class="sp-chip '+(active?'sp-chip-active':'')+'" data-cat="'+esc(c.code)+'" style="'+(active?'--tag-color:'+esc(c.color)+';':'')+'" title="'+esc(c.description||'')+'">'+esc(c.name)+'</button>';
                      }).join('')}
                </div>
              </div>
              <div class="sp-tf-row">
                <span class="sp-label">Таймфреймы:</span>
                <div class="sp-tf-chips">
                  ${SP.timeframes.length === 0
                    ? '<span class="sp-hint-small">Нет интервалов</span>'
                    : SP.timeframes.map(tf => '<button class="sp-chip '+((m.timeframes||[]).includes(tf.code)?'sp-chip-active':'')+'" data-tf="'+esc(tf.code)+'" title="'+esc(tf.name)+'">'+esc(tf.name)+'</button>').join('')}
                </div>
              </div>
            </div>
            <div class="sp-section">
              <div class="sp-section-title">Параметры сетапа</div>
              <div class="sp-params-list" id="sp-params-list">${params.map((p,i) => buildParamRow(p,i)).join('')}</div>
              <button class="sp-btn sp-btn-ghost sp-btn-sm" id="sp-add-param">＋ Добавить параметр</button>
            </div>
            <div class="sp-section">
              <div class="sp-section-title">Условия входа</div>
              <div class="sp-ind-list" id="sp-entry-list">${entryInd.map((ind,i) => buildIndicatorRow(ind,i,'entry',params)).join('')}</div>
              <div class="sp-add-ind-hint">← Нажмите на индикатор в правом списке</div>
            </div>
            <div class="sp-section">
              <div class="sp-section-title">Условия выхода</div>
              <div class="sp-subsect-title">Стоп-лосс</div>
              <div class="sp-mode-row">${SP.slModes.map(m2 => '<button class="sp-mode-btn '+(sl.mode===m2.code?'sp-mode-active':'')+'" data-mode="'+esc(m2.code)+'" data-target="sl" title="'+esc(m2.description||'')+'">'+esc(m2.name)+'</button>').join('')}</div>
              <div id="sp-sl-detail">${buildSLDetail(sl, SP.slModes.find(x=>x.code===sl.mode))}</div>
              <div class="sp-subsect-title" style="margin-top:18px">Тейк-профит</div>
              <div class="sp-mode-row">${SP.tpModes.map(m2 => '<button class="sp-mode-btn '+(tp.mode===m2.code?'sp-mode-active':'')+'" data-mode="'+esc(m2.code)+'" data-target="tp" title="'+esc(m2.description||'')+'">'+esc(m2.name)+'</button>').join('')}</div>
              <div id="sp-tp-detail">${buildTPDetail(tp, SP.tpModes.find(x=>x.code===tp.mode))}</div>
              <div class="sp-subsect-title" style="margin-top:18px">Дополнительные условия выхода</div>
              <div class="sp-ind-list" id="sp-exit-list">${exitInd.map((ind,i) => buildIndicatorRow(ind,i,'exit',params)).join('')}</div>
            </div>
            <div class="sp-section">
              <div class="sp-section-title">Выход по времени</div>
              <div class="sp-mode-row" id="sp-time-modes-row">${SP.timeExitModes.map(m2 => '<button class="sp-mode-btn '+(te.mode===m2.code?'sp-mode-active':'')+'" data-mode="'+esc(m2.code)+'" data-target="time" title="'+esc(m2.description||'')+'">'+esc(m2.name)+'</button>').join('')}</div>
              <div id="sp-time-detail">${buildTimeDetail(te, SP.timeExitModes.find(x=>x.code===te.mode))}</div>
            </div>
          </div>
          <div class="sp-editor-sidebar">
            <div class="sp-sidebar-title">Доступные критерии</div>
            ${SP.indicators.length === 0 ? '<div class="sp-sidebar-empty">Нет индикаторов.<br>Убедитесь что есть записи с type_id=2 в javascript_scripts.</div>' : ''}
            <div class="sp-sidebar-list">
              ${SP.indicators.map(ind => '<div class="sp-sidebar-item" data-ind-id="'+ind.id+'" data-ind-name="'+esc(ind.display_name)+'" data-ind-inputs="'+esc(JSON.stringify(ind.inputs_schema||[]))+'" ><span class="sp-sidebar-item-name">'+esc(ind.display_name)+'</span>'+(ind.description?'<span class="sp-sidebar-item-desc">'+esc(ind.description)+'</span>':'')+'</div>').join('')}
            </div>
          </div>
        </div>
      </div>`;
    }
  
    function buildSLDetail(sl, mode) {
      if (!mode) return '';
      if (['level','pct','points'].includes(mode.code)) return '<div class="sp-input-wrap"><span class="sp-input-label">'+esc(mode.name)+'</span><input class="sp-input" id="sp-sl-value" type="number" step="any" placeholder="Введите значение" value="'+esc(sl.value||'')+'"></div>';
      if (mode.code === 'atr') return '<div class="sp-input-wrap"><span class="sp-input-label">Множитель ATR</span><input class="sp-input" id="sp-sl-atr" type="number" step="0.1" placeholder="1.5" value="'+esc(sl.atr_multiplier||1.5)+'"></div>';
      if (mode.code === 'swing') return '<span class="sp-hint">До ближайшего swing high/low</span>';
      return '';
    }
    function buildTPDetail(tp, mode) {
      if (!mode) return '';
      if (mode.code === 'fixed') return '<div class="sp-input-wrap"><span class="sp-input-label">Множитель стопа (R:R)</span><input class="sp-input" id="sp-tp-mult" type="number" step="0.1" placeholder="2.0" value="'+esc(tp.multiplier||2.0)+'"></div>';
      if (mode.code === 'trailing') return '<span class="sp-hint">Следует за ценой</span>';
      if (mode.code === 'condition') return '<div class="sp-input-wrap"><span class="sp-input-label">Условие</span><input class="sp-input" id="sp-tp-cond" type="text" placeholder="Индикатор или паттерн" value="'+esc(tp.condition||'')+'"></div>';
      if (['level','pct','points'].includes(mode.code)) return '<div class="sp-input-wrap"><span class="sp-input-label">'+esc(mode.name)+'</span><input class="sp-input" id="sp-tp-value" type="number" step="any" placeholder="Введите значение" value="'+esc(tp.value||'')+'"></div>';
      return '';
    }
    function buildTimeDetail(te, mode) {
      if (!mode || !mode.has_value) return '';
      return '<div class="sp-input-wrap" id="sp-time-val-wrap"><span class="sp-input-label">'+esc(mode.value_label||mode.name)+'</span><input class="sp-input" id="sp-time-value" type="number" placeholder="Введите значение" value="'+esc(te.value||'')+'"></div>';
    }
    function buildParamRow(p, i) {
      return '<div class="sp-param-row" data-idx="'+i+'"><input class="sp-input sp-p-id" type="text" placeholder="id" data-field="id" value="'+esc(p.id||'')+'"><input class="sp-input sp-p-name" type="text" placeholder="Название" data-field="name" value="'+esc(p.name||'')+'"><select class="sp-select sp-p-type" data-field="type">'+['integer','float','string','bool'].map(t=>'<option value="'+t+'" '+(p.type===t?'selected':'')+'>'+t+'</option>').join('')+'</select><input class="sp-input sp-p-defval" type="text" placeholder="По умолчанию" data-field="defval" value="'+esc(p.defval??'')+'"><button class="sp-param-del" data-idx="'+i+'">✕</button></div>';
    }
    function buildIndicatorRow(ind, i, listType, paramsSchema) {
      const inputs = ind.inputs_schema || []; const ps = paramsSchema || [];
      const inputsHtml = inputs.length ? '<div class="sp-ind-inputs">'+inputs.map(inp => '<div class="sp-ind-inp-row"><span class="sp-ind-inp-label">'+esc(inp.name||inp.id)+':</span><input class="sp-input sp-ind-inp-val" type="text" data-ind-idx="'+i+'" data-list="'+listType+'" data-inp-id="'+esc(inp.id)+'" placeholder="'+esc(String(inp.defval??''))+'" value="'+esc(ind.params?.[inp.id]??'')+'"><select class="sp-select sp-ind-bind" data-ind-idx="'+i+'" data-list="'+listType+'" data-inp-id="'+esc(inp.id)+'"><option value="">— параметр сетапа —</option>'+ps.map(p=>'<option value="'+esc(p.id)+'" '+((ind.paramBindings||{})[inp.id]===p.id?'selected':'')+'>'+esc(p.name||p.id)+'</option>').join('')+'</select></div>').join('')+'</div>' : '<div class="sp-ind-no-params">Нет параметров</div>';
      return '<div class="sp-ind-row" data-idx="'+i+'" data-list="'+listType+'"><span class="sp-ind-drag">⠿</span><div class="sp-ind-body"><div class="sp-ind-name">'+esc(ind.scriptName||'Индикатор')+'</div>'+inputsHtml+'</div><button class="sp-ind-del" data-idx="'+i+'" data-list="'+listType+'">✕</button></div>';
    }
  
    // ── EVENTS ──────────────────────────────────────────
  
    function bindEditorEvents() {
      const root = getRoot(); if (!root) return;
      const s = SP.currentSetup; const m = s.meta = s.meta || {};
      const goBack = () => { SP.currentSetup = null; SP.error = null; renderPage(); };
      root.querySelector('#sp-back-btn')?.addEventListener('click', goBack);
      root.querySelector('#sp-cancel-btn')?.addEventListener('click', goBack);
      root.querySelector('#sp-run-bt-btn')?.addEventListener('click', () => { if (window.backtestPage) window.backtestPage.preselect(s.id, s.display_name); if (window.spRouter) window.spRouter.navigate('backtest'); });
      root.querySelector('#sp-name')?.addEventListener('input', e => { s.display_name = e.target.value; root.querySelector('#sp-editor-title').textContent = e.target.value || 'Новый сетап'; if (!SP.editMode) s.system_name = autoSlug(e.target.value); });
      root.querySelector('#sp-desc')?.addEventListener('input', e => { s.description = e.target.value; });
      root.querySelectorAll('.sp-chip[data-cat]').forEach(chip => {
        chip.addEventListener('click', () => {
          if (!m.categories) m.categories = [];
          const code = chip.dataset.cat; const cat = getCat(code); const idx = m.categories.indexOf(code);
          if (idx >= 0) { m.categories.splice(idx, 1); chip.classList.remove('sp-chip-active'); chip.style.removeProperty('--tag-color'); }
          else { m.categories.push(code); chip.classList.add('sp-chip-active'); if (cat?.color) chip.style.setProperty('--tag-color', cat.color); }
        });
      });
      root.querySelectorAll('.sp-chip[data-tf]').forEach(chip => {
        chip.addEventListener('click', () => {
          if (!m.timeframes) m.timeframes = [];
          const code = chip.dataset.tf; const idx = m.timeframes.indexOf(code);
          if (idx >= 0) m.timeframes.splice(idx, 1); else m.timeframes.push(code);
          chip.classList.toggle('sp-chip-active', m.timeframes.includes(code));
        });
      });
      root.querySelector('#sp-add-param')?.addEventListener('click', () => { if (!m.params_schema) m.params_schema = []; m.params_schema.push({ id:'', name:'', type:'integer', defval:'' }); reRenderParams(); });
      bindParamList();
      root.querySelectorAll('.sp-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const target = btn.dataset.target; const code = btn.dataset.mode;
          if (target === 'sl') { m.stop_loss = { mode: code }; document.getElementById('sp-sl-detail').innerHTML = buildSLDetail(m.stop_loss, SP.slModes.find(x=>x.code===code)); bindSLInputs(); }
          if (target === 'tp') { m.take_profit = { mode: code }; document.getElementById('sp-tp-detail').innerHTML = buildTPDetail(m.take_profit, SP.tpModes.find(x=>x.code===code)); bindTPInputs(); }
          if (target === 'time') { m.time_exit = { mode: code }; document.getElementById('sp-time-detail').innerHTML = buildTimeDetail(m.time_exit, SP.timeExitModes.find(x=>x.code===code)); bindTimeInput(); }
          root.querySelectorAll('.sp-mode-btn[data-target="'+target+'"]').forEach(b => b.classList.toggle('sp-mode-active', b.dataset.mode === code));
        });
      });
      bindSLInputs(); bindTPInputs(); bindTimeInput();
      root.querySelectorAll('.sp-sidebar-item').forEach(item => {
        item.addEventListener('click', () => {
          if (!m.entry_indicators) m.entry_indicators = [];
          let inputs = []; try { inputs = JSON.parse(item.dataset.indInputs||'[]'); } catch(_) {}
          m.entry_indicators.push({ scriptId: +item.dataset.indId, scriptName: item.dataset.indName, inputs_schema: inputs, params: {}, paramBindings: {} });
          reRenderEntryList();
        });
      });
      bindIndicatorList('entry'); bindIndicatorList('exit');
      root.querySelector('#sp-save-btn')?.addEventListener('click', () => { if (!s.display_name.trim()) { alert('Введите название'); return; } saveSetup(s); });
    }
  
    function bindSLInputs() {
      const m = SP.currentSetup?.meta; if (!m) return;
      document.getElementById('sp-sl-value')?.addEventListener('input', e => { if (!m.stop_loss) m.stop_loss={}; m.stop_loss.value = e.target.value; });
      document.getElementById('sp-sl-atr')?.addEventListener('input', e => { if (!m.stop_loss) m.stop_loss={}; m.stop_loss.atr_multiplier = parseFloat(e.target.value); });
    }
    function bindTPInputs() {
      const m = SP.currentSetup?.meta; if (!m) return;
      document.getElementById('sp-tp-mult')?.addEventListener('input', e => { if (!m.take_profit) m.take_profit={}; m.take_profit.multiplier = parseFloat(e.target.value); });
      document.getElementById('sp-tp-cond')?.addEventListener('input', e => { if (!m.take_profit) m.take_profit={}; m.take_profit.condition = e.target.value; });
      document.getElementById('sp-tp-value')?.addEventListener('input', e => { if (!m.take_profit) m.take_profit={}; m.take_profit.value = e.target.value; });
    }
    function bindTimeInput() {
      const m = SP.currentSetup?.meta; if (!m) return;
      document.getElementById('sp-time-value')?.addEventListener('input', e => { if (!m.time_exit) m.time_exit={}; m.time_exit.value = e.target.value; });
    }
    function bindParamList() {
      const root = getRoot(); const el = root?.querySelector('#sp-params-list'); if (!el) return;
      el.addEventListener('input', e => { const row = e.target.closest('.sp-param-row'); if (!row) return; const m = SP.currentSetup?.meta; const idx = +row.dataset.idx; const fld = e.target.dataset.field; if (m?.params_schema?.[idx] !== undefined && fld) m.params_schema[idx][fld] = e.target.value; });
      el.addEventListener('click', e => { const del = e.target.closest('.sp-param-del'); if (!del) return; SP.currentSetup?.meta?.params_schema?.splice(+del.dataset.idx, 1); reRenderParams(); });
    }
    function bindIndicatorList(listType) {
      const root = getRoot(); const el = root?.querySelector(listType==='entry'?'#sp-entry-list':'#sp-exit-list'); if (!el) return;
      el.addEventListener('input', e => { const m = SP.currentSetup?.meta; const arr = listType==='entry'?m?.entry_indicators:m?.exit_indicators; if (!arr) return; if (e.target.classList.contains('sp-ind-inp-val')) { const idx = +e.target.dataset.indIdx; if (!arr[idx].params) arr[idx].params={}; arr[idx].params[e.target.dataset.inpId] = e.target.value; } });
      el.addEventListener('change', e => { const m = SP.currentSetup?.meta; const arr = listType==='entry'?m?.entry_indicators:m?.exit_indicators; if (!arr) return; if (e.target.classList.contains('sp-ind-bind')) { const idx = +e.target.dataset.indIdx; if (!arr[idx].paramBindings) arr[idx].paramBindings={}; arr[idx].paramBindings[e.target.dataset.inpId] = e.target.value; } });
      el.addEventListener('click', e => { const del = e.target.closest('.sp-ind-del'); if (!del || del.dataset.list !== listType) return; const m = SP.currentSetup?.meta; const arr = listType==='entry'?m?.entry_indicators:m?.exit_indicators; arr?.splice(+del.dataset.idx, 1); if (listType==='entry') reRenderEntryList(); else reRenderExitList(); });
    }
  
    function reRenderParams() { const root=getRoot(); const m=SP.currentSetup?.meta; const el=root?.querySelector('#sp-params-list'); if (!el) return; el.innerHTML=(m?.params_schema||[]).map((p,i)=>buildParamRow(p,i)).join(''); bindParamList(); reRenderEntryList(); reRenderExitList(); }
    function reRenderEntryList() { const root=getRoot(); const m=SP.currentSetup?.meta; const el=root?.querySelector('#sp-entry-list'); if (!el) return; el.innerHTML=(m?.entry_indicators||[]).map((ind,i)=>buildIndicatorRow(ind,i,'entry',m?.params_schema||[])).join(''); bindIndicatorList('entry'); }
    function reRenderExitList() { const root=getRoot(); const m=SP.currentSetup?.meta; const el=root?.querySelector('#sp-exit-list'); if (!el) return; el.innerHTML=(m?.exit_indicators||[]).map((ind,i)=>buildIndicatorRow(ind,i,'exit',m?.params_schema||[])).join(''); bindIndicatorList('exit'); }
    function renderEditor() { const root=getRoot(); if (!root||!SP.currentSetup) return; root.innerHTML=buildEditorHTML(); bindEditorEvents(); }
  
    // ── CSS ─────────────────────────────────────────────
  
    function injectCSS() {
      if (document.getElementById('sp-styles')) return;
      const s = document.createElement('style'); s.id = 'sp-styles';
      s.textContent = `
  #setups-page-root{height:100%;overflow:auto;background:var(--sp-bg,#f8f9fc);font-family:-apple-system,'Segoe UI',sans-serif}
  .sp-page{max-width:920px;margin:0 auto;padding:40px 24px}
  .sp-page-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px}
  .sp-title{font-size:28px;font-weight:700;color:var(--sp-text,#1a1d2e);margin:0;letter-spacing:-.5px}
  .sp-toolbar{margin-bottom:12px}
  .sp-search-wrap{position:relative}
  .sp-search-icon{position:absolute;left:12px;top:50%;transform:translateY(-50%);width:16px;height:16px;color:#9aa0b2;pointer-events:none}
  .sp-search{width:100%;padding:10px 12px 10px 36px;border:1.5px solid var(--sp-border,#e2e6f0);border-radius:10px;background:var(--sp-card-bg,#fff);color:var(--sp-text,#1a1d2e);font-size:14px;outline:none;box-sizing:border-box;transition:border-color .15s}
  .sp-search:focus{border-color:#4f6df5}
  .sp-filter-tags{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--sp-border,#e2e6f0)}
  .sp-filter-label{font-size:12px;color:#9aa0b2;flex-shrink:0}
  .sp-filter-tag{padding:5px 13px;border-radius:20px;font-size:12px;font-weight:500;border:1.5px solid var(--sp-border,#e2e6f0);background:transparent;color:#6b7280;cursor:pointer;transition:all .12s}
  .sp-filter-tag:hover{border-color:#4f6df5;color:#4f6df5}
  .sp-filter-tag-all-active{background:#1a1d2e;color:#fff;border-color:#1a1d2e}
  .sp-filter-tag-active{background:var(--tag-color,#4f6df5);color:#fff;border-color:var(--tag-color,#4f6df5)}
  .sp-filter-clear{padding:5px 12px;border-radius:20px;font-size:12px;border:1px solid #ffd0d0;color:#e53935;background:transparent;cursor:pointer}.sp-filter-clear:hover{background:#e53935;color:#fff}
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
  .sp-tag{display:inline-block;padding:2px 10px;background:color-mix(in srgb,var(--tag-color,#4f6df5) 12%,transparent);color:var(--tag-color,#4f6df5);border:1px solid color-mix(in srgb,var(--tag-color,#4f6df5) 30%,transparent);border-radius:20px;font-size:11px;font-weight:600}
  .sp-btn{padding:9px 20px;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;border:none;transition:all .15s}
  .sp-btn-primary{background:#1a1d2e;color:#fff}.sp-btn-primary:hover{background:#2d3250}.sp-btn-primary:disabled{opacity:.5;cursor:default}
  .sp-btn-secondary{background:#f0f4ff;color:#4f6df5;border:1.5px solid #d5deff}.sp-btn-secondary:hover{background:#4f6df5;color:#fff}
  .sp-btn-ghost{background:transparent;color:#6b7280;border:1.5px solid var(--sp-border,#e2e6f0)}.sp-btn-ghost:hover{background:#f5f5f5}
  .sp-btn-sm{padding:5px 12px;font-size:12px}
  .sp-editor{display:flex;flex-direction:column;height:100%}
  .sp-editor-header{display:flex;align-items:center;gap:12px;padding:14px 24px;border-bottom:1.5px solid var(--sp-border,#e2e6f0);background:var(--sp-card-bg,#fff);flex-shrink:0}
  .sp-back-btn{background:none;border:none;font-size:14px;color:#4f6df5;cursor:pointer;padding:5px 10px;border-radius:7px;font-weight:500}.sp-back-btn:hover{background:#f0f4ff}
  .sp-editor-title{flex:1;font-size:18px;font-weight:700;color:var(--sp-text,#1a1d2e);margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sp-editor-actions{display:flex;gap:8px;flex-shrink:0}
  .sp-error-banner{background:#fce4ec;color:#c62828;padding:10px 24px;font-size:13px;flex-shrink:0}
  .sp-editor-body{display:flex;flex:1;overflow:hidden}
  .sp-editor-main{flex:1;overflow-y:auto;padding:20px 24px;display:flex;flex-direction:column;gap:14px}
  .sp-editor-sidebar{width:230px;flex-shrink:0;border-left:1.5px solid var(--sp-border,#e2e6f0);background:var(--sp-card-bg,#fff);overflow-y:auto;display:flex;flex-direction:column}
  .sp-sidebar-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#9aa0b2;padding:16px 16px 10px}
  .sp-sidebar-empty{font-size:12px;color:#9aa0b2;padding:0 16px 12px;font-style:italic;line-height:1.6}
  .sp-sidebar-list{display:flex;flex-direction:column}
  .sp-sidebar-item{padding:10px 16px;cursor:pointer;border-bottom:1px solid var(--sp-border,#e2e6f0);transition:background .12s}.sp-sidebar-item:hover{background:#f0f4ff}
  .sp-sidebar-item-name{display:block;font-size:13px;font-weight:500;color:var(--sp-text,#1a1d2e)}
  .sp-sidebar-item-desc{display:block;font-size:11px;color:#9aa0b2;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sp-section{background:var(--sp-card-bg,#fff);border:1.5px solid var(--sp-border,#e2e6f0);border-radius:12px;padding:18px 20px}
  .sp-section-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;color:var(--sp-text,#1a1d2e);margin-bottom:14px}
  .sp-subsect-title{font-size:12px;font-weight:600;color:#6b7280;margin-bottom:8px}
  .sp-input{padding:9px 12px;border:1.5px solid var(--sp-border,#e2e6f0);border-radius:8px;font-size:14px;color:var(--sp-text,#1a1d2e);background:var(--sp-input-bg,#f8f9fc);outline:none;transition:border-color .15s;box-sizing:border-box;width:100%}
  .sp-input:focus{border-color:#4f6df5;background:var(--sp-card-bg,#fff)}
  .sp-input-name{font-size:20px;font-weight:700;border-color:transparent;background:transparent;padding-left:0;margin-bottom:10px}
  .sp-input-name:focus{border-color:#4f6df5;background:var(--sp-card-bg,#fff);padding-left:12px}
  .sp-textarea{width:100%;padding:9px 12px;border:1.5px solid var(--sp-border,#e2e6f0);border-radius:8px;font-size:13px;color:var(--sp-text,#1a1d2e);background:var(--sp-input-bg,#f8f9fc);outline:none;resize:vertical;box-sizing:border-box;margin-bottom:10px}
  .sp-textarea:focus{border-color:#4f6df5}
  .sp-select{padding:7px 10px;border:1.5px solid var(--sp-border,#e2e6f0);border-radius:8px;font-size:13px;background:var(--sp-card-bg,#fff);color:var(--sp-text,#1a1d2e);cursor:pointer;outline:none}
  .sp-label{font-size:12px;color:#6b7280;flex-shrink:0}
  .sp-hint{font-size:12px;color:#9aa0b2;font-style:italic;display:block;margin-top:8px}
  .sp-hint-small{font-size:11px;color:#9aa0b2;font-style:italic}
  .sp-tags-row{display:flex;align-items:flex-start;gap:8px;margin-bottom:10px;flex-wrap:wrap}
  .sp-tags-list{display:flex;gap:6px;flex-wrap:wrap;flex:1}
  .sp-tf-row{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;margin-top:10px}
  .sp-tf-chips{display:flex;gap:6px;flex-wrap:wrap;flex:1}
  .sp-chip{padding:4px 12px;border-radius:20px;font-size:12px;font-weight:500;border:1.5px solid var(--sp-border,#e2e6f0);background:transparent;color:#6b7280;cursor:pointer;transition:all .12s}
  .sp-chip[data-cat].sp-chip-active{background:var(--tag-color,#4f6df5);color:#fff;border-color:var(--tag-color,#4f6df5)}
  .sp-chip[data-tf].sp-chip-active{background:#1a1d2e;color:#fff;border-color:#1a1d2e}
  .sp-chip:not(.sp-chip-active):hover{border-color:#4f6df5;color:#4f6df5}
  .sp-params-list{display:flex;flex-direction:column;gap:6px;margin-bottom:10px}
  .sp-param-row{display:flex;gap:6px;align-items:center}
  .sp-p-id,.sp-p-defval{flex:1}.sp-p-name{flex:1.5}.sp-p-type{flex:1;min-width:80px}
  .sp-param-del{background:none;border:1px solid #ffd0d0;color:#e53935;border-radius:6px;padding:5px 8px;cursor:pointer;font-size:11px;flex-shrink:0}.sp-param-del:hover{background:#e53935;color:#fff}
  .sp-ind-list{display:flex;flex-direction:column;gap:8px}
  .sp-ind-row{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;background:var(--sp-input-bg,#f8f9fc);border:1.5px solid var(--sp-border,#e2e6f0);border-radius:10px}
  .sp-ind-drag{color:#c0c4d0;cursor:grab;font-size:18px;flex-shrink:0;padding-top:2px}
  .sp-ind-body{flex:1;min-width:0}.sp-ind-name{font-size:13px;font-weight:600;color:var(--sp-text,#1a1d2e);margin-bottom:6px}
  .sp-ind-no-params{font-size:11px;color:#9aa0b2;font-style:italic}
  .sp-ind-inputs{display:flex;flex-direction:column;gap:5px}
  .sp-ind-inp-row{display:flex;align-items:center;gap:8px}
  .sp-ind-inp-label{font-size:11px;color:#9aa0b2;flex-shrink:0;min-width:80px}
  .sp-ind-inp-val{flex:1;padding:5px 8px;font-size:12px}
  .sp-ind-del{background:none;border:1px solid #ffd0d0;color:#e53935;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:11px;flex-shrink:0;align-self:flex-start;margin-top:2px}.sp-ind-del:hover{background:#e53935;color:#fff}
  .sp-add-ind-hint{font-size:12px;color:#9aa0b2;text-align:center;padding:10px;font-style:italic}
  .sp-mode-row{display:flex;gap:8px;flex-wrap:wrap}
  .sp-mode-btn{padding:7px 14px;border:1.5px solid var(--sp-border,#e2e6f0);border-radius:10px;background:var(--sp-card-bg,#fff);color:#6b7280;font-size:13px;font-weight:500;cursor:pointer;transition:all .12s}
  .sp-mode-btn:hover{border-color:#4f6df5;color:#4f6df5}
  .sp-mode-active{background:#1a1d2e!important;color:#fff!important;border-color:#1a1d2e!important}
  .sp-input-wrap{margin-top:10px}
  .sp-input-label{display:block;font-size:12px;color:#9aa0b2;margin-bottom:4px}
  body.dark-theme{--sp-bg:#060810;--sp-card-bg:#0c0e1a;--sp-border:#1a1e34;--sp-text:#d1d4dc;--sp-input-bg:#080a14}
  body.dark-theme .sp-search,body.dark-theme .sp-input,body.dark-theme .sp-textarea,body.dark-theme .sp-select{background:#080a14;border-color:#1a1e34;color:#d1d4dc}
  body.dark-theme .sp-input:focus,body.dark-theme .sp-textarea:focus,body.dark-theme .sp-search:focus{background:#0c0e1a;border-color:#4f6df5}
  body.dark-theme .sp-input-name{background:transparent;border-color:transparent}
  body.dark-theme .sp-input-name:focus{background:#0c0e1a;border-color:#4f6df5;padding-left:12px}
  body.dark-theme .sp-card,body.dark-theme .sp-section,body.dark-theme .sp-editor-header,body.dark-theme .sp-editor-sidebar{background:#0c0e1a;border-color:#1a1e34}
  body.dark-theme .sp-card:hover{border-color:#4f6df5;box-shadow:0 4px 16px #4f6df518}
  body.dark-theme .sp-sidebar-item{border-color:#1a1e34}
  body.dark-theme .sp-sidebar-item:hover{background:#141826}
  body.dark-theme .sp-sidebar-item-name{color:#d1d4dc}
  body.dark-theme .sp-mode-btn{background:#080a14;border-color:#1a1e34;color:#8a90a8}
  body.dark-theme .sp-mode-active{background:#4f6df5!important;border-color:#4f6df5!important;color:#fff!important}
  body.dark-theme .sp-ind-row{background:#080a14;border-color:#1a1e34}
  body.dark-theme .sp-chip{border-color:#1a1e34;color:#8a90a8}
  body.dark-theme .sp-filter-tag{border-color:#1a1e34;color:#8a90a8;background:transparent}
  body.dark-theme .sp-filter-tag:hover{border-color:#4f6df5;color:#4f6df5}
  body.dark-theme .sp-filter-tag-all-active{background:#4f6df5;color:#fff;border-color:#4f6df5}
  body.dark-theme .sp-filter-tags{border-bottom-color:#1a1e34}
      `;
      document.head.appendChild(s);
    }
  
    async function init() { injectCSS(); await loadDictionaries(); await loadScriptsData(); }
    window.setupsPage = { init, reload: loadScriptsData, getSetups: () => SP.setups };
  
  })();