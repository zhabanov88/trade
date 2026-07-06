/**
 * AI Code Analyzer v2
 * Анализ кода через активную LLM
 * Кнопка размещается в .code-actions рядом с Execute/Run
 */

(function () {
    'use strict';

    // ════════════════════════════════════════════════════════
    // STATE
    // ════════════════════════════════════════════════════════
    const ACA = {
        open: false,
        codeType: null,   // 'js' | 'pine' | 'pine6'
        code: '',
        messages: [],
        analyzing: false,
        chatLoading: false,
        suggestedCode: '',
    };

    // Правильные ID редакторов из HTML
    const EDITOR_IDS = {
        js:    'jsEditor',
        pine:  'pineEditor',
        pine6: 'pine6Editor',
    };

    const LABELS = {
        js:    'JavaScript API',
        pine:  'Pine Script 5',
        pine6: 'Pine Script 6',
    };

    // ════════════════════════════════════════════════════════
    // LLM API — /api/llm/chat
    // ════════════════════════════════════════════════════════
    async function llmChat(messages) {
        const r = await fetch('/api/llm/chat', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages }),
        });
        if (!r.ok) {
            const e = await r.json().catch(() => ({ error: r.statusText }));
            throw new Error(e.error || r.statusText);
        }
        const data = await r.json();
        return data.response || data.content || data.message
            || data.choices?.[0]?.message?.content || '';
    }

    // ════════════════════════════════════════════════════════
    // SYSTEM PROMPT
    // ════════════════════════════════════════════════════════
    function systemPrompt(codeType) {
        const base = `You are an expert trading systems developer for TradingView platform.
Analyze the provided code and respond ONLY with a valid JSON object (no markdown, no extra text):
{
  "summary": "brief one-sentence summary",
  "issues": ["critical issue 1", "..."],
  "recommendations": ["recommendation 1", "..."],
  "optimizations": ["optimization 1", "..."],
  "suggested_code": "complete improved code as a string"
}
Always respond in the same language the user writes in (Russian or English).`;

        const extra = {
            js: 'Code type: TradingView Charting Library JavaScript API. Focus on widget API, createStudy, chart manipulation, event handling.',
            pine: 'Code type: Pine Script v5. Focus on ta.* functions, input params, plot styling, strategy logic, alert conditions.',
            pine6: 'Code type: Pine Script v6 (latest). Focus on v6 syntax, type system, methods, matrices, maps, request.* functions.',
        };
        return base + '\n\n' + extra[codeType];
    }

    // ════════════════════════════════════════════════════════
    // OPEN
    // ════════════════════════════════════════════════════════
    function openAnalyzer(codeType) {
        const editorEl = document.getElementById(EDITOR_IDS[codeType]);
        const code = editorEl ? editorEl.value.trim() : '';

        if (!code) {
            showToast('⚠️ Редактор пустой — нечего анализировать', 'warning');
            return;
        }

        ACA.codeType = codeType;
        ACA.code = code;
        ACA.messages = [];
        ACA.suggestedCode = '';
        ACA.analyzing = false;
        ACA.chatLoading = false;

        buildModal();
        document.getElementById('aca-overlay').style.display = 'flex';
        ACA.open = true;

        // Сразу запускаем анализ
        runAnalysis();
    }

    // ════════════════════════════════════════════════════════
    // ANALYSIS
    // ════════════════════════════════════════════════════════
    async function runAnalysis() {
        ACA.analyzing = true;
        setAnalysisState('loading');

        const userMsg = `Analyze this code:\n\`\`\`\n${ACA.code}\n\`\`\``;

        try {
            const reply = await llmChat([
                { role: 'system', content: systemPrompt(ACA.codeType) },
                { role: 'user',   content: userMsg },
            ]);

            ACA.messages = [
                { role: 'user',      content: userMsg },
                { role: 'assistant', content: reply },
            ];

            // Парсим JSON
            let parsed = null;
            try {
                const m = reply.match(/\{[\s\S]*\}/);
                if (m) parsed = JSON.parse(m[0]);
            } catch (_) {}

            if (parsed) {
                ACA.suggestedCode = parsed.suggested_code || '';
                setAnalysisState('done', parsed);
                renderCode();
            } else {
                ACA.suggestedCode = '';
                setAnalysisState('text', reply);
            }
        } catch (err) {
            setAnalysisState('error', err.message);
        } finally {
            ACA.analyzing = false;
        }
    }

    // ════════════════════════════════════════════════════════
    // CHAT
    // ════════════════════════════════════════════════════════
    async function sendChat(text) {
        if (!text.trim() || ACA.chatLoading) return;
        ACA.chatLoading = true;
        ACA.messages.push({ role: 'user', content: text });
        renderMessages();
        clearInput();

        const sys = systemPrompt(ACA.codeType)
            + `\n\nOriginal code:\n\`\`\`\n${ACA.code}\n\`\`\`\nFor follow-up questions respond in plain text with code blocks when needed.`;

        try {
            const reply = await llmChat([
                { role: 'system', content: sys },
                ...ACA.messages,
            ]);
            ACA.messages.push({ role: 'assistant', content: reply });

            // Если в ответе есть блок кода — обновить правую панель
            const cm = reply.match(/```(?:[\w]*)\n?([\s\S]*?)```/);
            if (cm && cm[1].trim()) {
                ACA.suggestedCode = cm[1].trim();
                renderCode();
            }
        } catch (err) {
            ACA.messages.push({ role: 'assistant', content: `❌ Ошибка: ${err.message}` });
        } finally {
            ACA.chatLoading = false;
            renderMessages();
        }
    }

    // ════════════════════════════════════════════════════════
    // APPLY CODE
    // ════════════════════════════════════════════════════════
    function applyCode() {
        if (!ACA.suggestedCode) return;
        const el = document.getElementById(EDITOR_IDS[ACA.codeType]);
        if (el) {
            el.value = ACA.suggestedCode;
            el.dispatchEvent(new Event('input'));
        }
        showToast('✅ Код применён в редактор', 'success');
        closeModal();
    }

    // ════════════════════════════════════════════════════════
    // MODAL BUILD (один раз)
    // ════════════════════════════════════════════════════════
    function buildModal() {
        // Если уже есть — просто обновляем badge
        if (document.getElementById('aca-overlay')) {
            document.getElementById('aca-badge').textContent = LABELS[ACA.codeType];
            // Сбрасываем состояние
            setAnalysisState('idle');
            renderCode();
            renderMessages();
            return;
        }

        injectCSS();

        const overlay = document.createElement('div');
        overlay.id = 'aca-overlay';
        overlay.innerHTML = `
<div id="aca-modal">

  <!-- HEADER -->
  <div id="aca-header">
    <div id="aca-title">
      <span id="aca-title-icon">🤖</span>
      <span>AI Анализ кода</span>
      <span id="aca-badge">${LABELS[ACA.codeType]}</span>
    </div>
    <div id="aca-hbtns">
      <button class="aca-hbtn" id="aca-rerun" title="Перезапустить анализ">↺ Повторить</button>
      <button class="aca-hbtn aca-hbtn-close" id="aca-close">✕</button>
    </div>
  </div>

  <!-- BODY: left = analysis+code, right = chat -->
  <div id="aca-body">

    <!-- LEFT COLUMN -->
    <div id="aca-left">

      <!-- Analysis -->
      <div id="aca-analysis">
        <div class="aca-col-head">📊 Анализ кода</div>
        <div id="aca-analysis-body"></div>
      </div>

      <!-- Suggested code -->
      <div id="aca-code-panel">
        <div class="aca-col-head">
          <span>💡 Предложенный код</span>
          <div id="aca-code-btns">
            <button class="aca-sm-btn" id="aca-copy-btn">⎘ Копировать</button>
            <button class="aca-sm-btn aca-apply-btn" id="aca-apply-btn">▶ Применить</button>
          </div>
        </div>
        <div id="aca-code-wrap">
          <pre id="aca-code-pre"><code id="aca-code-el"></code></pre>
        </div>
      </div>

    </div>

    <!-- RIGHT COLUMN: chat -->
    <div id="aca-right">
      <div class="aca-col-head">💬 Чат с AI</div>
      <div id="aca-messages"></div>
      <div id="aca-input-area">
        <textarea id="aca-input" placeholder="Задайте вопрос по коду…&#10;Ctrl+Enter — отправить" rows="3"></textarea>
        <button id="aca-send-btn">➤</button>
      </div>
    </div>

  </div>
</div>`;

        document.body.appendChild(overlay);

        // Events
        overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
        byId('aca-close').addEventListener('click', closeModal);
        byId('aca-rerun').addEventListener('click', () => { ACA.messages = []; runAnalysis(); });
        byId('aca-apply-btn').addEventListener('click', applyCode);
        byId('aca-copy-btn').addEventListener('click', () => {
            if (ACA.suggestedCode) {
                navigator.clipboard.writeText(ACA.suggestedCode).catch(() => {});
                showToast('Код скопирован', 'success');
            }
        });
        byId('aca-send-btn').addEventListener('click', () => {
            sendChat(byId('aca-input').value);
        });
        byId('aca-input').addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                sendChat(byId('aca-input').value);
            }
        });
    }

    // ════════════════════════════════════════════════════════
    // RENDER helpers
    // ════════════════════════════════════════════════════════
    function setAnalysisState(state, data) {
        const body = byId('aca-analysis-body');
        if (!body) return;

        if (state === 'idle') {
            body.innerHTML = '';
            return;
        }
        if (state === 'loading') {
            body.innerHTML = `<div class="aca-loading"><div class="aca-spin"></div><span>Анализирую код через LLM…</span></div>`;
            return;
        }
        if (state === 'error') {
            body.innerHTML = `<div class="aca-err">❌ ${esc(data)}</div>`;
            return;
        }
        if (state === 'text') {
            body.innerHTML = `<div class="aca-text-body">${esc(data)}</div>`;
            return;
        }

        // state === 'done', data = parsed JSON
        const issues = (data.issues || []);
        const recs   = (data.recommendations || []);
        const opts   = (data.optimizations || []);

        body.innerHTML = `
          ${data.summary ? `<div class="aca-summary">${esc(data.summary)}</div>` : ''}
          ${issues.length ? `<div class="aca-group">
            <div class="aca-group-lbl aca-lbl-red">⚠️ Проблемы</div>
            ${issues.map(x => `<div class="aca-item aca-item-red">• ${esc(x)}</div>`).join('')}
          </div>` : ''}
          ${recs.length ? `<div class="aca-group">
            <div class="aca-group-lbl aca-lbl-blue">✅ Рекомендации</div>
            ${recs.map(x => `<div class="aca-item aca-item-blue">• ${esc(x)}</div>`).join('')}
          </div>` : ''}
          ${opts.length ? `<div class="aca-group">
            <div class="aca-group-lbl aca-lbl-green">⚡ Оптимизации</div>
            ${opts.map(x => `<div class="aca-item aca-item-green">• ${esc(x)}</div>`).join('')}
          </div>` : ''}
        `;
    }

    function renderCode() {
        const el = byId('aca-code-el');
        const applyBtn = byId('aca-apply-btn');
        const copyBtn  = byId('aca-copy-btn');
        if (!el) return;

        if (ACA.suggestedCode) {
            el.textContent = ACA.suggestedCode;
            if (applyBtn) applyBtn.style.display = 'inline-flex';
            if (copyBtn)  copyBtn.style.display  = 'inline-flex';
        } else {
            el.textContent = '// Улучшенный код появится здесь после анализа…';
            if (applyBtn) applyBtn.style.display = 'none';
            if (copyBtn)  copyBtn.style.display  = 'none';
        }
    }

    function renderMessages() {
        const el = byId('aca-messages');
        if (!el) return;

        // Пропускаем первую пару (системный анализ)
        const visible = ACA.messages.slice(2);

        if (!visible.length && !ACA.chatLoading) {
            el.innerHTML = `<div class="aca-chat-hint">Задайте вопрос по коду.<br><small>Ctrl+Enter — отправить</small></div>`;
        } else {
            el.innerHTML = visible.map(m => `
              <div class="aca-msg aca-msg-${m.role}">
                <div class="aca-msg-who">${m.role === 'user' ? '👤 Вы' : '🤖 AI'}</div>
                <div class="aca-msg-text">${fmt(m.content)}</div>
              </div>`).join('');
        }

        if (ACA.chatLoading) {
            el.innerHTML += `<div class="aca-msg aca-msg-assistant">
              <div class="aca-msg-who">🤖 AI</div>
              <div class="aca-dots"><span></span><span></span><span></span></div>
            </div>`;
        }

        el.scrollTop = el.scrollHeight;
    }

    function clearInput() {
        const el = byId('aca-input');
        if (el) el.value = '';
    }

    function closeModal() {
        const el = byId('aca-overlay');
        if (el) el.style.display = 'none';
        ACA.open = false;
    }

    // ════════════════════════════════════════════════════════
    // UTILS
    // ════════════════════════════════════════════════════════
    function byId(id) { return document.getElementById(id); }

    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g,
            c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function fmt(text) {
        return esc(text)
            .replace(/```[\w]*\n?([\s\S]*?)```/g, '<pre class="aca-code-block"><code>$1</code></pre>')
            .replace(/`([^`\n]+)`/g, '<code class="aca-inline">$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\n/g, '<br>');
    }

    function showToast(msg, type = 'info') {
        let t = byId('aca-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'aca-toast';
            document.body.appendChild(t);
        }
        t.textContent = msg;
        t.className = `aca-toast-${type}`;
        t.style.cssText = 'opacity:1;transform:translateX(-50%) translateY(0)';
        clearTimeout(t._t);
        t._t = setTimeout(() => { t.style.opacity = '0'; }, 2500);
    }

    // ════════════════════════════════════════════════════════
    // INJECT BUTTONS into .code-actions (above Execute button)
    // ════════════════════════════════════════════════════════
    function injectButtons() {
        const cfg = [
            { runId: 'jsRunBtn',    type: 'js',    btnId: 'aca-btn-js' },
            { runId: 'pineRunBtn',  type: 'pine',  btnId: 'aca-btn-pine' },
            { runId: 'pine6RunBtn', type: 'pine6', btnId: 'aca-btn-pine6' },
        ];

        const timer = setInterval(() => {
            let done = 0;
            cfg.forEach(({ runId, type, btnId }) => {
                if (byId(btnId)) { done++; return; }
                const runBtn = byId(runId);
                if (!runBtn) return;

                const actionsDiv = runBtn.closest('.code-actions');
                if (!actionsDiv) return;

                const btn = document.createElement('button');
                btn.id = btnId;
                btn.className = 'aca-inject-btn';
                btn.innerHTML = `<span>🤖</span> AI Анализ`;
                btn.title = `Анализ кода через AI (${LABELS[type]})`;
                btn.addEventListener('click', () => openAnalyzer(type));

                // Вставляем ПЕРЕД кнопкой Execute/Run
                actionsDiv.insertBefore(btn, runBtn);
                done++;
            });

            if (done === cfg.length) clearInterval(timer);
        }, 400);

        setTimeout(() => clearInterval(timer), 20000);
    }

    // ════════════════════════════════════════════════════════
    // CSS
    // ════════════════════════════════════════════════════════
    function injectCSS() {
        if (byId('aca-css')) return;
        const s = document.createElement('style');
        s.id = 'aca-css';
        s.textContent = `

