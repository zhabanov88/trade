/**
 * Indicator Manager UI
 * Admin interface for managing all indicators
 */

class IndicatorManagerUI {
    constructor() {
        this.indicators = [];
        this.categories = [];
        this.currentUser = null;
        this.modalElement = null;
    }

    async init() {
        try {
            const authStatus = await apiClient.checkAuthStatus();
            this.currentUser = authStatus;
        } catch (error) {
            console.error('Failed to get auth status:', error);
        }
        
        this.createModal();
    }

    createModal() {
        const modalHTML = `
            <div id="indicatorManagerModal" class="indicator-manager-modal" style="display: none;">
                <div class="indicator-manager-overlay" onclick="indicatorManagerUI.close()"></div>
                <div class="indicator-manager-content">
                    <div class="indicator-manager-header">
                        <h2>Indicator Manager</h2>
                        <button class="indicator-manager-close" onclick="indicatorManagerUI.close()">×</button>
                    </div>
                    
                    <div class="indicator-manager-body">
                        <div class="indicator-manager-toolbar">
                            <button class="indicator-btn indicator-btn-primary" onclick="indicatorManagerUI.openCreateForm()">
                                <span>➕</span> Create New Indicator
                            </button>
                            <button class="indicator-btn" onclick="indicatorManagerUI.refresh()">
                                <span>🔄</span> Refresh
                            </button>
                            <div class="indicator-filter">
                                <select id="indicatorCategoryFilter" onchange="indicatorManagerUI.filterByCategory()">
                                    <option value="">All Categories</option>
                                </select>
                            </div>
                        </div>

                        <div class="indicator-manager-list" id="indicatorManagerList">
                            <div class="loading-spinner">Loading...</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Create/Edit Indicator Form -->
            <div id="indicatorFormModal" class="indicator-manager-modal" style="display: none;">
                <div class="indicator-manager-overlay" onclick="indicatorManagerUI.closeForm()"></div>
                <div class="indicator-manager-content indicator-form-content">
                    <div class="indicator-manager-header">
                        <h2 id="indicatorFormTitle">Create Indicator</h2>
                        <button class="indicator-manager-close" onclick="indicatorManagerUI.closeForm()">×</button>
                    </div>
                    
                    <div class="indicator-manager-body">
                        <form id="indicatorForm" onsubmit="indicatorManagerUI.handleSubmit(event)">
                            <input type="hidden" id="indicatorFormId" value="">
                            
                            <div class="form-row">
                                <div class="form-group">
                                    <label for="indicatorSystemName">System Name *</label>
                                    <input type="text" id="indicatorSystemName" required 
                                           placeholder="moving_average" 
                                           pattern="[a-z0-9_]+" 
                                           title="Only lowercase, numbers, underscores">
                                </div>

                                <div class="form-group">
                                    <label for="indicatorDisplayName">Display Name *</label>
                                    <input type="text" id="indicatorDisplayName" required 
                                           placeholder="Moving Average">
                                </div>
                            </div>

                            <div class="form-group">
                                <label for="indicatorDescription">Description</label>
                                <textarea id="indicatorDescription" rows="2" 
                                          placeholder="Brief description"></textarea>
                            </div>

                            <div class="form-row">
                                <div class="form-group">
                                    <label for="indicatorCategory">Category</label>
                                    <select id="indicatorCategory">
                                        <option value="">Select Category</option>
                                    </select>
                                </div>

                                <div class="form-group">
                                    <label for="indicatorType">Type *</label>
                                    <select id="indicatorType" required onchange="indicatorManagerUI.onTypeChange()">
                                        <option value="built-in">Built-in TradingView</option>
                                        <option value="pine-script">Pine Script</option>
                                        <option value="javascript">JavaScript</option>
                                        <option value="custom">Custom</option>
                                    </select>
                                </div>
                            </div>

                            <div class="form-group" id="tradingviewIdGroup">
                                <label for="indicatorTradingViewId">TradingView ID</label>
                                <input type="text" id="indicatorTradingViewId" 
                                       placeholder="e.g., Moving Average">
                                <small>The exact name used in TradingView's createStudy() method</small>
                            </div>

                            <div class="form-group" id="algorithmGroup" style="display: none;">
                                <label for="indicatorAlgorithm">Algorithm / Code</label>
                                <textarea id="indicatorAlgorithm" rows="10" 
                                          placeholder="Pine Script or JavaScript code"
                                          style="font-family: 'Consolas', monospace; font-size: 13px;"></textarea>
                            </div>

                            <div class="form-group">
                                <label>
                                    <input type="checkbox" id="indicatorIsOverlay">
                                    Overlay on main chart (vs separate pane)
                                </label>
                            </div>

                            <div class="form-group">
                                <label>
                                    <input type="checkbox" id="indicatorIsPublic">
                                    Public (accessible to all users)
                                </label>
                            </div>

                            ${this.currentUser?.isAdmin ? `
                            <div class="form-group admin-only">
                                <label>
                                    <input type="checkbox" id="indicatorIsDefault">
                                    <strong>Default</strong> (show in indicators menu for all users)
                                </label>
                            </div>
                            ` : ''}

                            <div class="form-actions">
                                <button type="button" class="indicator-btn" onclick="indicatorManagerUI.closeForm()">
                                    Cancel
                                </button>
                                <button type="submit" class="indicator-btn indicator-btn-primary">
                                    Save Indicator
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            </div>
        `;

        const container = document.createElement('div');
        container.innerHTML = modalHTML;
        document.body.appendChild(container);

        this.modalElement = document.getElementById('indicatorManagerModal');
    }

