/**
 * Settings Panel - Comprehensive Management UI
 * For users and admins to manage all entities
 */

class SettingsPanel {
    constructor() {
        this.currentUser = null;
        this.isAdmin = false;
        this.currentSection = 'profile';
        this.modalElement = null;
    }

    async init() {
        try {
            const authStatus = await apiClient.checkAuthStatus();
            this.currentUser = authStatus;
            this.isAdmin = authStatus.isAdmin || false;
        } catch (error) {
            console.error('Failed to get auth status:', error);
        }

        this.createModal();
    }

    createModal() {
        const modalHTML = `
            <div id="settingsPanelModal" class="settings-panel-modal" style="display: none;">
                <div class="settings-panel-overlay" onclick="settingsPanel.close()"></div>
                <div class="settings-panel-content">
                    <!-- Header -->
                    <div class="settings-panel-header">
                        <h2>⚙️ Settings & Management</h2>
                        <button class="settings-panel-close" onclick="settingsPanel.close()">×</button>
                    </div>

                    <!-- Body with Sidebar -->
                    <div class="settings-panel-body">
                        <!-- Sidebar Menu -->
                        <div class="settings-sidebar">
                            <div class="settings-menu-section">
                                <div class="settings-menu-title">Personal</div>
                                <button class="settings-menu-item active" data-section="profile" onclick="settingsPanel.switchSection('profile')">
                                    <span>👤</span> Profile
                                </button>
                                <button class="settings-menu-item" data-section="layouts" onclick="settingsPanel.switchSection('layouts')">
                                    <span>💾</span> My Layouts
                                </button>
                                <button class="settings-menu-item" data-section="scripts" onclick="settingsPanel.switchSection('scripts')">
                                    <span>📝</span> My Scripts
                                </button>
                            </div>

                            <div class="settings-menu-section">
                                <div class="settings-menu-title">Trading</div>
                                <button class="settings-menu-item" data-section="indicators" onclick="settingsPanel.switchSection('indicators')">
                                    <span>📊</span> Indicators
                                </button>
                                <button class="settings-menu-item" data-section="intervals" onclick="settingsPanel.switchSection('intervals')">
                                    <span>⏱️</span> Intervals
                                </button>
                                <button class="settings-menu-item" data-section="instruments" onclick="settingsPanel.switchSection('instruments')">
                                    <span>💱</span> Instruments
                                </button>
                            </div>

                            ${this.isAdmin ? `
                            <div class="settings-menu-section">
                                <div class="settings-menu-title">Admin</div>
                                <button class="settings-menu-item" data-section="users" onclick="settingsPanel.switchSection('users')">
                                    <span>👥</span> Users
                                </button>
                                <button class="settings-menu-item" data-section="roles" onclick="settingsPanel.switchSection('roles')">
                                    <span>🔐</span> Roles & Permissions
                                </button>
                                <button class="settings-menu-item" data-section="audit" onclick="settingsPanel.switchSection('audit')">
                                    <span>📜</span> Audit Log
                                </button>
                                <button class="settings-menu-item" data-section="database" onclick="settingsPanel.switchSection('database')">
                                    <span>🗄️</span> Database
                                </button>
                            </div>
                            ` : ''}
                        </div>

                        <!-- Content Area -->
                        <div class="settings-content" id="settingsContent">
                            <!-- Dynamic content will be loaded here -->
                            <div class="settings-loading">Loading...</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Styles -->
            <style>
            .settings-panel-modal {
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

            .settings-panel-overlay {
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.7);
            }

            .settings-panel-content {
                position: relative;
                background: #1e1e1e;
                border-radius: 8px;
                width: 90%;
                max-width: 1200px;
                height: 85vh;
                display: flex;
                flex-direction: column;
                box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
            }

            .settings-panel-header {
                padding: 20px;
                border-bottom: 1px solid #3e3e42;
                display: flex;
                justify-content: space-between;
                align-items: center;
                background: #252526;
                border-radius: 8px 8px 0 0;
            }

            .settings-panel-header h2 {
                margin: 0;
                color: #d4d4d4;
                font-size: 20px;
            }

            .settings-panel-close {
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

            .settings-panel-close:hover {
                color: #d4d4d4;
            }

            .settings-panel-body {
                display: flex;
                flex: 1;
                overflow: hidden;
            }

            .settings-sidebar {
                width: 220px;
                background: #252526;
                border-right: 1px solid #3e3e42;
                overflow-y: auto;
                padding: 15px 0;
            }

            .settings-menu-section {
                margin-bottom: 20px;
            }

            .settings-menu-title {
                padding: 8px 20px;
                color: #858585;
                font-size: 11px;
                text-transform: uppercase;
                font-weight: 600;
                letter-spacing: 0.5px;
            }

            .settings-menu-item {
                width: 100%;
                padding: 10px 20px;
                background: transparent;
                border: none;
                color: #d4d4d4;
                text-align: left;
                cursor: pointer;
                font-size: 14px;
                display: flex;
                align-items: center;
                gap: 10px;
                transition: all 0.2s;
                border-left: 3px solid transparent;
            }

            .settings-menu-item:hover {
                background: #2d2d30;
                color: #ffffff;
            }

            .settings-menu-item.active {
                background: #2d2d30;
                border-left-color: #2962FF;
                color: #2962FF;
            }

            .settings-menu-item span {
                font-size: 16px;
            }

            .settings-content {
                flex: 1;
                padding: 25px;
                overflow-y: auto;
                background: #1e1e1e;
            }

            .settings-loading {
                text-align: center;
                padding: 50px;
                color: #858585;
            }

            .settings-section {
                display: none;
            }

            .settings-section.active {
                display: block;
            }

            .settings-section-title {
                font-size: 24px;
                color: #d4d4d4;
                margin-bottom: 10px;
            }

            .settings-section-desc {
                color: #858585;
                margin-bottom: 25px;
                font-size: 14px;
            }

            .settings-card {
                background: #252526;
                border: 1px solid #3e3e42;
                border-radius: 6px;
                padding: 20px;
                margin-bottom: 20px;
            }

            .settings-card-title {
                font-size: 16px;
                color: #4ec9b0;
                margin-bottom: 15px;
                font-weight: 600;
            }

            .settings-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px 0;
                border-bottom: 1px solid #3e3e42;
            }

            .settings-row:last-child {
                border-bottom: none;
            }

            .settings-row-label {
                color: #d4d4d4;
                font-size: 14px;
            }

            .settings-row-value {
                color: #858585;
                font-size: 14px;
            }

            .settings-btn {
                padding: 8px 16px;
                background: #2962FF;
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 13px;
                font-weight: 500;
                transition: all 0.2s;
            }

            .settings-btn:hover {
                background: #1e4fd9;
            }

            .settings-btn-secondary {
                background: #2d2d30;
                color: #d4d4d4;
                border: 1px solid #3e3e42;
            }

            .settings-btn-secondary:hover {
                background: #3c3c3c;
            }

            .settings-btn-danger {
                background: #f44336;
            }

            .settings-btn-danger:hover {
                background: #d32f2f;
            }

            .settings-table {
                width: 100%;
                border-collapse: collapse;
            }

            .settings-table thead {
                background: #2d2d30;
            }

            .settings-table th {
                padding: 12px;
                text-align: left;
                color: #858585;
                font-size: 12px;
                text-transform: uppercase;
                font-weight: 600;
            }

            .settings-table td {
                padding: 12px;
                color: #d4d4d4;
                font-size: 13px;
                border-bottom: 1px solid #3e3e42;
            }

            .settings-table tr:hover {
                background: #2d2d30;
            }

            .settings-badge {
                padding: 3px 8px;
                border-radius: 3px;
                font-size: 11px;
                font-weight: 600;
                text-transform: uppercase;
            }

            .settings-badge-admin {
                background: #ffa726;
                color: white;
            }

            .settings-badge-user {
                background: #4caf50;
                color: white;
            }

            .settings-badge-active {
                background: #4caf50;
                color: white;
            }

            .settings-badge-inactive {
                background: #757575;
                color: white;
            }

            /* Scrollbar */
            .settings-sidebar::-webkit-scrollbar,
            .settings-content::-webkit-scrollbar {
                width: 8px;
            }

            .settings-sidebar::-webkit-scrollbar-track,
            .settings-content::-webkit-scrollbar-track {
                background: #1e1e1e;
            }

            .settings-sidebar::-webkit-scrollbar-thumb,
            .settings-content::-webkit-scrollbar-thumb {
                background: #424242;
                border-radius: 4px;
            }

            /* ── Основная оболочка модалки ── */
            body.light-theme .settings-panel-content {
                background: #ffffff;
                box-shadow: 0 10px 40px rgba(0, 0, 0, 0.15);
            }

            /* ── Хедер ── */
            body.light-theme .settings-panel-header {
                background: #f3f3f3;
                border-bottom-color: #d0d0d0;
            }

            body.light-theme .settings-panel-header h2 {
                color: #1e1e1e;
            }

            body.light-theme .settings-panel-close {
                color: #616161;
            }

            body.light-theme .settings-panel-close:hover {
                color: #1e1e1e;
            }

            /* ── Сайдбар ── */
            body.light-theme .settings-sidebar {
                background: #f3f3f3;
                border-right-color: #d0d0d0;
            }

            body.light-theme .settings-menu-title {
                color: #9e9e9e;
            }

            body.light-theme .settings-menu-item {
                color: #1e1e1e;
            }

            body.light-theme .settings-menu-item:hover {
                background: #e8e8e8;
                color: #1e1e1e;
            }

            body.light-theme .settings-menu-item.active {
                background: #e8e8e8;
                border-left-color: #2962FF;
                color: #2962FF;
            }

            /* ── Контент область ── */
            body.light-theme .settings-content {
                background: #ffffff;
            }

            body.light-theme .settings-loading {
                color: #616161;
            }

            /* ── Заголовки секций ── */
            body.light-theme .settings-section-title {
                color: #1e1e1e;
            }

            body.light-theme .settings-section-desc {
                color: #616161;
            }

            /* ── Карточки ── */
            body.light-theme .settings-card {
                background: #f3f3f3;
                border-color: #d0d0d0;
            }

            body.light-theme .settings-card-title {
                color: #00796b;
            }

            /* ── Строки настроек ── */
            body.light-theme .settings-row {
                border-bottom-color: #d0d0d0;
            }

            body.light-theme .settings-row-label {
                color: #1e1e1e;
            }

            body.light-theme .settings-row-value {
                color: #616161;
            }

            /* ── Кнопки ── */
            body.light-theme .settings-btn-secondary {
                background: #e8e8e8;
                color: #1e1e1e;
                border-color: #d0d0d0;
            }

            body.light-theme .settings-btn-secondary:hover {
                background: #d0d0d0;
            }

            /* ── Таблицы ── */
            body.light-theme .settings-table thead {
                background: #e8e8e8;
            }

            body.light-theme .settings-table th {
                color: #616161;
            }

            body.light-theme .settings-table td {
                color: #1e1e1e;
                border-bottom-color: #e0e0e0;
            }

            body.light-theme .settings-table tr:hover {
                background: #f3f3f3;
            }

            body.light-theme .settings-table code {
                background: #e8e8e8;
                color: #1e1e1e;
                padding: 2px 5px;
                border-radius: 3px;
            }

            /* ── Скроллбары внутри панели ── */
            body.light-theme .settings-sidebar::-webkit-scrollbar-track,
            body.light-theme .settings-content::-webkit-scrollbar-track {
                background: #f3f3f3;
            }

            body.light-theme .settings-sidebar::-webkit-scrollbar-thumb,
            body.light-theme .settings-content::-webkit-scrollbar-thumb {
                background: #c0c0c0;
            }
            </style>
        `;

        const container = document.createElement('div');
        container.innerHTML = modalHTML;
        document.body.appendChild(container);

        this.modalElement = document.getElementById('settingsPanelModal');
    }

