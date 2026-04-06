/**
 * AI Code Analyzer v3
 * - Два режима: Анализ (analysis) и Доработка (refactor)
 * - Железный парсер JSON: двухходовый запрос если первый не распознан
 * - Полная база знаний реального API платформы в системном промпте
 */
(function () {
  'use strict';

  const ACA = {
      mode: 'analysis',
      codeType: null,
      code: '',
      messages: [],
      analyzing: false,
      chatLoading: false,
      suggestedCode: '',
  };

  const EDITOR_IDS = { js: 'jsEditor', pine: 'pineEditor', pine6: 'pine6Editor' };
  const LABELS     = { js: 'JavaScript API', pine: 'Pine Script 5', pine6: 'Pine Script 6' };

  // ═══════════════════════════════════════════════════════════
  // LLM
  // ═══════════════════════════════════════════════════════════
  async function llmChat(messages) {
      const r = await fetch('/api/llm/chat', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({ error: r.statusText })); throw new Error(e.error || r.statusText); }
      const d = await r.json();
      return d.response || d.content || d.message || d.choices?.[0]?.message?.content || JSON.stringify(d);
  }

  // ═══════════════════════════════════════════════════════════
  // JSON EXTRACTOR — 5 уровней
  // ═══════════════════════════════════════════════════════════
  function extractJSON(raw) {
      if (!raw || typeof raw !== 'string') return null;

      // 1. Весь ответ напрямую
      try { const r = JSON.parse(raw.trim()); if (r && typeof r === 'object') return r; } catch (_) {}

      // 2. Убрать markdown-обёртки любого вида
      const noFences = raw
          .replace(/^[\s\S]*?```+(?:json|js|javascript)?\s*/i, '')
          .replace(/\s*```+[\s\S]*$/i, '')
          .trim();
      try { const r = JSON.parse(noFences); if (r && typeof r === 'object') return r; } catch (_) {}

      // 3. Depth-aware поиск { ... }
      let depth = 0, start = -1;
      for (let i = 0; i < raw.length; i++) {
          if (raw[i] === '{') { if (depth === 0) start = i; depth++; }
          else if (raw[i] === '}' && depth > 0) {
              depth--;
              if (depth === 0 && start !== -1) {
                  try { const r = JSON.parse(raw.slice(start, i + 1)); if (r && typeof r === 'object') return r; } catch (_) {}
                  start = -1;
              }
          }
      }

      // 4. Экранировать переносы в строках
      try {
          const m = raw.match(/\{[\s\S]*\}/);
          if (m) {
              const fixed = m[0].replace(/"((?:[^"\\]|\\.)*)"/g, (_, v) => '"' + v.replace(/\n/g, '\\n').replace(/\r/g, '') + '"');
              const r = JSON.parse(fixed);
              if (r && typeof r === 'object') return r;
          }
      } catch (_) {}

      // 5. Починить обрезанный JSON
      try {
          const m = raw.match(/\{[\s\S]*/);
          if (m) {
              const opens = (m[0].match(/\{/g)||[]).length - (m[0].match(/\}/g)||[]).length;
              const r = JSON.parse(m[0] + '}'.repeat(Math.max(0, opens)));
              if (r && typeof r === 'object') return r;
          }
      } catch (_) {}

      return null;
  }

  // Двухходовый: если не распарсили — просим LLM починить
  async function parseWithFallback(raw) {
      let parsed = extractJSON(raw);
      if (parsed) return parsed;
      try {
          const fix = await llmChat([
              { role: 'system', content: 'You are a JSON formatter. Return ONLY valid JSON object, no markdown, no text. Start with { end with }.' },
              { role: 'user',   content: 'Fix and return only valid JSON:\n' + raw.slice(0, 4000) },
          ]);
          parsed = extractJSON(fix);
      } catch (_) {}
      return parsed;
  }

  function extractCodeBlock(text) {
      const m = text.match(/```(?:[\w]*)\s*\n?([\s\S]*?)```/);
      return m ? m[1].trim() : null;
  }

  // ═══════════════════════════════════════════════════════════
  // KNOWLEDGE BASE
  // ═══════════════════════════════════════════════════════════
  const TV_KB = `
=== PLATFORM: TradingView Advanced Charts (custom build) ===
window.app              — main app
window.app.widget       — IChartingLibraryWidget
window.app.activedata   — Array<Bar> — ALL bar data (OHLCV source!)

BAR FIELDS: bar.timestamp (ISO→use Math.floor(new Date(bar.timestamp).getTime()/1000))
bar.open / bar.high / bar.low / bar.close / bar.volume  — always parseFloat()

VERIFIED API:
const chart = window.app.widget.activeChart();
chart.createStudy(name, overlay, lock, inputs)
chart.getAllStudies() → [{id,name}]
chart.removeEntity(id) / chart.removeShape(id)
chart.symbol() / chart.resolution()
chart.setVisibleRange({from,to})  — unix seconds

SHAPES (always async + Promise.resolve):
const hasMP = typeof chart.createMultipointShape==='function';
const hasSh = typeof chart.createShape==='function';
const id = await Promise.resolve(
  hasMP ? chart.createMultipointShape([{time:unixSec,price}],opts)
        : chart.createShape([{time:unixSec,price}],opts)
);
opts.shape: 'flag'|'arrow_up'|'arrow_down'|'label_up'|'label_down'|'balloon'|'vertical_line'

CORRECT PATTERN:
(async()=>{
  const chart=window.app.widget.activeChart();
  const bars=window.app.activedata||[];
  const hasMP=typeof chart.createMultipointShape==='function';
  const hasSh=typeof chart.createShape==='function';
  for(const bar of bars){
    const ts=Math.floor(new Date(bar.timestamp).getTime()/1000);
    const price=parseFloat(bar.high);
    await Promise.resolve(hasMP?chart.createMultipointShape([{time:ts,price}],opts):chart.createShape([{time:ts,price}],opts));
  }
})();

FORBIDDEN — NEVER USE:
chart.getOHLCV() ✗  chart.addAnnotations() ✗  chart.getData() ✗
chart.getBars() ✗   chart.getVisibleBars() ✗  chart.toYYYYMMDD() ✗
widget.data() ✗     widget.getBars() ✗
=== END ===`;

  // ═══════════════════════════════════════════════════════════
  // PROMPTS
  // ═══════════════════════════════════════════════════════════
  function buildAnalysisPrompt(codeType) {
      const focus = { js: 'Focus: correct API vs FORBIDDEN list, async patterns, use window.app.activedata.', pine: 'Focus: ta.* functions, inputs, strategy.*, alerts, barstate.*.', pine6: 'Focus: v6 types, method syntax, matrix/map, request.*, v5→v6 changes.' }[codeType] || '';
      return `You are a senior TradingView developer.
${TV_KB}
${focus}

CRITICAL OUTPUT RULES:
- Response = ONLY a raw JSON object. First char={  Last char=}
- NO markdown. NO backticks. NO text before or after JSON.
- Escape newlines as \\n  quotes as \\"
- "suggested_code" = complete improved code as one JSON string
- Language = same as code comments

RETURN EXACTLY:
{"summary":"...","issues":["..."],"recommendations":["..."],"optimizations":["..."],"suggested_code":"// line1\\nconst x=1;"}`;
  }

  function buildRefactorPrompt(codeType, task) {
      const label = { js: 'TradingView JS Charting Library', pine: 'Pine Script v5', pine6: 'Pine Script v6' }[codeType] || 'TradingView';
      return `You are a senior ${label} developer.
${TV_KB}

Task: "${task}"

OUTPUT:
1. Brief explanation (2-4 sentences, plain text)
2. Complete modified code in fenced block:
\`\`\`
[full code]
\`\`\`
NEVER use FORBIDDEN methods. Respond in user's language.`;
  }

  function buildChatPrompt(codeType) {
      const label = { js: 'TradingView JS Charting Library', pine: 'Pine Script v5', pine6: 'Pine Script v6' }[codeType] || 'TradingView';
      return `You are a senior ${label} developer.
${TV_KB}
NEVER use FORBIDDEN methods. Use window.app.activedata for OHLCV. Always async + Promise.resolve() for shapes.
When providing code: wrap in \`\`\` fenced blocks, COMPLETE code only.
Respond in user's language.
Code:
\`\`\`
PLACEHOLDER
\`\`\``;
  }

  // ═══════════════════════════════════════════════════════════
  // OPEN
  // ═══════════════════════════════════════════════════════════
  function openAnalyzer(codeType, mode) {
      const editorEl = document.getElementById(EDITOR_IDS[codeType]);
      const code = editorEl ? editorEl.value.trim() : '';
      if (!code) { showToast('Редактор пустой — нечего анализировать', 'warning'); return; }

      ACA.mode = mode || 'analysis';
      ACA.codeType = codeType;
      ACA.code = code;
      ACA.messages = [];
      ACA.suggestedCode = '';
      ACA.analyzing = false;
      ACA.chatLoading = false;

      if (!document.getElementById('aca-overlay')) { injectCSS(); buildModal(); }

      document.getElementById('aca-badge').textContent = LABELS[codeType] || '';
      document.getElementById('aca-mode-label').textContent = ACA.mode === 'refactor' ? '🔧 Доработка' : '🔍 Анализ кода';

      switchMode(ACA.mode);
      document.getElementById('aca-overlay').style.display = 'flex';
      document.body.style.overflow = 'hidden';
      ACA.open = true;

      if (ACA.mode === 'analysis') startAnalysis();
      else showCurrentCode();
  }

  function switchMode(mode) {
      const av = document.getElementById('aca-analysis-view');
      const rv = document.getElementById('aca-refactor-view');
      if (av) av.style.display = mode === 'analysis' ? 'flex' : 'none';
      if (rv) rv.style.display = mode === 'refactor'  ? 'flex' : 'none';
  }

  // ═══════════════════════════════════════════════════════════
  // ANALYSIS
  // ═══════════════════════════════════════════════════════════
  async function startAnalysis() {
      ACA.analyzing = true; ACA.messages = []; ACA.suggestedCode = '';
      const el = document.getElementById('aca-analysis-section');
      if (el) el.innerHTML = '<div class="aca-loading"><div class="aca-spinner"></div><span>Анализирую код…</span></div>';
      renderSuggestedCode();

      const userMsg = 'Analyze. Return ONLY raw JSON (no markdown, no backticks):\n```\n' + ACA.code + '\n```';
      try {
          const reply = await llmChat([
              { role: 'system', content: buildAnalysisPrompt(ACA.codeType) },
              { role: 'user',   content: userMsg },
          ]);
          ACA.messages = [{ role: 'user', content: userMsg }, { role: 'assistant', content: reply }];

          const parsed = await parseWithFallback(reply);
          if (parsed && (parsed.summary || parsed.issues || parsed.suggested_code)) {
              let code = parsed.suggested_code || '';
              try { code = code.replace(/\\n/g,'\n').replace(/\\t/g,'\t').replace(/\\"/g,'"').replace(/\\\\/g,'\\'); } catch(_){}
              ACA.suggestedCode = code;
              renderAnalysisDone(parsed);
          } else {
              const cb = extractCodeBlock(reply);
              if (cb) ACA.suggestedCode = cb;
              renderAnalysisFallback(reply);
          }
      } catch(err) {
          if (el) el.innerHTML = '<div class="aca-error">❌ ' + escHtml(err.message) + '</div>';
      } finally {
          ACA.analyzing = false; renderSuggestedCode();
      }
  }

  function renderAnalysisDone(d) {
      const el = document.getElementById('aca-analysis-section'); if (!el) return;
      const issues = (d.issues||[]).map(r=>'<li class="aca-issue">⚠ '+escHtml(r)+'</li>').join('');
      const recs   = (d.recommendations||[]).map(r=>'<li class="aca-rec">✓ '+escHtml(r)+'</li>').join('');
      const opts   = (d.optimizations||[]).map(r=>'<li class="aca-opt">⚡ '+escHtml(r)+'</li>').join('');
      el.innerHTML =
          (d.summary?'<div class="aca-summary">'+escHtml(d.summary)+'</div>':'')+
          (issues?'<div class="aca-group"><div class="aca-group-title">⚠️ Проблемы</div><ul>'+issues+'</ul></div>':'')+
          (recs  ?'<div class="aca-group"><div class="aca-group-title">✅ Рекомендации</div><ul>'+recs+'</ul></div>':'')+
          (opts  ?'<div class="aca-group"><div class="aca-group-title">⚡ Оптимизации</div><ul>'+opts+'</ul></div>':'');
  }

  function renderAnalysisFallback(raw) {
      const el = document.getElementById('aca-analysis-section'); if (!el) return;
      el.innerHTML = '<div class="aca-warning">⚠️ Формат ответа не распознан. Нажмите <b>↺ Повторить</b>.</div>' +
          '<details class="aca-raw-details"><summary>Показать сырой ответ</summary><pre class="aca-raw-text">'+escHtml(raw)+'</pre></details>';
  }

  function renderSuggestedCode() {
      const ce = document.getElementById('aca-code-content');
      const ab = document.getElementById('aca-apply-btn');
      const cb = document.getElementById('aca-copy-btn');
      if (!ce) return;
      if (ACA.suggestedCode) {
          ce.textContent = ACA.suggestedCode;
          if (ab) ab.style.display = 'inline-flex';
          if (cb) cb.style.display = 'inline-flex';
      } else {
          ce.textContent = '// Улучшенный код появится здесь после анализа…';
          if (ab) ab.style.display = 'none';
          if (cb) cb.style.display = 'none';
      }
  }

  // ═══════════════════════════════════════════════════════════
  // REFACTOR
  // ═══════════════════════════════════════════════════════════
  function showCurrentCode() {
      const el = document.getElementById('aca-current-code');
      if (el) el.textContent = ACA.code;
      const ti = document.getElementById('aca-refactor-input'); if (ti) ti.value = '';
      const ri = document.getElementById('aca-refactor-result'); if (ri) ri.innerHTML = '<div class="aca-refactor-hint">Опишите что нужно доработать и нажмите кнопку ▶</div>';
      const rc = document.getElementById('aca-refactor-code-content'); if (rc) rc.textContent = '';
      const ra = document.getElementById('aca-refactor-apply-btn'); if (ra) ra.style.display = 'none';
      const pb = document.getElementById('aca-refactor-code-block'); if (pb) pb.style.display = 'none';
  }

  async function runRefactor() {
      const taskEl = document.getElementById('aca-refactor-input');
      const task = taskEl ? taskEl.value.trim() : '';
      if (!task) { showToast('Опишите что нужно доработать', 'warning'); return; }
      if (ACA.analyzing) return;
      ACA.analyzing = true;

      const ri = document.getElementById('aca-refactor-result');
      if (ri) ri.innerHTML = '<div class="aca-loading"><div class="aca-spinner"></div><span>Дорабатываю код…</span></div>';
      const rc = document.getElementById('aca-refactor-code-content'); if (rc) rc.textContent = '';
      const ra = document.getElementById('aca-refactor-apply-btn'); if (ra) ra.style.display = 'none';
      const pb = document.getElementById('aca-refactor-code-block'); if (pb) pb.style.display = 'none';

      try {
          const reply = await llmChat([
              { role: 'system', content: buildRefactorPrompt(ACA.codeType, task) },
              { role: 'user',   content: 'Current code:\n```\n' + ACA.code + '\n```\n\nTask: ' + task },
          ]);

          const codeBlock   = extractCodeBlock(reply);
          const explanation = reply.split('```')[0].trim();

          if (ri) ri.innerHTML = explanation ? '<div class="aca-refactor-explanation">'+formatMsg(explanation)+'</div>' : '';

          if (codeBlock) {
              ACA.suggestedCode = codeBlock;
              if (rc) rc.textContent = codeBlock;
              if (pb) pb.style.display = 'block';
              if (ra) ra.style.display = 'inline-flex';
          } else {
              if (ri) ri.innerHTML += '<div class="aca-warning">⚠️ AI не вернул блок кода. Уточните запрос.</div>';
          }
      } catch(err) {
          if (ri) ri.innerHTML = '<div class="aca-error">❌ '+escHtml(err.message)+'</div>';
      } finally {
          ACA.analyzing = false;
      }
  }

  function applyRefactoredCode() {
      if (!ACA.suggestedCode) return;
      const el = document.getElementById(EDITOR_IDS[ACA.codeType]);
      if (el) { el.value = ACA.suggestedCode; el.dispatchEvent(new Event('input')); }
      showToast('✅ Код применён в редактор', 'success');
      closeModal();
  }

  // ═══════════════════════════════════════════════════════════
  // CHAT
  // ═══════════════════════════════════════════════════════════
  async function sendChatMessage(text) {
      text = (text||'').trim();
      if (!text || ACA.chatLoading) return;
      ACA.chatLoading = true;
      ACA.messages.push({ role: 'user', content: text });
      renderChatMessages(); clearChatInput();

      const sys = buildChatPrompt(ACA.codeType).replace('PLACEHOLDER', ACA.code);
      try {
          const reply = await llmChat([{ role: 'system', content: sys }, ...ACA.messages.slice(2)]);
          ACA.messages.push({ role: 'assistant', content: reply });
          const code = extractCodeBlock(reply);
          if (code) { ACA.suggestedCode = code; renderSuggestedCode(); }
      } catch(err) {
          ACA.messages.push({ role: 'assistant', content: '❌ '+err.message });
      } finally {
          ACA.chatLoading = false; renderChatMessages();
      }
  }

  function renderChatMessages() {
      const el = document.getElementById('aca-chat-messages'); if (!el) return;
      const display = ACA.messages.slice(2);
      if (!display.length && !ACA.chatLoading) {
          el.innerHTML = '<div class="aca-chat-empty"><div class="aca-chat-empty-icon">💬</div><div>Задайте вопрос по коду</div><div class="aca-chat-hint">Ctrl+Enter для отправки</div></div>';
          return;
      }
      el.innerHTML = display.map(m =>
          '<div class="aca-msg aca-msg-'+m.role+'">' +
          '<div class="aca-msg-label">'+(m.role==='user'?'👤 Вы':'🤖 AI')+'</div>' +
          '<div class="aca-msg-content">'+formatMsg(m.content)+'</div></div>'
      ).join('');
      if (ACA.chatLoading) el.innerHTML += '<div class="aca-msg aca-msg-assistant"><div class="aca-msg-label">🤖 AI</div><div class="aca-msg-content"><div class="aca-dots"><span></span><span></span><span></span></div></div></div>';
      el.scrollTop = el.scrollHeight;
  }

  function clearChatInput() { const el = document.getElementById('aca-chat-input'); if (el) el.value = ''; }

  function applyCode() {
      if (!ACA.suggestedCode) return;
      const el = document.getElementById(EDITOR_IDS[ACA.codeType]);
      if (el) { el.value = ACA.suggestedCode; el.dispatchEvent(new Event('input')); }
      showToast('✅ Код применён в редактор', 'success');
      closeModal();
  }

  function closeModal() {
      const o = document.getElementById('aca-overlay'); if (o) o.style.display = 'none';
      document.body.style.overflow = ''; ACA.open = false;
  }

  // ═══════════════════════════════════════════════════════════
  // MODAL
  // ═══════════════════════════════════════════════════════════
  function buildModal() {
      const overlay = document.createElement('div');
      overlay.id = 'aca-overlay';
      overlay.innerHTML = `<div id="aca-modal">
<div id="aca-header">
  <div id="aca-title"><span id="aca-title-icon">🤖</span><span id="aca-mode-label">AI Анализ кода</span><span id="aca-badge"></span></div>
  <div id="aca-header-right"><button class="aca-ghost-btn" id="aca-reanalyze-btn">↺ Повторить</button><button id="aca-close-btn">✕</button></div>
</div>
<div id="aca-analysis-view" style="display:flex;flex:1;overflow:hidden;min-height:0">
  <div id="aca-left">
    <div id="aca-analysis-wrap"><div class="aca-panel-title">📋 Анализ кода</div><div id="aca-analysis-section"></div></div>
    <div id="aca-code-wrap">
      <div class="aca-panel-title"><span>💡 Предложенный код</span>
        <div style="display:flex;gap:8px"><button class="aca-ghost-btn" id="aca-copy-btn" style="display:none">⎘ Копировать</button><button class="aca-apply-btn" id="aca-apply-btn" style="display:none">▶ Применить</button></div>
      </div>
      <pre id="aca-code-block"><code id="aca-code-content"></code></pre>
    </div>
  </div>
  <div id="aca-right">
    <div class="aca-panel-title">💬 Чат с AI</div>
    <div id="aca-chat-messages"></div>
    <div id="aca-chat-footer"><textarea id="aca-chat-input" placeholder="Задайте вопрос по коду…" rows="3"></textarea><button id="aca-send-btn">➤</button></div>
  </div>
</div>
<div id="aca-refactor-view" style="display:none;flex:1;overflow:hidden;min-height:0">
  <div id="aca-refactor-left">
    <div class="aca-panel-title">📄 Текущий код</div>
    <div id="aca-current-code-wrap"><pre id="aca-current-pre"><code id="aca-current-code"></code></pre></div>
  </div>
  <div id="aca-refactor-right">
    <div class="aca-panel-title">🔧 Задание на доработку</div>
    <div id="aca-refactor-task-area">
      <div class="aca-refactor-label">Что нужно доработать / изменить:</div>
      <textarea id="aca-refactor-input" placeholder="Например: добавь обработку ошибок, оптимизируй детектор пиков, выводи флаги на минимумах…" rows="5"></textarea>
      <button id="aca-refactor-run-btn">🔧 Доработать ▶</button>
    </div>
    <div id="aca-refactor-result-wrap">
      <div class="aca-panel-title"><span>💡 Результат доработки</span><button class="aca-apply-btn" id="aca-refactor-apply-btn" style="display:none">▶ Применить</button></div>
      <div id="aca-refactor-result"></div>
      <pre id="aca-refactor-code-block" style="display:none"><code id="aca-refactor-code-content"></code></pre>
    </div>
  </div>
</div>
</div>`;
      document.body.appendChild(overlay);

      overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
      document.getElementById('aca-close-btn').addEventListener('click', closeModal);
      document.getElementById('aca-reanalyze-btn').addEventListener('click', () => {
          if (ACA.mode === 'analysis') { ACA.messages = []; startAnalysis(); } else showCurrentCode();
      });
      document.getElementById('aca-apply-btn').addEventListener('click', applyCode);
      document.getElementById('aca-copy-btn').addEventListener('click', () => {
          if (ACA.suggestedCode) { navigator.clipboard.writeText(ACA.suggestedCode).catch(()=>{}); showToast('Скопировано','success'); }
      });
      document.getElementById('aca-send-btn').addEventListener('click', () => sendChatMessage(document.getElementById('aca-chat-input').value));
      document.getElementById('aca-chat-input').addEventListener('keydown', e => { if ((e.ctrlKey||e.metaKey)&&e.key==='Enter') { e.preventDefault(); sendChatMessage(e.target.value); } });
      document.getElementById('aca-refactor-run-btn').addEventListener('click', runRefactor);
      document.getElementById('aca-refactor-input').addEventListener('keydown', e => { if ((e.ctrlKey||e.metaKey)&&e.key==='Enter') { e.preventDefault(); runRefactor(); } });
      document.getElementById('aca-refactor-apply-btn').addEventListener('click', applyRefactoredCode);
  }

  // ═══════════════════════════════════════════════════════════
  // INJECT BUTTONS
  // ═══════════════════════════════════════════════════════════
  function injectButtons() {
      const configs = [
          { runId:'pineRunBtn',  type:'pine',  aId:'pineAiAnalyzeBtn',  rId:'pineAiRefactorBtn'  },
          { runId:'pine6RunBtn', type:'pine6', aId:'pine6AiAnalyzeBtn', rId:'pine6AiRefactorBtn' },
          { runId:'jsRunBtn',    type:'js',    aId:'jsAiAnalyzeBtn',    rId:'jsAiRefactorBtn'    },
      ];
      const timer = setInterval(() => {
          let done = 0;
          configs.forEach(cfg => {
              if (document.getElementById(cfg.aId)) { done++; return; }
              const runBtn = document.getElementById(cfg.runId); if (!runBtn) return;
              const wrap = document.createElement('div'); wrap.className = 'aca-btn-pair';
              const aBtn = document.createElement('button');
              aBtn.id = cfg.aId; aBtn.className = 'aca-ai-btn aca-ai-btn-analyze';
              aBtn.innerHTML = '<span>🔍</span><span>AI Анализ</span>';
              aBtn.addEventListener('click', () => openAnalyzer(cfg.type, 'analysis'));
              const rBtn = document.createElement('button');
              rBtn.id = cfg.rId; rBtn.className = 'aca-ai-btn aca-ai-btn-refactor';
              rBtn.innerHTML = '<span>🔧</span><span>AI Доработка</span>';
              rBtn.addEventListener('click', () => openAnalyzer(cfg.type, 'refactor'));
              wrap.appendChild(aBtn); wrap.appendChild(rBtn);
              runBtn.parentNode.insertBefore(wrap, runBtn);
              done++;
          });
          if (done === configs.length) clearInterval(timer);
      }, 300);
      setTimeout(() => clearInterval(timer), 15000);
  }

  // ═══════════════════════════════════════════════════════════
  // UTILS + CSS
  // ═══════════════════════════════════════════════════════════
  function escHtml(s) { return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function formatMsg(text) {
      return escHtml(text)
          .replace(/```[\w]*\n?([\s\S]*?)```/g,'<pre class="aca-code-block-inline"><code>$1</code></pre>')
          .replace(/`([^`\n]+)`/g,'<code class="aca-code-tag">$1</code>')
          .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
          .replace(/\n/g,'<br>');
  }
  function showToast(msg,type) {
      let t=document.getElementById('aca-toast');
      if(!t){t=document.createElement('div');t.id='aca-toast';document.body.appendChild(t);}
      t.textContent=msg; t.className='aca-toast aca-toast-'+(type||'info');
      clearTimeout(t._t); t._t=setTimeout(()=>{t.className='aca-toast';},2600);
  }

  function injectCSS() {
      if (document.getElementById('aca-styles')) return;
      const s = document.createElement('style'); s.id='aca-styles';
      s.textContent=`
.aca-btn-pair{display:flex;gap:6px;margin-bottom:6px}
.aca-ai-btn{flex:1;display:flex;align-items:center;justify-content:center;gap:7px;padding:9px 12px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:all .2s;letter-spacing:.2px;border:1px solid transparent}
.aca-ai-btn span:first-child{font-size:15px}
.aca-ai-btn-analyze{background:linear-gradient(135deg,#1a237e,#3949ab);border-color:#3949ab;color:#c5cae9}
.aca-ai-btn-analyze:hover{background:linear-gradient(135deg,#283593,#5c6bc0);border-color:#5c6bc0;color:#fff;box-shadow:0 2px 16px rgba(57,73,171,.5);transform:translateY(-1px)}
.aca-ai-btn-refactor{background:linear-gradient(135deg,#1b3a1b,#2e7d32);border-color:#2e7d32;color:#a5d6a7}
.aca-ai-btn-refactor:hover{background:linear-gradient(135deg,#2e7d32,#43a047);border-color:#43a047;color:#fff;box-shadow:0 2px 16px rgba(46,125,50,.5);transform:translateY(-1px)}
#aca-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,8,.78);z-index:99999;align-items:center;justify-content:center;backdrop-filter:blur(6px)}
#aca-modal{width:min(95vw,1400px);height:min(90vh,900px);background:#10121f;border:1px solid #1e2340;border-radius:16px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 32px 96px rgba(0,0,0,.85);animation:aca-appear .18s ease}
@keyframes aca-appear{from{opacity:0;transform:scale(.97) translateY(8px)}to{opacity:1;transform:none}}
#aca-header{display:flex;align-items:center;justify-content:space-between;padding:13px 20px;background:#13162a;border-bottom:1px solid #1e2340;flex-shrink:0}
#aca-title{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:700;color:#e8eaf6}
#aca-title-icon{font-size:20px}
#aca-badge{font-size:11px;padding:3px 10px;background:#1e2340;border-radius:20px;color:#5c6bc0;font-weight:600}
#aca-header-right{display:flex;align-items:center;gap:8px}
.aca-ghost-btn{background:transparent;border:1px solid #1e2340;color:#5c6bc0;padding:5px 12px;border-radius:6px;font-size:12px;cursor:pointer;transition:all .15s}
.aca-ghost-btn:hover{background:#1e2340;color:#9fa8da}
#aca-close-btn{background:transparent;border:1px solid #1e2340;color:#5c6bc0;width:32px;height:32px;border-radius:8px;font-size:14px;cursor:pointer;transition:all .15s;display:flex;align-items:center;justify-content:center}
#aca-close-btn:hover{background:#c62828;border-color:#c62828;color:#fff}
.aca-panel-title{display:flex;align-items:center;justify-content:space-between;padding:9px 16px;font-size:11px;font-weight:700;color:#3d4f8a;text-transform:uppercase;letter-spacing:.7px;background:#0f1120;border-bottom:1px solid #1a1d30;flex-shrink:0}
/* Analysis view */
#aca-left{flex:1;display:flex;flex-direction:column;overflow:hidden;border-right:1px solid #1e2340;min-width:0}
#aca-analysis-wrap{flex:0 0 auto;max-height:42%;overflow-y:auto;border-bottom:1px solid #1e2340}
#aca-analysis-section{padding:14px 16px;display:flex;flex-direction:column;gap:12px}
.aca-summary{font-size:13px;color:#9fa8da;line-height:1.6;padding:10px 14px;background:#13172a;border-left:3px solid #3949ab;border-radius:0 6px 6px 0}
.aca-group{display:flex;flex-direction:column;gap:5px}
.aca-group-title{font-size:11px;font-weight:700;color:#3d4f8a;text-transform:uppercase;letter-spacing:.5px}
.aca-group ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}
.aca-group li{font-size:13px;color:#9fa8da;line-height:1.45;padding:6px 10px;border-radius:5px}
.aca-issue{color:#ff8a65!important;background:#1a1208!important;border-left:2px solid #e64a19}
.aca-rec{color:#a5d6a7!important;background:#0d1a0e!important;border-left:2px solid #388e3c}
.aca-opt{color:#fff176!important;background:#1a1a0d!important;border-left:2px solid #f9a825}
#aca-code-wrap{flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0}
#aca-code-block{flex:1;margin:0;overflow:auto;background:#0d0f1a;padding:16px 20px}
#aca-code-content{display:block;font-family:'JetBrains Mono','Fira Code',monospace;font-size:12.5px;color:#82b1ff;white-space:pre;line-height:1.65}
#aca-right{width:360px;flex-shrink:0;display:flex;flex-direction:column;overflow:hidden;min-height:0}
#aca-chat-messages{flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:10px;min-height:0}
.aca-chat-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;color:#2a3060;font-size:13px;text-align:center;gap:6px;padding:40px 20px}
.aca-chat-empty-icon{font-size:32px;margin-bottom:4px}
.aca-chat-hint{font-size:11px;color:#1e2340;margin-top:4px}
.aca-msg{display:flex;flex-direction:column;gap:3px}
.aca-msg-label{font-size:11px;font-weight:700}
.aca-msg-user .aca-msg-label{color:#3949ab}
.aca-msg-assistant .aca-msg-label{color:#2e7d32}
.aca-msg-content{background:#13172a;border-radius:8px;padding:10px 12px;font-size:13px;color:#9fa8da;line-height:1.55;word-break:break-word}
.aca-msg-user .aca-msg-content{background:#1a1f3a}
.aca-code-block-inline{background:#0d0f1a;border-radius:6px;padding:10px 12px;overflow-x:auto;margin:6px 0;font-size:12px;color:#82b1ff;white-space:pre;font-family:monospace}
.aca-code-tag{background:#0d0f1a;border-radius:3px;padding:1px 5px;font-size:12px;color:#82b1ff;font-family:monospace}
#aca-chat-footer{display:flex;gap:8px;padding:12px;border-top:1px solid #1e2340;background:#0f1120;flex-shrink:0}
#aca-chat-input{flex:1;background:#13172a;border:1px solid #1e2340;color:#c5cae9;border-radius:8px;padding:9px 12px;font-size:13px;resize:none;font-family:inherit;outline:none;transition:border-color .15s;line-height:1.45}
#aca-chat-input:focus{border-color:#3949ab}
#aca-chat-input::placeholder{color:#2a3060}
#aca-send-btn{background:#3949ab;color:#fff;border:none;border-radius:8px;width:42px;font-size:16px;cursor:pointer;transition:background .15s;flex-shrink:0}
#aca-send-btn:hover{background:#5c6bc0}
/* Refactor view */
#aca-refactor-left{flex:1;display:flex;flex-direction:column;overflow:hidden;border-right:1px solid #1e2340;min-width:0}
#aca-current-code-wrap{flex:1;overflow:auto;background:#0d0f1a}
#aca-current-pre{margin:0;padding:16px 20px;min-height:100%}
#aca-current-code{display:block;font-family:'JetBrains Mono','Fira Code',monospace;font-size:12px;color:#546e7a;white-space:pre;line-height:1.65}
#aca-refactor-right{width:440px;flex-shrink:0;display:flex;flex-direction:column;overflow:hidden;min-height:0;background:#0f1120}
#aca-refactor-task-area{padding:14px;border-bottom:1px solid #1e2340;flex-shrink:0}
.aca-refactor-label{font-size:12px;font-weight:600;color:#5c6bc0;margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px}
#aca-refactor-input{width:100%;box-sizing:border-box;background:#13172a;border:1px solid #1e2340;color:#c5cae9;border-radius:8px;padding:10px 12px;font-size:13px;resize:none;font-family:inherit;outline:none;transition:border-color .15s;line-height:1.5}
#aca-refactor-input:focus{border-color:#2e7d32}
#aca-refactor-input::placeholder{color:#2a3060}
#aca-refactor-run-btn{width:100%;margin-top:10px;padding:10px;background:linear-gradient(135deg,#1b3a1b,#2e7d32);border:1px solid #388e3c;color:#a5d6a7;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;transition:all .2s}
#aca-refactor-run-btn:hover{background:linear-gradient(135deg,#2e7d32,#43a047);color:#fff;box-shadow:0 2px 14px rgba(46,125,50,.45)}
#aca-refactor-result-wrap{flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0}
#aca-refactor-result{padding:14px 16px;font-size:13px;color:#9fa8da;line-height:1.6;overflow-y:auto;flex-shrink:0;max-height:38%}
.aca-refactor-hint{color:#2a3060;text-align:center;padding:20px 0;font-size:13px}
.aca-refactor-explanation{color:#9fa8da;line-height:1.6}
#aca-refactor-code-block{flex:1;margin:0;overflow:auto;background:#0d0f1a;padding:16px 20px;border-top:1px solid #1e2340}
#aca-refactor-code-content{display:block;font-family:'JetBrains Mono','Fira Code',monospace;font-size:12.5px;color:#82b1ff;white-space:pre;line-height:1.65}
/* Shared */
.aca-apply-btn{background:#1b5e20;border:1px solid #2e7d32;color:#a5d6a7;padding:5px 14px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;gap:5px}
.aca-apply-btn:hover{background:#2e7d32;color:#fff}
.aca-warning{font-size:13px;color:#ffb74d;background:rgba(255,152,0,.08);border:1px solid rgba(255,152,0,.2);border-radius:8px;padding:10px 14px;line-height:1.5}
.aca-raw-details{margin-top:8px}
.aca-raw-details summary{font-size:12px;color:#4a5280;cursor:pointer;padding:4px 0}
.aca-raw-text{font-size:11px;color:#4a5280;white-space:pre-wrap;word-break:break-all;max-height:160px;overflow-y:auto;background:#0d0f1a;border-radius:6px;padding:10px;margin-top:6px}
.aca-loading{display:flex;align-items:center;gap:12px;padding:20px 16px;color:#3d4f8a;font-size:13px}
.aca-spinner{width:18px;height:18px;border:2px solid #1e2340;border-top-color:#3949ab;border-radius:50%;animation:aca-spin .7s linear infinite;flex-shrink:0}
@keyframes aca-spin{to{transform:rotate(360deg)}}
.aca-error{padding:16px;color:#ef9a9a;font-size:13px}
.aca-dots{display:flex;gap:5px;padding:3px 0}
.aca-dots span{width:6px;height:6px;border-radius:50%;background:#3949ab;animation:aca-dot 1.1s infinite}
.aca-dots span:nth-child(2){animation-delay:.18s}
.aca-dots span:nth-child(3){animation-delay:.36s}
@keyframes aca-dot{0%,80%,100%{opacity:.15;transform:scale(.7)}40%{opacity:1;transform:scale(1)}}
#aca-toast{position:fixed;bottom:32px;left:50%;transform:translateX(-50%) translateY(10px);background:#13172a;border:1px solid #1e2340;color:#9fa8da;padding:10px 24px;border-radius:8px;font-size:13px;pointer-events:none;z-index:100001;opacity:0;transition:opacity .2s,transform .2s}
.aca-toast-success{border-color:#2e7d32!important;color:#a5d6a7!important;opacity:1!important;transform:translateX(-50%) translateY(0)!important}
.aca-toast-warning{border-color:#e65100!important;color:#ffb74d!important;opacity:1!important;transform:translateX(-50%) translateY(0)!important}
#aca-analysis-wrap::-webkit-scrollbar,#aca-code-block::-webkit-scrollbar,#aca-chat-messages::-webkit-scrollbar,
#aca-current-code-wrap::-webkit-scrollbar,#aca-refactor-code-block::-webkit-scrollbar,#aca-refactor-result::-webkit-scrollbar{width:4px}
#aca-analysis-wrap::-webkit-scrollbar-thumb,#aca-code-block::-webkit-scrollbar-thumb,#aca-chat-messages::-webkit-scrollbar-thumb,
#aca-current-code-wrap::-webkit-scrollbar-thumb,#aca-refactor-code-block::-webkit-scrollbar-thumb,#aca-refactor-result::-webkit-scrollbar-thumb{background:#1e2340;border-radius:2px}
@media(max-width:900px){#aca-modal{width:99vw;height:98vh;border-radius:8px}#aca-right,#aca-refactor-right{width:260px}}`;
      document.head.appendChild(s);
  }

  window.AICodeAnalyzer = { open: openAnalyzer, close: closeModal };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectButtons);
  else injectButtons();
})();