    async open() {
        this.modalElement.style.display = 'flex';
        await this.loadIndicators();
        await this.loadCategories();
    }

    close() {
        this.modalElement.style.display = 'none';
    }

    async loadCategories() {
        // Hardcoded categories for now - could be from API
        this.categories = [
            { id: 1, name: 'Trend' },
            { id: 2, name: 'Momentum' },
            { id: 3, name: 'Volatility' },
            { id: 4, name: 'Volume' },
            { id: 5, name: 'Support/Resistance' },
            { id: 99, name: 'Custom' }
        ];

        // Update dropdowns
        const filterSelect = document.getElementById('indicatorCategoryFilter');
        const categorySelect = document.getElementById('indicatorCategory');

        this.categories.forEach(cat => {
            if (filterSelect) {
                const option = document.createElement('option');
                option.value = cat.id;
                option.textContent = cat.name;
                filterSelect.appendChild(option);
            }
            if (categorySelect) {
                const option = document.createElement('option');
                option.value = cat.id;
                option.textContent = cat.name;
                categorySelect.appendChild(option);
            }
        });
    }

    async loadIndicators() {
        const listEl = document.getElementById('indicatorManagerList');
        listEl.innerHTML = '<div class="loading-spinner">Loading indicators...</div>';

        try {
            this.indicators = await apiClient.getIndicators();
            this.renderIndicators();
        } catch (error) {
            console.error('Failed to load indicators:', error);
            listEl.innerHTML = `<div class="error-message">Failed to load: ${error.message}</div>`;
        }
    }

    filterByCategory() {
        const categoryId = document.getElementById('indicatorCategoryFilter').value;
        // Re-render with filter
        this.renderIndicators(categoryId);
    }

    renderIndicators(categoryFilter = '') {
        const listEl = document.getElementById('indicatorManagerList');

        let filtered = this.indicators;
        if (categoryFilter) {
            filtered = this.indicators.filter(i => i.category_id == categoryFilter);
        }

        if (filtered.length === 0) {
            listEl.innerHTML = '<div class="no-data">No indicators found.</div>';
            return;
        }

        const html = filtered.map(indicator => `
            <div class="indicator-manager-item">
                <div class="indicator-item-header">
                    <h3>${this.escapeHtml(indicator.display_name)}</h3>
                    <div class="indicator-item-badges">
                        ${indicator.is_default ? '<span class="badge badge-default">Default</span>' : ''}
                        ${indicator.is_public ? '<span class="badge badge-public">Public</span>' : '<span class="badge badge-private">Private</span>'}
                        <span class="badge badge-type">${indicator.indicator_type || 'built-in'}</span>
                    </div>
                </div>
                
                <div class="indicator-item-meta">
                    <span class="meta-item">System: <code>${this.escapeHtml(indicator.system_name)}</code></span>
                    <span class="meta-item">Category: ${this.escapeHtml(indicator.category_name || 'N/A')}</span>
                    ${indicator.tradingview_id ? `<span class="meta-item">TV ID: <code>${this.escapeHtml(indicator.tradingview_id)}</code></span>` : ''}
                </div>

                ${indicator.description ? `<p class="indicator-item-description">${this.escapeHtml(indicator.description)}</p>` : ''}

                <div class="indicator-item-actions">
                    ${this.canEdit(indicator) ? `
                        <button class="indicator-btn indicator-btn-sm" onclick="indicatorManagerUI.openEditForm(${indicator.id})">
                            <span>✏️</span> Edit
                        </button>
                        <button class="indicator-btn indicator-btn-sm indicator-btn-danger" onclick="indicatorManagerUI.deleteIndicator(${indicator.id})">
                            <span>🗑</span> Delete
                        </button>
                    ` : ''}
                    ${this.currentUser?.isAdmin && !indicator.is_default ? `
                        <button class="indicator-btn indicator-btn-sm indicator-btn-success" onclick="indicatorManagerUI.makeDefault(${indicator.id})">
                            <span>⭐</span> Make Default
                        </button>
                    ` : ''}
                </div>
            </div>
        `).join('');

        listEl.innerHTML = html;
    }