/* ════ Injected AI button ════ */
.aca-inject-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 16px;
  background: linear-gradient(135deg, #1a237e 0%, #3949ab 50%, #5c6bc0 100%);
  color: #e8eaf6;
  border: 1px solid #3949ab;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  letter-spacing: 0.3px;
  transition: all .2s;
  margin-bottom: 6px;
}
.aca-inject-btn:hover {
  background: linear-gradient(135deg, #283593 0%, #5c6bc0 50%, #7986cb 100%);
  border-color: #5c6bc0;
  box-shadow: 0 0 16px rgba(92,107,192,.4);
  color: #fff;
}
.aca-inject-btn span { font-size: 16px; }

/* ════ Overlay ════ */
#aca-overlay {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 99999;
  background: rgba(0,0,0,.72);
  backdrop-filter: blur(6px);
  align-items: center;
  justify-content: center;
}

/* ════ Modal ════ */
#aca-modal {
  width: min(94vw, 1320px);
  height: min(90vh, 860px);
  background: #12141f;
  border: 1px solid #252840;
  border-radius: 16px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 32px 100px rgba(0,0,0,.8), 0 0 0 1px rgba(92,107,192,.15);
}

/* ════ Header ════ */
#aca-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  background: #1a1d2e;
  border-bottom: 1px solid #252840;
  flex-shrink: 0;
}
#aca-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 15px;
  font-weight: 700;
  color: #e0e4f8;
}
#aca-title-icon { font-size: 20px; }
#aca-badge {
  font-size: 11px;
  padding: 3px 10px;
  background: rgba(92,107,192,.18);
  border: 1px solid rgba(92,107,192,.3);
  border-radius: 20px;
  color: #7986cb;
  font-weight: 500;
}
#aca-hbtns { display: flex; gap: 8px; align-items: center; }
.aca-hbtn {
  background: transparent;
  border: 1px solid #252840;
  color: #7986cb;
  border-radius: 7px;
  padding: 6px 13px;
  font-size: 12px;
  cursor: pointer;
  transition: all .15s;
}
.aca-hbtn:hover { background: #252840; color: #e0e4f8; }
.aca-hbtn-close { width: 32px; padding: 0; font-size: 14px; }
.aca-hbtn-close:hover { background: #c62828; border-color: #c62828; color: #fff; }

/* ════ Body ════ */
#aca-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* ════ Left column ════ */
#aca-left {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-right: 1px solid #1e2035;
}

#aca-analysis {
  flex-shrink: 0;
  max-height: 44%;
  overflow-y: auto;
  border-bottom: 1px solid #1e2035;
}
#aca-analysis-body { padding: 14px 16px; }

