/**
 * llm-router.js  v1.0
 * ══════════════════════════════════════════════════════════════════════
 * UNIVERSAL LLM ROUTER
 *
 * Поддерживает провайдеров:
 *  ☁️  ОБЛАЧНЫЕ:
 *    - Anthropic Claude (claude-opus-4-6, sonnet, haiku)
 *    - OpenAI ChatGPT (gpt-4o, gpt-4-turbo, o1, o3)
 *    - DeepSeek (deepseek-chat, deepseek-reasoner)
 *    - Groq (llama-3.3-70b, mixtral-8x7b — быстро и бесплатно!)
 *    - Google Gemini (gemini-2.0-flash-exp)
 *    - Mistral AI (mistral-large-latest)
 *    - OpenRouter (сотни моделей через один ключ)
 *    - xAI Grok (grok-2)
 *
 *  🖥️  ЛОКАЛЬНЫЕ (без API ключей):
 *    - Ollama (localhost:11434) — llama3, mistral, qwen, deepseek-r1, phi4
 *    - LM Studio (localhost:1234) — любые GGUF модели
 *    - vLLM (любой хост) — высокопроизводительный inference
 *    - llama.cpp server (любой хост)
 *    - Jan.ai (localhost:1337)
 *    - Anything with OpenAI-compatible API
 *
 * Использование в server.js:
 *   const { LLMRouter } = require('./llm-router');
 *   const llmRouter = new LLMRouter();
 *   await llmRouter.loadConfig(pgPool);
 *   llmRouter.mountRoutes(app, requireAuth, pgPool);
 *
 * API:
 *   POST /api/llm/providers     — список провайдеров
 *   POST /api/llm/config        — сохранить конфиг
 *   POST /api/llm/test          — тест соединения
 *   POST /api/llm/chat          — прямой чат
 *   GET  /api/llm/models/:provider — список моделей
 * ══════════════════════════════════════════════════════════════════════
 */

'use strict';

const https = require('https');
const http  = require('http');

// ═══════════════════════════════════════════════════════════════════
// PROVIDER DEFINITIONS
// ═══════════════════════════════════════════════════════════════════