    canEdit(indicator) {
        if (!this.currentUser) return false;
        if (this.currentUser.isAdmin) return true;
        return indicator.created_by === this.currentUser.userId;
    }

    openCreateForm() {
        document.getElementById('indicatorFormTitle').textContent = 'Create Indicator';
        document.getElementById('indicatorFormId').value = '';
        document.getElementById('indicatorSystemName').value = '';
        document.getElementById('indicatorDisplayName').value = '';
        document.getElementById('indicatorDescription').value = '';
        document.getElementById('indicatorCategory').value = '';
        document.getElementById('indicatorType').value = 'built-in';
        document.getElementById('indicatorTradingViewId').value = '';
        document.getElementById('indicatorAlgorithm').value = '';
        document.getElementById('indicatorIsOverlay').checked = false;
        document.getElementById('indicatorIsPublic').checked = false;
        if (document.getElementById('indicatorIsDefault')) {
            document.getElementById('indicatorIsDefault').checked = false;
        }

        document.getElementById('indicatorSystemName').disabled = false;
        this.onTypeChange();

        document.getElementById('indicatorFormModal').style.display = 'flex';
    }

    async openEditForm(indicatorId) {
        const indicator = this.indicators.find(i => i.id === indicatorId);
        if (!indicator) return;

        document.getElementById('indicatorFormTitle').textContent = 'Edit Indicator';
        document.getElementById('indicatorFormId').value = indicator.id;
        document.getElementById('indicatorSystemName').value = indicator.system_name;
        document.getElementById('indicatorDisplayName').value = indicator.display_name;
        document.getElementById('indicatorDescription').value = indicator.description || '';
        document.getElementById('indicatorCategory').value = indicator.category_id || '';
        document.getElementById('indicatorType').value = indicator.indicator_type || 'built-in';
        document.getElementById('indicatorTradingViewId').value = indicator.tradingview_id || '';
        document.getElementById('indicatorAlgorithm').value = indicator.algorithm || '';
        document.getElementById('indicatorIsOverlay').checked = indicator.is_overlay;
        document.getElementById('indicatorIsPublic').checked = indicator.is_public;
        if (document.getElementById('indicatorIsDefault')) {
            document.getElementById('indicatorIsDefault').checked = indicator.is_default;
        }

        document.getElementById('indicatorSystemName').disabled = true;
        this.onTypeChange();

        document.getElementById('indicatorFormModal').style.display = 'flex';
    }

    closeForm() {
        document.getElementById('indicatorFormModal').style.display = 'none';
    }

    onTypeChange() {
        const type = document.getElementById('indicatorType').value;
        const tradingviewGroup = document.getElementById('tradingviewIdGroup');
        const algorithmGroup = document.getElementById('algorithmGroup');

        if (type === 'built-in') {
            tradingviewGroup.style.display = 'block';
            algorithmGroup.style.display = 'none';
        } else {
            tradingviewGroup.style.display = 'none';
            algorithmGroup.style.display = 'block';
        }
    }

    async handleSubmit(event) {
        event.preventDefault();

        const indicatorId = document.getElementById('indicatorFormId').value;
        const data = {
            system_name: document.getElementById('indicatorSystemName').value,
            display_name: document.getElementById('indicatorDisplayName').value,
            description: document.getElementById('indicatorDescription').value,
            category_id: document.getElementById('indicatorCategory').value || null,
            indicator_type: document.getElementById('indicatorType').value,
            tradingview_id: document.getElementById('indicatorTradingViewId').value || null,
            algorithm: document.getElementById('indicatorAlgorithm').value || null,
            is_overlay: document.getElementById('indicatorIsOverlay').checked,
            is_public: document.getElementById('indicatorIsPublic').checked
        };

        if (this.currentUser?.isAdmin && document.getElementById('indicatorIsDefault')) {
            data.is_default = document.getElementById('indicatorIsDefault').checked;
        }

        try {
            if (indicatorId) {
                await apiClient.updateIndicator(indicatorId, data);
                alert('Indicator updated successfully!');
            } else {
                await apiClient.createIndicator(data);
                alert('Indicator created successfully!');
            }

            this.closeForm();
            await this.loadIndicators();

        } catch (error) {
            console.error('Failed to save indicator:', error);
            alert('Failed to save: ' + error.message);
        }
    }

