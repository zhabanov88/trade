
class CodePanelManagerEnhanced {
    constructor() {
        this.widget = null;
        this.pineExamples = {};
        this.pine6Examples = {};
        this.jsExamples = {};
        this.currentUser = null;
        
        // State
        this.isCollapsed = false;
        this.jsExecutionAbortController = null;
        this.pineExecutionAbortController = null;
    }

    async init(widget) {
        this.widget = widget;
        
        // Get current user
        try {
            const authStatus = await apiClient.checkAuthStatus();
            this.currentUser = authStatus;
        } catch (error) {
            console.error('Failed to get user:', error);
        }

        await this.loadExamplesFromDatabase();
        this.loadFallbackExamples();
        this.setupEventListeners();
        this.injectCollapseButton();
        
        // Restore collapsed state from localStorage
        const savedState = localStorage.getItem('code_panel_collapsed');
        if (savedState === 'true') {
            this.toggleCollapse();
        }

        this.logJSConsole('\u2713 JavaScript API ready', 'success');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // НОВОЕ: СВОРАЧИВАНИЕ ПАНЕЛИ
    // ═══════════════════════════════════════════════════════════════════════

    injectCollapseButton() {
        const panel = document.getElementById('codePanel');
        if (!panel) return;

        const header = panel.querySelector('.code-panel-header');
        if (!header || document.getElementById('codePanelCollapseBtn')) return;

        const btn = document.createElement('button');
        btn.id = 'codePanelCollapseBtn';
        btn.className = 'code-panel-collapse-btn';
        btn.innerHTML = '\u25C0'; // ◀
        btn.title = 'Hide code panel';
        btn.style.cssText = `
            background: transparent;
            border: 1px solid #2e3244;
            color: #d1d4dc;
            padding: 4px 8px;
            cursor: pointer;
            border-radius: 3px;
            font-size: 14px;
            transition: all 0.2s;
            margin-left: auto;
        `;

        btn.addEventListener('mouseenter', () => {
            btn.style.background = '#1a1e30';
            btn.style.borderColor = '#2962FF';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.background = 'transparent';
            btn.style.borderColor = '#2e3244';
        });

        btn.addEventListener('click', () => this.toggleCollapse());

        // Вставляем справа от заголовка
        header.style.display = 'flex';
        header.style.alignItems = 'center';
        header.appendChild(btn);
    }

    toggleCollapse() {
        const panel = document.getElementById('codePanel');
        const btn = document.getElementById('codePanelCollapseBtn');
        const chartContainer = document.querySelector('#tv-chart-container');
        const dataPanel = document.getElementById('dt-panel');

        if (!panel) return;

        this.isCollapsed = !this.isCollapsed;
        localStorage.setItem('code_panel_collapsed', String(this.isCollapsed));

        if (this.isCollapsed) {
            // Сворачиваем
            panel.style.width = '40px';
            panel.style.minWidth = '40px';
            panel.style.overflow = 'hidden';
            panel.querySelectorAll('.code-panel-header > *:not(#codePanelCollapseBtn)').forEach(el => {
                el.style.display = 'none';
            });
            panel.querySelectorAll('.code-tabs, .code-tab-content, .code-toolbar, .code-editor-wrapper, .code-actions, .code-console, .api-reference, .pine-scripts-list').forEach(el => {
                el.style.display = 'none';
            });

            if (btn) {
                btn.innerHTML = '\u25B6'; // ▶
                btn.title = 'Show code panel';
            }

            // Расширяем график и таблицу
            if (chartContainer) {
                chartContainer.style.width = 'calc(100% - 40px)';
            }
        } else {
            // Разворачиваем
            panel.style.width = '400px';
            panel.style.minWidth = '400px';
            panel.style.overflow = '';
            panel.querySelectorAll('.code-panel-header > *:not(#codePanelCollapseBtn)').forEach(el => {
                el.style.display = '';
            });
            panel.querySelectorAll('.code-tabs, .code-tab-content, .code-toolbar, .code-editor-wrapper, .code-actions, .code-console, .api-reference, .pine-scripts-list').forEach(el => {
                el.style.display = '';
            });

            if (btn) {
                btn.innerHTML = '\u25C0'; // ◀
                btn.title = 'Hide code panel';
            }

            // Возвращаем ширину
            if (chartContainer) {
                chartContainer.style.width = 'calc(100% - 400px)';
            }
        }

        // Trigger resize event для TradingView
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
            this.widget?.resize?.();
        }, 100);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ЗАГРУЗКА ПРИМЕРОВ
    // ═══════════════════════════════════════════════════════════════════════