const PROVIDERS = {
    anthropic: {
        id:       'anthropic',
        name:     'Anthropic Claude',
        icon:     '🤖',
        local:    false,
        apiKeyRequired: true,
        apiKeyUrl: 'https://console.anthropic.com/settings/keys',
        baseUrl:   'api.anthropic.com',
        defaultModel: 'claude-opus-4-6',
        models: [
            { id: 'claude-opus-4-6',         name: 'Claude Opus 4.6 (Smartest)',   ctx: 200000 },
            { id: 'claude-sonnet-4-6',        name: 'Claude Sonnet 4.6 (Balanced)', ctx: 200000 },
            { id: 'claude-haiku-4-5-20251001',name: 'Claude Haiku 4.5 (Fast)',      ctx: 200000 },
        ],
        color: '#d97706',
        description: 'Лучшие модели для кода и анализа. Ключ на console.anthropic.com',
    },
    openai: {
        id:       'openai',
        name:     'OpenAI ChatGPT',
        icon:     '🟢',
        local:    false,
        apiKeyRequired: true,
        apiKeyUrl: 'https://platform.openai.com/api-keys',
        baseUrl:   'api.openai.com',
        defaultModel: 'gpt-4o',
        models: [
            { id: 'gpt-4o',           name: 'GPT-4o (Best)',        ctx: 128000 },
            { id: 'gpt-4o-mini',      name: 'GPT-4o Mini (Fast)',   ctx: 128000 },
            { id: 'gpt-4-turbo',      name: 'GPT-4 Turbo',          ctx: 128000 },
            { id: 'o1',               name: 'o1 (Reasoning)',        ctx: 200000 },
            { id: 'o1-mini',          name: 'o1-mini (Reasoning)',   ctx: 128000 },
            { id: 'o3-mini',          name: 'o3-mini (Reasoning)',   ctx: 200000 },
        ],
        color: '#10b981',
        description: 'ChatGPT API. Ключ на platform.openai.com',
    },
    deepseek: {
        id:       'deepseek',
        name:     'DeepSeek',
        icon:     '🐳',
        local:    false,
        apiKeyRequired: true,
        apiKeyUrl: 'https://platform.deepseek.com/api_keys',
        baseUrl:   'api.deepseek.com',
        defaultModel: 'deepseek-chat',
        models: [
            { id: 'deepseek-chat',     name: 'DeepSeek V3 (Best)',     ctx: 128000 },
            { id: 'deepseek-reasoner', name: 'DeepSeek R1 (Reasoning)', ctx: 128000 },
        ],
        color: '#3b82f6',
        description: 'Топовые открытые модели. Дешевле OpenAI в 10-30x. Ключ на platform.deepseek.com',
    },
    groq: {
        id:       'groq',
        name:     'Groq (Ultra Fast)',
        icon:     '⚡',
        local:    false,
        apiKeyRequired: true,
        apiKeyUrl: 'https://console.groq.com/keys',
        baseUrl:   'api.groq.com',
        defaultModel: 'llama-3.3-70b-versatile',
        models: [
            { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B (Best)',    ctx: 128000 },
            { id: 'llama-3.1-8b-instant',    name: 'Llama 3.1 8B (Fastest)',  ctx: 128000 },
            { id: 'mixtral-8x7b-32768',      name: 'Mixtral 8x7B',            ctx: 32768  },
            { id: 'gemma2-9b-it',            name: 'Gemma2 9B',               ctx: 8192   },
            { id: 'deepseek-r1-distill-llama-70b', name: 'DeepSeek R1 70B',   ctx: 128000 },
        ],
        color: '#f59e0b',
        description: '🆓 БЕСПЛАТНЫЙ тир! Самый быстрый inference (500+ tok/s). Ключ на console.groq.com',
        free: true,
    },
    gemini: {
        id:       'gemini',
        name:     'Google Gemini',
        icon:     '✨',
        local:    false,
        apiKeyRequired: true,
        apiKeyUrl: 'https://aistudio.google.com/app/apikey',
        baseUrl:   'generativelanguage.googleapis.com',
        defaultModel: 'gemini-2.0-flash-exp',
        models: [
            { id: 'gemini-2.0-flash-exp',   name: 'Gemini 2.0 Flash (Fast)',  ctx: 1000000 },
            { id: 'gemini-1.5-pro',          name: 'Gemini 1.5 Pro (Best)',    ctx: 2000000 },
            { id: 'gemini-1.5-flash',        name: 'Gemini 1.5 Flash',        ctx: 1000000 },
        ],
        color: '#8b5cf6',
        description: 'Google Gemini. Ключ на aistudio.google.com (бесплатный тир есть)',
        free: true,
    },
    mistral: {
        id:       'mistral',
        name:     'Mistral AI',
        icon:     '🌀',
        local:    false,
        apiKeyRequired: true,
        apiKeyUrl: 'https://console.mistral.ai/api-keys',
        baseUrl:   'api.mistral.ai',
        defaultModel: 'mistral-large-latest',
        models: [
            { id: 'mistral-large-latest',  name: 'Mistral Large (Best)', ctx: 128000 },
            { id: 'mistral-small-latest',  name: 'Mistral Small (Fast)', ctx: 128000 },
            { id: 'codestral-latest',      name: 'Codestral (Code)',     ctx: 256000 },
            { id: 'open-mixtral-8x22b',    name: 'Mixtral 8x22B',       ctx: 64000  },
        ],
        color: '#f97316',
        description: 'Европейские открытые модели. Сильны в коде (Codestral)',
    },
    openrouter: {
        id:       'openrouter',
        name:     'OpenRouter (All Models)',
        icon:     '🔀',
        local:    false,
        apiKeyRequired: true,
        apiKeyUrl: 'https://openrouter.ai/keys',
        baseUrl:   'openrouter.ai',
        defaultModel: 'anthropic/claude-opus-4-6',
        models: [
            { id: 'anthropic/claude-opus-4-6',     name: 'Claude Opus 4.6',        ctx: 200000 },
            { id: 'openai/gpt-4o',                   name: 'GPT-4o',                 ctx: 128000 },
            { id: 'deepseek/deepseek-chat',           name: 'DeepSeek V3',            ctx: 128000 },
            { id: 'deepseek/deepseek-r1',             name: 'DeepSeek R1',            ctx: 128000 },
            { id: 'meta-llama/llama-3.3-70b-instruct',name: 'Llama 3.3 70B (Free!)', ctx: 128000, free: true },
            { id: 'google/gemini-2.0-flash-exp:free', name: 'Gemini 2.0 Flash (Free!)', ctx: 1000000, free: true },
            { id: 'microsoft/phi-4',                  name: 'Phi-4 (Free!)',          ctx: 16000, free: true },
        ],
        color: '#ec4899',
        description: 'Единый ключ для 200+ моделей. Есть БЕСПЛАТНЫЕ модели! openrouter.ai',
        free: true,
    },
    xai: {
        id:       'xai',
        name:     'xAI Grok',
        icon:     '𝕏',
        local:    false,
        apiKeyRequired: true,
        apiKeyUrl: 'https://console.x.ai/',
        baseUrl:   'api.x.ai',
        defaultModel: 'grok-2-1212',
        models: [
            { id: 'grok-2-1212',      name: 'Grok 2 (Best)',  ctx: 131072 },
            { id: 'grok-2-vision-1212', name: 'Grok 2 Vision', ctx: 32768  },
            { id: 'grok-beta',        name: 'Grok Beta',      ctx: 131072 },
        ],
        color: '#1d1d1d',
        description: 'Grok от Elon Musk / xAI. Доступ через console.x.ai',
    },
    // ── LOCAL PROVIDERS ──────────────────────────────────────────────
    ollama: {
        id:       'ollama',
        name:     'Ollama (Local)',
        icon:     '🦙',
        local:    true,
        apiKeyRequired: false,
        defaultUrl: 'http://localhost:11434',
        defaultModel: 'llama3.3',
        models: [
            { id: 'llama3.3',          name: 'Llama 3.3 70B (Рекомендован)',  ctx: 128000, vram: '40GB' },
            { id: 'llama3.1:70b',      name: 'Llama 3.1 70B',               ctx: 128000, vram: '40GB' },
            { id: 'llama3.1:8b',       name: 'Llama 3.1 8B (Быстро)',       ctx: 128000, vram: '8GB'  },
            { id: 'deepseek-r1:70b',   name: 'DeepSeek R1 70B',             ctx: 64000,  vram: '40GB' },
            { id: 'deepseek-r1:32b',   name: 'DeepSeek R1 32B',             ctx: 64000,  vram: '20GB' },
            { id: 'deepseek-r1:14b',   name: 'DeepSeek R1 14B',             ctx: 64000,  vram: '10GB' },
            { id: 'deepseek-r1:8b',    name: 'DeepSeek R1 8B',              ctx: 32000,  vram: '6GB'  },
            { id: 'qwen2.5:72b',       name: 'Qwen 2.5 72B',                ctx: 128000, vram: '40GB' },
            { id: 'qwen2.5-coder:32b', name: 'Qwen 2.5 Coder 32B (Код!)',  ctx: 128000, vram: '20GB' },
            { id: 'qwen2.5:14b',       name: 'Qwen 2.5 14B',                ctx: 128000, vram: '10GB' },
            { id: 'mistral:7b',        name: 'Mistral 7B',                  ctx: 32000,  vram: '6GB'  },
            { id: 'phi4',              name: 'Microsoft Phi-4 14B',         ctx: 16000,  vram: '10GB' },
            { id: 'gemma2:27b',        name: 'Gemma 2 27B',                 ctx: 8000,   vram: '20GB' },
            { id: 'codellama:70b',     name: 'CodeLlama 70B',               ctx: 16000,  vram: '40GB' },
        ],
        color: '#6366f1',
        description: 'Полностью локально, без интернета. Установить: curl -fsSL https://ollama.ai/install.sh | sh',
    },
    lmstudio: {
        id:       'lmstudio',
        name:     'LM Studio (Local)',
        icon:     '🎨',
        local:    true,
        apiKeyRequired: false,
        defaultUrl: 'http://localhost:1234',
        defaultModel: 'loaded_model',
        models: [
            { id: 'loaded_model', name: 'Текущая загруженная модель', ctx: 32768 },
        ],
        color: '#06b6d4',
        description: 'GUI для запуска GGUF моделей. Скачать: lmstudio.ai',
    },
    vllm: {
        id:       'vllm',
        name:     'vLLM Server (Local/Remote)',
        icon:     '🚀',
        local:    true,
        apiKeyRequired: false,
        defaultUrl: 'http://localhost:8000',
        defaultModel: '',
        models: [],
        color: '#84cc16',
        description: 'Высокопроизводительный inference сервер. Для GPU серверов.',
    },
    llamacpp: {
        id:       'llamacpp',
        name:     'llama.cpp Server (Local)',
        icon:     '⚙️',
        local:    true,
        apiKeyRequired: false,
        defaultUrl: 'http://localhost:8080',
        defaultModel: '',
        models: [],
        color: '#a3a3a3',
        description: 'Максимально лёгкий inference. ./server -m model.gguf --port 8080',
    },
    openai_compat: {
        id:       'openai_compat',
        name:     'OpenAI-Compatible API',
        icon:     '🔌',
        local:    true,
        apiKeyRequired: false,
        defaultUrl: 'http://localhost:8000',
        defaultModel: '',
        models: [],
        color: '#78716c',
        description: 'Любой сервер совместимый с OpenAI API (Jan.ai, TabbyML, и др.)',
    },
};

// ═══════════════════════════════════════════════════════════════════
// HTTP HELPER (без axios, только встроенные модули)
// ═══════════════════════════════════════════════════════════════════

function httpPost(url, headers, body, timeoutMs=900000) {
    return new Promise((resolve, reject) => {
        const parsed  = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const lib     = isHttps ? https : http;
        const data    = JSON.stringify(body);

        const options = {
            hostname: parsed.hostname,
            port:     parsed.port || (isHttps ? 443 : 80),
            path:     parsed.pathname + (parsed.search || ''),
            method:   'POST',
            headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
            timeout:  timeoutMs,
        };

        const req = lib.request(options, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(raw);
                    if (res.statusCode >= 400) {
                        reject(new Error(json?.error?.message || json?.message || `HTTP ${res.statusCode}: ${raw.slice(0,200)}`));
                    } else {
                        resolve(json);
                    }
                } catch(_) {
                    reject(new Error(`Invalid JSON from ${url}: ${raw.slice(0,200)}`));
                }
            });
        });

        req.on('timeout', () => { req.destroy(); reject(new Error(`Request timeout (${timeoutMs}ms)`)); });
        req.on('error',   reject);
        req.write(data);
        req.end();
    });
}