    async deleteIndicator(indicatorId) {
        if (!confirm('Delete this indicator? This cannot be undone.')) {
            return;
        }

        try {
            await apiClient.deleteIndicator(indicatorId);
            alert('Indicator deleted!');
            await this.loadIndicators();
        } catch (error) {
            console.error('Failed to delete:', error);
            alert('Failed to delete: ' + error.message);
        }
    }

    async makeDefault(indicatorId) {
        if (!confirm('Make this indicator default for all users?')) {
            return;
        }

        try {
            await apiClient.updateIndicator(indicatorId, { is_default: true, is_public: true });
            alert('Indicator is now default!');
            await this.loadIndicators();
        } catch (error) {
            console.error('Failed to update:', error);
            alert('Failed to update: ' + error.message);
        }
    }

    async refresh() {
        await this.loadIndicators();
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// CSS Styles
const indicatorManagerStyles = `
<style>
.indicator-manager-modal {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
}

.indicator-manager-overlay {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
}

.indicator-manager-content {
    position: relative;
    background: #1e1e1e;
    border-radius: 8px;
    max-width: 1000px;
    width: 95%;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
}

.indicator-form-content {
    max-width: 800px;
}

.indicator-manager-header {
    padding: 20px;
    border-bottom: 1px solid #3e3e42;
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: #252526;
    border-radius: 8px 8px 0 0;
}

.indicator-manager-header h2 {
    margin: 0;
    color: #d4d4d4;
    font-size: 20px;
}

.indicator-manager-close {
    background: transparent;
    border: none;
    color: #858585;
    font-size: 32px;
    cursor: pointer;
    line-height: 1;
    padding: 0;
    width: 32px;
    height: 32px;
}

.indicator-manager-close:hover {
    color: #d4d4d4;
}

.indicator-manager-body {
    padding: 20px;
    overflow-y: auto;
    flex: 1;
}

.indicator-manager-toolbar {
    display: flex;
    gap: 10px;
    margin-bottom: 20px;
    align-items: center;
}

.indicator-filter {
    margin-left: auto;
}

.indicator-filter select {
    padding: 8px 12px;
    background: #2d2d30;
    border: 1px solid #3e3e42;
    border-radius: 4px;
    color: #d4d4d4;
    font-size: 14px;
}

.indicator-btn {
    padding: 8px 16px;
    border: 1px solid #3e3e42;
    border-radius: 4px;
    background: #2d2d30;
    color: #d4d4d4;
    cursor: pointer;
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 6px;
    transition: all 0.2s;
}

.indicator-btn:hover {
    background: #3c3c3c;
}

.indicator-btn-primary {
    background: #2962FF;
    border-color: #2962FF;
    color: white;
}

.indicator-btn-primary:hover {
    background: #1e4fd9;
}

.indicator-btn-danger {
    background: #f44336;
    border-color: #f44336;
    color: white;
}

.indicator-btn-success {
    background: #4caf50;
    border-color: #4caf50;
    color: white;
}

.indicator-btn-sm {
    padding: 6px 12px;
    font-size: 12px;
}

.indicator-manager-list {
    display: flex;
    flex-direction: column;
    gap: 15px;
}

.indicator-manager-item {
    background: #252526;
    border: 1px solid #3e3e42;
    border-radius: 6px;
    padding: 16px;
}

.indicator-item-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
}

.indicator-item-header h3 {
    margin: 0;
    color: #4ec9b0;
    font-size: 16px;
}

.indicator-item-badges {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
}

.badge-type {
    background: #673ab7;
    color: white;
}

.indicator-item-meta {
    display: flex;
    gap: 15px;
    margin-bottom: 10px;
    font-size: 12px;
    color: #858585;
    flex-wrap: wrap;
}

.indicator-item-description {
    color: #d4d4d4;
    font-size: 13px;
    margin: 10px 0;
}

.indicator-item-actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid #3e3e42;
    flex-wrap: wrap;
}

.form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 15px;
}

.admin-only {
    background: rgba(255, 193, 7, 0.1);
    padding: 10px;
    border-radius: 4px;
    border: 1px solid rgba(255, 193, 7, 0.3);
}

@media (max-width: 768px) {
    .form-row {
        grid-template-columns: 1fr;
    }
}
</style>
`;

document.head.insertAdjacentHTML('beforeend', indicatorManagerStyles);

const indicatorManagerUI = new IndicatorManagerUI();
indicatorManagerUI.init();
window.indicatorManagerUI = indicatorManagerUI;