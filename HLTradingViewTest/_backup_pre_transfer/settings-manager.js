// ============================================
// SETTINGS MANAGER
// Управление интервалами, индикаторами, скриптами
// ============================================

class SettingsManager {
    constructor() {
        this.currentSection = 'intervals';
        this.init();
    }
    
    init() {
        this.attachEventListeners();
        // Не вызываем loadSection при инициализации
        // Секции открываются по требованию
    }
    
    // ИСПРАВЛЕНО: Добавлен недостающий метод loadSection
    loadSection(sectionName) {
        this.currentSection = sectionName;
        console.log(`✓ Settings section: ${sectionName}`);
    }
    
    attachEventListeners() {
        // Кнопки в секциях
        document.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const action = e.target.dataset.action;
                this.handleAction(action);
            });
        });
    }
    
    async handleAction(action) {
        switch(action) {
            case 'open-indicator-manager':
                this.openIndicatorManager();
                break;
            case 'manage-pine-scripts':
                this.openScriptManager('pine');
                break;
            case 'manage-javascript-scripts':
                this.openScriptManager('javascript');
                break;
            case 'manage-indicators':
                this.openIndicatorManager();
                break;
            case 'manage-scripts':
                this.openScriptManager('javascript');
                break;
            case 'load-layout':
                this.loadLayout();
                break;
        }
    }
    
    // ========== INTERVALS ==========
    
    async openIntervalManager() {
        const modal = this.createModal('Manage Time Intervals');
        
        const intervals = await this.fetchIntervals();
        
        const content = `
            <div class="interval-manager">
                <button class="btn btn-primary" onclick="settingsManager.createInterval()">
                    + Add Interval
                </button>
                
                <table class="intervals-table">
                    <thead>
                        <tr>
                            <th>Code</th>
                            <th>Name</th>
                            <th>TradingView</th>
                            <th>ClickHouse Table</th>
                            <th>Duration</th>
                            <th>Status</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${intervals.map(i => `
                            <tr>
                                <td>${i.code}</td>
                                <td>${i.name}</td>
                                <td>${i.tradingview_code}</td>
                                <td>${i.clickhouse_table}</td>
                                <td>${i.seconds}s</td>
                                <td>
                                    <span class="status ${i.is_active ? 'active' : 'inactive'}">
                                        ${i.is_active ? 'ACTIVE' : 'INACTIVE'}
                                    </span>
                                </td>
                                <td>
                                    <button onclick="settingsManager.editInterval(${i.id})">Edit</button>
                                    <button onclick="settingsManager.toggleInterval(${i.id})">
                                        ${i.is_active ? 'Deactivate' : 'Activate'}
                                    </button>
                                    <button onclick="settingsManager.deleteInterval(${i.id})">Delete</button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
        
        modal.querySelector('.modal-content').innerHTML = content;
    }
    
    async fetchIntervals() {
        const response = await fetch('/api/intervals', { credentials: 'include' });
        return response.json();
    }
    
    async createInterval() {
        const form = this.createForm([
            { name: 'code', label: 'Code', type: 'text', placeholder: '1m' },
            { name: 'name', label: 'Name', type: 'text', placeholder: '1 minute' },
            { name: 'tradingview_code', label: 'TradingView Code', type: 'text', placeholder: '1' },
            { name: 'clickhouse_table', label: 'ClickHouse Table', type: 'text', placeholder: 'market_data_minute' },
            { name: 'seconds', label: 'Duration (seconds)', type: 'number', placeholder: '60' }
        ]);
        
        form.onsubmit = async (e) => {
            e.preventDefault();
            const formData = new FormData(e.target);
            const data = Object.fromEntries(formData);
            
            await fetch('/api/intervals', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(data)
            });
            
            this.closeModal();
            this.openIntervalManager();
        };
    }
    
    async editInterval(id) {
        // TODO: Implement edit functionality
        console.log('Edit interval:', id);
        alert('Edit functionality coming soon');
    }
    
    async toggleInterval(id) {
        try {
            const intervals = await this.fetchIntervals();
            const interval = intervals.find(i => i.id === id);
            
            await fetch(`/api/intervals/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    ...interval,
                    is_active: !interval.is_active
                })
            });
            
            this.closeModal();
            this.openIntervalManager();
        } catch (error) {
            console.error('Failed to toggle interval:', error);
            alert('Failed to toggle interval');
        }
    }
    
    async deleteInterval(id) {
        if (!confirm('Are you sure you want to delete this interval?')) {
            return;
        }
        
        try {
            await fetch(`/api/intervals/${id}`, {
                method: 'DELETE',
                credentials: 'include'
            });
            
            this.closeModal();
            this.openIntervalManager();
        } catch (error) {
            console.error('Failed to delete interval:', error);
            alert('Failed to delete interval');
        }
    }
    
    // ========== INDICATORS ==========
    
    async openIndicatorManager() {
        const modal = this.createModal('Manage Indicators');
        
        const indicators = await fetch('/api/indicators', { credentials: 'include' }).then(r => r.json());
        
        const content = `
            <div class="indicator-manager">
                <button class="btn btn-primary" onclick="settingsManager.createIndicator()">
                    + Add Indicator
                </button>
                
                <div class="indicators-list">
                    ${indicators.map(ind => `
                        <div class="indicator-card">
                            <h3>${ind.name}</h3>
                            <p>${ind.description || ''}</p>
                            <code>${ind.code}</code>
                            <div class="actions">
                                <button onclick="settingsManager.editIndicator(${ind.id})">Edit</button>
                                <button onclick="settingsManager.deleteIndicator(${ind.id})">Delete</button>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
        
        modal.querySelector('.modal-content').innerHTML = content;
    }
    
    async createIndicator() {
        // TODO: Implement
        alert('Create indicator functionality coming soon');
    }
    
    async editIndicator(id) {
        // TODO: Implement
        alert('Edit indicator functionality coming soon');
    }
    
    async deleteIndicator(id) {
        if (!confirm('Are you sure?')) return;
        
        try {
            await fetch(`/api/indicators/${id}`, {
                method: 'DELETE',
                credentials: 'include'
            });
            
            this.closeModal();
            this.openIndicatorManager();
        } catch (error) {
            console.error('Failed to delete indicator:', error);
            alert('Failed to delete indicator');
        }
    }
    
    // ========== SCRIPTS ==========
    
    async openScriptManager(type) {
        const modal = this.createModal(`Manage ${type === 'pine' ? 'Pine' : 'JavaScript'} Scripts`);
        
        const scripts = await fetch(`/api/scripts?type=${type}`, { credentials: 'include' }).then(r => r.json());
        
        const content = `
            <div class="script-manager">
                <button class="btn btn-primary" onclick="settingsManager.createScript('${type}')">
                    + Add Script
                </button>
                
                <div class="scripts-list">
                    ${scripts.length === 0 ? '<p>No scripts yet</p>' : scripts.map(script => `
                        <div class="script-card">
                            <h3>${script.display_name}</h3>
                            <p>${script.description || ''}</p>
                            <small>System: ${script.system_name}</small>
                            <div class="actions">
                                <button onclick="settingsManager.viewScript(${script.id})">View</button>
                                <button onclick="settingsManager.editScript(${script.id})">Edit</button>
                                <button onclick="settingsManager.deleteScript(${script.id})">Delete</button>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
        
        modal.querySelector('.modal-content').innerHTML = content;
    }
    
    async createScript(type) {
        // TODO: Implement
        alert(`Create ${type} script functionality coming soon`);
    }
    
    async viewScript(id) {
        // TODO: Implement
        alert('View script functionality coming soon');
    }
    
    async editScript(id) {
        // TODO: Implement
        alert('Edit script functionality coming soon');
    }
    
    async deleteScript(id) {
        if (!confirm('Are you sure?')) return;
        
        try {
            await fetch(`/api/scripts/${id}`, {
                method: 'DELETE',
                credentials: 'include'
            });
            
            // Refresh current view
            const modal = document.querySelector('.settings-modal');
            if (modal) {
                this.closeModal();
                // Reopen based on current section
                // You can enhance this later
            }
        } catch (error) {
            console.error('Failed to delete script:', error);
            alert('Failed to delete script');
        }
    }
    
    loadLayout() {
        // TODO: Implement layout loading
        alert('Load layout functionality coming soon');
    }
    
    // ========== UI HELPERS ==========
    
    createModal(title) {
        const modal = document.createElement('div');
        modal.className = 'settings-modal';
        modal.innerHTML = `
            <div class="modal-overlay" onclick="settingsManager.closeModal()"></div>
            <div class="modal-container">
                <div class="modal-header">
                    <h2>${title}</h2>
                    <button onclick="settingsManager.closeModal()">✕</button>
                </div>
                <div class="modal-content"></div>
            </div>
        `;
        
        document.body.appendChild(modal);
        return modal;
    }
    
    closeModal() {
        const modal = document.querySelector('.settings-modal');
        if (modal) modal.remove();
    }
    
    createForm(fields) {
        const form = document.createElement('form');
        form.className = 'settings-form';
        
        fields.forEach(field => {
            const group = document.createElement('div');
            group.className = 'form-group';
            group.innerHTML = `
                <label>${field.label}</label>
                <input 
                    type="${field.type}" 
                    name="${field.name}" 
                    placeholder="${field.placeholder || ''}"
                    ${field.required !== false ? 'required' : ''}
                >
            `;
            form.appendChild(group);
        });
        
        const submitBtn = document.createElement('button');
        submitBtn.type = 'submit';
        submitBtn.className = 'btn btn-primary';
        submitBtn.textContent = 'Save';
        form.appendChild(submitBtn);
        
        const modal = this.createModal('Create New');
        modal.querySelector('.modal-content').appendChild(form);
        
        return form;
    }
}

// Инициализация
const settingsManager = new SettingsManager();
window.settingsManager = settingsManager;