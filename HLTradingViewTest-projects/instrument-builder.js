/**
 * InstrumentBuilder v2
 * Поддерживает два режима:
 *   - 'pinejs'     : код работает через PineJS.Std.* API (как раньше)
 *   - 'javascript' : чистый JS, данные из window.app.activedata
 */
class InstrumentBuilder {

    build(script) {
        const mode      = script.execution_mode || 'javascript'; // дефолт — чистый JS
        const isOverlay = script.is_overlay !== false;
        const schema    = Array.isArray(script.inputs_schema)  ? script.inputs_schema  : [];
        const outputs   = Array.isArray(script.outputs_schema) ? script.outputs_schema : [];
        const id        = `${script.system_name}@tv-basicstudies-1`;

        const plots = outputs.length > 0
            ? outputs.map((o, i) => ({ id: `plot_${i}`, type: o.plot_type || 'line' }))
            : [{ id: 'plot_0', type: 'line' }];

        const styles        = this._buildStyles(plots, outputs);
        const defaultStyles = this._buildDefaultStyles(plots, outputs);
        const defaultInputs = Object.fromEntries(schema.map(i => [i.id, i.defval]));
        const inputs        = this._buildInputsMeta(schema);

        const constructorFn = mode === 'pinejs'
            ? this._buildPineJSConstructor(script, schema, outputs)
            : this._buildJSConstructor(script, schema, outputs);

        return {
            name: script.display_name,
            metainfo: {
                _metainfoVersion: 53,
                id,
                scriptIdPart:      script.system_name,
                description:       script.description || script.display_name,
                shortDescription:  (script.display_name || '').substring(0, 24),
                is_price_study:    isOverlay,
                isCustomIndicator: true,
                format: { type: isOverlay ? 'price' : 'volume', precision: 4 },
                inputs,
                plots,
                styles,
                defaults: { inputs: defaultInputs, styles: defaultStyles, precision: 4 },
            },
            constructor: constructorFn,
        };
    }

    // ─────────────────────────────────────────────────────────────
    // РЕЖИМ 1: PineJS  (оригинальный режим)
    // ─────────────────────────────────────────────────────────────
    _buildPineJSConstructor(script, schema, outputs) {
        const inputExtractors = schema
            .map((inp, i) => `var ${inp.id} = inputCallback(${i});`)
            .join('\n');

        const userCode = script.code || '';

        return function() {
            return new Function('PineJS', `
                return {
                    main: function(ctx, inputCallback) {
                        this._context = ctx;
                        ${inputExtractors}
                        var _result = (function(ctx, PineJS) {
                            ${userCode}
                        })(ctx, PineJS);
                        if (Array.isArray(_result)) return _result;
                        if (_result !== undefined) return [_result];
                        return [NaN];
                    }
                };
            `)(PineJS);
        };
    }