#aca-code-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
#aca-code-wrap {
  flex: 1;
  overflow: auto;
  background: #0d0f1a;
}
#aca-code-pre {
  margin: 0;
  padding: 16px;
  min-height: 100%;
}
#aca-code-el {
  display: block;
  font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 12.5px;
  color: #90caf9;
  white-space: pre;
  line-height: 1.65;
}

/* ════ Right column ════ */
#aca-right {
  width: 340px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #111320;
}
#aca-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
#aca-input-area {
  display: flex;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid #1e2035;
  flex-shrink: 0;
}
#aca-input {
  flex: 1;
  background: #1a1d2e;
  border: 1px solid #252840;
  border-radius: 9px;
  color: #e0e4f8;
  padding: 9px 12px;
  font-size: 13px;
  font-family: inherit;
  resize: none;
  outline: none;
  transition: border-color .15s;
  line-height: 1.5;
}
#aca-input:focus { border-color: #3949ab; }
#aca-input::placeholder { color: #3a3f60; }
#aca-send-btn {
  background: #3949ab;
  color: #fff;
  border: none;
  border-radius: 9px;
  width: 40px;
  font-size: 16px;
  cursor: pointer;
  flex-shrink: 0;
  transition: background .15s;
}
#aca-send-btn:hover { background: #5c6bc0; }