    async open() {
        if (!this.currentUser?.authenticated) {
            alert('Please login first');
            return;
        }

        this.modalElement.style.display = 'flex';
        await this.switchSection(this.currentSection);
    }

    close() {
        this.modalElement.style.display = 'none';
    }

    async switchSection(section) {
        this.currentSection = section;

        // Update active menu item
        document.querySelectorAll('.settings-menu-item').forEach(item => {
            item.classList.remove('active');
            if (item.dataset.section === section) {
                item.classList.add('active');
            }
        });

        // Load section content
        const contentEl = document.getElementById('settingsContent');
        contentEl.innerHTML = '<div class="settings-loading">Loading...</div>';

        try {
            const content = await this.loadSectionContent(section);
            contentEl.innerHTML = content;
        } catch (error) {
            console.error('Failed to load section:', error);
            contentEl.innerHTML = `<div class="error-message">Failed to load content: ${error.message}</div>`;
        }
    }

    async loadSectionContent(section) {
        switch (section) {
            case 'profile':
                return this.renderProfileSection();
            case 'layouts':
                return await this.renderLayoutsSection();
            case 'scripts':
                return await this.renderScriptsSection();
            case 'indicators':
                return await this.renderIndicatorsSection();
            case 'intervals':
                return await this.renderIntervalsSection();
            case 'instruments':
                return await this.renderInstrumentsSection();
            case 'users':
                return this.isAdmin ? await this.renderUsersSection() : '<div>Access denied</div>';
            case 'roles':
                return this.isAdmin ? await this.renderRolesSection() : '<div>Access denied</div>';
            case 'audit':
                return this.isAdmin ? await this.renderAuditSection() : '<div>Access denied</div>';
            case 'database':
                return this.isAdmin ? await this.renderDatabaseSection() : '<div>Access denied</div>';
            default:
                return '<div>Section not found</div>';
        }
    }

