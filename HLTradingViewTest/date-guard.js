/**
 * date-guard.js
 * Блокирует даты ДО минимальной даты из window.app.activedata
 * в стандартном календаре TradingView.
 * Показывает toast при попытке выбрать недоступную дату.
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
    // TradingView рендерит пикер динамически; структура:
    //   div[class*="datepicker"] → td/div с data-value="YYYY-MM-DD"
    //   или span/div с textContent = день, и data-date на родителе.
    // Перебираем все найденные пикеры и дизейблим нужные ячейки.
    
    function processPicker(root) {
        const minDate = getMinDate();
        if (!minDate) return;
        if (root._dgDone) return;
        root._dgDone = true;
    
        const minDay = toDay(minDate);
    
        // Ищем все кликабельные ячейки дней
        // TV использует разные классы в зависимости от версии, поэтому ищем широко
        const cells = root.querySelectorAll(
            '[data-value], [data-date], [class*="cell"], [class*="Cell"], [class*="day"], [class*="Day"]'
        );
    
        cells.forEach(cell => {
            const dateStr = cell.dataset.value || cell.dataset.date || '';
            let cellDay = dateStr ? dateStr.slice(0, 10) : null;
    
            // Если data атрибута нет — пробуем aria-label
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
    
        // Перехватываем кнопку Apply / OK
        root.querySelectorAll('button').forEach(btn => {
            if (btn._dgHook) return;
            btn._dgHook = true;
            const txt = btn.textContent.toLowerCase();
            if (!txt.includes('apply') && !txt.includes('ok') && !txt.includes('go') && !txt.includes('set')) return;
    
            btn.addEventListener('click', e => {
                const minDate2 = getMinDate();
                if (!minDate2) return;
                const minDay2 = toDay(minDate2);
    
                // Ищем input поля с датами в ближайшем контейнере
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
                    toast(`⚠️ Нет данных ранее ${minDay2}. Выберите дату после неё.`);
                }
            }, true);
        });
    }
    
    function toDay(d) {
        return d.toISOString().slice(0, 10);
    }
    
    // ── MutationObserver ─────────────────────────────────────────────────────
    
    function isPicker(el) {
        if (!el || el.nodeType !== 1) return false;
        const cls = el.className || '';
        const dn  = el.dataset?.name || '';
        return /datepicker|DatePicker|date-picker|calendar|Calendar|dateRange|DateRange/i.test(cls + dn);
    }
    
    function scanAndProcess(node) {
        if (isPicker(node)) { processPicker(node); return; }
        node.querySelectorAll?.('[class*="datepicker"],[class*="DatePicker"],[class*="calendar"],[class*="Calendar"],[class*="dateRange"]')
            .forEach(el => processPicker(el));
    }
    
    function startObserver() {
        const obs = new MutationObserver(muts => {
            for (const m of muts) {
                m.addedNodes.forEach(n => scanAndProcess(n));
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