/**
 * Pine Script Editor Integration
 * Integrates PineTS with TradingView Advanced Charts
 */

class PineScriptEditor {
    constructor() {
        this.widget = null;
        this.activeIndicators = [];
        this.indicatorCounter = 0;
        this.isCollapsed = false;
        
        // Pine Script examples
        this.examples = {
            sma: `//@version=5
indicator("Simple Moving Average", overlay=true)
length = input.int(20, "Period", minval=1, maxval=500)
source = input.source(close, "Source")
sma_value = ta.sma(source, length)
plot(sma_value, "SMA", color=color.blue, linewidth=2)`,

            ema_cross: `//@version=5
indicator("EMA Crossover", overlay=true)
fast_length = input.int(9, "Fast EMA", minval=1)
slow_length = input.int(21, "Slow EMA", minval=1)

ema_fast = ta.ema(close, fast_length)
ema_slow = ta.ema(close, slow_length)

plot(ema_fast, "Fast EMA", color=color.green, linewidth=2)
plot(ema_slow, "Slow EMA", color=color.red, linewidth=2)

// Crossover signals
bullCross = ta.crossover(ema_fast, ema_slow)
bearCross = ta.crossunder(ema_fast, ema_slow)

plotshape(bullCross, "Buy Signal", shape.triangleup, 
          location.belowbar, color.new(color.green, 0), size=size.small)
plotshape(bearCross, "Sell Signal", shape.triangledown, 
          location.abovebar, color.new(color.red, 0), size=size.small)`,

            rsi: `//@version=5
indicator("RSI with Levels")
length = input.int(14, "RSI Period", minval=1)
overbought = input.int(70, "Overbought Level", minval=50, maxval=100)
oversold = input.int(30, "Oversold Level", minval=0, maxval=50)

rsi_value = ta.rsi(close, length)

plot(rsi_value, "RSI", color=color.purple, linewidth=2)
hline(overbought, "Overbought", color=color.red, linestyle=hline.style_dashed)
hline(50, "Middle", color=color.gray, linestyle=hline.style_dotted)
hline(oversold, "Oversold", color=color.green, linestyle=hline.style_dashed)`,

            macd: `//@version=5
indicator("MACD")
fast = input.int(12, "Fast Length")
slow = input.int(26, "Slow Length")
signal = input.int(9, "Signal Length")

[macdLine, signalLine, histLine] = ta.macd(close, fast, slow, signal)

plot(macdLine, "MACD", color=color.blue, linewidth=2)
plot(signalLine, "Signal", color=color.orange, linewidth=2)
plot(histLine, "Histogram", color=color.gray, style=plot.style_histogram)
hline(0, "Zero Line", color=color.gray)`,

            bb: `//@version=5
indicator("Bollinger Bands", overlay=true)
length = input.int(20, "Length", minval=1)
mult = input.float(2.0, "Standard Deviation")

basis = ta.sma(close, length)
dev = mult * ta.stdev(close, length)
upper = basis + dev
lower = basis - dev

plot(basis, "Basis", color=color.blue, linewidth=2)
plot(upper, "Upper Band", color=color.red)
plot(lower, "Lower Band", color=color.green)

// Fill between bands
fill(plot(upper), plot(lower), color=color.new(color.blue, 90))`,

            volume: `//@version=5
indicator("Volume Profile")
length = input.int(14, "Volume MA Length")

vol_ma = ta.sma(volume, length)

color volColor = volume > vol_ma ? color.green : color.red

plot(volume, "Volume", color=volColor, style=plot.style_histogram)
plot(vol_ma, "Volume MA", color=color.orange, linewidth=2)`
        };
    }

    /**
     * Initialize the editor
     */
    init(widget) {
        this.widget = widget;
        this.setupEventListeners();
        this.updateLineNumbers();
        this.logConsole('Pine Script Editor initialized successfully', 'success');
        this.logConsole('Widget available: ' + (this.widget ? 'Yes' : 'No'), 'info');
    }