    // ─────────────────────────────────────────────────────────────
    // РЕЖИМ 2: Чистый JavaScript
    //
    // Как работает:
    //   TradingView вызывает main(ctx, inputCallback) на каждом баре.
    //   ctx._context.symbol.time — timestamp текущего бара (unix seconds).
    //   Мы находим этот бар в window.app.activedata по timestamp,
    //   передаём пользователю удобный объект { bars, bar, index, inputs },
    //   пользователь возвращает число или массив чисел.
    //
    // Пользовательский код имеет доступ к:
    //   bar     — текущий бар { time, open, high, low, close, volume, ...custom }
    //   bars    — весь массив баров (для расчёта индикаторов вручную)
    //   index   — индекс текущего бара в массиве
    //   inputs  — объект с параметрами { length: 20, mult: 2.0, ... }
    //   history(arr, n) — хелпер: вернуть arr[index - n] безопасно
    //   sma(arr, period) — простая SMA до текущего index
    //   ema(arr, period) — EMA до текущего index
    //   stdev(arr, period) — стандартное отклонение
    //   highest(arr, period) — максимум за N баров
    //   lowest(arr, period) — минимум за N баров
    // ─────────────────────────────────────────────────────────────
    _buildJSConstructor(script, schema, outputs) {
        const inputExtractors = schema
            .map((inp, i) => `var ${inp.id} = inputCallback(${i});`)
            .join('\n');

        const userCode = script.code || '';

        return function() {
            // Кеш вычислений (живёт пока индикатор на графике)
            const _cache = {};

            return {
                main: function(ctx, inputCallback) {
                    this._context = ctx;

                    // ── Получаем параметры из диалога Settings
                    const inputs = {};
                    schema.forEach((inp, i) => {
                        inputs[inp.id] = inputCallback(i);
                    });

                    // ── Находим текущий бар в activedata
                    const activedata = window.app?.activedata;
                    if (!activedata || activedata.length === 0) return [NaN];

                    // TradingView передаёт время в секундах
                    const currentTimeSec = ctx.symbol.time;
                    const currentTimeMs  = currentTimeSec * 1000;

                    // Бинарный поиск по timestamp
                    let index = InstrumentBuilder._findBarIndex(activedata, currentTimeMs);
                    if (index === -1) return [NaN];

                    const bar  = activedata[index];
                    const bars = activedata;

                    // ── Хелперы (закрыты над bars и index)
                    function history(field, n) {
                        const i = index - (n || 0);
                        if (i < 0 || i >= bars.length) return NaN;
                        const v = typeof field === 'string' ? bars[i][field] : field[i];
                        return v !== undefined ? parseFloat(v) : NaN;
                    }

                    function _series(field) {
                        // Возвращает числовой массив значений поля до текущего бара включительно
                        return bars.slice(0, index + 1).map(b =>
                            parseFloat(typeof field === 'string' ? b[field] : field) || 0
                        );
                    }

                    function sma(field, period) {
                        const arr = _series(field);
                        if (arr.length < period) return NaN;
                        const slice = arr.slice(-period);
                        return slice.reduce((a, b) => a + b, 0) / period;
                    }

                    function ema(field, period) {
                        const arr    = _series(field);
                        const k      = 2 / (period + 1);
                        let   result = arr[0];
                        for (let i = 1; i < arr.length; i++) {
                            result = arr[i] * k + result * (1 - k);
                        }
                        return result;
                    }

                    function stdev(field, period) {
                        const arr = _series(field);
                        if (arr.length < period) return NaN;
                        const slice = arr.slice(-period);
                        const mean  = slice.reduce((a, b) => a + b, 0) / period;
                        const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
                        return Math.sqrt(variance);
                    }

                    function highest(field, period) {
                        const arr = _series(field);
                        if (arr.length < 1) return NaN;
                        const slice = arr.slice(-period);
                        return Math.max(...slice);
                    }

                    function lowest(field, period) {
                        const arr = _series(field);
                        if (arr.length < 1) return NaN;
                        const slice = arr.slice(-period);
                        return Math.min(...slice);
                    }

                    // ── Запускаем пользовательский код
                    try {
                        const _result = (new Function(
                            'bar', 'bars', 'index', 'inputs',
                            'history', 'sma', 'ema', 'stdev', 'highest', 'lowest',
                            '_cache',
                            `"use strict";\n${userCode}`
                        ))(
                            bar, bars, index, inputs,
                            history, sma, ema, stdev, highest, lowest,
                            _cache
                        );

                        if (Array.isArray(_result)) return _result;
                        if (_result !== undefined && !isNaN(_result)) return [_result];
                        return [NaN];
                    } catch (e) {
                        // Тихо — чтобы не спамить консоль на каждом баре
                        return [NaN];
                    }
                }
            };
        };
    }

    // Бинарный поиск бара по времени (activedata отсортирован по timestamp asc)
    static _findBarIndex(bars, targetMs) {
        let lo = 0, hi = bars.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const t   = new Date(bars[mid].timestamp).getTime();
            if (Math.abs(t - targetMs) < 500) return mid; // допуск 500мс
            if (t < targetMs) lo = mid + 1;
            else              hi = mid - 1;
        }
        // fallback — ближайший
        if (lo >= bars.length) return bars.length - 1;
        return lo;
    }

    // ─────────────────────────────────────────────────────────────
    // Вспомогательные методы (без изменений)
    // ─────────────────────────────────────────────────────────────
    _buildInputsMeta(schema) {
        return schema.map(inp => {
            const base = { id: inp.id, name: inp.name, defval: inp.defval, type: this._tvInputType(inp.type) };
            if (inp.min  !== undefined) base.min  = inp.min;
            if (inp.max  !== undefined) base.max  = inp.max;
            if (inp.step !== undefined) base.step = inp.step;
            if (inp.type === 'select' && inp.options) base.options = inp.options;
            return base;
        });
    }

    _buildStyles(plots, outputs) {
        const s = {};
        plots.forEach((p, i) => { s[p.id] = { title: outputs[i]?.name || `Plot ${i}`, histogramBase: 0 }; });
        return s;
    }

    _buildDefaultStyles(plots, outputs) {
        const s = {};
        plots.forEach((p, i) => {
            s[p.id] = {
                linestyle:    0,
                linewidth:    outputs[i]?.linewidth || 2,
                plottype:     this._plotType(outputs[i]?.plot_type),
                trackPrice:   false,
                transparency: outputs[i]?.transparency || 0,
                visible:      true,
                color:        outputs[i]?.color || '#2962FF',
            };
        });
        return s;
    }

    _tvInputType(t) {
        return { integer: 'integer', float: 'float', string: 'text',
                 color: 'color', source: 'source', bool: 'bool', select: 'text' }[t] || 'text';
    }

    _plotType(t) {
        return { line: 0, histogram: 5, cross: 3, area: 2, columns: 5 }[t] || 0;
    }
}

window.instrumentBuilder = new InstrumentBuilder();