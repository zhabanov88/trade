/**
 * activedata-persist.js  v5
 *
 * Отвечает ТОЛЬКО за одно: сохранять window.app.activedata в localStorage
 * каждые 2 секунды. Восстановление теперь делает сам datafeed-integrated-v3.js
 * (после правок в конструкторе и initActiveData).
 *
 * Подключать ПЕРВЫМ скриптом в index.html — до всех остальных.
 *
 * Публичный API (в консоли браузера):
 *   activedataPersist.status()  — показать состояние
 *   activedataPersist.save()    — принудительно сохранить прямо сейчас
 *   activedataPersist.clear()   — удалить кэш из localStorage
 */
(function () {
    'use strict';

    const LS_KEY        = 'activedata';
    const SAVE_INTERVAL = 2000; // мс между сохранениями

    // ─────────────────────────────────────────────────────────────────────────
    // localStorage helpers
    // ─────────────────────────────────────────────────────────────────────────

    function lsSave(data) {
        try {
            localStorage.setItem(LS_KEY, JSON.stringify(data));
        } catch (e) {
            console.warn('[ActivedataPersist] localStorage write failed:', e.message);
        }
    }

    function lsLoad() {
        try {
            const raw = localStorage.getItem(LS_KEY);
            if (!raw) return null;
            const arr = JSON.parse(raw);
            return Array.isArray(arr) && arr.length > 0 ? arr : null;
        } catch (_) {
            return null;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Шаг 1: положить кэш в window.app.activedata КАК МОЖНО РАНЬШЕ,
    // до того как конструктор DatabaseIntegratedDatafeed запустится.
    //
    // Конструктор делает:
    //   if (!Array.isArray(window.app.activedata)) window.app.activedata = [];
    // Значит если мы успели поставить массив — он его не тронет.
    // ─────────────────────────────────────────────────────────────────────────

    const cached = lsLoad();

    if (cached) {
        if (!window.app) window.app = {};
        window.app.activedata = cached;
        console.log('[ActivedataPersist] ✓ pre-loaded', cached.length,
                    'bars into window.app.activedata before datafeed init');
        if (cached[0]) {
            console.log('[ActivedataPersist]   sample keys:', Object.keys(cached[0]).join(', '));
        }
    } else {
        console.log('[ActivedataPersist] no cache in localStorage');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Шаг 2: запустить save loop как только datafeed готов
    //
    // Почему ждём datafeed, а не просто сразу?
    // Потому что datafeed.initialize() вызывается асинхронно и в конце делает
    // window.app.datafeed = this — это наш сигнал что инициализация завершена
    // и activedata больше не будет сброшен конструктором.
    // ─────────────────────────────────────────────────────────────────────────

    let _saveTimer   = null;
    let _lastSavedAt = 0;

    function startSaveLoop() {
        if (_saveTimer) return;
        _saveTimer = setInterval(() => {
            const ad = window.app?.activedata;
            if (!Array.isArray(ad) || ad.length === 0) return;

            // Сохраняем всегда — каждые SAVE_INTERVAL мс.
            // Это единственный надёжный способ поймать мутации объектов внутри
            // массива (например row.Donchian_Channel = {...}), которые прокси
            // через Object.defineProperty не видит.
            lsSave(ad);
            _lastSavedAt = Date.now();
        }, SAVE_INTERVAL);

        console.log('[ActivedataPersist] ✓ save loop started (interval:', SAVE_INTERVAL, 'ms)');
    }

    const _waitTimer = setInterval(() => {
        if (!window.app?.datafeed) return;
        clearInterval(_waitTimer);
        startSaveLoop();
        console.log('[ActivedataPersist] datafeed ready — save loop attached');
    }, 50);

    // ─────────────────────────────────────────────────────────────────────────
    // Публичный API
    // ─────────────────────────────────────────────────────────────────────────

    window.activedataPersist = {

        /** Принудительно сохранить прямо сейчас */
        save() {
            const ad = window.app?.activedata;
            if (Array.isArray(ad) && ad.length > 0) {
                lsSave(ad);
                console.log('[ActivedataPersist] manual save:', ad.length, 'bars');
            } else {
                console.warn('[ActivedataPersist] activedata пуст — нечего сохранять');
            }
        },

        /** Прочитать кэш из localStorage (не применяя) */
        load() {
            return lsLoad();
        },

        /** Удалить кэш из localStorage */
        clear() {
            localStorage.removeItem(LS_KEY);
            console.log('[ActivedataPersist] cache cleared');
        },

        /** Показать текущее состояние */
        status() {
            const c  = lsLoad();
            const ad = window.app?.activedata;

            console.log('──────── ActivedataPersist status ────────');
            console.log('localStorage bars  :', c?.length  ?? 0);
            console.log('activedata bars    :', ad?.length ?? 0);
            console.log('save loop running  :', !!_saveTimer);
            console.log('datafeed present   :', !!window.app?.datafeed);
            console.log('last saved         :',
                _lastSavedAt ? new Date(_lastSavedAt).toLocaleTimeString() : 'never');

            if (ad?.[0]) {
                console.log('live sample keys   :', Object.keys(ad[0]).join(', '));
            }
            if (c?.[0]) {
                console.log('cache sample keys  :', Object.keys(c[0]).join(', '));
            }
            console.log('──────────────────────────────────────────');
        },
    };

    console.log('[ActivedataPersist] v5 loaded');

})();