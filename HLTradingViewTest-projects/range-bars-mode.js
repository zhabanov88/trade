/*
 * range-bars-mode.js — additive, default-OFF integration layer that renders
 * SYNTHESIZED range bars in the (trimmed) charting library, which cannot render
 * native Range/Renko/Kagi/PnF/LineBreak.
 *
 * v2 (per user spec):
 *   - Range bars are built from RAW TICKS only (never from time-based candles).
 *     The getBars pipeline is intercepted: while enabled, we fetch raw trades
 *     from /api/market-data/ticks over the requested [from,to] window and run the
 *     proven RangeBars.fromTicks transform (range-bars.js). Candle-derived bars are
 *     used ONLY as a clearly-degraded fallback when ticks are unavailable.
 *   - Box size X is expressed in TICKS (minimum price step). Default 10, presets
 *     5/10/15/20/25/30/40/60/80/100, clamped to configurable [minX,maxX] (default 5..100).
 *   - Render style: candles (default) or bars.
 *   - Each range bar shows its cumulative volume delta as a label ABOVE bullish
 *     bars / BELOW bearish bars (bull/bear per RangeBars.classifySide). Delta uses
 *     the tick rule: +volume on an uptick, -volume on a downtick, unchanged price
 *     carries the previous direction; per-bar sum.
 *
 * It monkey-patches ONE datafeed INSTANCE (getBars/subscribeBars/unsubscribeBars);
 * production datafeed source + charting library are untouched. Selecting "Range" in
 * the chart-type dropdown flips it on; any other type flips it off.
 *
 * Public: window.RangeBarMode.install(datafeed), .initUI(widget),
 *         .enable(opts), .disable(), .setXTicks(n), .setRenderStyle(s), .setLimits(min,max)
 */
