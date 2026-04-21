/* ────────────────────────────────────────────────────────────
 *  Drawing Template Manager
 *  Custom implementation for TV Charting Library (v29)
 *  TV's built-in drawing templates are only in Trading Terminal edition.
 *  This uses context_menu.items_processor + existing backend API.
 *
 *  Backend: GET/POST/DELETE /api/drawing-templates/:toolName[/:name]
 *  DB: drawing_templates (user_id, tool_name, template_name, content TEXT)
 * ──────────────────────────────────────────────────────────── */
(function () {
    'use strict';

    var _widget = null;

    /* ── Cache ── */
    var _cache = {};            // { toolName: { names: [...], ts: N } }
    var CACHE_TTL = 30000;      // 30 s

    /* ── Friendly tool names ── */
    var TOOL_LABELS = {
        'trend_line':       'Trend Line',
        'horizontal_line':  'Horizontal Line',
        'vertical_line':    'Vertical Line',
        'horizontal_ray':   'Horizontal Ray',
        'ray':              'Ray',
        'extended':         'Extended Line',
        'parallel_channel': 'Parallel Channel',
        'regression_trend': 'Regression Trend',
        'fib_retracement':  'Fib Retracement',
        'fib_speed_resistance_fan': 'Fib Fan',
        'rectangle':        'Rectangle',
        'circle':           'Circle',
        'ellipse':          'Ellipse',
        'triangle':         'Triangle',
        'path':             'Path',
        'brush':            'Brush',
        'text':             'Text',
        'anchored_text':    'Anchored Text',
        'note':             'Note',
        'anchored_note':    'Anchored Note',
        'callout':          'Callout',
        'arrow_up':         'Arrow Up',
        'arrow_down':       'Arrow Down',
        'arrow_marker':     'Arrow Marker',
        'flag':             'Flag',
        'price_label':      'Price Label'
    };

    function toolLabel(name) {
        return TOOL_LABELS[name] || name.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    }

    /* ═══════════════════════════════════════════════════
     *  API  (matches existing backend endpoints)
     * ═══════════════════════════════════════════════════ */

    /** GET /api/drawing-templates/:toolName  →  ["name1","name2"] */
    function fetchTemplateNames(toolName) {
        return fetch('/api/drawing-templates/' + encodeURIComponent(toolName), {
            credentials: 'include'
        })
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (names) {
            _cache[toolName] = { names: names, ts: Date.now() };
            return names;
        })
        .catch(function () { return []; });
    }

    function getTemplateNames(toolName) {
        var c = _cache[toolName];
        if (c && Date.now() - c.ts < CACHE_TTL) return Promise.resolve(c.names);
        return fetchTemplateNames(toolName);
    }

    /** GET /api/drawing-templates/:toolName/:name  →  { content: "..." } */
    function fetchTemplateContent(toolName, name) {
        return fetch(
            '/api/drawing-templates/' + encodeURIComponent(toolName) + '/' + encodeURIComponent(name),
            { credentials: 'include' }
        )
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
    }

    /** POST /api/drawing-templates/:toolName  body { name, content } */
    function saveTemplateToDb(toolName, name, content) {
        return fetch('/api/drawing-templates/' + encodeURIComponent(toolName), {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, content: content })
        })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            delete _cache[toolName];   // invalidate
            return data;
        });
    }

    /** DELETE /api/drawing-templates/:toolName/:name */
    function deleteTemplateFromDb(toolName, name) {
        return fetch(
            '/api/drawing-templates/' + encodeURIComponent(toolName) + '/' + encodeURIComponent(name),
            { method: 'DELETE', credentials: 'include' }
        )
        .then(function (r) { return r.json(); })
        .then(function (data) {
            delete _cache[toolName];
            return data;
        });
    }

    /* ═══════════════════════════════════════════════════
     *  Shape helpers
     * ═══════════════════════════════════════════════════ */

    function getShapeInfo(shapeId) {
        if (!_widget) return null;
        try {
            var shapes = _widget.activeChart().getAllShapes();
            for (var i = 0; i < shapes.length; i++) {
                if (String(shapes[i].id) === String(shapeId)) return shapes[i];
            }
        } catch (_) {}
        return null;
    }

    function getShapeProps(shapeId) {
        if (!_widget) return null;
        try {
            return _widget.activeChart().getShapeById(shapeId).getProperties();
        } catch (_) { return null; }
    }

    function applyProps(shapeId, props, saveDefaults) {
        if (!_widget) return false;
        try {
            _widget.activeChart().getShapeById(shapeId).setProperties(props, saveDefaults !== false);
            return true;
        } catch (e) {
            console.error('[DT] setProperties failed:', e);
            return false;
        }
    }

    /** Strip positional / identity fields — keep only visual properties */
    var SKIP = {
        id: 1, points: 1, interval: 1, symbol: 1,
        ownerSource: 1, zorder: 1, linkKey: 1,
        visible: 1, frozen: 1
    };

    function visualProps(props) {
        var out = {};
        for (var k in props) {
            if (props.hasOwnProperty(k) && !SKIP[k]) {
                out[k] = props[k];
            }
        }
        return out;
    }

    /* ═══════════════════════════════════════════════════
     *  Save flow
     * ═══════════════════════════════════════════════════ */

    function promptAndSave(shapeId, toolName) {
        var name = prompt('Template name for "' + toolLabel(toolName) + '":');
        if (!name || !name.trim()) return;
        name = name.trim();

        var props = getShapeProps(shapeId);
        if (!props) { alert('Cannot read drawing properties'); return; }

        var vp = visualProps(props);
        saveTemplateToDb(toolName, name, JSON.stringify(vp))
            .then(function () {
                _log('Saved template "' + name + '" for ' + toolName);
            })
            .catch(function (e) {
                alert('Save failed: ' + (e.message || e));
            });
    }

    /* ═══════════════════════════════════════════════════
     *  Apply flow
     * ═══════════════════════════════════════════════════ */

    function applyTemplate(shapeId, toolName, templateName) {
        fetchTemplateContent(toolName, templateName)
            .then(function (data) {
                if (!data || !data.content) {
                    alert('Template not found');
                    return;
                }
                var props;
                try { props = JSON.parse(data.content); } catch (_) { props = null; }
                if (!props) { alert('Bad template data'); return; }

                if (applyProps(shapeId, props, true)) {
                    _log('Applied "' + templateName + '" to ' + toolName);
                }
            })
            .catch(function (e) {
                alert('Apply failed: ' + (e.message || e));
            });
    }

    /* ═══════════════════════════════════════════════════
     *  Delete flow
     * ═══════════════════════════════════════════════════ */

    function confirmAndDelete(toolName, templateName) {
        if (!confirm('Delete template "' + templateName + '"?')) return;
        deleteTemplateFromDb(toolName, templateName)
            .then(function () { _log('Deleted "' + templateName + '"'); })
            .catch(function () { alert('Delete failed'); });
    }

    /* ═══════════════════════════════════════════════════
     *  Context Menu Processor  (items_processor callback)
     *
     *  Signature:  (items, actionsFactory, params) → Promise<items>
     *  params.detail.type === 'shape'  →  drawing right-click
     * ═══════════════════════════════════════════════════ */

    function _injectChartTemplateMenu(items, actionsFactory) {
        var newItems = Array.from(items);

        newItems.push(actionsFactory.createSeparator());

        newItems.push(actionsFactory.createAsyncAction(function () {
            return fetch('/api/chart-templates', { credentials: 'include' })
                .then(function (r) { return r.ok ? r.json() : []; })
                .then(function (names) {
                    var sub = [];
                    var w = window.app && window.app.widget;

                    if (names && names.length > 0) {
                        for (var i = 0; i < names.length; i++) {
                            (function (tplName) {
                                sub.push(actionsFactory.createAction({
                                    actionId: 'ct-apply-' + tplName,
                                    label: tplName,
                                    onExecute: function () {
                                        if (!w) return;
                                        try { w.activeChart().loadChartTemplate(tplName); } catch (_) {}
                                    }
                                }));
                            })(names[i]);
                        }

                        sub.push(actionsFactory.createSeparator());
                        sub.push(actionsFactory.createAction({
                            actionId: 'ct-delete',
                            label: '\uD83D\uDDD1\uFE0F Delete template\u2026',
                            onExecute: function () {
                                var which = prompt('Template name to delete:');
                                if (!which || !which.trim()) return;
                                fetch('/api/chart-templates/' + encodeURIComponent(which.trim()), {
                                    method: 'DELETE', credentials: 'include'
                                });
                            }
                        }));
                    }

                    if (sub.length === 0) {
                        sub.push(actionsFactory.createAction({
                            actionId: 'ct-empty',
                            label: '(no templates)',
                            onExecute: function () {}
                        }));
                    }

                    return {
                        actionId: 'ct-menu',
                        label: 'Chart template',
                        subItems: sub
                    };
                })
                .catch(function () {
                    return {
                        actionId: 'ct-menu',
                        label: 'Chart template',
                        subItems: [actionsFactory.createAction({
                            actionId: 'ct-empty',
                            label: '(no templates)',
                            onExecute: function () {}
                        })]
                    };
                });
        }));

        return Promise.resolve(newItems);
    }

            function processContextMenu(items, actionsFactory, params) {
        // Chart area right-click → inject "Chart template" submenu
        if (!params.detail || params.detail.type !== 'shape') {
            return _injectChartTemplateMenu(items, actionsFactory);
        }
        // Drawing right-click
        if (params.detail.id == null) {
            return Promise.resolve(items);
        }

        var shapeId = params.detail.id;
        var info = getShapeInfo(shapeId);
        if (!info) return Promise.resolve(items);

        var toolName = info.name;       // e.g. "trend_line"
        var newItems = Array.from(items);

        // ── Separator ──
        newItems.push(actionsFactory.createSeparator());

        // ── "Save as Template…" ──
        newItems.push(actionsFactory.createAction({
            actionId: 'dt-save',
            label: '\uD83D\uDCCF Save as Template\u2026',
            onExecute: function () { promptAndSave(shapeId, toolName); }
        }));

        // ── "Templates (N)" — async submenu ──
        newItems.push(actionsFactory.createAsyncAction(function () {
            return getTemplateNames(toolName).then(function (names) {
                if (!names || names.length === 0) {
                    return {
                        actionId: 'dt-empty',
                        label: '\uD83D\uDCCF No Saved Templates',
                        disabled: true
                    };
                }

                var sub = [];
                for (var i = 0; i < names.length; i++) {
                    (function (tplName) {
                        // Apply item
                        sub.push(actionsFactory.createAction({
                            actionId: 'dt-apply-' + tplName,
                            label: tplName,
                            onExecute: function () { applyTemplate(shapeId, toolName, tplName); }
                        }));
                    })(names[i]);
                }

                // Separator + delete section
                sub.push(actionsFactory.createSeparator());
                sub.push(actionsFactory.createAction({
                    actionId: 'dt-manage',
                    label: '\uD83D\uDDD1\uFE0F Delete Template\u2026',
                    onExecute: function () {
                        showDeleteDialog(toolName);
                    }
                }));

                return {
                    actionId: 'dt-templates',
                    label: '\uD83D\uDCCF Templates (' + names.length + ')',
                    subItems: sub
                };
            });
        }));

        return Promise.resolve(newItems);
    }

    /* ═══════════════════════════════════════════════════
     *  Delete dialog  (simple floating panel)
     * ═══════════════════════════════════════════════════ */

    function showDeleteDialog(toolName) {
        // Remove any existing dialog
        var old = document.getElementById('dt-delete-dialog');
        if (old) old.remove();

        getTemplateNames(toolName).then(function (names) {
            if (!names || names.length === 0) {
                alert('No templates to delete');
                return;
            }

            var overlay = document.createElement('div');
            overlay.id = 'dt-delete-dialog';
            overlay.style.cssText =
                'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100000;' +
                'display:flex;align-items:center;justify-content:center;';

            var panel = document.createElement('div');
            var isDark = document.body.classList.contains('dark-theme') ||
                         document.documentElement.getAttribute('data-theme') === 'dark';
            panel.style.cssText =
                'background:' + (isDark ? '#1e222d' : '#fff') + ';' +
                'color:' + (isDark ? '#d1d4dc' : '#131722') + ';' +
                'border:1px solid ' + (isDark ? '#363a45' : '#e0e3eb') + ';' +
                'border-radius:8px;padding:16px 20px;min-width:260px;max-width:360px;' +
                'box-shadow:0 8px 24px rgba(0,0,0,.3);font-family:-apple-system,BlinkMacSystemFont,sans-serif;';

            var title = document.createElement('div');
            title.style.cssText = 'font-size:14px;font-weight:600;margin-bottom:12px;';
            title.textContent = 'Delete Templates — ' + toolLabel(toolName);
            panel.appendChild(title);

            for (var i = 0; i < names.length; i++) {
                (function (tplName) {
                    var row = document.createElement('div');
                    row.style.cssText =
                        'display:flex;align-items:center;justify-content:space-between;' +
                        'padding:6px 8px;border-radius:4px;margin-bottom:2px;';
                    row.onmouseenter = function () { row.style.background = isDark ? '#2a2e39' : '#f0f3fa'; };
                    row.onmouseleave = function () { row.style.background = 'transparent'; };

                    var lbl = document.createElement('span');
                    lbl.style.cssText = 'font-size:13px;';
                    lbl.textContent = tplName;

                    var btn = document.createElement('button');
                    btn.style.cssText =
                        'background:transparent;border:1px solid ' + (isDark ? '#363a45' : '#e0e3eb') + ';' +
                        'color:#f23645;font-size:12px;padding:2px 8px;border-radius:4px;cursor:pointer;';
                    btn.textContent = 'Delete';
                    btn.onclick = function () {
                        deleteTemplateFromDb(toolName, tplName).then(function () {
                            row.remove();
                            // If no more items, close dialog
                            if (!panel.querySelector('[data-dt-row]')) overlay.remove();
                        });
                    };

                    row.setAttribute('data-dt-row', '1');
                    row.appendChild(lbl);
                    row.appendChild(btn);
                    panel.appendChild(row);
                })(names[i]);
            }

            // Close button
            var closeBtn = document.createElement('button');
            closeBtn.style.cssText =
                'display:block;margin:12px auto 0;padding:6px 24px;border:none;border-radius:4px;' +
                'background:#2962ff;color:#fff;font-size:13px;cursor:pointer;';
            closeBtn.textContent = 'Close';
            closeBtn.onclick = function () { overlay.remove(); };
            panel.appendChild(closeBtn);

            overlay.appendChild(panel);
            overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };
            document.body.appendChild(overlay);
        });
    }

    /* ═══════════════════════════════════════════════════
     *  Init
     * ═══════════════════════════════════════════════════ */

    function init(widget) {
        _widget = widget;
        _log('Drawing Template Manager ready');
    }

    function _log(msg) {
        if (window.DebugOverlay) {
            window.DebugOverlay.log('[DT] ' + msg);
        }
    }

    /* ── Public API ── */
    window.drawingTemplateManager = {
        init: init,
        processContextMenu: processContextMenu
    };

})();


