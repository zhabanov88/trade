/**
 * tv-indicator-engine.js  v11
 * Оптимизации:
 *   - Кэш analyze() — пересчёт только при изменении данных
 *   - Умный дебаунс — не триггерит если bars не изменились
 *   - RAF батчи вместо setTimeout(0)
 *   - Лимит shapes по умолчанию 500
 *   - Ghost shapes cleanup при старте
 */
(function () {
    'use strict';

    if (!window._tve)         window._tve         = {};
    if (!window._tveRegistry) window._tveRegistry  = {};

    // ── Утилиты ──────────────────────────────────────────────────
    function _chart() {
        try { return window.app.widget.activeChart(); } catch (e) { return null; }
    }

    function _chartReady() {
        try {
            var c = window.app && window.app.widget && window.app.widget.activeChart();
            return !!(c && c.symbol());
        } catch (e) { return false; }
    }

    function _getBars() {
        var raw = window.app && window.app.activedata;
        if (!raw || raw.length < 3) return [];
        var bars = [];
        for (var i = 0; i < raw.length; i++) {
            var b = raw[i];
            var t  = Math.floor(new Date(b.timestamp).getTime() / 1000);
            var h  = parseFloat(b.high), l = parseFloat(b.low);
            var cl = parseFloat(b.close), op = parseFloat(b.open);
            if (!isNaN(h) && !isNaN(l)) bars.push({ t:t, h:h, l:l, c:cl, o:op, v:parseFloat(b.volume)||0 });
        }
        bars.sort(function (a, b) { return a.t - b.t; });
        return bars;
    }

    // ОПТИМ 2: Снимок состояния данных для сравнения
    function _dataSnapshot() {
        var raw = window.app && window.app.activedata;
        if (!raw || raw.length === 0) return null;
        return {
            len:    raw.length,
            firstT: raw[0].timestamp,
            lastT:  raw[raw.length - 1].timestamp,
        };
    }

    function _snapshotEqual(a, b) {
        if (!a || !b) return false;
        return a.len === b.len && a.firstT === b.firstT && a.lastT === b.lastT;
    }

    function _cfgHash(cfg) {
        try { return JSON.stringify(cfg); } catch(e) { return ''; }
    }

    // ── Shapes ───────────────────────────────────────────────────
    function _clearShapes(key) {
        var st = window._tve[key]; if (!st) return;
        var c = _chart();
        if (c) for (var i = 0; i < st.shapeIds.length; i++) {
            try { c.removeEntity(st.shapeIds[i]); } catch (e) {}
        }
        st.shapeIds = [];
    }

    // ОПТИМ 3: RAF батчи вместо setTimeout(0), увеличен размер до 100
    var BATCH_SIZE = 100;

    function _drawBatch(key, list, idx, batchId) {
        var st = window._tve[key];
        if (!st || st._hidden || st._batchId !== batchId) return;

        if (!_chartReady()) {
            setTimeout(function () { _drawBatch(key, list, idx, batchId); }, 500);
            return;
        }

        var c = _chart(); if (!c) return;
        var end = Math.min(idx + BATCH_SIZE, list.length);
        var ok  = true;

        for (var i = idx; i < end && ok; i++) {
            var s     = list[i];
            var shape = s.shape || 'rectangle';
            var ov;

            if (shape === 'rectangle') {
                ov = {
                    backgroundColor: s.color,
                    color:           s.color,
                    linewidth:       s.linewidth !== undefined ? s.linewidth : 0,
                    fillBackground:  true,
                    transparency:    0,
                    showLabel:       !!s.label,
                    text:            s.label || '',
                };
            } else if (shape === 'trend_line' || shape === 'horizontal_line') {
                ov = {
                    linecolor:   s.color,
                    linewidth:   s.linewidth !== undefined ? s.linewidth : 2,
                    linestyle:   s.linestyle !== undefined ? s.linestyle : 0,
                    showLabel:   false,
                    extendLeft:  false,
                    extendRight: false,
                };
            } else {
                // arrow_up, arrow_down, и прочие маркеры
                ov = {
                    color:     s.color,
                    textColor: s.color,
                    text:      s.label || '',
                    fontsize:  s.fontsize || 12,
                };
            }

            try {
                var r = c.createMultipointShape(s.points, {
                    shape:            shape,
                    lock:             s.lock !== undefined ? s.lock : true,
                    disableSelection: true,
                    disableSave:      true,
                    disableUndo:      true,
                    zOrder:           s.zOrder || 'bottom',
                    overrides:        ov,
                });
                if (r && typeof r.then === 'function') {
                    (function (ids, p) { p.then(function (id) { if (id != null) ids.push(id); }); })(st.shapeIds, r);
                } else if (r != null) { st.shapeIds.push(r); }
            } catch (e) {
                if (e.message && e.message.indexOf('Cannot create') !== -1) {
                    setTimeout(function () {
                        if (window._tve[key] && window._tve[key]._batchId === batchId)
                            _scheduleRedraw(key, 1000);
                    }, 100);
                    ok = false;
                }
            }
        }

        if (ok && end < list.length) {
            // ОПТИМ 3: requestAnimationFrame вместо setTimeout(0)
            requestAnimationFrame(function () { _drawBatch(key, list, end, batchId); });
        } else if (ok) {
            console.log('[TVEngine:' + key + '] ✅ drawn=' + list.length + ' bars=' + _getBars().length);
        }
    }

    function _drawShapes(key, list) {
        var st = window._tve[key];
        if (!st || st._hidden) return;
        _clearShapes(key);
        if (!list.length) return;
        st._batchId = (st._batchId || 0) + 1;
        _drawBatch(key, list, 0, st._batchId);
    }

    // ── Перерисовка с кэшем ───────────────────────────────────────
    function _redraw(key) {
        var st = window._tve[key];
        if (!st || st._hidden || !st.def || !st.cfg) return;

        if (!_chartReady()) { _scheduleRedraw(key, 800); return; }

        var bars = _getBars();
        if (bars.length < 3) { _scheduleRedraw(key, 500); return; }

        // ОПТИМ 1: Проверяем кэш — если данные и cfg не изменились, не пересчитываем
        var snap    = _dataSnapshot();
        var cfgStr  = _cfgHash(st.cfg);
        if (st._cache &&
            _snapshotEqual(st._cache.snap, snap) &&
            st._cache.cfgStr === cfgStr) {
            // Данные те же — просто перерисовываем закэшированные shapes
            _drawShapes(key, st._cache.shapes);
            return;
        }

        var shapes = [];
        try { shapes = st.def.analyze(bars, st.cfg) || []; }
        catch (e) { console.error('[TVEngine] analyze err:', e); return; }

        // ОПТИМ 4: Лимит shapes — берём последние maxShapes
        var maxShapes = st.def.maxShapes || 500;
        if (shapes.length > maxShapes) {
            shapes = shapes.slice(shapes.length - maxShapes);
        }

        // Сохраняем в кэш
        st._cache = { snap: snap, cfgStr: cfgStr, shapes: shapes };

        _drawShapes(key, shapes);
    }

    function _scheduleRedraw(key, ms) {
        var st = window._tve[key]; if (!st || st._hidden) return;
        clearTimeout(st.debTimer);
        st.debTimer = setTimeout(function () { _redraw(key); }, ms !== undefined ? ms : 300);
    }

    // ОПТИМ 2: Умный редро — только если данные действительно изменились
    function _smartRedraw(key, delayMs) {
        var st = window._tve[key]; if (!st || st._hidden || !st.cfg) return;
        var snap = _dataSnapshot();
        if (st._cache && _snapshotEqual(st._cache.snap, snap)) return; // данные не изменились
        _scheduleRedraw(key, delayMs || 500);
    }

    // ── Мониторинг ────────────────────────────────────────────────
    function _startMonitor(key, studyId) {
        var iv = setInterval(function () {
            var st = window._tve[key]; if (!st) { clearInterval(iv); return; }
            var c = _chart(); if (!c) return;
            var studies; try { studies = c.getAllStudies(); } catch (e) { return; }
            var found = null;
            for (var i = 0; i < studies.length; i++) {
                if (String(studies[i].id) === String(studyId) ||
                    String(studies[i].entityId) === String(studyId)) {
                    found = studies[i]; break;
                }
            }
            if (!found) { clearInterval(iv); _destroy(key); return; }
            var vis = true;
            try {
                var entity = c.getStudyById(found.entityId || found.id);
                if (entity && typeof entity.isVisible === 'function') vis = entity.isVisible();
            } catch (e) {}
            if (!vis && !st._hidden) { st._hidden = true; _clearShapes(key); }
            else if (vis && st._hidden) { st._hidden = false; _scheduleRedraw(key, 50); }
        }, 500);
        var st = window._tve[key]; if (st) st._iv = iv;
    }

    // ── Hooks ─────────────────────────────────────────────────────
    function _installGetBarsHook() {
        var df = window.app && window.app.datafeed;
        if (!df || typeof df.getBars !== 'function' || df._tveGetBarsHook) return;
        var orig = df.getBars.bind(df);
        df._tveGetBarsHook = true;
        df.getBars = function (symbolInfo, resolution, periodParams, onHistoryCallback, onErrorCallback) {
            var wrapped = function (bars, meta) {
                onHistoryCallback(bars, meta);
                if (bars && bars.length > 0) {
                    // ОПТИМ 2: умный редро — не пересчитываем если данные не изменились
                    setTimeout(function () {
                        var keys = Object.keys(window._tve);
                        for (var i = 0; i < keys.length; i++) _smartRedraw(keys[i], 400);
                    }, 100);
                }
            };
            return orig(symbolInfo, resolution, periodParams, wrapped, onErrorCallback);
        };
        console.log('[TVEngine] getBars hook installed');
    }

    function _installHook() {
        var df = window.app && window.app.datafeed;
        if (!df || typeof df.appendActiveData !== 'function' || df._tveHook) return;
        var orig = df.appendActiveData.bind(df);
        df._tveOrig = orig; df._tveHook = true;
        df.appendActiveData = function (data) {
            orig(data);
            if (!data || !data.length) return;
            // ОПТИМ 2: умный редро
            var keys = Object.keys(window._tve);
            for (var i = 0; i < keys.length; i++) _smartRedraw(keys[i], 600);
        };
        console.log('[TVEngine] appendActiveData hook installed');
    }

    function _tryInstallHooks() {
        var n = 0, t = setInterval(function () {
            n++;
            var df = window.app && window.app.datafeed;
            if (df) {
                if (typeof df.appendActiveData === 'function' && !df._tveHook) _installHook();
                if (typeof df.getBars === 'function' && !df._tveGetBarsHook) _installGetBarsHook();
                if (df._tveHook && df._tveGetBarsHook) { clearInterval(t); return; }
            }
            if (n > 50) clearInterval(t);
        }, 200);
    }

    // ── Ghost shapes cleanup ──────────────────────────────────────
    var _ghostCleanDone = false;
    function _cleanGhostShapes() {
        if (_ghostCleanDone) return;
        var c = _chart(); if (!c) return;
        var allShapes;
        try { allShapes = c.getAllShapes ? c.getAllShapes() : []; } catch (e) { return; }
        if (!allShapes || allShapes.length === 0) { _ghostCleanDone = true; return; }
        var removed = 0;
        var KNOWN = { rectangle:1, rect:1, trend_line:1, trendline:1,
                      arrow_up:1, arrow_down:1, horizontal_line:1 };
        for (var i = 0; i < allShapes.length; i++) {
            var sh = allShapes[i];
            if (KNOWN[(sh.name || '').toLowerCase()]) {
                try { c.removeEntity(sh.id); removed++; } catch (e) {}
            }
        }
        _ghostCleanDone = true;
        if (removed > 0) console.log('[TVEngine] cleaned ' + removed + ' ghost shapes');
    }

    // ── Destroy ───────────────────────────────────────────────────
    function _destroy(key) {
        var st = window._tve[key];
        if (st) {
            clearTimeout(st.debTimer);
            if (st._iv) clearInterval(st._iv);
            _clearShapes(key);
            if (st.tvId) delete window._tveRegistry[st.tvId];
        }
        delete window._tve[key];
        console.log('[TVEngine] destroyed:', key);
    }

    // ── Init ──────────────────────────────────────────────────────
    function _initInstance(def, studyName, studyDesc, tvId) {
        if (window._tveRegistry[tvId] && window._tve[window._tveRegistry[tvId]]) {
            return window._tveRegistry[tvId];
        }

        var key = 'tve_' + Date.now();
        window._tve[key] = {
            shapeIds: [], _hidden: false,
            def: def, cfg: null,
            debTimer: null, _iv: null, _batchId: 0,
            tvId: tvId,
            _cache: null,  // ОПТИМ 1: кэш результата analyze()
        };
        window._tveRegistry[tvId] = key;

        _cleanGhostShapes();
        _tryInstallHooks();

        var attempts = 0, t = setInterval(function () {
            attempts++;
            var c = _chart(); if (!c) return;
            var studies; try { studies = c.getAllStudies(); } catch (e) { return; }
            var found = null;
            for (var i = studies.length - 1; i >= 0; i--) {
                var sn = studies[i].name || '';
                if (sn === studyDesc || sn === studyName ||
                    (studyDesc && sn.indexOf(studyDesc.substring(0, 12)) !== -1)) {
                    found = studies[i]; break;
                }
            }
            if (!found && attempts < 30) return;
            clearInterval(t);
            var sid = found ? String(found.id || found.entityId) : key;
            var st = window._tve[key]; if (!st) return;
            st.studyId = sid;
            console.log('[TVEngine] init key=' + key + ' sid=' + sid + ' name="' + studyName + '"');
            _startMonitor(key, sid);
            if (st.cfg) _scheduleRedraw(key, 300);
        }, 100);

        return key;
    }

    // ════════════════════════════════════════════════════════════════
    function define(def) {
        var name    = def.name        || 'Custom Indicator';
        var tvId    = def.id          || (name.toLowerCase().replace(/\W+/g, '_') + '@tv-basicstudies-1');
        var desc    = def.description || name;
        var overlay = def.overlay !== undefined ? def.overlay : true;
        var inputs  = def.inputs       || [];
        var defInps = def.defaultInputs || {};

        var tvObj = {
            name: name,
            metainfo: {
                _metainfoVersion: 53,
                id: tvId, description: desc,
                shortDescription: name.substring(0, 24),
                is_price_study: overlay, isCustomIndicator: true,
                plots: [{ id: 'p0', type: 'line' }],
                format: { type: overlay ? 'inherit' : 'price' },
                defaults: {
                    styles: { p0: { linestyle: 0, linewidth: 0, plottype: 0,
                        trackPrice: false, transparency: 100, visible: false, color: 'rgba(0,0,0,0)' } },
                    inputs: defInps,
                },
                styles: { p0: { title: '', histogramBase: 0 } },
                inputs: inputs,
            },
            constructor: function () {
                var _key = null;
                this.main = function (ctx, inp) {
                    if (!_key || !window._tve[_key]) {
                        _key = _initInstance(def, name, desc, tvId);
                    }
                    var st = window._tve[_key]; if (!st) return [NaN];
                    var cfg = {};
                    try { cfg = def.buildCfg ? def.buildCfg(inp) : {}; } catch (e) {}

                    // ОПТИМ 1: Инвалидируем кэш если cfg изменился
                    var newCfgStr = _cfgHash(cfg);
                    if (st._cache && st._cache.cfgStr !== newCfgStr) {
                        st._cache = null;
                    }
                    st.cfg = cfg;

                    clearTimeout(st.debTimer);
                    st.debTimer = setTimeout(function () { _redraw(_key); }, 300);
                    return [NaN];
                };
            }
        };

        window.customPineIndicators = window.customPineIndicators || [];
        for (var di = window.customPineIndicators.length - 1; di >= 0; di--) {
            if (window.customPineIndicators[di].name === name) window.customPineIndicators.splice(di, 1);
        }
        window.customPineIndicators.push(tvObj);
        return tvObj;
    }

    window.TVEngine = {
        define:    define,
        instances: function () { return Object.keys(window._tve); },
        registry:  function () { return window._tveRegistry; },
        redraw:    function (key) { if(window._tve[key]) { window._tve[key]._cache=null; } _scheduleRedraw(key, 0); },
        redrawAll: function () { Object.keys(window._tve).forEach(function (k) { if(window._tve[k]) window._tve[k]._cache=null; _scheduleRedraw(k, 0); }); },
        destroy:   function (key) { _destroy(key); },
        clearAll:  function () { Object.keys(window._tve).forEach(function (k) { _destroy(k); }); },
        state:     function (key) { return window._tve[key]; },
    };

    console.log('[TVEngine] v11 loaded ✅');
})();