// Persistent cleanup watcher — survives indicator removal
(function() {
  if (window._fvgCleanupWatcher) clearInterval(window._fvgCleanupWatcher);
  window._fvgCleanupWatcher = setInterval(function() {
    var ids = window._fvgDrawnIds;
    if (!ids || ids.length === 0) return;
    try {
      var widget = window.app && window.app.widget;
      var chart = widget && widget.activeChart();
      if (!chart) return;
      var studies = chart.getAllStudies();
      var found = false;
      for (var i = 0; i < studies.length; i++) {
        if (studies[i].name === 'Fair Value Gap Zones') { found = true; break; }
      }
      if (!found) {
        console.log('[FVG] Study removed — cleaning up ' + ids.length + ' shapes');
        for (var j = 0; j < ids.length; j++) {
          try { chart.removeEntity(ids[j]); } catch(e) {}
        }
        window._fvgDrawnIds = [];
        window._fvgList = [];
        clearTimeout(window._fvgDrawTimer);
        // Persist clean state to server so shapes don't return after refresh
        try { widget.saveChartToServer(); } catch(e) {}
      }
    } catch(e) {}
  }, 500);
})();

(function() {
  'use strict';

  var BULL_FILL   = 'rgba(8, 153, 129, 0.15)';
  var BEAR_FILL   = 'rgba(242, 54, 69, 0.15)';

  window._fvgDrawnIds = window._fvgDrawnIds || [];
  var _fvgStudyId = null;
  var _fvgHidden = false;

  function getFvgStudyApi() {
    try {
      var chart = window.app && window.app.widget && window.app.widget.activeChart();
      if (!chart) return null;
      var studies = chart.getAllStudies();
      var found = false;
      for (var s = 0; s < studies.length; s++) {
        if (studies[s].name === 'Fair Value Gap Zones') {
          _fvgStudyId = studies[s].id;
          found = true;
          break;
        }
      }
      if (!found) { _fvgStudyId = null; return null; }
      return chart.getStudyById(_fvgStudyId);
    } catch (e) { return null; }
  }

  function removeAllShapes() {
    try {
      var chart = window.app.widget.activeChart();
      for (var i = 0; i < window._fvgDrawnIds.length; i++) {
        try { chart.removeEntity(window._fvgDrawnIds[i]); } catch (e) {}
      }
    } catch (e) {}
    window._fvgDrawnIds = [];
  }

  setInterval(function() {
    var api = getFvgStudyApi();
    if (!api) {
      if (window._fvgDrawnIds.length > 0) {
        removeAllShapes();
        clearTimeout(window._fvgDrawTimer);
        window._fvgList = [];
        _fvgHidden = false;
      }
      return;
    }
    var visible = api.isVisible();
    if (!visible && !_fvgHidden) {
      _fvgHidden = true;
      removeAllShapes();
    } else if (visible && _fvgHidden) {
      _fvgHidden = false;
      drawFVGShapes();
    }
  }, 300);

  function drawFVGShapes() {
    var chart;
    try {
      chart = window.app && window.app.widget && window.app.widget.activeChart();
    } catch (e) { return; }
    if (!chart) return;

    if (_fvgHidden) return;

    for (var i = 0; i < window._fvgDrawnIds.length; i++) {
      try { chart.removeEntity(window._fvgDrawnIds[i]); } catch (e) {}
    }
    window._fvgDrawnIds = [];

    var list = window._fvgList || [];
    var lastTime = window._fvgLastTime;
    var drawn = 0;

    var showFilled  = window._fvgShowFilled || false;
    var showExpired = window._fvgShowExpired || false;

    for (var j = 0; j < list.length; j++) {
      var fvg = list[j];
      if (fvg.expired && !showExpired) continue;
      if (fvg.filled && !fvg.expired && !showFilled) continue;

      var clr, tEnd;
      if (fvg.expired) {
        clr  = fvg.type === 'bull'
          ? (window._fvgExpBull || 'rgba(128,128,128,0.12)')
          : (window._fvgExpBear || 'rgba(128,128,128,0.12)');
        tEnd = fvg.expireTime || lastTime;
      } else if (fvg.filled) {
        clr  = fvg.type === 'bull'
          ? (window._fvgDimBull || '#089981')
          : (window._fvgDimBear || '#F23645');
        tEnd = fvg.fillTime || lastTime;
      } else {
        clr  = fvg.type === 'bull'
          ? (window._fvgActiveBull || BULL_FILL)
          : (window._fvgActiveBear || BEAR_FILL);
        tEnd = lastTime;
      }

      var result = chart.createMultipointShape(
        [
          { time: fvg.t0, price: fvg.bot },
          { time: tEnd, price: fvg.top }
        ],
        {
          shape: 'rectangle',
          lock: true,
          disableSelection: true,
          overrides: {
            backgroundColor: clr,
            color: clr,
            linewidth: 1,
            fillBackground: true,
            transparency: 0,
            showLabel: false
          },
          zOrder: 'bottom'
        }
      );
      if (result && typeof result.then === 'function') {
        result.then(function(eid) { if (eid) window._fvgDrawnIds.push(eid); });
      } else if (result) {
        window._fvgDrawnIds.push(result);
      }
      drawn++;
    }

    console.log('[FVG] drawn ' + drawn + ' rectangles, total tracked: ' + list.length);
  }

  window.customPineIndicators = window.customPineIndicators || [];
  for (var _di = window.customPineIndicators.length - 1; _di >= 0; _di--) {
    var _n = window.customPineIndicators[_di].name;
    if (_n === 'FVG Zones' || _n === 'Fair Value Gap Zones') {
      window.customPineIndicators.splice(_di, 1);
    }
  }
  window.customPineIndicators.push({
    name: 'FVG Zones',
    metainfo: {
      _metainfoVersion: 51,
      id: 'fvg_zones@tv-basicstudies-1',
      description: 'Fair Value Gap Zones',
      shortDescription: 'FVG Zones',
      is_price_study: true,
      isCustomIndicator: true,
      format: { type: 'inherit' },
      plots: [{ id: 'p0', type: 'line' }],
      defaults: {
        styles: {
          p0: { plottype: 7, linewidth: 0, color: '#089981', trackPrice: false }
        },
        inputs: { in_0: 'rgba(8, 153, 129, 0.27)', in_1: 'rgba(242, 54, 69, 0.27)', in_2: 'Приход в 0.5', in_3: true, in_4: 'rgba(8, 153, 129, 0.12)', in_5: 'rgba(242, 54, 69, 0.12)', in_6: true, in_7: 0, in_8: 'rgba(128, 128, 128, 0.20)', in_9: 'rgba(128, 128, 128, 0.20)' }
      },
      styles: { p0: { title: 'FVG', histogramBase: 0 } },
      inputs: [{
        id: 'in_0',
        name: 'Цвет бычьих',
        type: 'color',
        defval: 'rgba(8, 153, 129, 0.27)'
      }, {
        id: 'in_1',
        name: 'Цвет медвежьих',
        type: 'color',
        defval: 'rgba(242, 54, 69, 0.27)'
      }, {
        id: 'in_2',
        name: 'Способ инвалидации',
        type: 'text',
        defval: 'Приход в 0.5',
        options: ['Приход в 0.5', 'Касание зоны', 'Полное заполнение', 'Закрытие за зоной']
      }, {
        id: 'in_3',
        name: 'Показывать инвалидированные',
        type: 'bool',
        defval: true
      }, {
        id: 'in_4',
        name: 'Цвет инвалид. бычьих',
        type: 'color',
        defval: 'rgba(8, 153, 129, 0.12)'
      }, {
        id: 'in_5',
        name: 'Цвет инвалид. медвежьих',
        type: 'color',
        defval: 'rgba(242, 54, 69, 0.12)'
      }, {
        id: 'in_6',
        name: 'Показывать устаревшие',
        type: 'bool',
        defval: true
      }, {
        id: 'in_7',
        name: 'Время жизни имба (в барах)',
        type: 'integer',
        defval: 0,
        min: 0,
        max: 10000
      }, {
        id: 'in_8',
        name: 'Цвет устар. бычьих',
        type: 'color',
        defval: 'rgba(128, 128, 128, 0.20)'
      }, {
        id: 'in_9',
        name: 'Цвет устар. медвежьих',
        type: 'color',
        defval: 'rgba(128, 128, 128, 0.20)'
      }]
    },

    constructor: function() {
      this.main = function(context, inputCallback) {
        try {
          var PineJS = window.PineJS;
          if (!PineJS) return [NaN];

          var high  = context.new_var(PineJS.Std.high(context));
          var low   = context.new_var(PineJS.Std.low(context));
          var close = context.new_var(PineJS.Std.close(context));

          // Detect first bar → reset state
          var marker = context.new_var(0);
          if (!marker.get(1)) {
            clearTimeout(window._fvgDrawTimer);
            window._fvgList = [];
            window._fvgStats = { bars: 0, bullNew: 0, bearNew: 0, bullFill: 0, bearFill: 0 };
            window._fvgTimes = [NaN, NaN, NaN];
          }
          marker.set(1);

          var h = high.get(0);
          var l = low.get(0);
          var c = close.get(0);
          window._fvgActiveBull = inputCallback(0);
          window._fvgActiveBear = inputCallback(1);
          var mode = inputCallback(2);
          window._fvgShowFilled = !!inputCallback(3);
          window._fvgDimBull = inputCallback(4);
          window._fvgDimBear = inputCallback(5);
          window._fvgShowExpired = !!inputCallback(6);
          var ttl  = inputCallback(7) || 0;
          window._fvgExpBull = inputCallback(8);
          window._fvgExpBear = inputCallback(9);

          var curTime = PineJS.Std.time(context) / 1000;
          // Track time manually (time.get(1) returns NaN in this PineJS build)
          window._fvgTimes.shift();
          window._fvgTimes.push(curTime);
          var list = window._fvgList;

          window._fvgStats.bars++;

          for (var i = 0; i < list.length; i++) {
            var f = list[i];
            if (f.filled || f.expired) continue;
            var mid = (f.top + f.bot) / 2;
            var inv = false;

            if (f.type === 'bull') {
              switch (mode) {
                case 'Касание зоны':       inv = l <= f.top; break;
                case 'Полное заполнение':  inv = l <= f.bot; break;
                case 'Закрытие за зоной':  inv = c < f.bot;  break;
                default:                   inv = l <= mid;    break; // Приход в 0.5
              }
            } else {
              switch (mode) {
                case 'Касание зоны':       inv = h >= f.bot; break;
                case 'Полное заполнение':  inv = h >= f.top; break;
                case 'Закрытие за зоной':  inv = c > f.top;  break;
                default:                   inv = h >= mid;    break; // Приход в 0.5
              }
            }

            if (inv) {
              f.filled = true;
              f.fillTime = curTime;
              window._fvgStats[f.type === 'bull' ? 'bullFill' : 'bearFill']++;
            }
          }

          // TTL expiry — mark unfilled FVGs as expired after N bars
          if (ttl > 0) {
            var curBar = window._fvgStats.bars;
            for (var t = 0; t < list.length; t++) {
              var fe = list[t];
              if (fe.filled || fe.expired) continue;
              if ((curBar - fe.birthBar) >= ttl) {
                fe.expired = true;
                fe.expireTime = curTime;
              }
            }
          }

          var midTime = window._fvgTimes[1];

          var aH = high.get(2), cL = low.get(0);
          if (!isNaN(aH) && !isNaN(cL) && aH < cL) {
            list.push({ type: 'bull', top: cL, bot: aH, t0: midTime, filled: false, expired: false, birthBar: window._fvgStats.bars });
            window._fvgStats.bullNew++;
          }

          var aL = low.get(2), cH = high.get(0);
          if (!isNaN(aL) && !isNaN(cH) && aL > cH) {
            list.push({ type: 'bear', top: aL, bot: cH, t0: midTime, filled: false, expired: false, birthBar: window._fvgStats.bars });
            window._fvgStats.bearNew++;
          }

          window._fvgLastTime = curTime;

          // Debounce draw — fires only after last bar
          clearTimeout(window._fvgDrawTimer);
          window._fvgDrawTimer = setTimeout(drawFVGShapes, 100);

          return [NaN];
        } catch (e) {
          console.error('FVG error:', e);
          return [NaN];
        }
      };
    }
  });

  window.fvgClear = function() {
    clearTimeout(window._fvgDrawTimer);
    window._fvgList = [];
    var chart;
    try { chart = window.app.widget.activeChart(); } catch (e) { return; }
    for (var i = 0; i < window._fvgDrawnIds.length; i++) {
      try { chart.removeEntity(window._fvgDrawnIds[i]); } catch (e) {}
    }
    window._fvgDrawnIds = [];
  };
})();