/* ════ Col headers ════ */
.aca-col-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 16px;
  background: #1a1d2e;
  border-bottom: 1px solid #1e2035;
  font-size: 11px;
  font-weight: 700;
  color: #5c6bc0;
  text-transform: uppercase;
  letter-spacing: .6px;
  flex-shrink: 0;
}
#aca-code-btns { display: flex; gap: 6px; }
.aca-sm-btn {
  background: transparent;
  border: 1px solid #252840;
  color: #7986cb;
  border-radius: 5px;
  padding: 3px 10px;
  font-size: 11px;
  cursor: pointer;
  transition: all .15s;
  text-transform: none;
  letter-spacing: 0;
  font-weight: 500;
}
.aca-sm-btn:hover { background: #252840; color: #e0e4f8; }
.aca-apply-btn { background: rgba(56,142,60,.2); border-color: #388e3c; color: #81c784; }
.aca-apply-btn:hover { background: #388e3c; color: #fff; }

/* ════ Analysis content ════ */
.aca-summary {
  background: rgba(92,107,192,.1);
  border-left: 3px solid #3949ab;
  border-radius: 4px;
  padding: 10px 14px;
  font-size: 13px;
  color: #b0bce8;
  line-height: 1.55;
  margin-bottom: 12px;
}
.aca-group { margin-bottom: 12px; }
.aca-group-lbl {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .5px;
  margin-bottom: 6px;
}
.aca-lbl-red   { color: #ef5350; }
.aca-lbl-blue  { color: #5c6bc0; }
.aca-lbl-green { color: #4caf50; }
.aca-item {
  font-size: 13px;
  line-height: 1.5;
  padding: 4px 0 4px 6px;
  border-left: 2px solid transparent;
}
.aca-item-red   { color: #ff8a65; border-left-color: #c62828; }
.aca-item-blue  { color: #c5cae9; border-left-color: #3949ab; }
.aca-item-green { color: #a5d6a7; border-left-color: #388e3c; }
.aca-text-body  { font-size: 13px; color: #b0bce8; line-height: 1.6; white-space: pre-wrap; }

/* ════ Loading ════ */
.aca-loading {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px 0;
  color: #5c6bc0;
  font-size: 13px;
}
.aca-spin {
  width: 18px; height: 18px;
  border: 2px solid #1e2035;
  border-top-color: #5c6bc0;
  border-radius: 50%;
  animation: aca-spin .8s linear infinite;
  flex-shrink: 0;
}
@keyframes aca-spin { to { transform: rotate(360deg); } }
.aca-err { padding: 12px 0; color: #ef9a9a; font-size: 13px; }

/* ════ Chat messages ════ */
.aca-chat-hint {
  text-align: center;
  color: #2e3460;
  font-size: 13px;
  margin-top: 50px;
  line-height: 1.8;
}
.aca-chat-hint small { font-size: 11px; color: #252840; }
.aca-msg { display: flex; flex-direction: column; gap: 4px; }
.aca-msg-who { font-size: 11px; font-weight: 600; }
.aca-msg-user .aca-msg-who { color: #3949ab; }
.aca-msg-assistant .aca-msg-who { color: #2e7d32; }
.aca-msg-text {
  padding: 10px 12px;
  border-radius: 9px;
  font-size: 13px;
  line-height: 1.55;
  color: #c5cae9;
  word-break: break-word;
}
.aca-msg-user .aca-msg-text { background: #1e2548; }
.aca-msg-assistant .aca-msg-text { background: #1a1d2e; }
.aca-code-block {
  background: #0d0f1a;
  border-radius: 6px;
  padding: 10px 12px;
  margin: 6px 0;
  overflow-x: auto;
  font-size: 12px;
  color: #90caf9;
  display: block;
}
.aca-inline {
  background: #0d0f1a;
  border-radius: 3px;
  padding: 1px 5px;
  font-size: 12px;
  color: #90caf9;
  font-family: monospace;
}

/* typing dots */
.aca-dots { display: flex; gap: 5px; padding: 6px 0; }
.aca-dots span {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: #3949ab;
  animation: aca-dot 1.1s infinite;
}
.aca-dots span:nth-child(2) { animation-delay: .18s; }
.aca-dots span:nth-child(3) { animation-delay: .36s; }
@keyframes aca-dot {
  0%,80%,100% { opacity:.2; transform:scale(.8); }
  40% { opacity:1; transform:scale(1); }
}

/* ════ Toast ════ */
#aca-toast {
  position: fixed;
  bottom: 30px;
  left: 50%;
  transform: translateX(-50%) translateY(10px);
  background: #1a1d2e;
  border: 1px solid #252840;
  color: #e0e4f8;
  padding: 10px 24px;
  border-radius: 9px;
  font-size: 13px;
  z-index: 100001;
  opacity: 0;
  pointer-events: none;
  transition: opacity .25s, transform .25s;
}
.aca-toast-success { border-color: #388e3c !important; color: #81c784 !important; }
.aca-toast-warning { border-color: #f57c00 !important; color: #ffb74d !important; }

/* scrollbar */
#aca-analysis::-webkit-scrollbar,
#aca-code-wrap::-webkit-scrollbar,
#aca-messages::-webkit-scrollbar { width: 5px; }
#aca-analysis::-webkit-scrollbar-thumb,
#aca-code-wrap::-webkit-scrollbar-thumb,
#aca-messages::-webkit-scrollbar-thumb { background: #252840; border-radius: 3px; }
`;
        document.head.appendChild(s);
    }

    // ════════════════════════════════════════════════════════
    // PUBLIC + BOOT
    // ════════════════════════════════════════════════════════
    window.AICodeAnalyzer = { open: openAnalyzer, close: closeModal };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectButtons);
    } else {
        injectButtons();
    }

})();