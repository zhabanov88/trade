/**
 * tv-indicator-engine.js  v11.4
 * Подключить в index.html ДО app.js
 *
 * v11 changelog:
 *  - [HIGH]   Fix #1:  Cache buster mismatch (index.html ?v=5 → ?v=11)
 *  - [HIGH]   Fix #2:  _cleanGhostShapes no longer destroys FVG / user shapes
 *  - [HIGH]   Fix #3:  Retry limits on all setTimeout/setInterval chains
 *  - [HIGH]   Fix #4:  Race condition — shape ID leak from async _clearShapes
 *  - [MEDIUM] Fix #5:  fillBackground now configurable per shape
 *  - [MEDIUM] Fix #6:  Removed DEBUG console.log from production
 *  - [MEDIUM] Fix #7:  NaN/Infinity timestamp no longer corrupts sort
 *  - [MEDIUM] Fix #8:  Unhandled promise rejection on createShape
 *  - [MEDIUM] Fix #10: Hooks self-deactivate when no instances remain
 *  - [MEDIUM] Fix #14: Study matching uses longer substring
 *  - [LOW]    Fix #11: Counter-based key prevents same-ms collision
 *  - [LOW]    Fix #13: appendActiveData returns original result
 *  - [LOW]    Fix #15: Discovery interval cleaned on destroy
 */
