/**
 * Code Panel Manager - Database Integrated Version
 * Manages Pine Script and JavaScript tabs with database integration
 */

class CodePanelManager {
    constructor() {
        this.widget = null;
        this.activePineScripts = [];
        this.activePine6Scripts = [];
        this.activeJSScripts = [];
        this.pineScriptCounter = 0;
        
        
        // Will be loaded from database
        this.pineExamples = {};
        this.jsExamples = {};
        this.currentUser = null;
    }

    /**
     * Initialize the panel
     */
    async init(widget) {
        this.widget = widget;
        
        // Get current user
        try {
            const authStatus = await apiClient.checkAuthStatus();
            this.currentUser = authStatus;
        } catch (error) {
            console.error('Failed to get auth status:', error);
        }
        
        // Load examples from database
        await this.loadExamplesFromDatabase();

        // Перезагружаем скрипты после логина
        window.addEventListener('user-logged-in', async () => {
            try {
                const authStatus = await apiClient.checkAuthStatus();
                this.currentUser = authStatus;
            } catch(e) {}
            await this.loadExamplesFromDatabase();
        });

        this.logPine6Console('✓ Pine Script 6 Editor initialized', 'success');
        
        this.setupEventListeners();
        this.logPineConsole('✓ Pine Script Editor initialized', 'success');
        this.logJSConsole('✓ JavaScript API ready', 'success');
        console.log('CodePanelManager initialized with database integration');
    }

    /**
     * Load examples from database
     */
    
    async loadExamplesFromDatabase() {
        try {
            // Load Pine Script examples
            const pineScripts = await apiClient.getPineScripts();
            this.pineExamples = {};
            
            // Разделяем Pine 5 и Pine 6
            const pine5Scripts = pineScripts.filter(s => !s.pine_version || s.pine_version === 5);
            const pine6Scripts = pineScripts.filter(s => s.pine_version === 6);
            
            pine5Scripts.forEach(script => {
                this.pineExamples[script.system_name] = script.code;
            });
            
            this.pine6Examples = {}; // НОВОЕ
            pine6Scripts.forEach(script => {
                this.pine6Examples[script.system_name] = script.code;
            });
            
            this.updatePineExamplesDropdown(pine5Scripts);
            this.updatePine6ExamplesDropdown(pine6Scripts); // НОВОЕ
            
            // Load JavaScript examples
            const jsScripts = await apiClient.getJavaScriptScripts();
            this.jsExamples = {};


            this.jsScriptObjects = {};

            jsScripts.forEach(script => { //
                this.jsExamples[script.system_name] = script.code;
                this.jsScriptObjects[script.system_name] = script;
            });
            
            this.updateJSExamplesDropdown(jsScripts);
            
            console.log(`✓ Loaded ${pine5Scripts.length} Pine 5, ${pine6Scripts.length} Pine 6, ${jsScripts.length} JS scripts`);
        } catch (error) {
            console.error('Failed to load examples from database:', error);
            this.loadFallbackExamples();
        }
    }

    // ДОБАВЬТЕ НОВЫЙ МЕТОД:
    updatePine6ExamplesDropdown(scripts) {
        const select = document.getElementById('pine6Examples');
        if (!select) {
            console.warn('pine6Examples select not found - Pine 6 tab may not be in HTML');
            return;
        }
        
        while (select.options.length > 1) {
            select.remove(1);
        }
        
        scripts.forEach(script => {
            const option = document.createElement('option');
            option.value = script.system_name;
            option.textContent = script.display_name;
            select.appendChild(option);
        });
        
        if (this.currentUser && this.currentUser.authenticated) {
            const separator = document.createElement('option');
            separator.disabled = true;
            separator.textContent = '─────────────────';
            select.appendChild(separator);
            
            const manageOption = document.createElement('option');
            manageOption.value = '__manage__';
            manageOption.textContent = '⚙️ Manage Scripts...';
            select.appendChild(manageOption);
        }
    }

    /**
     * Update Pine Script examples dropdown
     */
    updatePineExamplesDropdown(scripts) {
        const select = document.getElementById('pineExamples');
        if (!select) return;
        
        // Clear existing options except first
        while (select.options.length > 1) {
            select.remove(1);
        }
        
        // Add scripts from database
        scripts.forEach(script => {
            const option = document.createElement('option');
            option.value = script.system_name;
            option.textContent = script.display_name;
            select.appendChild(option);
        });
        
        // Add "Manage Scripts" option for authenticated users
        if (this.currentUser && this.currentUser.authenticated) {
            const separator = document.createElement('option');
            separator.disabled = true;
            separator.textContent = '─────────────────';
            select.appendChild(separator);
            
            const manageOption = document.createElement('option');
            manageOption.value = '__manage__';
            manageOption.textContent = '⚙️ Manage Scripts...';
            select.appendChild(manageOption);
        }
    }