(function (root, factory) {
    var mod = factory();
    if (typeof window !== 'undefined') window.RangeBarMode = mod;
    else if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
  
    var LS_KEY = 'rbm_settings_v2';
    var DEFAULT_X = 10;
    var DEFAULT_MIN = 5;
    var DEFAULT_MAX = 100;
    var PRESETS = [5, 10, 15, 20, 25, 30, 40, 60, 80, 100];
  
    function clampInt(v, lo, hi, dflt) {
      var n = parseInt(v, 10);
      if (!isFinite(n)) n = dflt;
      if (n < lo) n = lo;
      if (n > hi) n = hi;
      return n;
    }
  
    function loadState() {
      var d = { enabled: false, xTicks: DEFAULT_X, renderStyle: 'candles', minX: DEFAULT_MIN, maxX: DEFAULT_MAX, showDelta: true, panelOpen: true };
      try {
        var raw = localStorage.getItem(LS_KEY);
        if (raw) {
          var p = JSON.parse(raw);
          if (typeof p.enabled === 'boolean') d.enabled = p.enabled;
          if (p.renderStyle === 'bars' || p.renderStyle === 'candles') d.renderStyle = p.renderStyle;
          if (typeof p.showDelta === 'boolean') d.showDelta = p.showDelta;
          if (typeof p.panelOpen === 'boolean') d.panelOpen = p.panelOpen;
          var mn = parseInt(p.minX, 10); if (isFinite(mn) && mn >= 1) d.minX = mn;
          var mx = parseInt(p.maxX, 10); if (isFinite(mx) && mx >= d.minX) d.maxX = mx;
          var xt = parseInt(p.xTicks, 10); if (isFinite(xt)) d.xTicks = xt;
        }
      } catch (e) {}
      // enforce ordering + bounds
      if (d.maxX < d.minX) d.maxX = d.minX;
      d.xTicks = clampInt(d.xTicks, d.minX, d.maxX, DEFAULT_X);
      return d;
    }
  
    var M = {
      available: true,
      datafeed: null,
      widget: null,
      presets: PRESETS,
      state: loadState(),
  
      _minTickCache: {},   // symKey -> effective minTick (price)
      _formingSeed: {},    // symKey -> seed bar for realtime
      _rtState: (typeof Map !== 'undefined') ? new Map() : null,
      _resetCbs: {},       // subscriberUID -> onResetCacheNeededCallback (drop lib bar cache on refresh)
      _lastBars: {},       // symKey -> last full range-bar array (for delta labels)
      _lastSymKey: '_',
      _labelIds: [],
      _labelTimer: null,
      _labelHooked: false,
      _ui: null,
      _reopen: null,
  
      get enabled() { return !!this.state.enabled; },
  
      _persist: function () {
        try { localStorage.setItem(LS_KEY, JSON.stringify(this.state)); } catch (e) {}
      },
  
      _clearRuntime: function () {
        this._minTickCache = {};
        this._formingSeed = {};
        this._lastBars = {};
        if (this._rtState) this._rtState.clear();
      },
  
      _symKey: function (s) {
        if (!s) return '_';
        return s.clickhouse_ticker || s.ticker || s.name || s.full_name || '_';
      },
  
      _ticker: function (s) {
        if (s && s.clickhouse_ticker) return s.clickhouse_ticker;
        var name = (s && (s.name || s.full_name)) || 'BTC';
        return 'C:' + String(name).replace(/[:]/g, '') + '-USD';
      },
  
      _symMinTick: function (s) {
        if (s && typeof s.minmov === 'number' && typeof s.pricescale === 'number' && s.pricescale > 0) {
          return s.minmov / s.pricescale;
        }
        return 0;
      },
  
      // Effective min price step: prefer symbolInfo; else infer from tick data; else 0.01% of price.
      _effectiveMinTick: function (symbolInfo, ticks) {
        var key = this._symKey(symbolInfo);
        if (this._minTickCache[key] > 0) return this._minTickCache[key];
        var mt = this._symMinTick(symbolInfo);
        if (!(mt > 0) && ticks && ticks.length > 1) {
          var minDiff = Infinity, last = null;
          for (var i = 0; i < ticks.length; i++) {
            var p = ticks[i] && ticks[i].price;
            if (typeof p !== 'number' || !isFinite(p)) continue;
            if (last != null) {
              var d = Math.abs(p - last);
              if (d > 0 && d < minDiff) minDiff = d;
            }
            last = p;
          }
          if (isFinite(minDiff) && minDiff > 0) mt = minDiff;
        }
        if (!(mt > 0)) {
          var ref = (ticks && ticks.length) ? ticks[ticks.length - 1].price : 100;
          mt = (isFinite(ref) && ref > 0 ? ref : 100) * 0.0001;
        }
        if (mt > 0) this._minTickCache[key] = mt;
        return mt;
      },
  
      _xTicksClamped: function () {
        return clampInt(this.state.xTicks, this.state.minX, this.state.maxX, DEFAULT_X);
      },
  
      _resolveXPrice: function (symbolInfo, ticks) {
        var mt = this._effectiveMinTick(symbolInfo, ticks);
        var X = this._xTicksClamped() * mt;
        var _lastPrice = (ticks && ticks.length) ? ticks[ticks.length - 1].price : 0;
        if (_lastPrice > 0 && X < _lastPrice * 5e-5 && ticks && ticks.length > 1) {
          var _minDiff = Infinity, _prev = null;
          for (var _i = 0; _i < ticks.length; _i++) { var _p = ticks[_i] && ticks[_i].price; if (typeof _p !== "number" || !isFinite(_p)) continue; if (_prev != null) { var _d = Math.abs(_p - _prev); if (_d > 0 && _d < _minDiff) _minDiff = _d; } _prev = _p; }
          if (isFinite(_minDiff) && _minDiff > mt) { mt = _minDiff; this._minTickCache[this._symKey(symbolInfo)] = mt; X = this._xTicksClamped() * mt; }
        }
        try { console.log("[RBM] resolveX", { sym: this._symKey(symbolInfo), minTick: mt, X: X, xTicks: this._xTicksClamped(), lastPrice: _lastPrice, ticks: (ticks && ticks.length) || 0 }); } catch (e) {}
        return X;
      },
  
      _parseTs: function (ts) {
        if (typeof ts === 'number' && isFinite(ts)) return ts < 1e12 ? ts * 1000 : ts;
        if (typeof ts === 'string') {
          var m = ts.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
          if (m) {
            var ms = 0;
            if (m[7]) { var f = (m[7] + '000').slice(0, 3); ms = parseInt(f, 10) || 0; }
            return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
          }
          var d = Date.parse(ts);
          if (isFinite(d)) return d;
        }
        return NaN;
      },
  
      _fetchTicks: function (symbolInfo, fromSec, toSec) {
      var self = this;
      return self._fetchTicksWindow(symbolInfo, fromSec, toSec).then(function (ticks) {
        if (ticks && ticks.length) return ticks;
        // Tick-only: requested window has no ticks (e.g. chart asks for 'now' but the
        // dataset ends earlier) -> fall back to the latest AVAILABLE ticks so range mode
        // always shows the most recent real ticks. Never candle-derived.
        return self._fetchLatestTicks(symbolInfo);
      });
    },
    _fetchLatestTicks: function (symbolInfo) {
      var self = this;
      var ticker = this._ticker(symbolInfo);
      return fetch('/api/market-data/ticks/latest?ticker=' + encodeURIComponent(ticker), { credentials: 'include' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (obj) {
          var lt = obj && (obj.latest_timestamp || obj.latestTimestamp);
          if (!lt) return [];
          var ms = self._parseTs(lt);
          if (!isFinite(ms)) return [];
          var latestSec = Math.floor(ms / 1000);
          return self._fetchTicksWindow(symbolInfo, latestSec - 3600, latestSec);
        }).catch(function () { return []; });
    },
    _navigateToBars: function (bars) {
      try {
        if (!bars || !bars.length || !this.widget || typeof this.widget.activeChart !== 'function') return;
        var chart = this.widget.activeChart();
        if (!chart || typeof chart.setVisibleRange !== 'function') return;
        var fromSec = Math.floor(bars[0].time / 1000);
        var toSec = Math.ceil(bars[bars.length - 1].time / 1000);
        if (!(toSec > fromSec)) return;
        chart.setVisibleRange({ from: fromSec, to: toSec });
      } catch (e) {}
    },
    _fetchTicksWindow: function (symbolInfo, fromSec, toSec) {
        var self = this;
        var ticker = this._ticker(symbolInfo);
        var url = '/api/market-data/ticks?ticker=' + encodeURIComponent(ticker) +
          '&table=forex_quotes&from=' + Math.floor(fromSec) + '&to=' + Math.floor(toSec);
        return fetch(url, { credentials: 'include' }).then(function (r) {
          if (!r.ok) throw new Error('ticks http ' + r.status);
          return r.json();
        }).then(function (rows) {
          var arr = Array.isArray(rows) ? rows : (rows && (rows.data || rows.ticks)) || [];
          var ticks = [];
          for (var i = 0; i < arr.length; i++) {
            var row = arr[i];
            if (!row) continue;
            var price = (typeof row.price === 'number') ? row.price
              : (typeof row.close === 'number') ? row.close
                : parseFloat(row.price != null ? row.price : row.close);
            if (typeof price !== 'number' || !isFinite(price)) continue;
            var tms = self._parseTs(row.participant_timestamp != null ? row.participant_timestamp : (row.timestamp != null ? row.timestamp : row.time));
            if (!isFinite(tms)) tms = i;
            var vol = (typeof row.volume === 'number') ? row.volume : (parseFloat(row.volume) || 0);
            ticks.push({ time: tms, price: price, volume: vol });
          }
          ticks.sort(function (a, b) { return a.time - b.time; });
          return ticks;
        });
      },
  
      // Resolve the newest available tick time (epoch seconds), so range mode anchors to the real
      // data-end instead of the browser wall-clock (the dataset may end in the past/future of 'now').
      _fetchDataEndSec: function (symbolInfo) {
        var self = this;
        var ticker = this._ticker(symbolInfo);
        return fetch('/api/market-data/ticks/latest?ticker=' + encodeURIComponent(ticker), { credentials: 'include' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (obj) {
            var lt = obj && (obj.latest_timestamp || obj.latestTimestamp);
            if (!lt) return NaN;
            var ms = self._parseTs(lt);
            return isFinite(ms) ? Math.floor(ms / 1000) : NaN;
          }).catch(function () { return NaN; });
      },
  
      // Truncation-defeating covering fetch. The ticks endpoint is ASC + LIMIT 200000, i.e. it returns
      // the OLDEST 200k rows of a window and SILENTLY DROPS the newest. A single wide/dense window thus
      // leaves a coverage hole near its tail; concatenating such chunks produced the giant seam bar.
      // Walk FORWARD: whenever a sub-window returns the full cap, advance the cursor past its last tick
      // and refetch (skipping only the boundary-overlap duplicates) until a sub-window comes back short
      // (= full contiguous coverage up to 'toSec').
      _fetchCovering: function (symbolInfo, fromSec, toSec) {
        var self = this;
        var CAP = 200000;      // MUST match the server-side LIMIT
        var MAX_ITERS = 40;    // hard guard against pathological loops
        var acc = [];
        function step(cur, iter) {
          if (iter > MAX_ITERS || cur > toSec) return Promise.resolve(acc);
          return self._fetchTicksWindow(symbolInfo, cur, toSec).then(function (ticks) {
            if (!ticks || !ticks.length) return acc;
            var startIdx = 0;
            if (acc.length) {
              var boundaryMs = acc[acc.length - 1].time;
              while (startIdx < ticks.length && ticks[startIdx].time <= boundaryMs) startIdx++;
            }
            for (var i = startIdx; i < ticks.length; i++) acc.push(ticks[i]);
            if (ticks.length >= CAP) {
              var nextSec = Math.floor(ticks[ticks.length - 1].time / 1000);
              if (nextSec <= cur) nextSec = cur + 1;
              return step(nextSec, iter + 1);
            }
            return acc;
          });
        }
        return step(Math.floor(fromSec), 0);
      },
  
      // Range-mode history loader. Ignores TV's wall-clock [from,to]; anchors to the real data-end,
      // pulls a contiguous truncation-free recent slice, keeps the most-recent MAX_TICKS, and builds
      // ALL range bars in ONE fromTicks pass -> no cross-chunk seams, ever.
      _loadRangeHistory: function (symbolInfo) {
        var self = this;
        var WINDOW_SEC = 14 * 3600;   // ~one session + overnight back from data-end
        var MAX_TICKS = 150000;       // bound browser load; keep the newest contiguous ticks
        return self._fetchDataEndSec(symbolInfo).then(function (endSec) {
          if (!isFinite(endSec)) return { bars: [], X: 0 };
          return self._fetchCovering(symbolInfo, endSec - WINDOW_SEC, endSec).then(function (ticks) {
            if (!ticks || !ticks.length) return { bars: [], X: 0 };
            if (ticks.length > MAX_TICKS) ticks = ticks.slice(ticks.length - MAX_TICKS);
            var X = self._resolveXPrice(symbolInfo, ticks);
            var bars = window.RangeBars.fromTicks(ticks, {
              boxSize: X, unit: 'price', minTick: self._effectiveMinTick(symbolInfo, ticks),
              emitForming: true, maxBars: 100000
            });
            return { bars: bars, X: X };
          });
        }).catch(function () { return { bars: [], X: 0 }; });
      },
  
      // Map a TV resolution string -> seconds. Bare number = minutes; trailing S=seconds, D=days, W=weeks.
      _resolutionToSec: function (resolution) {
        var r = String(resolution == null ? '1' : resolution).trim().toUpperCase();
        var n = parseInt(r, 10);
        if (!(n > 0)) n = 1;
        if (/S$/.test(r)) return n;          // seconds
        if (/D$/.test(r)) return n * 86400;  // days
        if (/W$/.test(r)) return n * 604800; // weeks
        return n * 60;                        // minutes (default, incl. '1', '60')
      },
  
      // Range bars are causal & sub-minute: at a 1-min resolution TV OHLC-MERGES the multiple range
      // bars that fall inside the same minute -> taller, uneven candles (proven: 32/108 minutes held
      // >=2 bars, heights 2.5..7). Remap each bar onto its OWN resolution slot (base + i*resSec) so
      // exactly one range bar occupies one slot -> TV cannot merge -> uniform <=X heights survive.
      // OHLC/volume/delta untouched; the real open time is preserved as .realTime for tooltips.
      _gridRemap: function (bars, resolution) {
        if (!bars || !bars.length) return bars;
        var resMs = this._resolutionToSec(resolution) * 1000;
        if (!(resMs > 0)) return bars;
        var base = Math.floor(bars[0].time / resMs) * resMs;
        var out = new Array(bars.length);
        for (var i = 0; i < bars.length; i++) {
          var b = bars[i];
          out[i] = {
            time: base + i * resMs,
            open: b.open, high: b.high, low: b.low, close: b.close,
            volume: b.volume, delta: b.delta, realTime: b.time
          };
          if (b.forming) out[i].forming = true;
        }
        return out;
      },
  
      _storeBars: function (symbolInfo, bars, firstReq, X) {
        var key = this._symKey(symbolInfo);
        this._lastSymKey = key;
        if (firstReq || !this._lastBars[key]) {
          this._lastBars[key] = bars.slice();
        } else {
          // prepend older window (scroll-back), dropping any duplicate forming bar
          var older = bars.filter(function (b) { return !b.forming; });
          this._lastBars[key] = older.concat(this._lastBars[key]);
        }
        if (firstReq && bars.length) {
          var last = bars[bars.length - 1];
          var seed = last.forming
            ? { open: last.open, high: last.high, low: last.low, close: last.close, delta: last.delta, volume: last.volume, time: last.time, X: X }
            : { open: last.close, high: last.close, low: last.close, close: last.close, delta: 0, volume: 0, time: last.time, X: X };
          this._formingSeed[key] = seed;
        }
      },
  
      // Degraded fallback ONLY (candle intrabar path is approximate — never preferred).
      _transformFromCandles: function (bars, symbolInfo, periodParams) {
        var X = this._resolveXPrice(symbolInfo, null);
        var firstReq = !!(periodParams && periodParams.firstDataRequest);
        var out = window.RangeBars.fromCandles(bars, {
          boxSize: X, unit: 'price', minTick: this._effectiveMinTick(symbolInfo, null), emitForming: firstReq
        });
        this._storeBars(symbolInfo, out, firstReq, X);
        return out;
      },
  
      _seedRealtime: function (uid, symbolInfo, price, incomingTime) {
        var seed = this._formingSeed[this._symKey(symbolInfo)];
        var X = (seed && seed.X > 0) ? seed.X : this._resolveXPrice(symbolInfo, [{ price: price }]);
        var seedBar = seed ? { open: seed.open, high: seed.high, low: seed.low, close: seed.close, volume: seed.volume, delta: seed.delta } : null;
        var st = window.RangeBars.newRangeState(X, price, seedBar);
        var rt = { st: st, formingTime: (seed && typeof seed.time === 'number') ? seed.time : incomingTime };
        if (this._rtState) this._rtState.set(uid, rt);
        return rt;
      },
  
      // Realtime is BEST-EFFORT: the datafeed's realtime poll delivers OHLC candles,
      // so we drive the reducer with candle close+volume. Precise realtime needs the
      // live tick feed (documented).
      _handleRealtime: function (uid, symbolInfo, candleBar, cb) {
        if (!candleBar || typeof candleBar.close !== 'number' || !isFinite(candleBar.close)) return cb(candleBar);
        var price = candleBar.close;
        var incomingTime = (typeof candleBar.time === 'number' && isFinite(candleBar.time)) ? candleBar.time : Date.now();
        var vol = (typeof candleBar.volume === 'number') ? candleBar.volume : 0;
  
        var rt = this._rtState ? this._rtState.get(uid) : null;
        if (!rt) rt = this._seedRealtime(uid, symbolInfo, price, incomingTime);
  
        var res = window.RangeBars.rangeStep(rt.st, price, vol);
  
        if (res.completed.length) {
          var t = rt.formingTime;
          var first = res.completed[0];
          cb({ time: t, open: first.open, high: first.high, low: first.low, close: first.close, volume: first.volume });
          for (var i = 1; i < res.completed.length; i++) {
            t = Math.max(t + 1, incomingTime + i);
            var c = res.completed[i];
            cb({ time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
          }
          var ft = Math.max(t + 1, incomingTime);
          cb({ time: ft, open: res.forming.open, high: res.forming.high, low: res.forming.low, close: res.forming.close, volume: res.forming.volume });
          rt.formingTime = ft;
        } else {
          cb({ time: rt.formingTime, open: res.forming.open, high: res.forming.high, low: res.forming.low, close: res.forming.close, volume: res.forming.volume });
        }
        this._scheduleLabels();
      },
  
      install: function (datafeed) {
        if (!datafeed || datafeed.__rangeBarsPatched) return;
        if (typeof datafeed.getBars !== 'function') return;
        datafeed.__rangeBarsPatched = true;
        this.datafeed = datafeed;
        var self = this;
  
        var origGetBars = datafeed.getBars.bind(datafeed);
        datafeed.getBars = function (symbolInfo, resolution, periodParams, onHistoryCallback, onErrorCallback) {
          // Синтетический символ бэктеста ('<TICKER>__BT') — своя статичная
          // серия, RangeBarMode её никогда не трогает, даже если включён.
          if (!self.enabled || !window.RangeBars || (symbolInfo && symbolInfo.is_bt_static)) {
            return origGetBars(symbolInfo, resolution, periodParams, onHistoryCallback, onErrorCallback);
          }
          var handled = false;
          function candleFallback() {
            if (handled) return; handled = true;
            origGetBars(symbolInfo, resolution, periodParams, function (bars, meta) {
              var out = bars;
              if (bars && bars.length) {
                try { out = self._transformFromCandles(bars, symbolInfo, periodParams); }
                catch (e) { out = bars; }
              }
              onHistoryCallback(out, meta);
              self._scheduleLabels();
            }, onErrorCallback);
          }
          var from = periodParams && periodParams.from;
          var to = periodParams && periodParams.to;
          if (!(typeof from === 'number' && typeof to === 'number')) { onHistoryCallback([], { noData: true }); return; }
          var firstReq = !!(periodParams && periodParams.firstDataRequest);
          if (!firstReq) {
            // Bounded history: all bars are built in a single pass on the first request, so there is
            // no contiguous older window to append here. Returning noData avoids stitching independent
            // fromTicks chunks (the source of the giant seam bar).
            handled = true; onHistoryCallback([], { noData: true }); return;
          }
          self._loadRangeHistory(symbolInfo).then(function (res) {
            if (handled) return;
            handled = true;
            if (!res || !res.bars || !res.bars.length) { onHistoryCallback([], { noData: true }); return; }
            var display = self._gridRemap(res.bars, resolution);
            self._storeBars(symbolInfo, display, true, res.X);
            onHistoryCallback(display, { noData: false });
            self._navigateToBars(display);
            self._scheduleLabels();
          }).catch(function () { if (handled) return; handled = true; onHistoryCallback([], { noData: true }); });
        };
  
        if (typeof datafeed.subscribeBars === 'function') {
          var origSub = datafeed.subscribeBars.bind(datafeed);
          datafeed.subscribeBars = function (symbolInfo, resolution, onRealtimeCallback, subscriberUID, onResetCacheNeededCallback) {
            if (self._rtState) self._rtState.set(subscriberUID, null);
            if (onResetCacheNeededCallback) self._resetCbs[subscriberUID] = onResetCacheNeededCallback;
            var wrapped = function (bar) {
              if (self.enabled && window.RangeBars) {
                try { return self._handleRealtime(subscriberUID, symbolInfo, bar, onRealtimeCallback); }
                catch (e) { return onRealtimeCallback(bar); }
              }
              return onRealtimeCallback(bar);
            };
            return origSub(symbolInfo, resolution, wrapped, subscriberUID, onResetCacheNeededCallback);
          };
        }
  
        if (typeof datafeed.unsubscribeBars === 'function') {
          var origUnsub = datafeed.unsubscribeBars.bind(datafeed);
          datafeed.unsubscribeBars = function (subscriberUID) {
            if (self._rtState) self._rtState.delete(subscriberUID);
            if (self._resetCbs) delete self._resetCbs[subscriberUID];
            return origUnsub(subscriberUID);
          };
        }
      },
  
      _applyRenderStyle: function () {
        try {
          if (!this.widget || typeof this.widget.activeChart !== 'function') return;
          var chart = this.widget.activeChart();
          if (!chart || typeof chart.setChartType !== 'function') return;
          chart.setChartType(this.state.renderStyle === 'bars' ? 0 : 1);
        } catch (e) {}
      },
  
      _refresh: function () {
        try {
          // Drop the library's cached bars FIRST; otherwise resetData() reuses stale
          // candles and never re-invokes the wrapped getBars (canonical TradingView pattern).
          var rc = this._resetCbs || {};
          for (var uid in rc) { if (rc.hasOwnProperty(uid)) { try { rc[uid](); } catch (e) {} } }
        } catch (e) {}
        try {
          if (this.widget && typeof this.widget.activeChart === 'function') {
            var chart = this.widget.activeChart();
            if (chart && typeof chart.resetData === 'function') chart.resetData();
            // resetData() alone does NOT re-request history in this trimmed build, so force a
            // hard reload that reliably re-invokes getBars (proven necessary via QA probe).
            if (chart && typeof chart.setResolution === 'function' && typeof chart.resolution === 'function') {
              try { chart.setResolution(chart.resolution(), function () {}); } catch (e2) {}
            }
          }
        } catch (e) {}
        this._scheduleLabels();
      },
  
      enable: function (opts) {
        if (opts && typeof opts === 'object') {
          if (opts.renderStyle === 'bars' || opts.renderStyle === 'candles') this.state.renderStyle = opts.renderStyle;
          if (opts.xTicks != null) this.state.xTicks = clampInt(opts.xTicks, this.state.minX, this.state.maxX, DEFAULT_X);
        }
        this.state.enabled = true;
        this.state.panelOpen = true;
        this._clearRuntime();
        this._persist();
        this._ensureLabelHook();
        this._applyRenderStyle();
        this._syncUI();
        this._refresh();
      },
  
      disable: function () {
        this.state.enabled = false;
        this._clearRuntime();
        this._persist();
        this._clearLabels();
        this._syncUI();
        this._refresh();
      },
  
      setXTicks: function (n) {
        this.state.xTicks = clampInt(n, this.state.minX, this.state.maxX, DEFAULT_X);
        this._clearRuntime();
        this._persist();
        this._syncUI();
        if (this.enabled) this._refresh();
      },
  
      setRenderStyle: function (s) {
        if (s !== 'bars' && s !== 'candles') return;
        this.state.renderStyle = s;
        this._persist();
        this._syncUI();
        if (this.enabled) { this._applyRenderStyle(); this._refresh(); }
      },
  
      setShowDelta: function (on) {
        this.state.showDelta = !!on;
        this._persist();
        this._syncUI();
        if (this.enabled) { if (this.state.showDelta) this._scheduleLabels(); else this._clearLabels(); }
      },
  
      setPanelOpen: function (open) {
        this.state.panelOpen = !!open;
        this._persist();
        this._syncUI();
      },
  
      setLimits: function (minX, maxX) {
        var mn = clampInt(minX, 1, 100000, DEFAULT_MIN);
        var mx = clampInt(maxX, mn, 100000, DEFAULT_MAX);
        this.state.minX = mn;
        this.state.maxX = mx;
        this.state.xTicks = clampInt(this.state.xTicks, mn, mx, DEFAULT_X);
        this._clearRuntime();
        this._persist();
        this._syncUI();
        if (this.enabled) this._refresh();
      },
  
      /* ---------- delta labels ---------- */
  
      _scheduleLabels: function () {
        if (!this.state.showDelta) return;
        var self = this;
        if (this._labelTimer) clearTimeout(this._labelTimer);
        this._labelTimer = setTimeout(function () { self._renderDeltaLabels(); }, 350);
      },
  
      _ensureLabelHook: function () {
        if (this._labelHooked || !this.widget) return;
        try {
          var chart = this.widget.activeChart();
          if (chart && typeof chart.onDataLoaded === 'function') {
            var self = this;
            chart.onDataLoaded().subscribe(null, function () { self._scheduleLabels(); }, false);
            this._labelHooked = true;
          }
        } catch (e) {}
      },
  
      _activeChart: function () {
        try {
          if (this.widget && typeof this.widget.activeChart === 'function') return this.widget.activeChart();
        } catch (e) {}
        return null;
      },
  
      _clearLabels: function () {
        var ids = this._labelIds || [];
        this._labelIds = [];
        if (!ids.length) return;
        var chart = this._activeChart();
        if (chart && typeof chart.removeEntity === 'function') {
          for (var i = 0; i < ids.length; i++) {
            try { chart.removeEntity(ids[i]); } catch (e) {}
          }
        }
      },
  
      _fmtDelta: function (d) {
        if (typeof d !== 'number' || !isFinite(d)) return '';
        var a = Math.abs(d);
        var s = a >= 1000 ? (Math.round(a / 100) / 10) + 'k' : String(Math.round(a * 100) / 100);
        return (d > 0 ? '+' : d < 0 ? '\u2212' : '') + s;
      },
  
      _renderDeltaLabels: function () {
        if (!this.enabled || !this.state.showDelta || !window.RangeBars) { this._clearLabels(); return; }
        var chart = this._activeChart();
        if (!chart || typeof chart.createShape !== 'function') return; // trimmed build may lack it
        this._clearLabels();
        var bars = this._lastBars[this._lastSymKey] || [];
        var CAP = 150;
        var startIdx = Math.max(0, bars.length - CAP);
        var ids = [];
        for (var i = startIdx; i < bars.length; i++) {
          var b = bars[i];
          if (!b || b.forming || typeof b.delta !== 'number') continue;
          var side = window.RangeBars.classifySide(b);
          var above = (side === 'bull');
          var price = above ? b.high : b.low;
          var text = this._fmtDelta(b.delta);
          if (!text) continue;
          try {
            var id = chart.createShape(
              { time: Math.floor(b.time / 1000), price: price },
              {
                shape: 'text', text: text, lock: true,
                disableSelection: true, disableSave: true, disableUndo: true,
                overrides: {
                  color: b.delta >= 0 ? '#26a69a' : '#ef5350',
                  fontsize: 11, bold: false,
                  vertLabelsAlign: above ? 'bottom' : 'top',
                  horzLabelsAlign: 'center'
                }
              }
            );
            if (id != null) ids.push(id);
          } catch (e) { /* per-shape ignore */ }
        }
        this._labelIds = ids;
      },
  
      /* ---------- UI ---------- */
  
      _injectCSS: function () {
        if (document.getElementById('rbm-css')) return;
        var s = document.createElement('style');
        s.id = 'rbm-css';
        s.textContent = [
          '.rbm-panel{position:absolute;top:56px;left:12px;z-index:40;display:none;',
          'background:#1e222d;border:1px solid #2a2e39;border-radius:6px;padding:8px 10px;',
          'font:12px/1.3 -apple-system,Segoe UI,Roboto,sans-serif;color:#d1d4dc;',
          'box-shadow:0 2px 10px rgba(0,0,0,.4);min-width:210px}',
          '.rbm-panel.rbm-on{display:block}',
          'body.light-theme .rbm-panel{background:#fff;border-color:#e0e3eb;color:#131722;box-shadow:0 2px 10px rgba(0,0,0,.12)}',
          '.rbm-title{font-weight:600;margin-bottom:6px;display:flex;align-items:center;gap:6px}',
          '.rbm-title .rbm-dot{width:8px;height:8px;border-radius:50%;background:#2962FF}',
          '.rbm-close{margin-left:auto;background:transparent;border:none;color:#787b86;cursor:pointer;',
          'font-size:16px;line-height:1;padding:0 2px;border-radius:3px}',
          '.rbm-close:hover{color:#d1d4dc}',
          'body.light-theme .rbm-close:hover{color:#131722}',
          '.rbm-reopen{position:absolute;top:56px;left:12px;z-index:40;display:none;align-items:center;gap:6px;',
          'background:#1e222d;border:1px solid #2a2e39;border-radius:6px;padding:5px 10px;cursor:pointer;',
          'font:12px/1 -apple-system,Segoe UI,Roboto,sans-serif;color:#d1d4dc;box-shadow:0 2px 10px rgba(0,0,0,.4)}',
          '.rbm-reopen.rbm-on{display:inline-flex}',
          '.rbm-reopen:hover{border-color:#2962FF;color:#2962FF}',
          '.rbm-reopen .rbm-dot{width:8px;height:8px;border-radius:50%;background:#2962FF;display:inline-block}',
          'body.light-theme .rbm-reopen{background:#fff;border-color:#e0e3eb;color:#131722}',
          '.rbm-row{display:flex;align-items:center;gap:6px;margin-top:6px}',
          '.rbm-row label{flex:0 0 58px;color:#787b86}',
          'body.light-theme .rbm-row label{color:#6a6d78}',
          '.rbm-panel select,.rbm-panel input{background:#131722;border:1px solid #2a2e39;color:#d1d4dc;',
          'border-radius:4px;padding:3px 6px;font-size:12px;flex:1 1 auto;min-width:0}',
          'body.light-theme .rbm-panel select,body.light-theme .rbm-panel input{background:#f8f9fd;border-color:#e0e3eb;color:#131722}',
          '.rbm-btn{background:#2962FF;border:none;color:#fff;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:12px}',
          '.rbm-btn:hover{background:#1e53e5}',
          '.rbm-presets{display:flex;gap:4px;margin-top:6px;flex-wrap:wrap}',
          '.rbm-preset{background:transparent;border:1px solid #2a2e39;color:#d1d4dc;border-radius:4px;padding:2px 7px;cursor:pointer;font-size:11px}',
          'body.light-theme .rbm-preset{border-color:#e0e3eb;color:#131722}',
          '.rbm-preset:hover{border-color:#2962FF;color:#2962FF}',
          '.rbm-preset.rbm-active{border-color:#2962FF;color:#2962FF;font-weight:600}',
          '.rbm-hint{margin-top:6px;color:#787b86;font-size:11px}',
          '.rbm-sub{margin-top:8px;padding-top:6px;border-top:1px solid #2a2e39}',
          'body.light-theme .rbm-sub{border-color:#e0e3eb}',
          '.rbm-chk{display:flex;align-items:center;gap:6px;margin-top:6px}',
          '.rbm-chk input{flex:0 0 auto}',
          '.rbm-mm{display:flex;gap:6px}',
          '.rbm-mm input{width:52px;flex:0 0 auto}'
        ].join('');
        document.head.appendChild(s);
      },
  
      initUI: function (widget) {
        if (widget) this.widget = widget;
        if (typeof document === 'undefined') return;
        this._injectCSS();
        var host = document.querySelector('.chart-container') || document.getElementById('tv_chart_container');
        if (!host) return;
        if (host === document.getElementById('tv_chart_container') && host.parentNode) host = host.parentNode;
        var existing = document.querySelector('.rbm-panel');
        if (existing) existing.remove();
  
        var panel = document.createElement('div');
        panel.className = 'rbm-panel';
        panel.innerHTML =
          '<div class="rbm-title"><span class="rbm-dot"></span><span>Range bars</span>' +
          '<button class="rbm-close" type="button" title="Hide panel" aria-label="Hide panel">\u00d7</button></div>' +
          '<div class="rbm-row"><label>Size (ticks)</label><input class="rbm-size" type="number" step="1" min="1"></div>' +
          '<div class="rbm-presets"></div>' +
          '<div class="rbm-row"><label>Style</label>' +
          '<select class="rbm-style"><option value="candles">Candles</option><option value="bars">Bars</option></select></div>' +
          '<div class="rbm-chk"><input type="checkbox" class="rbm-delta" id="rbm-delta"><label for="rbm-delta" style="flex:1 1 auto;color:inherit">Show delta labels</label></div>' +
          '<div class="rbm-row" style="justify-content:flex-end"><button class="rbm-btn rbm-apply">Apply</button></div>' +
          '<div class="rbm-hint"></div>' +
          '<div class="rbm-sub"><div class="rbm-row"><label>Limits</label>' +
          '<div class="rbm-mm"><input class="rbm-min" type="number" step="1" min="1" title="min X"> <input class="rbm-max" type="number" step="1" min="1" title="max X"></div></div>' +
          '<div class="rbm-row" style="justify-content:flex-end"><button class="rbm-btn rbm-savelim" style="background:#3a3e49">Save limits</button></div></div>';
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        host.appendChild(panel);
        this._ui = panel;
  
        var existingReopen = document.querySelector('.rbm-reopen');
        if (existingReopen) existingReopen.remove();
        var reopen = document.createElement('button');
        reopen.className = 'rbm-reopen';
        reopen.type = 'button';
        reopen.title = 'Show range bars panel';
        reopen.innerHTML = '<span class="rbm-dot"></span>Range bars';
        host.appendChild(reopen);
        this._reopen = reopen;
  
        var self = this;
        var sizeInp = panel.querySelector('.rbm-size');
        var styleSel = panel.querySelector('.rbm-style');
        var deltaChk = panel.querySelector('.rbm-delta');
        var presets = panel.querySelector('.rbm-presets');
        PRESETS.forEach(function (v) {
          var b = document.createElement('button');
          b.className = 'rbm-preset';
          b.textContent = String(v);
          b.setAttribute('data-v', String(v));
          b.addEventListener('click', function () { sizeInp.value = String(v); self._markActivePreset(v); });
          presets.appendChild(b);
        });
        panel.querySelector('.rbm-apply').addEventListener('click', function () {
          self.state.renderStyle = (styleSel.value === 'bars') ? 'bars' : 'candles';
          self.state.showDelta = !!deltaChk.checked;
          self.setXTicks(sizeInp.value);            // clamps + persists + refresh
          self._applyRenderStyle();
          if (self.enabled) { if (self.state.showDelta) self._scheduleLabels(); else self._clearLabels(); self._refresh(); }
          self._persist();
          self._syncUI();
        });
        panel.querySelector('.rbm-savelim').addEventListener('click', function () {
          self.setLimits(panel.querySelector('.rbm-min').value, panel.querySelector('.rbm-max').value);
          sizeInp.value = String(self.state.xTicks);
        });
        styleSel.addEventListener('change', function () { self.setRenderStyle(styleSel.value); });
        deltaChk.addEventListener('change', function () { self.setShowDelta(deltaChk.checked); });
        panel.querySelector('.rbm-close').addEventListener('click', function () { self.setPanelOpen(false); });
        reopen.addEventListener('click', function () { self.setPanelOpen(true); });
  
        this._ensureLabelHook();
        this._syncUI();
      },
  
      _markActivePreset: function (v) {
        if (!this._ui) return;
        var btns = this._ui.querySelectorAll('.rbm-preset');
        for (var i = 0; i < btns.length; i++) {
          btns[i].classList.toggle('rbm-active', String(v) === btns[i].getAttribute('data-v'));
        }
      },
  
      _syncUI: function () {
        if (!this._ui) return;
        var panelVisible = this.enabled && this.state.panelOpen !== false;
        this._ui.classList.toggle('rbm-on', panelVisible);
        if (this._reopen) this._reopen.classList.toggle('rbm-on', this.enabled && !panelVisible);
        var sizeInp = this._ui.querySelector('.rbm-size');
        var styleSel = this._ui.querySelector('.rbm-style');
        var deltaChk = this._ui.querySelector('.rbm-delta');
        var hint = this._ui.querySelector('.rbm-hint');
        var minInp = this._ui.querySelector('.rbm-min');
        var maxInp = this._ui.querySelector('.rbm-max');
        var x = this._xTicksClamped();
        if (sizeInp) sizeInp.value = String(x);
        if (styleSel) styleSel.value = this.state.renderStyle;
        if (deltaChk) deltaChk.checked = !!this.state.showDelta;
        if (minInp) minInp.value = String(this.state.minX);
        if (maxInp) maxInp.value = String(this.state.maxX);
        this._markActivePreset(x);
        if (hint) {
          var mt = this._minTickCache[this._lastSymKey];
          var priceStr = (mt > 0) ? ('  \u2248 ' + this._fmt(x * mt) + ' price') : '';
          hint.textContent = 'Box = ' + x + ' ticks' + priceStr + '  \u00b7  range \u2264 X';
        }
      },
  
      _fmt: function (x) {
        if (!isFinite(x)) return String(x);
        if (x >= 1) return (Math.round(x * 100) / 100).toString();
        return x.toPrecision(3);
      },
  
      onLayoutChanged: function () {
        this._labelHooked = false;
        this._ensureLabelHook();
        this._syncUI();
        if (this.enabled) this._scheduleLabels();
      }
    };
  
    return M;
  });
  