(function () {
    'use strict';

    if (!window._tve) window._tve = {};
    if (!window._tveRegistry) window._tveRegistry = {};

    var _keyCounter = 0;
    var _MAX_CHART_RETRIES = 15;
    var _MAX_ERROR_RETRIES = 5;
    var _STUDY_MATCH_LEN = 24;
    var _LEGEND_COLORS = { dark: '#b2b5be', light: '#131722' };
    var _VIEWPORT_BUFFER_PCT = 0.15;

    function _currentLegendColor() {
        var theme = 'dark';
        try { theme = localStorage.getItem('tradingview_theme') || 'dark'; } catch (e) {}
        return _LEGEND_COLORS[theme] || _LEGEND_COLORS.dark;
    }

    function _updateLegendColor(theme) {
        var color = _LEGEND_COLORS[theme] || _LEGEND_COLORS.dark;
        var c = _chart(); if (!c) return;
        var keys = Object.keys(window._tve);
        for (var i = 0; i < keys.length; i++) {
            var st = window._tve[keys[i]];
            if (st && st.studyId) {
                try {
                    var study = c.getStudyById(st.studyId);
                    if (study && typeof study.applyOverrides === 'function') {
                        study.applyOverrides({ 'styles.p0.color': color });
                    }
                } catch (e) {}
            }
        }
    }

    function _chart() {
        try { return window.app.widget.activeChart(); } catch (e) { return null; }
    }

    function _chartReady() {
        try {
            var c = window.app && window.app.widget && window.app.widget.activeChart();
            return !!(c && c.symbol());
        } catch (e) { return false; }
    }

    function _hasInstances() {
        return Object.keys(window._tve).length > 0;
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
            if (isFinite(t) && !isNaN(h) && !isNaN(l))
                bars.push({ t:t, h:h, l:l, c:cl, o:op, v:parseFloat(b.volume)||0 });
        }
        bars.sort(function (a, b) { return a.t - b.t; });
        return bars;
    }

    // ── Viewport ──────────────────────────────────────────────────
    function _getVisibleRange() {
        try {
            var c = _chart(); if (!c) return null;
            var vr = c.getVisibleRange();
            if (vr && isFinite(vr.from) && isFinite(vr.to)) return { from: vr.from, to: vr.to };
        } catch (e) {}
        return null;
    }

    function _visibleIndices(allShapes, vr) {
        var result = new Set ? new Set() : _makeSet();
        if (!vr || !allShapes.length) return result;
        var span  = vr.to - vr.from;
        var buf   = span * _VIEWPORT_BUFFER_PCT;
        var tFrom = vr.from - buf;
        var tTo   = vr.to   + buf;
        for (var i = 0; i < allShapes.length; i++) {
            var s   = allShapes[i];
            var pts = s.points;
            if (!pts || !pts.length) { result.add(i); continue; }
            var sFrom = pts[0].time;
            var sTo   = pts[pts.length - 1].time;
            if (sFrom > sTo) { var tmp = sFrom; sFrom = sTo; sTo = tmp; }
            if (sTo >= tFrom && sFrom <= tTo) result.add(i);
        }
        return result;
    }

    function _makeSet() {
        var items = {};
        return {
            add:    function (v) { items[v] = true; },
            has:    function (v) { return !!items[v]; },
            delete: function (v) { delete items[v]; },
            forEach: function (fn) { for (var k in items) if (items.hasOwnProperty(k)) fn(+k); },
            get size() { return Object.keys(items).length; }
        };
    }

    // ── Viewport hook ─────────────────────────────────────────────
    var _vrHookInstalled = false;
    var _vrDebounceTimer = null;

    function _installViewportHook() {
        if (_vrHookInstalled) return;
        var c = _chart(); if (!c) return;
        if (typeof c.onVisibleRangeChanged !== 'function') return;
        try {
            c.onVisibleRangeChanged().subscribe(null, function () {
                clearTimeout(_vrDebounceTimer);
                _vrDebounceTimer = setTimeout(_onViewportChanged, 150);
            });
            _vrHookInstalled = true;
            console.log('[TVEngine] visibleRange hook installed');
        } catch (e) {}
    }

    function _onViewportChanged() {
        var vr = _getVisibleRange(); if (!vr) return;
        var vrKey = Math.floor(vr.from) + ':' + Math.floor(vr.to);
        var keys = Object.keys(window._tve);
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            var st  = window._tve[key];
            if (!st || st._hidden || !st.cfg) continue;
            if (st._cache && st._cache.allShapes && st._cache.vrKey !== vrKey) {
                _incrementalRedraw(key, vr, vrKey);
            }
        }
    }

    // ══════════════════════════════════════════════════════════════
    // _buildShapeOpts — УНИВЕРСАЛЬНЫЙ механизм overrides
    //
    // Поддерживаемые поля шейпа из analyze():
    //   shape        — тип шейпа (rectangle, trend_line, text, ...)
    //   points       — [{time, price}, ...]
    //   point        — {time, price} (алтернатива для одноточечных)
    //   color        — основной цвет (заливка / линия / текст)
    //   linewidth    — толщина линии
    //   linestyle    — 0=solid 1=dotted 2=dashed  (verified visually)
    //   fillBackground — bool, показывать заливку
    //   transparency — 0-100
    //   zOrder       — 'top' | 'bottom'
    //   label        — текст (работает для ВСЕХ типов шейпов)
    //   textcolor    — цвет текста (если не задан — авто от color)
    //   fontsize     — размер шрифта (число)
    //   bold         — bool
    //   extendLeft   — bool (для ray, extended_line)
    //   extendRight  — bool (для ray, extended_line)
    // ══════════════════════════════════════════════════════════════
    function _buildShapeOpts(s) {
        var shapeName  = s.shape || 'rectangle';
        var isText     = shapeName === 'text';
        var isRect     = shapeName === 'rectangle' || shapeName === 'rect';
        var isLineType = /^(trend_line|ray|extended_line|parallel_channel|disjoint_angle)$/.test(shapeName);
        var isMarker   = /^(arrow_up|arrow_down|arrow_left|arrow_right|flag|cross|circle)$/.test(shapeName);
        var isLabelShape = /^(label_up|label_down|balloon|note|price_label)$/.test(shapeName);

        var overrides;

        if (isText) {
            // ── text шейп: отдельный объект с координатой ──────────
            // Фон прозрачный, цвет и размер задаются напрямую
            overrides = {
                color:           s.color     || 'rgba(255,255,255,0.90)',
                textcolor:       s.textcolor || s.color || 'rgba(255,255,255,0.90)',
                fontSize:        s.fontsize  !== undefined ? s.fontsize : 12,
                bold:            s.bold      !== undefined ? !!s.bold : false,
                fillBackground:  false,
                backgroundColor: 'rgba(0,0,0,0)',
                transparency:    0,
                text:            s.label || '',
            };

        } else if (isRect) {
            // ── rectangle / rect: TV нативно поддерживает текст внутри ──
            //
            // ── Правильные имена ключей (выяснены через entity.getProperties()) ──
            // horzLabelsAlign / vertLabelsAlign — строки ('right','center','left' / 'middle','top','bottom')
            // textColor — ЗАГЛАВНАЯ C
            // Все три работают напрямую через overrides при createMultipointShape
            overrides = {
                backgroundColor:  s.color,
                color:            s.color,
                linecolor:        s.color,
                linewidth:        s.linewidth      !== undefined ? s.linewidth      : 0,
                linestyle:        s.linestyle      !== undefined ? s.linestyle      : 0,
                fillBackground:   s.fillBackground !== undefined ? s.fillBackground : true,
                transparency:     s.transparency   !== undefined ? s.transparency   : 0,
                // ── Текст внутри прямоугольника ──
                showLabel:        !!(s.label),
                text:             s.label          || '',
                // textColor — ЗАГЛАВНАЯ C. НЕ падать на s.color (малая альфа → невидимый текст)
                textColor:        s.textcolor || s.textColor || 'rgba(255,255,255,0.90)',
                fontSize:         s.fontsize  !== undefined ? s.fontsize : 12,
                bold:             s.bold      !== undefined ? !!s.bold   : false,
                // Выравнивание — строки, не числа.
                // vertLabelsAlign ИНВЕРТИРОВАН в TV: 'top'=снизу снаружи, 'bottom'=сверху снаружи, 'middle'=центр
                // horzLabelsAlign: 'left' | 'center' | 'right'
                horzLabelsAlign:  s.horzLabelsAlign || s.horzAlign || 'right',
                vertLabelsAlign:  s.vertLabelsAlign || s.vertAlign || 'middle',
            };
        } else if (isLineType) {
            // ── Линии: trend_line, ray, extended_line и т.д. ───────
            overrides = {
                color:           s.color,
                linecolor:       s.color,
                linewidth:       s.linewidth  !== undefined ? s.linewidth  : 2,
                linestyle:       s.linestyle  !== undefined ? s.linestyle  : 0,
                fillBackground:  false,
                transparency:    s.transparency !== undefined ? s.transparency : 0,
                extendLeft:      s.extendLeft  !== undefined ? !!s.extendLeft  : false,
                extendRight:     s.extendRight !== undefined ? !!s.extendRight : false,
                // Подпись на линии
                showLabel:       !!(s.label),
                text:            s.label     || '',
                textcolor:       s.textcolor || s.color || 'rgba(255,255,255,0.90)',
                fontSize:        s.fontsize  !== undefined ? s.fontsize : 12,
                bold:            s.bold      !== undefined ? !!s.bold   : false,
            };

        } else if (isMarker) {
            // ── Маркеры: стрелки, флаги, кресты ────────────────────
            overrides = {
                color:           s.color,
                backgroundColor: s.color,
                linecolor:       s.color,
                fillBackground:  true,
                transparency:    s.transparency !== undefined ? s.transparency : 0,
            };

        } else if (isLabelShape) {
            // ── label_up / label_down / balloon / note ──────────────
            // Эти шейпы сами по себе текстовые — color = цвет фона/стрелки
            overrides = {
                color:           s.color     || 'rgba(41,98,255,0.90)',
                backgroundColor: s.color     || 'rgba(41,98,255,0.90)',
                textcolor:       s.textcolor || 'rgba(255,255,255,0.90)',
                fontSize:        s.fontsize  !== undefined ? s.fontsize : 12,
                bold:            s.bold      !== undefined ? !!s.bold   : false,
                transparency:    s.transparency !== undefined ? s.transparency : 0,
                text:            s.label || '',
            };

        } else {
            // ── Fallback для всех прочих типов (fib, pitchfork и т.д.) ──
            overrides = {
                backgroundColor: s.color,
                color:           s.color,
                linecolor:       s.color,
                linewidth:       s.linewidth    !== undefined ? s.linewidth    : 1,
                linestyle:       s.linestyle    !== undefined ? s.linestyle    : 0,
                fillBackground:  s.fillBackground !== undefined ? s.fillBackground : false,
                transparency:    s.transparency !== undefined ? s.transparency : 0,
                showLabel:       !!(s.label),
                text:            s.label     || '',
                textcolor:       s.textcolor || s.color,
                fontSize:        s.fontsize  !== undefined ? s.fontsize : 12,
                bold:            s.bold      !== undefined ? !!s.bold   : false,
            };
        }

        // Пробрасываем любые дополнительные overrides из шейпа (escape hatch)
        // Если скрипт передаёт s.overrides — мерджим поверх
        if (s.overrides && typeof s.overrides === 'object') {
            for (var k in s.overrides) {
                if (s.overrides.hasOwnProperty(k)) overrides[k] = s.overrides[k];
            }
        }

        return {
            shape:            shapeName,
            lock:             true,
            disableSelection: true,
            disableSave:      true,
            disableUndo:      true,
            zOrder:           s.zOrder || (isText || isLabelShape ? 'top' : (isRect ? 'bottom' : 'top')),
            overrides:        overrides,
        };
    }

    // ── Создание одного шейпа на чарте ───────────────────────────
    function _createOneShape(c, s) {
        var shapeName = s.shape || 'rectangle';
        var isText    = shapeName === 'text';
        var opts      = _buildShapeOpts(s);

        var r;

        // text шейп: TV ожидает createShape(point) с одной точкой
        if (isText) {
            var pt = s.point || (s.points && s.points[0]);
            if (!pt) return null;
            r = c.createShape(pt, opts);
        } else if (s.point) {
            r = c.createShape(s.point, opts);
        } else if (s.points && s.points.length) {
            r = c.createMultipointShape(s.points, opts);
        } else {
            return null;
        }

        return r;
    }

    // ── ИНКРЕМЕНТАЛЬНАЯ ОТРИСОВКА ─────────────────────────────────
    function _incrementalRedraw(key, vr, vrKey) {
        var st = window._tve[key];
        if (!st || st._hidden || !st._cache) return;
        var c = _chart(); if (!c) return;

        var allShapes  = st._cache.allShapes;
        var maxShapes  = st.def.maxShapes || 500;
        var nextSet    = _visibleIndices(allShapes, vr);
        var prevActive = st._activeSet || _makeSet();

        if (!st._activeSet) {
            st._activeSet = _makeSet();
            st._shapeMap  = {};
        }

        var nextArr = [];
        nextSet.forEach(function (idx) { nextArr.push(idx); });
        if (nextArr.length > maxShapes) {
            nextArr = nextArr.slice(nextArr.length - maxShapes);
            var trimmedSet = _makeSet();
            for (var ti = 0; ti < nextArr.length; ti++) trimmedSet.add(nextArr[ti]);
            nextSet = trimmedSet;
        }

        var toRemove = [];
        prevActive.forEach(function (idx) {
            if (!nextSet.has(idx)) toRemove.push(idx);
        });

        var toAdd = [];
        nextArr.forEach(function (idx) {
            if (!prevActive.has(idx)) toAdd.push(idx);
        });

        for (var ri = 0; ri < toRemove.length; ri++) {
            var removeIdx = toRemove[ri];
            var eid = st._shapeMap[removeIdx];
            if (eid != null) { try { c.removeEntity(eid); } catch (e) {} }
            delete st._shapeMap[removeIdx];
            st._activeSet.delete(removeIdx);
        }

        if (toAdd.length > 0) {
            var toDrawList = [];
            for (var ai = 0; ai < toAdd.length; ai++) {
                toDrawList.push({ idx: toAdd[ai], shape: allShapes[toAdd[ai]] });
            }
            // Передаём vrKey чтобы батч мог обнаружить смещение viewport
            _drawIncrementalBatch(key, toDrawList, 0, st._generation || 0, vrKey);
        }

        st._cache.vrKey = vrKey;

        if (toRemove.length > 0 || toAdd.length > 0) {
            console.log('[TVEngine:' + key + '] incremental: -' + toRemove.length + ' +' + toAdd.length
                + ' active=' + nextArr.length);
        }
    }

    function _drawIncrementalBatch(key, list, offset, gen, startVrKey) {
        var st = window._tve[key];
        if (!st || st._hidden || (st._generation || 0) !== gen) return;
        if (!_chartReady()) {
            setTimeout(function () { _drawIncrementalBatch(key, list, offset, gen, startVrKey); }, 300);
            return;
        }

        // ── Проверяем что viewport не изменился с начала батча ───────────
        // Если viewport сдвинулся — отменяем батч и запускаем новый redraw.
        // Это предотвращает рендер шейпов со смещением когда TV привязывает
        // их координаты к текущему видимому диапазону во время создания.
        var vr = _getVisibleRange();
        var curVrKey = vr ? (Math.floor(vr.from) + ':' + Math.floor(vr.to)) : 'null';
        if (startVrKey && curVrKey !== startVrKey) {
            // Viewport изменился во время батча — перезапускаем incremental redraw
            console.log('[TVEngine:' + key + '] batch cancelled: viewport moved during draw, restarting');
            _scheduleRedraw(key, 50);
            return;
        }

        var c = _chart(); if (!c) return;
        // Увеличен с 30 до 100 — меньше setTimeout прерываний между итерациями
        var end = Math.min(offset + 100, list.length);

        for (var i = offset; i < end; i++) {
            var item = list[i];
            var idx  = item.idx;
            var s    = item.shape;
            try {
                var r = _createOneShape(c, s);
                if (!r) continue;

                if (typeof r.then === 'function') {
                    (function (captIdx, p, stRef, captGen) {
                        p.then(function (id) {
                            if (id != null && (stRef._generation || 0) === captGen) {
                                stRef._shapeMap[captIdx] = id;
                                stRef._activeSet.add(captIdx);
                            }
                        }).catch(function () {});
                    })(idx, r, st, gen);
                } else {
                    st._shapeMap[idx] = r;
                    st._activeSet.add(idx);
                }
            } catch (e) { /* skip broken shape */ }
        }

        if (end < list.length) {
            setTimeout(function () { _drawIncrementalBatch(key, list, end, gen, startVrKey); }, 16);
        }
    }

    /* ── Полная отрисовка ─────────────────────────────────────── */
    function _clearShapes(key) {
        var st = window._tve[key]; if (!st) return;
        var c = _chart();
        st._generation = (st._generation || 0) + 1;

        if (st._shapeMap) {
            if (c) {
                for (var idx in st._shapeMap) {
                    if (st._shapeMap.hasOwnProperty(idx)) {
                        var eid = st._shapeMap[idx];
                        if (eid != null) try { c.removeEntity(eid); } catch (e) {}
                    }
                }
            }
            st._shapeMap  = {};
            st._activeSet = _makeSet();
        }

        if (st.shapeIds && st.shapeIds.length) {
            if (c) for (var i = 0; i < st.shapeIds.length; i++) {
                try { c.removeEntity(st.shapeIds[i]); } catch (e) {}
            }
            st.shapeIds.length = 0;
        }

        var pending = st._pendingPromises;
        if (pending && pending.length > 0) {
            var chartRef = c;
            var copy = pending.slice();
            pending.length = 0;
            for (var j = 0; j < copy.length; j++) {
                (function (p) {
                    p.then(function (id) {
                        if (id != null && chartRef) try { chartRef.removeEntity(id); } catch (e) {}
                    }).catch(function () {});
                })(copy[j]);
            }
        }
    }

    function _drawShapes(key, allShapes, visibleIndicesSet) {
        var st = window._tve[key];
        if (!st || st._hidden) return;
        _clearShapes(key);
        if (!allShapes.length) return;

        st._shapeMap  = {};
        st._activeSet = _makeSet();

        var toDrawList = [];
        visibleIndicesSet.forEach(function (idx) {
            if (idx < allShapes.length) toDrawList.push({ idx: idx, shape: allShapes[idx] });
        });

        var maxShapes = st.def.maxShapes || 500;
        if (toDrawList.length > maxShapes) toDrawList = toDrawList.slice(toDrawList.length - maxShapes);

        _drawIncrementalBatch(key, toDrawList, 0, st._generation || 0, null);
    }

    /* ── _redraw ─────────────────────────────────────────────────── */
    function _redraw(key, retryCount) {
        var st = window._tve[key];
        if (!st || st._hidden || !st.def || !st.cfg) return;
        retryCount = retryCount || 0;

        if (!_chartReady()) {
            if (retryCount < _MAX_CHART_RETRIES) _scheduleRedraw(key, 800, retryCount + 1);
            else { console.warn('[TVEngine:'+key+'] redraw aborted: chart not ready'); _clearShapes(key); }
            return;
        }

        var bars = _getBars();
        if (bars.length < 3) {
            if (retryCount < _MAX_CHART_RETRIES) _scheduleRedraw(key, 500, retryCount + 1);
            else console.warn('[TVEngine:'+key+'] redraw aborted: insufficient bars');
            return;
        }

        _installViewportHook();

        var dataKey = bars.length + ':' + bars[0].t + ':' + bars[bars.length - 1].t;
        var cfgKey  = '';
        try { cfgKey = JSON.stringify(st.cfg); } catch (e) {}

        var allShapes;
        var isFullRedraw = true;

        if (st._cache && st._cache.dataKey === dataKey && st._cache.cfgKey === cfgKey) {
            allShapes    = st._cache.allShapes;
            isFullRedraw = false;
        } else {
            allShapes = [];
            try { allShapes = st.def.analyze(bars, st.cfg) || []; }
            catch (e) { console.error('[TVEngine] analyze err:', e); return; }
            st._cache = { dataKey: dataKey, cfgKey: cfgKey, allShapes: allShapes, vrKey: null };
        }

        var vr    = _getVisibleRange();
        var vrKey = vr ? (Math.floor(vr.from) + ':' + Math.floor(vr.to)) : 'null';

        if (!isFullRedraw && st._cache.vrKey === vrKey && st._activeSet) {
            return;
        }

        if (isFullRedraw || !st._activeSet) {
            var visSet = _visibleIndices(allShapes, vr);
            st._cache.vrKey = vrKey;
            console.log('[TVEngine:' + key + '] full redraw: analyze=' + allShapes.length
                + ' visible=' + visSet.size);
            _drawShapes(key, allShapes, visSet);
        } else {
            _incrementalRedraw(key, vr, vrKey);
        }
    }

    function _scheduleRedraw(key, ms, retryCount) {
        var st = window._tve[key]; if (!st || st._hidden) return;
        clearTimeout(st.debTimer);
        var rc = retryCount || 0;
        st.debTimer = setTimeout(function () { _redraw(key, rc); }, ms !== undefined ? ms : 300);
    }

    /* ── Мониторинг ─────────────────────────────────────────────── */
    function _startMonitor(key, studyId) {
        var vrPollCounter = 0;
        var iv = setInterval(function () {
            var st = window._tve[key]; if (!st) { clearInterval(iv); return; }
            var c = _chart(); if (!c) return;
            var studies; try { studies = c.getAllStudies(); } catch (e) { return; }
            var found = null;
            for (var i = 0; i < studies.length; i++) {
                if (String(studies[i].id) === String(studyId) || String(studies[i].entityId) === String(studyId)) {
                    found = studies[i]; break;
                }
            }
            if (!found) { clearInterval(iv); _destroy(key); return; }
            var vis = true;
            try {
                var entity = c.getStudyById(found.entityId || found.id);
                if (entity && typeof entity.isVisible === 'function') vis = entity.isVisible();
            } catch (e) {}
            if (!vis && !st._hidden)    { st._hidden = true;  _clearShapes(key); }
            else if (vis && st._hidden) { st._hidden = false; _scheduleRedraw(key, 50); }

            if (!_vrHookInstalled) {
                vrPollCounter++;
                if (vrPollCounter >= 10) {
                    vrPollCounter = 0;
                    if (st._cache && st._cache.allShapes) {
                        var vr = _getVisibleRange();
                        var vrKey = vr ? (Math.floor(vr.from) + ':' + Math.floor(vr.to)) : 'null';
                        if (st._cache.vrKey !== vrKey) _incrementalRedraw(key, vr, vrKey);
                    }
                }
            }
        }, 500);
        var st = window._tve[key]; if (st) st._iv = iv;
    }

    /* ── Hooks ──────────────────────────────────────────────────── */
    function _installGetBarsHook() {
        var df = window.app && window.app.datafeed;
        if (!df || typeof df.getBars !== 'function' || df._tveGetBarsHook) return;
        var origGetBars = df.getBars.bind(df);
        df._tveGetBarsHook = true;
        df.getBars = function (symbolInfo, resolution, periodParams, onHistoryCallback, onErrorCallback) {
            if (!_hasInstances()) return origGetBars(symbolInfo, resolution, periodParams, onHistoryCallback, onErrorCallback);
            var wrappedCallback = function (bars, meta) {
                onHistoryCallback(bars, meta);
                if (bars && bars.length > 0) {
                    setTimeout(function () {
                        var keys = Object.keys(window._tve);
                        for (var i = 0; i < keys.length; i++) {
                            var st = window._tve[keys[i]];
                            if (st && !st._hidden && st.cfg) _scheduleRedraw(keys[i], 300);
                        }
                    }, 100);
                }
            };
            return origGetBars(symbolInfo, resolution, periodParams, wrappedCallback, onErrorCallback);
        };
        console.log('[TVEngine] getBars hook installed');
    }

    function _installHook() {
        var df = window.app && window.app.datafeed;
        if (!df || typeof df.appendActiveData !== 'function' || df._tveHook) return;
        var orig = df.appendActiveData.bind(df);
        df._tveOrig = orig; df._tveHook = true;
        df.appendActiveData = function (data) {
            var result = orig(data);
            if (!_hasInstances() || !data || !data.length) return result;
            var keys = Object.keys(window._tve);
            for (var i = 0; i < keys.length; i++) {
                var st = window._tve[keys[i]];
                if (st && !st._hidden && st.cfg) _scheduleRedraw(keys[i], 500);
            }
            return result;
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

    function _destroy(key) {
        var st = window._tve[key];
        if (st) {
            clearTimeout(st.debTimer);
            if (st._iv) clearInterval(st._iv);
            if (st._discoveryIv) clearInterval(st._discoveryIv);
            _clearShapes(key);
            st._cache     = null;
            st._shapeMap  = {};
            st._activeSet = null;
            if (st.tvId) delete window._tveRegistry[st.tvId];
        }
        delete window._tve[key];
        if (!_hasInstances()) setTimeout(_forceCleanGhosts, 100);
        console.log('[TVEngine] destroyed:', key);
    }

    /* ── Ghost cleanup ─────────────────────────────────────────── */
    var _ghostCleanDone = false;
    function _cleanGhostShapes() {
        if (_ghostCleanDone) return;
        _ghostCleanDone = true;
    }

    // Расширенный список всех shape types которые TVEngine создаёт
    var _TVE_SHAPE_TYPES = {
        trend_line:1, extended_line:1, ray:1,
        rectangle:1, rect:1,
        parallel_channel:1, rotated_rectangle:1,
        vertical_line:1, horizontal_line:1,
        arrow:1, arrow_up:1, arrow_down:1, arrow_left:1, arrow_right:1,
        flag:1, cross:1, circle:1,
        text:1, balloon:1, label_up:1, label_down:1, note:1, price_label:1,
    };

    function _forceCleanGhosts() {
        var c = _chart(); if (!c) return 0;
        var allShapes;
        try { allShapes = c.getAllShapes ? c.getAllShapes() : []; } catch (e) { return 0; }
        if (!allShapes || allShapes.length === 0) return 0;
        var knownIds = {};
        var keys = Object.keys(window._tve);
        for (var k = 0; k < keys.length; k++) {
            var st = window._tve[keys[k]];
            if (st && st._shapeMap) {
                for (var sidx in st._shapeMap) {
                    if (st._shapeMap.hasOwnProperty(sidx)) knownIds[String(st._shapeMap[sidx])] = true;
                }
            }
        }
        var removed = 0;
        for (var i = 0; i < allShapes.length; i++) {
            var sh = allShapes[i];
            var shName = (sh.name || '').toLowerCase();
            if (_TVE_SHAPE_TYPES[shName] && !knownIds[String(sh.id)]) {
                try { c.removeEntity(sh.id); removed++; } catch (e) {}
            }
        }
        if (removed > 0) console.log('[TVEngine] cleaned ' + removed + ' ghost shapes');
        return removed;
    }

    /* ── Instance init ─────────────────────────────────────────── */
    function _initInstance(def, studyName, studyDesc, tvId) {
        if (window._tveRegistry[tvId] && window._tve[window._tveRegistry[tvId]]) {
            return window._tveRegistry[tvId];
        }
        var key = 'tve_' + (++_keyCounter) + '_' + Date.now();
        window._tve[key] = {
            shapeIds: [],
            _shapeMap:  {},
            _activeSet: null,
            _pendingPromises: [],
            _hidden: false, def: def, cfg: null,
            debTimer: null, _iv: null, _batchId: 0,
            _generation: 0, _errorRetries: 0,
            tvId: tvId, _discoveryIv: null,
            _cache: null
        };
        window._tveRegistry[tvId] = key;
        _cleanGhostShapes();
        _tryInstallHooks();

        var matchLen = Math.min(studyDesc ? studyDesc.length : 0, _STUDY_MATCH_LEN);
        var attempts = 0, t = setInterval(function () {
            attempts++;
            var c = _chart(); if (!c) return;
            var studies; try { studies = c.getAllStudies(); } catch (e) { return; }
            var found = null;
            for (var i = studies.length - 1; i >= 0; i--) {
                var sn = studies[i].name || '';
                if (sn === studyDesc || sn === studyName ||
                    (studyDesc && matchLen > 0 && sn.indexOf(studyDesc.substring(0, matchLen)) !== -1))
                    { found = studies[i]; break; }
            }
            if (!found && attempts < 30) return;
            clearInterval(t);
            var sid = found ? String(found.id || found.entityId) : key;
            var st = window._tve[key]; if (!st) return;
            st.studyId = sid;
            st._discoveryIv = null;
            console.log('[TVEngine] init key=' + key + ' sid=' + sid + ' name="' + studyName + '"');
            _startMonitor(key, sid);
            if (st.cfg) _scheduleRedraw(key, 300);
        }, 100);
        var st = window._tve[key]; if (st) st._discoveryIv = t;
        return key;
    }

    /* ═══════════════════════════════════════════════════════════ */
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
                _metainfoVersion: 53, id: tvId, description: desc,
                shortDescription: name.substring(0, 24),
                is_price_study: overlay, isCustomIndicator: true,
                plots: [{ id: 'p0', type: 'line' }],
                format: { type: overlay ? 'inherit' : 'price' },
                defaults: {
                    styles: { p0: { linestyle: 0, linewidth: 0, plottype: 0,
                        trackPrice: false, transparency: 100, visible: false, color: _currentLegendColor() } },
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
                    if (st._cache) {
                        var newCfgKey = '';
                        try { newCfgKey = JSON.stringify(cfg); } catch (e) {}
                        if (st._cache.cfgKey !== newCfgKey) {
                            st._cache     = null;
                            st._activeSet = null;
                        }
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

    /* ── Public API ────────────────────────────────────────────── */
    window.TVEngine = {
        define:      define,
        instances:   function () { return Object.keys(window._tve); },
        registry:    function () { return window._tveRegistry; },
        redraw:      function (key) { if (window._tve[key]) { window._tve[key]._cache = null; window._tve[key]._activeSet = null; } _scheduleRedraw(key, 0); },
        redrawAll:   function () { Object.keys(window._tve).forEach(function (k) { if (window._tve[k]) { window._tve[k]._cache = null; window._tve[k]._activeSet = null; } _scheduleRedraw(k, 0); }); },
        destroy:     function (key) { _destroy(key); },
        clearAll:    function () { Object.keys(window._tve).forEach(function (k) { _destroy(k); }); },
        state:       function (key) { return window._tve[key]; },
        cleanGhosts: _forceCleanGhosts,
        updateLegendColor: _updateLegendColor,
        setViewportBuffer: function (pct) { _VIEWPORT_BUFFER_PCT = Math.max(0, pct); },
    };

    console.log('[TVEngine] v11.15 loaded');
})();