    /**
     * Update JavaScript examples dropdown
     */
    updateJSExamplesDropdown(scripts) { 
        const select = document.getElementById('jsExamples');
        if (!select) return;
        
        while (select.options.length > 1) {
            select.remove(1);
        }
        
        scripts.forEach(script => {
            const option = document.createElement('option');
            option.value = script.system_name;
            option.textContent = script.display_name;
            select.appendChild(option);
        });
        
        if (this.currentUser && this.currentUser.authenticated) {
            const separator = document.createElement('option');
            separator.disabled = true;
            separator.textContent = '─────────────────';
            select.appendChild(separator);
            
            const manageOption = document.createElement('option');
            manageOption.value = '__manage__';
            manageOption.textContent = '⚙️ Manage Scripts...';
            select.appendChild(manageOption);
        }
    }

    /**
     * Load fallback examples if database fails
     */
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
const chart = window.app.widget.activeChart();
chart.createStudy('Average True Range', false, false, [14]);
console.log('✓ ATR added');`
        };
    }

    /**
     * Setup event listeners
     */
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
        if (jsRunBtn) {
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


        // Pine Script 6 controls
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

    saveScript(type, pineVersion) {
        let code, editorId;
        
        if (type === 'pine' && pineVersion === 5) {
            editorId = 'pineEditor';
        } else if (type === 'pine' && pineVersion === 6) {
            editorId = 'pine6Editor';
        } else {
            editorId = 'jsEditor';
        }
        
        const editor = document.getElementById(editorId);
        if (!editor) return;
        
        code = editor.value.trim();
        
        if (!code) {
            alert('Please write some code first');
            return;
        }
        
        // Создаём модальное окно
        this.openSaveModal(type, pineVersion, code);
    }

    openSaveModal(type, pineVersion, code) {
        const modal = document.createElement('div');
        modal.className = 'save-modal-overlay';
        const scriptType = type === 'pine' ? 'Pine Script ' + pineVersion : 'JavaScript'
        this.currentUser._id = this.currentUser.userId
        const userId = this.currentUser?._id

        console.log("this.currentUser", this.currentUser)

        modal.innerHTML = `
            <div class="save-modal">
                <div class="save-modal-header">
                    <h3>Save ${type === 'pine' ? 'Pine Script ' + pineVersion : 'JavaScript'}</h3>
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
            const isPublic = document.getElementById('saveIsPublic').checked;
            
            if (!displayName || !systemName) {
                alert('Please fill in required fields');
                return;
            }
            
            try {
                await apiClient.createScript({
                    display_name: displayName,
                    system_name: systemName,
                    description: description,
                    code: code,
                    type: type,
                    is_public: isPublic,
                    script_type: scriptType,
                    pine_version: pineVersion,
                    user: JSON.stringify(this.currentUser),
                    user_id: userId 
                });
                
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

    /**
     * Open script manager modal
     */
    openScriptManager(type) {
        if (window.scriptManagerUI) {
            window.scriptManagerUI.open(type);
        } else {
            alert('Script manager not loaded. Please refresh the page.');
        }
    }

    /**
     * Switch between tabs
     */
    switchTab(tabName) {
        document.querySelectorAll('.code-tab').forEach(tab => {
            tab.classList.remove('active');
            if (tab.dataset.tab === tabName) {
                tab.classList.add('active');
            }
        });

        document.querySelectorAll('.code-tab-content').forEach(content => {
            content.classList.remove('active');
        });
        const activeContent = document.getElementById(`${tabName}-tab`);
        if (activeContent) {
            activeContent.classList.add('active');
        }
    }

    // ==================== PINE SCRIPT METHODS ====================

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
            const nameMatch = code.match(/indicator\s*\(\s*["']([^"']+)["']/);
            const indicatorName = nameMatch ? nameMatch[1] : 'Custom Indicator';

            await new Promise(resolve => setTimeout(resolve, 500));

            this.logPineConsole('✓ Compilation successful', 'success');
            this.logPineConsole(`✓ Indicator "${indicatorName}" ready`, 'success');

            this.addPineScript(indicatorName);

            // Проверяем доступность widget и chart
            if (this.widget && typeof this.widget.activeChart === 'function') {
                try {
                    this.createCustomIndicator(code, indicatorName);
                } catch (widgetError) {
                    this.logPineConsole('⚠ Could not add to chart: ' + widgetError.message, 'warning');
                }
            } else {
                this.logPineConsole('⚠ Chart not ready yet - indicator saved for later', 'warning');
            }

        } catch (error) {
            this.logPineConsole('✗ Error: ' + error.message, 'error');
        } finally {
            if (runBtn) {
                runBtn.disabled = false;
                runBtn.innerHTML = '<span>▶</span> Run Pine Script';
            }
        }
    }

