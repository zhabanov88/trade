/**
 * Script Manager UI
 * Modal interface for managing Pine Scripts and JavaScript scripts
 */

class ScriptManagerUI {
    constructor() {
        this.currentType = 'pine'; // 'pine' or 'javascript'
        this.scripts = [];
        this.currentUser = null;
        this.modalElement = null;
        // Filter & sort state
        this.filters = {
            search: '',
            isPublic: 'all',   // 'all' | 'yes' | 'no'
            isDefault: 'all',  // 'all' | 'yes' | 'no'
        };
        this.sortBy = 'created_at'; // 'display_name' | 'created_at'
        this.sortDir = 'desc';      // 'asc' | 'desc'
    }

    /**
     * Initialize the manager
     */
    async init() {
        try {
            const authStatus = await apiClient.checkAuthStatus();
            this.currentUser = authStatus;
        } catch (error) {
            console.error('Failed to get auth status:', error);
        }
        
        this.createModal();
    }

    /**
     * Create modal HTML
     */
    createModal() {
        const modalHTML = `
            <div id="scriptManagerModal" class="script-manager-modal" style="display: none;">
                <div class="script-manager-overlay" onclick="scriptManagerUI.close()"></div>
                <div class="script-manager-content">
                    <div class="script-manager-header">
                        <h2 id="scriptManagerTitle">Manage Scripts</h2>
                        <button class="script-manager-close" onclick="scriptManagerUI.close()">×</button>
                    </div>
                    
                    <div class="script-manager-body">
                        <div class="script-manager-toolbar">
                            <button class="script-btn script-btn-primary" onclick="scriptManagerUI.openCreateForm()">
                                <span>&#10133;</span> Create New Script
                            </button>
                            <button class="script-btn" onclick="scriptManagerUI.refresh()">
                                <span>&#128260;</span> Refresh
                            </button>
                        </div>

                        <!-- Filters & Sort -->
                        <div class="script-manager-filters">
                            <div class="filter-row">
                                <input type="text" id="filterSearch" class="filter-input filter-search"
                                       placeholder="Search by name..."
                                       oninput="scriptManagerUI.onFilterChange()">
                                <select id="filterPublic" class="filter-select" onchange="scriptManagerUI.onFilterChange()">
                                    <option value="all">All visibility</option>
                                    <option value="yes">Public only</option>
                                    <option value="no">Private only</option>
                                </select>
                                <select id="filterDefault" class="filter-select" onchange="scriptManagerUI.onFilterChange()">
                                    <option value="all">All types</option>
                                    <option value="yes">Default only</option>
                                    <option value="no">Non-default</option>
                                </select>
                            </div>
                            <div class="filter-row filter-sort-row">
                                <span class="filter-label">Sort:</span>
                                <button id="sortByName" class="sort-btn" onclick="scriptManagerUI.onSortChange('display_name')">
                                    Name <span id="sortNameIcon"></span>
                                </button>
                                <button id="sortByDate" class="sort-btn sort-btn-active" onclick="scriptManagerUI.onSortChange('created_at')">
                                    Date added <span id="sortDateIcon">&#8595;</span>
                                </button>
                                <span id="filterCount" class="filter-count"></span>
                            </div>
                        </div>

                        <div class="script-manager-list" id="scriptManagerList">
                            <div class="loading-spinner">Loading...</div>
                        </div>
                    </div>                </div>
            </div>

            <!-- Create/Edit Form Modal -->
            <div id="scriptFormModal" class="script-manager-modal" style="display: none;">
                <div class="script-manager-overlay" onclick="scriptManagerUI.closeForm()"></div>
                <div class="script-manager-content script-form-content">
                    <div class="script-manager-header">
                        <h2 id="scriptFormTitle">Create Script</h2>
                        <button class="script-manager-close" onclick="scriptManagerUI.closeForm()">×</button>
                    </div>
                    
                    <div class="script-manager-body">
                        <form id="scriptForm" onsubmit="scriptManagerUI.handleSubmit(event)">
                            <input type="hidden" id="scriptFormId" value="">
                            
                            <div class="form-group">
                                <label for="scriptSystemName">System Name *</label>
                                <input type="text" id="scriptSystemName" required 
                                       placeholder="e.g., my_custom_indicator" 
                                       pattern="[a-z0-9_]+" 
                                       title="Only lowercase letters, numbers, and underscores">
                                <small>Used internally. Only lowercase letters, numbers, and underscores.</small>
                            </div>

                            <div class="form-group">
                                <label for="scriptDisplayName">Display Name *</label>
                                <input type="text" id="scriptDisplayName" required 
                                       placeholder="e.g., My Custom Indicator">
                            </div>

                            <div class="form-group">
                                <label for="scriptDescription">Description</label>
                                <textarea id="scriptDescription" rows="3" 
                                          placeholder="Brief description of what this script does"></textarea>
                            </div>

                            <div class="form-group">
                                <label for="scriptCode">Code *</label>
                                <textarea id="scriptCode" rows="15" required 
                                          placeholder="Enter your Pine Script or JavaScript code here..."
                                          style="font-family: 'Consolas', 'Monaco', monospace; font-size: 13px;"></textarea>
                            </div>

                            <div class="form-group">
                                <label>
                                    <input type="checkbox" id="scriptIsPublic">
                                    Make this script public (accessible to other users)
                                </label>
                            </div>

                            <div class="form-actions">
                                <button type="button" class="script-btn" onclick="scriptManagerUI.closeForm()">
                                    Cancel
                                </button>
                                <button type="submit" class="script-btn script-btn-primary">
                                    Save Script
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            </div>
        `;

        // Add to body
        const container = document.createElement('div');
        container.innerHTML = modalHTML;
        document.body.appendChild(container);

        this.modalElement = document.getElementById('scriptManagerModal');
    }

