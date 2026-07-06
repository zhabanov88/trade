

(function () {
    'use strict';

    // ════════════════════════════════════════════════════════════════════════
    // РЕЕСТР СКРИПТОВ СЕССИИ
    // ════════════════════════════════════════════════════════════════════════

    /**
     * window.sessionScripts — Map<runId, { code, name, registeredAt, enabled }>
     * Публичный API для управления из консоли:
     *   sessionScripts.list()   — список всех скриптов
     *   sessionScripts.remove(id) — убрать скрипт из авто-повтора
     *   sessionScripts.enable(id) / .disable(id)
     *   sessionScripts.rerunAll() — принудительный перезапуск всех
     */
    const _registry = new Map();  // runId → entry
    let _runCounter = 0;

    window.sessionScripts = {
        _registry,

        /** Зарегистрировать новый скрипт (вызывается из code-panel после eval) */
        register(code, name) {
            const id = ++_runCounter;
            _registry.set(id, {
                id,
                code,
                name: name || `Script #${id}`,
                registeredAt: Date.now(),
                enabled: true,
            });
            console.log(`[SSR] ✅ Registered "${name || 'Script #' + id}" as run #${id}`);
            return id;
        },

        /** Удалить скрипт из авто-повтора */
        remove(id) {
            _registry.delete(id);
            console.log(`[SSR] 🗑 Removed script #${id}`);
        },

        /** Включить / отключить без удаления */
        enable(id)  { if (_registry.has(id)) { _registry.get(id).enabled = true;  console.log(`[SSR] ▶ Enabled  #${id}`); } },
        disable(id) { if (_registry.has(id)) { _registry.get(id).enabled = false; console.log(`[SSR] ⏸ Disabled #${id}`); } },

        /** Вывести список в консоль */
        list() {
            console.table([..._registry.values()].map(e => ({
                id: e.id,
                name: e.name,
                enabled: e.enabled,
                codeLen: e.code.length,
                registered: new Date(e.registeredAt).toLocaleTimeString(),
            })));
        },

        /** Принудительный перезапуск всех */
        rerunAll() {
            _scheduleRerun('manual');
        },
    };

    // ════════════════════════════════════════════════════════════════════════
    // ПЕРЕХВАТ РЕГИСТРАЦИИ СКРИПТОВ ИЗ CODE PANEL
    // ════════════════════════════════════════════════════════════════════════
    // Ждём загрузки code-panel и патчим runJavaScript

    function _patchCodePanel() {
        // Поддерживаем оба варианта: codePanelManager и CodePanelManagerEnhanced
        const mgr = window.codePanelManager || window.codePanelManagerEnhanced;
        if (!mgr) return false;
        if (mgr._ssrPatched) return true;

        const _origRun = mgr.runJavaScript.bind(mgr);

        mgr.runJavaScript = async function (...args) {
            // Получаем код до запуска
            const editor = document.getElementById('jsEditor');
            const code = editor ? editor.value.trim() : '';

            // Сохраняем runId ПЕРЕД eval, чтобы скрипт мог использовать его
            const pendingId = _runCounter + 1;
            window._currentRunId = pendingId;

            // Выполняем оригинальный метод
            await _origRun(...args);

            // Если выполнение прошло успешно — регистрируем
            if (code) {
                const name = mgr._currentJsSystemName || `Script #${pendingId}`;
                window.sessionScripts.register(code, name);
            }
        };

        mgr._ssrPatched = true;
        console.log('[SSR] ✅ CodePanelManager.runJavaScript patched');
        return true;
    }

    // ════════════════════════════════════════════════════════════════════════
    // ПЕРЕХВАТ appendActiveData В DATAFEED
    // ════════════════════════════════════════════════════════════════════════

    function _patchDatafeed(datafeed) {
        if (!datafeed || datafeed._ssrPatched) return;

        const _origAppend = datafeed.appendActiveData.bind(datafeed);

        datafeed.appendActiveData = function (newData) {
            _origAppend(newData);
            if (newData && newData.length > 0) {
                _scheduleRerun('appendActiveData', newData.length);
            }
        };

        datafeed._ssrPatched = true;
        console.log('[SSR] ✅ datafeed.appendActiveData patched');
    }

    // ════════════════════════════════════════════════════════════════════════
    // DEBOUNCED RERUN
    // ════════════════════════════════════════════════════════════════════════

    let _rerunTimer = null;
    const RERUN_DELAY_MS = 400; // ждём завершения серии getBars

    function _scheduleRerun(reason, barsCount) {
        if (_registry.size === 0) return;
        if (_rerunTimer) clearTimeout(_rerunTimer);
        console.log(`[SSR] ⏳ Rerun scheduled (reason: ${reason}, newBars: ${barsCount ?? '?'})`);
        _rerunTimer = setTimeout(() => {
            _rerunTimer = null;
            _rerunAllScripts();
        }, RERUN_DELAY_MS);
    }

    // ════════════════════════════════════════════════════════════════════════
    // ИСПОЛНЕНИЕ СКРИПТОВ
    // ════════════════════════════════════════════════════════════════════════

    async function _rerunAllScripts() {
        const enabled = [..._registry.values()].filter(e => e.enabled);
        if (enabled.length === 0) return;

        if (!window.app?.widget) {
            console.warn('[SSR] Widget not ready, skip rerun');
            return;
        }

        console.group(`[SSR] 🔄 Rerunning ${enabled.length} script(s) on ${window.app.activedata?.length ?? 0} bars`);

        // Устанавливаем глобальные переменные как делает code-panel
        window.chart  = window.app.widget.activeChart();
        window.widget = window.app.widget;

        for (const entry of enabled) {
            await _runSingle(entry);
        }

        console.groupEnd();
    }

    async function _runSingle(entry) {
        console.log(`[SSR]   ▶ Running "${entry.name}" (#${entry.id})`);

        // Cleanup предыдущих drawings этого скрипта
        _cleanup(entry.id);

        // Устанавливаем currentRunId чтобы скрипт мог зарегистрировать cleanup
        window._currentRunId = entry.id;

        try {
            // eslint-disable-next-line no-eval
            const result = eval(entry.code);
            if (result && typeof result.then === 'function') {
                await result;
            }
            console.log(`[SSR]   ✅ "${entry.name}" done`);
        } catch (err) {
            console.error(`[SSR]   ❌ "${entry.name}" error:`, err.message);
        }
    }

    function _cleanup(id) {
        const cleanups = window._scriptCleanup;
        if (cleanups && typeof cleanups[id] === 'function') {
            try {
                cleanups[id]();
                console.log(`[SSR]   🧹 Cleanup called for #${id}`);
            } catch (e) {
                console.warn(`[SSR]   ⚠️ Cleanup error for #${id}:`, e.message);
            }
            delete cleanups[id];
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // АВТОМАТИЧЕСКИЙ CLEANUP SHAPES/DRAWINGS ДЛЯ СКРИПТОВ БЕЗ РУЧНОГО CLEANUP
    // (опциональный вспомогательный хелпер для скриптов FVG и аналогичных)
    // ════════════════════════════════════════════════════════════════════════

    /**
     * window.ssrTrackShape(shapeId)
     *
     * Скрипт вызывает эту функцию после каждого chart.createShape() /
     * chart.createMultipointShape(), передавая возвращённый id.
     * При следующем реране SSR автоматически удалит все зарегистрированные
     * shapes этого скрипта перед повторным выполнением.
     *
     * Пример использования в скрипте FVG:
     *   const shapeId = chart.createMultipointShape(...);
     *   window.ssrTrackShape(shapeId);
     */
    window._ssrShapes = window._ssrShapes || {};  // runId → shapeId[]

    window.ssrTrackShape = function (shapeId) {
        const id = window._currentRunId;
        if (id == null) return;
        if (!window._ssrShapes[id]) window._ssrShapes[id] = [];
        window._ssrShapes[id].push(shapeId);
    };

    // Расширяем cleanup: удаляем shapes перед каждым рераном
    const _origCleanup = _cleanup;
    // (переопределяем через замыкание — _cleanup уже используется выше,
    //  поэтому патчим через расширение registry)

    // Патчим _runSingle чтобы удалять shapes
    const __runSingle = _runSingle;
    // Мы не можем переопределить замкнутую функцию снаружи, но можем
    // добавить хук через _scriptCleanup при первом запуске:
    // — shapes удаляются в _cleanupShapes, вызываемой из расширенного cleanup

    function _cleanupShapes(id) {
        const chart = window.app?.widget?.activeChart?.();
        if (!chart) return;
        const shapes = window._ssrShapes[id];
        if (!shapes || shapes.length === 0) return;
        let removed = 0;
        for (const sid of shapes) {
            try {
                chart.removeEntity(sid);
                removed++;
            } catch (_) { /* shape уже удалена */ }
        }
        window._ssrShapes[id] = [];
        if (removed > 0) console.log(`[SSR]   🧹 Removed ${removed} shapes for #${id}`);
    }

    // Переопределяем _rerunAllScripts чтобы вызывать cleanupShapes
    // (в замкнутом scope это делается через патч _runSingle)

    // Вместо того чтобы перезаписывать закрытую функцию,
    // регистрируем авто-cleanup через _scriptCleanup при каждом реране:
    const _origRerunAll = window.sessionScripts.rerunAll.bind(window.sessionScripts);
    window.sessionScripts.rerunAll = async function () {
        // Перед каждым реруном — удаляем shapes
        for (const id of _registry.keys()) {
            _cleanupShapes(id);
        }
        await _rerunAllScripts();
    };

    // Также патчим _scheduleRerun чтобы shapes удалялись автоматически
    const _origSchedule = _scheduleRerun;

    // Перекрываем внутреннюю логику — добавляем cleanupShapes в тело rerun
    // Поскольку _rerunAllScripts — закрытая функция, оборачиваем через
    // переназначение ссылки на глобальный символ (самый надёжный способ):
    window._ssrInternalRerun = async function () {
        const enabled = [..._registry.values()].filter(e => e.enabled);
        if (enabled.length === 0) return;

        if (!window.app?.widget) {
            console.warn('[SSR] Widget not ready, skip rerun');
            return;
        }

        console.group(`[SSR] 🔄 Rerunning ${enabled.length} script(s) on ${window.app.activedata?.length ?? 0} bars`);

        window.chart  = window.app.widget.activeChart();
        window.widget = window.app.widget;

        for (const entry of enabled) {
            // Cleanup shapes
            _cleanupShapes(entry.id);
            // Cleanup callbacks
            _cleanup(entry.id);

            window._currentRunId = entry.id;

            console.log(`[SSR]   ▶ Running "${entry.name}" (#${entry.id})`);
            try {
                const result = eval(entry.code);  // eslint-disable-line no-eval
                if (result && typeof result.then === 'function') await result;
                console.log(`[SSR]   ✅ "${entry.name}" done`);
            } catch (err) {
                console.error(`[SSR]   ❌ "${entry.name}" error:`, err.message);
            }
        }

        console.groupEnd();
    };

    // ════════════════════════════════════════════════════════════════════════
    // POLLING: ждём datafeed и code-panel
    // ════════════════════════════════════════════════════════════════════════

    let _pollCount = 0;
    const _poll = setInterval(() => {
        _pollCount++;

        // Патчим code-panel
        _patchCodePanel();

        // Патчим datafeed
        const df = window.app?.datafeed;
        if (df && !df._ssrPatched) {
            // Переопределяем внутренний _scheduleRerun чтобы вызывал _ssrInternalRerun
            _patchDatafeed(df);

            // Переопределяем appendActiveData чтобы debounce вызывал _ssrInternalRerun
            const _origAppend2 = df.appendActiveData.bind(df);
            df.appendActiveData = function (newData) {
                _origAppend2(newData);
                if (newData && newData.length > 0 && _registry.size > 0) {
                    if (_rerunTimer) clearTimeout(_rerunTimer);
                    console.log(`[SSR] ⏳ New ${newData.length} bars — rerun in ${RERUN_DELAY_MS}ms`);
                    _rerunTimer = setTimeout(() => {
                        _rerunTimer = null;
                        window._ssrInternalRerun();
                    }, RERUN_DELAY_MS);
                }
            };
            df._ssrPatched = true;
        }

        // Останавливаем poll если всё подключено или прошло 30 сек
        const panelOk = !!(window.codePanelManager?._ssrPatched || window.codePanelManagerEnhanced?._ssrPatched);
        if ((panelOk && df?._ssrPatched) || _pollCount > 60) {
            clearInterval(_poll);
            if (_pollCount > 60) console.warn('[SSR] ⚠️ Polling timeout — some patches may be missing');
            else console.log('[SSR] ✅ All patches applied, polling stopped');
        }
    }, 500);

    // ════════════════════════════════════════════════════════════════════════
    // ЭКСПОРТ / ПОДСКАЗКА
    // ════════════════════════════════════════════════════════════════════════

    console.log(`
[SSR] 📦 Session Script Runner loaded.
  sessionScripts.list()        — список скриптов сессии
  sessionScripts.remove(id)    — убрать из авто-повтора
  sessionScripts.disable(id)   — временно выключить
  sessionScripts.enable(id)    — включить обратно
  sessionScripts.rerunAll()    — принудительный перезапуск

  В вашем скрипте для авто-cleanup drawings:
    window.ssrTrackShape(chart.createShape(...));
    window.ssrTrackShape(chart.createMultipointShape(...));
`);

})();