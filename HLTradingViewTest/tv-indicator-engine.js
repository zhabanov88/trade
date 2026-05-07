/**
 * tv-indicator-engine.js  v11.25
 * Подключить в index.html ДО app.js
 *
 * v11.18 changelog (поверх v11.15):
 *  - [FIX]  _getBars: timestamps без Z парсились как локальное время браузера.
 *           Симптом: все шейпы смещены на UTC offset (напр. UTC+3 → шейпы -3ч).
 *           Фикс: добавляем Z к строкам без timezone suffix перед парсингом.
 *  - [FIX]  isMarker (arrow_up/down/flag): добавлены fontsize и arrowColor.
 *           fontsize контролирует размер маркера (verified via getProperties()).
 *           tiny≈8, small≈10, normal=14 (TV default), large≈18.
 *
 * v11.15 changelog (поверх v11.14):
 *  - [FIX]  fontsize → fontSize (заглавная S) в overrides для ВСЕХ типов шейпов
 *           Входное поле в скрипте по-прежнему s.fontsize (строчная) — удобнее писать
 *           В overrides TV всегда передаётся fontSize (верифицировано через getProperties())
 *
 * v11.14 changelog (поверх v11.13):
 *  - [FIX]  Баг смещения шейпов при прокрутке влево:
 *           _drawIncrementalBatch теперь проверяет что viewport не изменился
 *           между итерациями батча. Если viewport сдвинулся — батч отменяется
 *           и запускается новый _incrementalRedraw с актуальным vrKey.
 *  - [PERF] Размер батча увеличен с 30 до 100 шейпов за итерацию —
 *           меньше setTimeout прерываний, меньше шансов поймать смещение viewport.
 *
 * v11.13 changelog (поверх v11.12):
 *  - [FIX]  linestyle: 1=dotted, 2=dashed (было перепутано: 1=dashed, 2=dotted)
 *          Верифицировано визуально через createMultipointShape
 *
 * v11.12 changelog (поверх v11.12):
 *  - [DOC]  vertLabelsAlign ИНВЕРТИРОВАН: top=снизу снаружи, bottom=сверху снаружи, middle=центр
 *          aboveBar/belowBar не работают в TV Advanced Charts
 *
 * v11.11 changelog (поверх v11.10):
 *  - [FIX]  rectangle: правильные имена ключей выравнивания:
 *           horzLabelsAlign (не horzAlign), vertLabelsAlign (не vertAlign)
 *           textColor (заглавная C, не textcolor)
 *           Все три ключа работают через overrides при createMultipointShape
 *  - [FIX]  rectangle: удалён механизм postOverrides — не нужен,
 *           setProperties/applyOverrides на entity не требуются
 *  - [FIX]  Значения horzLabelsAlign/vertLabelsAlign — строки (right/middle),
 *           не числа как предполагалось ранее
 *
 * v11.10 changelog (поверх v11.9):
 *  - [NEW]  postOverrides: после создания шейпа вызывается entity.applyOverrides()
 *           Это единственный способ установить horzAlign/vertAlign для rectangle —
 *           TV игнорирует их при createMultipointShape, но принимает через entity API.
 *           Использование: добавь поле postOverrides:{horzAlign:2,vertAlign:1} в шейп.
 *
 * v11.9 changelog (поверх v11.8):
 *  - [FIX]  rectangle: horzAlign/vertAlign теперь числа (0/1/2), не строки
 *           TV Advanced Charts отклоняет строковые значения — текст не выравнивался
 *  - [FIX]  rectangle: textcolor больше не падает на s.color (цвет зоны с малой
 *           альфой делал текст невидимым). Дефолт: rgba(255,255,255,0.90)
 *  - [NEW]  rectangle: поля horzAlign/vertAlign доступны прямо в шейпе
 *           (0=left/top, 1=center/middle, 2=right/bottom)
 *
 * v11.8 changelog (поверх v11.7):
 *  - [FIX]  rectangle/zone: добавлены textcolor, fontsize, bold в overrides
 *           TV нативно поддерживает текст внутри прямоугольника через showLabel+text
 *           Теперь можно задавать label прямо на rectangle без отдельного text-шейпа
 *  - [NEW]  Универсальный механизм label для ВСЕХ шейпов:
 *           Любой шейп принимает label, textcolor, fontsize, bold
 *           rectangle → текст внутри зоны (нативно TV)
 *           text      → отдельный шейп с координатой
 *           остальные → showLabel + text через overrides
 *  - [NEW]  _TVE_SHAPE_TYPES расширен: text, balloon, label_up, label_down, note
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

    // ── Global indicator opacity ──────────────────────────────────
    // Per-indicator opacity multiplier (0.0 = invisible, 1.0 = full).
    // Applied to all rgba() colors in shapes before passing to TV API.
    var _indicatorOpacity = {};  // key → 0.0..1.0

    function _scaleAlpha(rgba, multiplier) {
        if (multiplier === 1) return rgba;
        var m = rgba.match(/^rgba?\(([^)]+)\)$/);
        if (!m) return rgba;
        var p = m[1].split(',');
        if (p.length < 3) return rgba;
        var a = p.length >= 4 ? parseFloat(p[3]) : 1.0;
        var newA = Math.max(0, Math.min(1, a * multiplier));
        // Round to 2 decimal places to avoid float noise
        newA = Math.round(newA * 100) / 100;
        return 'rgba(' + p[0].trim() + ',' + p[1].trim() + ',' + p[2].trim() + ',' + newA + ')';
    }

    function _applyOpacityToShape(s, multiplier) {
        if (multiplier === 1) return s;
        // Shallow clone shape, scale all color fields
        var out = {};
        for (var k in s) {
            if (!s.hasOwnProperty(k)) continue;
            var v = s[k];
            if (typeof v === 'string' && /^rgba?\(/.test(v)) {
                out[k] = _scaleAlpha(v, multiplier);
            } else if (k === 'overrides' && v && typeof v === 'object') {
                var ov = {};
                for (var ok in v) {
                    if (!v.hasOwnProperty(ok)) continue;
                    ov[ok] = (typeof v[ok] === 'string' && /^rgba?\(/.test(v[ok]))
                        ? _scaleAlpha(v[ok], multiplier)
                        : v[ok];
                }
                out[k] = ov;
            } else {
                out[k] = v;
            }
        }
        return out;
    }

    function _currentLegendColor() {
        var theme = 'dark';
        try { theme = localStorage.getItem('tradingview_theme') || 'dark'; } catch (e) { }
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
                } catch (e) { }
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
            // FIX: timestamps без timezone ("2025-11-20 23:00:00" без Z) парсятся
            // браузером как локальное время → смещение на UTC offset пользователя.
            // Добавляем Z чтобы всегда парсить как UTC.
            var ts = b.timestamp;
            if (ts && ts.indexOf('Z') === -1 && ts.indexOf('+') === -1) {
                ts = ts.replace(' ', 'T') + 'Z';
            }
            var t = Math.floor(new Date(ts).getTime() / 1000);
            var h = parseFloat(b.high), l = parseFloat(b.low);
            var cl = parseFloat(b.close), op = parseFloat(b.open);
            if (isFinite(t) && !isNaN(h) && !isNaN(l)) {
                var bar = { t: t, h: h, l: l, c: cl, o: op, v: parseFloat(b.volume) || 0 };
                // FIX: копируем MTF данные если они есть
                if (b.tf_up) bar.tf_up = b.tf_up;
                if (b.tf_down) bar.tf_down = b.tf_down;
                bars.push(bar);
            }
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
        } catch (e) { }
        return null;
    }

    function _visibleIndices(allShapes, vr) {
        var result = new Set ? new Set() : _makeSet();
        if (!vr || !allShapes.length) return result;
        var span = vr.to - vr.from;
        var buf = span * _VIEWPORT_BUFFER_PCT;
        var tFrom = vr.from - buf;
        var tTo = vr.to + buf;
        for (var i = 0; i < allShapes.length; i++) {
            var s = allShapes[i];
            var pts = s.points;
            if (!pts || !pts.length) { result.add(i); continue; }
            var sFrom = pts[0].time;
            var sTo = pts[pts.length - 1].time;
            if (sFrom > sTo) { var tmp = sFrom; sFrom = sTo; sTo = tmp; }
            if (sTo >= tFrom && sFrom <= tTo) result.add(i);
        }
        return result;
    }

    function _makeSet() {
        var items = {};
        return {
            add: function (v) { items[v] = true; },
            has: function (v) { return !!items[v]; },
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
        } catch (e) { }
    }

    function _onViewportChanged() {
        var vr = _getVisibleRange(); if (!vr) return;
        var vrKey = Math.floor(vr.from) + ':' + Math.floor(vr.to);
        var keys = Object.keys(window._tve);
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            var st = window._tve[key];
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
        var shapeName = s.shape || 'rectangle';
        var isText = shapeName === 'text';
        var isRect = shapeName === 'rectangle' || shapeName === 'rect';
        var isLineType = /^(trend_line|ray|extended_line|parallel_channel|disjoint_angle|flat_top|flat_bottom)$/.test(shapeName);
        var isMarker = /^(arrow_up|arrow_down|arrow_left|arrow_right|arrow|flag|cross|circle|triangle_up|triangle_down)$/.test(shapeName);
        var isLabelShape = /^(label_up|label_down|balloon|note|price_label)$/.test(shapeName);

        var overrides;

        if (isText) {
            // ── text шейп ──────────────────────────────────────────
            // fillBackground:true → цветной фон (как SH/SL метки)
            // fillBackground:false → прозрачный фон (обычный текст)
            var textFill = s.fillBackground !== undefined ? s.fillBackground : false;
            // Если есть s.overrides.fillBackground — приоритет за ним
            if (s.overrides && s.overrides.fillBackground !== undefined) textFill = s.overrides.fillBackground;
            var textBg = s.backgroundColor || (s.overrides && s.overrides.backgroundColor) || 'rgba(0,0,0,0)';
            overrides = {
                color: s.color || 'rgba(255,255,255,0.90)',
                textcolor: s.textcolor || s.color || 'rgba(255,255,255,0.90)',
                fontSize: s.fontsize !== undefined ? s.fontsize : 12,
                bold: s.bold !== undefined ? !!s.bold : false,
                fillBackground: textFill,
                backgroundColor: textFill ? textBg : 'rgba(0,0,0,0)',
                transparency: 0,
                text: s.label || '',
            };

        } else if (isRect) {
            // ── rectangle / rect: TV нативно поддерживает текст внутри ──
            //
            // ── Правильные имена ключей (выяснены через entity.getProperties()) ──
            // horzLabelsAlign / vertLabelsAlign — строки ('right','center','left' / 'middle','top','bottom')
            // textColor — ЗАГЛАВНАЯ C
            // Все три работают напрямую через overrides при createMultipointShape
            overrides = {
                backgroundColor: s.color,
                color: s.color,
                linecolor: s.color,
                linewidth: s.linewidth !== undefined ? s.linewidth : 0,
                linestyle: s.linestyle !== undefined ? s.linestyle : 0,
                fillBackground: s.fillBackground !== undefined ? s.fillBackground : true,
                transparency: s.transparency !== undefined ? s.transparency : 0,
                // ── Текст внутри прямоугольника ──
                showLabel: !!(s.label),
                text: s.label || '',
                // textColor — ЗАГЛАВНАЯ C. НЕ падать на s.color (малая альфа → невидимый текст)
                textColor: s.textcolor || s.textColor || 'rgba(255,255,255,0.90)',
                fontSize: s.fontsize !== undefined ? s.fontsize : 12,
                bold: s.bold !== undefined ? !!s.bold : false,
                // Выравнивание — строки, не числа.
                // vertLabelsAlign ИНВЕРТИРОВАН в TV: 'top'=снизу снаружи, 'bottom'=сверху снаружи, 'middle'=центр
                // horzLabelsAlign: 'left' | 'center' | 'right'
                horzLabelsAlign: s.horzLabelsAlign || s.horzAlign || 'right',
                vertLabelsAlign: s.vertLabelsAlign || s.vertAlign || 'middle',
            };
        } else if (isLineType) {
            // ── Линии: trend_line, ray, extended_line, flat_top, flat_bottom ─
            //
            // Верифицированные ключи для ray (из entity.getProperties()):
            //   linecolor, linewidth, linestyle, extendLeft, extendRight
            //   НЕТ полей: fillBackground, backgroundColor, color (только linecolor)
            //
            // ray всегда рисует линию — fillBackground не нужен и игнорируется.
            // Проблема с прямоугольниками была в старом коде где color → backgroundColor.
            overrides = {
                color: s.color,       // для trend_line / extended_line
                linecolor: s.color,        // для ray (верифицировано)
                linewidth: s.linewidth !== undefined ? s.linewidth : 2,
                linestyle: s.linestyle !== undefined ? s.linestyle : 0,
                fillBackground: false,          // безопасно передать — ray игнорирует
                transparency: s.transparency !== undefined ? s.transparency : 0,
                extendLeft: s.extendLeft !== undefined ? !!s.extendLeft : false,
                extendRight: s.extendRight !== undefined ? !!s.extendRight : false,
                // Подпись на линии
                showLabel: !!(s.label),
                text: s.label || '',
                textcolor: s.textcolor || s.color || 'rgba(255,255,255,0.90)',
                fontSize: s.fontsize !== undefined ? s.fontsize : 12,
                bold: s.bold !== undefined ? !!s.bold : false,
            };

        } else if (isMarker) {
            // ── Маркеры: стрелки, флаги, кресты ────────────────────
            // fontsize контролирует размер (verified via getProperties(): fontsize:14 default)
            // arrowColor — отдельный ключ для стрелок помимо color
            // Размеры: tiny≈8, small≈10, normal=14, large≈18
            overrides = {
                color: s.color,
                arrowColor: s.color,
                backgroundColor: s.color,
                linecolor: s.color,
                fillBackground: true,
                transparency: s.transparency !== undefined ? s.transparency : 0,
                fontsize: s.fontsize !== undefined ? s.fontsize : 14,
            };

        } else if (isLabelShape) {
            // ── label_up / label_down / balloon / note ──────────────
            // Эти шейпы сами по себе текстовые — color = цвет фона/стрелки
            overrides = {
                color: s.color || 'rgba(41,98,255,0.90)',
                backgroundColor: s.color || 'rgba(41,98,255,0.90)',
                textcolor: s.textcolor || 'rgba(255,255,255,0.90)',
                fontSize: s.fontsize !== undefined ? s.fontsize : 12,
                bold: s.bold !== undefined ? !!s.bold : false,
                transparency: s.transparency !== undefined ? s.transparency : 0,
                text: s.label || '',
            };

        } else {
            // ── Fallback для всех прочих типов (fib, pitchfork и т.д.) ──
            overrides = {
                backgroundColor: s.color,
                color: s.color,
                linecolor: s.color,
                linewidth: s.linewidth !== undefined ? s.linewidth : 1,
                linestyle: s.linestyle !== undefined ? s.linestyle : 0,
                fillBackground: s.fillBackground !== undefined ? s.fillBackground : false,
                transparency: s.transparency !== undefined ? s.transparency : 0,
                showLabel: !!(s.label),
                text: s.label || '',
                textcolor: s.textcolor || s.color,
                fontSize: s.fontsize !== undefined ? s.fontsize : 12,
                bold: s.bold !== undefined ? !!s.bold : false,
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
            shape: shapeName,
            lock: true,
            disableSelection: true,
            disableSave: true,
            disableUndo: true,
            zOrder: s.zOrder || (isText || isLabelShape ? 'top' : (isRect ? 'bottom' : 'top')),
            overrides: overrides,
        };
    }

    // ── Создание одного шейпа на чарте ───────────────────────────
    function _createOneShape(c, s) {
        var shapeName = s.shape || 'rectangle';
        var isText = shapeName === 'text';
        var opts = _buildShapeOpts(s);

        var r;

        // text / anchored_text: TV ожидает createShape(point) с одной точкой
        var isAnchoredText = shapeName === 'anchored_text';
        if (isText || isAnchoredText) {
            var pt = s.point || (s.points && s.points[0]);
            if (!pt) return null;
            r = c.createShape(pt, opts);
        } else if (s.point) {
            // Явно одноточечный шейп
            r = c.createShape(s.point, opts);
        } else if (s.points && s.points.length) {
            // 2+ точечные шейпы через createMultipointShape
            // Включая: trend_line, ray, extended_line, rectangle, fibonacci_retracement,
            //          flat_top, brush, highlighter и 3-точечные: parallel_channel, arc, ellipse
            r = c.createMultipointShape(s.points, opts);
        } else {
            return null;
        }

        // postCreate: после получения ID шейпа вызываем setProperties
        // Используется для свойств которые TV не принимает при создании
        // (например центрирование text шейпа)
        if (s.postProperties && r) {
            var pp = s.postProperties;
            var applyPost = function (id) {
                if (id == null) return;
                try {
                    var after = c.getAllShapes();
                    for (var ai = 0; ai < after.length; ai++) {
                        if (after[ai].id === id) {
                            var entity = c.getShapeById(id);
                            if (entity && typeof entity.setProperties === 'function') {
                                entity.setProperties(pp);
                            }
                            break;
                        }
                    }
                } catch (e) { }
            };
            if (typeof r.then === 'function') {
                r.then(function (id) { setTimeout(function () { applyPost(id); }, 50); }).catch(function () { });
            } else {
                setTimeout(function () { applyPost(r); }, 50);
            }
        }

        return r;
    }

    // ── ИНКРЕМЕНТАЛЬНАЯ ОТРИСОВКА ─────────────────────────────────
    function _incrementalRedraw(key, vr, vrKey) {
        var st = window._tve[key];
        if (!st || st._hidden || !st._cache) return;
        var c = _chart(); if (!c) return;

        var allShapes = st._cache.allShapes;
        var maxShapes = st.def.maxShapes || 500;
        var nextSet = _visibleIndices(allShapes, vr);
        var prevActive = st._activeSet || _makeSet();

        if (!st._activeSet) {
            st._activeSet = _makeSet();
            st._shapeMap = {};
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
            if (eid != null) { try { c.removeEntity(eid); } catch (e) { } }
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
            var idx = item.idx;
            var s = item.shape;
            try {
                // Apply per-indicator opacity multiplier to all colors
                var opacity = _indicatorOpacity[key];
                var sToRender = (opacity !== undefined && opacity !== 1)
                    ? _applyOpacityToShape(s, opacity)
                    : s;
                var r = _createOneShape(c, sToRender);
                if (!r) continue;

                if (typeof r.then === 'function') {
                    (function (captIdx, p, stRef, captGen) {
                        p.then(function (id) {
                            if (id != null && (stRef._generation || 0) === captGen) {
                                stRef._shapeMap[captIdx] = id;
                                stRef._activeSet.add(captIdx);
                            }
                        }).catch(function () { });
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
                        if (eid != null) try { c.removeEntity(eid); } catch (e) { }
                    }
                }
            }
            st._shapeMap = {};
            st._activeSet = _makeSet();
        }

        if (st.shapeIds && st.shapeIds.length) {
            if (c) for (var i = 0; i < st.shapeIds.length; i++) {
                try { c.removeEntity(st.shapeIds[i]); } catch (e) { }
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
                        if (id != null && chartRef) try { chartRef.removeEntity(id); } catch (e) { }
                    }).catch(function () { });
                })(copy[j]);
            }
        }
    }

    function _drawShapes(key, allShapes, visibleIndicesSet) {
        var st = window._tve[key];
        if (!st || st._hidden) return;
        _clearShapes(key);
        if (!allShapes.length) return;

        st._shapeMap = {};
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
            else { console.warn('[TVEngine:' + key + '] redraw aborted: chart not ready'); _clearShapes(key); }
            return;
        }

        var bars = _getBars();
        if (bars.length < 3) {
            if (retryCount < _MAX_CHART_RETRIES) _scheduleRedraw(key, 500, retryCount + 1);
            else console.warn('[TVEngine:' + key + '] redraw aborted: insufficient bars');
            return;
        }

        _installViewportHook();

        var dataKey = bars.length + ':' + bars[0].t + ':' + bars[bars.length - 1].t;
        var cfgKey = '';
        try { cfgKey = JSON.stringify(st.cfg); } catch (e) { }

        var allShapes;
        var isFullRedraw = true;

        if (st._cache && st._cache.dataKey === dataKey && st._cache.cfgKey === cfgKey) {
            allShapes = st._cache.allShapes;
            isFullRedraw = false;
        } else {
            allShapes = [];
            try { allShapes = st.def.analyze(bars, st.cfg) || []; }
            catch (e) { console.error('[TVEngine] analyze err:', e); return; }
            st._cache = { dataKey: dataKey, cfgKey: cfgKey, allShapes: allShapes, vrKey: null };
        }

        var vr = _getVisibleRange();
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
            } catch (e) { }
            if (!vis && !st._hidden) { st._hidden = true; _clearShapes(key); }
            else if (vis && st._hidden) {
                st._hidden = false;
                _clearShapes(key);
                if (st._cache) st._cache.vrKey = null;
                st._activeSet = null;
                _scheduleRedraw(key, 50);
            }

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
            st._cache = null;
            st._shapeMap = {};
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
        // 2-точечные линии
        trend_line: 1, extended_line: 1, ray: 1,
        flat_top: 1, flat_bottom: 1,
        fibonacci_retracement: 1, fib_retracement: 1,
        brush: 1, highlighter: 1,
        // 3-точечные
        parallel_channel: 1, rotated_rectangle: 1, disjoint_angle: 1,
        arc: 1, ellipse: 1,
        // Зоны
        rectangle: 1, rect: 1,
        // Вертикальные/горизонтальные
        vertical_line: 1, horizontal_line: 1,
        // Маркеры
        arrow: 1, arrow_up: 1, arrow_down: 1, arrow_left: 1, arrow_right: 1,
        flag: 1, cross: 1, circle: 1,
        triangle_up: 1, triangle_down: 1,
        // Текстовые
        text: 1, anchored_text: 1, balloon: 1,
        label_up: 1, label_down: 1, note: 1, price_label: 1,
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
                try { c.removeEntity(sh.id); removed++; } catch (e) { }
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
            _shapeMap: {},
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
                    (studyDesc && matchLen > 0 && sn.indexOf(studyDesc.substring(0, matchLen)) !== -1)) { found = studies[i]; break; }
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
        var system_name = def.system_name || window._current_system_name || '';
        var name = def.name || 'Custom Indicator';

        // КРИТИЧЕСКОЕ ИЗМЕНЕНИЕ:
        // Используем стабильный 'name' (FVG__Test_4) для ID, а не динамичный 'system_name'.
        // Это предотвратит пересоздание индикатора (init/destroyed).
        var tvId = def.id || (name.toLowerCase().replace(/\W+/g, '_') + '@tv-basicstudies-1');

        // Оставляем system_name в описании, раз тебе так нравится визуально,
        // НО только если он не меняется каждую секунду.
        var desc = system_name;

        var overlay = def.overlay !== undefined ? def.overlay : true;
        var inputs = def.inputs || [];
        var defInps = def.defaultInputs || {};

        var tvObj = {
            name: system_name,
            metainfo: {
                _metainfoVersion: 53,
                id: tvId, description: desc,
                shortDescription: system_name.substring(0, 24),
                is_price_study: overlay, isCustomIndicator: true,
                plots: [{ id: 'p0', type: 'line' }],
                format: { type: overlay ? 'inherit' : 'price' },
                defaults: {
                    styles: {
                        p0: {
                            linestyle: 0, linewidth: 0, plottype: 0,
                            trackPrice: false, transparency: 100, visible: false, color: _currentLegendColor()
                        }
                    },
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
                    try { cfg = def.buildCfg ? def.buildCfg(inp) : {}; } catch (e) { }
                    if (st._cache) {
                        var newCfgKey = '';
                        try { newCfgKey = JSON.stringify(cfg); } catch (e) { }
                        if (st._cache.cfgKey !== newCfgKey) {
                            st._cache = null;
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
        console.log(tvObj);
        return tvObj;
    }

    /* ── Public API ────────────────────────────────────────────── */
    window.TVEngine = {
        define: define,
        instances: function () { return Object.keys(window._tve); },
        registry: function () { return window._tveRegistry; },
        redraw: function (key) { if (window._tve[key]) { window._tve[key]._cache = null; window._tve[key]._activeSet = null; } _scheduleRedraw(key, 0); },
        redrawAll: function () { Object.keys(window._tve).forEach(function (k) { if (window._tve[k]) { window._tve[k]._cache = null; window._tve[k]._activeSet = null; } _scheduleRedraw(k, 0); }); },
        destroy: function (key) { _destroy(key); },
        clearAll: function () { Object.keys(window._tve).forEach(function (k) { _destroy(k); }); },
        state: function (key) { return window._tve[key]; },
        cleanGhosts: _forceCleanGhosts,
        updateLegendColor: _updateLegendColor,
        setViewportBuffer: function (pct) { _VIEWPORT_BUFFER_PCT = Math.max(0, pct); },

        // ── Indicator opacity API ─────────────────────────────────
        // Set opacity for a specific indicator instance (0.0 = invisible, 1.0 = full)
        // key = TVEngine instance key (from TVEngine.instances())
        // Triggers full redraw.
        setOpacity: function (key, opacity) {
            var o = Math.max(0, Math.min(1, parseFloat(opacity) || 1));
            _indicatorOpacity[key] = o;
            var st = window._tve[key];
            if (st) { st._cache = null; st._activeSet = null; _scheduleRedraw(key, 0); }
        },

        // Set opacity for all indicators at once
        setOpacityAll: function (opacity) {
            var o = Math.max(0, Math.min(1, parseFloat(opacity) || 1));
            Object.keys(window._tve).forEach(function (k) {
                _indicatorOpacity[k] = o;
                var st = window._tve[k];
                if (st) { st._cache = null; st._activeSet = null; }
            });
            Object.keys(window._tve).forEach(function (k) { _scheduleRedraw(k, 50); });
        },

        // Set opacity by indicator name (partial match)
        setOpacityByName: function (name, opacity) {
            var o = Math.max(0, Math.min(1, parseFloat(opacity) || 1));
            Object.keys(window._tve).forEach(function (k) {
                var st = window._tve[k];
                if (st && st.def && st.def.name && st.def.name.indexOf(name) !== -1) {
                    _indicatorOpacity[k] = o;
                    st._cache = null; st._activeSet = null;
                    _scheduleRedraw(k, 50);
                }
            });
        },

        getOpacity: function (key) { return _indicatorOpacity[key] !== undefined ? _indicatorOpacity[key] : 1; },

        // ── Layer (candles / background) opacity API ──────────────
        //
        // setCandlesOpacity(val)
        //   val: 0.0 (invisible) .. 1.0 (fully opaque)
        //   Uses series.setChartStyleProperties(chartType, { transparency })
        //   transparency in TV = 0 (opaque) .. 100 (invisible) — inverse of 0..1 scale
        setCandlesOpacity: function (val) {
            val = Math.max(0, Math.min(1, parseFloat(val) || 1));
            var tvTransparency = Math.round((1 - val) * 100); // invert: 1.0 → 0, 0.0 → 100
            try {
                var c = window.app && window.app.widget && window.app.widget.activeChart();
                if (!c) { console.warn('[TVEngine] setCandlesOpacity: no active chart'); return; }
                var series = c.getSeries();
                if (!series || typeof series.setChartStyleProperties !== 'function') {
                    console.warn('[TVEngine] setCandlesOpacity: setChartStyleProperties not available');
                    return;
                }
                // chartType 1 = candlestick, 2 = bars, 3 = line, etc.
                // Read current props to preserve all other settings
                [1, 2, 3, 4, 8, 9, 10].forEach(function (chartType) {
                    try {
                        var props = series.chartStyleProperties(chartType);
                        if (props) {
                            props.transparency = tvTransparency;
                            series.setChartStyleProperties(chartType, props);
                        }
                    } catch (e) { }
                });
                console.log('[TVEngine] setCandlesOpacity:', val, '(transparency=' + tvTransparency + ')');
            } catch (e) { console.error('[TVEngine] setCandlesOpacity error:', e); }
        },

        // setBackgroundOpacity(val)
        //   Controls chart pane background color opacity
        //   val: 0.0 (transparent) .. 1.0 (opaque)
        //   Blends between transparent and the current background color
        setBackgroundOpacity: function (val) {
            val = Math.max(0, Math.min(1, parseFloat(val) || 1));
            try {
                var c = window.app && window.app.widget && window.app.widget.activeChart();
                if (!c) { console.warn('[TVEngine] setBackgroundOpacity: no active chart'); return; }
                // Read current background
                var isDark = true;
                try { isDark = localStorage.getItem('tradingview_theme') !== 'light'; } catch (e) { }
                var baseColor = isDark ? '13,17,28' : '255,255,255';
                var bgColor = 'rgba(' + baseColor + ',' + val.toFixed(2) + ')';
                c.applyOverrides({
                    'paneProperties.background': bgColor,
                    'paneProperties.backgroundType': 0,
                    'paneProperties.backgroundGradientStartColor': bgColor,
                    'paneProperties.backgroundGradientEndColor': bgColor,
                });
                console.log('[TVEngine] setBackgroundOpacity:', val, '→', bgColor);
            } catch (e) { console.error('[TVEngine] setBackgroundOpacity error:', e); }
        },

        // setLayerOpacity(layer, val) — convenience method
        //   layer: 'candles' | 'background' | 'indicators'
        //   val:   0.0..1.0
        setLayerOpacity: function (layer, val) {
            val = Math.max(0, Math.min(1, parseFloat(val) || 1));
            if (layer === 'candles') { window.TVEngine.setCandlesOpacity(val); return; }
            if (layer === 'background') { window.TVEngine.setBackgroundOpacity(val); return; }
            if (layer === 'indicators') { window.TVEngine.setOpacityAll(val); return; }
            console.warn('[TVEngine] setLayerOpacity: unknown layer "' + layer + '"');
        },
    };

    console.log('[TVEngine] v11.25 loaded');
})();