    /**
     * Open the manager
     */
    async open(type = 'pine') {
        this.currentType = type;

        // Reset filters on open
        this.filters = { search: '', isPublic: 'all', isDefault: 'all' };
        this.sortBy = 'created_at';
        this.sortDir = 'desc';

        const title = type === 'pine' ? 'Manage Pine Scripts' : 'Manage JavaScript Scripts';
        document.getElementById('scriptManagerTitle').textContent = title;

        this.modalElement.style.display = 'flex';

        // Reset filter UI elements
        const fs = document.getElementById('filterSearch');
        const fp = document.getElementById('filterPublic');
        const fd = document.getElementById('filterDefault');
        if (fs) fs.value = '';
        if (fp) fp.value = 'all';
        if (fd) fd.value = 'all';

        await this.loadScripts();
        this.updateSortButtons();
    }

    /**
     * Close the manager
     */
    close() {
        this.modalElement.style.display = 'none';
    }

    /**
     * Load scripts from API
     */
    async loadScripts() {
        const listEl = document.getElementById('scriptManagerList');
        listEl.innerHTML = '<div class="loading-spinner">Loading scripts...</div>';

        try {
            if (this.currentType === 'pine') {
                this.scripts = await apiClient.getPineScripts();
            } else {
                this.scripts = await apiClient.getJavaScriptScripts();
            }

            this.renderScripts();
        } catch (error) {
            console.error('Failed to load scripts:', error);
            listEl.innerHTML = `<div class="error-message">Failed to load scripts: ${error.message}</div>`;
        }
    }

    /**
     * Render scripts list
     */
    /**
     * Get filtered and sorted scripts
     */
    getFilteredScripts() {
        let result = [...this.scripts];

        if (this.filters.search) {
            const q = this.filters.search.toLowerCase();
            result = result.filter(s =>
                s.display_name.toLowerCase().includes(q) ||
                s.system_name.toLowerCase().includes(q)
            );
        }

        if (this.filters.isPublic === 'yes') result = result.filter(s => s.is_public);
        else if (this.filters.isPublic === 'no') result = result.filter(s => !s.is_public);

        if (this.filters.isDefault === 'yes') result = result.filter(s => s.is_default);
        else if (this.filters.isDefault === 'no') result = result.filter(s => !s.is_default);

        result.sort((a, b) => {
            let va = a[this.sortBy] || '';
            let vb = b[this.sortBy] || '';
            if (this.sortBy === 'display_name') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
            if (va < vb) return this.sortDir === 'asc' ? -1 : 1;
            if (va > vb) return this.sortDir === 'asc' ? 1 : -1;
            return 0;
        });

        return result;
    }

