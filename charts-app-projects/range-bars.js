/*
 * range-bars.js — pure, dependency-free range-bar transform (v2 spec).
 *
 * UMD: exposes `window.RangeBars` in the browser and `module.exports` in Node.
 *
 * v2 RANGE-BAR DEFINITION (per user spec, tick-driven):
 *   - X ("box size") is the maximum price height of a bar, expressed in ticks
 *     (unit 'mintick') or raw price (unit 'price'). Resolved to a price height.
 *   - A bar accumulates incoming trade prices while  (high - low) <= X.
 *   - The FIRST tick whose inclusion would make (high - low) STRICTLY > X does
 *     NOT join the current bar: the current bar CLOSES at the previous accepted
 *     price, and that overflowing tick OPENS a new bar. Therefore:
 *       * every completed bar has height <= X (may be < X),
 *       * close(prev) differs from open(next) by >= 1 tick,
 *       * gaps (moves > 1 tick between bars) are left as visual HOLES — we do
 *         NOT synthesize phantom fill bars.
 *   - Only ONE bar can close per incoming tick.
 *   - Each bar also carries a cumulative volume `delta` (sum of signed tick
 *     volume: +volume on an uptick, -volume on a downtick, unchanged price
 *     carries the previous direction). The seed tick counts as an uptick.
 *
 * Range bars are time-INDEPENDENT and computed in a single O(N) pass over ticks;
 * cost is independent of X (X only changes how many output bars are produced).
 *
 * Public API:
 *   RangeBars.fromTicks(ticks, options)     -> bars[]
 *   RangeBars.fromCandles(candles, options) -> bars[]   (approx; testing/fallback)
 *   RangeBars.newRangeState(X, seedPrice, seedBar) -> state   (realtime reducer)
 *   RangeBars.rangeStep(state, price, volume) -> { completed[], forming }
 *   RangeBars.classifySide(bar) -> 'bull' | 'bear'
 *
 * ticks   : Array<number>                          (price; time = index, volume = 0)
 *         | Array<{ time, price|close|value, volume? }>
 * candles : Array<{ time, open, high, low, close, volume? }>
 * options : {
 *     boxSize     : number > 0   (REQUIRED — the range height X, in `unit`s)
 *     unit        : 'price'|'mintick'|'percent'  (default 'price')
 *     minTick     : number       (used by 'mintick'; also clamps min X)
 *     maxBars     : number       (default 200000 — hard cap, anti bar-explosion)
 *     emitForming : boolean      (default true — append the in-progress bar, forming:true)
 *     bullishCandlePath / bearishCandlePath: string[]  (fromCandles intrabar path override)
 *   }
 * Returns bars: { time, open, high, low, close, volume, delta, forming? }
 *   Every COMPLETED bar satisfies  (high - low) <= X.
 */