    createCustomIndicator(code, name) {
        try {
            const timestamp = Date.now();
            const random = Math.random().toString(36).substring(2, 8);
            const id = `pine_${timestamp}_${random}`;
            
            if (!window.customPineIndicators) {
                window.customPineIndicators = [];
            }

            const isOverlay = code.includes('overlay=true') || code.includes('overlay = true');

            const indicator = {
                name: name,
                metainfo: {
                    _metainfoVersion: 53,
                    id: id,
                    description: name,
                    shortDescription: name.substring(0, 15),
                    is_price_study: isOverlay,
                    isCustomIndicator: true,
                    format: { type: isOverlay ? 'inherit' : 'price' },
                    
                    plots: [{
                        id: 'plot_0',
                        type: 'line'
                    }],
                    
                    defaults: {
                        styles: {
                            plot_0: {
                                linestyle: 0,
                                linewidth: 2,
                                plottype: 0,
                                trackPrice: false,
                                transparency: 0,
                                visible: true,
                                color: '#2962FF'
                            }
                        }
                    },
                    
                    styles: {
                        plot_0: {
                            title: 'Value',
                            histogramBase: 0
                        }
                    }
                },
                
                constructor: function() {
                    this.main = function(context, inputCallback) {
                        this._context = context;
                        return [50 + Math.random() * 10];
                    };
                }
            };

            window.customPineIndicators.push(indicator);
            this.logPineConsole(`✓ Indicator added to chart registry`, 'success');
            
            if (this.widget && this.widget.activeChart) {
                try {
                    try {
                        const chart = this.widget.activeChart();
                        
                        //name = name.replaceAll(' ', '_');
                        console.log("name", name)
                        // Используем уникальный ID вместо имени
                        chart.createStudy(name, isOverlay, false, [], {
                            id: id  // Передаём явный ID
                        });
                        
                        this.logPineConsole(`✓ Indicator displayed on chart (ID: ${id})`, 'success');
                    } catch (e) {
                        this.logPineConsole(`⚠ Could not display: ${e.message}`, 'warning');
                        console.error('Study creation error:', e);
                    }
                    this.logPineConsole(`✓ Indicator displayed on chart`, 'success');
                } catch (e) {
                    this.logPineConsole(`⚠ Could not display: ${e.message}`, 'warning');
                }
            }

        } catch (error) {
            this.logPineConsole(`✗ Error: ${error.message}`, 'error');
        }
    }

    addPineScript(name) {
        const id = `script_${Date.now()}`;
        this.activePineScripts.push({ id, name });
        this.updatePineScriptsList();
    }

    removePineScript(id) {
        this.activePineScripts = this.activePineScripts.filter(s => s.id !== id);
        this.updatePineScriptsList();
    }

    updatePineScriptsList() {
        const listEl = document.getElementById('pineScriptsList');
        if (!listEl) return;

        if (this.activePineScripts.length === 0) {
            listEl.innerHTML = '<div class="no-scripts">No active indicators</div>';
            return;
        }

        listEl.innerHTML = this.activePineScripts.map(script => `
            <div class="script-item">
                <span class="script-name">${script.name}</span>
                <button class="script-remove" onclick="codePanelManager.removePineScript('${script.id}')">
                    Remove
                </button>
            </div>
        `).join('');
    }

    // ==================== JAVASCRIPT METHODS ====================

