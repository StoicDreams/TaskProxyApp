/*
 * Draws a plugin's page. Plugins describe their screens as data (see the SDK's ui.rs in TaskProxyPlugins), and this
 * builds them from Task Proxy's own components, so no plugin code runs in this window. Plugin text is always set as
 * text or escaped, and markdown is sanitized like project pages.
 *
 * <app-plugin-page plugin="jira" page="issues"></app-plugin-page> renders that page with the address's query as params.
 * showNode(node, plugin) draws a node without loading a page, as the Git Controller does for branch cards.
 */
"use strict"
{
    const themes = new Set(['primary', 'secondary', 'tertiary', 'info', 'success', 'warning', 'danger']);
    const theme = value => themes.has(value) ? value : '';
    const escape = text => webui.escapeForHTML(`${text ?? ''}`);
    /** Whether each plugin's sections are open, by plugin and section key, kept with the app's state. */
    const sectionsKey = 'app-plugin-sections';

    function el(tag, attrs, text) {
        const node = document.createElement(tag);
        Object.entries(attrs || {}).forEach(([name, value]) => {
            if (value === undefined || value === null || value === false) return;
            node.setAttribute(name, value === true ? '' : `${value}`);
        });
        if (text !== undefined) node.textContent = `${text}`;
        return node;
    }

    function confirmFirst(question) {
        if (!question) return Promise.resolve(true);
        return new Promise(resolve => {
            let confirmed = false;
            webui.dialog({
                content: escape(question),
                confirm: 'Confirm',
                cancel: 'Cancel',
                onconfirm: () => { confirmed = true; return true; },
                onclose: () => resolve(confirmed),
            }).catch(() => resolve(false));
        });
    }

    function readParams() {
        const params = {};
        new URLSearchParams(location.search).forEach((value, key) => { params[key] = value; });
        return params;
    }

    function pageUrl(plugin, page, params) {
        const query = new URLSearchParams();
        Object.entries(params || {}).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') query.set(key, typeof value === 'string' ? value : JSON.stringify(value));
        });
        const search = query.toString();
        return `/plugin/${encodeURIComponent(plugin)}/${encodeURIComponent(page)}${search ? `?${search}` : ''}`;
    }

    /** Every field in a form's children, for checking required ones. */
    function collectFields(nodes) {
        const found = [];
        (nodes || []).forEach(node => {
            if (!node || typeof node !== 'object') return;
            if (node.type === 'inputs') found.push(...(node.fields || []));
            else if (node.type !== 'form') found.push(...collectFields(node.children));
        });
        return found;
    }

    /** The open menu of choices, from a select cell or mention suggestions. Only one is open at a time. */
    let openMenu = null;
    function closeMenu() {
        if (!openMenu) return;
        const menu = openMenu;
        openMenu = null;
        menu.list.remove();
        menu.owner.setAttribute?.('aria-expanded', 'false');
        document.removeEventListener('pointerdown', menu.outside, true);
        window.removeEventListener('resize', closeMenu);
        document.removeEventListener('scroll', menu.scroll, true);
    }
    /** Moves through or picks from the open menu. True when it used the key. */
    function menuKey(ev) {
        if (!openMenu) return false;
        const items = [...openMenu.list.querySelectorAll('[role="option"]:not([hidden])')];
        const index = items.indexOf(openMenu.list.querySelector('[role="option"].active'));
        const activate = next => {
            items.forEach(item => item.classList.remove('active'));
            const item = items[(next + items.length) % items.length];
            item?.classList.add('active');
            item?.scrollIntoView({ block: 'nearest' });
        };
        switch (ev.key) {
            case 'ArrowDown': activate(index + 1); return true;
            case 'ArrowUp': activate(index < 0 ? items.length - 1 : index - 1); return true;
            case 'Enter':
            case 'Tab':
                if (index < 0) return false;
                items[index].click();
                return true;
            case 'Escape': closeMenu(); return true;
            default: return false;
        }
    }
    /**
     * Shows choices under `owner` and calls `pick` with the one chosen. Long lists get a box to filter them.
     * With `keepFocus`, typing stays in the owner, as for mention suggestions.
     */
    function showMenu(owner, options, current, pick, { keepFocus = false } = {}) {
        closeMenu();
        const list = el('div', { class: 'plugin-ui plugin-menu', role: 'listbox' });
        let filter = null;
        if (!keepFocus && options.length > 8) {
            filter = el('input', { type: 'search', class: 'plugin-menu-filter', placeholder: 'Filter', 'aria-label': 'Filter the choices' });
            list.appendChild(filter);
        }
        const items = options.map(option => {
            const item = el('div', { role: 'option', class: 'plugin-menu-item', 'aria-selected': `${option.label}` === current ? 'true' : 'false' }, option.label);
            item.addEventListener('pointerdown', ev => ev.preventDefault());
            item.addEventListener('click', () => {
                closeMenu();
                pick(option);
            });
            list.appendChild(item);
            return item;
        });
        filter?.addEventListener('input', () => {
            const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
            items.forEach(item => { item.hidden = !words.every(word => item.textContent.toLowerCase().includes(word)); });
        });
        list.addEventListener('keydown', ev => {
            if (menuKey(ev)) ev.preventDefault();
        });
        // A dialog shows above everything else, so a menu opened from one goes inside it to show above it.
        (owner.closest('dialog') || document.body).appendChild(list);
        const place = () => {
            const rect = owner.getBoundingClientRect();
            const below = window.innerHeight - rect.bottom;
            list.style.minWidth = `${Math.max(rect.width, 160)}px`;
            list.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - list.offsetWidth - 4))}px`;
            if (below < 220 && rect.top > below) {
                list.style.top = '';
                list.style.bottom = `${window.innerHeight - rect.top + 2}px`;
                list.style.maxHeight = `${Math.max(rect.top - 8, 120)}px`;
            } else {
                list.style.bottom = '';
                list.style.top = `${rect.bottom + 2}px`;
                list.style.maxHeight = `${Math.max(below - 8, 120)}px`;
            }
        };
        place();
        const outside = ev => {
            if (!ev.composedPath().includes(list) && !ev.composedPath().includes(owner)) closeMenu();
        };
        const scroll = ev => {
            if (!list.contains(ev.target)) place();
        };
        openMenu = { owner, list, outside, scroll };
        owner.setAttribute?.('aria-expanded', 'true');
        document.addEventListener('pointerdown', outside, true);
        window.addEventListener('resize', closeMenu);
        document.addEventListener('scroll', scroll, true);
        if (filter) filter.focus();
        else if (!keepFocus) {
            list.tabIndex = -1;
            list.focus();
        }
        if (!keepFocus || items.length) {
            const selected = items.find(item => item.getAttribute('aria-selected') === 'true');
            (selected || (keepFocus ? items[0] : null))?.classList.add('active');
        }
    }

    let pluginStyles = null;
    /**
     * The page's plugin rules from app.css, as a stylesheet a shadow root can adopt. A plugin card drawn inside a
     * component with its own shadow DOM, such as the Git Controller, would otherwise get none of them.
     */
    function pluginStyleSheet() {
        if (pluginStyles) return pluginStyles;
        const rules = [];
        for (const sheet of document.styleSheets) {
            let list;
            try { list = sheet.cssRules; } catch (_) { continue; }
            for (const rule of list || []) {
                if (rule.cssText.includes('.plugin-')) rules.push(rule.cssText);
            }
        }
        pluginStyles = new CSSStyleSheet();
        pluginStyles.replaceSync(rules.join('\n'));
        return pluginStyles;
    }
    function adoptPluginStyles(el) {
        const root = el.getRootNode();
        if (!(root instanceof ShadowRoot)) return;
        const sheet = pluginStyleSheet();
        if (!root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    }

    webui.define("app-plugin-page", {
        constructor() {
            const t = this;
            t._load = 0;
            t._node = null;
        },
        attr: ['plugin', 'page'],
        attrChanged(property) {
            // Class changes come here too, such as plugin-busy while an action runs.
            if (property === 'plugin' || property === 'page') this._queueLoad();
        },
        connected() {
            const t = this;
            t.classList.add('plugin-ui');
            adoptPluginStyles(t);
            // Back and Forward between two addresses of this page change only the query, which does not load a page.
            t._onPopState ??= () => {
                if (!t._staticNode && location.pathname === t.path()) t.load();
            };
            window.addEventListener('popstate', t._onPopState);
            t._queueLoad();
        },
        disconnected() {
            window.removeEventListener('popstate', this._onPopState);
            this.closeDialog();
            this._load++;
        },
        _queueLoad() {
            const t = this;
            if (t._queued || !t.isConnected || t._staticNode) return;
            t._queued = true;
            queueMicrotask(() => {
                t._queued = false;
                if (t.plugin && t.page) t.load();
            });
        },
        /** The address of this page, without its query. */
        path() {
            return pageUrl(this.plugin, this.page);
        },
        /** Loads the page from the plugin and draws it. */
        async load() {
            const t = this;
            const load = ++t._load;
            const plugin = t.plugin;
            const page = t.page;
            t._params = readParams();
            if (!t.firstChild) t.replaceChildren(el('webui-flex', { align: 'center', gap: 'var(--padding)' }, 'Loading…'));
            // A plugin's settings belong to projects, so one not set up for this project shows how to set it up.
            const plugins = await webui.proxy.plugins.list(() => undefined);
            if (load !== t._load) return;
            const info = (plugins || []).find(item => item.id === plugin);
            if (info?.configured === false) {
                t.showSetup(info);
                return;
            }
            let error = null;
            const node = await webui.proxy.plugins.render(plugin, page, t._params, err => { error = `${err}`; });
            if (load !== t._load) return;
            if (error) {
                t.showError(error);
                return;
            }
            t.draw(node);
        },
        /** Asks for the plugin's settings for this project, then shows the page once they are saved. */
        showSetup(info) {
            const t = this;
            const name = info.manifest?.name || info.id;
            const project = webui.getData('app-current-project')?.display || 'this project';
            const box = el('webui-flex', { column: true, gap: 'var(--padding)', class: 'plugin-setup' });
            box.appendChild(el('h3', { class: 'plugin-heading' }, `Set up ${name} for ${project}`));
            box.appendChild(el('p', {}, info.signIns > 0
                ? `${name} is not set up for this project yet. Use the settings from another project, or enter new ones for this one.`
                : `${name} needs a few settings before it can connect. They are kept for this project only.`));
            const settings = el('app-plugin-settings', { plugin: info.id });
            settings.addEventListener('plugin-settings-changed', () => t.load());
            box.appendChild(settings);
            t.replaceChildren(box);
        },
        showError(message) {
            const t = this;
            const alert = el('webui-alert', { theme: 'danger', show: true }, message);
            const retry = el('webui-button', { theme: 'secondary' }, 'Try again');
            retry.addEventListener('click', () => t.load());
            t.replaceChildren(el('webui-flex', { column: true, gap: 'var(--padding)' }));
            t.firstChild.append(alert, retry);
        },
        /** Draws a node from another plugin call, such as a branch card, without loading a page. */
        showNode(node, plugin, page) {
            const t = this;
            t._staticNode = true;
            t.setAttribute('plugin', plugin);
            if (page) t.setAttribute('page', page);
            t._params = {};
            t.draw(node);
        },
        draw(node) {
            const t = this;
            t._node = node;
            t._ctx = 'page';
            t.replaceChildren(t.build(node));
            t.syncToggles(t);
        },
        /**
         * Builds a node. Actions from what it builds answer to where it was built: the page, or the dialog. `t._ctx`
         * says which while building, and each handler keeps the one it was built in.
         */
        build(node) {
            const t = this;
            const ctx = t._ctx;
            if (!node || typeof node !== 'object') return document.createDocumentFragment();
            switch (node.type) {
                case 'stack': {
                    const box = el('webui-flex', { column: true, gap: 'var(--padding)', class: 'plugin-stack' });
                    (node.children || []).forEach(child => box.appendChild(t.build(child)));
                    return box;
                }
                case 'row':
                case 'toolbar': {
                    const box = el('webui-flex', { wrap: true, gap: 'var(--padding)', align: 'center', class: node.type === 'toolbar' ? 'plugin-toolbar' : 'plugin-row' });
                    (node.children || []).forEach(child => box.appendChild(t.build(child)));
                    return box;
                }
                case 'heading': {
                    const level = Math.min(Math.max(parseInt(node.level) || 2, 1), 4);
                    return el(`h${level + 1}`, { class: 'plugin-heading' }, node.text);
                }
                case 'text':
                    return el(node.strong ? 'strong' : 'span', { class: node.muted ? 'plugin-muted' : 'plugin-text' }, node.text);
                case 'markdown': {
                    const box = el('div', { class: 'plugin-markdown' });
                    box.innerHTML = sanitizeProjectHtml(webui.parseMarkdown(`${node.text ?? ''}`));
                    return box;
                }
                case 'badge':
                    return el('span', { class: 'plugin-badge', 'data-theme': theme(node.theme) || null }, node.text);
                case 'link': {
                    // No href, since the app's router would take a click on one as a page change.
                    const link = makeButton(el('a', { class: 'plugin-link' }, node.text), node.action?.label);
                    link.addEventListener('click', ev => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        t.run(node.action, undefined, ctx);
                    });
                    return link;
                }
                case 'button':
                    return t.buildButton(node, ctx);
                case 'properties': {
                    const list = el('dl', { class: 'plugin-properties' });
                    (node.items || []).forEach(item => {
                        list.appendChild(el('dt', {}, item.label));
                        const value = el('dd');
                        value.appendChild(t.build(item.value));
                        list.appendChild(value);
                    });
                    return list;
                }
                case 'table':
                    return t.buildTable(node, ctx);
                case 'select':
                    return t.buildSelect(node, ctx);
                case 'clip':
                    return t.buildClip(node, ctx);
                case 'section': {
                    const details = el('details', { class: 'plugin-section' });
                    const summary = el('summary');
                    // Toggled here, since a drawer stops the default action that opens a details element.
                    summary.addEventListener('click', ev => {
                        ev.preventDefault();
                        details.open = !details.open;
                    });
                    summary.appendChild(el('strong', {}, node.title));
                    if (node.subtitle) summary.appendChild(el('span', { class: 'plugin-muted' }, node.subtitle));
                    details.appendChild(summary);
                    const body = el('webui-flex', { column: true, gap: 'var(--padding)', class: 'plugin-section-body' });
                    (node.children || []).forEach(child => body.appendChild(t.build(child)));
                    details.appendChild(body);
                    details.open = t.savedOpen(node.key, !!node.open);
                    details.addEventListener('toggle', () => t.saveOpen(node.key, !!node.open, details.open));
                    return details;
                }
                case 'panel': {
                    const panel = el('webui-flex', { column: true, gap: 'var(--padding)', class: 'plugin-panel', 'data-panel': node.key });
                    (node.children || []).forEach(child => panel.appendChild(t.build(child)));
                    panel.hidden = !t.savedOpen(`panel:${node.key}`, !!node.open);
                    panel._defaultOpen = !!node.open;
                    return panel;
                }
                case 'inputs': {
                    // Fields placed among a form's children. Outside a form they show, but nothing sends them.
                    const box = el('div', { class: 'plugin-inputs' });
                    const readers = t._formReaders || [];
                    (node.fields || []).forEach(field => t.addField(box, field, readers, ctx));
                    return box;
                }
                case 'form':
                    return t.buildForm(node, ctx);
                case 'notice':
                    return el('webui-alert', { theme: theme(node.theme) || 'info', show: true }, node.text);
                case 'empty':
                    return el('p', { class: 'plugin-empty' }, node.text);
                default:
                    // A node type from a newer plugin, so the rest of the page still shows.
                    return el('span', { class: 'plugin-muted' }, `(This version of Task Proxy cannot show "${node.type}".)`);
            }
        },
        buildButton(node, ctx) {
            const t = this;
            const button = el('webui-button', { theme: theme(node.theme) || 'secondary', 'start-icon': node.action?.icon || null });
            button.appendChild(el('span', {}, node.action?.label ?? ''));
            if (node.action?.host?.type === 'toggle') {
                button.dataset.toggles = `${node.action.host.key ?? ''}`;
                button.classList.add('plugin-toggle');
            }
            button.addEventListener('click', () => t.run(node.action, undefined, ctx));
            return button;
        },
        buildTable(node, ctx) {
            const t = this;
            const table = el('table', { class: 'plugin-table' });
            const head = el('tr');
            (node.columns || []).forEach(column => {
                const info = typeof column === 'string' ? { label: column } : (column || {});
                const th = el('th', {}, info.label ?? '');
                if (info.sort === 'asc' || info.sort === 'desc') {
                    th.setAttribute('aria-sort', info.sort === 'asc' ? 'ascending' : 'descending');
                    th.appendChild(el('span', { class: 'plugin-sort', 'aria-hidden': 'true' }, info.sort === 'asc' ? ' ▲' : ' ▼'));
                }
                if (info.action) {
                    th.classList.add('plugin-sortable');
                    makeButton(th, info.action.label);
                    th.addEventListener('click', () => t.run(info.action, undefined, ctx));
                }
                head.appendChild(th);
            });
            table.appendChild(el('thead')).appendChild(head);
            const body = table.appendChild(el('tbody'));
            (node.rows || []).forEach(row => {
                const tr = el('tr');
                (row.cells || []).forEach(cell => tr.appendChild(el('td')).appendChild(t.build(cell)));
                if (row.action) {
                    tr.classList.add('plugin-clickable');
                    makeButton(tr, row.action.label);
                    tr.addEventListener('click', ev => {
                        if (ev.target.closest('a, webui-button, button, [role="button"]:not(tr)')) return;
                        t.run(row.action, undefined, ctx);
                    });
                }
                body.appendChild(tr);
            });
            // Wide tables scroll on their own, rather than widening the page.
            const wrap = el('div', { class: 'plugin-table-wrap' });
            wrap.appendChild(table);
            return wrap;
        },
        /** A value changed in place: its choices load from the plugin when it is clicked. */
        buildSelect(node, ctx) {
            const t = this;
            const button = el('button', { type: 'button', class: 'plugin-select', 'data-theme': theme(node.theme) || null, 'aria-haspopup': 'listbox', 'aria-expanded': 'false', title: node.action?.label || null });
            button.append(el('span', { class: 'plugin-select-text' }, node.text), el('span', { class: 'plugin-select-arrow', 'aria-hidden': 'true' }, '▾'));
            button.addEventListener('click', async ev => {
                ev.stopPropagation();
                if (t._running) return;
                const result = await t.ask(node.options);
                const options = result?.options;
                if (!Array.isArray(options)) return;
                if (!options.length) {
                    webui.alert('There is nothing to change it to.', 'info');
                    return;
                }
                showMenu(button, options, `${node.text ?? ''}`, choice => t.run(node.action, { value: `${choice.value}` }, ctx));
            });
            return button;
        },
        /** Text cut short, with the rest in a tooltip and a click away. */
        buildClip(node, ctx) {
            const t = this;
            const text = `${node.text ?? ''}`;
            const chars = [...text];
            const max = Math.max(parseInt(node.max) || 30, 1);
            const tip = Math.max(parseInt(node.tip) || 100, max);
            const cut = chars.length > max;
            const span = el('span', { class: node.muted ? 'plugin-clip plugin-muted' : 'plugin-clip' }, cut ? `${chars.slice(0, max).join('').trimEnd()}...` : text);
            if (cut) span.title = chars.length > tip ? `${chars.slice(0, tip).join('').trimEnd()}...` : text;
            if (node.action && (cut || node.always)) {
                span.classList.add('plugin-clip-open');
                makeButton(span, node.action.label);
                span.addEventListener('click', ev => {
                    ev.stopPropagation();
                    t.run(node.action, undefined, ctx);
                });
            }
            return span;
        },
        /** Whether a section or panel is open: as the user left it, or as the plugin starts it. */
        savedOpen(key, fallback) {
            const saved = ((webui.getData(sectionsKey) || {})[this.plugin] || {})[key];
            return typeof saved === 'boolean' ? saved : fallback;
        },
        saveOpen(key, fallback, open) {
            // Setting open while building also fires toggle, which is not the user's choice.
            if (this.savedOpen(key, fallback) === open) return;
            const all = structuredClone(webui.getData(sectionsKey) || {});
            all[this.plugin] = { ...(all[this.plugin] || {}), [key]: open };
            webui.setData(sectionsKey, all);
        },
        /** Shows or hides the panels with this key, and marks the buttons that toggle them. */
        togglePanel(key, ctx) {
            const t = this;
            const root = ctx === 'dialog' && t._dialog ? t._dialog.body : t;
            const panels = [...root.querySelectorAll('.plugin-panel')].filter(panel => panel.dataset.panel === key);
            if (!panels.length) return;
            const open = panels[0].hidden;
            panels.forEach(panel => { panel.hidden = !open; });
            t.saveOpen(`panel:${key}`, panels[0]._defaultOpen, open);
            t.syncToggles(root);
            if (open) panels[0].querySelector('textarea, input, select')?.focus?.();
        },
        syncToggles(root) {
            const panels = [...root.querySelectorAll('.plugin-panel')];
            root.querySelectorAll('.plugin-toggle').forEach(button => {
                const panel = panels.find(item => item.dataset.panel === button.dataset.toggles);
                const open = !!panel && !panel.hidden;
                button.setAttribute('aria-pressed', open ? 'true' : 'false');
                button.classList.toggle('plugin-toggle-on', open);
            });
        },
        /** Adds one field to a form, and how to read its value to `readers`. */
        addField(container, field, readers, ctx) {
            const t = this;
            const name = field.name;
            const value = field.value;
            let input;
            switch (field.kind) {
                case 'hidden':
                    readers.push(() => [name, value]);
                    return;
                case 'checkbox': {
                    const label = el('label', { class: 'plugin-checkbox', title: field.help || null });
                    const box = el('input', { type: 'checkbox', name });
                    box.checked = value === true || value === 'true';
                    label.append(box, el('span', {}, field.label));
                    container.appendChild(label);
                    readers.push(() => [name, box.checked]);
                    return;
                }
                case 'multiselect': {
                    const group = el('fieldset', { class: 'plugin-choices' });
                    group.appendChild(el('legend', {}, field.label));
                    const chosen = Array.isArray(value) ? value.map(String) : [];
                    const boxes = (field.options || []).map(option => {
                        const label = el('label', { class: 'plugin-checkbox' });
                        const box = el('input', { type: 'checkbox', value: option.value });
                        box.checked = chosen.includes(`${option.value}`);
                        label.append(box, el('span', {}, option.label));
                        group.appendChild(label);
                        return box;
                    });
                    container.appendChild(group);
                    readers.push(() => [name, boxes.filter(box => box.checked).map(box => box.value)]);
                    return;
                }
                case 'select': {
                    input = el('webui-dropdown', { label: escape(field.label), title: field.help || null });
                    // The dropdown escapes what it shows, so labels are passed as they are.
                    const options = (field.options || []).map(option => ({ id: `${option.value}`, value: `${option.value}`, display: `${option.label ?? ''}` }));
                    input.setAttribute('options', JSON.stringify(options));
                    const chosen = value !== undefined && value !== null && value !== '' ? `${value}` : options[0]?.value;
                    if (chosen !== undefined) input.setAttribute('value', chosen);
                    break;
                }
                case 'textarea':
                case 'text':
                    if (field.suggest) {
                        container.appendChild(t.mentionField(field, readers, ctx));
                        return;
                    }
                    if (field.kind === 'textarea') {
                        input = el('webui-input-message', { label: escape(field.label), name, placeholder: field.placeholder || null, title: field.help || null });
                        if (typeof value === 'string' && value) input.setAttribute('value', value);
                        break;
                    }
                // Falls through for plain text.
                default:
                    input = el('webui-input-text', {
                        label: escape(field.label), name,
                        type: field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : null,
                        placeholder: field.placeholder || null,
                        title: field.help || null
                    });
                    if (value !== undefined && value !== null && value !== '') input.setAttribute('value', `${value}`);
            }
            input.dataset.field = name;
            container.appendChild(input);
            if (field.help && field.kind !== 'select') container.appendChild(el('small', { class: 'plugin-muted' }, field.help));
            readers.push(() => [name, input.value ?? '']);
        },
        /**
         * Text that suggests people to mention: typing @ and a few letters asks the plugin, and a picked one is
         * written as @ and its name. The form also sends `<name>.mentions`, each name written with its value.
         */
        mentionField(field, readers, ctx) {
            const t = this;
            const wrap = el('label', { class: 'plugin-mention-field' });
            wrap.appendChild(el('span', { class: 'plugin-field-label' }, field.label));
            const area = el(field.kind === 'text' ? 'input' : 'textarea', { name: field.name, placeholder: field.placeholder || null, title: field.help || null, rows: field.kind === 'text' ? null : 4, autocomplete: 'off', spellcheck: 'true' });
            area.value = typeof field.value === 'string' ? field.value : '';
            wrap.appendChild(area);
            const picked = new Map();
            let asked = 0;
            let timer = null;
            const query = () => {
                const before = area.value.slice(0, area.selectionStart ?? area.value.length);
                const match = before.match(/(?:^|[\s(])@([^\s@]{0,30}(?: [^\s@]{0,30})?)$/);
                return match ? { text: match[1], start: before.length - match[1].length - 1 } : null;
            };
            const suggest = () => {
                clearTimeout(timer);
                const found = query();
                if (!found) {
                    closeMenu();
                    return;
                }
                timer = setTimeout(async () => {
                    const ask = ++asked;
                    const action = { ...field.suggest, params: { ...(field.suggest.params || {}), query: found.text } };
                    const result = await t.ask(action, true);
                    // Typing on while the plugin answered makes this answer old.
                    if (ask !== asked || !Array.isArray(result?.options)) return;
                    if (!result.options.length) {
                        closeMenu();
                        return;
                    }
                    showMenu(area, result.options, '', choice => {
                        const now = query();
                        if (!now) return;
                        const text = `@${choice.label}`;
                        const end = area.selectionStart ?? area.value.length;
                        area.value = `${area.value.slice(0, now.start)}${text} ${area.value.slice(end)}`;
                        const caret = now.start + text.length + 1;
                        area.setSelectionRange(caret, caret);
                        picked.set(text, `${choice.value}`);
                        area.focus();
                    }, { keepFocus: true });
                }, 200);
            };
            area.addEventListener('input', suggest);
            area.addEventListener('keydown', ev => {
                if (openMenu?.owner === area && menuKey(ev)) ev.preventDefault();
            });
            area.addEventListener('blur', () => setTimeout(() => { if (openMenu?.owner === area && !openMenu.list.matches(':hover')) closeMenu(); }, 150));
            readers.push(() => [field.name, area.value]);
            readers.push(() => {
                const used = {};
                picked.forEach((value, text) => { if (area.value.includes(text)) used[text] = value; });
                return [`${field.name}.mentions`, used];
            });
            if (field.help) wrap.appendChild(el('small', { class: 'plugin-muted' }, field.help));
            return wrap;
        },
        buildForm(node, ctx) {
            const t = this;
            // A form with one short field sits on one line with its button.
            const shown = (node.fields || []).filter(field => field.kind !== 'hidden');
            const extra = (node.buttons || []).length || (node.children || []).length;
            const inline = !extra && shown.length <= 1 && !shown.some(field => ['textarea', 'multiselect', 'checkbox'].includes(field.kind) || field.suggest);
            const form = el('form', { class: inline ? 'plugin-form plugin-form-inline' : 'plugin-form' });
            const readers = [];
            (node.fields || []).forEach(field => t.addField(form, field, readers, ctx));
            const actions = el('webui-flex', { gap: 'var(--padding)', wrap: true, align: 'center', class: 'plugin-form-actions' });
            (node.buttons || []).forEach(button => actions.appendChild(t.build(button)));
            const submit = el('webui-button', { theme: 'primary', 'start-icon': node.submit?.icon || null });
            submit.appendChild(el('span', {}, node.submit?.label ?? 'Submit'));
            actions.appendChild(submit);
            if (node.cancel) {
                const cancel = el('webui-button', { theme: 'secondary' });
                cancel.appendChild(el('span', {}, node.cancel.label ?? 'Cancel'));
                cancel.addEventListener('click', () => t.run(node.cancel, undefined, ctx));
                actions.appendChild(cancel);
            }
            form.appendChild(actions);
            // Fields among the children are sent with this form.
            const outer = t._formReaders;
            t._formReaders = readers;
            try {
                (node.children || []).forEach(child => form.appendChild(t.build(child)));
            } finally {
                t._formReaders = outer;
            }
            const fields = [...(node.fields || []), ...collectFields(node.children)];
            const send = () => {
                const values = Object.fromEntries(readers.map(read => read()));
                const missing = fields.find(field => field.required && field.kind !== 'checkbox' && `${values[field.name] ?? ''}`.trim() === '');
                if (missing) {
                    webui.alert(`${escape(missing.label || missing.name)} is required.`, 'warning');
                    return;
                }
                t.run(node.submit, values, ctx);
            };
            submit.addEventListener('click', send);
            form.addEventListener('submit', ev => {
                ev.preventDefault();
                send();
            });
            return form;
        },
        /** Asks the plugin for something, such as choices, and returns its answer without acting on it. */
        async ask(action, quiet) {
            const t = this;
            if (!action) return null;
            const request = { page: t.page || '', pageParams: t._params || {}, action: action.id, params: action.params || {}, form: {} };
            let error = null;
            const result = await webui.proxy.plugins.action(t.plugin, request, err => { error = `${err}`; });
            if (error) {
                if (!quiet) webui.alert(escape(error), 'danger');
                return null;
            }
            return result || {};
        },
        /** Runs an action: Task Proxy's own when it names one, otherwise the plugin's. */
        async run(action, form, ctx = 'page') {
            const t = this;
            if (!action || t._running) return;
            if (!await confirmFirst(action.confirm)) return;
            t._running = true;
            t.classList.add('plugin-busy');
            t._dialog?.box.classList.add('plugin-busy');
            try {
                if (action.host) {
                    await t.runHost(action.host, ctx);
                    return;
                }
                const request = { page: t.page || '', pageParams: t._params || {}, action: action.id, params: action.params || {}, form: form || {} };
                let error = null;
                const result = await webui.proxy.plugins.action(t.plugin, request, err => { error = `${err}`; });
                if (error) {
                    webui.alert(escape(error), 'danger');
                    return;
                }
                t.apply(result || {}, ctx);
            } finally {
                t._running = false;
                t.classList.remove('plugin-busy');
                t._dialog?.box.classList.remove('plugin-busy');
            }
        },
        apply(result, ctx = 'page') {
            const t = this;
            if (result.message?.text) webui.alert(escape(result.message.text), theme(result.message.theme) || 'info');
            const inDialog = ctx === 'dialog' && t._dialog;
            if (result.closeDialog || (result.navigate && t._dialog)) t.closeDialog();
            if (result.navigate) {
                const url = pageUrl(t.plugin, result.navigate.page, result.navigate.params);
                const samePage = !t._staticNode && url.split('?')[0] === t.path();
                webui.navigateTo(url);
                // The app only loads a page when its path changes, so a new query for this page is loaded here.
                if (samePage && location.pathname === t.path()) t.load();
                return;
            }
            if (result.dialog) t.openDialog(result.dialog);
            if (result.ui) {
                if (inDialog && !result.closeDialog) t.drawDialog(result.ui);
                else if (!inDialog) {
                    t.draw(result.ui);
                    return;
                }
            }
            if (result.refresh && !t._staticNode) t.load();
            if (result.refresh && t._staticNode) t.dispatchEvent(new CustomEvent('plugin-refresh', { bubbles: true }));
        },
        /** Opens a plugin's dialog over the page. Its actions answer to it, and closing it changes nothing. */
        openDialog(dialog) {
            const t = this;
            if (!t._dialog) {
                const box = el('dialog', { class: 'plugin-ui plugin-dialog' });
                const header = el('header', { class: 'plugin-dialog-header' });
                const title = el('h3', { class: 'plugin-heading' });
                const close = el('button', { type: 'button', class: 'plugin-dialog-close', 'aria-label': 'Close' }, '✕');
                close.addEventListener('click', () => t.closeDialog());
                header.append(title, close);
                const body = el('div', { class: 'plugin-dialog-body' });
                box.append(header, body);
                box.addEventListener('cancel', ev => {
                    ev.preventDefault();
                    t.closeDialog();
                });
                box.addEventListener('click', ev => {
                    if (ev.target === box) t.closeDialog();
                });
                document.body.appendChild(box);
                t._dialog = { box, title, body };
            }
            t._dialog.title.textContent = `${dialog.title ?? ''}`;
            t.drawDialog(dialog.ui);
            if (!t._dialog.box.open) t._dialog.box.showModal();
        },
        drawDialog(node) {
            const t = this;
            if (!t._dialog) return;
            const outer = t._ctx;
            t._ctx = 'dialog';
            try {
                t._dialog.body.replaceChildren(t.build(node));
            } finally {
                t._ctx = outer;
            }
            t.syncToggles(t._dialog.body);
            t._dialog.body.querySelector('textarea, input:not([type="hidden"])')?.focus();
        },
        closeDialog() {
            const t = this;
            closeMenu();
            if (!t._dialog) return;
            t._dialog.box.close?.();
            t._dialog.box.remove();
            t._dialog = null;
        },
        async runHost(host, ctx) {
            const t = this;
            switch (host.type) {
                case 'toggle':
                    t.togglePanel(`${host.key ?? ''}`, ctx);
                    return;
                case 'openSettings':
                    document.querySelector('app-plugins-drawer')?.open(t.plugin);
                    return;
                case 'copy':
                    await navigator.clipboard.writeText(`${host.text ?? ''}`);
                    webui.alert('Copied.', 'success');
                    return;
                default: {
                    let error = null;
                    const message = await webui.proxy.plugins.hostAction(t.plugin, host, err => { error = `${err}`; });
                    if (error) {
                        webui.alert(escape(error), 'danger');
                        return;
                    }
                    if (message) webui.alert(escape(message), 'success');
                }
            }
        }
    });
}
