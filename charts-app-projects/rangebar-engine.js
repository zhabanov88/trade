/**
 * RangeBar Engine — indicator script для backtest-engine-server.js
 *
 * Получает тики через window.app.activedata (массив raw ticks из raw_market_data).
 * Строит range-бары по вертикальной оси (диапазон = range_pts пунктов).
 * Джойнит GEX данные через window.app.gex_data (предзагружается движком).
 * Записывает в каждый бар свойства: rb_*, gex_*
 *
 * outputs_schema:
 *   rb_dir          — 1=bear (медвежий) | 2=bull (бычий) — ЧИСЛО, не строка!
 *                      (SharedArrayBuffer хранит только числа)
 *   rb_delta        — delta за период бара (Lee-Ready)
 *   rb_ticks        — количество тиков в баре
 *   rb_open         — цена открытия бара
 *   rb_close        — цена закрытия бара
 *   gex_zero_gamma  — уровень zero_gamma на момент закрытия бара
 *   gex_sum_vol     — sum_gex_vol на момент закрытия бара
 *   gex_major_neg   — major_neg_vol на момент закрытия бара
 *   gex_has_data    — 1 если есть GEX данные, 0 если нет
 *
 * Параметры (inputs_schema):
 *   range_pts       — размер бара в пунктах (default: 10)
 *   tick_size       — размер тика (default: 0.25 для ES)
 *   session_start_h — час начала сессии UTC (default: 14)
 *   session_start_m — минута начала сессии UTC (default: 30)
 *   session_end_h   — час конца сессии UTC (default: 21)
 */

