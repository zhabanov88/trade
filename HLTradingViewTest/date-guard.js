/**
 * date-guard.js
 * Блокирует даты ДО минимальной даты из window.app.activedata
 * в стандартном календаре TradingView.
 * Показывает toast при попытке выбрать недоступную дату.
 *
 * v2: добавлен перехват "Go to date" для тик-таймфрейма (1T/1t).
 * При нажатии "Go to" на тиках вместо пошагового движения назад —
 * мгновенная телепортация через datafeed.gotoTick() + chart.resetData().
 */
if (window._dgLoaded) {} else { window._dgLoaded = true; (function () {
    'use strict';

    // ── Получаем минимальную дату ─────────────────────────────────────────────

    function getMinDate() {
        const d = window.app?.activedata;
        if (!d?.length) return null;
        let min = Infinity;
        d.forEach(r => { const t = new Date(r.timestamp).getTime(); if (t < min) min = t; });
        return min === Infinity ? null : new Date(min);
    }

    // ── Toast ─────────────────────────────────────────────────────────────────

    function toast(msg) {
        let el = document.getElementById('dg-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'dg-toast';
            el.style.cssText = [
                'position:fixed','bottom:70px','left:50%',
                'transform:translateX(-50%) translateY(8px)',
                'z-index:100000','max-width:440px','text-align:center',
                'padding:10px 20px','border-radius:6px',
                'background:#3a1010','border-left:3px solid #ef5350',
                'color:#fff','font-size:13px',
                'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
                'box-shadow:0 4px 20px rgba(0,0,0,.6)',
                'transition:opacity .25s,transform .25s','opacity:0','pointer-events:none'
            ].join(';');
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.style.opacity = '1';
        el.style.transform = 'translateX(-50%) translateY(0)';
        clearTimeout(el._t);
        el._t = setTimeout(() => {
            el.style.opacity = '0';
            el.style.transform = 'translateX(-50%) translateY(8px)';
        }, 5000);
    }

    // ── CSS для заблокированных ячеек ─────────────────────────────────────────

    function injectCSS() {
        if (document.getElementById('dg-css')) return;
        const s = document.createElement('style');
        s.id = 'dg-css';
        s.textContent = `
    .dg-off {
        opacity: .28 !important;
        pointer-events: none !important;
        cursor: not-allowed !important;
        text-decoration: line-through !important;
        color: #555 !important;
    }`;
        document.head.appendChild(s);
    }

    // ── Обработка пикера ─────────────────────────────────────────────────────

    function toDay(d) {
        return d.toISOString().slice(0, 10);
    }

    function isPicker(el) {
        if (!el || el.nodeType !== 1) return false;
        const cls = el.className || '';
        const dn  = el.dataset?.name || '';
        return /datepicker|DatePicker|date-picker|calendar|Calendar|dateRange|DateRange/i.test(cls + dn);
    }

    function isGoToDialog(el) {
        if (!el || el.nodeType !== 1) return false;
        const cls = el.className || '';
        const txt = el.textContent || '';
        // Ищем диалог "Go to" по классу или содержимому
        return /go.?to|GoTo|goto/i.test(cls) ||
               (txt.includes('Go to') && el.querySelector('button'));
    }

    function scanAndProcess(node) {
        // Обычный date picker
        if (isPicker(node)) { processPicker(node); return; }
        node.querySelectorAll?.('[class*="datepicker"],[class*="DatePicker"],[class*="calendar"],[class*="Calendar"],[class*="dateRange"]')
            .forEach(el => processPicker(el));

        // Диалог "Go to"
        if (isGoToDialog(node)) { processGoToDialog(node); return; }
        // Ищем диалог внутри добавленного узла
        node.querySelectorAll?.('[class*="dialog"],[class*="Dialog"],[class*="popup"],[class*="Popup"]')
            .forEach(el => { if (isGoToDialog(el)) processGoToDialog(el); });
    }

    // ── Перехват диалога "Go to" для тик-таймфрейма ──────────────────────────

    function processGoToDialog(root) {
        if (root._dgGotoDone) return;
        root._dgGotoDone = true;

        // Ищем кнопку "Go to" — она имеет именно такой текст
        root.querySelectorAll('button').forEach(btn => {
            if (btn._dgGoToHook) return;
            const txt = btn.textContent.trim().toLowerCase();
            // Точное совпадение с "Go to" или содержит только "go to"
            if (txt !== 'go to' && !txt.match(/^go\s+to$/i)) return;

            btn._dgGoToHook = true;

            // capture=true — перехватываем ДО того как TV обработает клик
            btn.addEventListener('click', handleGoToClick, true);
            console.log('[date-guard] "Go to" button hooked in dialog');
        });
    }

    function handleGoToClick(e) {
        try {
            // Проверяем что текущий таймфрейм — тики
            const resolution = window.app?.widget?.activeChart?.()?.resolution?.();
            const isTick = resolution === '1T' || resolution === '1t';
            if (!isTick) return; // для не-тиков — обычное поведение TV

            const datafeed = window.app?.datafeed;
            if (!datafeed?.gotoTick) return;

            // Читаем выбранную дату и время из инпутов диалога
            const dialog = e.target.closest('[class*="dialog"],[class*="Dialog"],[class*="popup"],[class*="Popup"]')
                        || e.target.closest('[class*="wrapper"],[class*="Wrapper"]')
                        || document.body;

            const targetTs = readGoToTimestamp(dialog);
            if (!targetTs) {
                console.warn('[date-guard] Could not read target date from dialog');
                return;
            }

            console.log(`[date-guard] 🎯 Tick goto intercept: ${new Date(targetTs * 1000).toISOString()}`);

            // Останавливаем TV от обработки клика
            e.preventDefault();
            e.stopImmediatePropagation();

            // Устанавливаем целевую дату в datafeed
            datafeed.gotoTick(targetTs);

            // Закрываем диалог
            setTimeout(() => {
                try {
                    // Ищем кнопку закрытия диалога
                    const closeBtn = dialog.querySelector('[data-name="close"],[class*="close"],[class*="Close"]');
                    if (closeBtn) {
                        closeBtn.click();
                    } else {
                        // Escape
                        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
                    }
                } catch(_) {}
            }, 10);

            // Сбрасываем TV — принудительный firstDataRequest с новой точкой старта
            setTimeout(() => {
                try {
                    window.app.widget.activeChart().resetData();
                    console.log('[date-guard] ✅ resetData() called — loading ticks from target date');
                } catch(err) {
                    console.warn('[date-guard] resetData failed:', err.message);
                    // Fallback: пробуем через setResolution (пересоздаёт серию)
                    try {
                        const chart = window.app.widget.activeChart();
                        const res = chart.resolution();
                        chart.setResolution(res);
                    } catch(_) {}
                }
            }, 50);

        } catch(err) {
            console.warn('[date-guard] handleGoToClick error:', err);
        }
    }

    /**
     * Читает timestamp из полей ввода диалога "Go to".
     * TV показывает дату ("Thu 11 Sep '25") и время ("00:00") в отдельных элементах.
     * Возвращает Unix timestamp в секундах или null.
     */
    function readGoToTimestamp(dialog) {
        // Способ 1: ищем input[type=text] или input без type с датой/временем
        const inputs = [...dialog.querySelectorAll('input')];

        let dateStr = null;
        let timeStr = '00:00';

        for (const inp of inputs) {
            const val = inp.value?.trim();
            if (!val) continue;

            // Проверяем формат времени HH:MM
            if (/^\d{1,2}:\d{2}$/.test(val)) {
                timeStr = val;
                continue;
            }

            // Пробуем распарсить как дату
            const d = new Date(val);
            if (!isNaN(d.getTime())) {
                dateStr = val;
                continue;
            }

            // Формат TV: "Thu 11 Sep '25" или "11 Sep 2025"
            const tvDate = parseTVDateString(val);
            if (tvDate) { dateStr = tvDate; continue; }
        }

        if (!dateStr) {
            // Способ 2: ищем текстовые элементы с датой (TV рендерит как span/div)
            const textEls = dialog.querySelectorAll('[class*="date"],[class*="Date"],[class*="input"],[class*="Input"]');
            for (const el of textEls) {
                const txt = el.textContent?.trim() || el.value?.trim() || '';
                if (!txt) continue;
                const tvDate = parseTVDateString(txt);
                if (tvDate) { dateStr = tvDate; break; }
            }
        }

        if (!dateStr) return null;

        // Собираем дату+время и конвертируем в UTC timestamp
        try {
            const [h, m] = timeStr.split(':').map(Number);
            const d = new Date(dateStr + 'T00:00:00Z');
            if (isNaN(d.getTime())) return null;
            d.setUTCHours(h || 0, m || 0, 0, 0);
            return Math.floor(d.getTime() / 1000);
        } catch(_) {
            return null;
        }
    }

    /**
     * Парсит строки вида:
     *   "Thu 11 Sep '25" → "2025-09-11"
     *   "11 Sep 2025"    → "2025-09-11"
     *   "2025-09-11"     → "2025-09-11"
     */
    function parseTVDateString(str) {
        if (!str) return null;
        str = str.trim();

        // Уже ISO
        if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

        const months = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };

        // "Thu 11 Sep '25" или "11 Sep '25" или "11 Sep 2025"
        const m = str.match(/(\d{1,2})\s+([A-Za-z]{3})\s+'?(\d{2,4})/);
        if (m) {
            const day   = m[1].padStart(2, '0');
            const month = months[m[2].toLowerCase()];
            const year  = m[3].length === 2 ? '20' + m[3] : m[3];
            if (month) return `${year}-${String(month).padStart(2, '0')}-${day}`;
        }

        // Пробуем через Date
        const d = new Date(str);
        if (!isNaN(d.getTime())) {
            return d.toISOString().slice(0, 10);
        }

        return null;
    }

    function processPicker(root) {
        const minDate = getMinDate();
        if (!minDate) return;
        if (root._dgDone) return;
        root._dgDone = true;

        const minDay = toDay(minDate);

        // Ищем все кликабельные ячейки дней
        const cells = root.querySelectorAll(
            '[data-value], [data-date], [class*="cell"], [class*="Cell"], [class*="day"], [class*="Day"]'
        );

        cells.forEach(cell => {
            const dateStr = cell.dataset.value || cell.dataset.date || '';
            let cellDay = dateStr ? dateStr.slice(0, 10) : null;

            if (!cellDay) {
                const al = cell.getAttribute('aria-label');
                if (al) { const d = new Date(al); if (!isNaN(d)) cellDay = toDay(d); }
            }

            if (!cellDay) return;
            if (cellDay < minDay) {
                cell.classList.add('dg-off');
                cell.title = `Нет данных до ${minDay}`;
            }
        });

        // Перехватываем кнопку Apply / OK (для обычных date picker)
        root.querySelectorAll('button').forEach(btn => {
            if (btn._dgHook) return;
            btn._dgHook = true;
            const txt = btn.textContent.toLowerCase();
            if (!txt.includes('apply') && !txt.includes('ok') && !txt.includes('go') && !txt.includes('set')) return;

            btn.addEventListener('click', e => {
                const minDate2 = getMinDate();
                if (!minDate2) return;
                const minDay2 = toDay(minDate2);

                const inputs = (root.closest('[class*="dialog"],[class*="Dialog"],[class*="popup"],[class*="Popup"]') || root)
                    .querySelectorAll('input');

                let blocked = false;
                inputs.forEach(inp => {
                    if (!inp.value) return;
                    const d = new Date(inp.value);
                    if (!isNaN(d.getTime()) && toDay(d) < minDay2) blocked = true;
                });

                if (blocked) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    toast(`⚠️ Нет данных ранее ${minDay2}.`);
                }
            }, true);
        });
    }

    // ── MutationObserver ─────────────────────────────────────────────────────

    function startObserver() {
        const obs = new MutationObserver(muts => {
            for (const m of muts) {
                m.addedNodes.forEach(n => {
                    if (n.nodeType !== 1) return;
                    scanAndProcess(n);
                    // Также смотрим вглубь — TV иногда добавляет вложенные контейнеры
                    n.querySelectorAll?.('button').forEach(btn => {
                        const txt = btn.textContent.trim().toLowerCase();
                        if (txt.match(/^go\s+to$/i) && !btn._dgGoToHook) {
                            const dialog = btn.closest('[class*="dialog"],[class*="Dialog"],[class*="popup"],[class*="Popup"]');
                            if (dialog) processGoToDialog(dialog);
                        }
                    });
                });
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    // ── Перехват setVisibleRange виджета ─────────────────────────────────────

    function hookWidget() {
        const w = window.app?.widget;
        if (!w) return false;
        w.onChartReady(() => {
            const chart = w.activeChart();
            const orig = chart.setVisibleRange?.bind(chart);
            if (!orig) return;
            chart.setVisibleRange = function(range, ...args) {
                const minDate = getMinDate();
                if (minDate && range.from) {
                    const fromMs = (range.from < 1e10 ? range.from * 1000 : range.from);
                    if (fromMs < minDate.getTime()) {
                        toast(`⚠️ Нет данных ранее ${toDay(minDate)}.`);
                        range = { ...range, from: Math.floor(minDate.getTime() / 1000) };
                    }
                }
                return orig(range, ...args);
            };
            console.log('[date-guard] setVisibleRange hooked');
        });
        return true;
    }

    // ── Start ─────────────────────────────────────────────────────────────────

    function start() {
        injectCSS();
        startObserver();
        let n = 0;
        const t = setInterval(() => {
            if (++n > 100) clearInterval(t);
            if (hookWidget()) clearInterval(t);
        }, 300);
        console.log('[date-guard] started');
    }

    window.dateGuard = { getMinDate, toast };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();

    })(); }