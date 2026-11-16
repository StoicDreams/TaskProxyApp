/*
 * Draws a plugin's page. Plugins describe their screens as data (see the SDK's ui.rs in TaskProxyPlugins), and this
 * builds them from Task Proxy's own components, so no plugin code runs in this window. Plugin text is always set as
 * text or escaped, and markdown is sanitized like project pages.
 *
 * <app-plugin-page plugin="jira" page="issues"></app-plugin-page> renders that page with the address's query as params.
 * showNode(node, plugin) draws a node without loading a page, as the Git Controller does for branch cards.
 * A navigate result with `side` opens that page beside this one, in a split the user resizes (showSide).
 */
"use strict"
{
    const themes = new Set(['primary', 'secondary', 'tertiary', 'info', 'success', 'warning', 'danger']);
    const theme = value => themes.has(value) ? value : '';
    const escape = text => webui.escapeForHTML(`${text ?? ''}`);
    /** The larger copy of an image shown while the pointer is over it. One is shared, since one shows at a time. */
    let hoverPreview;
    function hideHoverPreview() {
        hoverPreview?.remove();
    }
    // The image moves away from the preview when the page scrolls.
    window.addEventListener('scroll', hideHoverPreview, true);
    /** A data URI's bytes, read here since the app's content policy lets no fetch read data or blob addresses. */
    function blobOf(dataUri) {
        const [head, data] = `${dataUri}`.split(',', 2);
        const type = /^data:([^;,]+)/.exec(head)?.[1] || 'application/octet-stream';
        const bytes = Uint8Array.from(atob(data || ''), char => char.charCodeAt(0));
        return new Blob([bytes], { type });
    }
    /** An image as a PNG, which is what other apps take from the clipboard. */
    async function pngOf(blob) {
        if (blob.type === 'image/png') return blob;
        const bitmap = await createImageBitmap(blob);
        const canvas = el('canvas', { width: bitmap.width, height: bitmap.height });
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        return new Promise((resolve, reject) => canvas.toBlob(png => png ? resolve(png) : reject(new Error('The image could not be read.')), 'image/png'));
    }
    async function copyImage(blob) {
        try {
            // A promise, so the copy keeps the click that started it while the PNG is made.
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngOf(blob) })]);
            webui.alert('Copied the image.', 'success');
        } catch (error) {
            webui.alert(`The image could not be copied: ${escape(error?.message || error)}`, 'danger');
        }
    }
    /**
     * Makes a markdown image show larger while the pointer is over it, and open in a dialog when clicked, or with
     * Enter or Space, where it can be copied. Its source is a checked data URI.
     */
    function showsLarger(img) {
        img.classList.add('plugin-image');
        img.tabIndex = 0;
        img.setAttribute('role', 'button');
        img.title = 'Open the image larger';
        img.addEventListener('mouseenter', () => {
            hoverPreview ??= el('img', { class: 'plugin-image-hover', alt: '' });
            hoverPreview.src = img.src;
            document.body.appendChild(hoverPreview);
            const box = img.getBoundingClientRect();
            // Beside the image, on whichever side has more room, and kept inside the window.
            const right = window.innerWidth - box.right;
            const roomWide = Math.max(160, Math.min(Math.max(right, box.left) - 24, window.innerWidth * 0.6));
            const roomHigh = Math.max(160, window.innerHeight * 0.8);
            // Sized here, since the page's styles for images would otherwise shrink it. As large as fits, up to the
            // image's own size, and always well above the size shown in the description.
            const natural = { width: img.naturalWidth || box.width, height: img.naturalHeight || box.height };
            const larger = Math.max(1, (box.height * 3) / natural.height);
            const scale = Math.min(roomWide / natural.width, roomHigh / natural.height, larger);
            const width = Math.round(natural.width * scale);
            const height = Math.round(natural.height * scale);
            Object.assign(hoverPreview.style, {
                width: `${width}px`,
                height: `${height}px`,
                maxWidth: 'none',
                maxHeight: 'none',
                left: right >= box.left ? `${box.right + 8}px` : '',
                right: right >= box.left ? '' : `${window.innerWidth - box.left + 8}px`,
                top: `${Math.max(8, Math.min(box.top, window.innerHeight - height - 8))}px`,
            });
        });
        img.addEventListener('mouseleave', hideHoverPreview);
        const open = () => {
            hideHoverPreview();
            // A blob address rather than the data URI, which the webview's own Copy Image handles better.
            const blob = blobOf(img.src);
            const src = URL.createObjectURL(blob);
            // Styled here, since the dialog's content is outside the app's stylesheet.
            const box = el('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:0.5em;' });
            const full = el('img', { class: 'plugin-image-full', src, alt: img.alt || '', style: 'display:block;height:60vh;max-height:none;width:auto;max-width:90vw;margin:auto;object-fit:contain;' });
            const copy = el('button', { type: 'button', class: 'plugin-image-copy', style: 'display:inline-flex;align-items:center;gap:0.4em;padding:0.3em 0.8em;font:inherit;cursor:pointer;' });
            copy.append(el('webui-icon', { icon: 'copy', 'aria-hidden': 'true' }), el('span', {}, 'Copy image'));
            copy.addEventListener('click', ev => {
                ev.preventDefault();
                copyImage(blob);
            });
            box.append(full, copy);
            webui.dialog({
                title: img.alt || 'Image',
                content: box,
                confirm: 'Close',
                onclose: () => setTimeout(() => URL.revokeObjectURL(src), 1000),
            }).catch(() => { });
        };
        img.addEventListener('click', ev => {
            ev.preventDefault();
            ev.stopPropagation();
            open();
        });
        img.addEventListener('keydown', ev => {
            if (ev.key !== 'Enter' && ev.key !== ' ') return;
            ev.preventDefault();
            open();
        });
    }
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

    /** A page's params as its address would carry them, for a page shown beside another, which has no address. */
    function paramsOf(plugin, page, params) {
        return Object.fromEntries(new URLSearchParams(pageUrl(plugin, page, params).split('?')[1] || ''));
    }

    /**
     * Pages drawn before, by project, plugin, page, and params, so going back to one shows it at once while it is
     * loaded again in the background. The oldest are dropped first.
     */
    const pageCache = new Map();
    const PAGE_CACHE_SIZE = 40;
    function cacheKey(plugin, page, params) {
        const project = webui.getData('app-current-project')?.value ?? '';
        const sorted = Object.keys(params || {}).sort().map(key => [key, params[key]]);
        return JSON.stringify([project, plugin, page, sorted]);
    }
    function cachePage(key, node) {
        pageCache.delete(key);
        pageCache.set(key, node);
        while (pageCache.size > PAGE_CACHE_SIZE) pageCache.delete(pageCache.keys().next().value);
    }

    /** The element that scrolls the page, which a split fills. */
    function scrollBox(node) {
        let at = node;
        while (at) {
            at = at.assignedSlot || at.parentElement || at.getRootNode?.().host;
            if (at?.nodeType === Node.ELEMENT_NODE && /^(auto|scroll)$/.test(getComputedStyle(at).overflowY)) return at;
        }
        return null;
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
        // Content of a webui.dialog is slotted into webui-dialogs, so a child added there shows in its dialog.
        (owner.closest('dialog, webui-dialogs') || document.body).appendChild(list);
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
                if (!t._staticNode && !t._sideOf && location.pathname === t.path()) t.load();
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
        /** Where the page is drawn: the split's own side while a page shows beside it, or the element itself. */
        content() {
            return this._split?.main || this;
        },
        /** The address of this page, without its query. */
        path() {
            return pageUrl(this.plugin, this.page);
        },
        /**
         * Loads the page from the plugin and draws it. A page drawn before shows straight away from the cache, and
         * is drawn again only if the plugin's answer changed.
         */
        async load() {
            const t = this;
            const load = ++t._load;
            const plugin = t.plugin;
            const page = t.page;
            // A page beside another has no address, so its params are kept on it.
            t._params = t._sideOf ? { ...t._sideParams } : readParams();
            const key = cacheKey(plugin, page, t._params);
            const content = t.content();
            const cached = pageCache.get(key);
            // Drawn from the cache, the plugin's answer only replaces it if it changed. Otherwise, such as for a
            // refresh, the answer is drawn.
            const fromCache = !!cached && t._shownKey !== key;
            if (fromCache) t.draw(cached, key);
            else if (!content.firstChild) content.replaceChildren(el('webui-flex', { align: 'center', gap: 'var(--padding)' }, 'Loading…'));
            // A plugin's settings belong to projects, so one not set up for this project shows how to set it up.
            const plugins = await webui.proxy.plugins.list(() => undefined);
            if (load !== t._load) return;
            const info = (plugins || []).find(item => item.id === plugin);
            t._info = info;
            if (info && !info.configured) {
                t.showSetup(info);
                return;
            }
            // The page the user left open beside this one opens again, such as the issue they were reading.
            if (!t._split && !t._sideOf && !t._staticNode) {
                const side = t.savedSide();
                if (side) t.showSide(side.page, side.params);
            }
            let error = null;
            const node = await webui.proxy.plugins.render(plugin, page, t._params, err => { error = `${err}`; });
            if (load !== t._load) return;
            if (error) {
                // A page showing from the cache stays, and says it could not be brought up to date.
                if (fromCache && t._shownKey === key) webui.alert(escape(error), 'danger');
                else t.showError(error);
                return;
            }
            const same = fromCache && t._shownKey === key && JSON.stringify(cached) === JSON.stringify(node);
            cachePage(key, node);
            if (same) return;
            if (fromCache) t.drawWhenIdle(node, key, load);
            else t.draw(node, key);
        },
        /**
         * Draws a page that loaded in the background. While the user is typing in it, that waits until they leave the
         * field, so what they typed is not lost.
         */
        drawWhenIdle(node, key, load) {
            const t = this;
            const content = t.content();
            const active = document.activeElement;
            const typing = t._shownKey === key && active && content.contains(active) && active.matches('input, textarea, select, [contenteditable]');
            if (!typing) {
                t.draw(node, key);
                return;
            }
            active.addEventListener('focusout', () => {
                if (load === t._load && t.isConnected) t.draw(node, key);
            }, { once: true });
        },
        /** Asks for the plugin's settings for this project, then shows the page once they are saved. */
        showSetup(info) {
            const t = this;
            const name = info.manifest?.name || info.id;
            const project = webui.getData('app-current-project')?.display || 'this project';
            const box = el('webui-flex', { column: true, gap: 'var(--padding)', class: 'plugin-setup' });
            box.appendChild(el('h3', { class: 'plugin-heading' }, `Set up ${name} for ${project}`));
            const needsSettings = (info.manifest?.permissions?.variables || []).length > 0;
            box.appendChild(el('p', {}, !needsSettings
                ? `${name} is not turned on for this project.`
                : info.signIns > 0
                    ? `${name} is not set up for this project yet. Use the settings from another project, or enter new ones for this one.`
                    : `${name} needs a few settings before it can connect. They are kept for this project only.`));
            const settings = el('app-plugin-settings', { plugin: info.id });
            settings.addEventListener('plugin-settings-changed', () => t.load());
            box.appendChild(settings);
            t._shownKey = null;
            t.content().replaceChildren(box);
        },
        showError(message) {
            const t = this;
            const alert = el('webui-alert', { theme: 'danger', show: true }, message);
            const retry = el('webui-button', { theme: 'secondary' }, 'Try again');
            retry.addEventListener('click', () => t.load());
            const box = el('webui-flex', { column: true, gap: 'var(--padding)' });
            box.append(alert, retry);
            t._shownKey = null;
            t.content().replaceChildren(box);
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
        draw(node, key = null) {
            const t = this;
            t._node = node;
            // Which cached page is shown. A plugin's ui result is not a cached page.
            t._shownKey = key;
            t._ctx = 'page';
            const content = t.content();
            content.replaceChildren(t.build(node));
            t.syncToggles(content);
            // A reorder list moved from the keyboard keeps focus on the item that moved, after the plugin redraws.
            const refocus = t._refocus;
            t._refocus = null;
            if (refocus) {
                [...content.querySelectorAll('.plugin-reorder-item')].find(item => item.dataset.id === refocus)
                    ?.querySelector('.plugin-reorder-handle')?.focus();
            }
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
                case 'markdown':
                    return t.buildMarkdown(node);
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
                        const label = el('dt', {}, item.label);
                        list.appendChild(label);
                        const value = el('dd');
                        const shown = t.build(item.value);
                        value.appendChild(shown);
                        if (item.edit) {
                            // Clicking the label switches between the value and its editor.
                            const editor = el('div', { class: 'plugin-property-edit' });
                            editor.appendChild(t.build(item.edit));
                            editor.hidden = true;
                            value.appendChild(editor);
                            const toggle = makeButton(el('a', { class: 'plugin-link plugin-property-label', 'aria-expanded': 'false', title: `Edit ${item.label ?? ''}` }, item.label));
                            toggle.addEventListener('click', ev => {
                                ev.preventDefault();
                                const editing = editor.hidden;
                                editor.hidden = !editing;
                                if (shown.nodeType === Node.ELEMENT_NODE) shown.hidden = editing;
                                toggle.setAttribute('aria-expanded', `${editing}`);
                                if (editing) editor.querySelector('textarea, input:not([type="hidden"])')?.focus?.();
                            });
                            label.replaceChildren(toggle);
                        }
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
                case 'reorder':
                    return t.buildReorder(node, ctx);
                case 'notice':
                    return el('webui-alert', { theme: theme(node.theme) || 'info', show: true }, node.text);
                case 'empty':
                    return el('p', { class: 'plugin-empty' }, node.text);
                default:
                    // A node type from a newer plugin, so the rest of the page still shows.
                    return el('span', { class: 'plugin-muted' }, `(This version of Task Proxy cannot show "${node.type}".)`);
            }
        },
        /**
         * Sanitized markdown. Its images come only from the node's `images`, as data URIs, so a plugin cannot load
         * anything from the web. With `toggle`, a switch shows the markdown as written instead.
         */
        buildMarkdown(node) {
            const box = el('div', { class: 'plugin-markdown' });
            box.innerHTML = sanitizeProjectHtml(webui.parseMarkdown(`${node.text ?? ''}`));
            const images = node.images && typeof node.images === 'object' ? node.images : {};
            box.querySelectorAll('img').forEach(img => {
                const uri = images[img.getAttribute('src') ?? ''];
                if (typeof uri === 'string' && /^data:image\/(png|jpe?g|gif|webp|bmp|avif);base64,[a-z0-9+/=]+$/i.test(uri)) {
                    img.src = uri;
                    showsLarger(img);
                } else {
                    img.remove();
                }
            });
            if (!node.toggle) return box;
            const wrap = el('div', { class: 'plugin-markdown-wrap' });
            const raw = el('pre', { class: 'plugin-markdown-raw' }, `${node.text ?? ''}`);
            raw.hidden = true;
            const mode = makeButton(el('a', { class: 'plugin-link plugin-markdown-mode', 'aria-pressed': 'false' }, 'Show raw'));
            mode.addEventListener('click', ev => {
                ev.preventDefault();
                const showRaw = raw.hidden;
                raw.hidden = !showRaw;
                box.hidden = showRaw;
                mode.textContent = showRaw ? 'Show rendered' : 'Show raw';
                mode.setAttribute('aria-pressed', `${showRaw}`);
            });
            wrap.append(mode, box, raw);
            return wrap;
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
                // A themed row is tinted, as Jira's bugs are, over its stripe.
                const tr = el('tr', { 'data-theme': theme(row.theme) || null });
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
            const span = el('span', { class: node.muted ? 'plugin-clip plugin-muted' : 'plugin-clip', 'data-theme': theme(node.theme) || null }, cut ? `${chars.slice(0, max).join('').trimEnd()}...` : text);
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
            const root = ctx === 'dialog' && t._dialog ? t._dialog.body : t.content();
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
            // A plugin can also ask for every field and button in one row.
            const form = el('form', { class: node.inline === true ? 'plugin-form plugin-form-inline plugin-form-row' : inline ? 'plugin-form plugin-form-inline' : 'plugin-form' });
            const readers = [];
            (node.fields || []).forEach(field => t.addField(form, field, readers, ctx));
            const actions = el('webui-flex', { gap: 'var(--padding)', wrap: true, align: 'center', class: 'plugin-form-actions' });
            (node.buttons || []).forEach(button => actions.appendChild(t.build(button)));
            const submit = el('webui-button', { theme: 'primary', 'start-icon': node.submit?.icon || null });
            const submitText = el('span', {}, node.submit?.label ?? 'Submit');
            submit.appendChild(submitText);
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
            // With `changed`, the button runs it once any field differs from what the form was drawn with, such as
            // Search, and `submit` otherwise, such as Refresh.
            const valuesNow = () => JSON.stringify(readers.map(read => read()));
            let drawn = null;
            let changed = false;
            const current = () => changed && node.changed ? node.changed : node.submit;
            if (node.changed) {
                // Read just before the user first changes anything, once the fields' components have their values.
                const snapshot = () => { drawn ??= valuesNow(); };
                form.addEventListener('focusin', snapshot, true);
                form.addEventListener('pointerdown', snapshot, true);
                const check = () => {
                    if (drawn === null) return;
                    const now = valuesNow() !== drawn;
                    if (now === changed) return;
                    changed = now;
                    const action = current();
                    submitText.textContent = action?.label ?? 'Submit';
                    if (action?.icon) submit.setAttribute('start-icon', action.icon);
                    else submit.removeAttribute('start-icon');
                };
                ['input', 'change', 'keyup', 'click'].forEach(name => form.addEventListener(name, () => setTimeout(check), true));
            }
            const send = () => {
                const values = Object.fromEntries(readers.map(read => read()));
                const missing = fields.find(field => field.required && field.kind !== 'checkbox' && `${values[field.name] ?? ''}`.trim() === '');
                if (missing) {
                    webui.alert(`${escape(missing.label || missing.name)} is required.`, 'warning');
                    return;
                }
                t.run(current(), values, ctx);
            };
            submit.addEventListener('click', send);
            form.addEventListener('submit', ev => {
                ev.preventDefault();
                send();
            });
            return form;
        },
        /**
         * Items put in order by dragging, or with Alt+Up and Alt+Down, using the app's drag and drop, as user pages
         * and the navigation manager do. Once the order settles it runs the node's action with the ids as `order`.
         */
        buildReorder(node, ctx) {
            const t = this;
            const list = el('div', { class: 'plugin-reorder', role: 'list' });
            const rows = [];
            const order = () => [...list.children].filter(row => row.classList.contains('plugin-reorder-item')).map(row => row.dataset.id);
            let saved = null;
            let timer = null;
            const changed = row => {
                // Moving an item blurs it, so the item is focused again once the plugin redraws. Several quick moves
                // from the keyboard are sent as one.
                t._refocus = row.dataset.id;
                clearTimeout(timer);
                timer = setTimeout(() => {
                    const now = order();
                    if (now.join('\n') === saved.join('\n')) return;
                    saved = now;
                    t.run(node.action, { order: now }, ctx);
                }, 400);
            };
            const dragNDrop = getDragNDropSetup(() => rows.filter(row => row.isConnected));
            (node.items || []).forEach(item => {
                const row = el('div', { class: 'plugin-reorder-item drag-handle', role: 'listitem', 'data-id': `${item.id ?? ''}` });
                const label = (item.children || []).find(child => child?.type === 'text')?.text ?? `${item.id ?? ''}`;
                row.appendChild(el('span', {
                    class: 'plugin-reorder-handle', tabindex: 0,
                    'aria-label': `${label}. Drag, or press Alt+Up or Alt+Down, to move it.`,
                    title: 'Drag, or press Alt+Up or Alt+Down, to move',
                }, '⠿'));
                const body = el('webui-flex', { wrap: true, gap: 'var(--padding)', align: 'center', class: 'plugin-reorder-body' });
                (item.children || []).forEach(child => body.appendChild(t.build(child)));
                row.appendChild(body);
                list.appendChild(row);
                rows.push(row);
                dragNDrop(row, () => changed(row));
            });
            saved = order();
            return list;
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
                    // A form submitted with a host action fills that action's own fields, such as a branch's name.
                    const host = { ...action.host };
                    if (form && typeof form === 'object') {
                        Object.keys(host).filter(key => key !== 'type' && key in form).forEach(key => host[key] = form[key]);
                    }
                    await t.runHost(host, ctx);
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
                const target = result.navigate;
                // A page shown beside another opens what it navigates to in its place, except the other page itself.
                if (t._sideOf) {
                    if (target.page === t._sideOf.page) t._sideOf.apply({ navigate: { page: target.page, params: target.params } });
                    else t._sideOf.showSide(target.page, target.params);
                    return;
                }
                if (target.side === true && !t._staticNode) {
                    t.showSide(target.page, target.params);
                    return;
                }
                const url = pageUrl(t.plugin, target.page, target.params);
                const samePage = !t._staticNode && url.split('?')[0] === t.path();
                // The address it is already at, such as a search run again unchanged, loads again without a new
                // history entry, so Back still leaves the page.
                const here = new URL(url, location.origin);
                if (samePage && here.pathname === location.pathname && here.search === location.search) {
                    t.load();
                    return;
                }
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
            // A change made beside the page, such as an issue's status, shows in the page too.
            if (result.refresh && t._sideOf) t._sideOf.load();
            if (result.refresh && t._staticNode) t.dispatchEvent(new CustomEvent('plugin-refresh', { bubbles: true }));
        },
        /**
         * Shows another of the plugin's pages beside this one, in a webui-split-panes whose bar resizes them. When the
         * window is too narrow for both, the side page covers this one, and a full height button on each switches
         * between them.
         */
        showSide(page, params) {
            const t = this;
            if (!t._split) t.openSplit();
            const side = t._split.page;
            side._sideParams = paramsOf(t.plugin, page, params);
            side.setAttribute('page', page);
            side._queueLoad();
            t.saveSide({ page, params: side._sideParams });
            t._split.split.setAttribute('end-label', t.pageName(page));
            t.focusSplit('side');
        },
        /** A page's name from the plugin's manifest. */
        pageName(page) {
            return (this._info?.manifest?.pages || []).find(item => item.id === page)?.name || page;
        },
        /** Puts the page in the start side of a webui-split-panes, and another page of the plugin in its end side. */
        openSplit() {
            const t = this;
            const box = scrollBox(t);
            // The page keeps where it was scrolled to, now inside its own side.
            const scrolled = box ? Math.max(0, box.scrollTop - (t.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop)) : 0;
            const split = el('webui-split-panes', { class: 'plugin-split', fill: true, ratio: `${t.savedSplit()}`, show: 'end', 'start-label': t.pageName(t.page), 'end-label': '' });
            const main = el('div', { slot: 'start', class: 'plugin-split-main' });
            main.append(...t.childNodes);
            const side = el('div', { slot: 'end', class: 'plugin-split-side' });
            const tools = el('div', { class: 'plugin-split-tools' });
            const tool = (icon, label, run) => {
                const button = el('button', { type: 'button', class: 'plugin-split-tool', title: label, 'aria-label': label });
                button.appendChild(el('webui-icon', { icon, 'aria-hidden': 'true' }));
                button.addEventListener('click', run);
                return button;
            };
            const page = el('app-plugin-page', { plugin: t.plugin, class: 'plugin-split-page' });
            page._sideOf = t;
            tools.append(
                tool('expand', 'Open as its own page', () => {
                    t.saveSide(null);
                    webui.navigateTo(pageUrl(t.plugin, page.page, page._sideParams));
                }),
                tool('xmark', 'Close', () => t.closeSplit()),
            );
            side.append(tools, page);
            split.append(main, side);
            // Saved when the user resizes the sides. Changes in the page's own fields bubble up here too.
            split.addEventListener('change', ev => {
                if (ev.target === split && typeof ev.detail?.ratio === 'number') t.saveSplit(ev.detail.ratio);
            });
            t.replaceChildren(split);
            t.classList.add('plugin-split-on');
            t._split = { split, main, page };
            if (scrolled) t.restoreScroll(split, scrolled);
        },
        /** Scrolls the start side once the component has drawn and sized it. */
        async restoreScroll(split, top) {
            await customElements.whenDefined('webui-split-panes');
            for (let frame = 0; frame < 30; frame++) {
                const pane = split.shadowRoot?.querySelector('.start');
                if (pane && split.style.height && pane.scrollHeight > pane.clientHeight) {
                    pane.scrollTop = top;
                    return;
                }
                await new Promise(resolve => requestAnimationFrame(resolve));
            }
        },
        closeSplit() {
            const t = this;
            const split = t._split;
            if (!split) return;
            split.page.closeDialog();
            t.saveSide(null);
            t._split = null;
            t.classList.remove('plugin-split-on');
            t.replaceChildren(...split.main.childNodes);
        },
        /** Which side shows while the window is too narrow for both. */
        focusSplit(which) {
            this._split?.split.setAttribute('show', which === 'side' ? 'end' : 'start');
        },
        savedSplit() {
            const saved = ((webui.getData(sectionsKey) || {})[this.plugin] || {})['split:ratio'];
            return typeof saved === 'number' && saved > 0 && saved < 1 ? saved : 0.5;
        },
        /** Where the page beside this one is remembered: by plugin, then by project and page. */
        sideKey() {
            const project = webui.getData('app-current-project')?.value ?? '';
            return `side:${project}:${this.page}`;
        },
        /** The page left open beside this one, as {page, params}, or null. */
        savedSide() {
            const saved = ((webui.getData(sectionsKey) || {})[this.plugin] || {})[this.sideKey()];
            return saved && typeof saved.page === 'string' && saved.page ? saved : null;
        },
        saveSide(side) {
            const key = this.sideKey();
            const all = structuredClone(webui.getData(sectionsKey) || {});
            const mine = { ...(all[this.plugin] || {}) };
            if (JSON.stringify(mine[key] ?? null) === JSON.stringify(side)) return;
            if (side) mine[key] = side;
            else delete mine[key];
            all[this.plugin] = mine;
            webui.setData(sectionsKey, all);
        },
        saveSplit(ratio) {
            const all = structuredClone(webui.getData(sectionsKey) || {});
            all[this.plugin] = { ...(all[this.plugin] || {}), 'split:ratio': ratio };
            webui.setData(sectionsKey, all);
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
