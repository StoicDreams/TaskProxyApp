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
            t._queueLoad();
        },
        disconnected() {
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
        /** Loads the page from the plugin and draws it. */
        async load() {
            const t = this;
            const load = ++t._load;
            const plugin = t.plugin;
            const page = t.page;
            t._params = readParams();
            if (!t.firstChild) t.replaceChildren(el('webui-flex', { align: 'center', gap: 'var(--padding)' }, 'Loading…'));
            let error = null;
            const node = await webui.proxy.plugins.render(plugin, page, t._params, err => { error = `${err}`; });
            if (load !== t._load) return;
            if (error) {
                t.showError(error);
                return;
            }
            t.draw(node);
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
            t.replaceChildren(t.build(node));
        },
        build(node) {
            const t = this;
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
                        t.run(node.action);
                    });
                    return link;
                }
                case 'button': {
                    const button = el('webui-button', { theme: theme(node.theme) || 'secondary', 'start-icon': node.action?.icon || null });
                    button.appendChild(el('span', {}, node.action?.label ?? ''));
                    button.addEventListener('click', () => t.run(node.action));
                    return button;
                }
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
                case 'table': {
                    const table = el('table', { class: 'plugin-table' });
                    const head = el('tr');
                    (node.columns || []).forEach(column => head.appendChild(el('th', {}, column)));
                    table.appendChild(el('thead')).appendChild(head);
                    const body = table.appendChild(el('tbody'));
                    (node.rows || []).forEach(row => {
                        const tr = el('tr');
                        (row.cells || []).forEach(cell => tr.appendChild(el('td')).appendChild(t.build(cell)));
                        if (row.action) {
                            tr.classList.add('plugin-clickable');
                            makeButton(tr, row.action.label);
                            tr.addEventListener('click', ev => {
                                if (ev.target.closest('a, webui-button')) return;
                                t.run(row.action);
                            });
                        }
                        body.appendChild(tr);
                    });
                    return table;
                }
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
                    const saved = (webui.getData(sectionsKey) || {})[t.plugin] || {};
                    details.open = saved[node.key] ?? !!node.open;
                    details.addEventListener('toggle', () => {
                        // Setting open above also fires this, which is not the user's choice.
                        const current = ((webui.getData(sectionsKey) || {})[t.plugin] || {})[node.key] ?? !!node.open;
                        if (current === details.open) return;
                        const all = structuredClone(webui.getData(sectionsKey) || {});
                        all[t.plugin] = { ...(all[t.plugin] || {}), [node.key]: details.open };
                        webui.setData(sectionsKey, all);
                    });
                    return details;
                }
                case 'form':
                    return t.buildForm(node);
                case 'notice':
                    return el('webui-alert', { theme: theme(node.theme) || 'info', show: true }, node.text);
                case 'empty':
                    return el('p', { class: 'plugin-empty' }, node.text);
                default:
                    // A node type from a newer plugin, so the rest of the page still shows.
                    return el('span', { class: 'plugin-muted' }, `(This version of Task Proxy cannot show "${node.type}".)`);
            }
        },
        buildForm(node) {
            const t = this;
            // A form with one short field sits on one line with its button.
            const shown = (node.fields || []).filter(field => field.kind !== 'hidden');
            const inline = shown.length <= 1 && !shown.some(field => ['textarea', 'multiselect', 'checkbox'].includes(field.kind));
            const form = el('form', { class: inline ? 'plugin-form plugin-form-inline' : 'plugin-form' });
            const readers = [];
            (node.fields || []).forEach(field => {
                const name = field.name;
                const value = field.value;
                const help = field.help ? escape(field.help) : null;
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
                        form.appendChild(label);
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
                        form.appendChild(group);
                        readers.push(() => [name, boxes.filter(box => box.checked).map(box => box.value)]);
                        return;
                    }
                    case 'select': {
                        input = el('webui-dropdown', { label: escape(field.label), title: field.help || null });
                        const options = (field.options || []).map(option => ({ id: `${option.value}`, value: `${option.value}`, display: escape(option.label) }));
                        input.setAttribute('options', JSON.stringify(options));
                        const chosen = value !== undefined && value !== null && value !== '' ? `${value}` : options[0]?.value;
                        if (chosen !== undefined) input.setAttribute('value', chosen);
                        break;
                    }
                    case 'textarea':
                        input = el('webui-input-message', { label: escape(field.label), name, placeholder: field.placeholder || null, title: field.help || null });
                        if (typeof value === 'string' && value) input.setAttribute('value', value);
                        break;
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
                form.appendChild(input);
                if (help && field.kind !== 'select') form.appendChild(el('small', { class: 'plugin-muted' }, field.help));
                readers.push(() => [name, input.value ?? '']);
            });
            const actions = el('webui-flex', { gap: 'var(--padding)', class: 'plugin-form-actions' });
            const submit = el('webui-button', { theme: 'primary', 'start-icon': node.submit?.icon || null });
            submit.appendChild(el('span', {}, node.submit?.label ?? 'Submit'));
            actions.appendChild(submit);
            if (node.cancel) {
                const cancel = el('webui-button', { theme: 'secondary' });
                cancel.appendChild(el('span', {}, node.cancel.label ?? 'Cancel'));
                cancel.addEventListener('click', () => t.run(node.cancel));
                actions.appendChild(cancel);
            }
            form.appendChild(actions);
            const send = () => {
                const values = Object.fromEntries(readers.map(read => read()));
                const missing = (node.fields || []).find(field => field.required && field.kind !== 'checkbox' && `${values[field.name] ?? ''}`.trim() === '');
                if (missing) {
                    webui.alert(`${escape(missing.label || missing.name)} is required.`, 'warning');
                    return;
                }
                t.run(node.submit, values);
            };
            submit.addEventListener('click', send);
            form.addEventListener('submit', ev => {
                ev.preventDefault();
                send();
            });
            return form;
        },
        /** Runs an action: Task Proxy's own when it names one, otherwise the plugin's. */
        async run(action, form) {
            const t = this;
            if (!action || t._running) return;
            if (!await confirmFirst(action.confirm)) return;
            t._running = true;
            t.classList.add('plugin-busy');
            try {
                if (action.host) {
                    await t.runHost(action.host);
                    return;
                }
                const request = { page: t.page || '', pageParams: t._params || {}, action: action.id, params: action.params || {}, form: form || {} };
                let error = null;
                const result = await webui.proxy.plugins.action(t.plugin, request, err => { error = `${err}`; });
                if (error) {
                    webui.alert(escape(error), 'danger');
                    return;
                }
                t.apply(result || {});
            } finally {
                t._running = false;
                t.classList.remove('plugin-busy');
            }
        },
        apply(result) {
            const t = this;
            if (result.message?.text) webui.alert(escape(result.message.text), theme(result.message.theme) || 'info');
            if (result.navigate) {
                webui.navigateTo(pageUrl(t.plugin, result.navigate.page, result.navigate.params));
                return;
            }
            if (result.ui) {
                t.draw(result.ui);
                return;
            }
            if (result.refresh && !t._staticNode) t.load();
            if (result.refresh && t._staticNode) t.dispatchEvent(new CustomEvent('plugin-refresh', { bubbles: true }));
        },
        async runHost(host) {
            const t = this;
            switch (host.type) {
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
