/**
 * bar-detail-popup.js — Long-press on candle → OHLCV popup
 * Mimics tradingview.com behavior: hold LMB ~0.7s → floating tooltip
 */
(function () {
    'use strict';

    var LONG_PRESS_MS  = 700;   // hold duration before showing
    var MOVE_THRESHOLD = 6;     // px — cancel if mouse moves
    var _timer         = null;
    var _currentBar    = null;  // bar under crosshair
    var _popup         = null;
    var _startX        = 0;
    var _startY        = 0;
    var _hooked        = false;

    /* ── helpers ─────────────────────────────────────────── */

    function _getTheme() {
        try { return localStorage.getItem('tradingview_theme') || 'dark'; }
        catch (e) { return 'dark'; }
    }

    function _fmt(v) {
        if (v === null || v === undefined || v === '') return '—';
        return parseFloat(Number(v).toFixed(5)).toString();
    }

    function _fmtVol(v) {
        var n = Number(v);
        if (!isFinite(n)) return '—';
        if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
        return n.toLocaleString();
    }

    /** Find bar in activedata closest to given Unix-seconds timestamp */
    function _findBar(tsSec) {
        var data = window.app && window.app.activedata;
        if (!data || !data.length) return null;
        var tsMs = tsSec * 1000;

        // Binary search (data sorted by timestamp ascending)
        var lo = 0, hi = data.length - 1, mid, best = null, bestDiff = Infinity;
        while (lo <= hi) {
            mid = (lo + hi) >> 1;
            var barTs = new Date(data[mid].timestamp).getTime();
            var diff  = Math.abs(barTs - tsMs);
            if (diff < bestDiff) { bestDiff = diff; best = data[mid]; }
            if (barTs < tsMs)      lo = mid + 1;
            else if (barTs > tsMs) hi = mid - 1;
            else break;
        }
        return best;
    }

    /* ── popup ───────────────────────────────────────────── */

    function _showPopup(bar, x, y) {
        _hidePopup();
        if (!bar) return;

        var isDark = _getTheme() !== 'light';

        var bg     = isDark ? '#1e222d' : '#ffffff';
        var bdr    = isDark ? '#363a45' : '#e0e3eb';
        var txt    = isDark ? '#d1d4dc' : '#131722';
        var lbl    = '#787b86';
        var green  = isDark ? '#26a69a' : '#089981';
        var red    = isDark ? '#ef5350' : '#f23645';

        var o = Number(bar.open),  h = Number(bar.high);
        var l = Number(bar.low),   c = Number(bar.close);
        var change  = o ? ((c - o) / o * 100) : 0;
        var isUp    = c >= o;
        var chgCol  = isUp ? green : red;
        var chgSign = change >= 0 ? '+' : '';

        var ts   = new Date(bar.timestamp);
        var _tz = 'America/New_York';
        var date = ts.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: _tz });
        var time = ts.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: _tz });

        var el = document.createElement('div');
        el.id  = 'bar-detail-popup';
        el.style.cssText =
            'position:fixed;z-index:99999;padding:12px 16px;border-radius:6px;' +
            'background:' + bg + ';border:1px solid ' + bdr + ';' +
            'box-shadow:0 4px 16px rgba(0,0,0,' + (isDark ? '0.5' : '0.15') + ');' +
            'font-family:-apple-system,BlinkMacSystemFont,Trebuchet MS,Roboto,Ubuntu,sans-serif;' +
            'font-size:13px;line-height:1.5;color:' + txt + ';pointer-events:none;min-width:170px;' +
            'opacity:0;transition:opacity .12s ease;';

        var rows = [];
        rows.push('<div style="color:' + lbl + ';font-size:16px;margin-bottom:6px;letter-spacing:.3px">' + date + '  ' + time + '</div>');

        var fields = [
            ['O', _fmt(o)],
            ['H', _fmt(h)],
            ['L', _fmt(l)],
            ['C', _fmt(c)]
        ];
        if (bar.volume !== undefined && bar.volume !== null && Number(bar.volume) > 0) {
            fields.push(['Vol', _fmtVol(bar.volume)]);
        }

        for (var i = 0; i < fields.length; i++) {
            rows.push(
                '<div style="display:flex;justify-content:space-between;gap:24px;padding:1px 0">' +
                '<span style="color:' + lbl + '">' + fields[i][0] + '</span>' +
                '<span style="font-variant-numeric:tabular-nums">' + fields[i][1] + '</span></div>'
            );
        }

        rows.push(
            '<div style="display:flex;justify-content:space-between;gap:24px;margin-top:6px;padding-top:6px;' +
            'border-top:1px solid ' + bdr + '">' +
            '<span style="color:' + lbl + '">Chg</span>' +
            '<span style="color:' + chgCol + ';font-weight:600;font-variant-numeric:tabular-nums">' +
            chgSign + change.toFixed(2) + '%</span></div>'
        );

        el.innerHTML = rows.join('');
        document.body.appendChild(el);

        // position: right of cursor, fallback left
        var pw   = el.offsetWidth,  ph = el.offsetHeight;
        var left = x + 18;
        var top  = y - ph / 2;
        if (left + pw > window.innerWidth  - 10) left = x - pw - 18;
        if (top < 10)                             top  = 10;
        if (top + ph > window.innerHeight - 10)   top  = window.innerHeight - ph - 10;
        el.style.left = left + 'px';
        el.style.top  = top  + 'px';

        // fade in
        requestAnimationFrame(function () {
            requestAnimationFrame(function () { el.style.opacity = '1'; });
        });

        _popup = el;
    }

    function _hidePopup() {
        var p = _popup || document.getElementById('bar-detail-popup');
        if (p) p.remove();
        _popup = null;
    }

    /* ── event handlers ──────────────────────────────────── */

    function _cancelTimer() {
        if (_timer) { clearTimeout(_timer); _timer = null; }
    }

    function _onDown(e) {
        if (e.button !== 0) return;              // LMB only
        _startX = e.clientX;
        _startY = e.clientY;
        _cancelTimer();

        // translate iframe coords to main doc coords
        var offX = 0, offY = 0;
        if (e.view !== window) {
            var iframes = document.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
                try {
                    if (iframes[i].contentWindow === e.view) {
                        var r = iframes[i].getBoundingClientRect();
                        offX = r.left;
                        offY = r.top;
                        break;
                    }
                } catch (_) {}
            }
        }
        var absX = e.clientX + offX;
        var absY = e.clientY + offY;

        _timer = setTimeout(function () {
            _timer = null;
            if (_currentBar) _showPopup(_currentBar, absX, absY);
        }, LONG_PRESS_MS);
    }

    function _onUp() {
        _cancelTimer();
        if (_popup) setTimeout(_hidePopup, 80);
    }

    function _onMove(e) {
        if (!_timer) return;
        var dx = e.clientX - _startX;
        var dy = e.clientY - _startY;
        if (dx * dx + dy * dy > MOVE_THRESHOLD * MOVE_THRESHOLD) _cancelTimer();
    }

    function _onKey(e) {
        if (e.key === 'Escape') _hidePopup();
    }

    /* ── crosshair hook ──────────────────────────────────── */

    function _hookCrosshair(chart) {
        function handler(p) {
            if (p && p.time) _currentBar = _findBar(p.time);
        }
        // TV v29 uses crossHairMoved (capital H), some builds use lowercase
        try { chart.crossHairMoved().subscribe(null, handler); return; } catch (_) {}
        try { chart.crosshairMoved().subscribe(null, handler); }        catch (_) {}
    }

    /* ── attach to a document ────────────────────────────── */

    function _attach(doc) {
        // target only the chart pane area (canvas container)
        var target = doc.querySelector('.chart-markup-table') ||
                     doc.querySelector('[class*="chart-gui-wrapper"]') ||
                     doc;

        target.addEventListener('mousedown', _onDown, true);
        doc.addEventListener('mouseup',   _onUp,   true);
        doc.addEventListener('mousemove', _onMove,  true);
        doc.addEventListener('keydown',   _onKey,   true);
    }

    /* ── init ────────────────────────────────────────────── */

    function _init() {
        if (_hooked) return;
        var w = window.app && window.app.widget;
        if (!w) { setTimeout(_init, 500); return; }

        w.onChartReady(function () {
            if (_hooked) return;
            _hooked = true;

            _hookCrosshair(w.activeChart());

            // main document
            _attach(document);

            // TV renders inside iframe — attach there too
            var iframes = document.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
                try {
                    var iDoc = iframes[i].contentDocument;
                    if (iDoc && iDoc.querySelector('canvas')) _attach(iDoc);
                } catch (_) {}
            }

            // watch for future iframes (TV lazy-loads some)
            var obs = new MutationObserver(function (muts) {
                for (var m = 0; m < muts.length; m++) {
                    for (var n = 0; n < muts[m].addedNodes.length; n++) {
                        var node = muts[m].addedNodes[n];
                        if (node.tagName === 'IFRAME') {
                            try {
                                node.addEventListener('load', function () {
                                    try {
                                        var d = this.contentDocument;
                                        if (d && d.querySelector('canvas')) _attach(d);
                                    } catch (_) {}
                                });
                            } catch (_) {}
                        }
                    }
                }
            });
            obs.observe(document.getElementById('tv_chart_container') || document.body,
                        { childList: true, subtree: true });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _init);
    } else {
        _init();
    }
})();