    /**
     * Handle filter input changes
     */
    onFilterChange() {
        this.filters.search = (document.getElementById('filterSearch')?.value || '').trim();
        this.filters.isPublic = document.getElementById('filterPublic')?.value || 'all';
        this.filters.isDefault = document.getElementById('filterDefault')?.value || 'all';
        this.renderScripts();
    }

    /**
     * Handle sort field change
     */
    onSortChange(field) {
        if (this.sortBy === field) {
            this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortBy = field;
            this.sortDir = field === 'created_at' ? 'desc' : 'asc';
        }
        this.updateSortButtons();
        this.renderScripts();
    }

    /**
     * Update sort button appearance
     */
    updateSortButtons() {
        const nameBtn = document.getElementById('sortByName');
        const dateBtn = document.getElementById('sortByDate');
        const nameIcon = document.getElementById('sortNameIcon');
        const dateIcon = document.getElementById('sortDateIcon');
        if (!nameBtn) return;
        nameBtn.classList.toggle('sort-btn-active', this.sortBy === 'display_name');
        dateBtn.classList.toggle('sort-btn-active', this.sortBy === 'created_at');
        const icon = this.sortDir === 'asc' ? '↑' : '↓';
        nameIcon.textContent = this.sortBy === 'display_name' ? icon : '';
        dateIcon.textContent = this.sortBy === 'created_at' ? icon : '';
    }

    renderScripts() {
        const listEl = document.getElementById('scriptManagerList');
        const filtered = this.getFilteredScripts();

        const countEl = document.getElementById('filterCount');
        if (countEl) {
            const total = this.scripts.length;
            countEl.textContent = filtered.length < total
                ? `Showing ${filtered.length} of ${total}`
                : `${total} script${total !== 1 ? 's' : ''}`;
        }

        if (filtered.length === 0) {
            listEl.innerHTML = this.scripts.length === 0
                ? '<div class="no-data">No scripts found. Create your first script!</div>'
                : '<div class="no-data">No scripts match the selected filters.</div>';
            return;
        }

        const scriptsHTML = filtered.map(script => `
            <div class="script-manager-item">
                <div class="script-item-header">
                    <h3>${this.escapeHtml(script.display_name)}</h3>
                    <div class="script-item-badges">
                        ${script.is_default ? '<span class="badge badge-default">DEFAULT</span>' : ''}
                        ${script.is_public ? '<span class="badge badge-public">PUBLIC</span>' : '<span class="badge badge-private">PRIVATE</span>'}
                    </div>
                </div>
                
                <div class="script-item-meta">
                    <span class="meta-item">System: <code>${this.escapeHtml(script.system_name)}</code></span>
                    <span class="meta-item">Status: ${this.escapeHtml(script.status_name || 'Active')}</span>
                    ${script.created_at ? `<span class="meta-item">Added: ${new Date(script.created_at).toLocaleDateString()}</span>` : ''}
                </div>

                ${script.description ? `<p class="script-item-description">${this.escapeHtml(script.description)}</p>` : ''}

                <div class="script-item-actions">
                    <button class="script-btn script-btn-sm" onclick="scriptManagerUI.viewCode(${script.id})">
                        &#128065; View Code
                    </button>
                    ${this.canEdit(script) ? `
                        <button class="script-btn script-btn-sm" onclick="scriptManagerUI.openEditForm(${script.id})">
                            &#9998; Edit
                        </button>
                        <button class="script-btn script-btn-sm script-btn-danger" onclick="scriptManagerUI.deleteScript(${script.id})">
                            &#128465; Delete
                        </button>
                    ` : ''}
                    ${this.currentUser?.isAdmin && !script.is_default ? `
                        <button class="script-btn script-btn-sm script-btn-success" onclick="scriptManagerUI.makeDefault(${script.id})">
                            &#11088; Make Default
                        </button>
                    ` : ''}
                </div>
            </div>
        `).join('');

        listEl.innerHTML = scriptsHTML;
    }
    /**
     * Check if current user can edit script
     */
    canEdit(script) {
        if (!this.currentUser) return false;
        if (this.currentUser.isAdmin) return true;
        // User can edit their own scripts
        return script.created_by === this.currentUser.userId;
    }

