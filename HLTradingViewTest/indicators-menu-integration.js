/**
 * TradingView Indicators Menu Integration
 * Injects database indicators into TradingView's indicators menu
 */

class IndicatorsMenuIntegration {
    constructor() {
        this.widget = null;
        this.indicators = [];
        this.customStudies = [];
    }

    /**
     * Initialize with TradingView widget
     */
    async init(widget) {
        this.widget = widget;
        
        console.log('🔧 Initializing Indicators Menu Integration...');
        
        // Wait for chart to be ready
        this.widget.onChartReady(async () => {
            await this.loadIndicatorsFromDatabase();
            this.injectCustomIndicators();
            console.log('✅ Indicators menu integration complete');
        });
    }

    /**
     * Load indicators from database
     */
    async loadIndicatorsFromDatabase() {
        try {
            this.indicators = await apiClient.getIndicators();
            console.log(`✓ Loaded ${this.indicators.length} indicators from database`);
        } catch (error) {
            console.error('Failed to load indicators:', error);
            this.indicators = [];
        }
    }

    /**
     * Inject custom indicators into TradingView
     */
    injectCustomIndicators() {
        if (!window.customPineIndicators) {
            window.customPineIndicators = [];
        }

        // Process Pine Script indicators
        const pineIndicators = this.indicators.filter(i => i.indicator_type === 'pine-script');
        
        pineIndicators.forEach(indicator => {
            try {
                const customIndicator = this.createPineScriptIndicator(indicator);
                window.customPineIndicators.push(customIndicator);
                console.log(`✓ Added Pine Script indicator: ${indicator.display_name}`);
            } catch (error) {
                console.error(`Failed to create indicator ${indicator.display_name}:`, error);
            }
        });

        console.log(`📊 Total custom indicators: ${window.customPineIndicators.length}`);
    }

    /**
     * Create Pine Script indicator definition
     */
    createPineScriptIndicator(indicator) {
        const isOverlay = indicator.is_overlay || false;
        const defaultInputs = indicator.default_inputs || {};
        const defaultStyles = indicator.default_styles || {};

        return {
            name: indicator.display_name,
            metainfo: {
                _metainfoVersion: 53,
                id: indicator.system_name,
                description: indicator.description || indicator.display_name,
                shortDescription: indicator.display_name,
                
                is_price_study: isOverlay,
                isCustomIndicator: true,
                
                format: {
                    type: isOverlay ? 'inherit' : 'price',
                    precision: 2
                },
                
                plots: this.generatePlots(indicator),
                
                defaults: {
                    styles: this.generateDefaultStyles(indicator),
                    inputs: this.generateDefaultInputs(indicator)
                },
                
                styles: this.generateStyles(indicator),
                inputs: this.generateInputs(indicator)
            },
            
            constructor: function() {
                this.init = function(context, inputCallback) {
                    this._context = context;
                    this._input = inputCallback;
                };
                
                this.main = function(context, inputCallback) {
                    this._context = context;
                    this._input = inputCallback;
                    
                    // Mock calculation - in production, execute actual Pine Script
                    // This would require a Pine Script interpreter
                    const mockValue = this.calculateMockValue(context);
                    
                    return [mockValue];
                };
                
                this.calculateMockValue = function(context) {
                    // Simple moving average mock
                    return 50 + Math.random() * 10;
                };
            }
        };
    }

    /**
     * Generate plots configuration
     */
    generatePlots(indicator) {
        // Parse algorithm to detect plots
        // For now, create default plot
        return [{
            id: 'plot_0',
            type: 'line'
        }];
    }

    /**
     * Generate default styles
     */
    generateDefaultStyles(indicator) {
        const defaultStyles = indicator.default_styles || {};
        
        return {
            plot_0: {
                linestyle: 0,
                linewidth: defaultStyles.linewidth || 2,
                plottype: defaultStyles.plottype || 0,
                trackPrice: false,
                transparency: defaultStyles.transparency || 0,
                visible: true,
                color: defaultStyles.color || '#2962FF'
            }
        };
    }

    /**
     * Generate styles configuration
     */
    generateStyles(indicator) {
        return {
            plot_0: {
                title: 'Value',
                histogramBase: 0
            }
        };
    }

    /**
     * Generate default inputs
     */
    generateDefaultInputs(indicator) {
        const inputs = indicator.default_inputs || {};
        return inputs;
    }

    /**
     * Generate inputs configuration
     */
    generateInputs(indicator) {
        const inputs = indicator.default_inputs || {};
        const inputsArray = [];
        
        // Convert inputs object to array format
        Object.keys(inputs).forEach((key, index) => {
            inputsArray.push({
                id: `input_${index}`,
                name: key,
                defval: inputs[key],
                type: typeof inputs[key] === 'number' ? 'integer' : 'text'
            });
        });
        
        return inputsArray;
    }

    /**
     * Add indicator to chart programmatically
     */
    addIndicatorToChart(indicatorId) {
        const indicator = this.indicators.find(i => i.id === indicatorId);
        if (!indicator) {
            console.error('Indicator not found:', indicatorId);
            return;
        }

        const chart = this.widget.activeChart();
        
        try {
            if (indicator.indicator_type === 'built-in' && indicator.tradingview_id) {
                // Use built-in TradingView indicator
                const params = this.parseIndicatorParams(indicator);
                chart.createStudy(
                    indicator.tradingview_id,
                    indicator.is_overlay,
                    false,
                    params
                );
                console.log(`✓ Added built-in indicator: ${indicator.display_name}`);
            } else if (indicator.indicator_type === 'pine-script') {
                // Use custom Pine Script indicator
                chart.createStudy(
                    indicator.display_name,
                    indicator.is_overlay,
                    false
                );
                console.log(`✓ Added Pine Script indicator: ${indicator.display_name}`);
            } else if (indicator.indicator_type === 'javascript') {
                // Execute JavaScript code
                this.executeJavaScriptIndicator(indicator);
            }
        } catch (error) {
            console.error('Failed to add indicator:', error);
        }
    }

