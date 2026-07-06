/**
 * setups-backtest-ext.js  v1.1
 *
 * Расширение setups-backtest.js. Подключается ПОСЛЕ него.
 *
 * Исправлено v1.1:
 *  - убран MutationObserver (причина зависания)
 *  - исправлен insertBefore (hideBtn не прямой потомок toolbar)
 *  - фильтры и кнопки вставляются один раз через tab-click перехват
 *
 * Задачи:
 *  1. Синхронизация replay и таблиц по датам
 *  2. Tooltip на статусах сетапов
 *  3. Фильтрация в таблице сетапов
 *  4. Разворот на весь экран / свернуть
 *  5. Плавающее перемещаемое окно
 *  6. Вкладка «📈 Strategy» — итоги по каждому сетапу
 *  7. Менеджер множества сетапов
 */

(function () {
    'use strict';

    // ─────────────────────────────────────────────────────────────────────────
    // ЖДЁМ ГОТОВНОСТИ setups-backtest.js
    // ─────────────────────────────────────────────────────────────────────────

    let _sbBody  = null;   // #sb-tab-body
    let _tabbar  = null;   // #sb-tabbar
    let _panel   = null;   // #dt-panel

    function waitReady(cb) {
        let n = 0;
        const t = setInterval(() => {
            if (++n > 300) { clearInterval(t); return; }
            const panel  = document.getElementById('dt-panel');
            const tabbar = document.getElementById('sb-tabbar');
            const sbBody = document.getElementById('sb-tab-body');
            if (panel && tabbar && sbBody) {
                clearInterval(t);
                _panel  = panel;
                _tabbar = tabbar;
                _sbBody = sbBody;
                cb();
            }
        }, 150);
    }

    waitReady(() => {
        patchTabClicks();
        addPanelControls();
        installReplaySync();
        injectExtCSS();
        injectTooltip();
        console.log('[SB-ext] v1.1 ready');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 1. СИНХРОНИЗАЦИЯ REPLAY
    // ─────────────────────────────────────────────────────────────────────────

    let _replayCursor = null;

    function installReplaySync() {
        let n = 0;
        const t = setInterval(() => {
            if (++n > 100) { clearInterval(t); return; }
            const bp = window.backtestPlayer;
            if (!bp || bp._extSyncDone) { if (bp) clearInterval(t); return; }
            clearInterval(t);
            bp._extSyncDone = true;

            const _next  = bp.next;
            const _prev  = bp.prev;
            const _exit  = bp.exit;
            const _start = bp.start;

            bp.next  = function (...a) { const r = _next?.(...a);  _updateCursor(); return r; };
            bp.prev  = function (...a) { const r = _prev?.(...a);  _updateCursor(); return r; };
            bp.start = function (...a) { const r = _start?.(...a); _updateCursor(); return r; };
            bp.exit  = function (...a) {
                _replayCursor = null;
                _refreshActiveExtTab();
                return _exit?.(...a);
            };
            console.log('[SB-ext] replay sync installed');
        }, 200);
    }

    function _updateCursor() {
        const ad = window.app?.activedata;
        if (!ad?.length) { _replayCursor = null; return; }
        _replayCursor = new Date(ad[ad.length - 1].timestamp).getTime();
        _refreshActiveExtTab();
    }

    function _refreshActiveExtTab() {
        const activeBtn = _tabbar?.querySelector('.sb-tab.sb-tab-active');
        const tab = activeBtn?.dataset?.tab;
        if (!_sbBody) return;
        if (tab === 'setups')   _refreshSetupsBody();
        if (tab === 'strategy') renderStrategyTab(_sbBody);
    }

    function filterByReplay(signals) {
        if (_replayCursor === null) return signals;
        return signals.filter(s => new Date(s.bar.timestamp).getTime() <= _replayCursor);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ПЕРЕХВАТ КЛИКОВ ПО ВКЛАДКАМ
    // Делегирование на tabbar — без MutationObserver
    // ─────────────────────────────────────────────────────────────────────────

    const EXT_FILTER = { status: 'all', dir: 'all', search: '' };
    let   _filterBarInjected = false;
    let   _manageBtnInjected = false;

    function patchTabClicks() {
        _tabbar.addEventListener('click', e => {
            const btn = e.target.closest('.sb-tab');
            if (!btn) return;
            const tab = btn.dataset.tab;

            // Показываем/скрываем ext-панели
            const extBar = document.getElementById('sb-ext-filterbar');
            if (extBar) extBar.style.display = tab === 'setups' ? 'flex' : 'none';

            if (tab === 'strategy') {
                setTimeout(() => renderStrategyTab(_sbBody), 20);
            }

            if (tab === 'setups') {
                // Инжектируем filter bar один раз, потом только показываем
                setTimeout(() => {
                    _ensureFilterBar();
                    _ensureManageBtn();
                    // Обновляем данные в таблице с нашими фильтрами
                    _refreshSetupsBody();
                }, 80);
            }
        }, true); // capture = true чтобы поймать до оригинальных обработчиков

        // Добавляем вкладку Strategy
        const stratBtn = document.createElement('button');
        stratBtn.className = 'sb-tab sb-tab-strat';
        stratBtn.dataset.tab = 'strategy';
        stratBtn.textContent = '📈 Strategy';
        _tabbar.appendChild(stratBtn);

        // Обработчик для Strategy (оригинальные обработчики не знают об этой вкладке)
        stratBtn.addEventListener('click', () => {
            _tabbar.querySelectorAll('.sb-tab').forEach(b => b.classList.remove('sb-tab-active'));
            stratBtn.classList.add('sb-tab-active');
            const twrap = _panel.querySelector('#dt-twrap');
            if (twrap) twrap.style.display = 'none';
            _sbBody.style.display = 'flex';
            _sbBody.style.flexDirection = 'column';
            renderStrategyTab(_sbBody);
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. ПАНЕЛЬ ФИЛЬТРОВ (инжектируется один раз в panel, не в sbBody)
    // ─────────────────────────────────────────────────────────────────────────

    function _ensureFilterBar() {
        if (document.getElementById('sb-ext-filterbar')) return;

        const bar = document.createElement('div');
        bar.id = 'sb-ext-filterbar';
        bar.style.cssText = [
            'display:flex', 'align-items:center', 'gap:5px',
            'padding:3px 10px', 'background:#060810',
            'border-bottom:1px solid #141826',
            'flex-shrink:0', 'flex-wrap:wrap',
        ].join(';');

        bar.innerHTML = `
            <span style="font-size:10px;color:#3a4060;font-weight:700;text-transform:uppercase;letter-spacing:.4px">Filter:</span>
            <select class="sb-sel" id="sb-flt-status" style="font-size:10px">
                <option value="all">All statuses</option>
                <option value="1">1 — Entry</option>
                <option value="2">2 — Hold</option>
                <option value="3">3 — Exit TP</option>
                <option value="4">4 — Exit SL</option>
                <option value="5">5+ — Custom</option>
            </select>
            <select class="sb-sel" id="sb-flt-dir" style="font-size:10px">
                <option value="all">All dirs</option>
                <option value="long">Long</option>
                <option value="short">Short</option>
            </select>
            <input class="sb-inp" id="sb-flt-search" placeholder="Search setup…"
                style="font-size:10px;width:120px">
            <button class="sb-btn" id="sb-flt-clear" style="font-size:10px">✕ Clear</button>
            <span id="sb-flt-replay" style="font-size:10px;color:#f5a623;display:none">⏱ Replay sync ON</span>
        `;

        // Вставляем сразу после tabbar в panel
        const tabbar = document.getElementById('sb-tabbar');
        if (tabbar && tabbar.parentNode === _panel) {
            tabbar.insertAdjacentElement('afterend', bar);
        } else {
            _panel.appendChild(bar);
        }

        bar.querySelector('#sb-flt-status')?.addEventListener('change', e => {
            EXT_FILTER.status = e.target.value; _refreshSetupsBody();
        });
        bar.querySelector('#sb-flt-dir')?.addEventListener('change', e => {
            EXT_FILTER.dir = e.target.value; _refreshSetupsBody();
        });
        bar.querySelector('#sb-flt-search')?.addEventListener('input', e => {
            EXT_FILTER.search = e.target.value.toLowerCase(); _refreshSetupsBody();
        });
        bar.querySelector('#sb-flt-clear')?.addEventListener('click', () => {
            EXT_FILTER.status = 'all';
            EXT_FILTER.dir = 'all';
            EXT_FILTER.search = '';
            bar.querySelector('#sb-flt-status').value = 'all';
            bar.querySelector('#sb-flt-dir').value = 'all';
            bar.querySelector('#sb-flt-search').value = '';
            _refreshSetupsBody();
        });
    }

    function _ensureManageBtn() {
        // Кнопка «⚙ Setups» в toolbar оригинального setups-tab
        if (document.getElementById('sb-manage-btn')) return;

        // Ищем кнопку Register в sb-toolbar (она должна быть в sbBody)
        const sbToolbar = _sbBody.querySelector('.sb-toolbar');
        if (!sbToolbar) return;

        const btn = document.createElement('button');
        btn.id = 'sb-manage-btn';
        btn.className = 'sb-btn';
        btn.textContent = '⚙ Setups';
        btn.style.cssText = 'font-size:10px;border-color:#f5a62344;color:#f5a623';
        sbToolbar.appendChild(btn);
        btn.addEventListener('click', openSetupsManagerDialog);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ОБНОВЛЕНИЕ TBODY В SETUPS TAB (только данные, не весь рендер)
    // ─────────────────────────────────────────────────────────────────────────

    function _refreshSetupsBody() {
        const tbody = _sbBody.querySelector('.sb-tbl tbody');
        if (!tbody) return;

        // Обновляем индикатор replay
        const replayTag = document.getElementById('sb-flt-replay');
        if (replayTag) replayTag.style.display = _replayCursor !== null ? 'inline' : 'none';

        const defs    = window.app?.setups || {};
        const allSigs = _runScan();
        const filtered = _applyExtFilters(allSigs);

        // Обновляем счётчик
        const cnt = _sbBody.querySelector('.sb-cnt');
        if (cnt) cnt.textContent = `${filtered.length} of ${allSigs.length} signals · ${window.app?.activedata?.length || 0} bars`;

        const PAGE  = 200;
        const slice = filtered.slice(0, PAGE);
        const prevLen = parseInt(tbody.dataset.prevLen || '0');
        tbody.dataset.prevLen = String(slice.length);

        if (!slice.length) {
            tbody.innerHTML = `<tr><td colspan="9" class="sb-empty">No signals match filters.</td></tr>`;
            return;
        }

        tbody.innerHTML = slice.map(s => {
            const d    = new Date(s.bar.timestamp).toISOString().replace('T', ' ').slice(0, 16);
            const def  = defs[s.setupName];
            const dir  = def?.dir || '';
            const tsMs = new Date(s.bar.timestamp).getTime();
            return `<tr class="sb-sig-row sb-st${s.status}" data-ts="${tsMs}">
                <td>${d}</td>
                <td>
                    <span class="sb-badge">${esc(s.setupName)}</span>
                    <span class="sb-mono">.${esc(s.col)}</span>
                    ${dir ? `<span class="sb-dir sb-dir-${dir}" style="font-size:9px;margin-left:3px">${dir}</span>` : ''}
                </td>
                <td>${_stLabelExt(s.status, def)}</td>
                <td>${fmtP(s.bar.open)}</td>
                <td>${fmtP(s.bar.high)}</td>
                <td>${fmtP(s.bar.low)}</td>
                <td>${fmtP(s.bar.close)}</td>
                <td>${s.barIdx + 1}</td>
                <td><button class="sb-goto" data-ts="${tsMs}">→</button></td>
            </tr>`;
        }).join('');

        // Скролл к новой строке при replay
        if (_replayCursor !== null && slice.length > prevLen) {
            setTimeout(() => {
                const rows = tbody.querySelectorAll('tr');
                rows[rows.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }, 50);
        }

        tbody.querySelectorAll('.sb-goto').forEach(b =>
            b.addEventListener('click', e => { e.stopPropagation(); _gotoBar(+b.dataset.ts); }));
        tbody.querySelectorAll('.sb-sig-row').forEach(r =>
            r.addEventListener('click', () => _gotoBar(+r.dataset.ts)));
    }

    function _applyExtFilters(signals) {
        let r = filterByReplay(signals);

        if (EXT_FILTER.status !== 'all') {
            const sv = parseInt(EXT_FILTER.status);
            r = sv === 5 ? r.filter(s => s.status >= 5) : r.filter(s => s.status === sv);
        }
        if (EXT_FILTER.dir !== 'all') {
            const defs = window.app?.setups || {};
            r = r.filter(s => {
                const def = defs[s.setupName];
                return def ? def.dir === EXT_FILTER.dir : true;
            });
        }
        if (EXT_FILTER.search) {
            r = r.filter(s =>
                s.setupName.toLowerCase().includes(EXT_FILTER.search) ||
                s.col.toLowerCase().includes(EXT_FILTER.search)
            );
        }
        return r;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. TOOLTIP НА СТАТУСАХ
    // ─────────────────────────────────────────────────────────────────────────

    const STATUS_TIPS = {
        1: 'Entry signal — bar where setup triggers a trade entry',
        2: 'Hold — position is open, no exit signal yet',
        3: 'Exit Rule 1 — typically Take Profit hit',
        4: 'Exit Rule 2 — typically Stop Loss hit',
        5: 'Custom exit rule 5',
        6: 'Custom exit rule 6',
    };

    function injectTooltip() {
        let tip = document.getElementById('sb-ext-tooltip');
        if (!tip) {
            tip = document.createElement('div');
            tip.id = 'sb-ext-tooltip';
            tip.className = 'sb-ext-tooltip';
            document.body.appendChild(tip);
        }

        document.addEventListener('mouseover', e => {
            const el = e.target.closest('.sb-st');
            if (!el) return;
            const status = el.dataset.status;
            const text   = STATUS_TIPS[parseInt(status)] || el.title || '';
            if (!text) return;
            tip.textContent = text;
            tip.style.display = 'block';
        });
        document.addEventListener('mousemove', e => {
            tip.style.left = (e.clientX + 12) + 'px';
            tip.style.top  = (e.clientY - 8)  + 'px';
        });
        document.addEventListener('mouseout', e => {
            if (e.target.closest('.sb-st')) return;
            tip.style.display = 'none';
        });
    }

    function _stLabelExt(v, def) {
        const rule = (def?.exitRules || []).find(r => r.status === v);
        const txt  = rule ? rule.label
            : v === 1 ? 'Entry' : v === 2 ? 'Hold' : v >= 3 ? `Exit ${v}` : String(v);
        const cls  = v === 1 ? 'sb-st-entry' : v === 2 ? 'sb-st-hold' : 'sb-st-exit';
        const tip  = STATUS_TIPS[v] || (rule ? `Exit: ${rule.label}` : '');
        return `<span class="sb-st ${cls}" data-status="${v}" title="${esc(tip)}">${esc(txt)}</span>`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4+5. FULLSCREEN И FLOATING WINDOW
    // ─────────────────────────────────────────────────────────────────────────

    let _isFullscreen = false;
    let _isFloat      = false;
    let _savedStyles  = {};

    function addPanelControls() {
        let n = 0;
        const t = setInterval(() => {
            if (++n > 50) { clearInterval(t); return; }
            const toolbar = document.getElementById('dt-toolbar');
            if (!toolbar) return;
            clearInterval(t);

            if (document.getElementById('sb-panel-ctrls')) return;

            const wrap = document.createElement('span');
            wrap.id = 'sb-panel-ctrls';
            wrap.style.cssText = 'display:inline-flex;gap:3px;align-items:center;margin-left:4px';
            wrap.innerHTML = `
                <button class="dt-btn" id="sb-btn-fullscreen" title="Fullscreen / Restore">⛶</button>
                <button class="dt-btn" id="sb-btn-float"      title="Float window">⧉</button>
            `;

            // Безопасная вставка — просто appendChild в toolbar
            toolbar.appendChild(wrap);

            wrap.querySelector('#sb-btn-fullscreen')?.addEventListener('click', toggleFullscreen);
            wrap.querySelector('#sb-btn-float')?.addEventListener('click', toggleFloat);
        }, 200);
    }

    function toggleFullscreen() {
        const panel = document.getElementById('dt-panel');
        if (!panel) return;
        _isFullscreen = !_isFullscreen;
        const btn = document.getElementById('sb-btn-fullscreen');

        if (_isFullscreen) {
            _savedStyles = {
                position: panel.style.position, top: panel.style.top,
                left: panel.style.left, width: panel.style.width,
                height: panel.style.height, zIndex: panel.style.zIndex,
            };
            Object.assign(panel.style, {
                position: 'fixed', top: '0', left: '0',
                width: '100vw', height: '100vh', zIndex: '99999',
            });
            if (btn) { btn.textContent = '⊠'; btn.style.color = '#2962FF'; }
        } else {
            Object.assign(panel.style, _savedStyles);
            if (btn) { btn.textContent = '⛶'; btn.style.color = ''; }
        }

        setTimeout(() => {
            window.dataTable?.refresh?.();
            _refreshActiveExtTab();
        }, 50);
    }

    function toggleFloat() {
        const panel = document.getElementById('dt-panel');
        if (!panel) return;
        _isFloat = !_isFloat;
        const btn = document.getElementById('sb-btn-float');

        if (_isFloat) {
            _savedStyles = {
                position: panel.style.position, top: panel.style.top,
                left: panel.style.left, width: panel.style.width,
                height: panel.style.height, zIndex: panel.style.zIndex,
                resize: panel.style.resize, overflow: panel.style.overflow,
                boxShadow: panel.style.boxShadow, borderRadius: panel.style.borderRadius,
            };
            Object.assign(panel.style, {
                position: 'fixed', top: '80px', left: '40px',
                width: '700px', height: '400px', zIndex: '99998',
                resize: 'both', overflow: 'hidden',
                boxShadow: '0 24px 80px rgba(0,0,0,.85)',
                borderRadius: '8px',
            });
            panel.classList.add('sb-float-panel');
            _makeDraggable(panel, document.getElementById('dt-toolbar'));
            if (btn) { btn.title = 'Dock back'; btn.style.color = '#2962FF'; }
        } else {
            Object.assign(panel.style, _savedStyles);
            panel.classList.remove('sb-float-panel');
            _removeDraggable(panel);
            if (btn) { btn.title = 'Float window'; btn.style.color = ''; }
        }

        setTimeout(() => {
            window.dataTable?.refresh?.();
            _refreshActiveExtTab();
        }, 50);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. ВКЛАДКА STRATEGY
    // ─────────────────────────────────────────────────────────────────────────

    function renderStrategyTab(container) {
        const setups  = window.app?.setups || {};
        const signals = _runScan();

        if (!signals.length) {
            container.innerHTML = `
                <div class="sb-empty-big">
                    <div class="sb-empty-ico">📈</div>
                    <div>Scan setups or run backtest to see strategy stats</div>
                    <div style="font-size:10px;color:#3a4060;margin-top:4px">
                        Click the Setups tab → Scan, then come back here
                    </div>
                </div>`;
            return;
        }

        // Статистика сигналов по сетапам
        const sigStats = {};
        signals.forEach(s => {
            if (!sigStats[s.setupName]) sigStats[s.setupName] = { total: 0, byStatus: {}, firstDate: null, lastDate: null };
            const ss = sigStats[s.setupName];
            ss.total++;
            ss.byStatus[s.status] = (ss.byStatus[s.status] || 0) + 1;
            const d = new Date(s.bar.timestamp);
            if (!ss.firstDate || d < ss.firstDate) ss.firstDate = d;
            if (!ss.lastDate  || d > ss.lastDate)  ss.lastDate  = d;
        });

        // Статистика трейдов из backtest journal
        const tradeStats = _getTradeStats();

        const allNames = [...new Set([...Object.keys(sigStats), ...Object.keys(tradeStats)])];

        container.innerHTML = `
            <div class="sb-toolbar" style="flex-shrink:0">
                <span class="sb-title">📈 Strategy Overview</span>
                <span class="sb-cnt">${allNames.length} strategies · ${signals.length} signals</span>
            </div>
            <div style="flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:10px">
                ${allNames.map(name => {
                    const ss  = sigStats[name]  || null;
                    const ts  = tradeStats[name] || null;
                    const def = setups[name];

                    return `<div class="sb-strat-card">
                        <div class="sb-strat-hdr">
                            <span class="sb-strat-name">${esc(name)}</span>
                            ${def?.dir ? `<span class="sb-dir sb-dir-${def.dir}" style="font-size:9px">${def.dir}</span>` : ''}
                            ${def?.column ? `<span class="sb-strat-col">col: ${esc(def.column)}</span>` : ''}
                        </div>
                        <div class="sb-strat-body">

                            ${ts ? `
                            <div class="sb-strat-grid">
                                ${_statCard('Trades',    ts.total)}
                                ${_statCard('Win Rate',  ts.winRate + '%',  parseFloat(ts.winRate) >= 50 ? '#4caf50' : '#ef5350')}
                                ${_statCard('Net PnL',   '$' + ts.pnl,      ts.pnl >= 0 ? '#4caf50' : '#ef5350')}
                                ${_statCard('W / L',     ts.wins + ' / ' + ts.losses)}
                                ${_statCard('Best',      '$' + ts.maxWin,   '#4caf50')}
                                ${_statCard('Worst',     '$' + ts.maxLoss,  '#ef5350')}
                                ${_statCard('Avg Bars',  ts.avgBars)}
                                ${_statCard('Period',    ts.period, '', true)}
                            </div>
                            <div class="sb-strat-exits">
                                ${Object.entries(ts.byExit).map(([r, c]) =>
                                    `<span class="sb-xtag sb-x-${r.toLowerCase()}">${r}: ${c}</span>`
                                ).join('')}
                            </div>
                            ` : ''}

                            ${ss ? `
                            <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-top:${ts?'6':'0'}px">
                                <span style="font-size:10px;color:#3a4060">Signals:</span>
                                ${Object.entries(ss.byStatus).map(([st, c]) =>
                                    `<span class="sb-strat-chip sb-st-chip-${st}">${_stLabelExt(+st, def)} ×${c}</span>`
                                ).join('')}
                                ${ss.firstDate ? `<span style="font-size:10px;color:#2e3244;margin-left:auto">
                                    ${ss.firstDate.toISOString().slice(0,10)} → ${ss.lastDate.toISOString().slice(0,10)}
                                </span>` : ''}
                            </div>
                            ` : ''}

                        </div>
                    </div>`;
                }).join('')}
            </div>`;
    }

    function _statCard(lbl, val, color, small) {
        return `<div class="sb-strat-stat">
            <div class="sb-strat-lbl">${lbl}</div>
            <div class="sb-strat-val${small?' sb-strat-period':''}" ${color?`style="color:${color}"`:''}>${val}</div>
        </div>`;
    }

    function _getTradeStats() {
        // Читаем из DOM backtest journal (SB.trades внутри IIFE недоступен)
        const stats = {};
        document.querySelectorAll('#sb-tab-body .sb-trow').forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length < 6) return;

            const setupEl   = cells[0]?.querySelector('.sb-badge');
            const setupName = setupEl?.textContent?.trim();
            if (!setupName) return;

            if (!stats[setupName]) {
                stats[setupName] = {
                    total: 0, wins: 0, losses: 0,
                    pnl: 0, maxWin: 0, maxLoss: 0,
                    totalBars: 0, byExit: {},
                    firstDate: null, lastDate: null,
                };
            }
            const st = stats[setupName];
            st.total++;

            // PnL — ищем ячейку с классом sb-pos/sb-neg
            const posCell = row.querySelector('.sb-pos, .sb-neg');
            const pnlVal  = parseFloat(posCell?.textContent?.replace(/[^0-9.\-]/g, '') || '0') || 0;
            const isWin   = posCell?.classList.contains('sb-pos');
            if (isWin) { st.wins++; st.maxWin = Math.max(st.maxWin, pnlVal); }
            else        { st.losses++; st.maxLoss = Math.min(st.maxLoss, -Math.abs(pnlVal)); }
            st.pnl += isWin ? pnlVal : -Math.abs(pnlVal);

            // Bars held — последняя числовая ячейка перед exit reason
            const barsCell = cells[cells.length - 3];
            st.totalBars += parseInt(barsCell?.textContent || '0') || 0;

            // Exit reason
            const exitCell = cells[cells.length - 2];
            const exit = exitCell?.textContent?.trim() || 'unknown';
            st.byExit[exit] = (st.byExit[exit] || 0) + 1;

            // Date
            const dateCell = cells[cells.length - 1];
            const dStr = dateCell?.textContent?.trim();
            if (dStr) {
                const d = new Date(dStr);
                if (!isNaN(d)) {
                    if (!st.firstDate || d < st.firstDate) st.firstDate = d;
                    if (!st.lastDate  || d > st.lastDate)  st.lastDate  = d;
                }
            }
        });

        // Финализируем
        Object.values(stats).forEach(st => {
            st.winRate  = st.total ? +(st.wins / st.total * 100).toFixed(1) : 0;
            st.pnl      = +st.pnl.toFixed(2);
            st.maxWin   = +st.maxWin.toFixed(2);
            st.maxLoss  = +st.maxLoss.toFixed(2);
            st.avgBars  = st.total ? +(st.totalBars / st.total).toFixed(1) : 0;
            st.period   = st.firstDate
                ? st.firstDate.toISOString().slice(0,10) + ' → ' + st.lastDate.toISOString().slice(0,10)
                : '—';
        });
        return stats;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7. МЕНЕДЖЕР МНОЖЕСТВА СЕТАПОВ
    // ─────────────────────────────────────────────────────────────────────────

    function openSetupsManagerDialog() {
        document.getElementById('sb-mgr-dlg')?.remove();

        const dlg = document.createElement('div');
        dlg.id = 'sb-mgr-dlg';
        dlg.className = 'sb-float-dlg';
        Object.assign(dlg.style, {
            position: 'fixed', zIndex: '100001',
            left: Math.max(20, (window.innerWidth - 460) / 2) + 'px',
            top: '60px', width: '460px',
            maxHeight: (window.innerHeight - 100) + 'px',
        });

        dlg.innerHTML = `
            <div class="sb-float-hdr" id="sb-mgr-drag">
                <span>⚙ Manage Setups</span>
                <button class="sb-float-close" id="sb-mgr-close">✕</button>
            </div>
            <div class="sb-float-body" id="sb-mgr-body"></div>`;

        document.body.appendChild(dlg);
        _makeDraggable(dlg, dlg.querySelector('#sb-mgr-drag'));
        dlg.querySelector('#sb-mgr-close')?.addEventListener('click', () => dlg.remove());

        _renderSetupsManager(dlg.querySelector('#sb-mgr-body'));
    }

    function _renderSetupsManager(body) {
        const setups  = window.app?.setups || {};
        const autoCols = Object.keys(_autoDetectCols());

        body.innerHTML = `
            <div style="font-size:10px;color:#4a5080;font-weight:700;text-transform:uppercase;margin-bottom:6px">
                Registered Setups (${Object.keys(setups).length})
            </div>
            <div id="sb-mgr-list" style="display:flex;flex-direction:column;gap:3px;max-height:180px;overflow-y:auto;margin-bottom:10px">
                ${Object.entries(setups).length === 0
                    ? '<div style="color:#3a4060;font-size:11px;font-style:italic">No setups registered</div>'
                    : Object.entries(setups).map(([name, def]) => `
                        <div class="sb-mgr-row" data-name="${esc(name)}">
                            <span class="sb-badge" style="flex:1;max-width:140px;overflow:hidden;text-overflow:ellipsis">${esc(name)}</span>
                            <span class="sb-mono">.${esc(def.column || name)}</span>
                            <span class="sb-dir sb-dir-${def.dir||'long'}" style="font-size:9px">${def.dir||'long'}</span>
                            <button class="sb-btn sb-mgr-edit" data-name="${esc(name)}" style="font-size:10px;padding:1px 7px">✏</button>
                            <button class="sb-btn sb-mgr-del"  data-name="${esc(name)}" style="font-size:10px;padding:1px 7px;border-color:#ef535044;color:#ef5350">✕</button>
                        </div>`).join('')}
            </div>

            <div style="font-size:10px;color:#4a5080;font-weight:700;text-transform:uppercase;margin-bottom:6px">
                ＋ Add / Edit Setup
            </div>
            <label class="sb-lbl">Setup name</label>
            <input class="sb-inp sb-inp-w" id="sb-mgr-name" placeholder="FVG Bull">

            <label class="sb-lbl" style="margin-top:5px">Column in activedata</label>
            <div style="display:flex;gap:4px;margin-top:2px">
                <input class="sb-inp" id="sb-mgr-col" placeholder="fvg_bull" style="flex:1">
                ${autoCols.length ? `
                <select class="sb-sel" id="sb-mgr-col-pick" style="flex:1">
                    <option value="">— auto-detected —</option>
                    ${autoCols.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
                </select>` : ''}
            </div>

            <label class="sb-lbl" style="margin-top:5px">Direction</label>
            <select class="sb-sel sb-sel-w" id="sb-mgr-dir" style="margin-top:2px">
                <option value="long">Long</option>
                <option value="short">Short</option>
            </select>

            <label class="sb-lbl" style="margin-top:5px">Exit rules
                <span style="font-size:10px;color:#2e3244;font-weight:400"> (column value → label)</span>
            </label>
            <div id="sb-mgr-rules" style="display:flex;flex-direction:column;gap:4px;margin-top:3px"></div>
            <button class="sb-btn sb-btn-add-rule" id="sb-mgr-add-rule" style="margin-top:4px;font-size:11px">+ Add exit rule</button>

            <div class="sb-float-foot">
                <button class="sb-btn sb-btn-ok" id="sb-mgr-save">✓ Save Setup</button>
                <button class="sb-btn" id="sb-mgr-clear">Clear form</button>
            </div>
        `;

        // Дефолтные exit rules в форме
        const rulesWrap = body.querySelector('#sb-mgr-rules');
        _addRuleRow(rulesWrap, 3, 'TP hit');
        _addRuleRow(rulesWrap, 4, 'SL hit');

        body.querySelector('#sb-mgr-col-pick')?.addEventListener('change', e => {
            if (e.target.value) body.querySelector('#sb-mgr-col').value = e.target.value;
        });

        body.querySelectorAll('.sb-mgr-del').forEach(btn => {
            btn.addEventListener('click', () => {
                const name = btn.dataset.name;
                if (window.app?.setups) delete window.app.setups[name];
                _renderSetupsManager(body);
            });
        });

        body.querySelectorAll('.sb-mgr-edit').forEach(btn => {
            btn.addEventListener('click', () => {
                const name = btn.dataset.name;
                const def  = setups[name];
                if (!def) return;
                body.querySelector('#sb-mgr-name').value = name;
                body.querySelector('#sb-mgr-col').value  = def.column || name;
                body.querySelector('#sb-mgr-dir').value  = def.dir || 'long';
                const rw = body.querySelector('#sb-mgr-rules');
                rw.innerHTML = '';
                (def.exitRules || []).forEach(r => _addRuleRow(rw, r.status, r.label));
            });
        });

        body.querySelector('#sb-mgr-add-rule')?.addEventListener('click', () => {
            _addRuleRow(body.querySelector('#sb-mgr-rules'));
        });

        body.querySelector('#sb-mgr-clear')?.addEventListener('click', () => {
            body.querySelector('#sb-mgr-name').value = '';
            body.querySelector('#sb-mgr-col').value  = '';
            const rw = body.querySelector('#sb-mgr-rules');
            rw.innerHTML = '';
            _addRuleRow(rw, 3, 'TP hit');
            _addRuleRow(rw, 4, 'SL hit');
        });

        body.querySelector('#sb-mgr-save')?.addEventListener('click', () => {
            const name = body.querySelector('#sb-mgr-name')?.value.trim();
            const col  = body.querySelector('#sb-mgr-col')?.value.trim();
            if (!name || !col) {
                if (!name) body.querySelector('#sb-mgr-name').style.borderColor = '#ef5350';
                if (!col)  body.querySelector('#sb-mgr-col').style.borderColor  = '#ef5350';
                return;
            }
            const dir = body.querySelector('#sb-mgr-dir')?.value || 'long';
            const exitRules = [];
            body.querySelectorAll('.sb-mgr-rule').forEach(row => {
                const ins = row.querySelectorAll('input');
                const st  = parseInt(ins[0]?.value);
                const lb  = ins[1]?.value?.trim();
                if (!isNaN(st) && lb) exitRules.push({ status: st, label: lb });
            });

            if (!window.app) window.app = {};
            if (!window.app.setups) window.app.setups = {};
            window.app.setups[name] = { column: col, dir, exitRules };

            _renderSetupsManager(body);
            body.querySelector('#sb-mgr-name').value = '';
            body.querySelector('#sb-mgr-col').value  = '';
            const rw = body.querySelector('#sb-mgr-rules');
            rw.innerHTML = '';
            _addRuleRow(rw, 3, 'TP hit');
            _addRuleRow(rw, 4, 'SL hit');
        });
    }

    function _addRuleRow(wrap, status = '', label = '') {
        const row = document.createElement('div');
        row.className = 'sb-rule sb-mgr-rule';
        row.innerHTML = `
            <span class="sb-rule-ico">if =</span>
            <input class="sb-inp sb-inp-xs" type="number" value="${status}" placeholder="#">
            <span class="sb-rule-ico">→</span>
            <input class="sb-inp sb-inp-flex" value="${label}" placeholder="Label">
            <button class="sb-rule-del" title="Remove">✕</button>`;
        row.querySelector('.sb-rule-del')?.addEventListener('click', () => row.remove());
        wrap?.appendChild(row);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    function _runScan() {
        const bars = window.app?.activedata;
        if (!bars?.length) return [];
        const defs = window.app?.setups || {};
        const cols = Object.keys(defs).length ? defs : _autoDetectCols();
        const out  = [];
        bars.forEach((bar, idx) => {
            for (const [name, def] of Object.entries(cols)) {
                const col = def.column || name;
                const v   = +bar[col];
                if (isNaN(v) || v === 0) continue;
                out.push({ barIdx: idx, bar, setupName: name, col, status: v });
            }
        });
        return out;
    }

    function _autoDetectCols() {
        const bars = window.app?.activedata;
        if (!bars?.length) return {};
        const skip   = new Set(['timestamp','open','high','low','close','volume','transactions','atr']);
        const sample = bars.slice(0, Math.min(300, bars.length));
        const res    = {};
        for (const key of Object.keys(sample[sample.length - 1] || {})) {
            if (skip.has(key)) continue;
            const has = sample.some(b => { const v = +b[key]; return Number.isInteger(v) && v >= 1 && v <= 9; });
            if (has) res[key] = { column: key };
        }
        return res;
    }

    function _gotoBar(tsMs) {
        try { window.app?.widget?.activeChart()?.scrollToPosition?.(Math.floor(tsMs / 1000)); } catch (_) {}
        window.dataTable?.highlight?.(tsMs);
    }

    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g,
            c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    function fmtP(v) {
        const n = parseFloat(v);
        if (isNaN(n)) return '—';
        return n < 0.01 ? n.toFixed(8) : n < 1 ? n.toFixed(6) : n < 100 ? n.toFixed(4) : n.toFixed(2);
    }

    function _makeDraggable(el, handle) {
        const h = handle || el;
        let ox = 0, oy = 0, mx = 0, my = 0;
        h.style.cursor = 'grab';
        const onMove = e => {
            ox = mx - e.clientX; oy = my - e.clientY;
            mx = e.clientX; my = e.clientY;
            el.style.top  = Math.max(0, Math.min(el.offsetTop  - oy, window.innerHeight - 40)) + 'px';
            el.style.left = Math.max(0, Math.min(el.offsetLeft - ox, window.innerWidth  - 40)) + 'px';
        };
        const onUp = () => {
            h.style.cursor = 'grab';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        const onDown = e => {
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' ||
                e.target.tagName === 'SELECT') return;
            e.preventDefault();
            mx = e.clientX; my = e.clientY;
            h.style.cursor = 'grabbing';
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };
        h.addEventListener('mousedown', onDown);
        el._removeDrag = () => h.removeEventListener('mousedown', onDown);
    }
    function _removeDraggable(el) { el._removeDrag?.(); }

    // ─────────────────────────────────────────────────────────────────────────
    // CSS
    // ─────────────────────────────────────────────────────────────────────────

    function injectExtCSS() {
        if (document.getElementById('sb-ext-css')) return;
        const s = document.createElement('style');
        s.id = 'sb-ext-css';
        s.textContent = `
    /* Tooltip */
    .sb-ext-tooltip{
        position:fixed;z-index:999999;pointer-events:none;display:none;
        background:#0c0e1e;border:1px solid #2962FF55;border-radius:4px;
        color:#d1d4dc;font-size:11px;padding:4px 10px;
        box-shadow:0 4px 18px rgba(0,0,0,.65);max-width:280px;line-height:1.4;
    }
    /* Strategy tab */
    .sb-tab-strat.sb-tab-active{color:#9c27b0;border-bottom-color:#9c27b0}
    .sb-strat-card{background:#0a0c18;border:1px solid #1a1e30;border-radius:6px;overflow:hidden}
    .sb-strat-hdr{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#0d0f20;border-bottom:1px solid #141826}
    .sb-strat-name{font-size:12px;font-weight:700;color:#d1d4dc}
    .sb-strat-col{font-size:10px;color:#2e3244;font-family:monospace;margin-left:auto}
    .sb-strat-body{padding:10px 12px;display:flex;flex-direction:column;gap:6px}
    .sb-strat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:5px}
    .sb-strat-stat{background:#080a14;border:1px solid #141826;border-radius:4px;padding:5px 8px}
    .sb-strat-lbl{font-size:9px;color:#2e3244;text-transform:uppercase;letter-spacing:.3px}
    .sb-strat-val{font-size:13px;font-weight:700;color:#d1d4dc;margin-top:2px;font-variant-numeric:tabular-nums}
    .sb-strat-period{font-size:10px!important;font-weight:400!important;color:#6a7090!important;font-family:monospace}
    .sb-strat-exits{display:flex;flex-wrap:wrap;gap:4px}
    .sb-strat-chip{font-size:10px;padding:1px 6px;border-radius:3px;border:1px solid #1a1e30;color:#6a7090;background:#080a14}
    .sb-st-chip-1{background:#2962FF15;color:#2962FF;border-color:#2962FF33}
    .sb-st-chip-2{background:#f5a62315;color:#f5a623;border-color:#f5a62333}
    .sb-st-chip-3{background:#4caf5015;color:#4caf50;border-color:#4caf5033}
    .sb-st-chip-4{background:#ef535015;color:#ef5350;border-color:#ef535033}
    /* Float panel */
    .sb-float-panel{border:1px solid #2962FF33!important;border-radius:8px!important}
    #dt-panel.sb-float-panel #dt-toolbar{cursor:grab}
    /* Manager rows */
    .sb-mgr-row{display:flex;align-items:center;gap:5px;padding:3px 6px;background:#0a0c16;border:1px solid #141826;border-radius:3px}
    .sb-mgr-row:hover{border-color:#1a1e30}
    /* Light theme */
    body.light-theme .sb-ext-tooltip{background:#fff;border-color:#2962FF;color:#131722}
    body.light-theme .sb-strat-card{background:#f8f9fd;border-color:#d0d3db}
    body.light-theme .sb-strat-hdr{background:#f0f3fa;border-color:#e0e3ef}
    body.light-theme .sb-strat-stat{background:#fff;border-color:#e0e3ef}
    body.light-theme .sb-mgr-row{background:#f8f9fd;border-color:#e0e3ef}
        `;
        document.head.appendChild(s);
    }

})();