/* ═══════════════════════════════════════════════════════════════
 *  DOM injection for floating toolbar "..." menu
 *  The "..." menu does NOT go through items_processor,
 *  so we detect it via MutationObserver and inject items.
 * ═══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    var _injecting = false;
    var _observer = null;
    var DT_MARKER = 'data-dt-injected';

    /* ── Get TV iframe document ── */
    function _getTVDoc() {
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
            try {
                var doc = iframes[i].contentDocument || (iframes[i].contentWindow ? iframes[i].contentWindow.document : null);
                if (doc && doc.getElementById('header-toolbar-save-load')) return doc;
            } catch (_) {}
        }
        if (document.getElementById('header-toolbar-save-load')) return document;
        return null;
    }

    /* ── Get currently selected shape ── */
    function _getSelectedShape() {
        var dtm = window.drawingTemplateManager;
        if (!dtm || !dtm._widget) return null;
        var w = dtm._widget;
        try {
            var sel = w.activeChart().selection();
            if (!sel || sel.isEmpty()) return null;
            var ids = sel.allSources();
            if (!ids || ids.length === 0) return null;
            var shapeId = ids[0];
            var shapes = w.activeChart().getAllShapes();
            for (var i = 0; i < shapes.length; i++) {
                if (String(shapes[i].id) === String(shapeId)) {
                    return { id: shapeId, name: shapes[i].name };
                }
            }
        } catch (_) {}
        return null;
    }

    /* ── Check if a DOM element is the "..." floating toolbar menu ── */
    function _isFloatingMenu(el) {
        if (!el || el.nodeType !== 1) return false;
        var text = el.textContent || '';
        // "..." menu has: Clone, Copy, Hide (and Visual order, Visibility)
        if (text.indexOf('Clone') === -1 || text.indexOf('Hide') === -1) return false;
        // Must NOT be the right-click context menu
        // Right-click has: Remove, Settings, Save as Template (from items_processor)
        if (text.indexOf("Remove") !== -1) return false;
        if (text.indexOf("Settings") !== -1) return false;
        if (text.indexOf("Save as Template") !== -1) return false;
        // The "..." menu is small: typically 5-7 items
        var items = el.querySelectorAll('[class*="item"]');
        if (items.length < 3) return false;
        // Check if already injected
        if (el.querySelector('[' + DT_MARKER + ']')) return false;
        return true;
    }

    /* ── Find the menu item container and clone style ── */
    function _findMenuItems(menuEl) {
        // TV menu items have role="menuitem" or contain inner text nodes
        // Strategy: find all direct interactive children
        var candidates = [];
        // Try role="menuitem" first
        var byRole = menuEl.querySelectorAll('[role="menuitem"]');
        if (byRole.length > 0) return Array.from(byRole);
        // Fallback: find elements containing "Clone" or "Copy"
        var all = menuEl.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
            var t = (all[i].textContent || '').trim();
            if (t === 'Clone' || t === 'Copy' || t === 'Hide') {
                candidates.push(all[i]);
            }
        }
        return candidates;
    }

    /* ── Create a separator matching TV style ── */
    function _createSeparator(referenceItem) {
        var sep = document.createElement('div');
        sep.setAttribute(DT_MARKER, '1');
        // Find an existing separator in the menu
        var parent = referenceItem ? referenceItem.parentNode : null;
        if (parent) {
            var existingSeps = parent.querySelectorAll('[class*="separator"], [class*="Separator"], hr');
            if (existingSeps.length > 0) {
                var clone = existingSeps[0].cloneNode(true);
                clone.setAttribute(DT_MARKER, '1');
                return clone;
            }
        }
        sep.style.cssText = 'height:1px;margin:4px 0;background:rgba(128,128,128,0.2);';
        return sep;
    }

    /* ── Create a menu item matching TV style ── */
    function _createMenuItem(label, onClick, referenceItem) {
        var item;
        if (referenceItem) {
            item = referenceItem.cloneNode(true);
            item.setAttribute(DT_MARKER, '1');
            // Remove ALL SVGs (icons, arrows)
            var svgs = item.querySelectorAll('svg');
            for (var s = svgs.length - 1; s >= 0; s--) svgs[s].remove();
            // Remove shortcut hints
            var hints = item.querySelectorAll('[class*="shortcut"], [class*="Shortcut"], [class*="hint"], [class*="Hint"]');
            for (var i = 0; i < hints.length; i++) hints[i].remove();
            // Set label text
            _setItemText(item, label);
        } else {
            item = document.createElement('div');
            item.setAttribute(DT_MARKER, '1');
            item.style.cssText = 'padding:6px 12px;cursor:pointer;font-size:13px;white-space:nowrap;';
            item.textContent = label;
            item.onmouseenter = function () { item.style.background = 'rgba(41,98,255,0.1)'; };
            item.onmouseleave = function () { item.style.background = ''; };
        }
        // Attach click handler
        item.style.cursor = 'pointer';
        item.onclick = function (e) {
            e.stopPropagation();
            e.preventDefault();
            onClick();
            // Close the menu
            _closeMenu();
        };
        return item;
    }

    function _setItemText(el, text) {
        // Find the deepest text-containing element
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
        var first = walker.nextNode();
        if (first) {
            first.textContent = text;
            // Clear other text nodes (shortcut hints etc.)
            var n;
            while ((n = walker.nextNode())) { n.textContent = ''; }
        } else {
            el.textContent = text;
        }
    }

    function _closeMenu() {
        // Press Escape to close TV menus
        var doc = _getTVDoc() || document;
        try {
            doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        } catch (_) {}
        // Also try clicking outside
        setTimeout(function () {
            try { doc.body.click(); } catch (_) {}
        }, 50);
    }

    /* ── Find the menu-row element (direct child of the list container) ── */
    function _findMenuRow(textEl, menuRoot) {
        var el = textEl;
        var maxDepth = 10;
        while (el && el !== menuRoot && maxDepth-- > 0) {
            if (el.parentNode === menuRoot) return el;
            var parent = el.parentNode;
            if (parent && parent.children && parent.children.length >= 3) {
                return el;
            }
            el = el.parentNode;
        }
        return textEl;
    }

    /* ── Inject template items into the floating toolbar menu ── */
    function _injectTemplateItems(menuEl) {
        if (_injecting) return;
        _injecting = true;

        try {
            var shape = _getSelectedShape();
            if (!shape) { _injecting = false; return; }

            var items = _findMenuItems(menuEl);
            var hideTextEl = null;
            var cloneTextEl = null;
            for (var i = 0; i < items.length; i++) {
                var txt = (items[i].textContent || '').trim();
                if (txt.indexOf('Hide') === 0) hideTextEl = items[i];
                if (txt.indexOf('Clone') === 0) cloneTextEl = items[i];
            }

            var refTextEl = cloneTextEl || hideTextEl || items[0];
            if (!refTextEl) { _injecting = false; return; }

            // Walk UP from text element to the actual menu row
            var refItem = _findMenuRow(refTextEl, menuEl);

            // Container = parent holding all menu rows
            var container = refItem.parentNode;
            if (!container) { _injecting = false; return; }

            // ── Create our items ──
            var sep = _createSeparator(refItem);

            var saveItem = _createMenuItem('\uD83D\uDCCF Save as Template\u2026', function () {
                if (window.drawingTemplateManager) {
                    // Use prompt for name, then save
                    var dtm = window.drawingTemplateManager;
                    var name = prompt('Template name for "' + (shape.name || 'drawing') + '":');
                    if (!name || !name.trim()) return;
                    name = name.trim();
                    try {
                        var props = dtm._widget.activeChart().getShapeById(shape.id).getProperties();
                        var vp = {};
                        var SKIP = { id:1, points:1, interval:1, symbol:1, ownerSource:1, zorder:1, linkKey:1, visible:1, frozen:1 };
                        for (var k in props) { if (props.hasOwnProperty(k) && !SKIP[k]) vp[k] = props[k]; }
                        fetch('/api/drawing-templates/' + encodeURIComponent(shape.name), {
                            method: 'POST', credentials: 'include',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name: name, content: JSON.stringify(vp) })
                        }).then(function () {
                            if (window.DebugOverlay) window.DebugOverlay.log('[DT] Saved "' + name + '" via toolbar menu');
                        });
                    } catch (e) { alert('Save failed: ' + e.message); }
                }
            }, refItem);

            // -- "Templates >" item with hover submenu --
            var tplItem = _createMenuItem('\uD83D\uDCCF Templates', function(){}, refItem);
            tplItem.style.position = 'relative';
            var arrow = document.createElement('span');
            arrow.textContent = '\u203A';
            arrow.style.cssText = 'position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:16px;opacity:.5;';
            tplItem.appendChild(arrow);
            tplItem.onclick = function(e) { e.stopPropagation(); };
            var _subPanel = null;
            var _subTimer = null;
            function _hideSubmenu() {
                _subTimer = setTimeout(function() {
                    if (_subPanel) { _subPanel.remove(); _subPanel = null; }
                }, 200);
            }
            function _keepSubmenu() {
                if (_subTimer) { clearTimeout(_subTimer); _subTimer = null; }
            }
            tplItem.onmouseenter = function() {
                _keepSubmenu();
                if (_subPanel) return;
                _buildSubmenu(tplItem, shape, function(panel) {
                    _subPanel = panel;
                    if (_subPanel) {
                        _subPanel.onmouseenter = _keepSubmenu;
                        _subPanel.onmouseleave = _hideSubmenu;
                    }
                });
            };
            tplItem.onmouseleave = _hideSubmenu;

            // Append: separator + save + templates
            container.appendChild(sep);
            container.appendChild(saveItem);
            container.appendChild(tplItem);

        } catch (e) {
            if (window.DebugOverlay) window.DebugOverlay.warn('[DT] Inject error: ' + e.message);
        }

        _injecting = false;
    }

    /* ── Build hover submenu for Templates item ── */
    function _buildSubmenu(anchorEl, shape, callback) {
        var isDark = (function () {
            var doc2 = _getTVDoc() || document;
            return doc2.body.classList.contains('dark-theme') ||
                   doc2.documentElement.getAttribute('data-theme') === 'dark' ||
                   document.body.classList.contains('dark-theme');
        })();

        fetch('/api/drawing-templates/' + encodeURIComponent(shape.name), { credentials: 'include' })
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (names) {
            var panel = document.createElement('div');
            panel.setAttribute(DT_MARKER, '1');
            panel.style.cssText =
                'position:fixed;z-index:200000;' +
                'background:' + (isDark ? '#1e222d' : '#fff') + ';' +
                'color:' + (isDark ? '#d1d4dc' : '#131722') + ';' +
                'border:1px solid ' + (isDark ? '#363a45' : '#e0e3eb') + ';' +
                'border-radius:6px;padding:4px 0;min-width:160px;max-width:280px;' +
                'box-shadow:0 4px 16px rgba(0,0,0,.25);font-family:-apple-system,BlinkMacSystemFont,sans-serif;';

            var rect = anchorEl.getBoundingClientRect();
            var left = rect.right + 2;
            var top = rect.top;
            if (left + 180 > window.innerWidth) left = rect.left - 182;
            if (top + 200 > window.innerHeight) top = window.innerHeight - 200;
            panel.style.left = left + 'px';
            panel.style.top = top + 'px';

            if (!names || names.length === 0) {
                var empty = document.createElement('div');
                empty.style.cssText = 'padding:8px 12px;font-size:13px;color:' + (isDark ? '#787b86' : '#9598a1') + ';font-style:italic;';
                empty.textContent = 'No saved templates';
                panel.appendChild(empty);
            } else {
                for (var i = 0; i < names.length; i++) {
                    (function (tplName) {
                        var row = document.createElement('div');
                        row.style.cssText = 'padding:6px 12px;cursor:pointer;font-size:13px;display:flex;justify-content:space-between;align-items:center;';

                        var lbl = document.createElement('span');
                        lbl.textContent = tplName;

                        var delBtn = document.createElement('span');
                        delBtn.textContent = '\u00D7';
                        delBtn.title = 'Delete';
                        delBtn.style.cssText = 'color:#f23645;font-size:16px;padding:0 4px;cursor:pointer;opacity:0;margin-left:8px;';
                        row.onmouseenter = function () {
                            row.style.background = isDark ? '#2a2e39' : '#f0f3fa';
                            delBtn.style.opacity = '0.6';
                        };
                        row.onmouseleave = function () {
                            row.style.background = '';
                            delBtn.style.opacity = '0';
                        };
                        delBtn.onmouseenter = function () { delBtn.style.opacity = '1'; };
                        delBtn.onclick = function (e) {
                            e.stopPropagation();
                            if (!confirm('Delete "' + tplName + '"?')) return;
                            fetch('/api/drawing-templates/' + encodeURIComponent(shape.name) + '/' + encodeURIComponent(tplName),
                                { method: 'DELETE', credentials: 'include' })
                            .then(function () { row.remove(); });
                        };

                        row.appendChild(lbl);
                        row.appendChild(delBtn);
                        row.onclick = function () {
                            fetch('/api/drawing-templates/' + encodeURIComponent(shape.name) + '/' + encodeURIComponent(tplName),
                                { credentials: 'include' })
                            .then(function (r) { return r.ok ? r.json() : null; })
                            .then(function (data) {
                                if (!data || !data.content) return;
                                var props;
                                try { props = JSON.parse(data.content); } catch (_) { return; }
                                try {
                                    window.drawingTemplateManager._widget.activeChart()
                                        .getShapeById(shape.id).setProperties(props, true);
                                } catch (_) {}
                            });
                            panel.remove();
                            _closeMenu();
                        };
                        panel.appendChild(row);
                    })(names[i]);
                }
            }

            document.body.appendChild(panel);
            callback(panel);
        })
        .catch(function () { callback(null); });
    }

    /* ── Templates floating panel (shown from "..." menu) ── */
    function _showTemplatesPanel(shape) {
        var old = document.getElementById('dt-toolbar-templates');
        if (old) old.remove();

        fetch('/api/drawing-templates/' + encodeURIComponent(shape.name), { credentials: 'include' })
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (names) {
            if (!names || names.length === 0) {
                alert('No saved templates for this tool');
                return;
            }

            var isDark = (function () {
                var doc = _getTVDoc() || document;
                return doc.body.classList.contains('dark-theme') ||
                       doc.documentElement.getAttribute('data-theme') === 'dark' ||
                       document.body.classList.contains('dark-theme');
            })();

            var panel = document.createElement('div');
            panel.id = 'dt-toolbar-templates';
            panel.style.cssText =
                'position:fixed;z-index:200000;' +
                'background:' + (isDark ? '#1e222d' : '#fff') + ';' +
                'color:' + (isDark ? '#d1d4dc' : '#131722') + ';' +
                'border:1px solid ' + (isDark ? '#363a45' : '#e0e3eb') + ';' +
                'border-radius:6px;padding:8px 0;min-width:180px;max-width:300px;' +
                'box-shadow:0 4px 16px rgba(0,0,0,.25);font-family:-apple-system,BlinkMacSystemFont,sans-serif;';

            // Position near mouse
            var mx = (window._dtLastMouseX || window.innerWidth / 2);
            var my = (window._dtLastMouseY || window.innerHeight / 2);
            panel.style.left = Math.min(mx, window.innerWidth - 220) + 'px';
            panel.style.top = Math.min(my, window.innerHeight - 300) + 'px';

            // Title
            var title = document.createElement('div');
            title.style.cssText = 'padding:4px 12px 6px;font-size:11px;color:' + (isDark ? '#787b86' : '#9598a1') + ';text-transform:uppercase;letter-spacing:.5px;';
            title.textContent = 'Templates';
            panel.appendChild(title);

            // Template items
            for (var i = 0; i < names.length; i++) {
                (function (tplName) {
                    var row = document.createElement('div');
                    row.style.cssText = 'padding:6px 12px;cursor:pointer;font-size:13px;display:flex;justify-content:space-between;align-items:center;';
                    row.onmouseenter = function () { row.style.background = isDark ? '#2a2e39' : '#f0f3fa'; };
                    row.onmouseleave = function () { row.style.background = ''; };

                    var lbl = document.createElement('span');
                    lbl.textContent = tplName;

                    var delBtn = document.createElement('span');
                    delBtn.textContent = '\u00D7';
                    delBtn.title = 'Delete';
                    delBtn.style.cssText = 'color:#f23645;font-size:16px;padding:0 4px;cursor:pointer;opacity:0.5;';
                    delBtn.onmouseenter = function () { delBtn.style.opacity = '1'; };
                    delBtn.onmouseleave = function () { delBtn.style.opacity = '0.5'; };
                    delBtn.onclick = function (e) {
                        e.stopPropagation();
                        if (!confirm('Delete "' + tplName + '"?')) return;
                        fetch('/api/drawing-templates/' + encodeURIComponent(shape.name) + '/' + encodeURIComponent(tplName),
                            { method: 'DELETE', credentials: 'include' })
                        .then(function () { row.remove(); });
                    };

                    row.appendChild(lbl);
                    row.appendChild(delBtn);
                    row.onclick = function () {
                        // Apply template
                        fetch('/api/drawing-templates/' + encodeURIComponent(shape.name) + '/' + encodeURIComponent(tplName),
                            { credentials: 'include' })
                        .then(function (r) { return r.ok ? r.json() : null; })
                        .then(function (data) {
                            if (!data || !data.content) return;
                            var props;
                            try { props = JSON.parse(data.content); } catch (_) { return; }
                            try {
                                window.drawingTemplateManager._widget.activeChart()
                                    .getShapeById(shape.id).setProperties(props, true);
                                if (window.DebugOverlay) window.DebugOverlay.log('[DT] Applied "' + tplName + '" via toolbar');
                            } catch (e) { alert('Apply failed: ' + e.message); }
                        });
                        panel.remove();
                    };
                    panel.appendChild(row);
                })(names[i]);
            }

            // Click outside to close
            var backdrop = document.createElement('div');
            backdrop.style.cssText = 'position:fixed;inset:0;z-index:199999;';
            backdrop.onclick = function () { backdrop.remove(); panel.remove(); };
            document.body.appendChild(backdrop);
            document.body.appendChild(panel);
        });
    }

    /* ── Track mouse position for panel placement ── */
    document.addEventListener('mousemove', function (e) {
        window._dtLastMouseX = e.clientX;
        window._dtLastMouseY = e.clientY;
    }, { passive: true });

    /* ── MutationObserver: watch for "..." menu appearing ── */
    function _startObserving() {
        var doc = _getTVDoc();
        var target = doc ? doc.body : document.body;
        if (!target) {
            setTimeout(_startObserving, 1000);
            return;
        }

        _observer = new MutationObserver(function (mutations) {
            for (var m = 0; m < mutations.length; m++) {
                var added = mutations[m].addedNodes;
                for (var i = 0; i < added.length; i++) {
                    var node = added[i];
                    if (node.nodeType !== 1) continue;
                    if (_isFloatingMenu(node)) {
                        setTimeout(function () { _injectTemplateItems(node); }, 50);
                        return;
                    }
                    // Check children (menu might be wrapped)
                    if (node.querySelectorAll) {
                        var inner = node.querySelectorAll('div');
                        for (var j = 0; j < inner.length; j++) {
                            if (_isFloatingMenu(inner[j])) {
                                var target2 = inner[j];
                                setTimeout(function () { _injectTemplateItems(target2); }, 50);
                                return;
                            }
                        }
                    }
                }
            }
        });

        _observer.observe(target, { childList: true, subtree: true });

        if (window.DebugOverlay) window.DebugOverlay.log('[DT] Floating toolbar menu observer active');
    }

    /* ── Expose _widget on drawingTemplateManager for the DOM injector ── */
    var _origInit = window.drawingTemplateManager ? window.drawingTemplateManager.init : null;
    if (window.drawingTemplateManager) {
        var origInit = window.drawingTemplateManager.init;
        window.drawingTemplateManager.init = function (widget) {
            origInit(widget);
            window.drawingTemplateManager._widget = widget;
            // Start observing after widget is ready
            widget.onChartReady(function () {
                setTimeout(_startObserving, 500);
            });
        };
    } else {
        // Fallback: wait for drawingTemplateManager to appear
        var _waitInterval = setInterval(function () {
            if (window.drawingTemplateManager) {
                clearInterval(_waitInterval);
                var origInit2 = window.drawingTemplateManager.init;
                window.drawingTemplateManager.init = function (widget) {
                    origInit2(widget);
                    window.drawingTemplateManager._widget = widget;
                    widget.onChartReady(function () {
                        setTimeout(_startObserving, 500);
                    });
                };
            }
        }, 200);
    }

})();
