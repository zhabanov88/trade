return TVEngine.define({

  name:        'CISD',
  id:          'cisd@tv-basicstudies-1',
  description: 'Change in State of Delivery',
  overlay:     true,

  inputs: [
    { id:'in_0', name:'Bullish Color',   type:'color',   defval:'rgba(8,153,129,1)' },
    { id:'in_1', name:'Bearish Color',   type:'color',   defval:'rgba(239,83,80,1)' },
    { id:'in_2', name:'Line Width',      type:'integer',  defval:2, min:1, max:5 },
    { id:'in_3', name:'Line Style',      type:'text',    defval:'dotted', options:['solid','dashed','dotted'] },
    { id:'in_4', name:'Ray Length',      type:'integer',  defval:24, min:0, max:500 },
    { id:'in_5', name:'Show Mitigated',  type:'bool',    defval:false },
    { id:'in_6', name:'Show Last Only',  type:'bool',    defval:false },
  ],

  defaultInputs: {
    in_0: 'rgba(8,153,129,1)',
    in_1: 'rgba(239,83,80,1)',
    in_2: 2,
    in_3: 'dotted',
    in_4: 24,
    in_5: false,
    in_6: false,
  },

  buildCfg: function(inp) {
    return {
      bullishColor:  inp(0) || 'rgba(8,153,129,1)',
      bearishColor:  inp(1) || 'rgba(239,83,80,1)',
      lineWidth:     inp(2) || 2,
      lineStyle:     inp(3) || 'dotted',
      rayLength:     inp(4) || 24,
      showMitigated: !!inp(5),
      showLastOnly:  !!inp(6),
    };
  },

  analyze: function(bars, cfg) {
    if (!bars || bars.length < 3) return [];

    var lineStyleMap = { solid: 0, dotted: 1, dashed: 2 };
    var linestyle    = lineStyleMap[cfg.lineStyle] || 1;

    var list  = [];
    var lastT = bars[bars.length - 1].t;
    var avgInterval = Math.round((lastT - bars[0].t) / (bars.length - 1));
    if (avgInterval < 1) avgInterval = 60;

    for (var i = 0; i < bars.length; i++) {
      var b = bars[i];

      for (var fi = 0; fi < list.length; fi++) {
        var f = list[fi];
        if (f.closed) continue;
        if (f.type === 'bull' && b.c < f.level) { f.closed = true; f.closeTime = b.t; }
        if (f.type === 'bear' && b.c > f.level) { f.closed = true; f.closeTime = b.t; }
      }

      if (i >= 1) {
        var prev = bars[i - 1];

        if (b.l < prev.l && b.c > prev.l) {
          list.push({ type: 'bull', level: prev.l, t0: b.t, color: cfg.bullishColor, closed: false });
        }

        if (b.h > prev.h && b.c < prev.h) {
          list.push({ type: 'bear', level: prev.h, t0: b.t, color: cfg.bearishColor, closed: false });
        }
      }
    }

    if (cfg.showLastOnly) {
      var lastBull = null, lastBear = null;
      for (var a = list.length - 1; a >= 0; a--) {
        if (!list[a].closed) {
          if (!lastBull && list[a].type === 'bull') lastBull = list[a];
          if (!lastBear && list[a].type === 'bear') lastBear = list[a];
        }
        if (lastBull && lastBear) break;
      }
      var filtered = [];
      for (var b2 = 0; b2 < list.length; b2++) {
        var z = list[b2];
        if (!z.closed && z !== lastBull && z !== lastBear) continue;
        filtered.push(z);
      }
      list = filtered;
    }

    var shapes = [];
    for (var si = 0; si < list.length; si++) {
      var z = list[si];
      if (z.closed && !cfg.showMitigated) continue;

      var rayEnd = cfg.rayLength > 0 ? z.t0 + avgInterval * cfg.rayLength : lastT;
      var endTime = z.closed ? Math.min(z.closeTime, rayEnd) : rayEnd;

      shapes.push({
        points: [
          { time: z.t0,    price: z.level },
          { time: endTime, price: z.level },
        ],
        color:        z.color,
        shape:        'trend_line',
        lock:         true,
        zOrder:       'bottom',
        linewidth:    cfg.lineWidth,
        linestyle:    linestyle,
        transparency: z.closed ? 60 : 0,
      });
    }

    return shapes;
  },

});