    /**
     * Open create form
     */
    openCreateForm() {
        document.getElementById('scriptFormTitle').textContent = 
            `Create ${this.currentType === 'pine' ? 'Pine Script' : 'JavaScript Script'}`;
        document.getElementById('scriptFormId').value = '';
        document.getElementById('scriptSystemName').value = '';
        document.getElementById('scriptDisplayName').value = '';
        document.getElementById('scriptDescription').value = '';
        document.getElementById('scriptCode').value = '';
        document.getElementById('scriptIsPublic').checked = false;
        
        // Enable system name field for new scripts
        document.getElementById('scriptSystemName').disabled = false;

        document.getElementById('scriptFormModal').style.display = 'flex';
    }

    /**
     * Open edit form
     */
    async openEditForm(scriptId) {
        const script = this.scripts.find(s => s.id === scriptId);
        if (!script) return;

        document.getElementById('scriptFormTitle').textContent = 
            `Edit ${this.currentType === 'pine' ? 'Pine Script' : 'JavaScript Script'}`;
        document.getElementById('scriptFormId').value = script.id;
        document.getElementById('scriptSystemName').value = script.system_name;
        document.getElementById('scriptDisplayName').value = script.display_name;
        document.getElementById('scriptDescription').value = script.description || '';
        document.getElementById('scriptCode').value = script.code;
        document.getElementById('scriptIsPublic').checked = script.is_public;

        // Disable system name field for existing scripts
        document.getElementById('scriptSystemName').disabled = true;

        document.getElementById('scriptFormModal').style.display = 'flex';
    }

    /**
     * Close form
     */
    closeForm() {
        document.getElementById('scriptFormModal').style.display = 'none';
    }

    /**
     * Handle form submit
     */
    async handleSubmit(event) {
        event.preventDefault();

        const scriptId = document.getElementById('scriptFormId').value;
        const data = {
            system_name: document.getElementById('scriptSystemName').value,
            display_name: document.getElementById('scriptDisplayName').value,
            description: document.getElementById('scriptDescription').value,
            code: document.getElementById('scriptCode').value,
            is_public: document.getElementById('scriptIsPublic').checked
        };

        try {
            if (scriptId) {
                // Update existing
                if (this.currentType === 'pine') {
                    await apiClient.updatePineScript(scriptId, data);
                } else {
                    await apiClient.updateJavaScriptScript(scriptId, data);
                }
                alert('Script updated successfully!');
            } else {
                // Create new
                if (this.currentType === 'pine') {
                    await apiClient.createPineScript(data);
                } else {
                    await apiClient.createJavaScriptScript(data);
                }
                alert('Script created successfully!');
            }

            this.closeForm();
            await this.loadScripts();
            
            // Reload examples in code panel
            if (window.codePanelManager) {
                await window.codePanelManager.loadExamplesFromDatabase();
            }

        } catch (error) {
            console.error('Failed to save script:', error);
            alert('Failed to save script: ' + error.message);
        }
    }

