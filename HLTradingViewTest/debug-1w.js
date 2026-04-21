(function() {
    var overlay = document.createElement('div');
    overlay.id = 'debug-1w-overlay';
    overlay.style.cssText = 'position:fixed;bottom:10px;right:10px;background:rgba(0,0,0,0.85);color:#0f0;font:11px monospace;padding:10px;z-index:99999;max-width:500px;max-height:400px;overflow:auto;border:1px solid #0f0;pointer-events:all;user-select:text;cursor:text;';
    document.body.appendChild(overlay);

    overlay.addEventListener('mouseup', function() {
        var sel = window.getSelection();
        var text = sel ? sel.toString().trim() : '';
        if (text) {
            navigator.clipboard.writeText(text).then(function() {
                var flash = document.createElement('div');
                flash.textContent = 'Copied!';
                flash.style.cssText = 'position:fixed;bottom:415px;right:10px;background:#0f0;color:#000;font:bold 11px monospace;padding:3px 8px;z-index:100000;border-radius:3px;';
                document.body.appendChild(flash);
                setTimeout(function() { flash.remove(); }, 800);
            }).catch(function() {});
        }
    });

    function log(msg) {
        overlay.innerHTML += msg + '<br>';
        console.log('[DEBUG-1W] ' + msg);
    }

    // Wait for datafeed to be FULLY initialized (intervals loaded)
    var checkInterval = setInterval(function() {
        var df = window.app && window.app.datafeed;
        if (!df) return;
        if (!df.intervals || df.intervals.length === 0) return; // wait for initialize()
        clearInterval(checkInterval);

        log('=== DATAFEED STATE ===');
        log('supportedResolutions: ' + JSON.stringify(df.supportedResolutions));
        log('intervals count: ' + df.intervals.length);
        
        df.intervals.forEach(function(i) {
            if (['1W','1M','W','M','1D','30S','1T'].indexOf(i.tradingview_code) !== -1) {
                log('  ' + i.code + ' → tv:' + i.tradingview_code + ' → ' + i.clickhouse_table);
            }
        });

        var symbols = df.symbols;
        if (symbols && symbols.size > 0) {
            var first = symbols.values().next().value;
            log('symbol.supported_resolutions: ' + JSON.stringify(first.supported_resolutions));
            log('has_weekly_and_monthly: ' + first.has_weekly_and_monthly);
        }

        // Patch getBars for 1W/1M logging
        var origGetBars = df.getBars.bind(df);
        df.getBars = function(si, res, pp, onOk, onErr) {
            if (res === '1W' || res === '1M' || res === 'W' || res === 'M') {
                log('getBars: res=' + res + ' table=' + df.getClickHouseTable(res) + ' sec=' + df.getIntervalSeconds(res));
            }
            return origGetBars(si, res, pp, function(bars, meta) {
                if (res === '1W' || res === '1M') {
                    log('  → OK: ' + bars.length + ' bars');
                }
                onOk(bars, meta);
            }, function(err) {
                if (res === '1W' || res === '1M') {
                    log('  → ERROR: ' + err);
                }
                onErr(err);
            });
        };

        log('=== READY ===');
    }, 300);
})();
