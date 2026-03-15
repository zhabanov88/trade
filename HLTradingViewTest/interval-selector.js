class IntervalSelector {
    constructor() {
        this.currentInterval  = null;
        this.intervals        = {};
        this.widget           = null;
        this._ivSeconds       = 60;
        this._pollTimer       = null;
        this._lastRenderedTs  = null;

        // ── Настройки отображаемых полей ──────────────────────────────────
        // Каждый элемент: { key, label, color, decimals }
        this._displayFields   = [];
        this._defaultFields   = [
            { key: 'open',  label: 'Open',  color: null,      decimals: 5 },
            { key: 'close', label: 'Close', color: null,      decimals: 5 },
            { key: '#',     label: '#',     color: '#787b86', decimals: 0 },
            { key: 'atr',   label: 'ATR',   color: '#f5a623', decimals: 5 },
        ];

        // ── Фильтр дат ────────────────────────────────────────────────────
        this._dateFrom  = null;  // Date | null
        this._dateTo    = null;  // Date | null
        this._availDays = new Set(); // 'YYYY-MM-DD' строки из activedata

        // ── Ключ настроек в localStorage ─────────────────────────────────
        this._LS_KEY = 'isp_settings_v1';
    }

    // ─────────────────────────────────────────────────────────────────────
    // INIT
    // ─────────────────────────────────────────────────────────────────────

    async init(widget) {
        this.widget = widget;
        await this._loadIntervals();
        this._loadSettings();          // читаем сохранённые настройки
        this._buildDOM();
        this._injectCSS();
        this._buildFieldsBar();        // строим поля на основе настроек

        if (!this.widget?.activeChart) return;
        const chart = this.widget.activeChart();

        try {
            this.currentInterval = chart.resolution();
            this._ivSeconds      = this._res2sec(this.currentInterval);
            this._markActive();
        } catch(_) {}

        chart.onIntervalChanged().subscribe(null, (iv) => {
            this.currentInterval = iv;
            this._ivSeconds      = this._res2sec(iv);
            this._markActive();
            this._resetInfo();
        });

        this._hookCrosshair(chart);
        this._startPoll();

        // После первой загрузки данных — обновляем доступные даты
        this._scheduleAvailDaysUpdate();

        console.log('✓ IntervalSelector initialized');
    }

    // ─────────────────────────────────────────────────────────────────────
    // SETTINGS PERSISTENCE
    // ─────────────────────────────────────────────────────────────────────

    _settingsKey() {
        // Привязываем к layoutId если он есть в сессии
        try {
            const session = JSON.parse(localStorage.getItem('tv_session') || '{}');
            if (session.layoutId) return `${this._LS_KEY}_layout_${session.layoutId}`;
        } catch(_) {}
        return this._LS_KEY;
    }

    _loadSettings() {
        try {
            const raw = localStorage.getItem(this._settingsKey());
            if (!raw) {
                this._displayFields = JSON.parse(JSON.stringify(this._defaultFields));
                return;
            }
            const s = JSON.parse(raw);
            this._displayFields = Array.isArray(s.fields) && s.fields.length
                ? s.fields
                : JSON.parse(JSON.stringify(this._defaultFields));

            // Даты не восстанавливаем — они будут выбраны из последнего периода
        } catch(_) {
            this._displayFields = JSON.parse(JSON.stringify(this._defaultFields));
        }
    }

    _saveSettings() {
        try {
            const s = { fields: this._displayFields };
            localStorage.setItem(this._settingsKey(), JSON.stringify(s));

            // При смене layout — обновляем ключ (layout-state-sync может вызвать этот метод)
            console.log('[ISP] Settings saved');
        } catch(e) {
            console.warn('[ISP] Could not save settings:', e);
        }
    }

    // Вызывается из layout-manager при загрузке layout чтобы применить нужный ключ
    onLayoutChanged() {
        this._loadSettings();
        this._buildFieldsBar();
    }

    // ─────────────────────────────────────────────────────────────────────
    // INTERVALS
    // ─────────────────────────────────────────────────────────────────────

    async _loadIntervals() {
        try {
            const res  = await fetch('/api/intervals', { credentials: 'include' });
            const list = await res.json();
            this.intervals = { ticks: [], minutes: [], hours: [], days: [] };
            list.filter(i => i.is_active).forEach(i => {
                const c = i.tradingview_code;
                if      (c.includes('T') || c.includes('t'))                    this.intervals.ticks.push(c);
                else if (['1','2','3','5','15','30'].includes(c))                this.intervals.minutes.push(c);
                else if (['60','120','180','240'].includes(c))                   this.intervals.hours.push(c);
                else if (c.includes('D') || c.includes('W') || c.includes('M')) this.intervals.days.push(c);
            });
        } catch(_) {
            this.intervals = {
                ticks:   ['1T'],
                minutes: ['1','3','5','15','30'],
                hours:   ['60','240'],
                days:    ['1D','1W']
            };
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // DOM — главная панель
    // ─────────────────────────────────────────────────────────────────────

    _buildDOM() {
        const container = document.getElementById('tv_chart_container');
        if (!container) return;

        document.querySelector('.interval-selector-panel')?.remove();

        const names = {
            '1T':'1T','1':'1m','2':'2m','3':'3m','5':'5m','15':'15m',
            '30':'30m','60':'1h','120':'2h','180':'3h','240':'4h',
            '1D':'1D','1W':'1W','1M':'1M'
        };

        const btns = [...(this.intervals.ticks||[]),
                      ...(this.intervals.minutes||[]),
                      ...(this.intervals.hours||[]),
                      ...(this.intervals.days||[])]
            .map(c => `<button class="isb" data-iv="${c}">${names[c]||c}</button>`)
            .join('');

        const panel = document.createElement('div');
        panel.className = 'interval-selector-panel';
        panel.innerHTML = `
            <div class="isb-group">${btns}</div>
            <div class="isp-sep-v"></div>

            <!-- ── Date range picker ── -->
            <div class="isp-daterange" id="isp-daterange">
                <button class="isp-drp-btn" id="isp-drp-toggle" title="Выбрать диапазон дат">
                    <span class="isp-drp-icon">📅</span>
                    <span id="isp-drp-label">Все даты</span>
                    <span class="isp-drp-arrow">▾</span>
                </button>
                <div class="isp-drp-popup" id="isp-drp-popup">
                    <div class="isp-drp-header">Диапазон дат</div>
                    <div class="isp-drp-row">
                        <label>От</label>
                        <input type="date" id="isp-date-from" class="isp-date-input">
                    </div>
                    <div class="isp-drp-row">
                        <label>До</label>
                        <input type="date" id="isp-date-to" class="isp-date-input">
                    </div>
                    <div class="isp-drp-btns">
                        <button class="isp-drp-apply" id="isp-drp-apply">Применить</button>
                        <button class="isp-drp-reset" id="isp-drp-reset">Сбросить</button>
                    </div>
                    <div class="isp-drp-hint" id="isp-drp-hint"></div>
                </div>
            </div>

            <div class="isp-sep-v"></div>

            <!-- ── Info fields ── -->
            <div class="isp-info" id="isp-info"></div>

            <!-- ── Fields config button ── -->
            <button class="isp-cfg-btn" id="isp-cfg-btn" title="Настроить поля">⚙</button>

            <!-- ── Fields config popup ── -->
            <div class="isp-cfg-popup" id="isp-cfg-popup" style="display:none"></div>
        `;

        container.parentNode.insertBefore(panel, container);

        // Interval buttons
        panel.querySelectorAll('.isb').forEach(b => {
            b.addEventListener('click', () => this._setInterval(b.dataset.iv));
        });

        // Date range
        this._bindDateRange();

        // Config button
        document.getElementById('isp-cfg-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleCfgPopup();
        });

        // Close popups on outside click
        document.addEventListener('click', (e) => {
            if (!e.target.closest('#isp-drp-popup') && !e.target.closest('#isp-drp-toggle')) {
                document.getElementById('isp-drp-popup')?.classList.remove('open');
            }
            if (!e.target.closest('#isp-cfg-popup') && !e.target.closest('#isp-cfg-btn')) {
                document.getElementById('isp-cfg-popup').style.display = 'none';
            }
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    // FIELDS BAR (динамическая зона info)
    // ─────────────────────────────────────────────────────────────────────

    _buildFieldsBar() {
        const info = document.getElementById('isp-info');
        if (!info) return;

        info.innerHTML = this._displayFields.map((f, i) => {
            const colorStyle = f.color ? `style="color:${f.color}"` : '';
            return `${i > 0 ? '<span class="isp-sep-v isp-sep-sm"></span>' : ''}
                <span class="isp-field">
                    <span class="isp-k">${this._esc(f.label)}</span>
                    <span class="isp-v isp-fv" id="isp-fv-${this._esc(f.key)}" ${colorStyle}>—</span>
                </span>`;
        }).join('');

        this._resetInfo();
    }

    // ─────────────────────────────────────────────────────────────────────
    // CONFIG POPUP (настройка полей)
    // ─────────────────────────────────────────────────────────────────────

    _toggleCfgPopup() {
        const popup = document.getElementById('isp-cfg-popup');
        const isOpen = popup.style.display !== 'none';
        if (isOpen) {
            popup.style.display = 'none';
        } else {
            this._renderCfgPopup();
            popup.style.display = 'block';
        }
    }

    _getAvailableFieldKeys() {
        const data = window.app?.activedata;
        if (!data?.length) return ['open','high','low','close','volume','atr'];
        const sample = data[data.length - 1];
        // '#' — виртуальное поле (номер бара), всегда доступно
        return ['#', ...Object.keys(sample).filter(k => k !== 'timestamp' && k !== 'time')];
    }

    _renderCfgPopup() {
        const popup = document.getElementById('isp-cfg-popup');
        const allKeys = this._getAvailableFieldKeys();

        const activeKeys = new Set(this._displayFields.map(f => f.key));

        const rows = this._displayFields.map((f, i) => `
            <div class="isp-cfg-row" data-idx="${i}">
                <span class="isp-cfg-drag" title="Перетащить">⠿</span>
                <input class="isp-cfg-label" type="text" value="${this._esc(f.label)}" data-idx="${i}" placeholder="Метка">
                <select class="isp-cfg-key" data-idx="${i}">
                    ${allKeys.map(k => `<option value="${k}" ${k===f.key?'selected':''}>${k}</option>`).join('')}
                </select>
                <input class="isp-cfg-color" type="color" value="${f.color||'#d1d4dc'}" data-idx="${i}" title="Цвет">
                <input class="isp-cfg-dec" type="number" min="0" max="10" value="${f.decimals??5}" data-idx="${i}" title="Знаков" style="width:40px">
                <button class="isp-cfg-del" data-idx="${i}" title="Удалить">✕</button>
            </div>
        `).join('');

        popup.innerHTML = `
            <div class="isp-cfg-title">Настройка полей панели</div>
            <div class="isp-cfg-list" id="isp-cfg-list">${rows}</div>
            <div class="isp-cfg-add-row">
                <select id="isp-cfg-add-key">
                    ${allKeys.map(k => `<option value="${k}">${k}</option>`).join('')}
                </select>
                <button id="isp-cfg-add-btn">+ Добавить поле</button>
            </div>
            <div class="isp-cfg-actions">
                <button id="isp-cfg-save">💾 Сохранить</button>
                <button id="isp-cfg-reset-def">↺ По умолчанию</button>
            </div>
        `;

        // Bind events
        popup.querySelectorAll('.isp-cfg-del').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.idx);
                this._displayFields.splice(idx, 1);
                this._saveSettings();      // ← сохранить
                this._buildFieldsBar();    // ← обновить панель сразу
                this._renderCfgPopup();
            });
        });

        document.getElementById('isp-cfg-add-btn').addEventListener('click', () => {
            const key = document.getElementById('isp-cfg-add-key').value;
            this._displayFields.push({ key, label: key, color: null, decimals: 5 });
            this._saveSettings();      // ← сохранить в localStorage сразу
            this._buildFieldsBar();    // ← показать в #isp-info сразу
            this._renderCfgPopup();    // ← обновить список в попапе
        });

        document.getElementById('isp-cfg-save').addEventListener('click', () => {
            // Собираем изменения из полей
            const rows2 = popup.querySelectorAll('.isp-cfg-row');
            const newFields = [];
            rows2.forEach(row => {
                const idx = parseInt(row.dataset.idx);
                const key   = row.querySelector('.isp-cfg-key').value;
                const label = row.querySelector('.isp-cfg-label').value || key;
                const color = row.querySelector('.isp-cfg-color').value;
                const dec   = parseInt(row.querySelector('.isp-cfg-dec').value) || 5;
                newFields.push({
                    key,
                    label,
                    color: (color === '#d1d4dc' ? null : color),
                    decimals: dec
                });
            });
            this._displayFields = newFields;
            this._saveSettings();
            this._buildFieldsBar();
            popup.style.display = 'none';
        });

        document.getElementById('isp-cfg-reset-def').addEventListener('click', () => {
            this._displayFields = JSON.parse(JSON.stringify(this._defaultFields));
            this._renderCfgPopup();
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    // DATE RANGE PICKER
    // ─────────────────────────────────────────────────────────────────────

    _bindDateRange() {
        const toggle = document.getElementById('isp-drp-toggle');
        const popup  = document.getElementById('isp-drp-popup');

        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = popup.classList.contains('open');
            if (!isOpen) {
                this._updateAvailDays();
                this._updateDateInputsState();
            }
            popup.classList.toggle('open');
        });

        document.getElementById('isp-drp-apply').addEventListener('click', () => {
            const fromVal = document.getElementById('isp-date-from').value;
            const toVal   = document.getElementById('isp-date-to').value;
            this._dateFrom = fromVal ? new Date(fromVal + 'T00:00:00Z') : null;
            this._dateTo   = toVal   ? new Date(toVal   + 'T23:59:59Z') : null;
            this._updateDrpLabel();
            this._applyDateFilter();
            popup.classList.remove('open');
        });

        document.getElementById('isp-drp-reset').addEventListener('click', () => {
            this._dateFrom = null;
            this._dateTo   = null;
            document.getElementById('isp-date-from').value = '';
            document.getElementById('isp-date-to').value   = '';
            this._updateDrpLabel();
            this._applyDateFilter();
            popup.classList.remove('open');
        });

        // Валидация: disable недоступных дат через CSS + атрибуты min/max
        document.getElementById('isp-date-from').addEventListener('change', () => {
            this._validateDateInputs();
        });
        document.getElementById('isp-date-to').addEventListener('change', () => {
            this._validateDateInputs();
        });
    }

    _scheduleAvailDaysUpdate() {
        // Ждём пока загрузятся данные и обновляем доступные даты
        const tryUpdate = (attempts = 0) => {
            const data = window.app?.activedata;
            if (data?.length) {
                this._updateAvailDays();
                this._setDefaultDateRange();
            } else if (attempts < 20) {
                setTimeout(() => tryUpdate(attempts + 1), 500);
            }
        };
        setTimeout(() => tryUpdate(), 1000);
    }

    _updateAvailDays() {
        const data = window.app?.activedata;
        if (!data?.length) return;
        this._availDays = new Set();
        data.forEach(bar => {
            const d = bar.timestamp ? bar.timestamp.slice(0, 10) : null;
            if (d) this._availDays.add(d);
        });
    }

    _setDefaultDateRange() {
        // По умолчанию — последний период (последние доступные даты)
        if (!this._dateFrom && !this._dateTo && this._availDays.size > 0) {
            const sorted = Array.from(this._availDays).sort();
            const lastDay = sorted[sorted.length - 1];
            const data = window.app?.activedata;

            // Определяем разумный диапазон по умолчанию: последние 30 дней из доступных
            const daysArr = sorted;
            const fromDay = daysArr.length > 30 ? daysArr[daysArr.length - 30] : daysArr[0];

            this._dateFrom = new Date(fromDay + 'T00:00:00Z');
            this._dateTo   = new Date(lastDay + 'T23:59:59Z');
            this._updateDrpLabel();
            // НЕ применяем фильтр сразу при инициализации — только обновляем UI
            document.getElementById('isp-date-from').value = fromDay;
            document.getElementById('isp-date-to').value   = lastDay;
        }
    }

    _updateDateInputsState() {
        if (!this._availDays.size) return;

        const sorted = Array.from(this._availDays).sort();
        const minDay = sorted[0];
        const maxDay = sorted[sorted.length - 1];

        const fromInput = document.getElementById('isp-date-from');
        const toInput   = document.getElementById('isp-date-to');

        fromInput.min = minDay;
        fromInput.max = maxDay;
        toInput.min   = minDay;
        toInput.max   = maxDay;

        // Добавляем подсказку о доступных датах
        const hint = document.getElementById('isp-drp-hint');
        if (hint) {
            hint.textContent = `Доступно: ${minDay} → ${maxDay} (${this._availDays.size} дней)`;
        }

        // Устанавливаем custom валидатор для блокировки недоступных дат
        // (нативно браузер не поддерживает произвольные disabled dates в <input type=date>,
        //  но мы валидируем при apply)
    }

    _validateDateInputs() {
        const fromVal = document.getElementById('isp-date-from').value;
        const toVal   = document.getElementById('isp-date-to').value;
        const hint    = document.getElementById('isp-drp-hint');

        let msg = '';
        if (fromVal && !this._availDays.has(fromVal)) {
            // Найдём ближайшую доступную дату
            const nearest = this._nearestAvailDay(fromVal);
            msg += `Дата "от" ${fromVal} не найдена в базе. Ближайшая: ${nearest}. `;
        }
        if (toVal && !this._availDays.has(toVal)) {
            const nearest = this._nearestAvailDay(toVal);
            msg += `Дата "до" ${toVal} не найдена в базе. Ближайшая: ${nearest}.`;
        }
        if (fromVal && toVal && fromVal > toVal) {
            msg = 'Дата "от" не может быть позже даты "до".';
        }

        if (hint) hint.textContent = msg || (this._availDays.size
            ? `Доступно: ${Array.from(this._availDays).sort()[0]} → ${Array.from(this._availDays).sort().pop()} (${this._availDays.size} дней)`
            : '');

        const applyBtn = document.getElementById('isp-drp-apply');
        if (applyBtn) applyBtn.disabled = !!msg && msg.includes('не может');
    }

    _nearestAvailDay(dateStr) {
        const sorted = Array.from(this._availDays).sort();
        // Найти ближайшую дату >= dateStr
        const after = sorted.find(d => d >= dateStr);
        if (after) return after;
        // или <= dateStr
        return sorted.filter(d => d <= dateStr).pop() || sorted[0];
    }

    _updateDrpLabel() {
        const label = document.getElementById('isp-drp-label');
        if (!label) return;
        if (!this._dateFrom && !this._dateTo) {
            label.textContent = 'Все даты';
        } else {
            const f = this._dateFrom ? this._dateFrom.toISOString().slice(0,10) : '...';
            const t = this._dateTo   ? this._dateTo.toISOString().slice(0,10)   : '...';
            label.textContent = `${f} → ${t}`;
        }
    }

    _applyDateFilter() {
        // Скроллим/фильтруем график TradingView по диапазону дат
        if (!this.widget?.activeChart) return;
        try {
            const chart = this.widget.activeChart();
            if (this._dateFrom && this._dateTo) {
                const fromSec = Math.floor(this._dateFrom.getTime() / 1000);
                const toSec   = Math.floor(this._dateTo.getTime()   / 1000);
                chart.setVisibleRange({ from: fromSec, to: toSec });
            } else {
                // Сброс — показать все данные
                chart.resetData?.();
            }
        } catch(e) {
            console.warn('[ISP] setVisibleRange error:', e);
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // MARK ACTIVE INTERVAL
    // ─────────────────────────────────────────────────────────────────────

    _markActive() {
        document.querySelectorAll('.isb').forEach(b => {
            b.classList.toggle('active', b.dataset.iv === this.currentInterval);
        });
    }

    updateActiveButton() { this._markActive(); }

    _setInterval(iv) {
        if (!this.widget?.activeChart) return;
        try {
            this.widget.activeChart().setResolution(iv);
            this.currentInterval = iv;
            this._ivSeconds      = this._res2sec(iv);
            this._markActive();
            localStorage.setItem('tradingview_interval', iv);
        } catch(e) { console.error(e); }
    }

    // ─────────────────────────────────────────────────────────────────────
    // CROSSHAIR → BAR INFO
    // ─────────────────────────────────────────────────────────────────────

    _hookCrosshair(chart) {
        try {
            if (typeof chart.crossHairMoved === 'function') {
                chart.crossHairMoved().subscribe(null, ({ time }) => {
                    if (time) this._renderBar(time * 1000);
                });
                return;
            }
        } catch(_) {}
        try {
            if (typeof chart.crosshairMoved === 'function') {
                chart.crosshairMoved().subscribe(null, ({ time }) => {
                    if (time) this._renderBar(time * 1000);
                });
                return;
            }
        } catch(_) {}
        console.warn('[BarInfo] crosshair API not available — using polling only');
    }

    // ─────────────────────────────────────────────────────────────────────
    // POLLING
    // ─────────────────────────────────────────────────────────────────────

    _startPoll() {
        if (this._pollTimer) clearInterval(this._pollTimer);
        this._pollTimer = setInterval(() => {
            const data = window.app?.activedata;
            if (!data?.length) return;
            const last = data[data.length - 1];
            const tsMs = new Date(last.timestamp).getTime();
            if (tsMs !== this._lastRenderedTs) {
                this._renderBar(tsMs, true);
            }
            // Обновляем доступные даты каждые ~10 циклов (20 сек)
            if (Math.random() < 0.1) this._updateAvailDays();
        }, 2000);
    }

    // ─────────────────────────────────────────────────────────────────────
    // RENDER BAR INFO
    // ─────────────────────────────────────────────────────────────────────

    _renderBar(tsMs, isCurrent = false) {
        const data = window.app?.activedata;
        if (!data?.length) return;

        const idx = this._findBar(data, tsMs);
        if (idx === -1) return;

        const bar    = data[idx];
        const openMs = new Date(bar.timestamp).getTime();

        if (openMs === this._lastRenderedTs && !isCurrent) return;
        this._lastRenderedTs = openMs;

        // Обновляем каждое настроенное поле
        this._displayFields.forEach(f => {
            const el = document.getElementById(`isp-fv-${f.key}`);
            if (!el) return;

            // Виртуальное поле — номер бара (индекс)
            if (f.key === '#') {
                el.textContent = String(idx + 1);
                el.style.opacity = '';
                if (f.color) el.style.color = f.color;
                return;
            }

            const val = bar[f.key];
            if (val == null || val === '') {
                el.textContent = 'n/a';
                el.style.opacity = '0.4';
            } else {
                const num = parseFloat(val);
                el.textContent = isNaN(num) ? String(val) : num.toFixed(f.decimals ?? 5);
                el.style.opacity = '';
                if (f.color) el.style.color = f.color;
            }
        });

        document.querySelector('.isp-info')?.classList.toggle('isp-current', isCurrent);
    }

    _findBar(data, targetMs) {
        let lo = 0, hi = data.length - 1;
        while (lo <= hi) {
            const m  = (lo + hi) >> 1;
            const bm = new Date(data[m].timestamp).getTime();
            if (bm === targetMs) return m;
            bm < targetMs ? (lo = m + 1) : (hi = m - 1);
        }
        const c = lo - 1;
        if (c >= 0) {
            const bm  = new Date(data[c].timestamp).getTime();
            const end = bm + this._ivSeconds * 1000;
            if (targetMs >= bm && targetMs < end) return c;
        }
        return -1;
    }

    _resetInfo() {
        this._lastRenderedTs = null;
        this._displayFields.forEach(f => {
            const el = document.getElementById(`isp-fv-${f.key}`);
            if (el) { el.textContent = '—'; el.style.opacity = ''; }
        });
        document.querySelector('.isp-info')?.classList.remove('isp-current');
    }

    // ─────────────────────────────────────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────────────────────────────────────

    _esc(s) {
        return String(s||'').replace(/[&<>"']/g, c =>
            ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    _fmt(ms) {
        const d = new Date(ms);
        const p = n => String(n).padStart(2,'0');
        return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} `
             + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
    }

    _res2sec(r) {
        return ({
            '1T':1,'1t':1,
            '1':60,'2':120,'3':180,'5':300,'15':900,'30':1800,
            '60':3600,'120':7200,'180':10800,'240':14400,
            '1D':86400,'1W':604800,'1M':2592000
        })[r] || 60;
    }

    // ─────────────────────────────────────────────────────────────────────
    // CSS
    // ─────────────────────────────────────────────────────────────────────

    _injectCSS() {
        if (document.getElementById('isp-css')) return;
        const s = document.createElement('style');
        s.id = 'isp-css';
        s.textContent = `
/* ── Панель ──────────────────────────────────────────────── */
.interval-selector-panel {
    display: flex;
    align-items: center;
    height: 34px;
    min-height: 34px;
    padding: 0 8px;
    gap: 0;
    background: var(--bg-primary, #131722);
    border-bottom: 1px solid #2a2e39;
    overflow: visible;
    flex-shrink: 0;
    box-sizing: border-box;
    position: relative;
    z-index: 100;
}

/* ── Кнопки интервалов ────────────────────────────────────── */
.isb-group { display:flex; align-items:center; gap:1px; flex-shrink:0; }
.isb {
    padding: 3px 8px;
    background: transparent;
    border: none;
    color: #787b86;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    border-radius: 3px;
    white-space: nowrap;
    transition: background .12s, color .12s;
}
.isb:hover  { background:#2a2e39; color:#d1d4dc; }
.isb.active { background:#9fb4ee; color:#fff; }
.isb.active:hover { background:#1e4fcc; }

/* ── Разделитель ──────────────────────────────────────────── */
.isp-sep-v {
    width:1px; height:18px;
    background:#2a2e39;
    margin:0 10px;
    flex-shrink:0;
}
.isp-sep-sm { height:13px; margin:0 8px; }

/* ── Date range picker ────────────────────────────────────── */
.isp-daterange { position:relative; flex-shrink:0; }
.isp-drp-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    background: transparent;
    border: 1px solid #2a2e39;
    border-radius: 4px;
    color: #787b86;
    font-size: 11px;
    cursor: pointer;
    white-space: nowrap;
    transition: background .12s, color .12s, border-color .12s;
}
.isp-drp-btn:hover { background:#2a2e39; color:#d1d4dc; border-color:#3a3e4e; }
.isp-drp-icon { font-size:12px; }
.isp-drp-arrow { font-size:9px; opacity:.6; }

.isp-drp-popup {
    display: none;
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    background: #1e222d;
    border: 1px solid #2a2e39;
    border-radius: 6px;
    padding: 12px;
    min-width: 240px;
    box-shadow: 0 8px 24px rgba(0,0,0,.5);
    z-index: 9999;
}
.isp-drp-popup.open { display:block; }
.isp-drp-header {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: .5px;
    color: #4a4f5e;
    margin-bottom: 10px;
}
.isp-drp-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
}
.isp-drp-row label {
    font-size: 11px;
    color: #787b86;
    width: 24px;
    flex-shrink: 0;
}
.isp-date-input {
    flex: 1;
    background: #2a2e39;
    border: 1px solid #3a3e4e;
    border-radius: 4px;
    color: #d1d4dc;
    font-size: 12px;
    padding: 4px 6px;
    outline: none;
    color-scheme: dark;
}
.isp-date-input:focus { border-color:#2962FF; }
.isp-drp-btns { display:flex; gap:6px; margin-top:10px; }
.isp-drp-apply {
    flex:1; padding:5px 10px;
    background:#2962FF; border:none; border-radius:4px;
    color:#fff; font-size:11px; cursor:pointer;
    transition: background .12s;
}
.isp-drp-apply:hover { background:#1e4fcc; }
.isp-drp-apply:disabled { background:#2a2e39; color:#555; cursor:not-allowed; }
.isp-drp-reset {
    padding:5px 10px;
    background:transparent; border:1px solid #2a2e39; border-radius:4px;
    color:#787b86; font-size:11px; cursor:pointer;
    transition: background .12s;
}
.isp-drp-reset:hover { background:#2a2e39; color:#d1d4dc; }
.isp-drp-hint {
    font-size:10px; color:#4a4f5e;
    margin-top:8px; min-height:14px;
    line-height:1.4;
}

/* ── Info fields ──────────────────────────────────────────── */
.isp-info {
    display:flex; align-items:center; gap:0;
    font-size:12px; flex:1; min-width:0;
    overflow:hidden; white-space:nowrap;
}
.isp-info.isp-current .isp-k { color:#2962FF; }
.isp-field { display:inline-flex; align-items:baseline; gap:4px; flex-shrink:0; }
.isp-k {
    font-size:10px; font-weight:700;
    text-transform:uppercase; letter-spacing:.3px;
    color:#4a4f5e;
}
.isp-v {
    font-size:12px; color:#d1d4dc;
    font-variant-numeric:tabular-nums;
}

/* ── Config button ────────────────────────────────────────── */
.isp-cfg-btn {
    margin-left:6px; padding:3px 7px;
    background:transparent; border:1px solid #2a2e39;
    border-radius:4px; color:#4a4f5e; font-size:13px;
    cursor:pointer; flex-shrink:0;
    transition: background .12s, color .12s;
}
.isp-cfg-btn:hover { background:#2a2e39; color:#d1d4dc; }

/* ── Config popup ─────────────────────────────────────────── */
.isp-cfg-popup {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    background: #1e222d;
    border: 1px solid #2a2e39;
    border-radius: 6px;
    padding: 12px;
    min-width: 380px;
    box-shadow: 0 8px 24px rgba(0,0,0,.5);
    z-index: 9999;
}
.isp-cfg-title {
    font-size:11px; font-weight:700; text-transform:uppercase;
    letter-spacing:.5px; color:#4a4f5e; margin-bottom:10px;
}
.isp-cfg-list { display:flex; flex-direction:column; gap:5px; margin-bottom:10px; }
.isp-cfg-row {
    display:flex; align-items:center; gap:6px;
    background:#252a35; border-radius:4px; padding:4px 8px;
}
.isp-cfg-drag { color:#4a4f5e; cursor:grab; font-size:13px; }
.isp-cfg-label {
    flex:1; min-width:60px;
    background:#1a1e2b; border:1px solid #2a2e39;
    border-radius:3px; color:#d1d4dc; font-size:11px; padding:3px 6px;
}
.isp-cfg-key {
    flex:1; min-width:80px;
    background:#1a1e2b; border:1px solid #2a2e39;
    border-radius:3px; color:#d1d4dc; font-size:11px; padding:3px 4px;
}
.isp-cfg-color { width:28px; height:24px; padding:2px; border:none; border-radius:3px; cursor:pointer; background:transparent; }
.isp-cfg-dec {
    background:#1a1e2b; border:1px solid #2a2e39;
    border-radius:3px; color:#d1d4dc; font-size:11px; padding:3px 4px;
    text-align:center;
}
.isp-cfg-del {
    background:transparent; border:none; color:#4a4f5e;
    cursor:pointer; font-size:12px; padding:0 2px;
    transition:color .12s;
}
.isp-cfg-del:hover { color:#ff4444; }
.isp-cfg-add-row {
    display:flex; gap:6px; margin-bottom:10px;
}
.isp-cfg-add-row select {
    flex:1; background:#2a2e39; border:1px solid #3a3e4e;
    border-radius:4px; color:#d1d4dc; font-size:11px; padding:4px 6px;
}
.light-theme .isp-cfg-add-row select {
    background: #ffffff;
}
.light-theme #isp-cfg-add-btn {
    background:#ffffff;color: #787b86;
}
#isp-cfg-add-btn {
    padding:4px 10px; background:#2a2e39; border:1px solid #3a3e4e;
    border-radius:4px; color:#d1d4dc; font-size:11px; cursor:pointer;
    white-space:nowrap; transition:background .12s;
}
#isp-cfg-add-btn:hover { background:#3a3e4e; }
.isp-cfg-actions { display:flex; gap:6px; }
#isp-cfg-save {
    flex:1; padding:5px 10px;
    background:#2962FF; border:none; border-radius:4px;
    color:#fff; font-size:11px; cursor:pointer;
    transition:background .12s;
}
#isp-cfg-save:hover { background:#1e4fcc; }
#isp-cfg-reset-def {
    padding:5px 10px;
    background:transparent; border:1px solid #2a2e39; border-radius:4px;
    color:#787b86; font-size:11px; cursor:pointer;
    transition:background .12s;
}
#isp-cfg-reset-def:hover { background:#2a2e39; color:#d1d4dc; }

/* ── Light theme ──────────────────────────────────────────── */
body.light-theme .interval-selector-panel { background:#f8f9fd; border-bottom-color:#e0e3eb; }
body.light-theme .isb                     { color:#787b86; }
body.light-theme .isb:hover               { background:#e9ecf2; color:#131722; }
body.light-theme .isp-sep-v               { background:#d0d3db; }
body.light-theme .isp-k                   { color:#aaa; }
body.light-theme .isp-v                   { color:#131722; }
body.light-theme .isp-drp-popup,
body.light-theme .isp-cfg-popup           { background:#fff; border-color:#e0e3eb; }
body.light-theme .isp-date-input          { background:#f0f3fb; border-color:#d0d3db; color:#131722; color-scheme:light; }
body.light-theme .isp-drp-btn            { border-color:#d0d3db; color:#787b86; }
body.light-theme .isp-drp-btn:hover      { background:#e9ecf2; }
body.light-theme .isp-cfg-row            { background:#f0f3fb; }
body.light-theme .isp-cfg-label,
body.light-theme .isp-cfg-key,
body.light-theme .isp-cfg-dec            { background:#fff; border-color:#d0d3db; color:#131722; }
        `;
        document.head.appendChild(s);
    }
}

// ── Init ──────────────────────────────────────────────────────────────────────
window.intervalSelector = new IntervalSelector();

// Интеграция с layout-manager: при смене layout обновляем настройки
document.addEventListener('layoutChanged', () => {
    window.intervalSelector?.onLayoutChanged?.();
});