    renderProfileSection() {
        return `
            <div class="settings-section active">
                <h3 class="settings-section-title">Profile Settings</h3>
                <p class="settings-section-desc">Manage your account information</p>

                <div class="settings-card">
                    <div class="settings-card-title">Account Information</div>
                    <div class="settings-row">
                        <div class="settings-row-label">Username</div>
                        <div class="settings-row-value">${this.currentUser.username}</div>
                    </div>
                    <div class="settings-row">
                        <div class="settings-row-label">User ID</div>
                        <div class="settings-row-value">${this.currentUser.userId}</div>
                    </div>
                    <div class="settings-row">
                        <div class="settings-row-label">Role</div>
                        <div class="settings-row-value">
                            <span class="settings-badge ${this.isAdmin ? 'settings-badge-admin' : 'settings-badge-user'}">
                                ${this.isAdmin ? 'Admin' : 'User'}
                            </span>
                        </div>
                    </div>
                </div>

                <div class="settings-card">
                    <div class="settings-card-title">Quick Actions</div>
                    <div style="display: flex; gap: 10px;">
                        <button class="settings-btn" onclick="indicatorManagerUI.open()">
                            📊 Manage Indicators
                        </button>
                        <button class="settings-btn" onclick="scriptManagerUI.open('pine')">
                            📝 Manage Scripts
                        </button>
                        <button class="settings-btn" onclick="layoutManager.openLoadDialog()">
                            💾 Load Layout
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    async renderLayoutsSection() {
        try {
            const layouts = await apiClient.getLayouts();

            let layoutsHTML = layouts.map(layout => `
                <tr>
                    <td>${layout.name}</td>
                    <td>${layout.symbol || '-'}</td>
                    <td>${layout.interval || '-'}</td>
                    <td>
                        <span class="settings-badge ${layout.is_default ? 'settings-badge-active' : 'settings-badge-inactive'}">
                            ${layout.is_default ? 'Default' : 'Custom'}
                        </span>
                    </td>
                    <td>${new Date(layout.created_at).toLocaleDateString()}</td>
                    <td>
                        <button class="settings-btn settings-btn-secondary" onclick="settingsPanel.loadLayout(${layout.id})">
                            Load
                        </button>
                        <button class="settings-btn settings-btn-danger" onclick="settingsPanel.deleteLayout(${layout.id})">
                            Delete
                        </button>
                    </td>
                </tr>
            `).join('');

            return `
                <div class="settings-section active">
                    <h3 class="settings-section-title">My Layouts</h3>
                    <p class="settings-section-desc">Saved chart configurations</p>

                    <div style="margin-bottom: 15px;">
                        <button class="settings-btn" onclick="layoutManager.openSaveDialog()">
                            💾 Save Current Layout
                        </button>
                    </div>

                    <table class="settings-table">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Symbol</th>
                                <th>Interval</th>
                                <th>Type</th>
                                <th>Created</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${layoutsHTML || '<tr><td colspan="6" style="text-align: center; color: #858585;">No layouts found</td></tr>'}
                        </tbody>
                    </table>
                </div>
            `;
        } catch (error) {
            return `<div class="error-message">Failed to load layouts: ${error.message}</div>`;
        }
    }

    async renderScriptsSection() {
        try {
            const [pineScripts, jsScripts] = await Promise.all([
                apiClient.getPineScripts(),
                apiClient.getJavaScriptScripts()
            ]);

            const myPineScripts = pineScripts.filter(s => s.is_user_script || s.created_by === this.currentUser.userId);
            const myJSScripts = jsScripts.filter(s => s.is_user_script || s.created_by === this.currentUser.userId);

            return `
                <div class="settings-section active">
                    <h3 class="settings-section-title">My Scripts</h3>
                    <p class="settings-section-desc">Your Pine Script and JavaScript scripts</p>

                    <div class="settings-card">
                        <div class="settings-card-title">Pine Scripts (${myPineScripts.length})</div>
                        <div style="margin-bottom: 10px;">
                            <button class="settings-btn" onclick="scriptManagerUI.open('pine')">
                                Manage Pine Scripts
                            </button>
                        </div>
                        <div style="color: #858585; font-size: 13px;">
                            ${myPineScripts.map(s => `• ${s.display_name}`).join('<br>') || 'No scripts yet'}
                        </div>
                    </div>

                    <div class="settings-card">
                        <div class="settings-card-title">JavaScript Scripts (${myJSScripts.length})</div>
                        <div style="margin-bottom: 10px;">
                            <button class="settings-btn" onclick="scriptManagerUI.open('javascript')">
                                Manage JavaScript Scripts
                            </button>
                        </div>
                        <div style="color: #858585; font-size: 13px;">
                            ${myJSScripts.map(s => `• ${s.display_name}`).join('<br>') || 'No scripts yet'}
                        </div>
                    </div>
                </div>
            `;
        } catch (error) {
            return `<div class="error-message">Failed to load scripts: ${error.message}</div>`;
        }
    }

    async renderIndicatorsSection() {
        return `
            <div class="settings-section active">
                <h3 class="settings-section-title">Indicators</h3>
                <p class="settings-section-desc">Manage trading indicators</p>

                <div class="settings-card">
                    <div class="settings-card-title">Indicator Management</div>
                    <div style="margin-bottom: 15px;">
                        <button class="settings-btn" onclick="indicatorManagerUI.open()">
                            Open Indicator Manager
                        </button>
                    </div>
                    <p style="color: #858585; font-size: 13px;">
                        View and manage all available indicators. ${this.isAdmin ? 'As an admin, you can create, edit, and set default indicators.' : 'Create your own custom indicators.'}
                    </p>
                </div>
            </div>
        `;
    }

    async renderIntervalsSection() {
        try {
            const intervals = await apiClient.getIntervals();

            const intervalsHTML = intervals.map(interval => `
                <tr>
                    <td>${interval.code}</td>
                    <td>${interval.name}</td>
                    <td>${interval.tradingview_code}</td>
                    <td><code>${interval.clickhouse_table}</code></td>
                    <td>${interval.seconds}s</td>
                    <td>
                        <span class="settings-badge ${interval.is_active ? 'settings-badge-active' : 'settings-badge-inactive'}">
                            ${interval.is_active ? 'Active' : 'Inactive'}
                        </span>
                    </td>
                </tr>
            `).join('');

            return `
                <div class="settings-section active">
                    <h3 class="settings-section-title">Time Intervals</h3>
                    <p class="settings-section-desc">Available timeframes for charts</p>

                    <table class="settings-table">
                        <thead>
                            <tr>
                                <th>Code</th>
                                <th>Name</th>
                                <th>TradingView</th>
                                <th>ClickHouse Table</th>
                                <th>Duration</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${intervalsHTML}
                        </tbody>
                    </table>
                </div>
            `;
        } catch (error) {
            return `<div class="error-message">Failed to load intervals: ${error.message}</div>`;
        }
    }

    async renderInstrumentsSection() {
        try {
            const instruments = await apiClient.getInstruments();

            const instrumentsHTML = instruments.map(inst => `
                <tr>
                    <td>${inst.symbol}</td>
                    <td>${inst.name}</td>
                    <td>${inst.type}</td>
                    <td>${inst.provider_name || '-'}</td>
                    <td><code>${inst.clickhouse_ticker}</code></td>
                    <td>
                        <span class="settings-badge ${inst.is_active ? 'settings-badge-active' : 'settings-badge-inactive'}">
                            ${inst.is_active ? 'Active' : 'Inactive'}
                        </span>
                    </td>
                </tr>
            `).join('');

            return `
                <div class="settings-section active">
                    <h3 class="settings-section-title">Instruments</h3>
                    <p class="settings-section-desc">Available trading instruments</p>

                    <table class="settings-table">
                        <thead>
                            <tr>
                                <th>Symbol</th>
                                <th>Name</th>
                                <th>Type</th>
                                <th>Provider</th>
                                <th>ClickHouse Ticker</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${instrumentsHTML}
                        </tbody>
                    </table>
                </div>
            `;
        } catch (error) {
            return `<div class="error-message">Failed to load instruments: ${error.message}</div>`;
        }
    }

    renderUsersSection() {
        return `
            <div class="settings-section active">
                <h3 class="settings-section-title">Users Management</h3>
                <p class="settings-section-desc">Manage user accounts and permissions</p>

                <div class="settings-card">
                    <div class="settings-card-title">User Management</div>
                    <p style="color: #858585;">User management interface coming soon...</p>
                </div>
            </div>
        `;
    }

    renderRolesSection() {
        return `
            <div class="settings-section active">
                <h3 class="settings-section-title">Roles & Permissions</h3>
                <p class="settings-section-desc">Manage user roles and access control</p>

                <div class="settings-card">
                    <div class="settings-card-title">Available Roles</div>
                    <div class="settings-row">
                        <div class="settings-row-label">Superadmin</div>
                        <div class="settings-row-value">Full system access</div>
                    </div>
                    <div class="settings-row">
                        <div class="settings-row-label">User</div>
                        <div class="settings-row-value">Standard user access</div>
                    </div>
                    <div class="settings-row">
                        <div class="settings-row-label">Analyst</div>
                        <div class="settings-row-value">Extended analysis features</div>
                    </div>
                </div>
            </div>
        `;
    }

    renderAuditSection() {
        return `
            <div class="settings-section active">
                <h3 class="settings-section-title">Audit Log</h3>
                <p class="settings-section-desc">System activity and user actions</p>

                <div class="settings-card">
                    <div class="settings-card-title">Recent Activity</div>
                    <p style="color: #858585;">Audit log interface coming soon...</p>
                </div>
            </div>
        `;
    }

    renderDatabaseSection() {
        return `
            <div class="settings-section active">
                <h3 class="settings-section-title">Database Management</h3>
                <p class="settings-section-desc">Database statistics and maintenance</p>

                <div class="settings-card">
                    <div class="settings-card-title">Database Stats</div>
                    <p style="color: #858585;">Database management interface coming soon...</p>
                </div>
            </div>
        `;
    }

    async loadLayout(layoutId) {
        try {
            await layoutManager.loadLayout(layoutId);
            alert('Layout loaded successfully!');
            this.close();
        } catch (error) {
            alert('Failed to load layout: ' + error.message);
        }
    }

    async deleteLayout(layoutId) {
        if (!confirm('Delete this layout?')) return;

        try {
            await apiClient.deleteLayout(layoutId);
            alert('Layout deleted!');
            await this.switchSection('layouts');
        } catch (error) {
            alert('Failed to delete layout: ' + error.message);
        }
    }
}

// Initialize
const settingsPanel = new SettingsPanel();

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        settingsPanel.init();
    });
} else {
    settingsPanel.init();
}

window.settingsPanel = settingsPanel;