function httpGet(url, headers={}, timeoutMs=10000) {
    return new Promise((resolve, reject) => {
        const parsed  = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const lib     = isHttps ? https : http;
        const options = {
            hostname: parsed.hostname,
            port:     parsed.port || (isHttps ? 443 : 80),
            path:     parsed.pathname + (parsed.search || ''),
            method:   'GET',
            headers,
            timeout:  timeoutMs,
        };
        const req = lib.request(options, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try { resolve(JSON.parse(raw)); }
                catch(_) { resolve({ raw }); }
            });
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.on('error',   reject);
        req.end();
    });
}

// ═══════════════════════════════════════════════════════════════════
// ADAPTERS — нормализуют ответы к общему формату
// ═══════════════════════════════════════════════════════════════════

async function callAnthropic(cfg, messages, systemPrompt, maxTokens) {
    const resp = await httpPost(
        `https://api.anthropic.com/v1/messages`,
        {
            'x-api-key': cfg.apiKey,
            'anthropic-version': '2023-06-01',
        },
        { model: cfg.model, max_tokens: maxTokens, system: systemPrompt, messages }
    );
    return resp.content?.[0]?.text || '';
}

async function callOpenAI(cfg, messages, systemPrompt, maxTokens) {
    const baseUrl = cfg.baseUrl || 'https://api.openai.com';
    const msgs = [{ role:'system', content: systemPrompt }, ...messages];
    const body  = { model: cfg.model, max_tokens: maxTokens, messages: msgs };
    const hdrs  = {};
    if (cfg.apiKey) hdrs['Authorization'] = `Bearer ${cfg.apiKey}`;
    if (cfg.baseUrl?.includes('openrouter.ai')) {
        hdrs['HTTP-Referer'] = 'https://tradeview.local';
        hdrs['X-Title'] = 'TradeView Neural';
    }
    const resp = await httpPost(`${baseUrl}/v1/chat/completions`, hdrs, body);
    return resp.choices?.[0]?.message?.content || '';
}