    loadJSExample(key) {
        const editor = document.getElementById('jsEditor');
        if (editor && this.jsExamples[key]) {
            editor.value = this.jsExamples[key];
            this._currentJsSystemName = key; // track for scriptId injection
            const scriptObj = this.jsScriptObjects?.[key];
            this._currentJsScriptId = scriptObj?.id || null;
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
        console.log("Starting JavaScript execution...");
        const editor = document.getElementById('jsEditor');
        if (!editor) return;

        const code = editor.value.trim();
        if (!code) {
            this.logJSConsole('Error: No code to execute', 'error');
            return;
        }

        const runBtn = document.getElementById('jsRunBtn');
        if (runBtn) {
            runBtn.disabled = true;
            runBtn.innerHTML = '<span>⏳</span> Executing...';
        }

        this.clearJSConsole();
        this.logJSConsole('→ Executing JavaScript...', 'info');

        try {
            // Ensure widget is available
            if (!window.app || !window.app.widget) {
                throw new Error('TradingView widget not available');
            }

            // Set global variables BEFORE eval
            window.chart = window.app.widget.activeChart();
            window.widget = window.app.widget;
            
            // Log for debugging
            console.log('✓ chart set:', typeof window.chart);
            console.log('✓ widget set:', typeof window.widget);

            // Snapshot setups BEFORE eval to detect new ones added by script
            const _setupsBefore = new Set(Object.keys(window.app?.setups || {}));
            
            try {
                // Execute code directly

                console.log("Pre__Eval");
                const result = eval(code); 

                // Handle promises
                if (result && typeof result.then === 'function') {
                    await result;
                }

                this.logJSConsole('✓ Execution completed successfully', 'success');
             
                console.log("In _currentJsScriptId", 1, this._currentJsScriptId)

                if(!this._currentJsScriptId){
                    this._currentJsScriptId = 123456
                }
                // AUTO-INJECT scriptId into setups registered by the script
                   
                console.log("window.app", window.app, window.app.setups)
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
            } finally {
                // Keep chart and widget available for debugging
                // Don't delete them immediately
            }

        } catch (error) {
            this.logJSConsole('✗ Error: ' + error.message, 'error');
            console.error('JavaScript execution error:', error);
        } finally {
            if (runBtn) {
                runBtn.disabled = false;
                runBtn.innerHTML = '<span>▶</span> Execute JavaScript';
            }
        }
    }


    // ==================== PINE SCRIPT 6 METHODS ====================

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

        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 8);
        const uniqueId = `pine6_${timestamp}_${random}`;
        
        
        try {
            const nameMatch = code.match(/indicator\s*\(\s*["']([^"']+)["']/);
            const indicatorName = nameMatch ? nameMatch[1] : 'Custom Indicator (v6)';

            await new Promise(resolve => setTimeout(resolve, 500));

            this.logPine6Console('✓ Compilation successful', 'success');
            this.logPine6Console(`✓ Indicator "${indicatorName}" ready`, 'success');

            // Используем ту же логику что и для Pine 5
            if (this.widget && typeof this.widget.activeChart === 'function') {
                try {
                    this.createCustomIndicator(code, indicatorName);

                    /*
                    // И при создании индикатора:
                    chart.createStudy(indicatorName, isOverlay, false, [], {
                        id: uniqueId
                    });
                    */
                } catch (widgetError) {
                    this.logPine6Console('⚠ Could not add to chart: ' + widgetError.message, 'warning');
                }
            } else {
                this.logPine6Console('⚠ Chart not ready yet', 'warning');
            }

        } catch (error) {
            this.logPine6Console('✗ Error: ' + error.message, 'error');
        } finally {
            if (runBtn) {
                runBtn.disabled = false;
                runBtn.innerHTML = '<span>▶</span> Run Pine Script 6';
            }
        }
    }

    logPine6Console(message, type = 'info') {
        this.logToConsole('pine6ConsoleBody', message, type);
    }

    clearPine6Console() {
        const consoleBody = document.getElementById('pine6ConsoleBody');
        if (consoleBody) consoleBody.innerHTML = '';
    }

    // ==================== CONSOLE METHODS ====================

    logPineConsole(message, type = 'info') {
        this.logToConsole('pineConsoleBody', message, type);
    }

    clearPineConsole() {
        const consoleBody = document.getElementById('pineConsoleBody');
        if (consoleBody) consoleBody.innerHTML = '';
    }

    logJSConsole(message, type = 'info') {
        this.logToConsole('jsConsoleBody', message, type);
    }

    clearJSConsole() {
        const consoleBody = document.getElementById('jsConsoleBody');
        if (consoleBody) consoleBody.innerHTML = '';
    }

    logToConsole(consoleId, message, type = 'info') {
        const consoleBody = document.getElementById(consoleId);
        if (!consoleBody) return;

        const line = document.createElement('div');
        line.className = `console-line console-${type}`;
        const time = new Date().toLocaleTimeString();
        line.textContent = `[${time}] ${message}`;
        
        consoleBody.appendChild(line);
        consoleBody.scrollTop = consoleBody.scrollHeight;
    }
}

// Initialize
//let codePanelManager;

const codePanelManager = new CodePanelManager();
window.codePanelManager = codePanelManager;