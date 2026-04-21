/**
 * API Client Service
 * Handles all API requests to the backend
 */

class ApiClient {
    constructor() {
        this.baseURL = '/api';
    }

    /**
     * Generic request handler
     */
    async request(endpoint, options = {}) {
        const url = `${this.baseURL}${endpoint}`;
        
        const config = {
            credentials: 'include', 
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            },
            ...options
        };

        try {
            const response = await fetch(url, config);
            
            if (!response.ok) {
                const error = await response.json().catch(() => ({ error: response.statusText }));
                throw new Error(error.error || 'Request failed');
            }

            return await response.json();
        } catch (error) {
            console.error(`API Error [${endpoint}]:`, error);
            throw error;
        }
    }

    // ==================== AUTH ====================

    async login(username, password) {
        return this.request('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username, password })
        });
    }

    async register(username, email, password) {
        return this.request('/auth/register', {
            method: 'POST',
            body: JSON.stringify({ username, email, password })
        });
    }

    async logout() {
        return this.request('/auth/logout', { method: 'POST' });
    }

    async checkAuthStatus() {
        return this.request('/auth/status');
    }

    // ==================== INTERVALS ====================

    async getIntervals() {
        return this.request('/intervals');
    }

    // ==================== INSTRUMENTS ====================

    async getInstruments(params = {}) {
        const query = new URLSearchParams(params).toString();
        return this.request(`/instruments${query ? '?' + query : ''}`);
    }

    async createInstrument(data) {
        return this.request('/instruments', {
            method: 'POST',
            body: JSON.stringify(data)
        });
    }

    // ==================== INDICATORS ====================

    async getIndicators(params = {}) {
        const query = new URLSearchParams(params).toString();
        return this.request(`/indicators${query ? '?' + query : ''}`);
    }

    async getIndicator(id) {
        return this.request(`/indicators/${id}`);
    }

    async createIndicator(data) {
        return this.request('/indicators', {
            method: 'POST',
            body: JSON.stringify(data)
        });
    }

    async updateIndicator(id, data) {
        return this.request(`/indicators/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data)
        });
    }

    async deleteIndicator(id) {
        return this.request(`/indicators/${id}`, {
            method: 'DELETE'
        });
    }

    // ==================== JAVASCRIPT SCRIPTS ====================

    async getJavaScriptScripts() {
        return this.request('/javascript-scripts');
    }

    async createJavaScriptScript(data) {
        return this.request('/javascript-scripts', {
            method: 'POST',
            body: JSON.stringify(data)
        });
    }

    async updateJavaScriptScript(id, data) {
        return this.request(`/javascript-scripts/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data)
        });
    }

    async deleteJavaScriptScript(id) {
        return this.request(`/javascript-scripts/${id}`, {
            method: 'DELETE'
        });
    }

    // ==================== PINE SCRIPTS ====================

    async getPineScripts() {
        return this.request('/pine-scripts');
    }

    async createPineScript(data) {
        return this.request('/pine-scripts', {
            method: 'POST',
            body: JSON.stringify(data)
        });
    }

    async updatePineScript(id, data) {
        return this.request(`/pine-scripts/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data)
        });
    }

    async deletePineScript(id) {
        return this.request(`/pine-scripts/${id}`, {
            method: 'DELETE'
        });
    }

    // ==================== LAYOUTS ====================

    async getLayouts() {
        return this.request('/layouts');
    }

    async getLayout(id) {
        return this.request(`/layouts/${id}`);
    }

    async createLayout(data) {
        return this.request('/layouts', {
            method: 'POST',
            body: JSON.stringify(data)
        });
    }

    async updateLayout(id, data) {
        return this.request(`/layouts/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data)
        });
    }

    async deleteLayout(id) {
        return this.request(`/layouts/${id}`, {
            method: 'DELETE'
        });
    }

    /**
     * Создать новый скрипт
     */
    
    async createScript(scriptData) {
        const response = await fetch('/api/scripts', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(scriptData)
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to create script');
        }
        
        return response.json();
    }

    /**
     * Обновить существующий скрипт
     */
    async updateScript(systemName, scriptData) {
        const response = await fetch(`/api/scripts/${systemName}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(scriptData)
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to update script');
        }
        
        return response.json();
    }

    /**
     * Получить мои скрипты
     */
    async getMyScripts(type = null) {
        const url = type 
            ? `/api/scripts/my?type=${type}` 
            : '/api/scripts/my';
        
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error('Failed to fetch scripts');
        }
        
        return response.json();
    }

    /**
     * Удалить скрипт
     */
    async deleteScript(systemName) {
        const response = await fetch(`/api/scripts/${systemName}`, {
            method: 'DELETE'
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to delete script');
        }
        
        return response.json();
    }

    /**
     * Получить публичные Pine скрипты (из старой таблицы scripts)
     */
    async getPineScripts() {
        const response = await fetch('/api/pine-scripts', {
            credentials: 'include'
        });
        
        if (!response.ok) {
            throw new Error('Failed to fetch Pine scripts');
        }
        
        return response.json();
    }
    
    async getJavaScriptScripts() {
        const response = await fetch('/api/javascript-scripts', {
            credentials: 'include'
        });
        
        if (!response.ok) {
            throw new Error('Failed to fetch JavaScript scripts');
        }
        
        return response.json();
    }

}

// Create singleton instance
const apiClient = new ApiClient();
window.apiClient = apiClient;