async function callGemini(cfg, messages, systemPrompt, maxTokens) {
    const model   = cfg.model || 'gemini-2.0-flash-exp';
    const url     = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cfg.apiKey}`;
    const parts   = [{ text: systemPrompt + '\n\n' + messages.map(m=>`${m.role}: ${m.content}`).join('\n') }];
    const resp    = await httpPost(url, {}, {
        contents: [{ parts }],
        generationConfig: { maxOutputTokens: maxTokens }
    });
    return resp.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callOllama(cfg, messages, systemPrompt, maxTokens) {
    const baseUrl = cfg.baseUrl || 'http://localhost:11434';
    const msgs    = [{ role:'system', content: systemPrompt }, ...messages];
    const resp    = await httpPost(`${baseUrl}/api/chat`, {}, {
        model: cfg.model,
        messages: msgs,
        stream: false,
        options: { num_predict: maxTokens },
    }, 900000);
    return resp.message?.content || resp.response || '';
}

async function callOpenAICompat(cfg, messages, systemPrompt, maxTokens) {
    // LM Studio, vLLM, llama.cpp, Jan.ai, etc.
    const baseUrl = cfg.baseUrl || 'http://localhost:1234';
    const msgs    = [{ role:'system', content: systemPrompt }, ...messages];
    const body    = { model: cfg.model || 'default', max_tokens: maxTokens, messages: msgs };
    const hdrs    = cfg.apiKey ? { 'Authorization': `Bearer ${cfg.apiKey}` } : {};
    const resp    = await httpPost(`${baseUrl}/v1/chat/completions`, hdrs, body, 900000);
    return resp.choices?.[0]?.message?.content || '';
}

// ═══════════════════════════════════════════════════════════════════
// LLMRouter CLASS
// ═══════════════════════════════════════════════════════════════════

class LLMRouter {
    constructor() {
        this.config  = null;  // { provider, model, apiKey, baseUrl, ... }
        this.pgPool  = null;
    }

    async loadConfig(pgPool) {
        this.pgPool = pgPool;
        // Попробовать загрузить из БД
        try {
            const r = await pgPool.query(
                `SELECT value FROM neural_config WHERE key='llm_config' LIMIT 1`
            );
            if (r.rows.length) {
                this.config = JSON.parse(r.rows[0].value);
                console.log(`[LLMRouter] Loaded config: ${this.config.provider} / ${this.config.model}`);
                return;
            }
        } catch(_) {}

        // Fallback: .env переменные
        const provider = process.env.LLM_PROVIDER;
        if (provider) {
            this.config = {
                provider,
                model:   process.env.LLM_MODEL   || PROVIDERS[provider]?.defaultModel || '',
                apiKey:  process.env.LLM_API_KEY  || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || '',
                baseUrl: process.env.LLM_BASE_URL || '',
            };
            console.log(`[LLMRouter] Config from env: ${provider}`);
        }
    }

    async saveConfig(pgPool, config) {
        this.config = config;
        try {
            await pgPool.query(`DELETE FROM neural_config WHERE key='llm_config'`);
            await pgPool.query(
                `INSERT INTO neural_config (key, value) VALUES ('llm_config', $1)`,
                [JSON.stringify(config)]
            );
        } catch(e) {
            console.error('[LLMRouter] Save config error:', e.message);
        }
    }

    isConfigured() {
        return !!(this.config?.provider);
    }

    async chat(messages, systemPrompt, opts={}) {
        if (!this.config) throw new Error('LLM not configured. Set up provider in ⚙️ LLM Settings tab.');
        const maxTokens = opts.maxTokens || 2048;
        const { provider, model, apiKey, baseUrl } = this.config;
        const cfg = { model, apiKey, baseUrl };

        switch (provider) {
            case 'anthropic':   return callAnthropic(cfg, messages, systemPrompt, maxTokens);
            case 'openai':      return callOpenAI({ ...cfg, baseUrl: 'https://api.openai.com' }, messages, systemPrompt, maxTokens);
            case 'deepseek':    return callOpenAI({ ...cfg, baseUrl: 'https://api.deepseek.com' }, messages, systemPrompt, maxTokens);
            case 'groq':        return callOpenAI({ ...cfg, baseUrl: 'https://api.groq.com/openai' }, messages, systemPrompt, maxTokens);
            case 'mistral':     return callOpenAI({ ...cfg, baseUrl: 'https://api.mistral.ai' }, messages, systemPrompt, maxTokens);
            case 'openrouter':  return callOpenAI({ ...cfg, baseUrl: 'https://openrouter.ai' }, messages, systemPrompt, maxTokens);
            case 'xai':         return callOpenAI({ ...cfg, baseUrl: 'https://api.x.ai' }, messages, systemPrompt, maxTokens);
            case 'gemini':      return callGemini(cfg, messages, systemPrompt, maxTokens);
            case 'ollama':      return callOllama(cfg, messages, systemPrompt, maxTokens);
            case 'lmstudio':    return callOpenAICompat({ ...cfg, baseUrl: baseUrl || 'http://localhost:1234' }, messages, systemPrompt, maxTokens);
            case 'vllm':        return callOpenAICompat({ ...cfg, baseUrl: baseUrl || 'http://localhost:8000' }, messages, systemPrompt, maxTokens);
            case 'llamacpp':    return callOpenAICompat({ ...cfg, baseUrl: baseUrl || 'http://localhost:8080' }, messages, systemPrompt, maxTokens);
            case 'openai_compat': return callOpenAICompat(cfg, messages, systemPrompt, maxTokens);
            default: throw new Error(`Unknown provider: ${provider}`);
        }
    }

    async testConnection(config) {
        const savedConfig = this.config;
        this.config = config;
        try {
            const resp = await this.chat(
                [{ role:'user', content: 'Reply only: OK' }],
                'You are a test. Reply with just "OK".',
                { maxTokens: 10 }
            );
            this.config = savedConfig;
            return { ok: true, response: resp?.trim() };
        } catch(e) {
            this.config = savedConfig;
            throw e;
        }
    }

    async getAvailableModels(provider, config) {
        // Для Ollama можно получить список установленных моделей
        if (provider === 'ollama') {
            try {
                const baseUrl = config?.baseUrl || 'http://localhost:11434';
                const r = await httpGet(`${baseUrl}/api/tags`);
                return (r.models || []).map(m => ({ id: m.name, name: m.name, size: m.size }));
            } catch(_) {
                return PROVIDERS.ollama.models;
            }
        }
        // Для vLLM
        if (provider === 'vllm' || provider === 'llamacpp' || provider === 'openai_compat') {
            try {
                const baseUrl = config?.baseUrl || PROVIDERS[provider]?.defaultUrl;
                const r = await httpGet(`${baseUrl}/v1/models`);
                return (r.data || []).map(m => ({ id: m.id, name: m.id }));
            } catch(_) {
                return [];
            }
        }
        // OpenRouter — список бесплатных
        if (provider === 'openrouter') {
            try {
                const r = await httpGet('https://openrouter.ai/api/v1/models', {
                    Authorization: `Bearer ${config?.apiKey || ''}`,
                });
                return (r.data || [])
                    .filter(m => m.id)
                    .map(m => ({ id: m.id, name: m.name || m.id, free: m.pricing?.prompt === '0' }))
                    .slice(0, 50);
            } catch(_) {}
        }
        return PROVIDERS[provider]?.models || [];
    }

    mountRoutes(app, requireAuth, pgPool) {
        this.pgPool = pgPool;

        // GET /api/llm/providers — список всех провайдеров
        app.get('/api/llm/providers', requireAuth, (req, res) => {
            const current = this.config?.provider;
            const result  = Object.values(PROVIDERS).map(p => ({
                ...p,
                models: undefined, // не передаём все модели в список
                modelCount: p.models.length || '?',
                active: p.id === current,
            }));
            res.json({ providers: result, current: this.config || null });
        });

        // GET /api/llm/models/:provider — модели провайдера
        app.get('/api/llm/models/:provider', requireAuth, async (req, res) => {
            const p = PROVIDERS[req.params.provider];
            if (!p) return res.status(404).json({ error: 'Unknown provider' });
            try {
                const models = await this.getAvailableModels(req.params.provider, this.config);
                res.json({ provider: req.params.provider, models });
            } catch(e) {
                res.json({ provider: req.params.provider, models: p.models || [] });
            }
        });

        // POST /api/llm/config — сохранить конфигурацию
        app.post('/api/llm/config', requireAuth, async (req, res) => {
            const { provider, model, apiKey, baseUrl } = req.body;
            if (!provider || !PROVIDERS[provider]) {
                return res.status(400).json({ error: 'Unknown provider: ' + provider });
            }
            const config = { provider, model: model || PROVIDERS[provider].defaultModel, apiKey, baseUrl };
            try {
                await this.saveConfig(pgPool, config);
                res.json({ ok: true, config: { ...config, apiKey: config.apiKey ? '***' : '' } });
            } catch(e) {
                res.status(500).json({ error: e.message });
            }
        });

        // POST /api/llm/test — тест соединения
        app.post('/api/llm/test', requireAuth, async (req, res) => {
            const { provider, model, apiKey, baseUrl } = req.body;
            const testConfig = { provider, model, apiKey, baseUrl };
            try {
                const result = await this.testConnection(testConfig);
                res.json({ ok: true, response: result.response });
            } catch(e) {
                res.status(400).json({ ok: false, error: e.message });
            }
        });

        // POST /api/llm/chat — прямой чат (используется Neural UI)
        app.post('/api/llm/chat', requireAuth, async (req, res) => {
            const { messages, systemPrompt, maxTokens } = req.body;
            if (!this.isConfigured()) return res.status(400).json({ error: 'LLM not configured' });
            try {
                const response = await this.chat(messages, systemPrompt || 'You are a helpful assistant.', { maxTokens: maxTokens || 2048 });
                res.json({ response });
            } catch(e) {
                res.status(500).json({ error: e.message });
            }
        });

        // GET /api/llm/status
        app.get('/api/llm/status', requireAuth, (req, res) => {
            res.json({
                configured: this.isConfigured(),
                provider:   this.config?.provider,
                model:      this.config?.model,
                local:      PROVIDERS[this.config?.provider]?.local || false,
                providerName: PROVIDERS[this.config?.provider]?.name || '',
            });
        });

        console.log('[LLMRouter] ✅ Routes mounted: /api/llm/*');
    }
}

module.exports = { LLMRouter, PROVIDERS };