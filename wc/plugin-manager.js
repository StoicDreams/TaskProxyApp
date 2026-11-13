/*
 * The plugin manager, in the Plugins drawer: installed plugins, what each may reach, their settings, and installing one from a folder.
 * Settings are kept per project by app-plugin-settings, saved encrypted for that plugin alone, so project pages and
 * scripts cannot read them, and secret values never come back to this window.
 */
"use strict"
{
    const escape = text => webui.escapeForHTML(`${text ?? ''}`);
    const gitPermissions = {
        currentBranch: 'Read the current branch',
        createBranch: 'Create a branch when you click its button',
    };

    function el(tag, attrs, text) {
        const node = document.createElement(tag);
        Object.entries(attrs || {}).forEach(([name, value]) => {
            if (value === undefined || value === null || value === false) return;
            node.setAttribute(name, value === true ? '' : `${value}`);
        });
        if (text !== undefined) node.textContent = `${text}`;
        return node;
    }

    /**
     * Opens and closes its section on click. The right drawer stops the default action of clicks inside it,
     * which is what opens a details element.
     */
    function toggles(summary, details) {
        summary.addEventListener('click', ev => {
            ev.preventDefault();
            details.open = !details.open;
        });
        return summary;
    }

    function button(label, theme, icon) {
        const btn = el('webui-button', { theme, 'start-icon': icon || null });
        btn.appendChild(el('span', {}, label));
        return btn;
    }

    /** What a plugin may reach, in plain words, as list items. */
    function permissionList(manifest) {
        const list = el('ul', { class: 'plugin-permissions' });
        const add = text => list.appendChild(el('li', {}, text));
        const permissions = manifest.permissions || {};
        if ((permissions.hosts || []).length) add(`Connect to ${permissions.hosts.join(', ')}`);
        if ((permissions.variables || []).length) add(`Read its settings: ${permissions.variables.map(v => v.label || v.key).join(', ')}`);
        (permissions.git || []).forEach(git => add(gitPermissions[git] || git));
        add(`Save its own data, and files in the open project's .taskproxy/plugins/${manifest.id} folder`);
        return list;
    }

    /** Asks before installing, showing what the plugin will be able to do. Folder installs are not signed. */
    function confirmInstall(manifest, signed) {
        const warning = signed
            ? '<p>Signed by Stoic Dreams.</p>'
            : '<webui-alert theme="warning" show>This plugin is installed from a folder, so it is not signed by Stoic Dreams. Only install plugins you trust.</webui-alert>';
        const content = `<p><strong>${escape(manifest.name)} ${escape(manifest.version)}</strong></p>
            <p>${escape(manifest.description)}</p>
            <p>It will be able to:</p>
            ${permissionList(manifest).outerHTML}
            ${warning}`;
        return new Promise(resolve => {
            let confirmed = false;
            webui.dialog({
                title: 'Install plugin?',
                content,
                confirm: 'Install',
                cancel: 'Cancel',
                onconfirm: () => { confirmed = true; return true; },
                onclose: () => resolve(confirmed),
            }).catch(() => resolve(false));
        });
    }

    /** Whether version a is newer than b, both as 1.2.3. */
    function isNewer(a, b) {
        const parts = version => `${version}`.split('.').map(part => parseInt(part) || 0);
        const [x, y] = [parts(a), parts(b)];
        for (let i = 0; i < 3; i++) {
            if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
        }
        return false;
    }

    webui.define("app-plugin-manager", {
        preload: 'app:plugin-page app:plugin-settings input-text button alert',
        constructor() {
            const t = this;
            t._load = 0;
        },
        connected() {
            const t = this;
            t.load();
        },
        disconnected() {
            this._load++;
        },
        async load() {
            const t = this;
            const load = ++t._load;
            await whenProxyReady();
            const [plugins, catalog] = await Promise.all([webui.proxy.plugins.refreshNav(), webui.proxy.plugins.catalog()]);
            if (load !== t._load) return;
            t.render(plugins || [], catalog);
        },
        render(plugins, catalog) {
            const t = this;
            const top = el('webui-flex', { wrap: true, gap: 'var(--padding)', align: 'center', class: 'plugin-manager-actions' });
            const install = button('Install from folder', 'primary', 'folder-open');
            install.addEventListener('click', () => t.installFromFolder());
            top.appendChild(install);
            top.appendChild(el('span', { class: 'plugin-muted' }, 'For plugins you build yourself: choose the folder with plugin.json and plugin.wasm.'));
            const list = el('webui-flex', { column: true, gap: 'calc(var(--padding) * 2)', class: 'plugin-list' });
            if (!plugins.length) {
                list.appendChild(el('p', { class: 'plugin-empty' }, 'No plugins are installed yet.'));
            }
            plugins.forEach(plugin => list.appendChild(t.renderPlugin(plugin)));
            t.replaceChildren(el('h3', {}, 'Installed'), list, t.renderCatalog(catalog, plugins), top);
            const wanted = t.getAttribute('plugin');
            const card = wanted && t.querySelector(`[data-plugin="${CSS.escape(wanted)}"]`);
            if (card) {
                card.classList.add('plugin-highlight');
                card.querySelector('details')?.setAttribute('open', '');
                card.scrollIntoView({ block: 'start' });
            }
        },
        /** The catalog's plugins, to install or update. */
        renderCatalog(catalog, plugins) {
            const t = this;
            const box = el('webui-flex', { column: true, gap: 'var(--padding)', class: 'plugin-catalog' });
            box.appendChild(el('h3', {}, 'Available'));
            if (!catalog) {
                box.appendChild(el('p', { class: 'plugin-empty' }, 'The plugin catalog could not be reached. Check your connection and open Plugins again.'));
                return box;
            }
            if (!catalog.length) {
                box.appendChild(el('p', { class: 'plugin-empty' }, 'No plugins are published yet.'));
                return box;
            }
            catalog.forEach(entry => {
                const installed = plugins.find(plugin => plugin.id === entry.id);
                const card = el('section', { class: 'plugin-card', 'data-catalog': entry.id });
                const head = el('webui-flex', { wrap: true, gap: 'var(--padding)', align: 'center' });
                head.appendChild(el('strong', {}, entry.name));
                head.appendChild(el('span', { class: 'plugin-muted' }, `v${entry.version}`));
                card.appendChild(head);
                if (entry.description) card.appendChild(el('p', {}, entry.description));
                const update = installed && isNewer(entry.version, installed.version);
                if (installed && !update) {
                    card.appendChild(el('span', { class: 'plugin-badge', 'data-theme': 'success' }, 'Installed'));
                } else {
                    const action = button(update ? `Update to v${entry.version}` : 'Install', 'primary', update ? 'refresh' : 'download');
                    action.addEventListener('click', () => t.installFromCatalog(entry));
                    card.appendChild(action);
                }
                box.appendChild(card);
            });
            return box;
        },
        async installFromCatalog(entry) {
            const t = this;
            if (!await confirmInstall({ ...entry, permissions: entry.permissions || {} }, true)) return;
            const installed = await webui.proxy.plugins.installCatalog(entry.id);
            if (!installed) return;
            webui.alert(`${escape(entry.name)} ${escape(entry.version)} is installed.`, 'success');
            t.load();
        },
        renderPlugin(plugin) {
            const t = this;
            const card = el('section', { class: 'plugin-card', 'data-plugin': plugin.id });
            const manifest = plugin.manifest;
            const head = el('webui-flex', { wrap: true, gap: 'var(--padding)', align: 'center' });
            head.appendChild(el('h3', {}, manifest?.name || plugin.id));
            head.appendChild(el('span', { class: 'plugin-muted' }, `v${plugin.version}`));
            head.appendChild(el('span', { class: 'plugin-badge', 'data-theme': plugin.signed ? 'success' : 'warning' }, plugin.signed ? 'Signed' : 'From a folder'));
            if (!plugin.enabled) head.appendChild(el('span', { class: 'plugin-badge' }, 'Turned off'));
            card.appendChild(head);
            if (!manifest) {
                card.appendChild(el('webui-alert', { theme: 'danger', show: true }, plugin.error || 'This plugin cannot be read.'));
            } else {
                if (manifest.description) card.appendChild(el('p', {}, manifest.description));
                card.appendChild(el('strong', {}, 'It can:'));
                card.appendChild(permissionList(manifest));
            }
            const actions = el('webui-flex', { wrap: true, gap: 'var(--padding)' });
            const toggle = button(plugin.enabled ? 'Turn off' : 'Turn on', 'secondary', plugin.enabled ? 'pause' : 'play');
            toggle.addEventListener('click', async () => {
                if (await webui.proxy.plugins.setEnabled(plugin.id, !plugin.enabled)) t.load();
            });
            const remove = button('Remove', 'danger', 'trash-can');
            remove.addEventListener('click', () => {
                webui.dialog.confirm(`Remove ${escape(manifest?.name || plugin.id)}, with its settings and saved data?`, async () => {
                    if (await webui.proxy.plugins.remove(plugin.id)) {
                        webui.alert(`${escape(manifest?.name || plugin.id)} was removed.`, 'success');
                        t.load();
                    }
                    return true;
                });
            });
            actions.append(toggle, remove);
            card.appendChild(actions);
            if (manifest && (manifest.permissions?.variables || []).length) {
                const details = el('details', { class: 'plugin-section' });
                const summary = toggles(el('summary'), details);
                summary.appendChild(el('strong', {}, 'Settings for this project'));
                details.appendChild(summary);
                const body = el('webui-flex', { column: true, gap: 'var(--padding)', class: 'plugin-section-body' });
                details.appendChild(body);
                details.addEventListener('toggle', () => {
                    if (details.open && !body.firstChild) body.appendChild(el('app-plugin-settings', { plugin: plugin.id }));
                });
                card.appendChild(details);
            }
            return card;
        },
        async installFromFolder() {
            const t = this;
            const folder = await webui.proxy.plugins.pickFolder();
            if (!folder) return;
            const manifest = await webui.proxy.plugins.inspectFolder(folder);
            if (!manifest) return;
            if (!await confirmInstall(manifest, false)) return;
            const installed = await webui.proxy.plugins.installFolder(folder);
            if (!installed) return;
            webui.alert(`${escape(manifest.name)} ${escape(manifest.version)} is installed.`, 'success');
            t.load();
        }
    });
}