TVEngine.define({
    name: 'RangeBar Engine',
    defaultInputs: {
      range_pts:       10,
      tick_size:       0.25,
      session_start_h: 14,
      session_start_m: 30,
      session_end_h:   21,
    },
  
    buildCfg: function(inputs) {
      return {
        range_pts:       parseFloat(inputs.range_pts)       || 10,
        tick_size:       parseFloat(inputs.tick_size)       || 0.25,
        session_start_h: parseInt(inputs.session_start_h)   || 14,
        session_start_m: parseInt(inputs.session_start_m)   || 30,
        session_end_h:   parseInt(inputs.session_end_h)     || 21,
      };
    },
  
    analyze: function(bars, cfg) {
      // bars = тики из raw_market_data (уже отфильтрованные движком)
      // Каждый тик: { t, price, open, high, low, close, volume, timestamp }
      // gex_data = window.app.gex_data (массив GEX записей, предзагружен движком)
  
      var gexData  = (typeof window !== 'undefined' && window.app && window.app.gex_data) ? window.app.gex_data : [];
      var RANGE    = cfg.range_pts;
      var SH       = cfg.session_start_h;
      var SM       = cfg.session_start_m;
      var EH       = cfg.session_end_h;
      var SESSION_START_SOD = SH * 3600 + SM * 60;
      var SESSION_END_SOD   = EH * 3600;
  
      // Строим индекс GEX по timestamp (бинарный поиск)
      var gexTs = [];
      for (var gi = 0; gi < gexData.length; gi++) {
        gexTs.push(new Date(gexData[gi].ts).getTime());
      }
  
      function getGEX(tsMs) {
        var lo = 0, hi = gexTs.length - 1, res = -1;
        while (lo <= hi) {
          var mid = (lo + hi) >> 1;
          if (gexTs[mid] <= tsMs) { res = mid; lo = mid + 1; }
          else hi = mid - 1;
        }
        if (res < 0) return null;
        // Проверяем что GEX с того же дня
        var gexDate = new Date(gexTs[res]).toISOString().slice(0, 10);
        var reqDate = new Date(tsMs).toISOString().slice(0, 10);
        if (gexDate !== reqDate) return null;
        return gexData[res];
      }
  
      // Lee-Ready: определение агрессора
      var prevPrice = null, prevDir = 0;
      function leeReady(px) {
        var dir;
        if (prevPrice === null || px > prevPrice) { dir = 1;  prevDir = 1; }
        else if (px < prevPrice)                   { dir = -1; prevDir = -1; }
        else                                        { dir = prevDir; }
        prevPrice = px;
        return dir;
      }
  
      // Строим range-бары
      var barOpen = null, barHigh = null, barLow = null;
      var barDelta = 0, barTicks = 0;
      var barOpenTs = 0;
      var sessionDay = null;
  
      // Массив для хранения баров (будем матчить с тиками потом)
      var rangeBars = [];
  
      for (var i = 0; i < bars.length; i++) {
        var tick = bars[i];
        var tsMs = tick.t ? tick.t * 1000 : new Date(tick.timestamp).getTime();
        var px   = parseFloat(tick.price || tick.close);
        var d    = new Date(tsMs);
        var dow  = d.getUTCDay(); // 0=Sun, 6=Sat
        if (dow === 0 || dow === 6) { leeReady(px); continue; }
        var sod  = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
        if (sod < SESSION_START_SOD || sod >= SESSION_END_SOD) { leeReady(px); continue; }
  
        var tickDate = d.toISOString().slice(0, 10);
        // Новый день — сбрасываем бар
        if (tickDate !== sessionDay) {
          sessionDay = tickDate;
          barOpen = null; barHigh = null; barLow = null;
          barDelta = 0; barTicks = 0; barOpenTs = 0;
          prevPrice = null; prevDir = 0;
        }
  
        var dir = leeReady(px);
  
        if (barOpen === null) {
          barOpen = px; barHigh = px; barLow = px;
          barOpenTs = tsMs; barDelta = 0; barTicks = 0;
        }
  
        if (px > barHigh) barHigh = px;
        if (px < barLow)  barLow  = px;
        barDelta += dir;
        barTicks++;
  
        var rangeUp   = barHigh - barOpen;
        var rangeDown = barOpen - barLow;
  
        var closed = null;
        if (rangeUp >= RANGE) {
          closed = { direction: 'bull', open: barOpen, close: barOpen + RANGE,
                     high: barOpen + RANGE, low: barOpen,
                     open_ts: barOpenTs, close_ts: tsMs,
                     delta: barDelta, ticks: barTicks };
          barOpen = barOpen + RANGE; barHigh = barOpen; barLow = barOpen;
          barDelta = 0; barTicks = 0; barOpenTs = tsMs;
        } else if (rangeDown >= RANGE) {
          closed = { direction: 'bear', open: barOpen, close: barOpen - RANGE,
                     high: barOpen, low: barOpen - RANGE,
                     open_ts: barOpenTs, close_ts: tsMs,
                     delta: barDelta, ticks: barTicks };
          barOpen = barOpen - RANGE; barHigh = barOpen; barLow = barOpen;
          barDelta = 0; barTicks = 0; barOpenTs = tsMs;
        }
  
        if (closed) {
          // Получаем GEX на момент закрытия бара
          var gex = getGEX(closed.close_ts);
  
          // ВАЖНО: SharedArrayBuffer хранит только числа (Float64Array).
          // Движок фильтрует только typeof === 'number' поля при передаче
          // данных из воркера обратно в основной процесс.
          // rb_dir: 1 = bear (медвежий), 2 = bull (бычий)
          tick.rb_dir         = closed.direction === 'bear' ? 1 : 2;
          tick.rb_delta       = closed.delta;
          tick.rb_ticks       = closed.ticks;
          tick.rb_open        = closed.open;
          tick.rb_close       = closed.close;
          tick.rb_high        = closed.high;
          tick.rb_low         = closed.low;
          tick.rb_bar_open_ts = closed.open_ts;
  
          if (gex) {
            tick.gex_zero_gamma = parseFloat(gex.zero_gamma)  || 0;
            tick.gex_sum_vol    = parseFloat(gex.sum_gex_vol)  || 0;
            tick.gex_major_neg  = parseFloat(gex.major_neg_vol)|| 0;
            tick.gex_has_data   = 1;
          } else {
            tick.gex_zero_gamma = 0;
            tick.gex_sum_vol    = 0;
            tick.gex_major_neg  = 0;
            tick.gex_has_data   = 0;
          }
        }
      }
    }
  });