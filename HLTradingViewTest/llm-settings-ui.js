if (window._llmSettingsLoaded) {} else { window._llmSettingsLoaded = true; (function () {
    'use strict';
    
    // ══════════════════════════════════════════════════════════════════
    // STATE
    // ══════════════════════════════════════════════════════════════════
    
    const LS = {
        providers: [],
        current:   null,
        status:    null,
        selected:  null,   // выбранный в UI провайдер
        models:    [],
        testing:   false,
        saving:    false,
        testResult: null,
    };
    
    const esc = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    
    async function api(path, data) {
        const r = await fetch(path, data ? {
            method:'POST', credentials:'include',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify(data)
        } : { method:'GET', credentials:'include' });
        if (!r.ok) { const e = await r.json().catch(()=>({error:r.statusText})); throw new Error(e.error||r.statusText); }
        return r.json();
    }
    
    // ══════════════════════════════════════════════════════════════════
    // TAB INJECTION
    // ══════════════════════════════════════════════════════════════════
    
    function injectTab() {
        const timer = setInterval(() => {
            const tabbar = document.getElementById('sb-tabbar');
            const body   = document.getElementById('sb-tab-body');
            if (!tabbar || !body) return;
            clearInterval(timer);
            if (document.getElementById('sb-tab-llm')) return;
            injectCSS();
    
            const btn = document.createElement('button');
            btn.id = 'sb-tab-llm';
            btn.className = 'sb-tab sb-tab-llm';
            btn.dataset.tab = 'llm';
            btn.innerHTML = '⚙️ LLM';
            tabbar.appendChild(btn);
    
            btn.addEventListener('click', () => {
                const twrap = document.getElementById('dt-twrap');
                tabbar.querySelectorAll('.sb-tab').forEach(b => b.classList.remove('sb-tab-active'));
                btn.classList.add('sb-tab-active');
                if (twrap) twrap.style.display = 'none';
                body.style.display = 'flex';
                loadAndRender(body);
            });
        }, 300);
    }
    
    async function loadAndRender(body) {
        body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;width:100%;color:#444c70;font-size:12px">Loading providers…</div>`;
        try {
            const [prov, stat] = await Promise.all([
                api('/api/llm/providers'),
                api('/api/llm/status').catch(()=>null),
            ]);
            LS.providers = prov.providers || [];
            LS.current   = prov.current;
            LS.status    = stat;
            if (LS.current?.provider && !LS.selected) {
                LS.selected = LS.current.provider;
            }
        } catch(e) {
            body.innerHTML = `<div style="padding:20px;color:#ef5350">Error loading providers: ${esc(e.message)}</div>`;
            return;
        }
        renderPanel(body);
    }
    
    // ══════════════════════════════════════════════════════════════════
    // RENDER
    // ══════════════════════════════════════════════════════════════════
    
    function renderPanel(body) {
        body.innerHTML = `<div class="llm-root">${renderMain()}</div>`;
        bindEvents(body);
    }
    
    function renderMain() {
        const cur = LS.current;
        const sel = LS.selected;
    
        // Group providers
        const cloud = LS.providers.filter(p => !p.local);
        const local = LS.providers.filter(p => p.local);
    
        return `
        <div class="llm-layout">
    
            <!-- LEFT: provider list -->
            <div class="llm-left">
                <div class="llm-panel-hdr">
                    <div class="llm-panel-title">⚙️ LLM Provider</div>
                    ${cur ? `<div class="llm-active-badge" style="border-color:${cur.color||'#a78bfa'};color:${cur.color||'#a78bfa'}">
                        Active: ${esc(cur.provider)}
                    </div>` : '<div class="llm-no-badge">Not configured</div>'}
                </div>
    
                <div class="llm-sect-lbl">☁️ Cloud Providers</div>
                ${cloud.map(p => renderProviderCard(p, sel)).join('')}
    
                <div class="llm-sect-lbl" style="margin-top:16px">🖥️ Local (No API Key)</div>
                ${local.map(p => renderProviderCard(p, sel)).join('')}
            </div>
    
            <!-- RIGHT: config form -->
            <div class="llm-right">
                ${sel ? renderConfigForm(sel) : renderPlaceholder()}
            </div>
        </div>
            `;
    }
    
    function renderProviderCard(p, selected) {
        const isActive  = LS.current?.provider === p.id;
        const isSel     = selected === p.id;
        return `
        <div class="llm-card ${isSel?'llm-card-sel':''} ${isActive?'llm-card-active':''}"
             data-provider="${p.id}"
             style="${isSel?`border-color:${p.color};`:''}${isActive?`background:rgba(167,139,250,.04);`:''}">
            <div class="llm-card-left">
                <span class="llm-card-ico">${esc(p.icon)}</span>
                <div>
                    <div class="llm-card-name">${esc(p.name)}</div>
                    ${p.free ? '<span class="llm-free-tag">FREE TIER</span>' : ''}
                </div>
            </div>
            ${isActive ? `<span class="llm-active-dot" style="background:${p.color}"></span>` : ''}
        </div>`;
    }
    
    function renderConfigForm(providerId) {
        const p   = LS.providers.find(x=>x.id===providerId);
        if (!p) return '';
        const cur = LS.current?.provider === providerId ? LS.current : null;
        const savedKey = cur?.apiKey ? '***saved***' : '';
        const savedUrl = cur?.baseUrl || p.defaultUrl || '';
        const savedModel = cur?.model || p.defaultModel || '';
    
        return `
        <div class="llm-form">
            <div class="llm-form-hdr" style="border-left:3px solid ${p.color}">
                <div class="llm-form-ico">${esc(p.icon)}</div>
                <div>
                    <div class="llm-form-name">${esc(p.name)}</div>
                    <div class="llm-form-desc">${esc(p.description||'')}</div>
                </div>
            </div>
    
            ${p.apiKeyRequired ? `
            <div class="llm-field">
                <label class="llm-lbl">API Key
                    <a href="${esc(p.apiKeyUrl||'#')}" target="_blank" class="llm-get-key">Получить ключ ↗</a>
                </label>
                <input class="sb-inp llm-inp" id="llm-apikey" type="password"
                       placeholder="${savedKey ? '***сохранён***' : 'Вставьте API ключ...'}"
                       value="${savedKey}">
                <div class="llm-hint">Хранится на сервере в зашифрованном виде (в БД)</div>
            </div>` : `
            <div class="llm-field">
                <label class="llm-lbl">URL сервера</label>
                <input class="sb-inp llm-inp" id="llm-baseurl"
                       placeholder="${esc(p.defaultUrl||'http://ollama:11434')}"
                       value="${esc(savedUrl)}">
                ${p.apiKeyRequired === false && p.local ? `<div class="llm-hint">🔐 API ключ не нужен — модель работает локально</div>` : ''}
            </div>`}
    
            <div class="llm-field">
                <label class="llm-lbl">Model</label>
                <select class="sb-sel llm-sel" id="llm-model">
                    <option value="${esc(savedModel)}" selected>${esc(savedModel || 'Loading...')}</option>
                </select>
                ${p.local ? `<button class="llm-refresh-btn" id="llm-refresh-models">↺ Refresh</button>` : ''}
            </div>
    
            ${p.id === 'openai_compat' || p.id === 'vllm' || p.id === 'llamacpp' ? `
            <div class="llm-field">
                <label class="llm-lbl">Server URL</label>
                <input class="sb-inp llm-inp" id="llm-baseurl"
                       placeholder="${esc(p.defaultUrl||'http://localhost:8000')}"
                       value="${esc(savedUrl)}">
            </div>` : ''}
    
            <!-- Test & Save buttons -->
            <div class="llm-actions">
                <button class="llm-btn llm-btn-test" id="llm-test-btn" ${LS.testing?'disabled':''}>
                    ${LS.testing ? '<span class="llm-spin"></span> Testing...' : '🔌 Test Connection'}
                </button>
                <button class="llm-btn llm-btn-save" id="llm-save-btn" ${LS.saving?'disabled':''}>
                    ${LS.saving ? '<span class="llm-spin"></span> Saving...' : '💾 Save & Activate'}
                </button>
            </div>
    
            <!-- Test result -->
            ${LS.testResult ? `
            <div class="llm-test-result ${LS.testResult.ok?'llm-ok':'llm-err'}">
                ${LS.testResult.ok
                    ? `✅ Connection OK! Response: "${esc(LS.testResult.response||'OK')}"`
                    : `❌ Error: ${esc(LS.testResult.error)}`}
            </div>` : ''}
    
            <!-- Free tier info -->
            ${p.free ? `
            <div class="llm-free-info">
                💡 <b>Бесплатный тир:</b> ${p.id==='groq'?'Groq даёт 14 400 запросов/сутки бесплатно (достаточно для активного использования)' :
                   p.id==='openrouter'?'OpenRouter имеет модели с пометкой :free — полностью бесплатно, без лимитов' :
                   p.id==='gemini'?'Gemini даёт 15 запросов/мин бесплатно (Flash модель)' : 'Есть бесплатный тир'}
            </div>` : ''}
        </div>`;
    }
    
    function renderPlaceholder() {
        return `<div class="llm-placeholder"><div style="font-size:12px;color:#4a5080">← Выберите провайдера</div></div>`;
    }
    

    // ══════════════════════════════════════════════════════════════════
    // EVENTS
    // ══════════════════════════════════════════════════════════════════
    
    function bindEvents(body) {
        // Provider card click
        body.querySelectorAll('.llm-card').forEach(card => {
            card.addEventListener('click', async () => {
                LS.selected   = card.dataset.provider;
                LS.testResult = null;
                LS.models     = [];
                renderPanel(body);
                // Load models for this provider
                await loadModels(LS.selected, body);
            });
        });
    
        // Test connection
        body.querySelector('#llm-test-btn')?.addEventListener('click', async () => {
            const config = collectFormConfig(body);
            LS.testing = true; LS.testResult = null;
            renderPanel(body);
            try {
                const r = await api('/api/llm/test', config);
                LS.testResult = { ok: true, response: r.response };
            } catch(e) {
                LS.testResult = { ok: false, error: e.message };
            }
            LS.testing = false;
            renderPanel(body);
        });
    
        // Save config
        body.querySelector('#llm-save-btn')?.addEventListener('click', async () => {
            const config = collectFormConfig(body);
            if (!config.provider) return;
            LS.saving = true;
            renderPanel(body);
            try {
                await api('/api/llm/config', config);
                LS.current = config;
                // Уведомить Neural UI
                if (window.neuralUI) window.neuralUI.onLLMChange?.();
                toast('✅ LLM настроен и активирован!', '#4caf50');
            } catch(e) {
                toast('❌ ' + e.message, '#ef5350');
            }
            LS.saving = false;
            renderPanel(body);
        });
    
        // Refresh models (Ollama)
        body.querySelector('#llm-refresh-models')?.addEventListener('click', async () => {
            await loadModels(LS.selected, body);
        });
    }
    
    function collectFormConfig(body) {
        return {
            provider: LS.selected,
            apiKey:   body.querySelector('#llm-apikey')?.value   || '',
            baseUrl:  body.querySelector('#llm-baseurl')?.value  || '',
            model:    body.querySelector('#llm-model')?.value    || '',
        };
    }
    
    async function loadModels(providerId, body) {
        try {
            const r = await api(`/api/llm/models/${providerId}`);
            LS.models = r.models || [];
            const sel   = body.querySelector('#llm-model');
            const saved = LS.current?.provider === providerId ? LS.current.model : null;
            if (sel && LS.models.length) {
                sel.innerHTML = LS.models.map(m =>
                    `<option value="${esc(m.id)}" ${(saved||'')===(m.id)?'selected':''}>
                        ${esc(m.name||m.id)}${m.free?' 🆓':''}${m.vram?` (${m.vram})`:''}
                    </option>`
                ).join('');
            }
        } catch(_) {}
    }
    
    function toast(msg, color='#4caf50') {
        const el = document.createElement('div');
        el.style.cssText=`position:fixed;bottom:60px;right:20px;background:${color};color:#fff;padding:8px 16px;border-radius:6px;font-size:12px;z-index:99999;box-shadow:0 4px 20px rgba(0,0,0,.5)`;
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(()=>el.remove(), 3000);
    }
    
    // ══════════════════════════════════════════════════════════════════
    // CSS
    // ══════════════════════════════════════════════════════════════════
    
    function injectCSS() {
        if (document.getElementById('llm-css')) return;
        const s = document.createElement('style');
        s.id = 'llm-css';
        s.textContent = `
    .sb-tab-llm.sb-tab-active{color:#22d3ee;border-bottom-color:#22d3ee}
    
    .llm-root{width:100%;height:100%;overflow-y:auto;background:#080a12;display:flex;flex-direction:column}
    .llm-layout{display:grid;grid-template-columns:280px 1fr;gap:0;height:100%;min-height:0;flex:1}
    
    /* Left panel */
    .llm-left{background:#0b0d16;border-right:1px solid #141826;overflow-y:auto;padding:0}
    .llm-panel-hdr{padding:12px 14px;border-bottom:1px solid #141826}
    .llm-panel-title{font-size:13px;font-weight:700;color:#c8ccd8;margin-bottom:4px}
    .llm-active-badge{font-size:10px;font-weight:700;padding:2px 8px;border-radius:9px;border:1px solid;display:inline-block;margin-top:4px}
    .llm-no-badge{font-size:10px;color:#ef5350;margin-top:4px}
    .llm-sect-lbl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#3a4060;padding:8px 14px 4px}
    
    .llm-card{display:flex;align-items:center;justify-content:space-between;padding:8px 14px;cursor:pointer;border-left:2px solid transparent;transition:all .12s;border-bottom:1px solid #0f111800}
    .llm-card:hover{background:rgba(255,255,255,.02);color:#c8ccd8}
    .llm-card-sel{background:rgba(167,139,250,.04)!important}
    .llm-card-active{background:rgba(255,255,255,.02)}
    .llm-card-left{display:flex;align-items:center;gap:8px}
    .llm-card-ico{font-size:16px;width:22px;text-align:center}
    .llm-card-name{font-size:11px;font-weight:600;color:#8a90a8}
    .llm-card-sel .llm-card-name{color:#c8ccd8}
    .llm-free-tag{font-size:8px;font-weight:700;background:rgba(76,175,80,.15);color:#4caf50;padding:1px 5px;border-radius:9px;display:inline-block}
    .llm-active-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;box-shadow:0 0 5px currentColor}
    
    /* Right panel */
    .llm-right{overflow-y:auto;padding:20px}
    .llm-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#4a5080;text-align:center;padding:40px}
    
    /* Form */
    .llm-form{max-width:600px}
    .llm-form-hdr{display:flex;align-items:flex-start;gap:12px;padding:12px;background:#0c0e1a;border-radius:6px;margin-bottom:16px;padding-left:16px}
    .llm-form-ico{font-size:28px}
    .llm-form-name{font-size:14px;font-weight:700;color:#c8ccd8;margin-bottom:2px}
    .llm-form-desc{font-size:11px;color:#4a5080;line-height:1.5}
    .llm-field{margin-bottom:14px}
    .llm-lbl{display:flex;align-items:center;justify-content:space-between;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#4a5080;margin-bottom:5px}
    .llm-get-key{font-size:10px;color:#58a6ff;text-decoration:none;font-weight:600;text-transform:none;letter-spacing:0}
    .llm-get-key:hover{text-decoration:underline}
    .llm-inp{width:100%;box-sizing:border-box!important}
    .llm-sel{width:100%;box-sizing:border-box}
    .llm-hint{font-size:10px;color:#3a4060;margin-top:3px}
    .llm-refresh-btn{background:none;border:1px solid #1a1e30;border-radius:3px;color:#4a5080;font-size:10px;padding:2px 7px;cursor:pointer;margin-top:4px}
    .llm-refresh-btn:hover{border-color:#a78bfa;color:#a78bfa}
    .llm-actions{display:flex;gap:8px;margin-top:20px}
    .llm-btn{padding:8px 18px;border-radius:5px;font-size:12px;font-weight:700;cursor:pointer;border:none;font-family:inherit;transition:all .12s}
    .llm-btn-test{background:#1a1e30;color:#8a90a8;border:1px solid #2a2e44}
    .llm-btn-test:hover{border-color:#22d3ee;color:#22d3ee}
    .llm-btn-test:disabled{opacity:.4}
    .llm-btn-save{background:#4a1fb8;color:#fff}
    .llm-btn-save:hover{background:#5b2bc4}
    .llm-btn-save:disabled{opacity:.4}
    .llm-test-result{margin-top:10px;padding:8px 12px;border-radius:5px;font-size:11px}
    .llm-ok{background:rgba(76,175,80,.1);border:1px solid rgba(76,175,80,.3);color:#4caf50}
    .llm-err{background:rgba(239,83,80,.1);border:1px solid rgba(239,83,80,.3);color:#ef5350}
    .llm-free-info{margin-top:10px;padding:8px 12px;background:rgba(76,175,80,.05);border:1px solid rgba(76,175,80,.2);border-radius:5px;font-size:11px;color:#4a5080;line-height:1.6}
    
    /* Guide */
    
    .llm-spin{display:inline-block;width:10px;height:10px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:llm-spin .7s linear infinite;margin-right:4px}
    @keyframes llm-spin{to{transform:rotate(360deg)}}
    `;
        document.head.appendChild(s);
    }
    
    // ══════════════════════════════════════════════════════════════════
    // INIT
    // ══════════════════════════════════════════════════════════════════
    
    injectTab();
    window.llmSettings = { open: () => document.getElementById('sb-tab-llm')?.click() };
    console.log('[LLMSettingsUI] v1.0 loaded');
    
    })(); }