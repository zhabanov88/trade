/**
 * code-panel-hotfix.js v4.0 (Combined)
 * 
 * Патч для code-panel-manager.js:
 *  1. Loader + Cancel button + детальные ошибки при выполнении JS
 *  2. Кнопка сворачивания/разворачивания панели
 *  3. Правильные эндпоинты для сохранения (/api/javascript-scripts vs /api/pine-scripts)
 *  4. Сохранение выбранного скрипта в селекте после обновления списка
 *  5. Update существующих скриптов вместо создания дубликатов
 * 
 * Подключать ПОСЛЕ code-panel-manager.js
 */

(function() {
    'use strict';

    console.log('[CodePanel Hotfix v4] Loading...');

    // ═════════════════════════════════════════════════════════════════════
    // ЖДЁМ ГОТОВНОСТИ CodePanelManager
    // ═════════════════════════════════════════════════════════════════════

    const CHECK_INTERVAL = 50;
    const MAX_WAIT_MS    = 10000;
    let   waited         = 0;

    const waitTimer = setInterval(() => {
        waited += CHECK_INTERVAL;

        if (typeof CodePanelManager === 'undefined' && !window.codePanelManager) {
            if (waited >= MAX_WAIT_MS) {
                clearInterval(waitTimer);
                console.error('[Hotfix v4] CodePanelManager not found after 10s');
            }
            return;
        }

        clearInterval(waitTimer);
        
        // Проверяем наличие класса или инстанса
        if (typeof CodePanelManager !== 'undefined') {
            patchPrototype();
        }
        if (window.codePanelManager) {
            patchInstance(window.codePanelManager);
        }
    }, CHECK_INTERVAL);

    // ═════════════════════════════════════════════════════════════════════
    // ПАТЧИНГ PROTOTYPE (для нового стиля с классом)
    // ═════════════════════════════════════════════════════════════════════

    function patchPrototype() {
        const proto = CodePanelManager.prototype;

        // ── 1. Патчим setupEventListeners ─────────────────────────────────
        const _origSetup = proto.setupEventListeners;

        proto.setupEventListeners = function () {
            // Вызываем оригинал
            _origSetup.call(this);

            const self = this;

            // Инициализируем хранилище
            self._selected    = { pine: null, pine6: null, js: null };
            self._scriptCache = { pine: null, pine6: null, js: null };

            // Заменяем обработчики select
            replaceSelect.call(self, 'pineExamples',  'pine',  'pineEditor',  'logPineConsole');
            replaceSelect.call(self, 'pine6Examples', 'pine6', 'pine6Editor', 'logPine6Console');
            replaceSelect.call(self, 'jsExamples',    'js',    'jsEditor',    'logJSConsole');

            // Заменяем кнопки Clear
            replaceClear.call(self, 'pineClearBtn',  'pineEditor',  'pineExamples',  'pine',  'logPineConsole');
            replaceClear.call(self, 'pine6ClearBtn', 'pine6Editor', 'pine6Examples', 'pine6', 'logPine6Console');
            replaceClear.call(self, 'jsClearBtn',    'jsEditor',    'jsExamples',    'js',    'logJSConsole');

            // Заменяем кнопки Save
            replaceSave.call(self, 'pineSaveBtn',  'pineEditor',  'pine',  5);
            replaceSave.call(self, 'pine6SaveBtn', 'pine6Editor', 'pine6', 6);
            replaceSave.call(self, 'jsSaveBtn',    'jsEditor',    'js',    null);

            console.log('[Hotfix v4] ✓ Event listeners replaced (prototype)');
        };

        // ── 2. Патчим методы обновления dropdown ─────────────────────────
        ['updatePineExamplesDropdown', 'updateJSExamplesDropdown', 'updateDropdown', 'populateExamplesDropdowns']
            .forEach(name => {
                if (!proto[name]) return;
                const _orig = proto[name];
                proto[name] = function (...args) {
                    const snap = saveSelects();
                    _orig.apply(this, args);
                    restoreSelects(snap);
                };
                console.log(`[Hotfix v4] patched ${name}`);
            });

        // ── 3. Патчим loadExamplesFromDatabase ────────────────────────────
        if (proto.loadExamplesFromDatabase) {
            const _origLoad = proto.loadExamplesFromDatabase;
            proto.loadExamplesFromDatabase = async function (...args) {
                const snap = saveSelects();
                await _origLoad.apply(this, args);
                restoreSelects(snap);
            };
            console.log('[Hotfix v4] patched loadExamplesFromDatabase');
        }

        console.log('[Hotfix v4] CodePanelManager prototype patched ✓');
    }

    // ═════════════════════════════════════════════════════════════════════
    // ПАТЧИНГ INSTANCE (для старого стиля)
    // ═════════════════════════════════════════════════════════════════════

    function patchInstance(manager) {
        console.log('[Hotfix v4] Patching instance...');

        // ── 1. LOADER + CANCEL + ERROR DETAILS для JavaScript ─────────────
        const originalRunJS = manager.runJavaScript;
        if (originalRunJS) {
            manager.runJavaScript = async function() {
                const editor = document.getElementById('jsEditor');
                if (!editor) return;

                const code = editor.value.trim();
                if (!code) {
                    this.logJSConsole('Error: No code to execute', 'error');
                    return;
                }

                const runBtn = document.getElementById('jsRunBtn');
                const actionsDiv = runBtn?.closest('.code-actions');

                // Создаём Cancel button
                let cancelBtn = document.getElementById('jsCancelBtn');
                if (!cancelBtn && actionsDiv) {
                    cancelBtn = document.createElement('button');
                    cancelBtn.id = 'jsCancelBtn';
                    cancelBtn.className = 'code-btn';
                    cancelBtn.style.cssText = 'background:#ef5350;display:none;margin-left:8px';
                    cancelBtn.innerHTML = '✕ Cancel';
                    actionsDiv.appendChild(cancelBtn);
                }

                // AbortController для отмены
                let aborted = false;
                if (cancelBtn) {
                    cancelBtn.style.display = 'inline-block';
                    cancelBtn.onclick = () => {
                        aborted = true;
                        this.logJSConsole('⚠ Execution cancelled by user', 'warning');
                        if (runBtn) {
                            runBtn.disabled = false;
                            runBtn.innerHTML = '<span>▶</span> Execute JavaScript';
                        }
                        if (cancelBtn) cancelBtn.style.display = 'none';
                    };
                }

                // Показываем loader
                if (runBtn) {
                    runBtn.disabled = true;
                    runBtn.innerHTML = '<span>⏳</span> Executing...';
                }

                this.clearJSConsole();
                this.logJSConsole('→ Executing JavaScript...', 'info');

                try {
                    if (!window.app || !window.app.widget) {
                        throw new Error('TradingView widget not available');
                    }

                    window.chart = window.app.widget.activeChart();
                    window.widget = window.app.widget;

                    if (aborted) throw new Error('Execution aborted');

                    console.log('[JS Execution] Code to execute:', code);
                    const result = eval(code);
                    console.log('Finish');

                    try{  
                        console.log("window.app", window.app, window.app.setups)
                        const _setupsBefore = new Set(Object.keys(window.app?.setups || {}));
                        if ( window.app && window.app.setups) {
                            console.log("In _currentJsScriptId", 2)
                            const allSetups = Object.keys(window.app.setups);
                            const affectedSetups = allSetups.filter(
                                k => !_setupsBefore.has(k) || !('scriptId' in (window.app.setups[k] || {}))
                            );
                            
                            const _codeToInject = code;
                            const _scriptIdToInject = this._currentJsScriptId;


                            console.log("In affectedSetups", affectedSetups)
                            setTimeout(() => {
                                affectedSetups.forEach(setupName => {
                                    if (window.app.setups[setupName]) {
                                        window.app.setups[setupName].scriptId   = _scriptIdToInject;
                                        window.app.setups[setupName].scriptCode = _codeToInject;
                                        console.log(`[CodePanel] ✓ scriptCode injected into "${setupName}" (${_codeToInject.length} chars)`);
                                    }
                                });
                            }, 0);
                            if (affectedSetups.length) {
                                this.logJSConsole(
                                    '✓ scriptId=' + this._currentJsScriptId + ' linked to setups: [' + affectedSetups.join(', ') + '] — Server BT ready',
                                    'info'
                                );
                                console.log('[CodePanel] scriptId auto-injected:', this._currentJsScriptId, '→', affectedSetups);
                            }
                        }
                    } catch (e) {
                        console.log('Error during result processing:', e);
                    }

                    console.log("app.activedata", app.activedata)
                    let act = JSON.stringify(app.activedata)
                    localStorage.setItem("activedata", act)

                    if (result && typeof result.then === 'function') {
                        await Promise.race([
                            result,
                            new Promise((resolve) => {
                                const check = setInterval(() => {
                                    if (aborted) {
                                        clearInterval(check);
                                        resolve();
                                    }
                                }, 100);
                            })
                        ]);
                    }

                    if (!aborted) {
                        this.logJSConsole('✓ Execution completed successfully', 'success');
                    }

                } catch (error) {
                    if (error.message === 'Execution aborted') return;

                    // Детальный вывод ошибки
                    this.logJSConsole('✗ Execution failed', 'error');
                    this.logJSConsole(`${error.name}: ${error.message}`, 'error');

                    // Stack trace (первые 3 строки)
                    if (error.stack) {
                        const lines = error.stack.split('\n').slice(1, 4);
                        lines.forEach(line => {
                            if (line.trim()) {
                                this.logJSConsole(`  ${line.trim()}`, 'error');
                            }
                        });
                    }

                    console.error('[JS Execution]', error);

                } finally {
                    if (runBtn) {
                        runBtn.disabled = false;
                        runBtn.innerHTML = '<span>▶</span> Execute JavaScript';
                    }
                    if (cancelBtn) {
                        cancelBtn.style.display = 'none';
                    }
                }
            };
            console.log('[Hotfix v4] ✓ JavaScript execution patched');
        }

        // ── 2. COLLAPSE/EXPAND BUTTON ──────────────────────────────────────
        injectCollapseButton();

        // ── 3. INIT STORAGE ────────────────────────────────────────────────
        if (!manager._selected) {
            manager._selected = { pine: null, pine6: null, js: null };
        }
        if (!manager._scriptCache) {
            manager._scriptCache = { pine: null, pine6: null, js: null };
        }

        console.log('[Hotfix v4] Instance patched ✓');
    }

    // ═════════════════════════════════════════════════════════════════════
    // COLLAPSE BUTTON
    // ═════════════════════════════════════════════════════════════════════

    function injectCollapseButton() {
        const container = document.getElementById('codePanelContainer');
        const header = document.querySelector('.code-panel-header');

        if (!container || !header || document.getElementById('codePanelCollapseBtn')) {
            return;
        }

        const collapseBtn = document.createElement('button');
        collapseBtn.id = 'codePanelCollapseBtn';
        collapseBtn.className = 'code-collapse-btn';
        collapseBtn.innerHTML = '◀';
        collapseBtn.title = 'Hide code panel';

        // Стили
        if (!document.getElementById('code-collapse-styles')) {
            const style = document.createElement('style');
            style.id = 'code-collapse-styles';
            style.textContent = `
                .code-collapse-btn {
                    background: transparent;
                    border: 1px solid #2e3244;
                    color: #d1d4dc;
                    padding: 4px 10px;
                    cursor: pointer;
                    border-radius: 3px;
                    font-size: 14px;
                    transition: all 0.2s;
                    margin-left: auto;
                }
                .code-collapse-btn:hover {
                    background: #1a1e30;
                    border-color: #2962FF;
                    color: #2962FF;
                }
                #codePanelContainer.collapsed {
                    width: 40px !important;
                    min-width: 40px !important;
                }
                #codePanelContainer.collapsed .code-panel-tabs,
                #codePanelContainer.collapsed .code-tab-content {
                    display: none !important;
                }
                #codePanelContainer.collapsed .code-panel-header {
                    padding: 8px 4px;
                }
            `;
            document.head.appendChild(style);
        }

        // Функция toggle
        let isCollapsed = localStorage.getItem('code_panel_collapsed') === 'true';
        const toggle = () => {
            isCollapsed = !isCollapsed;
            localStorage.setItem('code_panel_collapsed', String(isCollapsed));

            if (isCollapsed) {
                container.classList.add('collapsed');
                collapseBtn.innerHTML = '▶';
                collapseBtn.title = 'Show code panel';

                // Расширяем график
                const chart = document.querySelector('#tv-chart-container');
                if (chart) chart.style.width = 'calc(100% - 40px)';
            } else {
                container.classList.remove('collapsed');
                collapseBtn.innerHTML = '◀';
                collapseBtn.title = 'Hide code panel';

                // Возвращаем ширину
                const chart = document.querySelector('#tv-chart-container');
                if (chart) chart.style.width = 'calc(100% - 400px)';
            }

            // Resize TradingView
            setTimeout(() => {
                window.dispatchEvent(new Event('resize'));
                if (window.app?.widget?.resize) {
                    window.app.widget.resize();
                }
            }, 150);
        };

        collapseBtn.addEventListener('click', toggle);

        // Вставляем кнопку
        if (!header.style.display || header.style.display === '') {
            header.style.display = 'flex';
            header.style.alignItems = 'center';
            header.style.justifyContent = 'space-between';
            header.style.padding = '8px 12px';
        }
        //header.appendChild(collapseBtn);

        // Восстанавливаем состояние
        if (isCollapsed) {
            toggle();
        }

        console.log('[Hotfix v4] ✓ Collapse button added');
    }

    // ═════════════════════════════════════════════════════════════════════
    // HELPERS: SELECT PERSISTENCE
    // ═════════════════════════════════════════════════════════════════════

    const SELECT_IDS = ['pineExamples', 'pine6Examples', 'jsExamples'];

    function saveSelects() {
        const snap = {};
        SELECT_IDS.forEach(id => {
            const el = document.getElementById(id);
            if (el) snap[id] = el.value;
        });
        return snap;
    }

    function restoreSelects(snap) {
        SELECT_IDS.forEach(id => {
            if (!snap[id]) return;
            const el = document.getElementById(id);
            if (el) el.value = snap[id];
        });
    }

    // ═════════════════════════════════════════════════════════════════════
    // REPLACE SELECT HANDLER
    // ═════════════════════════════════════════════════════════════════════

    function replaceSelect(selectId, type, editorId, logMethod) {
        const self = this;
        const sel  = document.getElementById(selectId);
        if (!sel) return;

        // Убираем старые listeners через clone
        const fresh = sel.cloneNode(true);
        sel.parentNode.replaceChild(fresh, sel);

        fresh.addEventListener('change', async function (e) {
            const val = e.target.value;
            if (!val) return;

            if (val === '__manage__') {
                if (self.openScriptManager) self.openScriptManager(type);
                e.target.value = '';
                return;
            }

            // Код из локального кеша менеджера
            const examples = type === 'pine'  ? self.pineExamples
                           : type === 'pine6' ? self.pine6Examples
                           : self.jsExamples;
            const code = examples && examples[val];
            if (code !== undefined) {
                const ed = document.getElementById(editorId);
                if (ed) ed.value = code;
            }

            // НЕ сбрасываем e.target.value - оставляем выбранным

            // Запоминаем объект скрипта для Save
            if (!self._scriptCache[type]) {
                try {
                    self._scriptCache[type] = type === 'js'
                        ? await fetchJavaScriptScripts()
                        : await fetchPineScripts();
                } catch (_) { 
                    self._scriptCache[type] = []; 
                }
            }
            self._selected[type] = self._scriptCache[type].find(
                s => s.system_name === val
            ) || null;

            if (self[logMethod]) {
                const label = self._selected[type]?.display_name || val;
                self[logMethod](`Loaded: ${label}`, 'info');
            }
        });
    }

    // ═════════════════════════════════════════════════════════════════════
    // REPLACE CLEAR HANDLER
    // ═════════════════════════════════════════════════════════════════════

    function replaceClear(btnId, editorId, selectId, type, logMethod) {
        const self = this;
        const btn  = document.getElementById(btnId);
        if (!btn) return;
        const fresh = btn.cloneNode(true);
        btn.parentNode.replaceChild(fresh, btn);
        fresh.addEventListener('click', () => {
            const ed  = document.getElementById(editorId);
            const sel = document.getElementById(selectId);
            if (ed)  ed.value  = '';
            if (sel) sel.value = '';
            self._selected[type]    = null;
            self._scriptCache[type] = null;
            if (self[logMethod]) self[logMethod]('Editor cleared', 'info');
        });
    }

    // ═════════════════════════════════════════════════════════════════════
    // REPLACE SAVE HANDLER
    // ═════════════════════════════════════════════════════════════════════

    function replaceSave(btnId, editorId, type, pineVersion) {
        const self = this;
        const btn  = document.getElementById(btnId);
        if (!btn) return;
        const fresh = btn.cloneNode(true);
        btn.parentNode.replaceChild(fresh, btn);
        fresh.addEventListener('click', () => {
            const code = document.getElementById(editorId)?.value?.trim();
            if (!code) { 
                alert('Please write some code first'); 
                return; 
            }
            openSaveModal(self, type, code, self._selected[type], pineVersion);
        });
    }

    // ═════════════════════════════════════════════════════════════════════
    // SAVE MODAL (with Update support)
    // ═════════════════════════════════════════════════════════════════════

    function openSaveModal(mgr, type, code, existing, pineVersion) {
        const isUpdate = !!existing;
        const logFn    = type === 'pine'  ? 'logPineConsole'
                       : type === 'pine6' ? 'logPine6Console'
                       : 'logJSConsole';
        const log = (m, t) => mgr[logFn] && mgr[logFn](m, t);

        document.querySelector('.cpm-hf-modal')?.remove();

        const modal = document.createElement('div');
        modal.className = 'cpm-hf-modal';
        modal.innerHTML = `
            <div class="cpm-hf-overlay"></div>
            <div class="cpm-hf-box">
                <div class="cpm-hf-head">
                    <span>${isUpdate ? `✏️ Update — ${escapeHtml(existing.display_name)}` : '💾 Save New Script'}</span>
                    <button class="cpm-hf-close">✕</button>
                </div>
                <div class="cpm-hf-body">
                    <label>Display Name *
                        <input type="text" id="hfName"
                            value="${escapeHtml(existing?.display_name || '')}"
                            placeholder="My Indicator">
                    </label>
                    <label>System Name *${isUpdate ? ' <small>(не изменяется)</small>' : ''}
                        <input type="text" id="hfSys"
                            value="${escapeHtml(existing?.system_name || '')}"
                            placeholder="my_indicator"
                            ${isUpdate ? 'readonly' : ''}>
                    </label>
                    <label>Description
                        <textarea id="hfDesc" rows="2"
                            placeholder="What does this script do?">${escapeHtml(existing?.description || '')}</textarea>
                    </label>
                    <label class="hf-row">
                        <input type="checkbox" id="hfPublic" ${existing?.is_public ? 'checked' : ''}>
                        Make public
                    </label>
                </div>
                <div class="cpm-hf-foot">
                    <button class="hf-cancel">Cancel</button>
                    <button class="hf-save">${isUpdate ? '✏️ Update' : '💾 Save'}</button>
                </div>
            </div>`;

        // Inject modal styles if not present
        if (!document.getElementById('cpm-hf-modal-styles')) {
            const style = document.createElement('style');
            style.id = 'cpm-hf-modal-styles';
            style.textContent = `
                .cpm-hf-modal { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 100000; display: flex; align-items: center; justify-content: center; }
                .cpm-hf-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); }
                .cpm-hf-box { position: relative; background: #131722; border: 1px solid #2e3244; border-radius: 6px; width: 90%; max-width: 500px; box-shadow: 0 8px 32px rgba(0,0,0,0.5); }
                .cpm-hf-head { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid #2e3244; color: #d1d4dc; font-weight: 600; }
                .cpm-hf-close { background: transparent; border: none; color: #6a7080; font-size: 20px; cursor: pointer; padding: 0 4px; }
                .cpm-hf-close:hover { color: #ef5350; }
                .cpm-hf-body { padding: 16px; }
                .cpm-hf-body label { display: block; margin-bottom: 12px; color: #d1d4dc; font-size: 12px; font-weight: 500; }
                .cpm-hf-body label small { color: #6a7080; font-weight: 400; margin-left: 4px; }
                .cpm-hf-body input[type="text"],
                .cpm-hf-body textarea { width: 100%; background: #1a1e30; border: 1px solid #2e3244; color: #d1d4dc; padding: 8px; margin-top: 4px; border-radius: 4px; font-family: inherit; font-size: 13px; }
                .cpm-hf-body input[type="text"]:focus,
                .cpm-hf-body textarea:focus { outline: none; border-color: #2962FF; }
                .cpm-hf-body input[readonly] { opacity: 0.6; cursor: not-allowed; }
                .cpm-hf-body .hf-row { display: flex; align-items: center; gap: 8px; }
                .cpm-hf-body input[type="checkbox"] { margin: 0; width: auto; }
                .cpm-hf-foot { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid #2e3244; justify-content: flex-end; }
                .cpm-hf-foot button { padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 500; border: none; transition: all 0.2s; }
                .hf-cancel { background: #2e3244; color: #d1d4dc; }
                .hf-cancel:hover { background: #3a4060; }
                .hf-save { background: #2962FF; color: white; }
                .hf-save:hover { background: #1e53e5; }
            `;
            document.head.appendChild(style);
        }

        document.body.appendChild(modal);
        
        const close = () => modal.remove();
        modal.querySelector('.cpm-hf-overlay').onclick = close;
        modal.querySelector('.cpm-hf-close').onclick   = close;
        modal.querySelector('.hf-cancel').onclick      = close;

        // Auto-generate system name for new scripts
        if (!isUpdate) {
            const nameEl = modal.querySelector('#hfName');
            const sysEl  = modal.querySelector('#hfSys');
            let touched  = false;
            sysEl.addEventListener('input', () => { touched = true; });
            nameEl.addEventListener('input', () => {
                if (!touched) sysEl.value = nameEl.value
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '_')
                    .replace(/^_+|_+$/g, '');
            });
        }

        modal.querySelector('.hf-save').onclick = async () => {
            const displayName = modal.querySelector('#hfName').value.trim();
            const systemName  = modal.querySelector('#hfSys').value.trim();
            const description = modal.querySelector('#hfDesc').value.trim();
            const isPublic    = modal.querySelector('#hfPublic').checked;

            if (!displayName || !systemName) {
                alert('Display Name и System Name обязательны');
                return;
            }

            const payload = {
                display_name: displayName, 
                system_name: systemName,
                description, 
                code,
                type: type === 'js' ? 'javascript' : 'pine',
                is_public: isPublic
            };

            if (pineVersion) {
                payload.pine_version = pineVersion;
            }

            try {
                const saveBtn = modal.querySelector('.hf-save');
                saveBtn.disabled = true;
                saveBtn.textContent = '⏳ Saving...';

                if (isUpdate) {
                    // Update existing
                    const endpoint = type === 'js' 
                        ? `/api/javascript-scripts/${existing.id}`
                        : `/api/pine-scripts/${existing.id}`;
                    
                    const response = await fetch(endpoint, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify(payload)
                    });

                    if (!response.ok) {
                        const error = await response.json();
                        throw new Error(error.error || 'Update failed');
                    }

                    log(`✓ Updated: "${displayName}"`, 'success');
                } else {
                    // Create new
                    const endpoint = type === 'js'
                        ? '/api/javascript-scripts'
                        : '/api/pine-scripts';

                    const response = await fetch(endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify(payload)
                    });

                    if (!response.ok) {
                        const error = await response.json();
                        throw new Error(error.error || 'Save failed');
                    }

                    log(`✓ Saved: "${displayName}"`, 'success');
                }

                close();

                // Refresh examples and restore selection
                mgr._scriptCache[type] = null;
                if (mgr.loadExamplesFromDatabase) {
                    await mgr.loadExamplesFromDatabase();
                }

                // Select the saved script
                const selId = type === 'pine'  ? 'pineExamples'
                            : type === 'pine6' ? 'pine6Examples'
                            : 'jsExamples';
                const sel = document.getElementById(selId);
                if (sel) {
                    sel.value = systemName;
                }

                // Update selected reference
                mgr._selected[type] = { ...existing, ...payload };

            } catch (err) {
                alert('Ошибка: ' + err.message);
                console.error('[Hotfix Save]', err);
                const saveBtn = modal.querySelector('.hf-save');
                saveBtn.disabled = false;
                saveBtn.textContent = isUpdate ? '✏️ Update' : '💾 Save';
            }
        };
    }

    // ═════════════════════════════════════════════════════════════════════
    // UTILITY FUNCTIONS
    // ═════════════════════════════════════════════════════════════════════

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    async function fetchPineScripts() {
        try {
            const response = await fetch('/api/pine-scripts', { credentials: 'include' });
            if (!response.ok) return [];
            return await response.json();
        } catch (_) {
            return [];
        }
    }

    async function fetchJavaScriptScripts() {
        try {
            const response = await fetch('/api/javascript-scripts', { credentials: 'include' });
            if (!response.ok) return [];
            return await response.json();
        } catch (_) {
            return [];
        }
    }

    console.log('[CodePanel Hotfix v4] Loaded ✓');

})();