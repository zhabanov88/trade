/**
 * ChartTypeSelector
 * ─────────────────────────────────────────────────────────────────────────────
 * Adds a native top-toolbar dropdown that lets the user switch the main-series
 * chart style ("bar type"), including TradingView **Range** bars.
 *
 * Why the magic number 11?
 *   Range is a first-class built-in chart style in Charting Library v29.x
 *   (internal enum: `ChartStyle.Range === 11`). It is intentionally omitted from
 *   the public TypeScript `SeriesType` / `ChartStyle` enums, so we reference it
 *   by its numeric id and pass it to `setChartType()`.
 *
 * Conventions mirror interval-selector.js:
 *   - a class exposing `async init(widget)`
 *   - a singleton `window.chartTypeSelector`
 *   - re-syncs on the `layoutChanged` event
 */
class ChartTypeSelector {
    constructor() {
        this.widget           = null;
        this.dropdown         = null;   // IDropdownApi | null
        this.fallbackBtn      = null;   // HTMLElement | null (only if createDropdown missing)
        this._chart           = null;
        this._subscribedChart = null;
        this._onTypeChanged   = null;
        this._current         = null;   // current SeriesType (number)

        // Menu order. `id` is the SeriesType/ChartStyle integer accepted by
        // IChartWidgetApi.setChartType().
        this.TYPES = [
            { id: 1,  label: 'Candles' },
            { id: 9,  label: 'Hollow candles' },
            { id: 0,  label: 'Bars' },
            { id: 2,  label: 'Line' },
            { id: 3,  label: 'Area' },
            { id: 10, label: 'Baseline' },
            { id: 8,  label: 'Heikin Ashi' },
            { id: 11, label: 'Range' },          // ← requested range-bars view
            { id: 4,  label: 'Renko' },
            { id: 7,  label: 'Line break' },
            { id: 5,  label: 'Kagi' },
            { id: 6,  label: 'Point & Figure' },
        ];
    }

    async init(widget) {
        this.widget = widget || (window.app && window.app.widget) || null;
        if (!this.widget || typeof this.widget.activeChart !== 'function') {
            console.warn('[ChartTypeSelector] widget/activeChart unavailable — skipping');
            return;
        }

        try { this._chart = this.widget.activeChart(); } catch (_) { this._chart = null; }
        if (!this._chart) {
            console.warn('[ChartTypeSelector] no active chart — skipping');
            return;
        }

        try { this._current = this._chart.chartType(); } catch (_) { this._current = null; }

        if (typeof this.widget.createDropdown === 'function') {
            await this._buildDropdown();
        } else {
            this._buildFallbackButton();
        }

        this._subscribeTypeChanges();
    }

    async _buildDropdown() {
        const items = this.TYPES.map((t) => ({
            title: t.label,
            onSelect: () => this._select(t.id),
        }));
        try {
            this.dropdown = await this.widget.createDropdown({
                title: this._titleFor(this._current),
                tooltip: 'Bar type (incl. Range bars)',
                items,
                align: 'left',
            });
        } catch (e) {
            console.warn('[ChartTypeSelector] createDropdown failed, using fallback', e);
            this.dropdown = null;
            this._buildFallbackButton();
        }
    }

    _buildFallbackButton() {
        if (typeof this.widget.createButton !== 'function') return;
        try {
            const btn = this.widget.createButton();
            btn.textContent = 'Range bars';
            btn.title = 'Toggle Range bars / Candles';
            btn.style.cursor = 'pointer';
            btn.addEventListener('click', () => {
                const next = (this._current === 11) ? 1 : 11;
                this._select(next);
            });
            this.fallbackBtn = btn;
        } catch (e) {
            console.warn('[ChartTypeSelector] createButton fallback failed', e);
        }
    }

    _select(id) {
        if (!this._chart || typeof this._chart.setChartType !== 'function') {
            try { this._chart = this.widget.activeChart(); } catch (_) {}
        }
        if (!this._chart || typeof this._chart.setChartType !== 'function') {
            console.warn('[ChartTypeSelector] setChartType unavailable');
            return;
        }

        const rbm = window.RangeBarMode;

        // "Range" (11) has no native builder in the deployed (trimmed) charting
        // library, so we render synthesized range bars: underlying style stays
        // Candles (1) and RangeBarMode transforms the datafeed's bars.
        if (id === 11 && rbm && rbm.available) {
            try {
                this._chart.setChartType(1);
                rbm.enable();
                this._current = 11;
                this._refreshTitle();
            } catch (e) {
                console.warn('[ChartTypeSelector] range-bars enable failed', e);
            }
            return;
        }

        if (rbm && rbm.enabled) {
            try { rbm.disable(); } catch (_) {}
        }

        try {
            this._chart.setChartType(id);
            this._current = id;
            this._refreshTitle();
        } catch (e) {
            console.warn('[ChartTypeSelector] setChartType(' + id + ') failed', e);
        }
    }

    _subscribeTypeChanges() {
        if (!this._chart || typeof this._chart.onChartTypeChanged !== 'function') return;
        if (this._subscribedChart === this._chart) return;
        try {
            if (!this._onTypeChanged) {
                this._onTypeChanged = (type) => {
                    const rbm = window.RangeBarMode;
                    this._current = (rbm && rbm.enabled) ? 11 : type;
                    this._refreshTitle();
                };
            }
            this._chart.onChartTypeChanged().subscribe(null, this._onTypeChanged);
            this._subscribedChart = this._chart;
        } catch (e) {
            console.warn('[ChartTypeSelector] onChartTypeChanged subscribe failed', e);
        }
    }

    _titleFor(id) {
        const found = this.TYPES.find((t) => t.id === id);
        return 'Bars: ' + (found ? found.label : '—');
    }

    _refreshTitle() {
        if (this.dropdown && typeof this.dropdown.applyOptions === 'function') {
            try { this.dropdown.applyOptions({ title: this._titleFor(this._current) }); } catch (_) {}
        }
        if (this.fallbackBtn) {
            this.fallbackBtn.style.opacity = (this._current === 11) ? '1' : '0.7';
        }
    }

    onLayoutChanged() {
        try {
            if (this.widget && typeof this.widget.activeChart === 'function') {
                this._chart = this.widget.activeChart();
                try { this._current = this._chart.chartType(); } catch (_) {}
                this._subscribeTypeChanges();
                this._refreshTitle();
            }
        } catch (_) {}
    }
}

// ── Init ──────────────────────────────────────────────────────────────────────
window.chartTypeSelector = new ChartTypeSelector();

document.addEventListener('layoutChanged', () => {
    window.chartTypeSelector?.onLayoutChanged?.();
});