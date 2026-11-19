/*
 * The plugin manager, in the Plugins drawer, in three tabs. Installed and Available each list their plugins beside
 * the one chosen, in a webui-split-panes, so the list stays short however many plugins there are: an installed
 * plugin shows what it may reach, its actions, and its settings for the open project, and a catalog plugin what it
 * would reach and its Install or Update button. From a folder installs a plugin built by hand.
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

    const TAB_KEY = 'session-plugins-tab-index';
    const INSTALLED_TAB = 0;

    /** A plugin's name, as its manifest gives it or its id when it can't be read. */
    const nameOf = plugin => plugin.manifest?.name || plugin.name || plugin.id;

    webui.define("app-plugin-manager", {
        preload: 'app:plugin-page app:plugin-settings input-text button alert tabs split-panes icon badge',
        constructor() {
            const t = this;
            t._load = 0;
            t._chosen = { installed: null, available: null };
        },
        connected() {
            const t = this;
            // Opened on one plugin, the drawer shows it on the Installed tab.
            if (t.getAttribute('plugin')) {
                t._chosen.installed = t.getAttribute('plugin');
                webui.setData(TAB_KEY, INSTALLED_TAB);
            }
            t.build();
            t.load();
        },
        disconnected() {
            this._load++;
        },
        /** The tabs and their panes, made once, so reloading the lists keeps the tab and how the panes are sized. */
        build() {
            const t = this;
            const tabs = el('webui-tabs', { theme: 'secondary', 'transition-timing': '200', class: 'plugin-tabs', 'data-subscribe': `${TAB_KEY}:setTab` });
            const tab = (label, icon, name) => {
                const btn = el('webui-button', { slot: 'tabs', 'start-icon': icon, class: `plugin-tab-${name}` });
                btn.appendChild(el('span', {}, label));
                const content = el('webui-content', { slot: 'content', nodetach: true, class: `plugin-tab-content plugin-${name}` });
                tabs.append(btn, content);
                return { btn, content };
            };
            const installed = tab('Installed', 'cloud_puzzle-piece', 'installed');
            const available = tab('Available', 'download', 'available');
            const folder = tab('From a folder', 'folder-open', 'folder');
            t._tabs = { installed, available, folder };
            t._panes = {
                installed: t.splitPane(installed.content, 'Installed plugins'),
                available: t.splitPane(available.content, 'Available plugins'),
            };
            folder.content.appendChild(t.renderFolder());
            t.replaceChildren(tabs);
        },
        /**
         * A list of plugins beside the one chosen. Too narrow for both, the chosen one covers the list, and the strip
         * beside it goes back to the list.
         */
        splitPane(content, listLabel) {
            const split = el('webui-split-panes', { class: 'plugin-split-list', fill: true, min: '220', ratio: '0.35', show: 'end', 'start-label': listLabel, 'end-label': 'Details' });
            const list = el('div', { slot: 'start', class: 'plugin-picker', role: 'listbox', 'aria-label': listLabel });
            const detail = el('div', { slot: 'end', class: 'plugin-detail' });
            split.append(list, detail);
            content.appendChild(split);
            return { split, list, detail };
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
            t._plugins = plugins;
            t._catalog = catalog;
            const updates = (catalog || []).filter(entry => {
                const installed = plugins.find(plugin => plugin.id === entry.id);
                return installed && !entry.incompatible && isNewer(entry.version, installed.version);
            });
            t._updates = new Map(updates.map(entry => [entry.id, entry]));
            t._tabs.installed.btn.querySelector('span').textContent = `Installed (${plugins.length})`;
            t._tabs.available.btn.querySelector('span').textContent = updates.length
                ? `Available (${updates.length === 1 ? '1 update' : `${updates.length} updates`})`
                : 'Available';
            t.renderInstalled();
            t.renderAvailable();
        },
        /** A row of a plugin list: its icon, name, and what state it is in. */
        listItem(pane, kind, id, icon, name, version, states) {
            const t = this;
            const chosen = t._chosen[kind] === id;
            const row = el('button', { type: 'button', role: 'option', class: 'plugin-pick', 'data-pick': id, 'aria-selected': chosen ? 'true' : 'false' });
            row.appendChild(el('webui-icon', { icon: icon || 'cloud_puzzle-piece', 'aria-hidden': 'true' }));
            const text = el('span', { class: 'plugin-pick-text' });
            const title = el('span', { class: 'plugin-pick-name' });
            title.appendChild(el('strong', {}, name));
            if (version) title.appendChild(el('span', { class: 'plugin-muted' }, ` v${version}`));
            text.appendChild(title);
            const badges = el('span', { class: 'plugin-pick-states' });
            states.filter(Boolean).forEach(([label, theme]) => badges.appendChild(el('webui-badge', { class: 'plugin-badge', theme: theme || null }, label)));
            text.appendChild(badges);
            row.appendChild(text);
            row.addEventListener('click', () => {
                t._chosen[kind] = id;
                kind === 'installed' ? t.renderInstalled() : t.renderAvailable();
                pane.split.showPane?.('end', true);
            });
            return row;
        },
        renderInstalled() {
            const t = this;
            const pane = t._panes.installed;
            const plugins = t._plugins || [];
            if (!plugins.some(plugin => plugin.id === t._chosen.installed)) t._chosen.installed = plugins[0]?.id || null;
            if (!plugins.length) {
                pane.list.replaceChildren(el('p', { class: 'plugin-empty' }, 'No plugins are installed yet.'));
                const help = el('webui-flex', { column: true, gap: 'var(--padding)' });
                help.appendChild(el('p', {}, 'Plugins add integrations to Task Proxy, such as Jira. Install one from the Available tab.'));
                pane.detail.replaceChildren(help);
                return;
            }
            pane.list.replaceChildren(...plugins.map(plugin => t.listItem(pane, 'installed', plugin.id, plugin.manifest?.icon, nameOf(plugin), plugin.version, [
                !plugin.manifest && ['Can\'t be read', 'danger'],
                plugin.manifest && !plugin.enabled && ['Turned off'],
                plugin.manifest && plugin.enabled && (plugin.configured ? ['Set up here', 'success'] : ['Not set up here', 'info']),
                t._updates.has(plugin.id) && ['Update', 'primary'],
            ])));
            const plugin = plugins.find(item => item.id === t._chosen.installed);
            pane.detail.replaceChildren(t.renderPlugin(plugin));
        },
        renderPlugin(plugin) {
            const t = this;
            const card = el('section', { class: 'plugin-card', 'data-plugin': plugin.id });
            if (t.getAttribute('plugin') === plugin.id) card.classList.add('plugin-highlight');
            const manifest = plugin.manifest;
            const head = el('webui-flex', { wrap: true, gap: 'var(--padding)', align: 'center' });
            head.appendChild(el('h3', {}, nameOf(plugin)));
            head.appendChild(el('span', { class: 'plugin-muted' }, `v${plugin.version}`));
            head.appendChild(el('webui-badge', { class: 'plugin-badge', theme: plugin.signed ? 'success' : 'warning' }, plugin.signed ? 'Signed' : 'From a folder'));
            if (!plugin.enabled) head.appendChild(el('webui-badge', { class: 'plugin-badge' }, 'Turned off'));
            card.appendChild(head);
            if (!manifest) {
                card.appendChild(el('webui-alert', { theme: 'danger', show: true }, plugin.error || 'This plugin cannot be read.'));
            } else if (manifest.description) {
                card.appendChild(el('p', {}, manifest.description));
            }
            const actions = el('webui-flex', { wrap: true, gap: 'var(--padding)', class: 'plugin-actions' });
            const update = t._updates.get(plugin.id);
            if (update) {
                const updateButton = button(`Update to v${update.version}`, 'primary', 'refresh');
                updateButton.addEventListener('click', () => t.installFromCatalog(update));
                actions.appendChild(updateButton);
            }
            const toggle = button(plugin.enabled ? 'Turn off' : 'Turn on', 'secondary', plugin.enabled ? 'pause' : 'play');
            toggle.addEventListener('click', async () => {
                if (await webui.proxy.plugins.setEnabled(plugin.id, !plugin.enabled)) t.load();
            });
            const remove = button('Remove', 'danger', 'trash');
            remove.addEventListener('click', () => {
                webui.dialog.confirm(`Remove ${escape(nameOf(plugin))}, with its settings and saved data?`, async () => {
                    if (await webui.proxy.plugins.remove(plugin.id)) {
                        webui.alert(`${escape(nameOf(plugin))} was removed.`, 'success');
                        t.load();
                    }
                    return true;
                });
            });
            actions.append(toggle, remove);
            card.appendChild(actions);
            if (manifest) {
                // Each project is set up for a plugin on its own, so it only shows in the projects that use it.
                const project = el('section', { class: 'plugin-project' });
                const title = el('webui-flex', { wrap: true, gap: '0.25em 1em', align: 'baseline' });
                title.appendChild(el('h4', {}, (manifest.permissions?.variables || []).length ? 'Settings for this project' : 'Use in this project'));
                title.appendChild(el('span', { class: 'plugin-muted', 'data-role': 'project-state' }, plugin.configured ? 'Set up' : 'Not set up'));
                project.append(title, el('app-plugin-settings', { plugin: plugin.id }));
                card.appendChild(project);
                card.appendChild(el('h4', {}, 'It can'));
                card.appendChild(permissionList(manifest));
            }
            return card;
        },
        renderAvailable() {
            const t = this;
            const pane = t._panes.available;
            const catalog = t._catalog;
            const plugins = t._plugins || [];
            if (!catalog || !catalog.length) {
                const text = catalog ? 'No plugins are published yet.' : 'The plugin catalog could not be reached. Check your connection and open Plugins again.';
                pane.list.replaceChildren(el('p', { class: 'plugin-empty', 'data-role': 'catalog-state' }, text));
                pane.detail.replaceChildren();
                return;
            }
            if (!catalog.some(entry => entry.id === t._chosen.available)) t._chosen.available = catalog[0].id;
            pane.list.replaceChildren(...catalog.map(entry => {
                const installed = plugins.find(plugin => plugin.id === entry.id);
                return t.listItem(pane, 'available', entry.id, entry.icon, entry.name, entry.version, [
                    entry.incompatible && ['Needs an update', 'warning'],
                    !entry.incompatible && t._updates.has(entry.id) && ['Update', 'primary'],
                    !entry.incompatible && installed && !t._updates.has(entry.id) && ['Installed', 'success'],
                ]);
            }));
            pane.detail.replaceChildren(t.renderEntry(catalog.find(entry => entry.id === t._chosen.available), plugins));
        },
        /** A catalog plugin, with what it would reach, and its Install or Update button. */
        renderEntry(entry, plugins) {
            const t = this;
            const installed = plugins.find(plugin => plugin.id === entry.id);
            const card = el('section', { class: 'plugin-card', 'data-catalog': entry.id });
            const head = el('webui-flex', { wrap: true, gap: 'var(--padding)', align: 'center' });
            head.appendChild(el('h3', {}, entry.name));
            head.appendChild(el('span', { class: 'plugin-muted' }, `v${entry.version}`));
            card.appendChild(head);
            if (entry.description) card.appendChild(el('p', {}, entry.description));
            const update = installed && isNewer(entry.version, installed.version);
            if (entry.incompatible) {
                // No listed version supports a plugin spec this app runs, so it says which side to update.
                card.appendChild(el('p', { class: 'plugin-muted', 'data-role': 'incompatible' }, entry.incompatible));
            } else if (installed && !update) {
                card.appendChild(el('webui-badge', { class: 'plugin-badge', theme: 'success', 'data-role': 'installed' }, `Installed (v${installed.version})`));
            } else {
                const action = button(update ? `Update to v${entry.version}` : 'Install', 'primary', update ? 'refresh' : 'download');
                action.addEventListener('click', () => t.installFromCatalog(entry));
                card.appendChild(action);
            }
            if (entry.permissions) {
                card.appendChild(el('h4', {}, installed ? 'It can' : 'It would be able to'));
                card.appendChild(permissionList({ ...entry, permissions: entry.permissions }));
            }
            return card;
        },
        renderFolder() {
            const t = this;
            const box = el('webui-flex', { column: true, gap: 'var(--padding)', class: 'plugin-manager-actions' });
            box.appendChild(el('p', {}, 'For plugins you build yourself: choose the folder with plugin.json and plugin.wasm. A plugin installed from a folder is not signed by Stoic Dreams, so only install plugins you trust.'));
            const install = button('Install from folder', 'primary', 'folder-open');
            install.addEventListener('click', () => t.installFromFolder());
            const row = el('webui-flex', { wrap: true, gap: 'var(--padding)' });
            row.appendChild(install);
            box.appendChild(row);
            return box;
        },
        async installFromCatalog(entry) {
            const t = this;
            if (!await confirmInstall({ ...entry, permissions: entry.permissions || {} }, true)) return;
            const installed = await webui.proxy.plugins.installCatalog(entry.id);
            if (!installed) return;
            webui.alert(`${escape(entry.name)} ${escape(entry.version)} is installed.`, 'success');
            t._chosen.installed = entry.id;
            t.load();
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
            // The new plugin shows where its settings are.
            t._chosen.installed = manifest.id;
            webui.setData(TAB_KEY, INSTALLED_TAB);
            t.load();
        }
    });
}
