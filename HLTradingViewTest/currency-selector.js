/**
 * Currency Selector
 * Allows users to switch between available instruments
 */

class CurrencySelector {
    constructor() {
        this.instruments = [];
        this.currentSymbol = 'EUR';
        this.widget = null;
    }

    async init(widget) {
        this.widget = widget;
        await this.loadInstruments();
        this.createSelector();
    }

    async loadInstruments() {
        try {
            this.instruments = await apiClient.getInstruments();
            console.log(`✓ Loaded ${this.instruments.length} instruments`);
        } catch (error) {
            console.error('Failed to load instruments:', error);
            this.instruments = [
                { symbol: 'EUR', name: 'EUR/USD', type: 'forex' },
                { symbol: 'GBP', name: 'GBP/USD', type: 'forex' },
                { symbol: 'JPY', name: 'USD/JPY', type: 'forex' },
                { symbol: 'BTC', name: 'BTC/USD', type: 'crypto' },
                { symbol: 'ETH', name: 'ETH/USD', type: 'crypto' }
            ];
        }
    }

    createSelector() {
        const navbar = document.querySelector('.navbar-center');
        if (!navbar) return;

        const selectorHTML = `
            <div class="currency-selector">
                <select id="currencySelect" class="currency-select">
                    ${this.instruments.map(inst => `
                        <option value="${inst.symbol}" ${inst.symbol === this.currentSymbol ? 'selected' : ''}>
                            ${inst.name || inst.symbol}
                        </option>
                    `).join('')}
                </select>
            </div>

            <style>
            .currency-selector {
                margin-right: 15px;
            }
            .currency-select {
                padding: 6px 12px;
                background: #2d2d30;
                color: #d4d4d4;
                border: 1px solid #3e3e42;
                border-radius: 4px;
                font-size: 14px;
                cursor: pointer;
                outline: none;
                font-weight: 600;
                min-width: 150px;
            }
            .currency-select:hover {
                background: #3c3c3c;
                border-color: #555;
            }
            .currency-select:focus {
                border-color: #2962FF;
            }
            </style>
        `;

        // Insert before symbol-info
        const symbolInfo = navbar.querySelector('.symbol-info');
        if (symbolInfo) {
            symbolInfo.insertAdjacentHTML('beforebegin', selectorHTML);
        } else {
            navbar.insertAdjacentHTML('afterbegin', selectorHTML);
        }

        // Add event listener
        const select = document.getElementById('currencySelect');
        if (select) {
            select.addEventListener('change', (e) => {
                this.changeSymbol(e.target.value);
            });
        }
    }

    changeSymbol(symbol) {
        if (!this.widget) {
            console.error('Widget not initialized');
            return;
        }

        console.log(`Changing symbol to: ${symbol}`);
        this.currentSymbol = symbol;

        const chart = this.widget.activeChart();
        if (chart) {
            chart.setSymbol(symbol, () => {
                console.log(`✓ Symbol changed to ${symbol}`);
                
                // Update navbar display
                const symbolName = document.getElementById('symbolName');
                const inst = this.instruments.find(i => i.symbol === symbol);
                if (symbolName && inst) {
                    symbolName.textContent = inst.name || symbol;
                }
            });
        }
    }

    getCurrentSymbol() {
        return this.currentSymbol;
    }
}

// Initialize
const currencySelector = new CurrencySelector();
window.currencySelector = currencySelector;