    /**
     * Parse indicator parameters
     */
    parseIndicatorParams(indicator) {
        if (!indicator.tradingview_params) {
            return [];
        }

        // Convert params object to array
        const params = indicator.tradingview_params;
        if (Array.isArray(params)) {
            return params;
        }

        return Object.values(params);
    }

    /**
     * Execute JavaScript indicator
     */
    executeJavaScriptIndicator(indicator) {
        try {
            // Execute the JavaScript code
            const code = indicator.algorithm;
            if (code) {
                eval(code);
                console.log(`✓ Executed JavaScript indicator: ${indicator.display_name}`);
            }
        } catch (error) {
            console.error('Failed to execute JavaScript indicator:', error);
        }
    }

    /**
     * Create indicator selector UI
     */
    createIndicatorSelector() {
        const container = document.createElement('div');
        container.className = 'indicator-selector';
        container.innerHTML = `
            <div class="indicator-selector-header">
                <h3>Available Indicators</h3>
                <button onclick="indicatorsMenuIntegration.closeSelector()">×</button>
            </div>
            <div class="indicator-selector-body">
                <div class="indicator-search">
                    <input type="text" placeholder="Search indicators..." 
                           oninput="indicatorsMenuIntegration.filterIndicators(this.value)">
                </div>
                <div class="indicator-categories" id="indicatorCategories">
                    ${this.renderCategories()}
                </div>
            </div>
            
            <style>
            .indicator-selector {
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: #1e1e1e;
                border: 1px solid #3e3e42;
                border-radius: 8px;
                width: 500px;
                max-height: 600px;
                z-index: 10000;
                display: flex;
                flex-direction: column;
            }
            .indicator-selector-header {
                padding: 15px 20px;
                border-bottom: 1px solid #3e3e42;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .indicator-selector-header h3 {
                margin: 0;
                color: #d4d4d4;
            }
            .indicator-selector-header button {
                background: transparent;
                border: none;
                color: #858585;
                font-size: 24px;
                cursor: pointer;
            }
            .indicator-selector-body {
                flex: 1;
                overflow-y: auto;
                padding: 15px 20px;
            }
            .indicator-search input {
                width: 100%;
                padding: 10px;
                background: #2d2d30;
                border: 1px solid #3e3e42;
                border-radius: 4px;
                color: #d4d4d4;
                margin-bottom: 15px;
            }
            .indicator-category {
                margin-bottom: 20px;
            }
            .indicator-category-title {
                color: #4ec9b0;
                font-weight: 600;
                margin-bottom: 10px;
                font-size: 14px;
            }
            .indicator-item {
                background: #252526;
                padding: 10px;
                margin-bottom: 8px;
                border-radius: 4px;
                cursor: pointer;
                transition: background 0.2s;
            }
            .indicator-item:hover {
                background: #2d2d30;
            }
            .indicator-item-name {
                color: #d4d4d4;
                font-weight: 500;
                font-size: 13px;
            }
            .indicator-item-desc {
                color: #858585;
                font-size: 11px;
                margin-top: 4px;
            }
            </style>
        `;

        document.body.appendChild(container);
        this.selectorElement = container;
    }

    /**
     * Render categories
     */
    renderCategories() {
        const categories = {};
        
        this.indicators.forEach(indicator => {
            const categoryName = indicator.category_name || 'Other';
            if (!categories[categoryName]) {
                categories[categoryName] = [];
            }
            categories[categoryName].push(indicator);
        });

        let html = '';
        Object.keys(categories).forEach(categoryName => {
            html += `
                <div class="indicator-category">
                    <div class="indicator-category-title">${categoryName}</div>
                    ${categories[categoryName].map(ind => `
                        <div class="indicator-item" onclick="indicatorsMenuIntegration.addIndicatorToChart(${ind.id})">
                            <div class="indicator-item-name">${ind.display_name}</div>
                            ${ind.description ? `<div class="indicator-item-desc">${ind.description}</div>` : ''}
                        </div>
                    `).join('')}
                </div>
            `;
        });

        return html;
    }

    /**
     * Open selector
     */
    openSelector() {
        if (!this.selectorElement) {
            this.createIndicatorSelector();
        } else {
            this.selectorElement.style.display = 'flex';
        }
    }

    /**
     * Close selector
     */
    closeSelector() {
        if (this.selectorElement) {
            this.selectorElement.style.display = 'none';
        }
    }

    /**
     * Filter indicators
     */
    filterIndicators(searchTerm) {
        // Implementation for filtering
        console.log('Filtering by:', searchTerm);
    }

    /**
     * Refresh indicators from database
     */
    async refresh() {
        await this.loadIndicatorsFromDatabase();
        this.injectCustomIndicators();
        
        if (this.selectorElement) {
            const categoriesEl = document.getElementById('indicatorCategories');
            if (categoriesEl) {
                categoriesEl.innerHTML = this.renderCategories();
            }
        }
    }
}

// Initialize
const indicatorsMenuIntegration = new IndicatorsMenuIntegration();
window.indicatorsMenuIntegration = indicatorsMenuIntegration;