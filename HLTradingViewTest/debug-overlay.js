/**
 * Debug Overlay — универсальная debug-консоль
 *
 * Включение:
 *   localStorage.setItem('debug_overlay', '1') + reload
 *   Ctrl+Shift+D — toggle
 *   DebugOverlay.show() — из консоли
 *
 * Перехватывает (когда включён):
 *   console.log/warn/error/info/debug
 *   fetch запросы (метод, URL, статус, время)
 *   window.onerror / unhandledrejection
 *
 * API (window.DebugOverlay):
 *   .log/.warn/.error/.info(msg)
 *   .dump(label, obj)
 *   .time(label) / .timeEnd(label)
 *   .clear()
 *   .filter(text)
 *   .show() / .hide() / .toggle()
 *   .startCapture() / .stopCapture()
 *
 * Фичи: перетаскивание, сворачивание, авто-копирование, JS eval,
 *        история команд (↑↓), фильтр, счётчик, пауза, Ctrl+Shift+D
 *
 * Настройки (DebugOverlay.config):
 *   .captureConsole = true
 *   .captureFetch   = true
 *   .captureErrors  = true
 *   .maxLines       = 500
 *   .fetchFilter    = null   — RegExp или null (все)
 */
(function() {
    'use strict';

    var LS_KEY = 'debug_overlay';
    var LS_POS = 'debug_overlay_pos';
    var MAX_LINES = 500;

    var COLORS = { log:'#0f0', info:'#0af', warn:'#ff0', error:'#f44', debug:'#888', fetch:'#c8f', time:'#fa0' };

    // ── DOM ────────────────────────────────────────────────────────────
    var el = document.createElement('div');
    el.id = 'debug-overlay';
    el.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:99999;font:11px/1.5 "SF Mono",Monaco,Consolas,monospace;pointer-events:all;display:none;width:560px;';
    try { var sp=JSON.parse(localStorage.getItem(LS_POS)); if(sp&&sp.left){el.style.left=sp.left;el.style.top=sp.top;el.style.right='auto';el.style.bottom='auto';} } catch(_){}

    // Header
    var hdr = document.createElement('div');
    hdr.style.cssText = 'background:#1a1a1a;color:#0f0;padding:4px 8px;cursor:move;display:flex;justify-content:space-between;align-items:center;border:1px solid #333;border-bottom:none;border-radius:6px 6px 0 0;';
    hdr.innerHTML = '<span style="font-weight:bold">🔧 Debug Console</span><span style="display:flex;gap:2px;align-items:center;">' +
        '<input id="dbg-f" placeholder="filter..." style="background:#111;border:1px solid #333;color:#0f0;font:10px monospace;padding:1px 4px;width:80px;border-radius:3px;"/>' +
        '<span style="color:#555;margin:0 4px" id="dbg-n">0</span>' +
        '<button class="dbg-b" data-a="pause" title="Pause">⏸</button>' +
        '<button class="dbg-b" data-a="clear" title="Clear">⌫</button>' +
        '<button class="dbg-b" data-a="min" title="Collapse">−</button>' +
        '<button class="dbg-b" data-a="close" title="Close">✕</button></span>';

    // Body
    var bod = document.createElement('div');
    bod.style.cssText = 'background:rgba(0,0,0,0.92);padding:0;max-height:400px;overflow:auto;border:1px solid #333;user-select:text;cursor:text;';

    // Input bar
    var inp = document.createElement('div');
    inp.style.cssText = 'border:1px solid #333;border-top:none;border-radius:0 0 6px 6px;display:flex;background:#0a0a0a;';
    inp.innerHTML = '<span style="color:#0af;padding:3px 6px">›</span><input id="dbg-i" style="flex:1;background:transparent;border:none;color:#0f0;font:11px monospace;padding:3px 4px;outline:none" placeholder="JS expression..."/>';

    // Styles
    var css = document.createElement('style');
    css.textContent = '.dbg-b{background:none;border:1px solid #333;color:#999;cursor:pointer;font:11px monospace;padding:1px 5px;border-radius:3px;margin:0 1px}.dbg-b:hover{color:#fff;border-color:#666}#debug-overlay .dbg-line{padding:1px 8px;border-bottom:1px solid #1a1a1a;word-break:break-all}';
    document.head.appendChild(css);

    el.appendChild(hdr); el.appendChild(bod); el.appendChild(inp);
    document.body.appendChild(el);

    // ── State ──────────────────────────────────────────────────────────
    var lines=[], count=0, paused=false, mini=false, filterTxt='';
    var timers={}, origCon={}, origFetch=null;

    // ── Drag ───────────────────────────────────────────────────────────
    var drag=false,dx,dy;
    hdr.addEventListener('mousedown',function(e){if(e.target.tagName==='BUTTON'||e.target.tagName==='INPUT')return;drag=true;dx=e.clientX-el.getBoundingClientRect().left;dy=e.clientY-el.getBoundingClientRect().top;e.preventDefault();});
    document.addEventListener('mousemove',function(e){if(!drag)return;el.style.left=(e.clientX-dx)+'px';el.style.top=(e.clientY-dy)+'px';el.style.right='auto';el.style.bottom='auto';});
    document.addEventListener('mouseup',function(){if(!drag)return;drag=false;try{localStorage.setItem(LS_POS,JSON.stringify({left:el.style.left,top:el.style.top}));}catch(_){}});

    // ── Header buttons ────────────────────────────────────────────────
    hdr.addEventListener('click',function(e){
        var a=e.target.dataset&&e.target.dataset.a; if(!a)return;
        if(a==='close') api.hide();
        if(a==='clear') api.clear();
        if(a==='pause'){paused=!paused;e.target.textContent=paused?'▶':'⏸';e.target.title=paused?'Resume':'Pause';}
        if(a==='min'){mini=!mini;bod.style.display=mini?'none':'block';inp.style.display=mini?'none':'flex';e.target.textContent=mini?'+':'−';}
    });
    hdr.querySelector('#dbg-f').addEventListener('input',function(){filterTxt=this.value.toLowerCase();rerender();});

    // ── Auto-copy ─────────────────────────────────────────────────────
    bod.addEventListener('mouseup',function(){
        var s=window.getSelection(),t=s?s.toString().trim():''; if(!t)return;
        navigator.clipboard.writeText(t).then(function(){
            var f=document.createElement('div');f.textContent='📋 Copied!';
            f.style.cssText='position:absolute;top:-18px;right:8px;background:#0f0;color:#000;font:bold 10px monospace;padding:1px 6px;border-radius:3px;';
            el.appendChild(f);setTimeout(function(){f.remove();},700);
        }).catch(function(){});
    });

    // ── Eval input ────────────────────────────────────────────────────
    var cmdHist=[],cmdIdx=-1;
    var inpEl=inp.querySelector('#dbg-i');
    inpEl.addEventListener('keydown',function(e){
        if(e.key==='Enter'){var c=this.value.trim();if(!c)return;cmdHist.unshift(c);cmdIdx=-1;add('info','› '+c);try{add('log',str(eval(c)));}catch(er){add('error',er.message);}this.value='';}
        if(e.key==='ArrowUp'){e.preventDefault();cmdIdx=Math.min(cmdIdx+1,cmdHist.length-1);this.value=cmdHist[cmdIdx]||'';}
        if(e.key==='ArrowDown'){e.preventDefault();cmdIdx=Math.max(cmdIdx-1,-1);this.value=cmdIdx>=0?cmdHist[cmdIdx]:'';}
    });

    // ── Ctrl+Shift+D ──────────────────────────────────────────────────
    document.addEventListener('keydown',function(e){if(e.ctrlKey&&e.shiftKey&&e.code==='KeyD'){e.preventDefault();api.toggle();}});

    // ── Core ──────────────────────────────────────────────────────────
    function str(v){
        if(v===undefined)return'undefined';if(v===null)return'null';
        if(typeof v==='function')return v.toString().substring(0,80)+'…';
        if(typeof v==='object'){try{return JSON.stringify(v,null,1);}catch(_){return String(v);}}
        return String(v);
    }
    function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
    function ts(){var d=new Date();return('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2)+':'+('0'+d.getSeconds()).slice(-2)+'.'+('00'+d.getMilliseconds()).slice(-3);}

    function add(type,text){
        if(paused)return;
        var entry={type:type,text:String(text),time:ts()};
        lines.push(entry); count++;
        if(lines.length>MAX_LINES)lines.shift();
        hdr.querySelector('#dbg-n').textContent=count;
        if(!filterTxt||entry.text.toLowerCase().indexOf(filterTxt)!==-1) appendDOM(entry);
    }

    function appendDOM(e){
        var d=document.createElement('div');d.className='dbg-line';
        d.style.color=COLORS[e.type]||'#0f0';
        d.innerHTML='<span style="color:#555;margin-right:6px">'+e.time+'</span>'+esc(e.text);
        bod.appendChild(d);
        if(bod.scrollHeight-bod.scrollTop-bod.clientHeight<60)bod.scrollTop=bod.scrollHeight;
    }

    function rerender(){bod.innerHTML='';lines.forEach(function(e){if(!filterTxt||e.text.toLowerCase().indexOf(filterTxt)!==-1)appendDOM(e);});}

    // ── Console capture ───────────────────────────────────────────────
    function hookConsole(){
        ['log','warn','error','info','debug'].forEach(function(m){
            origCon[m]=console[m];
            console[m]=function(){origCon[m].apply(console,arguments);add(m==='log'?'log':m,Array.prototype.map.call(arguments,function(a){return str(a);}).join(' '));};
        });
    }
    function unhookConsole(){Object.keys(origCon).forEach(function(m){console[m]=origCon[m];});origCon={};}

    // ── Fetch capture ─────────────────────────────────────────────────
    function hookFetch(){
        origFetch=window.fetch;
        window.fetch=function(url,opts){
            var method=(opts&&opts.method)||'GET';
            var u=typeof url==='string'?url:(url.url||String(url));
            var short=u.replace(/^https?:\/\/[^\/]+/,'');
            if(api.config.fetchFilter&&!api.config.fetchFilter.test(u))return origFetch.apply(window,arguments);
            var t0=performance.now();
            add('fetch','→ '+method+' '+short);
            return origFetch.apply(window,arguments).then(function(r){
                var dt=Math.round(performance.now()-t0);
                add(r.status>=400?'error':'fetch','← '+r.status+' '+short+' ('+dt+'ms)');
                return r;
            }).catch(function(err){
                add('error','← FAIL '+short+' '+err.message);
                throw err;
            });
        };
    }
    function unhookFetch(){if(origFetch){window.fetch=origFetch;origFetch=null;}}

    // ── Error capture ─────────────────────────────────────────────────
    function hookErrors(){
        window.addEventListener('error',function(e){add('error','💥 '+e.message+' @ '+(e.filename||'').split('/').pop()+':'+e.lineno);});
        window.addEventListener('unhandledrejection',function(e){add('error','💥 Unhandled: '+(e.reason&&e.reason.message||e.reason||'unknown'));});
    }

    // ── Public API ────────────────────────────────────────────────────
    var api = {
        config: { captureConsole:true, captureFetch:true, captureErrors:true, maxLines:MAX_LINES, fetchFilter:null },

        show:    function(){el.style.display='block';localStorage.setItem(LS_KEY,'1');},
        hide:    function(){el.style.display='none';localStorage.removeItem(LS_KEY);},
        toggle:  function(){el.style.display==='none'?api.show():api.hide();},
        clear:   function(){lines=[];count=0;bod.innerHTML='';hdr.querySelector('#dbg-n').textContent='0';},

        log:   function(msg){add('log',msg);},
        info:  function(msg){add('info',msg);},
        warn:  function(msg){add('warn',msg);},
        error: function(msg){add('error',msg);},
        dump:  function(label,obj){add('log',label+': '+str(obj));},

        time:    function(label){timers[label]=performance.now();},
        timeEnd: function(label){
            if(!timers[label]){add('warn','timer "'+label+'" not found');return;}
            add('time','⏱ '+label+': '+(performance.now()-timers[label]).toFixed(1)+'ms');
            delete timers[label];
        },

        filter: function(text){filterTxt=(text||'').toLowerCase();hdr.querySelector('#dbg-f').value=text||'';rerender();},

        startCapture: function(){
            if(api.config.captureConsole)hookConsole();
            if(api.config.captureFetch)hookFetch();
            if(api.config.captureErrors)hookErrors();
            add('info','🔧 Capture started');
        },
        stopCapture: function(){unhookConsole();unhookFetch();add('info','Capture stopped');}
    };

    window.DebugOverlay = api;

    // ── Auto-start ────────────────────────────────────────────────────
    if(localStorage.getItem(LS_KEY)==='1'){
        api.show();
        api.startCapture();
        add('info','🔧 Debug Overlay — Ctrl+Shift+D to toggle');
    }
})();
