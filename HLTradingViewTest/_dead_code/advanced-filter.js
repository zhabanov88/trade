/**
 * advanced-filter.js  v2
 *
 * Расширенный конструктор фильтров. Работает вместе с data-table.js.
 * Интеграция: window.dataTable.setAdvancedFilter(fn) / clearAdvancedFilter()
 *
 * Возможности:
 *  ▸ Визуальный построитель: группы условий + AND / OR между ними
 *  ▸ Текстовая формула:  close > 1.15 AND volume > 1000 OR atr < 0.001
 *  ▸ Операторы: > < >= <= = !=  between  contains  not_contains  starts  regex  is_null  not_null
 *  ▸ Диапазоны полей из реальных данных подставляются как подсказки
 *  ▸ Preview — показывает сколько баров пройдёт фильтр до применения
 *  ▸ Пресеты: localStorage + Share на /api/filter-presets
 *  ▸ Кнопка ⚗ Filter в navbar, открывает floating popup
 */
if (window._afv2Loaded) {} else { window._afv2Loaded = true; (function () {
    'use strict';
    
    // ═══════════════════════════════════════════════════════════════
    // СОСТОЯНИЕ
    // ═══════════════════════════════════════════════════════════════
    
    const AF = {
        mode:    'visual',   // 'visual' | 'text'
        groups:  [],         // [ { logic:'AND'|'OR', conditions:[ {field,op,value,value2} ] } ]
        formula: '',         // текстовая формула
        active:  false,      // применён ли фильтр
    };
    
    function makeGroup()  { return { logic:'AND', conditions:[ makeCond() ] }; }
    function makeCond()   { return { field:'', op:'>', value:'', value2:'' }; }
    
    AF.groups = [ makeGroup() ];
    
    // Все операторы
    const OPS = [
        { id:'>',            label:'> больше'        },
        { id:'>=',           label:'≥ не меньше'     },
        { id:'<',            label:'< меньше'        },
        { id:'<=',           label:'≤ не больше'     },
        { id:'=',            label:'= равно'         },
        { id:'!=',           label:'≠ не равно'      },
        { id:'between',      label:'∈ диапазон [a,b]'},
        { id:'contains',     label:'⊇ содержит'      },
        { id:'not_contains', label:'⊉ не содержит'   },
        { id:'starts',       label:'↳ начинается с'  },
        { id:'regex',        label:'RegExp'          },
        { id:'is_null',      label:'= пусто/null'    },
        { id:'not_null',     label:'≠ не пусто'      },
    ];
    
    // ═══════════════════════════════════════════════════════════════
    // КОМПИЛЯТОР УСЛОВИЙ
    // ═══════════════════════════════════════════════════════════════
    
    function buildCondFn(cond) {
        const { field, op, value, value2 } = cond;
        const col  = getCols().find(c => c.key === field);
        const type = col?.type || 'num';
    
        return function matchRow(row) {
            const raw = row[field];
    
            if (op === 'is_null')      return raw == null || raw === '' || raw === false;
            if (op === 'not_null')     return raw != null && raw !== '';
            if (op === 'contains')     return String(raw ?? '').toLowerCase().includes(String(value).toLowerCase());
            if (op === 'not_contains') return !String(raw ?? '').toLowerCase().includes(String(value).toLowerCase());
            if (op === 'starts')       return String(raw ?? '').toLowerCase().startsWith(String(value).toLowerCase());
            if (op === 'regex') {
                try { return new RegExp(value, 'i').test(String(raw ?? '')); }
                catch (_) { return false; }
            }
    
            // Числовые / дата
            const v = type === 'ts' ? new Date(raw).getTime()    : parseFloat(raw);
            const n = type === 'ts' ? new Date(value).getTime()  : parseFloat(value);
            if (isNaN(v) || isNaN(n)) return false;
    
            if (op === 'between') {
                const n2 = type === 'ts' ? new Date(value2).getTime() : parseFloat(value2);
                return !isNaN(n2) && v >= Math.min(n, n2) && v <= Math.max(n, n2);
            }
            if (op === '>')  return v > n;
            if (op === '>=') return v >= n;
            if (op === '<')  return v < n;
            if (op === '<=') return v <= n;
            if (op === '=')  return v === n;
            if (op === '!=') return v !== n;
            return false;
        };
    }
    
    function buildGroupFn(group) {
        const fns = group.conditions
            .filter(c => c.field && (c.op === 'is_null' || c.op === 'not_null' || c.value !== ''))
            .map(buildCondFn);
        if (!fns.length) return null;
        return group.logic === 'AND'
            ? row => fns.every(fn => fn(row))
            : row => fns.some(fn => fn(row));
    }
    
    function buildVisualFn(groups) {
        // Группы объединяются через OR
        const gfns = groups.map(buildGroupFn).filter(Boolean);
        if (!gfns.length) return null;
        return gfns.length === 1
            ? gfns[0]
            : row => gfns.some(fn => fn(row));
    }
    
    // ═══════════════════════════════════════════════════════════════
    // ПАРСЕР ТЕКСТОВОЙ ФОРМУЛЫ
    // Грамматика:  expr = or_expr
    //              or_expr  = and_expr  (OR  and_expr)*
    //              and_expr = not_expr  (AND not_expr)*
    //              not_expr = NOT? atom
    //              atom     = '(' expr ')' | cond
    //              cond     = field op value
    // ═══════════════════════════════════════════════════════════════
    
    function parseFormula(src) {
        if (!src.trim()) return null;
        const cols = getCols();
        const colSet = new Set(cols.map(c => c.key));
    
        /* ── Лексер ────────────────────────────────── */
        const tokens = [];
        let i = 0;
        while (i < src.length) {
            if (/\s/.test(src[i])) { i++; continue; }
            if (src[i] === '(') { tokens.push({t:'LP'}); i++; continue; }
            if (src[i] === ')') { tokens.push({t:'RP'}); i++; continue; }
            // Операторы >=, <=, !=, =, >, <
            const opM = src.slice(i).match(/^(>=|<=|!=|>|<|=)/);
            if (opM) { tokens.push({t:'OP', v:opM[1]}); i += opM[1].length; continue; }
            // Строки в кавычках
            if (src[i] === '"' || src[i] === "'") {
                const q = src[i]; let j = i+1, s = '';
                while (j < src.length && src[j] !== q) { s += src[j++]; }
                tokens.push({t:'VAL', v:s}); i = j+1; continue;
            }
            // Слово
            let j = i;
            while (j < src.length && !/[\s()><=!]/.test(src[j])) j++;
            const w = src.slice(i, j); i = j;
            const wu = w.toUpperCase();
            if (wu === 'AND')   { tokens.push({t:'AND'}); continue; }
            if (wu === 'OR')    { tokens.push({t:'OR'});  continue; }
            if (wu === 'NOT')   { tokens.push({t:'NOT'}); continue; }
            if (wu === 'BETWEEN') { tokens.push({t:'OP', v:'between'}); continue; }
            if (wu === 'CONTAINS')  { tokens.push({t:'OP', v:'contains'}); continue; }
            if (wu === 'STARTSWITH') { tokens.push({t:'OP', v:'starts'}); continue; }
            // Число или дата — если не имя поля
            if (!colSet.has(w)) tokens.push({t:'VAL', v:w});
            else tokens.push({t:'FIELD', v:w});
        }
    
        /* ── Парсер ────────────────────────────────── */
        let pos = 0;
        const peek  = () => tokens[pos];
        const eat   = () => tokens[pos++];
    
        function parseOr() {
            let left = parseAnd();
            while (peek()?.t === 'OR') { eat(); left = {t:'OR', left, right:parseAnd()}; }
            return left;
        }
        function parseAnd() {
            let left = parseNot();
            while (peek()?.t === 'AND') { eat(); left = {t:'AND', left, right:parseNot()}; }
            return left;
        }
        function parseNot() {
            if (peek()?.t === 'NOT') { eat(); return {t:'NOT', expr:parseAtom()}; }
            return parseAtom();
        }
        function parseAtom() {
            if (peek()?.t === 'LP') {
                eat();
                const e = parseOr();
                if (peek()?.t !== 'RP') throw new Error('Missing closing )');
                eat();
                return e;
            }
            // Условие: FIELD OP VAL [AND VAL2 для between]
            const fTok = eat();
            if (fTok?.t !== 'FIELD') throw new Error(`Expected field name, got: "${fTok?.v ?? fTok?.t}"`);
            const opTok = eat();
            if (!opTok || opTok.t !== 'OP') throw new Error(`Expected operator after "${fTok.v}"`);
    
            if (opTok.v === 'is_null' || opTok.v === 'not_null') {
                return {t:'COND', field:fTok.v, op:opTok.v, value:'', value2:''};
            }
    
            const vTok = eat();
            const val  = vTok?.v ?? '';
            let val2   = '';
    
            // between field >= v1 AND field <= v2 → или field BETWEEN v1 AND v2
            if (opTok.v === 'between') {
                if (peek()?.t === 'AND') { eat(); val2 = eat()?.v ?? ''; }
            }
    
            return {t:'COND', field:fTok.v, op:opTok.v, value:val, value2:val2};
        }
    
        /* ── AST → предикат ───────────────────────── */
        function compile(node) {
            if (!node) return () => true;
            if (node.t === 'AND') { const l=compile(node.left),r=compile(node.right); return row=>l(row)&&r(row); }
            if (node.t === 'OR')  { const l=compile(node.left),r=compile(node.right); return row=>l(row)||r(row); }
            if (node.t === 'NOT') { const e=compile(node.expr); return row=>!e(row); }
            if (node.t === 'COND') {
                const col = cols.find(c=>c.key===node.field);
                return buildCondFn({...node, type:col?.type||'num'});
            }
            return () => true;
        }
    
        const ast = parseOr();
        return compile(ast);
    }
    
    // ═══════════════════════════════════════════════════════════════
    // ПРИМЕНЕНИЕ К ТАБЛИЦЕ
    // ═══════════════════════════════════════════════════════════════
    
    function apply() {
        let fn = null, err = null;
        try {
            fn = AF.mode === 'text'
                ? parseFormula(AF.formula)
                : buildVisualFn(AF.groups);
        } catch(e) { err = e.message; }
    
        if (err) { showErr(err); return false; }
    
        AF.active = !!fn;
        window.dataTable?.setAdvancedFilter(fn);
        updateNavBtn();
        updateMatchBadge(fn);
        return true;
    }
    
    function clearAll() {
        AF.active  = false;
        AF.formula = '';
        AF.groups  = [ makeGroup() ];
        window.dataTable?.setAdvancedFilter(null);
        updateNavBtn();
    }
    
    function countMatch(fn) {
        if (!fn) return null;
        const data = window.app?.activedata || [];
        return data.filter(row => { try { return fn(row); } catch(_) { return false; } }).length;
    }
    
    function previewFn() {
        try {
            return AF.mode === 'text'
                ? parseFormula(AF.formula)
                : buildVisualFn(AF.groups);
        } catch(_) { return null; }
    }
    
    // ═══════════════════════════════════════════════════════════════
    // ПРЕСЕТЫ
    // ═══════════════════════════════════════════════════════════════
    
    function loadPresets() {
        try { return JSON.parse(localStorage.getItem('af_v2_presets') || '[]'); } catch(_) { return []; }
    }
    function savePreset(name) {
        const list = loadPresets().filter(p => p.name !== name);
        list.unshift({
            name,
            mode:    AF.mode,
            groups:  JSON.parse(JSON.stringify(AF.groups)),
            formula: AF.formula,
            at:      new Date().toISOString(),
        });
        localStorage.setItem('af_v2_presets', JSON.stringify(list.slice(0, 40)));
    }
    async function sharePreset(name) {
        try {
            await fetch('/api/filter-presets', {
                method: 'POST', credentials: 'include',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ name, mode:AF.mode, groups:AF.groups, formula:AF.formula }),
            });
            return true;
        } catch(_) { return false; }
    }
    function loadPreset(name) {
        const p = loadPresets().find(p => p.name === name);
        if (!p) return;
        AF.mode    = p.mode    || 'visual';
        AF.groups  = JSON.parse(JSON.stringify(p.groups  || [makeGroup()]));
        AF.formula = p.formula || '';
    }
    function deletePreset(name) {
        localStorage.setItem('af_v2_presets', JSON.stringify(loadPresets().filter(p => p.name !== name)));
    }
    
    // ═══════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════
    
    function getCols() { return window.dataTable?.getColumns?.() || []; }
    function esc(s) { return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    
    function dataStats(field) {
        const d   = window.app?.activedata;
        const col = getCols().find(c => c.key === field);
        if (!d?.length || !col || !field) return null;
        if (col.type === 'num' || col.type === 'int') {
            const vs = d.map(r => parseFloat(r[field])).filter(v => !isNaN(v));
            if (!vs.length) return null;
            const mn = Math.min(...vs), mx = Math.max(...vs);
            return { hint: `${mn.toFixed(5)} … ${mx.toFixed(5)}`, sample: mx };
        }
        if (col.type === 'ts') {
            const vs = d.map(r => new Date(r[field]).getTime()).filter(v => !isNaN(v));
            if (!vs.length) return null;
            const mn = new Date(Math.min(...vs)).toISOString().slice(0,10);
            const mx = new Date(Math.max(...vs)).toISOString().slice(0,10);
            return { hint: `${mn} … ${mx}`, sample: mx };
        }
        return null;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // UI — Popup
    // ═══════════════════════════════════════════════════════════════
    
    function openPopup() {
        document.getElementById('af-popup')?.remove();
        const pop = document.createElement('div');
        pop.id = 'af-popup';
        document.body.appendChild(pop);
        renderPopup(pop);
        positionPopup(pop);
    }
    
    function closePopup() {
        document.getElementById('af-popup')?.remove();
        updateNavBtn();
    }
    
    function positionPopup(pop) {
        const btn = document.getElementById('af-nav-btn');
        if (!btn) return;
        const r  = btn.getBoundingClientRect();
        const pw = Math.min(860, window.innerWidth - 40);
        pop.style.width = pw + 'px';
        pop.style.left  = Math.max(20, r.left) + 'px';
        // Показываем под кнопкой
        const popH = pop.offsetHeight || 500;
        const spaceBelow = window.innerHeight - r.bottom - 10;
        pop.style.top = spaceBelow > 200
            ? (r.bottom + 6) + 'px'
            : Math.max(10, r.top - popH - 6) + 'px';
    }
    
    function renderPopup(pop) {
        const cols = getCols();
        pop.innerHTML = `
        <div class="af-hdr">
            <div class="af-tabs">
                <button class="af-tab${AF.mode==='visual'?' on':''}" data-m="visual">🔲 Visual</button>
                <button class="af-tab${AF.mode==='text'?' on':''}"   data-m="text">✏ Formula</button>
            </div>
            <span id="af-match"></span>
            <div class="af-hdr-r">
                <button class="af-b af-b-prev" id="af-prev">👁 Preview</button>
                <button class="af-b af-b-ok"   id="af-ok">✓ Apply</button>
                <button class="af-b af-b-clr"  id="af-clr">✕ Clear</button>
                <button class="af-b"            id="af-x">✕</button>
            </div>
        </div>
        <div id="af-body">${AF.mode==='visual' ? htmlVisual(cols) : htmlText(cols)}</div>
        <div class="af-foot">
            <input class="af-pi" id="af-pn" placeholder="Preset name…">
            <button class="af-b af-b-sm" id="af-ps">💾 Save</button>
            <button class="af-b af-b-sm" id="af-psh">🌐 Share</button>
            <div class="af-plist" id="af-plist">${htmlPresets()}</div>
        </div>`;
    
        bind(pop, cols);
    }
    
    // ─── Visual builder HTML ────────────────────────────────────────
    
    function htmlVisual(cols) {
        return `<div id="af-vis">
            ${AF.groups.map((g, gi) => htmlGroup(g, gi, cols)).join('')}
            <button class="af-add-g" id="af-add-g">＋ Add group (OR between groups)</button>
        </div>`;
    }
    
    function htmlGroup(g, gi, cols) {
        const canDel = AF.groups.length > 1;
        return `
        <div class="af-grp" data-gi="${gi}">
            <div class="af-grp-hdr">
                <span class="af-grp-lbl">Group ${gi+1}</span>
                <span class="af-grp-logic-lbl">Conditions joined by</span>
                <button class="af-lg${g.logic==='AND'?' on':''}" data-gi="${gi}" data-l="AND">AND</button>
                <button class="af-lg${g.logic==='OR'?' on':''}"  data-gi="${gi}" data-l="OR">OR</button>
                ${canDel ? `<button class="af-del-g af-ib" data-gi="${gi}" title="Remove group">✕</button>` : ''}
            </div>
            ${gi > 0 ? '<div class="af-or-sep">— OR —</div>' : ''}
            <div class="af-conds">
                ${g.conditions.map((c, ci) => htmlCond(c, gi, ci, g.logic, cols)).join('')}
            </div>
            <button class="af-add-c af-ib" data-gi="${gi}">＋ condition</button>
        </div>`;
    }
    
    function htmlCond(c, gi, ci, logic, cols) {
        const showV2  = c.op === 'between';
        const noValue = c.op === 'is_null' || c.op === 'not_null';
        const stats   = dataStats(c.field);
        const ph      = stats?.hint || 'value';
        const colType = cols.find(x=>x.key===c.field)?.type || '';
    
        return `
        <div class="af-cond" data-gi="${gi}" data-ci="${ci}">
            <span class="af-cond-lbl">${ci===0 ? 'WHERE' : logic}</span>
            <select class="af-s af-s-f" data-gi="${gi}" data-ci="${ci}">
                <option value="">— field —</option>
                ${cols.map(x=>`<option value="${x.key}"${c.field===x.key?' selected':''}>${esc(x.label)}<em> (${x.type})</em></option>`).join('')}
            </select>
            <select class="af-s af-s-o" data-gi="${gi}" data-ci="${ci}">
                ${OPS.map(o=>`<option value="${o.id}"${c.op===o.id?' selected':''}>${esc(o.label)}</option>`).join('')}
            </select>
            ${noValue ? '' : `
            <input class="af-v" data-gi="${gi}" data-ci="${ci}" data-r="v"
                   value="${esc(c.value)}" placeholder="${esc(ph)}">`}
            ${showV2 ? `<span class="af-and">AND</span>
            <input class="af-v" data-gi="${gi}" data-ci="${ci}" data-r="v2"
                   value="${esc(c.value2)}" placeholder="${esc(ph)}">` : ''}
            ${stats ? `<span class="af-hint">${esc(stats.hint)}</span>` : ''}
            <button class="af-del-c af-ib" data-gi="${gi}" data-ci="${ci}" title="Remove">✕</button>
        </div>`;
    }
    
    // ─── Text formula HTML ──────────────────────────────────────────
    
    function htmlText(cols) {
        const examples = [
            'close > 1.15 AND volume > 1000',
            'atr < 0.001 OR (close < open AND volume > 500)',
            'close >= 1.10 AND close <= 1.20',
            'NOT (volume = 0)',
            'close BETWEEN 1.10 AND 1.20',
        ];
        return `<div id="af-txt">
            <textarea id="af-fml" class="af-fml" placeholder="close > 1.15 AND volume > 1000">${esc(AF.formula)}</textarea>
            <div id="af-ferr" class="af-ferr"></div>
            <div class="af-fhelp">
                <div class="af-hlbl">Fields — click to insert:</div>
                <div class="af-chips">
                    ${cols.map(c=>`<span class="af-chip" data-k="${c.key}">${esc(c.label)}<em> ${c.type}</em></span>`).join('')}
                </div>
                <div class="af-hlbl" style="margin-top:6px">Operators: &gt; &lt; &gt;= &lt;= = != AND OR NOT ( ) BETWEEN</div>
                <div class="af-hlbl" style="margin-top:4px">Examples:</div>
                ${examples.map(e=>`<div class="af-ex" data-e="${esc(e)}">${esc(e)}</div>`).join('')}
            </div>
        </div>`;
    }
    
    // ─── Presets HTML ───────────────────────────────────────────────
    
    function htmlPresets() {
        const list = loadPresets();
        if (!list.length) return '<span class="af-no-p">No saved presets</span>';
        return list.map(p => `
            <div class="af-pi-row">
                <button class="af-pl" data-n="${esc(p.name)}" title="${esc(p.formula||JSON.stringify(p.groups).slice(0,60))}">${esc(p.name)}</button>
                <em class="af-pm">${p.mode} · ${p.at?.slice(0,10)||''}</em>
                <button class="af-pd" data-n="${esc(p.name)}">✕</button>
            </div>`).join('');
    }
    
    // ─── Event binding ──────────────────────────────────────────────
    
    function bind(pop, cols) {
        // Tabs
        pop.querySelectorAll('.af-tab').forEach(t => t.addEventListener('click', () => {
            syncFromDOM(pop);
            // При переключении в text — конвертируем visual в формулу
            if (t.dataset.m === 'text' && !AF.formula) AF.formula = visual2text();
            AF.mode = t.dataset.m;
            renderPopup(pop); positionPopup(pop);
        }));
    
        // Apply / Preview / Clear / Close
        pop.querySelector('#af-ok').addEventListener('click', () => {
            syncFromDOM(pop);
            if (apply()) closePopup();
        });
        pop.querySelector('#af-prev').addEventListener('click', () => {
            syncFromDOM(pop);
            const fn = previewFn();
            updateMatchBadge(fn);
            showErr(fn === null && AF.mode === 'text' ? 'Parse error' : '');
        });
        pop.querySelector('#af-clr').addEventListener('click', () => {
            clearAll(); renderPopup(pop);
        });
        pop.querySelector('#af-x').addEventListener('click', closePopup);
    
        // Visual events
        if (AF.mode === 'visual') bindVisual(pop, cols);
        if (AF.mode === 'text')   bindText(pop, cols);
    
        // Presets
        pop.querySelector('#af-ps').addEventListener('click', () => {
            syncFromDOM(pop);
            const name = pop.querySelector('#af-pn')?.value.trim();
            if (!name) { alert('Enter preset name'); return; }
            savePreset(name);
            pop.querySelector('#af-plist').innerHTML = htmlPresets();
            bindPresets(pop);
        });
        pop.querySelector('#af-psh').addEventListener('click', async () => {
            syncFromDOM(pop);
            const name = pop.querySelector('#af-pn')?.value.trim() || 'shared';
            const ok = await sharePreset(name);
            alert(ok ? `"${name}" опубликован` : 'Ошибка публикации — проверьте /api/filter-presets');
        });
        bindPresets(pop);
    }
    
    function bindVisual(pop, cols) {
        // Logic AND/OR toggle
        pop.querySelectorAll('.af-lg').forEach(b => b.addEventListener('click', () => {
            syncFromDOM(pop);
            AF.groups[+b.dataset.gi].logic = b.dataset.l;
            redrawBody(pop, cols);
        }));
        // Add group
        pop.querySelector('#af-add-g')?.addEventListener('click', () => {
            syncFromDOM(pop); AF.groups.push(makeGroup()); redrawBody(pop, cols);
        });
        // Delete group
        pop.querySelectorAll('.af-del-g').forEach(b => b.addEventListener('click', () => {
            syncFromDOM(pop); AF.groups.splice(+b.dataset.gi, 1); redrawBody(pop, cols);
        }));
        // Add condition
        pop.querySelectorAll('.af-add-c').forEach(b => b.addEventListener('click', () => {
            syncFromDOM(pop); AF.groups[+b.dataset.gi]?.conditions.push(makeCond()); redrawBody(pop, cols);
        }));
        // Delete condition
        pop.querySelectorAll('.af-del-c').forEach(b => b.addEventListener('click', () => {
            const g = AF.groups[+b.dataset.gi];
            if (g?.conditions.length > 1) { syncFromDOM(pop); g.conditions.splice(+b.dataset.ci, 1); redrawBody(pop, cols); }
        }));
        // Field change → redraw for updated hints + op defaults
        pop.querySelectorAll('.af-s-f').forEach(s => s.addEventListener('change', () => {
            syncFromDOM(pop); redrawBody(pop, cols);
        }));
        // Op change → redraw for show/hide value2
        pop.querySelectorAll('.af-s-o').forEach(s => s.addEventListener('change', () => {
            syncFromDOM(pop); redrawBody(pop, cols);
        }));
        // Live preview on value input
        pop.querySelectorAll('.af-v').forEach(inp => inp.addEventListener('input', () => {
            syncFromDOM(pop);
            updateMatchBadge(buildVisualFn(AF.groups));
        }));
    }
    
    function bindText(pop, cols) {
        const ta  = pop.querySelector('#af-fml');
        const err = pop.querySelector('#af-ferr');
        ta?.addEventListener('input', () => {
            AF.formula = ta.value;
            try {
                const fn = parseFormula(ta.value);
                err.textContent = '';
                updateMatchBadge(fn);
            } catch(e) { err.textContent = '⚠ ' + e.message; }
        });
        // Field chips
        pop.querySelectorAll('.af-chip').forEach(ch => ch.addEventListener('click', () => {
            if (!ta) return;
            const ins = ch.dataset.k;
            const s = ta.selectionStart, e = ta.selectionEnd;
            ta.value = ta.value.slice(0,s) + ins + ta.value.slice(e);
            ta.selectionStart = ta.selectionEnd = s + ins.length;
            ta.focus(); AF.formula = ta.value;
        }));
        // Examples
        pop.querySelectorAll('.af-ex').forEach(ex => ex.addEventListener('click', () => {
            if (ta) { ta.value = ex.dataset.e; AF.formula = ta.value; ta.focus(); }
        }));
    }
    
    function bindPresets(pop) {
        pop.querySelectorAll('.af-pl').forEach(b => b.addEventListener('click', () => {
            loadPreset(b.dataset.n); renderPopup(pop); positionPopup(pop);
        }));
        pop.querySelectorAll('.af-pd').forEach(b => b.addEventListener('click', () => {
            deletePreset(b.dataset.n);
            pop.querySelector('#af-plist').innerHTML = htmlPresets();
            bindPresets(pop);
        }));
    }
    
    function redrawBody(pop, cols) {
        pop.querySelector('#af-body').innerHTML = htmlVisual(cols);
        bindVisual(pop, cols);
        updateMatchBadge(buildVisualFn(AF.groups));
    }
    
    // ─── Sync DOM → AF state ────────────────────────────────────────
    
    function syncFromDOM(pop) {
        if (AF.mode === 'text') {
            AF.formula = pop.querySelector('#af-fml')?.value || '';
            return;
        }
        pop.querySelectorAll('.af-s-f').forEach(s => {
            const c = AF.groups[+s.dataset.gi]?.conditions[+s.dataset.ci];
            if (c) c.field = s.value;
        });
        pop.querySelectorAll('.af-s-o').forEach(s => {
            const c = AF.groups[+s.dataset.gi]?.conditions[+s.dataset.ci];
            if (c) c.op = s.value;
        });
        pop.querySelectorAll('.af-v[data-r="v"]').forEach(inp => {
            const c = AF.groups[+inp.dataset.gi]?.conditions[+inp.dataset.ci];
            if (c) c.value = inp.value;
        });
        pop.querySelectorAll('.af-v[data-r="v2"]').forEach(inp => {
            const c = AF.groups[+inp.dataset.gi]?.conditions[+inp.dataset.ci];
            if (c) c.value2 = inp.value;
        });
    }
    
    // ─── Visual → text formula converter ───────────────────────────
    
    function visual2text() {
        return AF.groups.map(g => {
            const parts = g.conditions
                .filter(c => c.field && (c.op === 'is_null' || c.op === 'not_null' || c.value))
                .map(c => {
                    if (c.op === 'between')      return `${c.field} BETWEEN ${c.value} AND ${c.value2}`;
                    if (c.op === 'contains')     return `${c.field} CONTAINS "${c.value}"`;
                    if (c.op === 'not_contains') return `NOT (${c.field} CONTAINS "${c.value}")`;
                    if (c.op === 'is_null')      return `${c.field} IS NULL`;
                    if (c.op === 'not_null')     return `${c.field} IS NOT NULL`;
                    return `${c.field} ${c.op} ${c.value}`;
                });
            if (!parts.length) return '';
            return parts.length === 1 ? parts[0] : `(${parts.join(` ${g.logic} `)})`;
        }).filter(Boolean).join(' OR ');
    }
    
    // ─── UI helpers ─────────────────────────────────────────────────
    
    function updateMatchBadge(fn) {
        const el = document.getElementById('af-match');
        if (!el) return;
        if (!fn) { el.textContent = ''; return; }
        const cnt   = countMatch(fn);
        const total = window.app?.activedata?.length || 0;
        el.textContent = `${cnt} / ${total} bars`;
        el.style.color = cnt === 0 ? '#ef5350' : '#26a69a';
    }
    
    function showErr(msg) {
        const el = document.getElementById('af-ferr');
        if (el) el.textContent = msg ? '⚠ ' + msg : '';
    }
    
    function updateNavBtn() {
        const btn = document.getElementById('af-nav-btn');
        if (!btn) return;
        btn.textContent = AF.active ? '⚗ Filter ●' : '⚗ Filter';
        btn.classList.toggle('af-on', AF.active);
    }
    
    // ═══════════════════════════════════════════════════════════════
    // NAV BUTTON
    // ═══════════════════════════════════════════════════════════════
    
    function buildNavBtn() {
        if (document.getElementById('af-nav-btn')) return;
        const btn = document.createElement('button');
        btn.id        = 'af-nav-btn';
        btn.className = 'nav-btn';
        btn.textContent = '⚗ Filter';
        btn.title     = 'Advanced Filter';
        btn.addEventListener('click', () => {
            document.getElementById('af-popup') ? closePopup() : openPopup();
        });
        // Вставляем сразу после кнопки Table
        const dtBtn = document.getElementById('dt-nav-btn');
        if (dtBtn?.parentNode) dtBtn.parentNode.insertBefore(btn, dtBtn.nextSibling);
        else document.querySelector('.navbar-right')?.appendChild(btn);
    }
    
    // ═══════════════════════════════════════════════════════════════
    // CSS
    // ═══════════════════════════════════════════════════════════════
    
    function css() {
        if (document.getElementById('af-css')) return;
        const s = document.createElement('style');
        s.id = 'af-css';
        s.textContent = `
    #af-nav-btn{font-size:12px;padding:3px 10px;margin-right:2px;transition:background .15s,color .15s}
    #af-nav-btn.af-on{background:#f5a62322;color:#f5a623;border-color:#f5a62366}
    
    /* Popup */
    #af-popup{
        position:fixed;z-index:100001;
        background:#131722;border:1px solid #2a2e39;border-radius:8px;
        box-shadow:0 16px 56px rgba(0,0,0,.85);
        font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        display:flex;flex-direction:column;max-height:82vh;overflow:hidden;
    }
    /* Header */
    .af-hdr{display:flex;align-items:center;gap:8px;padding:8px 12px;
        background:#0d0f17;border-bottom:1px solid #2a2e39;flex-shrink:0}
    .af-tabs{display:flex;gap:0}
    .af-tab{padding:4px 12px;background:#1a1d27;border:1px solid #2a2e39;
        color:#787b86;font-size:12px;cursor:pointer}
    .af-tab:first-child{border-radius:4px 0 0 4px}
    .af-tab:last-child{border-radius:0 4px 4px 0;border-left:none}
    .af-tab.on{background:#2a2e39;color:#d1d4dc}
    #af-match{font-size:12px;font-weight:700;min-width:100px;font-variant-numeric:tabular-nums}
    .af-hdr-r{display:flex;align-items:center;gap:4px;margin-left:auto}
    
    /* Buttons */
    .af-b{padding:3px 10px;background:#2a2e39;border:1px solid #363a45;
        border-radius:4px;color:#9598a1;font-size:12px;cursor:pointer;white-space:nowrap}
    .af-b:hover{background:#363a45;color:#d1d4dc}
    .af-b-ok{background:#162b18;border-color:#4caf50;color:#4caf50;font-weight:600}
    .af-b-ok:hover{background:#1e3d20}
    .af-b-clr{border-color:#ef535044;color:#ef5350}
    .af-b-clr:hover{background:#3a1010}
    .af-b-prev{border-color:#2962FF44;color:#5c8ef0}
    .af-b-sm{padding:2px 8px;font-size:11px}
    .af-ib{background:transparent;border:none;color:#555;cursor:pointer;padding:2px 5px;font-size:12px}
    .af-ib:hover{color:#ef5350}
    
    /* Body */
    #af-body{overflow-y:auto;flex:1;padding:10px 12px}
    
    /* Groups */
    .af-grp{background:#0d0f17;border:1px solid #2a2e39;border-radius:6px;padding:10px 12px;margin-bottom:8px}
    .af-grp-hdr{display:flex;align-items:center;gap:6px;margin-bottom:8px}
    .af-grp-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#555;flex:1}
    .af-grp-logic-lbl{font-size:10px;color:#555}
    .af-lg{padding:2px 8px;background:#1a1d27;border:1px solid #2a2e39;
        color:#555;font-size:11px;font-weight:700;cursor:pointer}
    .af-lg:first-of-type{border-radius:3px 0 0 3px}
    .af-lg:last-of-type{border-radius:0 3px 3px 0;border-left:none}
    .af-lg.on{background:#2962FF22;border-color:#2962FF;color:#2962FF}
    .af-or-sep{text-align:center;font-size:10px;font-weight:700;letter-spacing:2px;
        color:#f5a623;padding:2px 0 6px;margin-top:-4px}
    .af-conds{display:flex;flex-direction:column;gap:5px}
    .af-cond{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
    .af-cond-lbl{font-size:10px;font-weight:700;letter-spacing:.4px;color:#2962FF;
        min-width:44px;text-align:right;flex-shrink:0}
    .af-s{background:#1a1d27;border:1px solid #2a2e39;border-radius:3px;
        color:#d1d4dc;font-size:12px;padding:3px 5px;cursor:pointer}
    .af-s-f{min-width:110px}.af-s-o{min-width:130px}
    .af-s:focus{outline:none;border-color:#2962FF}
    .af-v{background:#1a1d27;border:1px solid #2a2e39;border-radius:3px;
        color:#d1d4dc;font-size:12px;padding:3px 6px;width:110px}
    .af-v:focus{outline:none;border-color:#2962FF}
    .af-and{color:#555;font-size:10px;font-weight:700}
    .af-hint{font-size:10px;color:#555;white-space:nowrap;font-variant-numeric:tabular-nums}
    .af-add-c{color:#555;font-size:11px;margin-top:4px;background:none;border:none;cursor:pointer}
    .af-add-c:hover{color:#2962FF}
    .af-add-g{width:100%;padding:6px;background:transparent;border:1px dashed #2a2e39;
        border-radius:4px;color:#555;font-size:12px;cursor:pointer;margin-top:4px}
    .af-add-g:hover{border-color:#2962FF;color:#2962FF}
    
    /* Text formula */
    #af-txt{display:flex;flex-direction:column;gap:8px}
    .af-fml{width:100%;height:72px;background:#0d0f17;border:1px solid #2a2e39;border-radius:4px;
        color:#d1d4dc;font-size:13px;font-family:monospace;padding:8px;
        resize:vertical;box-sizing:border-box}
    .af-fml:focus{outline:none;border-color:#2962FF}
    .af-ferr{color:#ef5350;font-size:11px;min-height:14px}
    .af-fhelp{border-top:1px solid #1a1d27;padding-top:8px}
    .af-hlbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;
        color:#555;margin-bottom:4px}
    .af-chips{display:flex;flex-wrap:wrap;gap:4px}
    .af-chip{padding:2px 8px;background:#1a1d27;border:1px solid #2a2e39;border-radius:12px;
        color:#9598a1;font-size:11px;cursor:pointer}
    .af-chip em{color:#555;font-style:normal}
    .af-chip:hover{border-color:#2962FF;color:#2962FF;background:#1a2744}
    .af-ex{padding:3px 8px;background:#0d0f17;border-radius:3px;
        color:#555;font-size:11px;font-family:monospace;cursor:pointer;margin:1px 0}
    .af-ex:hover{color:#d1d4dc;background:#1a1d27}
    
    /* Footer presets */
    .af-foot{padding:8px 12px;border-top:1px solid #2a2e39;background:#0d0f17;
        flex-shrink:0;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    .af-pi{background:#1a1d27;border:1px solid #2a2e39;border-radius:3px;
        color:#d1d4dc;font-size:12px;padding:3px 8px;width:150px}
    .af-pi:focus{outline:none;border-color:#2962FF}
    .af-plist{display:flex;flex-wrap:wrap;gap:6px;flex:1;align-items:center}
    .af-pi-row{display:flex;align-items:center;gap:3px}
    .af-pl{background:#1a1d27;border:1px solid #2a2e39;border-radius:3px;
        color:#9598a1;font-size:11px;padding:2px 8px;cursor:pointer}
    .af-pl:hover{border-color:#2962FF;color:#2962FF}
    .af-pm{font-size:10px;color:#555;font-style:normal}
    .af-pd{background:transparent;border:none;color:#444;cursor:pointer;font-size:11px}
    .af-pd:hover{color:#ef5350}
    .af-no-p{font-size:11px;color:#555}
    
    /* Light theme */
    /* Light theme */
    body.light-theme #af-popup          { background:#f8f9fd; border-color:#e0e3eb }
    /* ИСПРАВЛЕНО: убрана опечатка .body.light-theme */
    body.light-theme .af-hdr,
    body.light-theme .af-foot           { background:#fff; border-color:#e0e3eb }
    body.light-theme .af-grp            { background:#fff; border-color:#e0e3eb }
    body.light-theme .af-tab            { background:#f0f3fa; border-color:#e0e3eb; color:#555 }
    body.light-theme .af-tab.on         { background:#e0e3eb; color:#131722 }
    /* ИСПРАВЛЕНО: убраны две опечатки .body.light-theme */
    body.light-theme .af-s,
    body.light-theme .af-v,
    body.light-theme .af-fml            { background:#fff; border-color:#d0d3db; color:#131722 }
    body.light-theme .af-lg             { background:#fff; border-color:#d0d3db; color:#787b86 }
    body.light-theme .af-lg.on          { background:#2962FF22; border-color:#2962FF; color:#2962FF }

    /* Дополнительные элементы без адаптации */
    body.light-theme #af-nav-btn        { color:#555; border-color:#d0d3db }
    body.light-theme #af-nav-btn.af-on  { background:#f5a62322; color:#f5a623; border-color:#f5a62366 }
    body.light-theme #af-body           { background:#f8f9fd }
    body.light-theme .af-b              { background:#e9ecf2; border-color:#d0d3db; color:#555 }
    body.light-theme .af-b:hover        { background:#d0d3db; color:#131722 }
    body.light-theme .af-b-ok           { background:#e8f5e9; border-color:#4caf50; color:#2e7d32 }
    body.light-theme .af-b-clr          { border-color:#ef535044; color:#ef5350; background:transparent }
    body.light-theme .af-b-prev         { border-color:#2962FF44; color:#2962FF }
    body.light-theme .af-cond-lbl       { color:#2962FF }
    body.light-theme .af-and            { color:#aaa }
    body.light-theme .af-hint           { color:#aaa }
    body.light-theme .af-add-c          { color:#aaa }
    body.light-theme .af-add-c:hover    { color:#2962FF }
    body.light-theme .af-add-g          { border-color:#d0d3db; color:#aaa }
    body.light-theme .af-add-g:hover    { border-color:#2962FF; color:#2962FF }
    body.light-theme .af-grp-lbl        { color:#aaa }
    body.light-theme .af-grp-logic-lbl  { color:#aaa }
    body.light-theme .af-or-sep         { color:#f5a623 }
    body.light-theme .af-chip           { background:#f0f3fa; border-color:#d0d3db; color:#555 }
    body.light-theme .af-chip:hover     { border-color:#2962FF; color:#2962FF; background:#e8f0ff }
    body.light-theme .af-ex             { background:#f0f3fa; color:#aaa }
    body.light-theme .af-ex:hover       { color:#131722; background:#e0e3eb }
    body.light-theme .af-pi             { background:#fff; border-color:#d0d3db; color:#131722 }
    body.light-theme .af-pm             { color:#aaa }
    body.light-theme .af-no-p           { color:#aaa }
    body.light-theme .af-hlbl           { color:#aaa }
    body.light-theme #af-match          { /* цвет задаётся динамически через JS */ }
    `;
        document.head.appendChild(s);
    }
    
    // ═══════════════════════════════════════════════════════════════
    // START
    // ═══════════════════════════════════════════════════════════════
    
    function start() {
        css();
        // Ждём data-table
        let n = 0;
        const t = setInterval(() => {
            if (++n > 200) clearInterval(t);
            if (window.dataTable?.setAdvancedFilter) {
                clearInterval(t);
                buildNavBtn();
                console.log('[advanced-filter] ready');
            }
        }, 150);
    }
    
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
    
    window.advancedFilter = {
        open: openPopup, close: closePopup,
        apply, clear: clearAll,
        parseFormula, buildVisualFn,
        getActiveFn: () => previewFn(),
    };
    
    })(); }