    /**
     * Setup event listeners
     */
    setupEventListeners() {
        // Toggle editor
        const toggleBtn = document.getElementById('pineEditorToggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => this.toggleEditor());
        }

        // Run script button
        const runBtn = document.getElementById('editorRunBtn');
        if (runBtn) {
            runBtn.addEventListener('click', () => this.runScript());
        }

        // Clear button
        const clearBtn = document.getElementById('editorClearBtn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => this.clearEditor());
        }

        // Examples select
        const examplesSelect = document.getElementById('pineExamplesSelect');
        if (examplesSelect) {
            examplesSelect.addEventListener('change', (e) => {
                if (e.target.value) {
                    this.loadExample(e.target.value);
                    e.target.value = '';
                }
            });
        }

        // Console clear button
        const consoleClearBtn = document.getElementById('consoleClearBtn');
        if (consoleClearBtn) {
            consoleClearBtn.addEventListener('click', () => this.clearConsole());
        }

        // Code editor - update line numbers
        const editor = document.getElementById('pineCodeEditor');
        if (editor) {
            editor.addEventListener('input', () => this.updateLineNumbers());
            editor.addEventListener('scroll', () => this.syncLineNumbers());
            
            // Keyboard shortcuts
            editor.addEventListener('keydown', (e) => {
                // Ctrl/Cmd + Enter to run
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    this.runScript();
                }
            });
        }
    }

    /**
     * Toggle editor visibility
     */
    toggleEditor() {
        const panel = document.getElementById('pineEditorPanel');
        this.isCollapsed = !this.isCollapsed;
        
        if (this.isCollapsed) {
            panel.classList.add('collapsed');
        } else {
            panel.classList.remove('collapsed');
        }
    }

    /**
     * Update line numbers
     */
    updateLineNumbers() {
        const editor = document.getElementById('pineCodeEditor');
        const lineNumbers = document.getElementById('editorLineNumbers');
        
        if (!editor || !lineNumbers) return;
        
        const lines = editor.value.split('\n').length;
        lineNumbers.innerHTML = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
    }

    /**
     * Sync line numbers scroll with editor
     */
    syncLineNumbers() {
        const editor = document.getElementById('pineCodeEditor');
        const lineNumbers = document.getElementById('editorLineNumbers');
        
        if (!editor || !lineNumbers) return;
        
        lineNumbers.scrollTop = editor.scrollTop;
    }

    /**
     * Load example code
     */
    loadExample(exampleKey) {
        const editor = document.getElementById('pineCodeEditor');
        if (!editor) return;
        
        const code = this.examples[exampleKey];
        if (code) {
            editor.value = code;
            this.updateLineNumbers();
            this.logConsole(`Loaded example: ${exampleKey}`, 'info');
        }
    }

    /**
     * Clear editor
     */
    clearEditor() {
        const editor = document.getElementById('pineCodeEditor');
        if (editor) {
            editor.value = '';
            this.updateLineNumbers();
            this.logConsole('Editor cleared', 'info');
        }
    }

    /**
     * Run Pine Script
     */
    async runScript() {
        const editor = document.getElementById('pineCodeEditor');
        if (!editor) return;
        
        const code = editor.value.trim();
        
        if (!code) {
            this.logConsole('Error: No code to execute', 'error');
            return;
        }

        if (!this.widget) {
            this.logConsole('Error: TradingView widget not initialized', 'error');
            return;
        }

        // Update status
        this.setStatus('running', 'Compiling...');
        const runBtn = document.getElementById('editorRunBtn');
        if (runBtn) {
            runBtn.disabled = true;
            runBtn.classList.add('loading');
        }

        this.clearConsole();
        this.logConsole('→ Starting Pine Script compilation...', 'info');

        try {
            // Check if PineTS is available
            if (typeof PineTS === 'undefined') {
                throw new Error('PineTS library not loaded. Please include PineTS in your project.');
            }

            // Get current symbol and interval from chart
            const symbol = this.getCurrentSymbol();
            const interval = this.getCurrentInterval();
            
            this.logConsole(`Symbol: ${symbol}, Interval: ${interval}`, 'info');

            // Initialize PineTS
            // Note: You need to import PineTS library
            // For now, we'll create a mock implementation
            const result = await this.compilePineScript(code, symbol, interval);

            if (result.success) {
                this.logConsole('✓ Compilation successful', 'success');
                
                // Add indicator to chart
                const indicatorName = this.extractIndicatorName(code);
                this.addIndicatorToChart(result, indicatorName);
                
                this.setStatus('ready', 'Ready');
                this.logConsole(`✓ Indicator "${indicatorName}" added to chart`, 'success');
            } else {
                throw new Error(result.error);
            }

        } catch (error) {
            this.logConsole('✗ Error: ' + error.message, 'error');
            this.setStatus('error', 'Error');
            console.error('Pine Script Error:', error);
        } finally {
            if (runBtn) {
                runBtn.disabled = false;
                runBtn.classList.remove('loading');
            }
        }
    }

    /**
     * Compile Pine Script using PineTS
     */
    async compilePineScript(code, symbol, interval) {
        // First validate the code
        if (window.PineScriptRunner && window.PineScriptRunner.validate) {
            const validation = window.PineScriptRunner.validate(code);
            if (!validation.valid) {
                throw new Error('Validation errors:\n' + validation.errors.join('\n'));
            }
        }

        // Use PineScriptRunner if available
        if (window.PineScriptRunner && window.PineScriptRunner.run) {
            this.logConsole('Using PineScriptRunner...', 'info');
            const result = await window.PineScriptRunner.run(code, symbol, interval, 500);
            
            if (!result.success) {
                throw new Error(result.error || 'Compilation failed');
            }
            
            return result;
        }

        // Fallback to mock if PineScriptRunner not available
        this.logConsole('PineScriptRunner not found, using mock execution', 'warning');
        
        return new Promise((resolve) => {
            setTimeout(() => {
                resolve({
                    success: true,
                    data: {
                        name: this.extractIndicatorName(code),
                        plots: {
                            'plot_0': {
                                data: Array(100).fill(0).map((_, i) => 100 + Math.random() * 10),
                                color: '#2962FF'
                            }
                        },
                        inputs: {},
                        isOverlay: code.includes('overlay=true')
                    }
                });
            }, 800);
        });
    }

    /**
     * Add indicator to TradingView chart
     */
    addIndicatorToChart(result, name) {
        try {
            if (!this.widget || !this.widget.activeChart) {
                throw new Error('Chart not available');
            }

            // Create custom indicator definition
            const indicatorId = `custom_indicator_${this.indicatorCounter++}`;
            
            // Store in global indicators array
            if (!window.customPineIndicators) {
                window.customPineIndicators = [];
            }

            const indicator = this.createIndicatorDefinition(result.data, name, indicatorId);
            window.customPineIndicators.push(indicator);

            // Add to active indicators list
            this.addToActiveIndicators(name, indicatorId);

            // Try to add to chart
            // Note: This requires proper custom_indicators_getter integration
            this.logConsole(`Indicator definition created: ${indicatorId}`, 'info');
            this.logConsole('Note: Full integration requires custom_indicators_getter in widget config', 'warning');

        } catch (error) {
            throw new Error('Failed to add indicator: ' + error.message);
        }
    }

    /**
     * Create TradingView indicator definition from PineTS result
     */
    createIndicatorDefinition(data, name, id) {
        const isOverlay = data.isOverlay !== undefined ? data.isOverlay : true;
        
        return {
            name: name,
            metainfo: {
                _metainfoVersion: 53,
                id: id,
                description: name,
                shortDescription: name.substring(0, 20),
                is_price_study: isOverlay,
                isCustomIndicator: true,
                format: { type: isOverlay ? 'inherit' : 'price' },
                
                plots: Object.keys(data.plots).map((key, index) => ({
                    id: `plot_${index}`,
                    type: 'line'
                })),
                
                defaults: {
                    styles: Object.keys(data.plots).reduce((acc, key, index) => {
                        acc[`plot_${index}`] = {
                            linestyle: 0,
                            linewidth: 2,
                            plottype: 0,
                            trackPrice: false,
                            transparency: 0,
                            visible: true,
                            color: data.plots[key].color || '#2962FF'
                        };
                        return acc;
                    }, {}),
                    inputs: data.inputs || {}
                },
                
                styles: Object.keys(data.plots).reduce((acc, key, index) => {
                    acc[`plot_${index}`] = {
                        title: key.replace('plot_', 'Plot '),
                        histogramBase: 0,
                        joinPoints: true
                    };
                    return acc;
                }, {}),
                
                inputs: Object.keys(data.inputs || {}).map(key => ({
                    id: key,
                    name: key,
                    defval: data.inputs[key],
                    type: typeof data.inputs[key] === 'number' ? 
                          (Number.isInteger(data.inputs[key]) ? 'integer' : 'float') : 
                          'text'
                }))
            },
            
            constructor: function() {
                const plotData = data.plots;
                this.main = function(context, inputCallback) {
                    this._context = context;
                    // Return plot values
                    // In real implementation, calculate based on context
                    return Object.values(plotData).map(plot => {
                        // Use first data point or calculate from context
                        return plot.data && plot.data.length > 0 ? plot.data[0] : 0;
                    });
                };
            }
        };
    }

    /**
     * Add indicator to active indicators list
     */
    addToActiveIndicators(name, id) {
        this.activeIndicators.push({ name, id });
        this.updateActiveIndicatorsList();
    }

    /**
     * Remove indicator
     */
    removeIndicator(id) {
        this.activeIndicators = this.activeIndicators.filter(ind => ind.id !== id);
        this.updateActiveIndicatorsList();
        
        // Remove from global array
        if (window.customPineIndicators) {
            window.customPineIndicators = window.customPineIndicators.filter(
                ind => ind.metainfo.id !== id
            );
        }
        
        this.logConsole(`Indicator removed: ${id}`, 'info');
    }

    /**
     * Update active indicators list UI
     */
    updateActiveIndicatorsList() {
        const listEl = document.getElementById('indicatorsList');
        const countEl = document.getElementById('indicatorsCount');
        
        if (!listEl) return;
        
        if (this.activeIndicators.length === 0) {
            listEl.innerHTML = '<div class="no-indicators">No active indicators</div>';
            if (countEl) countEl.textContent = '0';
            return;
        }
        
        listEl.innerHTML = this.activeIndicators.map(ind => `
            <div class="indicator-item">
                <span class="indicator-name">${ind.name}</span>
                <button class="indicator-remove" onclick="pineEditor.removeIndicator('${ind.id}')">
                    Remove
                </button>
            </div>
        `).join('');
        
        if (countEl) countEl.textContent = this.activeIndicators.length;
    }

    /**
     * Extract indicator name from code
     */
    extractIndicatorName(code) {
        const match = code.match(/indicator\s*\(\s*["']([^"']+)["']/);
        return match ? match[1] : 'Custom Indicator';
    }

    /**
     * Get current symbol from chart
     */
    getCurrentSymbol() {
        try {
            if (this.widget && this.widget.activeChart) {
                const symbol = this.widget.activeChart().symbol();
                return symbol.replace('BINANCE:', '').replace('/', '');
            }
        } catch (e) {
            console.error('Error getting symbol:', e);
        }
        return 'BTCUSDT';
    }

    /**
     * Get current interval from chart
     */
    getCurrentInterval() {
        try {
            if (this.widget && this.widget.activeChart) {
                return this.widget.activeChart().resolution();
            }
        } catch (e) {
            console.error('Error getting interval:', e);
        }
        return '1H';
    }

    /**
     * Set editor status
     */
    setStatus(type, text) {
        const statusEl = document.getElementById('editorStatus');
        if (!statusEl) return;
        
        const dot = statusEl.querySelector('.status-dot');
        const textEl = statusEl.querySelector('.status-text');
        
        if (dot) {
            dot.className = 'status-dot';
            dot.classList.add(`status-${type}`);
        }
        
        if (textEl) {
            textEl.textContent = text;
        }
    }

    /**
     * Log message to console
     */
    logConsole(message, type = 'info') {
        const consoleOutput = document.getElementById('consoleOutput');
        if (!consoleOutput) return;
        
        const line = document.createElement('div');
        line.className = `console-line console-${type}`;
        
        const time = new Date().toLocaleTimeString();
        line.textContent = `[${time}] ${message}`;
        
        consoleOutput.appendChild(line);
        consoleOutput.scrollTop = consoleOutput.scrollHeight;
    }

    /**
     * Clear console
     */
    clearConsole() {
        const consoleOutput = document.getElementById('consoleOutput');
        if (consoleOutput) {
            consoleOutput.innerHTML = '';
        }
    }
}

// Initialize Pine Script Editor
let pineEditor;

// Initialize when app is ready
if (typeof app !== 'undefined') {
    const originalInit = app.init;
    app.init = async function() {
        await originalInit.call(this);
        
        // Wait for widget to be ready
        if (this.widget) {
            this.widget.onChartReady(() => {
                pineEditor = new PineScriptEditor();
                pineEditor.init(this.widget);
                console.log('Pine Script Editor initialized with widget');
            });
        } else {
            // Initialize editor without widget
            pineEditor = new PineScriptEditor();
            pineEditor.init(null);
            console.log('Pine Script Editor initialized (widget not available yet)');
        }
    };
}

// Expose to global scope
window.pineEditor = pineEditor;