    /**
     * View script code
     */
    viewCode(scriptId) {
        const script = this.scripts.find(s => s.id === scriptId);
        if (!script) return;

        const codeWindow = window.open('', '_blank', 'width=800,height=600');
        codeWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>${script.display_name} - Code</title>
                <style>
                    body { 
                        font-family: 'Consolas', 'Monaco', monospace; 
                        background: #1e1e1e; 
                        color: #d4d4d4; 
                        padding: 20px; 
                        margin: 0;
                    }
                    h1 { color: #4ec9b0; }
                    pre { 
                        background: #252526; 
                        padding: 20px; 
                        border-radius: 5px; 
                        overflow-x: auto;
                        line-height: 1.6;
                    }
                    code { color: #ce9178; }
                </style>
            </head>
            <body>
                <h1>${script.display_name}</h1>
                <p>${script.description || ''}</p>
                <pre><code>${this.escapeHtml(script.code)}</code></pre>
            </body>
            </html>
        `);
    }

    /**
     * Delete script
     */
    async deleteScript(scriptId) {
        if (!confirm('Are you sure you want to delete this script?')) {
            return;
        }

        try {
            if (this.currentType === 'pine') {
                await apiClient.deletePineScript(scriptId);
            } else {
                await apiClient.deleteJavaScriptScript(scriptId);
            }

            alert('Script deleted successfully!');
            await this.loadScripts();
            
            // Reload examples in code panel
            if (window.codePanelManager) {
                await window.codePanelManager.loadExamplesFromDatabase();
            }

        } catch (error) {
            console.error('Failed to delete script:', error);
            alert('Failed to delete script: ' + error.message);
        }
    }

    /**
     * Make script default (admin only)
     */
    async makeDefault(scriptId) {
        if (!confirm('Make this script available to all users as a default example?')) {
            return;
        }

        try {
            const data = { is_default: true, is_public: true };
            
            if (this.currentType === 'pine') {
                await apiClient.updatePineScript(scriptId, data);
            } else {
                await apiClient.updateJavaScriptScript(scriptId, data);
            }

            alert('Script is now a default example!');
            await this.loadScripts();

        } catch (error) {
            console.error('Failed to update script:', error);
            alert('Failed to update script: ' + error.message);
        }
    }

    /**
     * Refresh scripts list
     */
    async refresh() {
        await this.loadScripts();
    }

    /**
     * Escape HTML to prevent XSS
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// CSS for Script Manager
const scriptManagerStyles = `
<style>
.script-manager-modal {
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

.script-manager-overlay {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
}

.script-manager-content {
    position: relative;
    background: #1e1e1e;
    border-radius: 8px;
    max-width: 900px;
    width: 90%;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
}

.script-form-content {
    max-width: 700px;
}

.script-manager-header {
    padding: 20px;
    border-bottom: 1px solid #3e3e42;
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: #252526;
    border-radius: 8px 8px 0 0;
}

.script-manager-header h2 {
    margin: 0;
    color: #d4d4d4;
    font-size: 20px;
}

.script-manager-close {
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

.script-manager-close:hover {
    color: #d4d4d4;
}

.script-manager-body {
    padding: 20px;
    overflow-y: auto;
    flex: 1;
}

.script-manager-toolbar {
    display: flex;
    gap: 10px;
    margin-bottom: 12px;
}

/* ---- Filters ---- */
.script-manager-filters {
    background: #252526;
    border: 1px solid #3e3e42;
    border-radius: 6px;
    padding: 12px 14px;
    margin-bottom: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.filter-row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
}

.filter-search {
    flex: 1;
    min-width: 160px;
}

.filter-input {
    padding: 7px 10px;
    background: #1e1e1e;
    border: 1px solid #3e3e42;
    border-radius: 4px;
    color: #d4d4d4;
    font-size: 13px;
    transition: border-color 0.2s;
}

.filter-input:focus {
    outline: none;
    border-color: #2962FF;
}

.filter-select {
    padding: 7px 10px;
    background: #1e1e1e;
    border: 1px solid #3e3e42;
    border-radius: 4px;
    color: #d4d4d4;
    font-size: 13px;
    cursor: pointer;
    transition: border-color 0.2s;
}

.filter-select:focus {
    outline: none;
    border-color: #2962FF;
}

.filter-sort-row {
    border-top: 1px solid #3e3e42;
    padding-top: 8px;
}

.filter-label {
    color: #858585;
    font-size: 12px;
    white-space: nowrap;
}

.sort-btn {
    padding: 5px 12px;
    background: #2d2d30;
    border: 1px solid #3e3e42;
    border-radius: 4px;
    color: #858585;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
}

.sort-btn:hover {
    border-color: #555;
    color: #d4d4d4;
}

.sort-btn-active {
    border-color: #2962FF;
    color: #2962FF;
    background: rgba(41, 98, 255, 0.08);
}

.filter-count {
    margin-left: auto;
    font-size: 12px;
    color: #858585;
}

.script-btn {
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

.script-btn:hover {
    background: #3c3c3c;
    border-color: #555;
}

.script-btn-primary {
    background: #2962FF;
    border-color: #2962FF;
    color: white;
}

.script-btn-primary:hover {
    background: #1e4fd9;
}

.script-btn-danger {
    background: #f44336;
    border-color: #f44336;
    color: white;
}

.script-btn-danger:hover {
    background: #d32f2f;
}

.script-btn-success {
    background: #4caf50;
    border-color: #4caf50;
    color: white;
}

.script-btn-success:hover {
    background: #45a049;
}

.script-btn-sm {
    padding: 6px 12px;
    font-size: 12px;
}

.script-manager-list {
    display: flex;
    flex-direction: column;
    gap: 15px;
}

.script-manager-item {
    background: #252526;
    border: 1px solid #3e3e42;
    border-radius: 6px;
    padding: 16px;
}

.script-item-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
}

.script-item-header h3 {
    margin: 0;
    color: #4ec9b0;
    font-size: 16px;
}

.script-item-badges {
    display: flex;
    gap: 6px;
}

.badge {
    padding: 3px 8px;
    border-radius: 3px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
}

.badge-default {
    background: #ffa726;
    color: white;
}

.badge-public {
    background: #4caf50;
    color: white;
}

.badge-private {
    background: #757575;
    color: white;
}

.script-item-meta {
    display: flex;
    gap: 15px;
    margin-bottom: 10px;
    font-size: 12px;
    color: #858585;
}

.meta-item code {
    background: #1e1e1e;
    padding: 2px 6px;
    border-radius: 3px;
    color: #ce9178;
}

.script-item-description {
    color: #d4d4d4;
    font-size: 13px;
    margin: 10px 0;
    line-height: 1.5;
}

.script-item-actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid #3e3e42;
}

.form-group {
    margin-bottom: 20px;
}

.form-group label {
    display: block;
    margin-bottom: 6px;
    color: #d4d4d4;
    font-size: 14px;
    font-weight: 500;
}

.form-group input[type="text"],
.form-group textarea {
    width: 100%;
    padding: 10px;
    background: #2d2d30;
    border: 1px solid #3e3e42;
    border-radius: 4px;
    color: #d4d4d4;
    font-size: 14px;
    font-family: inherit;
}

.form-group textarea {
    resize: vertical;
}

.form-group input:focus,
.form-group textarea:focus {
    outline: none;
    border-color: #2962FF;
}

.form-group small {
    display: block;
    margin-top: 4px;
    color: #858585;
    font-size: 12px;
}

.form-group input[type="checkbox"] {
    margin-right: 8px;
}

.form-actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    margin-top: 20px;
    padding-top: 20px;
    border-top: 1px solid #3e3e42;
}

.loading-spinner {
    text-align: center;
    padding: 40px;
    color: #858585;
}

.no-data {
    text-align: center;
    padding: 40px;
    color: #858585;
    font-size: 14px;
}

.error-message {
    background: #f44336;
    color: white;
    padding: 12px;
    border-radius: 4px;
    margin: 10px 0;
}
</style>
`;

// Inject styles
document.head.insertAdjacentHTML('beforeend', scriptManagerStyles);

// Initialize
const scriptManagerUI = new ScriptManagerUI();
scriptManagerUI.init();
window.scriptManagerUI = scriptManagerUI;