    async loadExamplesFromDatabase() {
        try {
            const scripts = await apiClient.getMyScripts();
            
            scripts.forEach(script => {
                if (script.type === 'pine') {
                    if (script.pine_version === 6) {
                        this.pine6Examples[script.system_name] = script.code;
                    } else {
                        this.pineExamples[script.system_name] = script.code;
                    }
                } else if (script.type === 'javascript') {
                    this.jsExamples[script.system_name] = script.code;
                }
            });

            this.populateExamplesDropdowns();
        } catch (error) {
            console.error('Failed to load examples from database:', error);
            this.loadFallbackExamples();
        }
    }

    loadFallbackExamples() {
        this.pineExamples = {
            sma: `//@version=5
indicator("Simple Moving Average", overlay=true)
length = input.int(20, "Period", minval=1, maxval=500)
source = input.source(close, "Source")
sma_value = ta.sma(source, length)
plot(sma_value, "SMA", color=color.blue, linewidth=2)`
        };

        this.jsExamples = {
            atr: `// Add ATR Indicator
// inputs = объект {key: value}, НЕ массив [14]
const chart = window.app.widget.activeChart();
chart.createStudy('Average True Range', false, false, { length: 14 });
console.log('\\u2713 ATR added');`,

            sma: `// Simple Moving Average
const chart = window.app.widget.activeChart();
chart.createStudy('Moving Average', false, false, { length: 14, source: 'close' });
console.log('\\u2713 SMA added');`,

            rsi: `// RSI
const chart = window.app.widget.activeChart();
chart.createStudy('Relative Strength Index', false, false, { length: 14 });
console.log('\\u2713 RSI added');`,

            bbands: `// Bollinger Bands
const chart = window.app.widget.activeChart();
chart.createStudy('Bollinger Bands', false, false, { length: 20, mult: 2 });
console.log('\\u2713 Bollinger Bands added');`,
        };
    }