(function (root, factory) {
    var mod = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = mod;
    if (typeof window !== 'undefined') window.RangeBars = mod;
    else if (typeof self !== 'undefined') self.RangeBars = mod;
  })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
  
    function resolveBoxSize(options, firstPrice) {
      var opts = options || {};
      var box = opts.boxSize;
      if (typeof box !== 'number' || !isFinite(box) || box <= 0) {
        throw new Error('range-bars: boxSize must be a finite number > 0 (got ' + box + ')');
      }
      var unit = opts.unit || 'price';
      var X;
      if (unit === 'mintick') {
        var mt = (typeof opts.minTick === 'number' && opts.minTick > 0) ? opts.minTick : 1;
        X = box * mt;
      } else if (unit === 'percent') {
        X = (box / 100) * firstPrice;
      } else { // 'price'
        X = box;
      }
      if (typeof opts.minTick === 'number' && opts.minTick > 0 && X < opts.minTick) {
        X = opts.minTick;
      }
      if (!isFinite(X) || X <= 0) {
        throw new Error('range-bars: resolved box size must be > 0 (got ' + X + ')');
      }
      return X;
    }
  
    function normalizeTick(t, i) {
      if (typeof t === 'number') return { time: i, price: t, volume: 0 };
      if (t && typeof t === 'object') {
        var price = typeof t.price === 'number' ? t.price
                  : typeof t.close === 'number' ? t.close
                  : typeof t.value === 'number' ? t.value : NaN;
        var time = typeof t.time === 'number' ? t.time : i;
        var volume = typeof t.volume === 'number' ? t.volume : 0;
        return { time: time, price: price, volume: volume };
      }
      return { time: i, price: NaN, volume: 0 };
    }
  
    function fromTicks(ticks, options) {
      if (!ticks || !ticks.length) return [];
      var opts = options || {};
      var maxBars = (typeof opts.maxBars === 'number' && opts.maxBars > 0) ? opts.maxBars : 200000;
      var emitForming = opts.emitForming !== false;
  
      // Seed the first bar from the first tick that carries a finite price.
      var start = 0;
      var first = normalizeTick(ticks[0], 0);
      while (!isFinite(first.price) && start < ticks.length - 1) {
        start++; first = normalizeTick(ticks[start], start);
      }
      if (!isFinite(first.price)) return [];
  
      var X = resolveBoxSize(opts, first.price);
      var eps = X * 1e-9;
  
      var bars = [];
      var lastEmittedTime = -Infinity;
      function nudge(t) {
        var tt = (typeof t === 'number' && isFinite(t)) ? t : lastEmittedTime + 1;
        if (tt <= lastEmittedTime) tt = lastEmittedTime + 1;
        lastEmittedTime = tt;
        return tt;
      }
  
      var o = first.price, h = first.price, l = first.price, c = first.price;
      var accVol = first.volume || 0;
      var delta = first.volume || 0; // seed tick counts as an uptick (+vol)
      var lastDir = 1;
      var tOpen = first.time;
      var capped = false;
  
      for (var i = start + 1; i < ticks.length; i++) {
        var nt = normalizeTick(ticks[i], i);
        if (!isFinite(nt.price)) continue;
        var p = nt.price;
        var vol = nt.volume || 0;
        var dir = p > c ? 1 : (p < c ? -1 : lastDir);
  
        var H2 = p > h ? p : h;
        var L2 = p < l ? p : l;
  
        if ((H2 - L2) > X + eps) {
          // p overflows the current bar: close current bar at the previous accepted
          // price c, then p opens a NEW bar. No phantom fill => gap stays a hole.
          bars.push({
            time: nudge(tOpen),
            open: o, high: h, low: l, close: c,
            volume: accVol, delta: delta
          });
          if (bars.length >= maxBars) { capped = true; break; }
          o = p; h = p; l = p; c = p;
          accVol = vol; delta = dir * vol; lastDir = dir;
          tOpen = nt.time;
        } else {
          // accept p into the current bar
          h = H2; l = L2; c = p;
          accVol += vol; delta += dir * vol; lastDir = dir;
        }
      }
  
      if (!capped && emitForming) {
        bars.push({
          time: nudge(tOpen),
          open: o, high: h, low: l, close: c,
          volume: accVol, delta: delta,
          forming: true
        });
      }
      return bars;
    }
  
    function newRangeState(X, seedPrice, seedBar) {
      if (typeof X !== 'number' || !isFinite(X) || X <= 0) {
        throw new Error('range-bars: newRangeState requires X > 0 (got ' + X + ')');
      }
      var st = { X: X, eps: X * 1e-9, o: 0, h: 0, l: 0, c: 0, accVol: 0, delta: 0, lastDir: 1 };
      if (seedBar && typeof seedBar === 'object') {
        st.o = seedBar.open; st.h = seedBar.high; st.l = seedBar.low; st.c = seedBar.close;
        st.accVol = typeof seedBar.volume === 'number' ? seedBar.volume : 0;
        st.delta = typeof seedBar.delta === 'number' ? seedBar.delta : 0;
      } else {
        st.o = st.h = st.l = st.c = seedPrice;
      }
      return st;
    }
  
    function formingOf(state) {
      return {
        open: state.o, high: state.h, low: state.l, close: state.c,
        volume: state.accVol, delta: state.delta
      };
    }
  
    function rangeStep(state, price, volume) {
      var completed = [];
      var vol = (typeof volume === 'number' && isFinite(volume)) ? volume : 0;
      if (typeof price !== 'number' || !isFinite(price)) {
        return { completed: completed, forming: formingOf(state) };
      }
      var X = state.X, eps = state.eps;
      var dir = price > state.c ? 1 : (price < state.c ? -1 : state.lastDir);
      var H2 = price > state.h ? price : state.h;
      var L2 = price < state.l ? price : state.l;
  
      if ((H2 - L2) > X + eps) {
        completed.push({
          open: state.o, high: state.h, low: state.l, close: state.c,
          volume: state.accVol, delta: state.delta
        });
        state.o = price; state.h = price; state.l = price; state.c = price;
        state.accVol = vol; state.delta = dir * vol; state.lastDir = dir;
      } else {
        state.h = H2; state.l = L2; state.c = price;
        state.accVol += vol; state.delta += dir * vol; state.lastDir = dir;
      }
      return { completed: completed, forming: formingOf(state) };
    }
  
    // Bull  := open < close  OR  open == high == close
    // Bear  := open > close  OR  open == low  == close
    // Ambiguous doji (open == close, not touching high/low) falls back to delta sign.
    function classifySide(bar) {
      if (!bar) return 'bull';
      var o = bar.open, c = bar.close, h = bar.high, l = bar.low;
      if (o < c) return 'bull';
      if (o > c) return 'bear';
      if (o === h) return 'bull';
      if (o === l) return 'bear';
      return (typeof bar.delta === 'number' && bar.delta < 0) ? 'bear' : 'bull';
    }
  
    // fromCandles is APPROXIMATE (a candle's true intrabar path is unknown). Kept for
    // tests / fallback only — production builds range bars from raw ticks, never candles.
    function fromCandles(candles, options) {
      if (!candles || !candles.length) return [];
      var opts = options || {};
      var bullPath = opts.bullishCandlePath || ['open', 'low', 'high', 'close'];
      var bearPath = opts.bearishCandlePath || ['open', 'high', 'low', 'close'];
      var ticks = [];
      for (var i = 0; i < candles.length; i++) {
        var cd = candles[i];
        if (!cd) continue;
        var t = typeof cd.time === 'number' ? cd.time : i;
        var vol = typeof cd.volume === 'number' ? cd.volume : 0;
        var bull = (typeof cd.close === 'number' && typeof cd.open === 'number') ? cd.close >= cd.open : true;
        var path = bull ? bullPath : bearPath;
        var per = path.length ? vol / path.length : 0;
        for (var k = 0; k < path.length; k++) {
          var price = cd[path[k]];
          if (typeof price !== 'number' || !isFinite(price)) continue;
          ticks.push({ time: t, price: price, volume: per });
        }
      }
      return fromTicks(ticks, options);
    }
  
    return {
      fromTicks: fromTicks,
      fromCandles: fromCandles,
      newRangeState: newRangeState,
      rangeStep: rangeStep,
      classifySide: classifySide,
      version: '2.0.0'
    };
  });