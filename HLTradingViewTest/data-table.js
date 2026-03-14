
if (window._dtLoaded) {} else { window._dtLoaded = true; (function () {
    'use strict';
    
    // ════════════════════════════════════════════════════════
    // СОСТОЯНИЕ
    // ════════════════════════════════════════════════════════
    
    const S = {
        visible:  false,
        columns:  [],
        sortKey:  'timestamp', sortDir: 'desc',
        groupKey: null,
        filters:  {},      // { key: { raw, fn } }
        hlIdx:    -1,
        panelH:   220,
        knownKeys: new Set(),
        // Активные маркеры на графике: [ shapeId, ... ]
        activeShapes: [],
        autoViz: false,
        lastDataLen: 0,
    };
    
    const BASE = [
        { key:'_index',       label:'Index',   visible:true,  width:60,  type:'int'  },
        { key:'timestamp',    label:'Time',    visible:true,  width:150, type:'ts'   },
        { key:'open',         label:'Open',    visible:true,  width:90,  type:'num'  },
        { key:'high',         label:'High',    visible:true,  width:90,  type:'num'  },
        { key:'low',          label:'Low',     visible:true,  width:90,  type:'num'  },
        { key:'close',        label:'Close',   visible:true,  width:90,  type:'num'  },
        { key:'volume',       label:'Volume',  visible:true,  width:90,  type:'int'  },
        { key:'atr',          label:'ATR',     visible:true,  width:90,  type:'num'  },
    ];
    
    // DOM elements — declared here so all functions share the same scope
    let panelEl = null, tbodyEl = null, colMgrEl = null;
    
    // ════════════════════════════════════════════════════════
    // ФОРМАТИРОВАНИЕ (с фиксом boolean/null)
    // ════════════════════════════════════════════════════════
    
    function fmt(type, v) {
        // boolean — проверяем до всего остального
        if (v === true  || v === 'true')  return '✓';
        if (v === false || v === 'false') return '✗';
        // null / undefined / NaN / empty
        if (v == null || v === '' || (typeof v === 'number' && isNaN(v))) return '—';
        if (type === 'ts')   return new Date(v).toISOString().replace('T',' ').slice(0,19);
        if (type === 'num')  return parseFloat(v).toFixed(5);
        if (type === 'int')  return parseInt(v).toLocaleString();
        if (type === 'bool') return v ? '✓' : '✗';
        return String(v);
    }
    
    function rawVal(type, v) {
        if (v === true || v === 'true')   return true;
        if (v === false || v === 'false') return false;
        if (v == null || v === '')        return null;
        if (type === 'ts')  return new Date(v).getTime();
        if (type === 'num' || type === 'int') return parseFloat(v);
        return String(v);
    }
    
    // ════════════════════════════════════════════════════════
    // УМНЫЕ ФИЛЬТРЫ
    // ════════════════════════════════════════════════════════
    
    /**
     * Парсим строку фильтра в функцию-предикат
     * num/int:  '>1.1'  '<2'  '>=1'  '=1.5'  '1.1..2.0'  '1.1'
     * ts:       '2024-01-01..2024-12-31'  '>2024-06-01'  '2024'
     * text:     любая подстрока (case-insensitive)
     * bool:     '1'/'true'/'✓' → true,  '0'/'false'/'✗' → false
     */
    // ════════════════════════════════════════════════════════
    // FILTER ENGINE
    // Simple filter: typed directly in header input row
    // Advanced popup: opens per-column when clicking ⊕ button
    // Both work simultaneously (simple AND advanced per column)
    // ════════════════════════════════════════════════════════
    
    // S.filters[key] = { raw, fn, type, rules: [{op,val,val2,logic}] }
    // rules = null  → simple text mode (raw string)
    // rules = [...]  → advanced mode (built from popup)
    
    const FOP = [
        { id:'>',    label:'> >' }, { id:'>=', label:'≥ >=' },
        { id:'<',    label:'< <' }, { id:'<=', label:'≤ <=' },
        { id:'=',    label:'= =' }, { id:'!=', label:'≠ !=' },
        { id:'..', label:'∈ range' },
        { id:'contains',    label:'⊇ contains' },
        { id:'not_contains',label:'⊉ !contains' },
        { id:'regex',       label:'~ regex' },
        { id:'is_null',     label:'= empty' },
        { id:'not_null',    label:'≠ not empty' },
    ];
    
    // ── compile one rule object into a predicate ────────────────────
    function compileRule(rule, type) {
        const { op, val, val2 } = rule;
        return function(raw) {
            if (op === 'is_null')      return raw == null || raw === '' || raw === false;
            if (op === 'not_null')     return raw != null && raw !== '';
            if (op === 'contains')     return String(raw??'').toLowerCase().includes(String(val).toLowerCase());
            if (op === 'not_contains') return !String(raw??'').toLowerCase().includes(String(val).toLowerCase());
            if (op === 'regex') { try { return new RegExp(val,'i').test(String(raw??'')); } catch(_){return false;} }
            const v = type==='ts' ? new Date(raw).getTime()  : parseFloat(raw);
            const n = type==='ts' ? new Date(val).getTime()  : parseFloat(val);
            if (isNaN(v)||isNaN(n)) return false;
            if (op === '..')  { const n2=type==='ts'?new Date(val2).getTime():parseFloat(val2); return !isNaN(n2)&&v>=Math.min(n,n2)&&v<=Math.max(n,n2); }
            if (op === '>')  return v>n;  if (op === '>=') return v>=n;
            if (op === '<')  return v<n;  if (op === '<=') return v<=n;
            if (op === '=')  return v===n; if (op === '!=') return v!==n;
            return false;
        };
    }
    
    // ── build combined fn from rules array (AND / OR between rows) ──
    function buildRulesFn(rules, type) {
        if (!rules || !rules.length) return null;
        const fns = rules
            .filter(r => r.op==='is_null'||r.op==='not_null'||r.val!=='')
            .map(r => ({ fn: compileRule(r, type), logic: r.logic }));
        if (!fns.length) return null;
        return function(raw) {
            let result = fns[0].fn(raw);
            for (let i=1; i<fns.length; i++) {
                result = fns[i].logic==='OR' ? result||fns[i].fn(raw) : result&&fns[i].fn(raw);
            }
            return result;
        };
    }
    
    // ── simple text → fn (used when typing directly in input) ───────
    function parseSimple(raw, type) {
        const s = (raw||'').trim();
        if (!s) return null;
        if (type==='num'||type==='int') {
            const rng = s.match(/^(.+?)\.\.(.+)$/);
            if (rng) { const lo=parseFloat(rng[1]),hi=parseFloat(rng[2]); if(!isNaN(lo)&&!isNaN(hi)) return v=>{const n=parseFloat(v);return n>=lo&&n<=hi;}; }
            const op = s.match(/^(>=|<=|!=|>|<|=)(.+)$/);
            if (op) { const n=parseFloat(op[2]); if(!isNaN(n)) { const m={'>':v=>parseFloat(v)>n,'<':v=>parseFloat(v)<n,'>=':v=>parseFloat(v)>=n,'<=':v=>parseFloat(v)<=n,'=':v=>parseFloat(v)===n,'!=':v=>parseFloat(v)!==n}; return m[op[1]]||null; } }
            const n=parseFloat(s); if(!isNaN(n)) return v=>parseFloat(v)===n;
            return null;
        }
        if (type==='ts') {
            const rng=s.match(/^(.+?)\.\.(.+)$/);
            if (rng) { const lo=new Date(rng[1].trim()).getTime(),hi=new Date(rng[2].trim()+(rng[2].trim().length===10?' 23:59:59':'')).getTime(); if(!isNaN(lo)&&!isNaN(hi)) return v=>{const t=new Date(v).getTime();return t>=lo&&t<=hi;}; }
            const op=s.match(/^(>=|<=|>|<)(.+)$/);
            if (op) { const d=new Date(op[2].trim()).getTime(); if(!isNaN(d)) { const m={'>':v=>new Date(v).getTime()>d,'<':v=>new Date(v).getTime()<d,'>=':v=>new Date(v).getTime()>=d,'<=':v=>new Date(v).getTime()<=d}; return m[op[1]]||null; } }
            return v=>String(v).includes(s);
        }
        if (type==='bool') {
            const want=['1','true','yes'].includes(s.toLowerCase());
            return v => { const bv=(v===true||v==='true'||v===1||v==='1'); return bv===want; };
        }
        const lo=s.toLowerCase(); return v=>String(v??'').toLowerCase().includes(lo);
    }
    
    // ── set / clear filter ───────────────────────────────────────────
    function setFilter(key, raw, type, rules) {
        if (rules) {
            // Advanced mode — build from rules
            const fn = buildRulesFn(rules, type);
            if (fn) S.filters[key] = { raw: rulesLabel(rules), fn, type, rules };
            else delete S.filters[key];
        } else {
            // Simple mode
            if (!raw||!raw.trim()) { delete S.filters[key]; return; }
            const fn = parseSimple(raw, type);
            if (fn) S.filters[key] = { raw, fn, type, rules:null };
            else delete S.filters[key];
        }
    }
    
    function rulesLabel(rules) {
        return rules.filter(r=>r.op==='is_null'||r.op==='not_null'||r.val!=='')
            .map((r,i) => (i>0?r.logic+' ':'')+r.op+(r.val?' '+r.val:'')+(r.val2?'..'+r.val2:'')).join(' ');
    }
    
    // ── добавляет поле _index ко всем строкам (0 = старейший бар) ──────────
    function getDataWithIndex(data) {
        if (!data || !data.length) return data;
        const sorted = [...data].sort((a,b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        const idxMap = new Map(sorted.map((r,i) => [new Date(r.timestamp).getTime(), i]));
        return data.map(r => ({ ...r, _index: idxMap.get(new Date(r.timestamp).getTime()) ?? 0 }));
    }

    // ── apply all filters to data ──────────────────────────────────────────
    function applyFilters(data) {
        const keys = Object.keys(S.filters);
        if (!keys.length) return data;
        return data.filter(row => keys.every(k => {
            const f = S.filters[k];
            const v = row[k];
            // bool columns have actual true/false values, don't skip them
            if (f.type !== 'bool' && (v == null || v === '')) return false;
            try { return f.fn(v); } catch(_) { return false; }
        }));
    }
    
    // ── column data range hint ────────────────────────────────────────
    function fieldRange(key, type) {
        const d = window.app?.activedata; if(!d?.length) return null;
        if (type==='num'||type==='int') {
            const vs=d.map(r=>parseFloat(r[key])).filter(v=>!isNaN(v)); if(!vs.length) return null;
            return { min:Math.min(...vs), max:Math.max(...vs) };
        }
        if (type==='ts') {
            const vs=d.map(r=>new Date(r[key]).getTime()).filter(v=>!isNaN(v)); if(!vs.length) return null;
            return { min:new Date(Math.min(...vs)).toISOString().slice(0,10), max:new Date(Math.max(...vs)).toISOString().slice(0,10) };
        }
        return null;
    }
    
    function filterHint(type) {
        if (type==='num'||type==='int') return '>1.1  <2  1..5';
        if (type==='ts')  return '2024-06  >2024-01-01  a..b';
        if (type==='bool') return 'true / false';
        return 'search text';
    }
    
    // ════════════════════════════════════════════════════════
    // RENDER HEADER + FILTER ROW
    // ════════════════════════════════════════════════════════
    
    function renderHead() {
        const thead = document.getElementById('dt-thead');
        const frow  = document.getElementById('dt-frow');
        if (!thead) return;
        const vis = S.columns.filter(c => c.visible);
    
        thead.innerHTML = vis.map(c => {
            const ic = S.sortKey===c.key ? (S.sortDir==='asc'?' ↑':' ↓') : '';
            const hasF = !!S.filters[c.key];
            const isAdv = !!S.filters[c.key]?.rules;
            return `<th class="dt-th${hasF?' dt-th-f':''}" data-k="${c.key}" style="width:${c.width}px">
                ${esc(c.label)}${ic}
            </th>`;
        }).join('');
    
        // Скрываем строку простых фильтров когда активен viz-фильтр (не table mode) с маркерами
        const vizFilterActive = VIZ.filterMode !== 'table' && S.activeShapes.length > 0;
        if (vizFilterActive) {
            frow.innerHTML = `<tr><td colspan="${vis.length}" class="dt-frow-viz-msg">
                ⊗ Simple filters hidden — <strong>${VIZ.filterMode}</strong> chart filter active
                (${S.activeShapes.length} markers)
                &nbsp;<button class="dt-frow-restore">Show filters</button>
            </td></tr>`;
            frow.querySelector('.dt-frow-restore')?.addEventListener('click', () => {
                VIZ.filterMode = 'table'; renderHead();
            });
            return;
        }
    
        frow.innerHTML = vis.map(c => {
            const f   = S.filters[c.key];
            const fv  = f?.raw || '';
            const isAdv = !!f?.rules;
            const rng = fieldRange(c.key, c.type);
            const ph  = rng
                ? (c.type==='num'||c.type==='int' ? `${rng.min.toFixed(4)}..${rng.max.toFixed(4)}` : `${rng.min}..${rng.max}`)
                : filterHint(c.type);
            return `<th class="dt-fth" style="position:relative">
                <div class="dt-fi-wrap">
                    <input class="dt-fi${isAdv?' dt-fi-adv':''}" data-k="${c.key}" data-type="${c.type}"
                           placeholder="${esc(ph)}" value="${esc(fv)}"
                           title="${esc(filterTipText(c.type))}" ${isAdv?'readonly':''}>
                    <button class="dt-fi-adv-btn${isAdv?' active':''}" data-k="${c.key}" data-type="${c.type}"
                            title="Advanced filter for ${esc(c.label)}">⊕</button>
                </div>
            </th>`;
        }).join('');
    
        thead.querySelectorAll('.dt-th').forEach(th => th.addEventListener('click', () => {
            if (S.sortKey===th.dataset.k) S.sortDir = S.sortDir==='asc'?'desc':'asc';
            else { S.sortKey=th.dataset.k; S.sortDir='desc'; }
            render();
        }));
    
        // Simple filter input
        frow.querySelectorAll('.dt-fi:not([readonly])').forEach(inp => inp.addEventListener('input', () => {
            setFilter(inp.dataset.k, inp.value, inp.dataset.type, null);
            render();
        }));
    
        // Advanced popup button
        frow.querySelectorAll('.dt-fi-adv-btn').forEach(btn => btn.addEventListener('click', e => {
            e.stopPropagation();
            openAdvPopup(btn.dataset.k, btn.dataset.type, btn);
        }));
    }
    
    function filterTipText(type) {
        if (type==='num'||type==='int') return '>1.1  <2  >=0.5  !=0  1..5  =3';
        if (type==='ts')  return '2024-06  >2024-01-01  2024-01-01..2024-06-30';
        if (type==='bool') return 'true / false / 1 / 0';
        return 'Partial text match';
    }
    
    // ════════════════════════════════════════════════════════
    // ADVANCED FILTER POPUP (per column)
    // ════════════════════════════════════════════════════════
    
    function openAdvPopup(key, type, anchorEl) {
        // Close any existing popup for other column
        const existing = document.getElementById('dt-adv-popup');
        if (existing) {
            if (existing.dataset.key === key) { existing.remove(); return; } // toggle
            existing.remove();
        }
    
        const col   = S.columns.find(c=>c.key===key);
        const label = col?.label || key;
        const rng   = fieldRange(key, type);
    
        // Current rules or default
        const rules = S.filters[key]?.rules
            ? JSON.parse(JSON.stringify(S.filters[key].rules))
            : [{ op:'>', val:'', val2:'', logic:'AND' }];
    
        const pop = document.createElement('div');
        pop.id = 'dt-adv-popup';
        pop.dataset.key = key;
        pop.className = 'dt-adv-pop';
    
        function renderPop() {
            const rangeHint = rng
                ? (type==='num'||type==='int'
                    ? `range: ${rng.min.toFixed(5)} … ${rng.max.toFixed(5)}`
                    : `range: ${rng.min} … ${rng.max}`)
                : '';
    
            pop.innerHTML = `
            <div class="dt-adv-hdr">
                <span><strong>${esc(label)}</strong> filter</span>
                ${rangeHint ? `<span class="dt-adv-rng">${esc(rangeHint)}</span>` : ''}
                <button class="dt-adv-x" id="dt-adv-x">✕</button>
            </div>
            <div class="dt-adv-rules" id="dt-adv-rules">
                ${rules.map((r,i) => renderRule(r,i,type,rng)).join('')}
            </div>
            <button class="dt-adv-add" id="dt-adv-add">＋ Add condition</button>
            <div class="dt-adv-foot">
                <span id="dt-adv-cnt" class="dt-adv-cnt"></span>
                <button class="dt-adv-btn dt-adv-clr" id="dt-adv-clr">Clear</button>
                <button class="dt-adv-btn dt-adv-ok"  id="dt-adv-ok">Apply</button>
            </div>`;
    
            bindPop();
            updateCount();
        }
    
        function renderRule(r, i, type, rng) {
            const noVal  = r.op==='is_null'||r.op==='not_null';
            const showV2 = r.op==='..' ;
            const ph = rng ? (type==='ts'?rng.min:`${rng.min.toFixed(5)}`) : 'value';
            const ph2= rng ? (type==='ts'?rng.max:`${rng.max.toFixed(5)}`) : 'to';
    
            // Filter FOP to relevant ops for this type
            const relevantOps = FOP.filter(o => {
                if (type==='text') return ['contains','not_contains','regex','is_null','not_null','=','!='].includes(o.id);
                if (type==='bool') return ['=','!=','is_null','not_null'].includes(o.id);
                return true; // num/int/ts get all ops
            });
    
            return `<div class="dt-adv-rule" data-i="${i}">
                ${i > 0 ? `<select class="dt-adv-logic" data-i="${i}">
                    <option value="AND"${r.logic==='AND'?' selected':''}>AND</option>
                    <option value="OR"${r.logic==='OR'?' selected':''}>OR</option>
                </select>` : '<span class="dt-adv-where">WHERE</span>'}
                <select class="dt-adv-op" data-i="${i}">
                    ${relevantOps.map(o=>`<option value="${o.id}"${r.op===o.id?' selected':''}>${esc(o.label)}</option>`).join('')}
                </select>
                ${noVal ? '' : `<input class="dt-adv-val" data-i="${i}" data-r="v" value="${esc(r.val)}" placeholder="${esc(ph)}">`}
                ${showV2 ? `<span class="dt-adv-and">…</span><input class="dt-adv-val" data-i="${i}" data-r="v2" value="${esc(r.val2)}" placeholder="${esc(ph2)}">` : ''}
                ${rules.length>1 ? `<button class="dt-adv-del" data-i="${i}">✕</button>` : ''}
            </div>`;
        }
    
        function bindPop() {
            pop.querySelector('#dt-adv-x').onclick  = () => pop.remove();
            pop.querySelector('#dt-adv-clr').onclick = () => { delete S.filters[key]; render(); renderHead(); pop.remove(); };
            pop.querySelector('#dt-adv-ok').onclick  = () => {
                setFilter(key, null, type, rules);
                render(); renderHead(); pop.remove();
            };
            pop.querySelector('#dt-adv-add').onclick = () => {
                rules.push({ op: type==='text'?'contains':'>', val:'', val2:'', logic:'AND' });
                renderPop(); positionPop();
            };
            // Logic selects
            pop.querySelectorAll('.dt-adv-logic').forEach(s => s.addEventListener('change', () => { rules[+s.dataset.i].logic = s.value; updateCount(); }));
            // Op selects → redraw rule for show/hide val2
            pop.querySelectorAll('.dt-adv-op').forEach(s => s.addEventListener('change', () => {
                rules[+s.dataset.i].op = s.value;
                rules[+s.dataset.i].val = ''; rules[+s.dataset.i].val2 = '';
                renderPop(); positionPop();
            }));
            // Value inputs
            pop.querySelectorAll('.dt-adv-val[data-r="v"]').forEach(inp => inp.addEventListener('input', () => { rules[+inp.dataset.i].val=inp.value; updateCount(); }));
            pop.querySelectorAll('.dt-adv-val[data-r="v2"]').forEach(inp => inp.addEventListener('input', () => { rules[+inp.dataset.i].val2=inp.value; updateCount(); }));
            // Delete row
            pop.querySelectorAll('.dt-adv-del').forEach(b => b.addEventListener('click', () => { rules.splice(+b.dataset.i,1); renderPop(); positionPop(); }));
        }
    
        function updateCount() {
            const fn = buildRulesFn(rules, type);
            const cnt = document.getElementById('dt-adv-cnt'); if(!cnt) return;
            if (!fn) { cnt.textContent=''; return; }
            const total = window.app?.activedata?.length||0;
            const match = (window.app?.activedata||[]).filter(r=>{try{return fn(r[key]);}catch(_){return false;}}).length;
            cnt.textContent = `${match} / ${total}`;
            cnt.style.color = match===0 ? '#ef5350' : '#26a69a';
        }
    
        function positionPop() {
            const r = anchorEl.getBoundingClientRect();
            pop.style.top  = (r.bottom + 4) + 'px';
            // Align left edge with anchor, but don't go off-screen
            const pw = 340;
            const left = Math.min(r.left, window.innerWidth - pw - 10);
            pop.style.left = Math.max(8, left) + 'px';
        }
    
        document.body.appendChild(pop);
        renderPop();
        positionPop();
    
        // Close on outside click
        setTimeout(() => document.addEventListener('click', function outside(e) {
            if (!pop.contains(e.target) && e.target !== anchorEl) { pop.remove(); document.removeEventListener('click', outside); }
        }), 50);
    }
    
    
    // ════════════════════════════════════════════════════════
    // RENDER TABLE BODY
    // ════════════════════════════════════════════════════════
    
    function render() {
        if (!panelEl) return;
        renderHead();
    
        let data = getDataWithIndex([...(window.app?.activedata||[])]);
        data = applyFilters(data);
    
        const col = S.columns.find(c=>c.key===S.sortKey);
        data.sort((a,b)=>{
            let va=a[S.sortKey], vb=b[S.sortKey];
            if (col?.type==='ts') { va=new Date(va).getTime(); vb=new Date(vb).getTime(); }
            else { va=parseFloat(va)||0; vb=parseFloat(vb)||0; }
            return S.sortDir==='asc'?va-vb:vb-va;
        });
    
        const total = window.app?.activedata?.length||0;
        const cnt = document.getElementById('dt-cnt');
        if (cnt) cnt.textContent = data.length<total ? `${data.length} / ${total} bars (filtered)` : `${total} bars`;
    
        const vis = S.columns.filter(c=>c.visible);
        if (!data.length) { tbodyEl.innerHTML=`<tr><td colspan="${vis.length}" class="dt-empty">No data matches filter</td></tr>`; return; }
    
        if (S.groupKey) { renderGrouped(data,vis); return; }
    
        const MAX = 2000;
        // Center window on highlighted row so crosshair sync always lands in view
        let startIdx = 0;
        if (S.hlTs) {
            const hlTsNum = +S.hlTs;
            const hlPos = data.findIndex(r => new Date(r.timestamp).getTime() === hlTsNum);
            if (hlPos >= 0) startIdx = Math.max(0, hlPos - Math.floor(MAX / 2));
        }
        const slice = data.slice(startIdx, startIdx + MAX);
    
        // Строим глобальный индекс: сортируем весь activedata по timestamp asc, присваиваем номер
        const allData = window.app?.activedata || [];
        const sortedForIndex = [...allData].sort((a,b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        const indexMap = new Map(sortedForIndex.map((r,i) => [new Date(r.timestamp).getTime(), i]));

        tbodyEl.innerHTML = slice.map(row => {
            const bull  = parseFloat(row.close) >= parseFloat(row.open);
            const rowTs = new Date(row.timestamp).getTime();
            const hl    = (S.hlTs && rowTs === +S.hlTs) ? ' dt-hl' : '';
            const rowWithIndex = { ...row, _index: indexMap.get(rowTs) ?? '' };
            return `<tr class="dt-row${hl}${bull?' dt-bull':' dt-bear'}" data-ts="${rowTs}">
                ${vis.map(c=>`<td class="dt-td${c.type==='bool'?(' '+(rowWithIndex[c.key]?'dt-bool-t':'dt-bool-f')):''}">${esc(fmt(c.type,rowWithIndex[c.key]))}</td>`).join('')}
            </tr>`;
        }).join('') + (data.length > MAX ? `<tr><td colspan="${vis.length}" class="dt-empty">Showing ${MAX} of ${data.length} — use filters</td></tr>` : '');
    }
    
    function renderGrouped(data,vis) {
        const grps={};
        data.forEach(r=>{ const k=String(r[S.groupKey]??'—'); (grps[k]??=[]).push(r); });
        tbodyEl.innerHTML=Object.entries(grps).sort((a,b)=>a[0].localeCompare(b[0])).map(([k,rows])=>
            `<tr class="dt-ghead"><td colspan="${vis.length}"><span class="dt-gtgl" data-gk="${esc(k)}">▼</span> ${esc(k)} <span class="dt-gcnt">(${rows.length})</span></td></tr>`+
            rows.slice(0,500).map(row=>{
                const bull=parseFloat(row.close)>=parseFloat(row.open);
                return `<tr class="dt-row${bull?' dt-bull':' dt-bear'}" data-gk="${esc(k)}" data-ts="${new Date(row.timestamp).getTime()}">
                    ${vis.map(c=>`<td class="dt-td">${esc(fmt(c.type,row[c.key]))}</td>`).join('')}
                </tr>`;
            }).join('')
        ).join('');
        tbodyEl.querySelectorAll('.dt-gtgl').forEach(t=>t.addEventListener('click',()=>{
            const open=t.textContent==='▼'; t.textContent=open?'▶':'▼';
            tbodyEl.querySelectorAll(`tr[data-gk="${t.dataset.gk}"]`).forEach(r=>r.style.display=open?'none':'');
        }));
    }
    
    
    // ════════════════════════════════════════════════════════
    // COLUMN MANAGER
    // ════════════════════════════════════════════════════════
    
    function toggleColMgr(){ colMgrEl.classList.toggle('dt-hidden'); if(!colMgrEl.classList.contains('dt-hidden')) renderColMgr(); }
    
    function renderColMgr(){
        colMgrEl.innerHTML=`<div class="dt-cm-wrap">
            <div class="dt-cm-hdr">Columns <button class="dt-btn" id="dt-cm-x">✕</button></div>
            <div class="dt-cm-note">Drag to reorder · ☑ to show · click label to rename</div>
            <div id="dt-cm-list">${S.columns.map((c,i)=>`
                <div class="dt-cm-row" draggable="true" data-i="${i}">
                    <span class="dt-cm-drag">⠿</span>
                    <input type="checkbox" class="dt-cm-chk" data-i="${i}" ${c.visible?'checked':''}>
                    <input class="dt-cm-lbl" value="${esc(c.label)}" data-i="${i}">
                    <span class="dt-cm-key">${esc(c.key)} <em class="dt-cm-type">${c.type}</em></span>
                </div>`).join('')}</div></div>`;
        document.getElementById('dt-cm-x').onclick=()=>colMgrEl.classList.add('dt-hidden');
        colMgrEl.querySelectorAll('.dt-cm-chk').forEach(x=>x.addEventListener('change',()=>{ S.columns[+x.dataset.i].visible=x.checked; render(); }));
        colMgrEl.querySelectorAll('.dt-cm-lbl').forEach(x=>x.addEventListener('change',()=>{ S.columns[+x.dataset.i].label=x.value; render(); }));
        let di=null;
        colMgrEl.querySelectorAll('.dt-cm-row').forEach(row=>{
            row.addEventListener('dragstart',()=>{ di=+row.dataset.i; row.style.opacity='.4'; });
            row.addEventListener('dragend',  ()=>row.style.opacity='');
            row.addEventListener('dragover', e=>{ e.preventDefault(); row.style.borderTop='2px solid #2962FF'; });
            row.addEventListener('dragleave',()=>row.style.borderTop='');
            row.addEventListener('drop',     ()=>{ row.style.borderTop=''; if(di!=null&&di!==+row.dataset.i){ const m=S.columns.splice(di,1)[0]; S.columns.splice(+row.dataset.i,0,m); renderColMgr(); render(); } });
        });
    }
    
    // ════════════════════════════════════════════════════════
    // GROUP PICKER
    // ════════════════════════════════════════════════════════
    
    function showGroupPicker(){
        document.getElementById('dt-gpick')?.remove();
        const pk=document.createElement('div'); pk.id='dt-gpick'; pk.className='dt-popup';
        pk.innerHTML=`<div class="dt-pp-hdr">Group by</div>
            <div class="dt-pp-item" data-k="">— None —</div>
            ${S.columns.map(c=>`<div class="dt-pp-item${S.groupKey===c.key?' dt-pp-act':''}" data-k="${c.key}">${esc(c.label)}</div>`).join('')}`;
        const r=document.getElementById('dt-btn-grp').getBoundingClientRect();
        pk.style=`top:${r.bottom+2}px;right:${window.innerWidth-r.right}px`;
        document.body.appendChild(pk);
        pk.querySelectorAll('.dt-pp-item').forEach(it=>it.addEventListener('click',()=>{ S.groupKey=it.dataset.k||null; pk.remove(); render(); }));
        setTimeout(()=>document.addEventListener('click',()=>pk.remove(),{once:true}),50);
    }
    
    // ════════════════════════════════════════════════════════
    // ВИЗУАЛИЗАЦИЯ НА ГРАФИКЕ
    // ════════════════════════════════════════════════════════
    
    // Доступные типы маркеров — проверены в TV v29.6
    // createMultipointShape возвращает Promise<EntityId> в v29+
    const SHAPE_TYPES = [
        { id:'arrow_up',        label:'↑ Стрелка вверх' },
        { id:'arrow_down',      label:'↓ Стрелка вниз' },
        { id:'flag',            label:'🚩 Флаг' },
        { id:'label_up',        label:'📌 Метка вверх' },
        { id:'label_down',      label:'📌 Метка вниз' },
        { id:'balloon',         label:'💬 Balloon' },
        { id:'vertical_line',   label:'| Вертикаль' },
        { id:'horizontal_line', label:'─ Горизонталь' },
    ];
    
    // Пресеты визуализации
    function loadPresets() {
        try { return JSON.parse(localStorage.getItem('dt_viz_presets')||'[]'); } catch(_){ return []; }
    }
    function savePresetLocal(preset) {
        const list = loadPresets().filter(p=>p.name!==preset.name);
        list.unshift(preset);
        localStorage.setItem('dt_viz_presets', JSON.stringify(list.slice(0,20)));
    }
    async function sharePreset(preset) {
        try {
            const res = await fetch('/api/viz-presets', { method:'POST', credentials:'include',
                headers:{'Content-Type':'application/json'}, body: JSON.stringify(preset) });
            return res.ok;
        } catch(_){ return false; }
    }
    async function loadSharedPresets() {
        try {
            const res = await fetch('/api/viz-presets', { credentials:'include' });
            return res.ok ? await res.json() : [];
        } catch(_){ return []; }
    }
    
    // Текущие настройки визуализации
    // ════════════════════════════════════════════════════════
    // AF ENGINE — helpers used by viz filter builder
    // ════════════════════════════════════════════════════════
    
    function afMakeGroup() { return { logic: 'AND', conditions: [ afMakeCond() ] }; }
    function afMakeCond()  { return { field: '', op: '>', value: '', value2: '' }; }
    
    function vzEnsureGroups() {
        if (!VIZ.vizGroups || !VIZ.vizGroups.length) VIZ.vizGroups = [ afMakeGroup() ];
    }
    
    const AF_OPS = [
        { id:'>',            label:'> больше'       },
        { id:'>=',           label:'≥ не меньше'    },
        { id:'<',            label:'< меньше'       },
        { id:'<=',           label:'≤ не больше'    },
        { id:'=',            label:'= равно'        },
        { id:'!=',           label:'≠ не равно'     },
        { id:'between',      label:'∈ [a … b]'      },
        { id:'contains',     label:'⊇ содержит'     },
        { id:'not_contains', label:'⊉ не содержит'  },
        { id:'starts',       label:'↳ начинается'   },
        { id:'regex',        label:'∼ RegExp'        },
        { id:'is_null',      label:'= пусто'        },
        { id:'not_null',     label:'≠ не пусто'     },
    ];
    
    function afBuildCondFn(cond) {
        const { field, op, value, value2 } = cond;
        const col  = S.columns.find(c => c.key === field);
        const type = col?.type || 'num';
        return function(row) {
            const raw = row[field];
            if (op === 'is_null')      return raw == null || raw === '' || raw === false;
            if (op === 'not_null')     return raw != null && raw !== '';
            if (op === 'contains')     return String(raw??'').toLowerCase().includes(String(value).toLowerCase());
            if (op === 'not_contains') return !String(raw??'').toLowerCase().includes(String(value).toLowerCase());
            if (op === 'starts')       return String(raw??'').toLowerCase().startsWith(String(value).toLowerCase());
            if (op === 'regex') { try { return new RegExp(value,'i').test(String(raw??'')); } catch(_){ return false; } }
            // Bool type
            if (type === 'bool') {
                const bv = (raw===true||raw==='true'||raw===1||raw==='1');
                const want = ['1','true','yes'].includes(String(value).toLowerCase());
                if (op==='=')  return bv===want;
                if (op==='!=') return bv!==want;
                return false;
            }
            const v = type==='ts' ? new Date(raw).getTime()   : parseFloat(raw);
            const n = type==='ts' ? new Date(value).getTime() : parseFloat(value);
            if (isNaN(v)||isNaN(n)) return false;
            if (op==='between') {
                const n2 = type==='ts' ? new Date(value2).getTime() : parseFloat(value2);
                return !isNaN(n2) && v >= Math.min(n,n2) && v <= Math.max(n,n2);
            }
            if (op==='>') return v>n; if (op==='>=') return v>=n;
            if (op==='<') return v<n; if (op==='<=') return v<=n;
            if (op==='=') return v===n; if (op==='!=') return v!==n;
            return false;
        };
    }
    
    function afParseFormula(src) {
        if (!src.trim()) return null;
        const colSet = new Set(S.columns.map(c=>c.key));
        // Лексер
        const toks = []; let i=0;
        while (i < src.length) {
            if (/\s/.test(src[i])) { i++; continue; }
            if (src[i]==='(') { toks.push({t:'LP'}); i++; continue; }
            if (src[i]===')') { toks.push({t:'RP'}); i++; continue; }
            const opM = src.slice(i).match(/^(>=|<=|!=|>|<|=)/);
            if (opM) { toks.push({t:'OP',v:opM[1]}); i+=opM[1].length; continue; }
            if (src[i]==='"'||src[i]==="'") {
                const q=src[i]; let j=i+1, s='';
                while(j<src.length&&src[j]!==q) s+=src[j++];
                toks.push({t:'VAL',v:s}); i=j+1; continue;
            }
            let j=i; while(j<src.length&&!/[\s()><=!]/.test(src[j])) j++;
            const w=src.slice(i,j); i=j;
            const wu=w.toUpperCase();
            if (wu==='AND')     { toks.push({t:'AND'}); continue; }
            if (wu==='OR')      { toks.push({t:'OR'});  continue; }
            if (wu==='NOT')     { toks.push({t:'NOT'}); continue; }
            if (wu==='BETWEEN') { toks.push({t:'OP',v:'between'}); continue; }
            if (wu==='CONTAINS')  { toks.push({t:'OP',v:'contains'}); continue; }
            if (colSet.has(w))  toks.push({t:'FIELD',v:w});
            else                toks.push({t:'VAL',v:w});
        }
        let pos=0;
        const peek=()=>toks[pos], eat=()=>toks[pos++];
        function parseOr()  { let l=parseAnd(); while(peek()?.t==='OR'){eat();l={t:'OR',l,r:parseAnd()};} return l; }
        function parseAnd() { let l=parseNot(); while(peek()?.t==='AND'){eat();l={t:'AND',l,r:parseNot()};} return l; }
        function parseNot() { if(peek()?.t==='NOT'){eat();return {t:'NOT',e:parseAtom()};} return parseAtom(); }
        function parseAtom() {
            if(peek()?.t==='LP'){eat();const e=parseOr();if(peek()?.t!=='RP')throw new Error('Missing )');eat();return e;}
            const f=eat(); if(f?.t!=='FIELD') throw new Error(`Expected field, got "${f?.v??f?.t}"`);
            const o=eat(); if(!o||o.t!=='OP') throw new Error(`Expected operator after "${f.v}"`);
            if(o.v==='is_null'||o.v==='not_null') return {t:'COND',field:f.v,op:o.v,value:'',value2:''};
            const v=eat(); let v2='';
            if(o.v==='between'&&peek()?.t==='AND'){eat();v2=eat()?.v??'';}
            return {t:'COND',field:f.v,op:o.v,value:v?.v??'',value2:v2};
        }
        function compile(n) {
            if(!n) return ()=>true;
            if(n.t==='AND'){const l=compile(n.l),r=compile(n.r);return row=>l(row)&&r(row);}
            if(n.t==='OR') {const l=compile(n.l),r=compile(n.r);return row=>l(row)||r(row);}
            if(n.t==='NOT'){const e=compile(n.e);return row=>!e(row);}
            if(n.t==='COND') return afBuildCondFn(n);
            return ()=>true;
        }
        return compile(parseOr());
    }
    
    function afFieldStats(field) {
        const d = window.app?.activedata; if(!d?.length||!field) return null;
        const col = S.columns.find(c=>c.key===field); if(!col) return null;
        if (col.type==='num'||col.type==='int') {
            const vs=d.map(r=>parseFloat(r[field])).filter(v=>!isNaN(v)); if(!vs.length) return null;
            return `${Math.min(...vs).toFixed(5)} … ${Math.max(...vs).toFixed(5)}`;
        }
        if (col.type==='ts') {
            const vs=d.map(r=>new Date(r[field]).getTime()).filter(v=>!isNaN(v)); if(!vs.length) return null;
            return `${new Date(Math.min(...vs)).toISOString().slice(0,10)} … ${new Date(Math.max(...vs)).toISOString().slice(0,10)}`;
        }
        return null;
    }
    
    // ════════════════════════════════════════════════════════
    // NAV BUTTON
    // ════════════════════════════════════════════════════════
    
    // ════════════════════════════════════════════════════════
    // COLUMN INIT
    // ════════════════════════════════════════════════════════
    
    function initCols() {
        S.columns = BASE.map(c => ({...c}));
        BASE.forEach(c => S.knownKeys.add(c.key));
    }
    
    function syncNewCols() {
        const d = window.app?.activedata;
        if (!d?.length) return;
        Object.keys(d[0]).forEach(key => {
            if (!S.knownKeys.has(key)) {
                S.knownKeys.add(key);
                S.columns.push({ key, label: key, visible: true, width: 90, type: 'num' });
            }
        });
    }
    
    // ════════════════════════════════════════════════════════
    // PANEL BUILD
    // ════════════════════════════════════════════════════════
    
    function buildPanel() {
        if (panelEl) return;
        panelEl = document.createElement('div');
        panelEl.id = 'dt-panel';
        panelEl.style.cssText = `height:${S.panelH}px;position:relative`;
    
        panelEl.innerHTML = `
            <div id="dt-resizer"></div>
            <div id="dt-toolbar">
                <span id="dt-title">📊 Data Table</span>
                <span id="dt-cnt"></span>
                <div style="margin-left:auto;display:flex;gap:4px;align-items:center">
                    <button class="dt-btn" id="dt-btn-cols">⚙ Columns</button>
                    <button class="dt-btn" id="dt-btn-grp">⊞ Group</button>
                    <button class="dt-btn" id="dt-btn-clf" title="Clear all filters">✕ Filters</button>
                    <button class="dt-btn dt-btn-viz" id="dt-btn-viz" title="Chart markers">📈 Chart</button>
                    <button class="dt-btn" id="dt-btn-hide">✕</button>
                </div>
            </div>
            <div id="dt-colmgr" class="dt-hidden"></div>
            <div id="dt-vizmgr" class="dt-hidden"></div>
            <div id="dt-twrap">
                <table id="dt-tbl">
                    <thead><tr id="dt-thead"></tr><tr id="dt-frow"></tr></thead>
                    <tbody id="dt-tbody"></tbody>
                </table>
            </div>`;
    
        const chartContainer = document.querySelector('#tv-chart-container') ||
                               document.querySelector('.chart-container')     ||
                               document.querySelector('.layout__area--center') ||
                               document.body;
        chartContainer.appendChild(panelEl);
    
        colMgrEl = panelEl.querySelector('#dt-colmgr');
        tbodyEl  = panelEl.querySelector('#dt-tbody');
    
        // Resizer
        const resizer = panelEl.querySelector('#dt-resizer');
        let startY, startH;
        resizer.addEventListener('mousedown', e => {
            startY = e.clientY; startH = panelEl.offsetHeight;
            const onMove = e => { panelEl.style.height = Math.max(120, startH - (e.clientY - startY)) + 'px'; };
            const onUp   = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    
        // Toolbar
        panelEl.querySelector('#dt-btn-cols').onclick = toggleColMgr;
        panelEl.querySelector('#dt-btn-grp').onclick  = showGroupPicker;
        panelEl.querySelector('#dt-btn-clf').onclick  = () => { S.filters = {}; render(); };
        panelEl.querySelector('#dt-btn-viz').onclick  = toggleVizMgr;
        panelEl.querySelector('#dt-btn-hide').onclick = hide;
    
        // Row click → jump chart
        tbodyEl.addEventListener('click', e => {
            const row = e.target.closest('tr[data-ts]');
            if (row) {
                const ts = +row.dataset.ts;
                try { window.app?.widget?.activeChart()?.setVisibleRange?.({ from: Math.floor(ts/1000)-3600, to: Math.floor(ts/1000)+3600 }); } catch(_){}
            }
        });
    }
    
    // ════════════════════════════════════════════════════════
    // NAV BUTTON
    // ════════════════════════════════════════════════════════
    
    function buildNavBtn() {
        if (document.getElementById('dt-nav-btn')) return;
        const btn = document.createElement('button');
        btn.id        = 'dt-nav-btn';
        btn.className = 'nav-btn';
        btn.textContent = '📊 Table';
        btn.addEventListener('click', toggle);
        const nav = document.querySelector('.navbar-right');
        if (nav) nav.insertBefore(btn, nav.firstChild);
        else document.body.appendChild(btn);
    }
    
    let VIZ = {
        shapeType:   'arrow_up',
        color:       '#2962FF',
        text:        '',
        position:    'aboveBar',   // 'aboveBar' | 'belowBar' | 'onBar'
        // Filter mode: 'table' | 'simple' | 'visual' | 'formula'
        filterMode:  'table',
        // Simple filter (single column)
        filterCol:   '',
        filterVal:   '',
        // Visual filter (multi-column groups, same as AF)
        vizGroups:   [],
        // Formula filter
        vizFormula:  '',
        filterFn:    null,
        name:        'My Marker',
    };
    // vizGroups инициализируется лениво в vzEnsureGroups()
    
    function toggleVizMgr() {
        // Viz manager открывается как floating popup поверх всего
        let popup = document.getElementById('dt-viz-popup');
        if (popup) { popup.remove(); return; }
        popup = document.createElement('div');
        popup.id = 'dt-viz-popup';
        document.body.appendChild(popup);
        renderVizMgr(popup);
        // Позиционируем рядом с кнопкой
        const btn = document.getElementById('dt-btn-viz');
        if (btn) {
            const r = btn.getBoundingClientRect();
            popup.style.top  = (r.top - popup.offsetHeight - 8) + 'px';
            popup.style.left = Math.max(10, r.right - popup.offsetWidth) + 'px';
            // Пересчёт после рендера
            requestAnimationFrame(() => {
                const ph = popup.offsetHeight;
                const pw = popup.offsetWidth;
                popup.style.top  = Math.max(10, r.top - ph - 8) + 'px';
                popup.style.left = Math.max(10, r.right - pw) + 'px';
            });
        }
        // Кнопка "Chart" подсвечивается
        document.getElementById('dt-nav-btn')?.classList.add('nav-btn-active');
        document.getElementById('dt-btn-viz').style.borderColor = '#2962FF';
    }
    
    
    // ════════════════════════════════════════════════════════
    // VIZ FILTER — тело фильтра внутри Chart popup
    // ════════════════════════════════════════════════════════
    
    function vzFilterBody(cols) {
        const m = VIZ.filterMode;
        if (m === 'table') {
            return `<div class="vz-ftable-hint">
                <span class="vz-fhint-ico">↩</span>
                Маркеры ставятся на строки, прошедшие фильтры таблицы
                (строка поиска под заголовками).
                <br><span id="vz-table-cnt" class="vz-cnt"></span>
            </div>`;
        }
        if (m === 'simple') {
            // Один столбец + значение
            const hint = VIZ.filterCol ? afFieldStats(VIZ.filterCol) : '';
            return `<div class="vz-fsimple">
                <div class="vz-frow">
                    <select class="dt-vi vz-fs-col" id="vz-sc">
                        <option value="">— field —</option>
                        ${cols.map(x=>`<option value="${x.key}"${VIZ.filterCol===x.key?' selected':''}>${esc(x.label)} (${x.type})</option>`).join('')}
                    </select>
                    <input class="dt-vi vz-fs-val" id="vz-sv"
                           value="${esc(VIZ.filterVal)}"
                           placeholder="${hint||filterHint(cols.find(x=>x.key===VIZ.filterCol)?.type||'num')}">
                </div>
                ${hint?`<span class="vz-cnt">${esc(hint)}</span>`:''}
                <span id="vz-simple-cnt" class="vz-cnt"></span>
            </div>`;
        }
        if (m === 'visual') {
            // Multi-group visual builder (переиспользуем AF функции с префиксом vz-)
            return `<div class="vz-fvisual">
                ${VIZ.vizGroups.map((g,gi) => vzHtmlGroup(g,gi,cols)).join('')}
                <button class="af-add-g vz-add-g" id="vz-add-g">＋ Add group (OR)</button>
                <span id="vz-vis-cnt" class="vz-cnt"></span>
            </div>`;
        }
        if (m === 'formula') {
            const ex = ['close > 1.15 AND volume > 1000', 'atr < 0.001 OR close < open', 'close BETWEEN 1.10 AND 1.20'];
            return `<div class="vz-fformula">
                <textarea id="vz-fml" class="af-fml" style="height:60px" placeholder="close > 1.15 AND volume > 1000">${esc(VIZ.vizFormula)}</textarea>
                <div id="vz-fml-err" class="af-ferr"></div>
                <div class="af-chips" style="margin-top:4px">
                    ${cols.map(x=>`<span class="af-chip vz-chip" data-k="${x.key}">${esc(x.label)}</span>`).join('')}
                </div>
                <div class="af-exlist" style="margin-top:4px">
                    ${ex.map(e=>`<code class="af-ex vz-ex" data-e="${esc(e)}">${esc(e)}</code>`).join('')}
                </div>
                <span id="vz-fml-cnt" class="vz-cnt"></span>
            </div>`;
        }
        return '';
    }
    
    function vzHtmlGroup(g, gi, cols) {
        const canDel = VIZ.vizGroups.length > 1;
        return `<div class="af-grp vz-grp" data-vgi="${gi}">
            <div class="af-grp-hdr">
                <span class="af-grp-lbl">Group ${gi+1}</span>
                ${gi>0?'<div class="af-or-badge">OR</div>':''}
                <button class="af-lg${g.logic==='AND'?' af-on':''}" data-vgi="${gi}" data-l="AND">AND</button>
                <button class="af-lg${g.logic==='OR'?' af-on':''}"  data-vgi="${gi}" data-l="OR">OR</button>
                ${canDel?`<button class="af-ib vz-del-g" data-vgi="${gi}">✕</button>`:''}
            </div>
            <div class="af-conds">
                ${g.conditions.map((cd,ci) => vzHtmlCond(cd,gi,ci,g.logic,cols)).join('')}
            </div>
            <button class="af-add-c af-ib vz-add-c" data-vgi="${gi}">＋ condition</button>
        </div>`;
    }
    
    function vzHtmlCond(cd, gi, ci, logic, cols) {
        const noVal = cd.op==='is_null'||cd.op==='not_null';
        const showV2= cd.op==='between';
        const stats = afFieldStats(cd.field);
        const ph    = stats||'value';
        return `<div class="af-cond" data-vgi="${gi}" data-vci="${ci}">
            <span class="af-cond-lbl">${ci===0?'WHERE':logic}</span>
            <select class="af-s af-s-f vz-sf" data-vgi="${gi}" data-vci="${ci}">
                <option value="">— field —</option>
                ${cols.map(x=>`<option value="${x.key}"${cd.field===x.key?' selected':''}>${esc(x.label)} (${x.type})</option>`).join('')}
            </select>
            <select class="af-s af-s-o vz-so" data-vgi="${gi}" data-vci="${ci}">
                ${AF_OPS.map(o=>`<option value="${o.id}"${cd.op===o.id?' selected':''}>${esc(o.label)}</option>`).join('')}
            </select>
            ${noVal?'':`<input class="af-v vz-val" data-vgi="${gi}" data-vci="${ci}" data-r="v" value="${esc(cd.value)}" placeholder="${esc(ph)}">`}
            ${showV2?`<span class="af-and">AND</span><input class="af-v vz-val" data-vgi="${gi}" data-vci="${ci}" data-r="v2" value="${esc(cd.value2)}" placeholder="${esc(ph)}">`:''}
            ${stats?`<span class="af-hint">${esc(stats)}</span>`:''}
            <button class="af-ib vz-del-c" data-vgi="${gi}" data-vci="${ci}">✕</button>
        </div>`;
    }
    
    // Собрать данные из DOM → VIZ.vizGroups
    function vzSyncGroups(el) {
        el.querySelectorAll('.vz-sf').forEach(s => {
            const c = VIZ.vizGroups[+s.dataset.vgi]?.conditions[+s.dataset.vci]; if(c) c.field = s.value;
        });
        el.querySelectorAll('.vz-so').forEach(s => {
            const c = VIZ.vizGroups[+s.dataset.vgi]?.conditions[+s.dataset.vci]; if(c) c.op = s.value;
        });
        el.querySelectorAll('.vz-val[data-r="v"]').forEach(inp => {
            const c = VIZ.vizGroups[+inp.dataset.vgi]?.conditions[+inp.dataset.vci]; if(c) c.value = inp.value;
        });
        el.querySelectorAll('.vz-val[data-r="v2"]').forEach(inp => {
            const c = VIZ.vizGroups[+inp.dataset.vgi]?.conditions[+inp.dataset.vci]; if(c) c.value2 = inp.value;
        });
    }
    
    // Скомпилировать фильтр из текущих настроек VIZ
    function vzBuildFilterFn() {
        const m = VIZ.filterMode;
        if (m === 'table') {
            // Используем простые фильтры таблицы (S.filters)
            return null; // null → applyFilters() использует S.filters автоматически
        }
        if (m === 'simple') {
            if (!VIZ.filterCol || !VIZ.filterVal) return null;
            const col = S.columns.find(c=>c.key===VIZ.filterCol);
            const fn  = parseSimple(VIZ.filterVal, col?.type||'num');
            if (!fn) return null;
            return row => { try { return fn(row[VIZ.filterCol]); } catch(_) { return false; } };
        }
        if (m === 'visual') {
            // Переиспользуем afBuildFn с VIZ.vizGroups вместо AF.groups
            const gfns = VIZ.vizGroups.map(g => {
                const fns = g.conditions
                    .filter(cd => cd.field && (cd.op==='is_null'||cd.op==='not_null'||cd.value!==''))
                    .map(cd => afBuildCondFn(cd));
                if (!fns.length) return null;
                return g.logic==='AND' ? row=>fns.every(fn=>fn(row)) : row=>fns.some(fn=>fn(row));
            }).filter(Boolean);
            if (!gfns.length) return null;
            return gfns.length===1 ? gfns[0] : row=>gfns.some(fn=>fn(row));
        }
        if (m === 'formula') {
            if (!VIZ.vizFormula.trim()) return null;
            try { return afParseFormula(VIZ.vizFormula); } catch(_) { return null; }
        }
        return null;
    }
    
    // Привязка событий фильтра внутри viz-popup
    function bindVzFilter(popup) {
        const el = document.getElementById('vz-fbody');
        if (!el) return;
        const cols = S.columns;
        const m = VIZ.filterMode;
    
        // Вкладки
        popup.querySelectorAll('.vz-ftab').forEach(t => t.addEventListener('click', () => {
            VIZ.filterMode = t.dataset.fm;
            if (VIZ.filterMode === 'visual') vzEnsureGroups();
            const fb = document.getElementById('vz-fbody');
            if (fb) { fb.innerHTML = vzFilterBody(cols); bindVzFilter(popup); }
            popup.querySelectorAll('.vz-ftab').forEach(x => x.classList.toggle('vz-fon', x.dataset.fm===VIZ.filterMode));
            vzUpdateCnt();
        }));
    
        if (m === 'table') {
            vzUpdateCnt();
        }
    
        if (m === 'simple') {
            const scSel = document.getElementById('vz-sc');
            const svInp = document.getElementById('vz-sv');
            scSel?.addEventListener('change', () => { VIZ.filterCol=scSel.value; el.innerHTML=vzFilterBody(cols); bindVzFilter(popup); vzUpdateCnt(); });
            svInp?.addEventListener('input',  () => { VIZ.filterVal=svInp.value; vzUpdateCnt(); });
            vzUpdateCnt();
        }
    
        if (m === 'visual') {
            // Add/del group
            el.querySelector('#vz-add-g')?.addEventListener('click', () => {
                vzSyncGroups(el); VIZ.vizGroups.push(afMakeGroup());
                el.innerHTML=vzFilterBody(cols); bindVzFilter(popup); vzUpdateCnt();
            });
            el.querySelectorAll('.vz-del-g').forEach(b => b.addEventListener('click', () => {
                vzSyncGroups(el); VIZ.vizGroups.splice(+b.dataset.vgi,1);
                el.innerHTML=vzFilterBody(cols); bindVzFilter(popup); vzUpdateCnt();
            }));
            // Add/del condition
            el.querySelectorAll('.vz-add-c').forEach(b => b.addEventListener('click', () => {
                vzSyncGroups(el); VIZ.vizGroups[+b.dataset.vgi]?.conditions.push(afMakeCond());
                el.innerHTML=vzFilterBody(cols); bindVzFilter(popup); vzUpdateCnt();
            }));
            el.querySelectorAll('.vz-del-c').forEach(b => b.addEventListener('click', () => {
                vzSyncGroups(el); const g=VIZ.vizGroups[+b.dataset.vgi];
                if(g?.conditions.length>1){g.conditions.splice(+b.dataset.vci,1);el.innerHTML=vzFilterBody(cols);bindVzFilter(popup);}
            }));
            // Logic AND/OR
            el.querySelectorAll('.af-lg').forEach(b => b.addEventListener('click', () => {
                vzSyncGroups(el); VIZ.vizGroups[+b.dataset.vgi].logic=b.dataset.l;
                el.innerHTML=vzFilterBody(cols); bindVzFilter(popup); vzUpdateCnt();
            }));
            // Field/op change → redraw
            el.querySelectorAll('.vz-sf,.vz-so').forEach(s => s.addEventListener('change', () => {
                vzSyncGroups(el); el.innerHTML=vzFilterBody(cols); bindVzFilter(popup); vzUpdateCnt();
            }));
            // Value live preview
            el.querySelectorAll('.vz-val').forEach(inp => inp.addEventListener('input', () => {
                vzSyncGroups(el); vzUpdateCnt();
            }));
        }
    
        if (m === 'formula') {
            const ta  = document.getElementById('vz-fml');
            const err = document.getElementById('vz-fml-err');
            ta?.addEventListener('input', () => {
                VIZ.vizFormula = ta.value;
                try { afParseFormula(ta.value); err.textContent=''; } catch(e) { err.textContent='⚠ '+e.message; }
                vzUpdateCnt();
            });
            el.querySelectorAll('.vz-chip').forEach(ch => ch.addEventListener('click', () => {
                if(!ta) return;
                const s=ta.selectionStart, e=ta.selectionEnd;
                ta.value=ta.value.slice(0,s)+ch.dataset.k+ta.value.slice(e);
                ta.selectionStart=ta.selectionEnd=s+ch.dataset.k.length; ta.focus(); VIZ.vizFormula=ta.value;
            }));
            el.querySelectorAll('.vz-ex').forEach(ex => ex.addEventListener('click', () => {
                if(ta){ta.value=ex.dataset.e;VIZ.vizFormula=ta.value;ta.focus();}
            }));
        }
    }
    
    function vzUpdateCnt() {
        const m = VIZ.filterMode;
        const cntId = {table:'vz-table-cnt',simple:'vz-simple-cnt',visual:'vz-vis-cnt',formula:'vz-fml-cnt'}[m];
        const el = document.getElementById(cntId);
        if (!el) return;
        const total = window.app?.activedata?.length||0;
        try {
            let fn = vzBuildFilterFn();
            let data = getDataWithIndex([...(window.app?.activedata||[])]);
            if (!fn) {
                // table mode — применяем текущие S.filters
                data = applyFilters(data);
            } else {
                data = data.filter(row => { try{return fn(row);}catch(_){return false;} });
            }
            el.textContent = `${data.length} / ${total} rows will get markers`;
            el.style.color = data.length===0?'#ef5350':'#26a69a';
        } catch(e) { el.textContent=''; }
    }
    
    function renderVizMgr(container) {
        const el = container || document.getElementById('dt-viz-popup');
        if (!el) return;
        const presets = loadPresets();
        const cols = S.columns;
    
        el.innerHTML = `<div class="dt-viz-wrap">
            <div class="dt-cm-hdr">📈 Chart Marker
                <button class="dt-btn" id="dt-viz-x" title="Закрыть и вернуться к таблице">✕ Close</button>
            </div>
            <div class="dt-viz-body">
                <!-- Левая колонка: настройки -->
                <div class="dt-viz-col">
                    <label class="dt-vl">Preset name</label>
                    <input class="dt-vi" id="vz-name" value="${esc(VIZ.name)}" placeholder="My Marker">
    
                    <label class="dt-vl">Marker type</label>
                    <select class="dt-vi" id="vz-shape">
                        ${SHAPE_TYPES.map(s=>`<option value="${s.id}"${VIZ.shapeType===s.id?' selected':''}>${s.label}</option>`).join('')}
                    </select>
    
                    <label class="dt-vl">Color</label>
                    <input type="color" class="dt-vi-color" id="vz-color" value="${VIZ.color}">
    
                    <label class="dt-vl">Label text (optional)</label>
                    <input class="dt-vi" id="vz-text" value="${esc(VIZ.text)}" placeholder="Buy / Sell / ...">
    
                    <label class="dt-vl">Position</label>
                    <select class="dt-vi" id="vz-pos">
                        <option value="aboveBar"${VIZ.position==='aboveBar'?' selected':''}>Above bar</option>
                        <option value="belowBar"${VIZ.position==='belowBar'?' selected':''}>Below bar</option>
                        <option value="onBar"${VIZ.position==='onBar'?' selected':''}>On bar</option>
                    </select>
                </div>
                <!-- Правая колонка: фильтр для маркера -->
                <div class="dt-viz-col">
                    <label class="dt-vl">Apply marker to rows matching…</label>
    
                    <!-- Вкладки типа фильтра -->
                    <div class="vz-ftabs">
                        <button class="vz-ftab${VIZ.filterMode==='table'?' vz-fon':''}"   data-fm="table">← Table filters</button>
                        <button class="vz-ftab${VIZ.filterMode==='simple'?' vz-fon':''}"  data-fm="simple">Simple</button>
                        <button class="vz-ftab${VIZ.filterMode==='visual'?' vz-fon':''}"  data-fm="visual">Visual</button>
                        <button class="vz-ftab${VIZ.filterMode==='formula'?' vz-fon':''}" data-fm="formula">Formula</button>
                    </div>
    
                    <div id="vz-fbody">${vzFilterBody(cols)}</div>
    
                    <div class="dt-viz-actions" style="margin-top:10px">
                        <button class="dt-btn dt-btn-apply" id="vz-apply">📈 Apply to chart</button>
                        <button class="dt-btn" id="vz-clear">🗑 Clear</button>
                        <button class="dt-btn${S.autoViz?' dt-btn-auto':''}" id="vz-auto" title="Auto-recompute markers when new data arrives">⟳ Auto: ${S.autoViz?'ON':'OFF'}</button>
                    </div>
                    <div class="dt-viz-actions">
                        <button class="dt-btn" id="vz-save">💾 Save preset</button>
                        <button class="dt-btn" id="vz-share">🌐 Share</button>
                    </div>
    
                    <!-- Пресеты -->
                    <label class="dt-vl">Saved presets</label>
                    <div id="vz-presets">
                        ${presets.length ? presets.map(p=>`
                            <div class="dt-preset-row">
                                <button class="dt-preset-load" data-name="${esc(p.name)}">${esc(p.name)}</button>
                                <button class="dt-preset-del"  data-name="${esc(p.name)}">✕</button>
                            </div>`).join('') : '<span class="dt-cm-note">No presets yet</span>'}
                    </div>
                </div>
            </div>
        </div>`;
    
        document.getElementById('dt-viz-x').onclick = () => {
            document.getElementById('dt-viz-popup')?.remove();
            document.getElementById('dt-btn-viz').style.borderColor = '';
            // Показываем таблицу если была скрыта
            if (!S.visible) show();
        };
    
        // Привязываем filter tabs + visual/formula events
        bindVzFilter(el);
    
        // Apply / Clear
        document.getElementById('vz-apply').onclick = applyMarkers;
        document.getElementById('vz-clear').onclick  = clearMarkers;
        document.getElementById('vz-auto').onclick   = () => {
            S.autoViz = !S.autoViz;
            const btn = document.getElementById('vz-auto');
            if (btn) {
                btn.textContent  = '⟳ Auto: ' + (S.autoViz ? 'ON' : 'OFF');
                btn.className    = 'dt-btn' + (S.autoViz ? ' dt-btn-auto' : '');
            }
        };
    
        // Save
        document.getElementById('vz-save').onclick = () => {
            collectVIZ();
            savePresetLocal({...VIZ});
            renderVizMgr();
        };
    
        // Share
        document.getElementById('vz-share').onclick = async () => {
            collectVIZ();
            const ok = await sharePreset({...VIZ});
            alert(ok ? 'Пресет опубликован! Другие пользователи смогут его загрузить.' : 'Ошибка при публикации. Проверьте /api/viz-presets.');
        };
    
        // Загрузка пресетов
        el.querySelectorAll('.dt-preset-load').forEach(btn => btn.addEventListener('click', () => {
            const p = loadPresets().find(p=>p.name===btn.dataset.name);
            if (!p) return;
            VIZ = {...p};
            renderVizMgr();
        }));
        el.querySelectorAll('.dt-preset-del').forEach(btn => btn.addEventListener('click', () => {
            const list = loadPresets().filter(p=>p.name!==btn.dataset.name);
            localStorage.setItem('dt_viz_presets', JSON.stringify(list));
            renderVizMgr();
        }));
    }
    
    function collectVIZ() {
        VIZ.name      = document.getElementById('vz-name')?.value  || 'Marker';
        VIZ.shapeType = document.getElementById('vz-shape')?.value || 'arrow_up';
        VIZ.color     = document.getElementById('vz-color')?.value || '#2962FF';
        VIZ.text      = document.getElementById('vz-text')?.value  || '';
        VIZ.position  = document.getElementById('vz-pos')?.value   || 'aboveBar';
        // filterMode уже хранится в VIZ.filterMode, обновляем только simple fields
        const scSel = document.getElementById('vz-sc');
        const svInp = document.getElementById('vz-sv');
        if (scSel) VIZ.filterCol = scSel.value;
        if (svInp) VIZ.filterVal = svInp.value;
        const fml = document.getElementById('vz-fml');
        if (fml) VIZ.vizFormula = fml.value;
        // vizGroups синхронизируются через vzSyncGroups при событиях
    }
    
    // ── Применение маркеров на график ────────────────────────────────────────
    
    async function applyMarkers() {
        collectVIZ();
        await clearMarkers();
    
        const chart = window.app?.widget?.activeChart();
        if (!chart) { alert('График не готов'); return; }
    
        // Определяем набор баров для маркировки
        let data = getDataWithIndex([...(window.app?.activedata||[])]);
    
        // Применяем фильтр по режиму (table / simple / visual / formula)
        const vizFn = vzBuildFilterFn();
        if (!vizFn) {
            data = applyFilters(data); // table mode — берём фильтры таблицы
        } else {
            data = data.filter(row => { try { return vizFn(row); } catch(_) { return false; } });
        }
    
        // Диагностика
        console.log('[dt-viz] Total bars:', window.app?.activedata?.length);
        console.log('[dt-viz] After filter:', data.length, '| mode:', VIZ.filterMode);
        if (data.length && VIZ.filterMode === 'simple') {
            const sampleVals = data.slice(0,3).map(r => r[VIZ.filterCol]);
            console.log('[dt-viz] Sample values:', sampleVals);
        }
    
        if (!data.length) {
            // Подсказка что могло пойти не так
            const allData = window.app?.activedata || [];
            const colObj  = S.columns.find(c=>c.key===VIZ.filterCol);
            let hint = '';
            if (allData.length && colObj) {
                const sample = parseFloat(allData[allData.length-1][VIZ.filterCol]);
                hint = `\n\nЗначение "${colObj.label}" в последнем баре: ${sample}`;
                if (!isNaN(sample)) hint += `\nПопробуйте: >${(sample*0.99).toFixed(5)} или диапазон ${(sample*0.98).toFixed(5)}..${(sample*1.02).toFixed(5)}`;
            }
            alert('Нет баров, удовлетворяющих условию.' + hint);
            return;
        }
        if (data.length > 500) {
            if (!confirm(`Будет добавлено ${data.length} маркеров. Продолжить?`)) return;
        }
    
        // TV v29+: createMultipointShape возвращает Promise<EntityId>
        // TV < v29: возвращает EntityId напрямую
        // Оба случая обрабатываем через Promise.resolve()
        const hasMultipoint = typeof chart.createMultipointShape === 'function';
        const hasCreate     = typeof chart.createShape === 'function';
    
        if (!hasMultipoint && !hasCreate) {
            alert('createMultipointShape не найден. Версия TV: ' + (window.TradingView?.version?.() || 'unknown'));
            return;
        }
    
        // Нормализация имён shape для старого API (createShape)
        function normalizeShape(id) {
            // createShape в старых версиях использует camelCase
            const map = { arrow_up:'arrowUp', arrow_down:'arrowDown', label_up:'arrowUpLabel', label_down:'arrowDownLabel' };
            return (!hasMultipoint && hasCreate) ? (map[id] || id) : id;
        }
    
        // Кнопку в состояние загрузки
        const vizBtn = document.getElementById('dt-btn-viz');
        if (vizBtn) vizBtn.textContent = '📈 Adding…';
    
        let added = 0;
        // Создаём маркеры последовательно (Promise chain) чтобы не перегрузить TV
        for (const row of data) {
            try {
                const ts    = Math.floor(new Date(row.timestamp).getTime() / 1000);
                const price = VIZ.position === 'belowBar'
                    ? (parseFloat(row.low)  || parseFloat(row.close) || 0)
                    : (parseFloat(row.high) || parseFloat(row.close) || 0);
    
                const points = [{ time: ts, price }];
                const opts = {
                    shape:   normalizeShape(VIZ.shapeType),
                    text:    VIZ.text || undefined,
                    lock:    false,
                    disableSelection: false,
                    disableSave:      false,
                    disableUndo:      false,
                    overrides: {
                        color:           VIZ.color,
                        textColor:       VIZ.color,
                        backgroundColor: VIZ.color + '33',
                        fontsize:        12,
                        bold:            false,
                    }
                };
    
                // Promise.resolve() корректно обработает и Promise и прямой id
                const shapeId = await Promise.resolve(
                    hasMultipoint
                        ? chart.createMultipointShape(points, opts)
                        : chart.createShape(points, opts)
                );
    
                if (shapeId != null) { S.activeShapes.push(shapeId); added++; }
            } catch(e) {
                console.warn('[dt-viz] shape error:', e.message);
            }
        }
    
        console.log(`[dt-viz] Added ${added}/${data.length} markers`);
        if (vizBtn) vizBtn.textContent = `📈 Chart (${S.activeShapes.length})`;
    
        if (added === 0) {
            alert('Маркеры не добавились. Проверьте консоль — там детали.');
            return;
        }
    
        // Прокручиваем график к последнему маркеру чтобы он был виден
        try {
            const lastBar = data[data.length - 1];
            const lastTs  = Math.floor(new Date(lastBar.timestamp).getTime() / 1000);
            const chart2  = window.app?.widget?.activeChart();
            if (chart2) {
                // setVisibleRange — показываем последние 100 баров включая маркер
                const ivSec = { '1T':1,'1':60,'3':180,'5':300,'15':900,'30':1800,'60':3600,'240':14400,'1D':86400,'1W':604800 };
                const res   = window.app?.widget?.activeChart?.()?.resolution?.() || '1D';
                const step  = (ivSec[res] || 86400) * 100;
                chart2.setVisibleRange({ from: lastTs - step, to: lastTs + step / 10 });
            }
        } catch(_) {}
    }
    
    // Тихий пересчёт маркеров (без alert/confirm) — вызывается из startPoll
    async function reapplyMarkers() {
        const chart = window.app?.widget?.activeChart();
        if (!chart) return;
        // Снимаем старые маркеры
        if (S.activeShapes.length) {
            const remFn = typeof chart.removeEntity === 'function' ? id => chart.removeEntity(id)
                        : typeof chart.removeShape  === 'function' ? id => chart.removeShape(id)  : null;
            if (remFn) for (const id of S.activeShapes) { try { await Promise.resolve(remFn(id)); } catch(_){} }
            S.activeShapes = [];
        }
        // Применяем фильтр
        let data = getDataWithIndex([...(window.app?.activedata || [])]);
        const vizFn = vzBuildFilterFn();
        data = vizFn ? data.filter(r => { try { return vizFn(r); } catch(_) { return false; } })
                     : applyFilters(data);
        if (!data.length) return;
        // Добавляем маркеры
        const hasMP = typeof chart.createMultipointShape === 'function';
        const hasSh = typeof chart.createShape === 'function';
        if (!hasMP && !hasSh) return;
        const shapeMap = { arrow_up:'arrowUp', arrow_down:'arrowDown', label_up:'arrowUpLabel', label_down:'arrowDownLabel' };
        const shape = (!hasMP && hasSh) ? (shapeMap[VIZ.shapeType] || VIZ.shapeType) : VIZ.shapeType;
        const opts = {
            shape, text: VIZ.text || undefined, lock: false,
            disableSelection: false, disableSave: false, disableUndo: false,
            overrides: { color:VIZ.color, textColor:VIZ.color, backgroundColor:VIZ.color+'33', fontsize:12, bold:false }
        };
        for (const row of data) {
            try {
                const ts    = Math.floor(new Date(row.timestamp).getTime() / 1000);
                const price = VIZ.position === 'belowBar'
                    ? (parseFloat(row.low)  || parseFloat(row.close) || 0)
                    : (parseFloat(row.high) || parseFloat(row.close) || 0);
                const id = await Promise.resolve(
                    hasMP ? chart.createMultipointShape([{time:ts,price}], opts)
                          : chart.createShape([{time:ts,price}], opts)
                );
                if (id != null) S.activeShapes.push(id);
            } catch(_) {}
        }
        const btn = document.getElementById('dt-btn-viz');
        if (btn) btn.textContent = `📈 Chart (${S.activeShapes.length})`;
    }
    
    async function clearMarkers() {
        const chart = window.app?.widget?.activeChart();
        if (chart && S.activeShapes.length) {
            // TV v29+: removeEntity возвращает Promise — await каждый
            const remFn = typeof chart.removeEntity === 'function'
                ? id => chart.removeEntity(id)
                : typeof chart.removeShape === 'function'
                    ? id => chart.removeShape(id) : null;
            if (remFn) {
                for (const id of S.activeShapes) {
                    try { await Promise.resolve(remFn(id)); } catch(_) {}
                }
            }
        }
        S.activeShapes = [];
        const btn = document.getElementById('dt-btn-viz');
        if (btn) btn.textContent = '📈 Chart';
    }
    
    // ════════════════════════════════════════════════════════
    // HIGHLIGHT BY TIME
    // ════════════════════════════════════════════════════════
    
    function highlightByTime(tsMs) {
        // Panel may not be built yet (wire() fires before first show())
        if (!tbodyEl) return;  // panel not built yet (before first show())
        // Find closest bar in full dataset
        const d = window.app?.activedata;
        if (!d?.length) return;
        let bestTs = null, bestDiff = Infinity;
        for (const row of d) {
            const t = new Date(row.timestamp).getTime();
            const diff = Math.abs(t - tsMs);
            if (diff < bestDiff) { bestDiff = diff; bestTs = String(t); }
        }
        if (!bestTs || bestTs === S.hlTs) return;
        S.hlTs = bestTs;
        // Re-render: centers window on hlTs and applies dt-hl class
        render();
        // Scroll highlighted row into view
        requestAnimationFrame(() => {
            const row = tbodyEl?.querySelector('.dt-hl');
            if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
    }
    
    // ════════════════════════════════════════════════════════
    // SHOW / HIDE / TOGGLE
    // ════════════════════════════════════════════════════════
    
    function show() {
        S.visible=true;
        if (!panelEl) buildPanel();
        panelEl.style.display='flex';
        document.getElementById('dt-nav-btn')?.classList.add('nav-btn-active');
        syncNewCols(); render();
    }
    function hide() {
        S.visible=false;
        if (panelEl) panelEl.style.display='none';
        document.getElementById('dt-nav-btn')?.classList.remove('nav-btn-active');
    }
    function toggle() { S.visible ? hide() : show(); }
    
    // ════════════════════════════════════════════════════════
    // WIRE TV + POLLING
    // ════════════════════════════════════════════════════════
    
    function wire(widget) {
        widget.onChartReady(() => {
            const chart=widget.activeChart();
            try { chart.crossHairMoved().subscribe(null,({time})=>{ if(time&&S.visible) highlightByTime(time*1000); }); }
            catch(_) { try { chart.crosshairMoved().subscribe(null,({time})=>{ if(time&&S.visible) highlightByTime(time*1000); }); } catch(_){} }
            chart.onSymbolChanged().subscribe(null,  ()=>S.visible&&setTimeout(()=>{ syncNewCols(); render(); },800));
            chart.onIntervalChanged().subscribe(null,()=>S.visible&&setTimeout(()=>{ syncNewCols(); render(); clearMarkers(); },800));
        });
    }
    
    function startPoll() {
        setInterval(async () => {
            const n = window.app?.activedata?.length || 0;
            if (n !== S.lastDataLen) {
                S.lastDataLen = n;
                syncNewCols();
                if (S.visible) render();
                if (S.autoViz && n > 0) {
                    const fn = vzBuildFilterFn();
                    const hasFilter = fn !== null || Object.keys(S.filters).length > 0;
                    if (hasFilter) await reapplyMarkers();
                }
            }
        }, 1000);
    }
    
    // ════════════════════════════════════════════════════════
    // CSS
    // ════════════════════════════════════════════════════════
    
    function css(){
        if(document.getElementById('dt-css')) return;
        const s=document.createElement('style'); s.id='dt-css';
        s.textContent=`
    #dt-nav-btn{font-size:12px;padding:3px 10px;margin-right:6px;transition:background .15s}
    #dt-nav-btn.nav-btn-active{background:#2962FF;color:#fff}
    #dt-panel{display:none;flex-direction:column;width:100%;background:#0d0f17;border-top:2px solid #2a2e39;flex-shrink:0;overflow:hidden;font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',monospace}
    #dt-resizer{position:absolute;top:0;left:0;right:0;height:5px;cursor:ns-resize;z-index:5}
    #dt-resizer:hover{background:#2962FF33}
    #dt-toolbar{display:flex;align-items:center;gap:8px;padding:4px 10px;background:#131722;border-bottom:1px solid #2a2e39;height:32px;flex-shrink:0}
    #dt-title{font-weight:600;color:#d1d4dc}#dt-cnt{color:#555;font-size:11px}
    .dt-btn{padding:2px 8px;background:#2a2e39;border:1px solid #363a45;border-radius:3px;color:#9598a1;font-size:11px;cursor:pointer;transition:background .12s}
    .dt-btn:hover{background:#363a45;color:#d1d4dc}
    .dt-btn-apply{background:#162b18;border-color:#4caf50;color:#4caf50}.dt-btn-apply:hover{background:#1e3d20}
    .dt-btn-auto{background:#1a1a2e;border-color:#f5a623;color:#f5a623}.dt-btn-auto:hover{background:#2a2010}
    .dt-btn-viz{border-color:#2962FF44}
    #dt-twrap{overflow:auto;flex:1}
    #dt-tbl{border-collapse:collapse;width:max-content;min-width:100%}
    .dt-th{position:sticky;top:0;background:#1a1d27;color:#d1d4dc;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.3px;padding:4px 8px;text-align:right;border-bottom:1px solid #2a2e39;border-right:1px solid #1e2230;cursor:pointer;white-space:nowrap;user-select:none}
    .dt-th:first-child{text-align:left}.dt-th:hover{color:#d1d4dc;background:#212435}
    .dt-th-filtered{color:#2962FF!important}
    .dt-fth{position:sticky;top:25px;background:#0d0f17;padding:2px 2px;border-bottom:1px solid #1e2230}
    .dt-fi-wrap{display:flex;align-items:center;gap:2px}
    .dt-fi{flex:1;min-width:0;background:#131722;border:1px solid #2a2e39;border-radius:2px;color:#9598a1;font-size:11px;padding:1px 4px;box-sizing:border-box}
    .dt-fi:focus{outline:none;border-color:#2962FF;color:#d1d4dc}
    .dt-fi::placeholder{color:#3a3f4e;font-style:italic}
    .dt-fi.dt-fi-adv{border-color:#f5a62366;color:#f5a623;background:#1a160a}
    .dt-fi-adv-btn{flex-shrink:0;width:16px;height:16px;padding:0;line-height:16px;text-align:center;font-size:11px;background:transparent;border:none;color:#3a3f4e;cursor:pointer;border-radius:2px}
    .dt-fi-adv-btn:hover,.dt-fi-adv-btn.active{color:#f5a623;background:#f5a62322}
    .dt-th-f{color:#2962FF!important}
    /* Advanced popup */
    .dt-adv-pop{position:fixed;z-index:100002;width:340px;background:#1a1d27;border:1px solid #2a2e39;border-radius:6px;box-shadow:0 8px 32px rgba(0,0,0,.7);font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:0}
    .dt-adv-hdr{display:flex;align-items:center;gap:6px;padding:7px 10px 6px;border-bottom:1px solid #2a2e39;background:#131722;border-radius:6px 6px 0 0}
    .dt-adv-hdr strong{color:#d1d4dc}.dt-adv-rng{font-size:10px;color:#555;margin-left:auto;font-variant-numeric:tabular-nums}
    .dt-adv-x{background:transparent;border:none;color:#555;cursor:pointer;font-size:13px;margin-left:4px;padding:0 2px}
    .dt-adv-x:hover{color:#ef5350}
    .dt-adv-rules{padding:8px 10px;display:flex;flex-direction:column;gap:5px}
    .dt-adv-rule{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
    .dt-adv-where{font-size:10px;font-weight:700;color:#555;letter-spacing:.3px;min-width:44px;text-align:right}
    .dt-adv-logic{background:#131722;border:1px solid #2a2e39;border-radius:3px;color:#2962FF;font-size:11px;font-weight:700;padding:2px 4px;min-width:44px}
    .dt-adv-op{background:#131722;border:1px solid #2a2e39;border-radius:3px;color:#d1d4dc;font-size:12px;padding:2px 4px;flex:1}
    .dt-adv-op:focus,.dt-adv-logic:focus{outline:none;border-color:#2962FF}
    .dt-adv-val{background:#131722;border:1px solid #2a2e39;border-radius:3px;color:#d1d4dc;font-size:12px;padding:2px 6px;width:90px}
    .dt-adv-val:focus{outline:none;border-color:#2962FF}
    .dt-adv-and{color:#555;font-size:11px}
    .dt-adv-del{background:transparent;border:none;color:#555;cursor:pointer;font-size:11px;padding:0 2px}
    .dt-adv-del:hover{color:#ef5350}
    .dt-adv-add{width:calc(100% - 20px);margin:0 10px 6px;padding:4px;background:transparent;border:1px dashed #2a2e39;border-radius:3px;color:#555;font-size:11px;cursor:pointer}
    .dt-adv-add:hover{border-color:#2962FF;color:#2962FF}
    .dt-adv-foot{display:flex;align-items:center;gap:6px;padding:6px 10px;border-top:1px solid #2a2e39;background:#131722;border-radius:0 0 6px 6px}
    .dt-adv-cnt{font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;flex:1}
    .dt-adv-btn{padding:3px 10px;border-radius:3px;font-size:12px;cursor:pointer;border:1px solid #363a45;background:#2a2e39;color:#9598a1}
    .dt-adv-btn:hover{background:#363a45;color:#d1d4dc}
    .dt-adv-ok{background:#162b18;border-color:#4caf50;color:#4caf50;font-weight:600}
    .dt-adv-ok:hover{background:#1e3d20}
    .dt-adv-clr{border-color:#ef535044;color:#ef5350}
    .dt-adv-clr:hover{background:#3a1010}
    .dt-td{padding:3px 8px;border-bottom:1px solid #141720;border-right:1px solid #141720;color:#d1d4dc;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
    .dt-td:first-child{text-align:left;color:#c8cbd4}
    .dt-row:hover .dt-td{background:#1e2235}
    .dt-row.dt-bull .dt-td:nth-child(5){color:#26a69a}
    .dt-row.dt-bear .dt-td:nth-child(5){color:#ef5350}
    .dt-row.dt-hl .dt-td{background:#1a2744!important;color:#d1d4dc!important}
    .dt-bool-t{color:#26a69a!important;font-weight:600}
    .dt-bool-f{color:#ef5350!important}
    .dt-empty{text-align:center;color:#555;padding:16px;font-style:italic}
    .dt-ghead td{background:#1a1d27;color:#d1d4dc;font-size:11px;font-weight:700;text-transform:uppercase;padding:4px 8px}
    .dt-gtgl{cursor:pointer;margin-right:6px}.dt-gcnt{color:#555;font-weight:400}
    
    /* Column manager */
    /* Column manager — встроен в панель */
    #dt-colmgr{background:#1a1d27;border-bottom:1px solid #2a2e39;overflow-y:auto;max-height:200px;flex-shrink:0}
    #dt-colmgr.dt-hidden{display:none}
    /* Viz manager — floating popup */
    #dt-viz-popup{
        position:fixed;z-index:100000;
        background:#1a1d27;border:1px solid #2a2e39;border-radius:8px;
        box-shadow:0 12px 40px rgba(0,0,0,.7);
        min-width:680px;max-width:800px;
        max-height:80vh;overflow-y:auto;
        font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    }
    /* Скрытый vizmgr внутри панели — не нужен больше */
    #dt-vizmgr{display:none!important}
    .dt-cm-wrap,.dt-viz-wrap{padding:8px 12px}
    .dt-cm-hdr{font-weight:600;color:#d1d4dc;margin-bottom:4px;display:flex;justify-content:space-between;align-items:center}
    .dt-cm-note{color:#555;font-size:11px;margin-bottom:6px}
    .dt-cm-row{display:flex;align-items:center;gap:8px;padding:2px 0;cursor:grab}
    .dt-cm-drag{color:#555}.dt-cm-lbl{background:transparent;border:none;border-bottom:1px solid transparent;color:#d1d4dc;font-size:12px;width:130px}
    .dt-cm-lbl:focus{outline:none;border-bottom-color:#2962FF}
    .dt-cm-key{color:#555;font-size:11px}.dt-cm-type{color:#2962FF55;margin-left:3px}
    
    /* Viz manager */
    .dt-viz-wrap{padding:12px 16px}
    .dt-viz-body{display:grid;grid-template-columns:1fr 1fr;gap:20px}
    .dt-viz-col{display:flex;flex-direction:column;gap:6px}
    .dt-vl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#555;margin-top:6px;margin-bottom:2px}
    .dt-vi{background:#0d0f17;border:1px solid #2a2e39;border-radius:4px;color:#d1d4dc;font-size:12px;padding:5px 8px;width:100%;box-sizing:border-box}
    .dt-vi:focus{outline:none;border-color:#2962FF}
    .dt-vi-color{width:44px;height:32px;padding:1px 2px;border:1px solid #2a2e39;border-radius:4px;background:#0d0f17;cursor:pointer}
    .dt-viz-actions{display:flex;gap:6px;margin-top:4px;flex-wrap:wrap}
    .dt-viz-actions .dt-btn{flex:1;text-align:center;padding:5px 8px;font-size:12px}
    .dt-preset-row{display:flex;align-items:center;gap:4px;padding:3px 0;border-bottom:1px solid #1a1d27}
    .dt-preset-load{background:transparent;border:none;color:#9598a1;font-size:12px;cursor:pointer;text-align:left;padding:2px 4px;flex:1}
    .dt-preset-load:hover{color:#2962FF}.dt-preset-del{background:transparent;border:none;color:#444;cursor:pointer;font-size:11px;padding:2px 6px}
    .dt-preset-del:hover{color:#ef5350}
    /* Hint badge на кнопке Chart */
    #dt-btn-viz{position:relative}
    
    /* Popup */
    .dt-popup{position:fixed;z-index:99999;background:#1a1d27;border:1px solid #2a2e39;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.5);min-width:160px;max-height:280px;overflow-y:auto;font-size:13px}
    .dt-pp-hdr{padding:5px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#555;background:#14161f}
    .dt-pp-item{padding:7px 12px;cursor:pointer;color:#9598a1}.dt-pp-item:hover{background:#252836;color:#d1d4dc}.dt-pp-act{color:#2962FF;font-weight:600}
    
    /* Light theme */
    body.light-theme #dt-panel{background:#fff;border-top-color:#e0e3eb}
    body.light-theme #dt-toolbar{background:#f8f9fd;border-bottom-color:#e0e3eb}
    body.light-theme .dt-th{background:#f0f3fa;color:#d1d4dc;border-color:#e0e3eb}
    body.light-theme .dt-fth{background:#f8f9fd}
    body.light-theme .dt-fi{background:#fff;border-color:#d0d3db;color:#131722}
    body.light-theme .dt-td{color:#555;border-color:#f0f3fa}
    body.light-theme .dt-td:first-child{color:#131722}
    body.light-theme .dt-row.dt-hl .dt-td{background:#eef2ff!important}
    body.light-theme #dt-colmgr,body.light-theme #dt-vizmgr{background:#f8f9fd;border-bottom-color:#e0e3eb}
    
    /* Viz filter tabs */
    .vz-ftabs{display:flex;gap:0;margin-bottom:8px}
    .vz-ftab{padding:3px 10px;background:#1a1d27;border:1px solid #2a2e39;
        color:#d1d4dc;font-size:11px;cursor:pointer}
    .vz-ftab:first-child{border-radius:3px 0 0 3px}
    .vz-ftab:last-child{border-radius:0 3px 3px 0;border-left:none}
    .vz-ftab:not(:first-child):not(:last-child){border-left:none}
    .vz-ftab.vz-fon{background:#2962FF22;border-color:#2962FF;color:#2962FF;font-weight:600}
    
    /* Table filter hint */
    .vz-ftable-hint{color:#d1d4dc;font-size:12px;line-height:1.5;padding:6px 0}
    .vz-fhint-ico{font-size:16px;margin-right:4px}
    
    /* Simple filter row */
    .vz-frow{display:flex;gap:6px;align-items:center}
    .vz-fs-col{flex:1}
    .vz-fs-val{flex:1}
    
    /* Count badge */
    .vz-cnt{font-size:11px;font-weight:600;display:block;margin-top:4px;font-variant-numeric:tabular-nums}
    
    /* Viz popup layout */
    .vz-wrap{padding:12px 16px}
    .vz-hdr{font-weight:600;color:#d1d4dc;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center}
    .vz-body{display:grid;grid-template-columns:1fr 1fr;gap:20px}
    .vz-col{display:flex;flex-direction:column;gap:5px}
    .vz-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#555;margin-top:5px}
    .vz-vi{background:#0d0f17;border:1px solid #2a2e39;border-radius:4px;color:#d1d4dc;font-size:12px;padding:5px 8px;width:100%;box-sizing:border-box}
    .vz-vi:focus{outline:none;border-color:#2962FF}
    .vz-color{width:44px;height:32px;padding:1px;border:1px solid #2a2e39;border-radius:4px;background:#0d0f17;cursor:pointer}
    .vz-actions{display:flex;gap:5px;margin-top:8px;flex-wrap:wrap}
    .vz-actions .dt-btn{flex:1;text-align:center;padding:5px 4px;font-size:11px}
    .vz-prow{display:flex;align-items:center;gap:4px;padding:2px 0;border-bottom:1px solid #1e2230}
    .vz-pl{background:transparent;border:none;color:#9598a1;font-size:12px;cursor:pointer;text-align:left;flex:1}
    .vz-pl:hover{color:#2962FF}
    .vz-pd{background:transparent;border:none;color:#444;cursor:pointer;font-size:11px}
    .vz-pd:hover{color:#ef5350}
    .vz-note{font-size:11px;color:#555;font-style:italic}
    /* Viz filter builder */
    .vz-fvisual,.vz-fformula,.vz-fsimple{padding:2px 0}
    .vz-grp{background:#0d0f17;border:1px solid #1e2230;border-radius:5px;padding:7px 10px;margin-bottom:6px}
    .vz-grp-hdr{display:flex;align-items:center;gap:5px;margin-bottom:6px}
    .vz-grp-lbl{font-size:10px;font-weight:700;color:#555;flex:1}
    .vz-grp-lbl em{color:#f5a623;font-style:normal}
    .vz-lg{padding:2px 7px;background:#1a1d27;border:1px solid #2a2e39;color:#555;font-size:11px;font-weight:700;cursor:pointer}
    .vz-lg:first-of-type{border-radius:3px 0 0 3px}
    .vz-lg + .vz-lg{border-left:none;border-radius:0 3px 3px 0}
    .vz-lg.vz-on{background:#2962FF22;border-color:#2962FF;color:#2962FF}
    .vz-conds{display:flex;flex-direction:column;gap:4px}
    .vz-cond{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
    .vz-cond-lbl{font-size:10px;font-weight:700;color:#2962FF;min-width:44px;text-align:right;flex-shrink:0}
    .vz-ib{background:transparent;border:none;color:#555;cursor:pointer;font-size:11px;padding:1px 4px}
    .vz-ib:hover{color:#ef5350}
    .vz-add-c{color:#555;font-size:11px;margin-top:3px;background:none;border:none;cursor:pointer}
    .vz-add-c:hover{color:#2962FF}
    .vz-add-g{width:100%;padding:5px;background:transparent;border:1px dashed #2a2e39;border-radius:4px;color:#555;font-size:11px;cursor:pointer;margin-top:3px}
    .vz-add-g:hover{border-color:#2962FF;color:#2962FF}
    .vz-sel{background:#0d0f17;border:1px solid #2a2e39;border-radius:3px;color:#d1d4dc;font-size:12px;padding:3px 5px}
    .vz-sel:focus{outline:none;border-color:#2962FF}
    .vz-inp{background:#0d0f17;border:1px solid #2a2e39;border-radius:3px;color:#d1d4dc;font-size:12px;padding:3px 6px;width:90px}
    .vz-inp:focus{outline:none;border-color:#2962FF}
    .vz-hint{font-size:10px;color:#555;white-space:nowrap}
    .vz-and{color:#555;font-size:10px;font-weight:700}
    .vz-fml{width:100%;height:56px;background:#0d0f17;border:1px solid #2a2e39;border-radius:4px;color:#d1d4dc;font-size:12px;font-family:monospace;padding:6px;resize:vertical;box-sizing:border-box}
    .vz-fml:focus{outline:none;border-color:#2962FF}
    .vz-ferr{color:#ef5350;font-size:11px;min-height:14px}
    .vz-chips{display:flex;flex-wrap:wrap;gap:3px;margin-top:3px}
    .vz-chip{padding:1px 7px;background:#1a1d27;border:1px solid #2a2e39;border-radius:10px;color:#9598a1;font-size:11px;cursor:pointer}
    .vz-chip:hover{border-color:#2962FF;color:#2962FF}
    .vz-exlist{display:flex;flex-direction:column;gap:2px;margin-top:3px}
    .vz-ex{padding:2px 6px;background:#0d0f17;border-radius:3px;color:#555;font-size:11px;font-family:monospace;cursor:pointer}
    .vz-ex:hover{color:#d1d4dc;background:#1a1d27}
    /* Filter row hide message */
    .dt-frow-viz-msg{padding:3px 8px;color:#555;font-size:11px;background:#0d0f17;font-style:italic}
    .dt-frow-restore{background:transparent;border:none;color:#2962FF;cursor:pointer;font-size:11px;padding:0 4px}
    .dt-frow-restore:hover{text-decoration:underline}
    body.light-theme .vz-sel,body.light-theme .vz-inp{background:#fff;border-color:#d0d3db;color:#131722}
        `;
        document.head.appendChild(s);
    }
    
    // ════════════════════════════════════════════════════════
    // HELPERS
    // ════════════════════════════════════════════════════════
    
    function esc(s){ return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    
    // ════════════════════════════════════════════════════════
    // START
    // ════════════════════════════════════════════════════════
    
    function start(){
        css(); initCols(); buildNavBtn();
        let n=0; const t=setInterval(()=>{ if(++n>200)clearInterval(t); if(window.app?.widget){clearInterval(t);wire(window.app.widget);startPoll();} },200);
    }
    
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',start);
    else start();
    
    window.dataTable={
        toggle, show, hide,
        refresh:()=>{ syncNewCols(); render(); },
        highlight: highlightByTime,
        clearMarkers,
        addColumn:(key,label,type='num')=>{ if(!S.knownKeys.has(key)){S.knownKeys.add(key);S.columns.push({key,label,visible:true,width:90,type});renderColMgr();render();} },
        getColumns:()=> S.columns,
        getFilteredData:()=>{ let d=[...(window.app?.activedata||[])]; return applyFilters(d); },
    
        getState: () => {
            const filtersSnap = {};
            Object.keys(S.filters).forEach(k => {
                const f = S.filters[k];
                filtersSnap[k] = { raw: f.raw, type: f.type, rules: f.rules || null };
            });
            const vizSnap = { ...VIZ };
            delete vizSnap.filterFn;
            return {
                visible:  S.visible,
                columns:  S.columns.map(c => ({...c})),
                sortKey:  S.sortKey,
                sortDir:  S.sortDir,
                groupKey: S.groupKey,
                filters:  filtersSnap,
                panelH:   S.panelH,
                autoViz:  S.autoViz,
                viz:      vizSnap,
            };
        },
    
        restoreState: (snap) => {
            if (!snap) return;
            if (snap.columns) {
                S.columns = snap.columns;
                snap.columns.forEach(c => S.knownKeys.add(c.key));
                // Всегда гарантируем наличие _index первым столбцом
                if (!S.columns.find(c => c.key === '_index')) {
                    S.columns.unshift({ key:'_index', label:'Index', visible:true, width:60, type:'int' });
                    S.knownKeys.add('_index');
                }
            }
            if (snap.sortKey  !== undefined) S.sortKey  = snap.sortKey;
            if (snap.sortDir  !== undefined) S.sortDir  = snap.sortDir;
            if (snap.groupKey !== undefined) S.groupKey = snap.groupKey;
            if (snap.panelH   !== undefined) S.panelH   = snap.panelH;
            if (snap.autoViz  !== undefined) S.autoViz  = snap.autoViz;
    
            if (snap.filters) {
                S.filters = {};
                Object.keys(snap.filters).forEach(k => {
                    const f = snap.filters[k];
                    if (f.rules) {
                        const fn = buildRulesFn(f.rules, f.type);
                        if (fn) S.filters[k] = { raw: f.raw, fn, type: f.type, rules: f.rules };
                    } else if (f.raw) {
                        const fn = parseSimple(f.raw, f.type);
                        if (fn) S.filters[k] = { raw: f.raw, fn, type: f.type, rules: null };
                    }
                });
            }
    
            if (snap.viz) {
                Object.keys(snap.viz).forEach(k => { if (k !== 'filterFn') VIZ[k] = snap.viz[k]; });
                VIZ.filterFn = null;
            }
    
            if (snap.panelH && panelEl) panelEl.style.height = snap.panelH + 'px';
            if (snap.visible) show();
    
            renderHead();
            render();
            console.log('[DataTable] State restored from layout');
        },
    };
    
    })(); }