    setupEventListeners() {
        // Tab switching
        document.querySelectorAll('.code-tab').forEach(tab => {
            tab.addEventListener('click', (e) => this.switchTab(e.target.closest('.code-tab').dataset.tab));
        });

        // Pine Script controls
        const pineExamples = document.getElementById('pineExamples');
        if (pineExamples) {
            pineExamples.addEventListener('change', async (e) => {
                if (e.target.value === '__manage__') {
                    this.openScriptManager('pine');
                    e.target.value = '';
                } else if (e.target.value) {
                    this.loadPineExample(e.target.value);
                    e.target.value = '';
                }
            });
        }

        const pineClearBtn = document.getElementById('pineClearBtn');
        if (pineClearBtn) {
            pineClearBtn.addEventListener('click', () => this.clearPineEditor());
        }


        const pineSaveBtn = document.getElementById('pineSaveBtn');
        if (pineSaveBtn) {
            pineSaveBtn.addEventListener('click', () => this.saveScript('pine', 5));
        }

        const pine6SaveBtn = document.getElementById('pine6SaveBtn');
        if (pine6SaveBtn) {
            pine6SaveBtn.addEventListener('click', () => this.saveScript('pine', 6));
        }

        const jsSaveBtn = document.getElementById('jsSaveBtn');
        if (jsSaveBtn) {
            jsSaveBtn.addEventListener('click', () => this.saveScript('javascript', null));
        }


        const pineRunBtn = document.getElementById('pineRunBtn');
        if (pineRunBtn) {
            pineRunBtn.addEventListener('click', () => this.runPineScript());
        }

        const pineConsoleClear = document.getElementById('pineConsoleClear');
        if (pineConsoleClear) {
            pineConsoleClear.addEventListener('click', () => this.clearPineConsole());
        }

        // JavaScript controls
        const jsExamples = document.getElementById('jsExamples');
        if (jsExamples) {
            jsExamples.addEventListener('change', async (e) => {
                if (e.target.value === '__manage__') {
                    this.openScriptManager('javascript');
                    e.target.value = '';
                } else if (e.target.value) {
                    this.loadJSExample(e.target.value);
                    e.target.value = '';
                }
            });
        }

        const jsClearBtn = document.getElementById('jsClearBtn');
        if (jsClearBtn) {
            jsClearBtn.addEventListener('click', () => this.clearJSEditor());
        }

        const jsRunBtn = document.getElementById('jsRunBtn');
        if (jsRunBtn && 1 == 2) {
            jsRunBtn.addEventListener('click', () => this.runJavaScript());
        }

        const jsConsoleClear = document.getElementById('jsConsoleClear');
        if (jsConsoleClear) {
            jsConsoleClear.addEventListener('click', () => this.clearJSConsole());
        }

        // Keyboard shortcuts
        const pineEditor = document.getElementById('pineEditor');
        if (pineEditor) {
            pineEditor.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    this.runPineScript();
                }
            });
        }

        const jsEditor = document.getElementById('jsEditor');
        if (jsEditor) {
            jsEditor.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    this.runJavaScript();
                }
            });
        }

        // Pine 6 controls
        const pine6Examples = document.getElementById('pine6Examples');
        if (pine6Examples) {
            pine6Examples.addEventListener('change', async (e) => {
                if (e.target.value === '__manage__') {
                    this.openScriptManager('pine6');
                    e.target.value = '';
                } else if (e.target.value) {
                    this.loadPine6Example(e.target.value);
                    e.target.value = '';
                }
            });
        }

        const pine6ClearBtn = document.getElementById('pine6ClearBtn');
        if (pine6ClearBtn) {
            pine6ClearBtn.addEventListener('click', () => this.clearPine6Editor());
        }

        const pine6RunBtn = document.getElementById('pine6RunBtn');
        if (pine6RunBtn) {
            pine6RunBtn.addEventListener('click', () => this.runPine6Script());
        }

        const pine6ConsoleClear = document.getElementById('pine6ConsoleClear');
        if (pine6ConsoleClear) {
            pine6ConsoleClear.addEventListener('click', () => this.clearPine6Console());
        }

        const pine6Editor = document.getElementById('pine6Editor');
        if (pine6Editor) {
            pine6Editor.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    this.runPine6Script();
                }
            });
        }
    }

    populateExamplesDropdowns() {
        const pineSelect = document.getElementById('pineExamples');
        const jsSelect = document.getElementById('jsExamples');
        const pine6Select = document.getElementById('pine6Examples');

        if (pineSelect) {
            pineSelect.innerHTML = '<option value="">📚 Select Example...</option>';
            Object.keys(this.pineExamples).forEach(key => {
                pineSelect.innerHTML += `<option value="${key}">${key}</option>`;
            });
            pineSelect.innerHTML += '<option value="__manage__">⚙ Manage Scripts...</option>';
        }

        if (jsSelect) {
            jsSelect.innerHTML = '<option value="">📚 Select Example...</option>';
            Object.keys(this.jsExamples).forEach(key => {
                jsSelect.innerHTML += `<option value="${key}">${key}</option>`;
            });
            jsSelect.innerHTML += '<option value="__manage__">⚙ Manage Scripts...</option>';
        }

        if (pine6Select) {
            pine6Select.innerHTML = '<option value="">📚 Select Example...</option>';
            Object.keys(this.pine6Examples).forEach(key => {
                pine6Select.innerHTML += `<option value="${key}">${key}</option>`;
            });
            pine6Select.innerHTML += '<option value="__manage__">⚙ Manage Scripts...</option>';
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ИСПРАВЛЕНИЕ 3: ПРАВИЛЬНЫЕ ЭНДПОИНТЫ ДЛЯ СОХРАНЕНИЯ
    // ═══════════════════════════════════════════════════════════════════════

    saveScript(type, pineVersion) {
        let code = '';
        if (type === 'pine') {
            const editor = pineVersion === 6 
                ? document.getElementById('pine6Editor')
                : document.getElementById('pineEditor');
            code = editor?.value?.trim() || '';
        } else if (type === 'javascript') {
            const editor = document.getElementById('jsEditor');
            code = editor?.value?.trim() || '';
        }

        if (!code) {
            alert('No code to save');
            return;
        }

        const modal = document.createElement('div');
        modal.className = 'save-modal-overlay';
        const scriptType = type === 'pine' ? 'Pine Script ' + pineVersion : 'JavaScript';
        this.currentUser._id = this.currentUser.userId;
        const userId = this.currentUser?._id;

        console.log("this.currentUser", this.currentUser);

        modal.innerHTML = `
            <div class="save-modal">
                <div class="save-modal-header">
                    <h3>Save ${scriptType}</h3>
                    <button class="save-modal-close" onclick="this.closest('.save-modal-overlay').remove()">✕</button>
                </div>
                <div class="save-modal-body">
                    <div class="form-group">
                        <label>Display Name *</label>
                        <input type="text" id="saveDisplayName" placeholder="My Custom Indicator" required>
                    </div>
                    <div class="form-group">
                        <label>System Name * (unique identifier)</label>
                        <input type="text" id="saveSystemName" placeholder="my_custom_indicator" required>
                        <small>Use lowercase letters, numbers, and underscores only</small>
                    </div>
                    <div class="form-group">
                        <label>Description</label>
                        <textarea id="saveDescription" rows="3" placeholder="Describe what this script does..."></textarea>
                    </div>
                    <div class="form-group">
                        <label>
                            <input type="checkbox" id="saveIsPublic">
                            Make this script public (visible to all users)
                        </label>
                    </div>
                </div>
                <div class="save-modal-footer">
                    <button class="btn-cancel" onclick="this.closest('.save-modal-overlay').remove()">Cancel</button>
                    <button class="btn-save" id="confirmSaveBtn">Save</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // Обработчик сохранения
        document.getElementById('confirmSaveBtn').addEventListener('click', async () => {
            const displayName = document.getElementById('saveDisplayName').value.trim();
            const systemName = document.getElementById('saveSystemName').value.trim();
            const description = document.getElementById('saveDescription').value.trim();
            const isPublic = document.getElementById('saveIsPublic').checked();
            
            if (!displayName || !systemName) {
                alert('Please fill in required fields');
                return;
            }
            
            try {
                // ИСПРАВЛЕНИЕ: используем правильный эндпоинт в зависимости от типа
                const endpoint = type === 'javascript' 
                    ? '/api/javascript-scripts'
                    : '/api/pine-scripts';

                const payload = {
                    display_name: displayName,
                    system_name: systemName,
                    description: description,
                    code: code,
                    type: type,
                    is_public: isPublic,
                    script_type: scriptType,
                    user_id: userId 
                };

                if (type === 'pine') {
                    payload.pine_version = pineVersion;
                }

                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    credentials: 'include',
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    const error = await response.json();
                    throw new Error(error.error || 'Failed to save script');
                }
                
                alert('Script saved successfully!');
                modal.remove();
                
                // Перезагружаем примеры
                await this.loadExamplesFromDatabase();
                
            } catch (error) {
                alert('Failed to save script: ' + error.message);
                console.error('Save error:', error);
            }
        });
        
        // Auto-generate system_name from display_name
        document.getElementById('saveDisplayName').addEventListener('input', (e) => {
            const systemNameInput = document.getElementById('saveSystemName');
            if (!systemNameInput.value) {
                systemNameInput.value = e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '_')
                    .replace(/^_+|_+$/g, '');
            }
        });
    }

    openScriptManager(type) {
        if (window.scriptManagerUI) {
            window.scriptManagerUI.open(type);
        } else {
            alert('Script manager not loaded. Please refresh the page.');
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TAB SWITCHING
    // ═══════════════════════════════════════════════════════════════════════

    switchTab(tabName) {
        document.querySelectorAll('.code-tab').forEach(tab => {
            tab.classList.remove('active');
        });
        
        document.querySelectorAll('.code-tab-content').forEach(content => {
            content.classList.remove('active');
        });
        
        const activeTab = document.querySelector(`.code-tab[data-tab="${tabName}"]`);
        const activeContent = document.getElementById(`${tabName}-tab`);
        
        if (activeTab) activeTab.classList.add('active');
        if (activeContent) activeContent.classList.add('active');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PINE SCRIPT 5 METHODS
    // ═══════════════════════════════════════════════════════════════════════

    loadPineExample(key) {
        const editor = document.getElementById('pineEditor');
        if (editor && this.pineExamples[key]) {
            editor.value = this.pineExamples[key];
            this.logPineConsole(`Example loaded: ${key}`, 'info');
        }
    }

    clearPineEditor() {
        const editor = document.getElementById('pineEditor');
        if (editor) {
            editor.value = '';
            this.logPineConsole('Editor cleared', 'info');
        }
    }

    async runPineScript() {
        const editor = document.getElementById('pineEditor');
        if (!editor) return;

        const code = editor.value.trim();
        if (!code) {
            this.logPineConsole('Error: No code to execute', 'error');
            return;
        }

        const runBtn = document.getElementById('pineRunBtn');
        if (runBtn) {
            runBtn.disabled = true;
            runBtn.innerHTML = '<span>⏳</span> Running...';
        }

        this.clearPineConsole();
        this.logPineConsole('→ Compiling Pine Script...', 'info');

        try {
            const pineIntegration = window.pineIntegration;
            if (!pineIntegration) {
                throw new Error('Pine integration not loaded');
            }

            await pineIntegration.executePineScript(code, this.widget);
            this.logPineConsole('✓ Script executed successfully', 'success');
        } catch (error) {
            this.logPineConsole('✗ Error: ' + error.message, 'error');
            console.error('Pine execution error:', error);
        } finally {
            if (runBtn) {
                runBtn.disabled = false;
                runBtn.innerHTML = '<span>▶</span> Run Pine Script';
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // JAVASCRIPT METHODS — ИСПРАВЛЕНИЕ 1: LOADER + ОТМЕНА + ОБРАБОТКА ОШИБОК
    // ═══════════════════════════════════════════════════════════════════════

    loadJSExample(key) {
        const editor = document.getElementById('jsEditor');
        if (editor && this.jsExamples[key]) {
            editor.value = this.jsExamples[key];
            this.logJSConsole(`Example loaded: ${key}`, 'info');
        }
    }

    clearJSEditor() {
        const editor = document.getElementById('jsEditor');
        if (editor) {
            editor.value = '';
            this.logJSConsole('Editor cleared', 'info');
        }
    }

    async runJavaScript() {
        const editor = document.getElementById('jsEditor');
        if (!editor) return;

        const code = editor.value.trim();
        if (!code) {
            this.logJSConsole('Error: No code to execute', 'error');
            return;
        }

        const runBtn = document.getElementById('jsRunBtn');
        
        // Показываем loader + кнопку отмены
        if (runBtn) {
            runBtn.disabled = true;
            runBtn.innerHTML = `
                <span>⏳</span> Executing... 
                <button id="jsAbortBtn" style="margin-left:8px;padding:2px 8px;background:#ef5350;border:none;border-radius:3px;color:white;cursor:pointer">✕ Cancel</button>
            `;
        }

        this.clearJSConsole();
        this.logJSConsole('→ Executing JavaScript...', 'info');

        // Создаём AbortController для отмены
        this.jsExecutionAbortController = new AbortController();
        const signal = this.jsExecutionAbortController.signal;

        // Обработчик кнопки отмены
        setTimeout(() => {
            const abortBtn = document.getElementById('jsAbortBtn');
            if (abortBtn) {
                abortBtn.addEventListener('click', () => {
                    this.jsExecutionAbortController.abort();
                    this.logJSConsole('⚠ Execution cancelled by user', 'warning');
                    if (runBtn) {
                        runBtn.disabled = false;
                        runBtn.innerHTML = '<span>▶</span> Execute JavaScript';
                    }
                });
            }
        }, 50);

        try {
            // Проверка доступности widget
            if (!window.app || !window.app.widget) {
                throw new Error('TradingView widget not available');
            }

            // Устанавливаем глобальные переменные
            window.chart = window.app.widget.activeChart();
            window.widget = window.app.widget;
            
            console.log('✓ chart set:', typeof window.chart);
            console.log('✓ widget set:', typeof window.widget);
            
            // Выполняем код с проверкой отмены
            if (signal.aborted) {
                throw new Error('Execution aborted');
            }

            const result = eval(code);

            // Обрабатываем промисы
            if (result && typeof result.then === 'function') {
                await Promise.race([
                    result,
                    new Promise((_, reject) => {
                        signal.addEventListener('abort', () => reject(new Error('Execution aborted')));
                    })
                ]);
            }

            if (!signal.aborted) {
                this.logJSConsole('✓ Execution completed successfully', 'success');
            }

        } catch (error) {
            if (error.message === 'Execution aborted') {
                // Уже обработано в onabort
                return;
            }

            // Детальная обработка ошибок
            this.logJSConsole('✗ Execution failed', 'error');
            this.logJSConsole(`Error: ${error.name}: ${error.message}`, 'error');
            
            if (error.stack) {
                const stackLines = error.stack.split('\n').slice(0, 3);
                stackLines.forEach(line => {
                    this.logJSConsole(`  ${line.trim()}`, 'error');
                });
            }
            
            console.error('JavaScript execution error:', error);

        } finally {
            this.jsExecutionAbortController = null;
            
            if (runBtn) {
                runBtn.disabled = false;
                runBtn.innerHTML = '<span>▶</span> Execute JavaScript';
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PINE SCRIPT 6 METHODS
    // ═══════════════════════════════════════════════════════════════════════

    loadPine6Example(key) {
        const editor = document.getElementById('pine6Editor');
        if (editor && this.pine6Examples[key]) {
            editor.value = this.pine6Examples[key];
            this.logPine6Console(`Example loaded: ${key}`, 'info');
        }
    }

    clearPine6Editor() {
        const editor = document.getElementById('pine6Editor');
        if (editor) {
            editor.value = '';
            this.logPine6Console('Editor cleared', 'info');
        }
    }

    async runPine6Script() {
        const editor = document.getElementById('pine6Editor');
        if (!editor) return;

        const code = editor.value.trim();
        if (!code) {
            this.logPine6Console('Error: No code to execute', 'error');
            return;
        }

        const runBtn = document.getElementById('pine6RunBtn');
        if (runBtn) {
            runBtn.disabled = true;
            runBtn.innerHTML = '<span>⏳</span> Running...';
        }

        this.clearPine6Console();
        this.logPine6Console('→ Compiling Pine Script 6...', 'info');

        try {
            const pineIntegration = window.pineIntegration;
            if (!pineIntegration) {
                throw new Error('Pine integration not loaded');
            }

            await pineIntegration.executePineScript6(code, this.widget);
            this.logPine6Console('✓ Script executed successfully', 'success');
        } catch (error) {
            this.logPine6Console('✗ Error: ' + error.message, 'error');
            console.error('Pine 6 execution error:', error);
        } finally {
            if (runBtn) {
                runBtn.disabled = false;
                runBtn.innerHTML = '<span>▶</span> Run Pine Script 6';
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CONSOLE LOGGING
    // ═══════════════════════════════════════════════════════════════════════

    logPineConsole(message, type = 'info') {
        this._logToConsole('pineConsoleBody', message, type);
    }

    logPine6Console(message, type = 'info') {
        this._logToConsole('pine6ConsoleBody', message, type);
    }

    logJSConsole(message, type = 'info') {
        this._logToConsole('jsConsoleBody', message, type);
    }

    _logToConsole(consoleId, message, type) {
        const console = document.getElementById(consoleId);
        if (!console) return;

        const line = document.createElement('div');
        line.className = `console-line console-${type}`;
        line.textContent = message;
        console.appendChild(line);
        console.scrollTop = console.scrollHeight;
    }

    clearPineConsole() {
        const console = document.getElementById('pineConsoleBody');
        if (console) console.innerHTML = '';
    }

    clearPine6Console() {
        const console = document.getElementById('pine6ConsoleBody');
        if (console) console.innerHTML = '';
    }

    clearJSConsole() {
        const console = document.getElementById('jsConsoleBody');
        if (console) console.innerHTML = '';
    }
}

// Initialize
const codePanelManager = new CodePanelManagerEnhanced();
window.codePanelManager = codePanelManager;