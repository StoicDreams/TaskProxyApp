/*
 * The header's Updates icon, left of Save. Clicked, it checks for a newer app and for newer versions of installed
 * plugins, and shows what it found in a dialog, whose Apply Updates installs the plugins first, since they need no
 * restart, then the app, which restarts. With automatic checks turned on in Settings' Application Updates
 * (app-update-auto-check), it checks every 6 hours on its own, and shows what it found as a badge on its icon.
 */
"use strict"
{
    const AUTO_KEY = 'app-update-auto-check';
    /** When updates were last checked for on their own, so a restart doesn't check again sooner than every 6 hours. */
    const LAST_KEY = 'app-update-last-check';
    const EVERY_MS = 6 * 60 * 60 * 1000;
    const ICON = 'refresh|theme:info|fill|backing|bordered';
    const ICON_FOUND = 'download|theme:warning|fill|backing|bordered';

    /** Whether version a is newer than b, both as 1.2.3. */
    function isNewer(a, b) {
        const parts = version => `${version}`.split('.').map(part => parseInt(part) || 0);
        const [x, y] = [parts(a), parts(b)];
        for (let i = 0; i < 3; i++) {
            if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
        }
        return false;
    }

    /**
     * Looks for updates: `{ app, plugins, errors }`, where app is the newer release or null, plugins are the installed
     * plugins with a newer version in the catalog that this app can run, and errors say what couldn't be checked.
     */
    async function findUpdates() {
        const errors = [];
        let failedApp = false;
        const [app, installed, catalog] = await Promise.all([
            webui.proxy.checkUpdate(err => { failedApp = true; errors.push(`Task Proxy couldn't be checked for an update: ${err}`); }),
            webui.proxy.plugins.list(() => undefined),
            webui.proxy.plugins.catalog(),
        ]);
        if ((installed || []).length && !Array.isArray(catalog)) errors.push('The plugin catalog couldn\'t be reached, so plugins weren\'t checked for updates.');
        const plugins = (Array.isArray(catalog) ? catalog : []).flatMap(entry => {
            const plugin = (installed || []).find(item => item.id === entry.id);
            if (!plugin || entry.incompatible || !isNewer(entry.version, plugin.version)) return [];
            return [{ id: entry.id, name: entry.name || plugin.manifest?.name || entry.id, version: entry.version, current: plugin.version }];
        });
        return { app: failedApp ? null : (app || null), plugins, errors };
    }
    const countOf = found => (found?.app ? 1 : 0) + (found?.plugins?.length || 0);

    function escape(text) {
        return webui.escapeForHTML(`${text ?? ''}`);
    }

    webui.define("app-update-button", {
        constructor() {
            const t = this;
            t._found = null;
            t._timer = 0;
        },
        connected() {
            const t = this;
            // A browser using this computer through Remote Connections can't update it.
            if (window.__taskProxyRemote) {
                t.hidden = true;
                return;
            }
            if (t._ready) {
                // Put back, it checks on its own again.
                t.onAutoCheck(webui.getData(AUTO_KEY));
                return;
            }
            t._ready = true;
            makeButton(t, 'Check for updates');
            t._icon = webui.create('webui-icon', { icon: ICON });
            t.appendChild(t._icon);
            t.dataset.subscribe = `${AUTO_KEY}:onAutoCheck`;
            t.addEventListener('click', () => t.checkNow());
        },
        disconnected() {
            clearTimeout(this._timer);
            this._timer = 0;
        },
        /** Automatic checks were turned on or off, here or in Settings. */
        onAutoCheck(value) {
            const t = this;
            clearTimeout(t._timer);
            t._timer = 0;
            if (value !== true && value !== 'true' || window.__taskProxyRemote) return;
            const last = Number(webui.getData(LAST_KEY)) || 0;
            const wait = Math.max(0, last + EVERY_MS - Date.now());
            t._timer = setTimeout(() => t.autoCheck(), wait);
        },
        /** A check on its own: what it finds only shows on the icon. */
        async autoCheck() {
            const t = this;
            t._timer = 0;
            webui.setData(LAST_KEY, Date.now());
            await whenProxyReady();
            const found = await findUpdates();
            if (!t.isConnected) return;
            // A check that couldn't reach anything leaves what was found before.
            if (found.errors.length && !countOf(found)) {
                t.onAutoCheck(webui.getData(AUTO_KEY));
                return;
            }
            t.show(found);
            t.onAutoCheck(webui.getData(AUTO_KEY));
        },
        /** Shows how many updates there are on the icon. */
        show(found) {
            const t = this;
            t._found = found;
            const count = countOf(found);
            t._icon.setAttribute('icon', count ? ICON_FOUND : ICON);
            t._icon.setAttribute('count', count ? `${count}` : '');
            t.classList.toggle('has-updates', count > 0);
            t.setAttribute('title', count ? `${count === 1 ? '1 update' : `${count} updates`} available` : 'Check for updates');
            t.setAttribute('aria-label', t.getAttribute('title'));
        },
        /** Clicked: checks, then says there is nothing, or asks to apply what was found. */
        async checkNow() {
            const t = this;
            if (t._busy) return;
            t._busy = true;
            try {
                await whenProxyReady();
                const found = await findUpdates();
                if (!t.isConnected) return;
                t.show(found);
                // The header has no room by its icons for a message, so what the check found goes in the app's alerts.
                if (!countOf(found)) {
                    if (found.errors.length) found.errors.forEach(error => appAlert(error, 'danger'));
                    else appAlert('No updates available.', 'info');
                    return;
                }
                if (await t.confirm(found)) await t.apply(found);
            } finally {
                t._busy = false;
            }
        },
        /** The dialog listing what was found, which resolves to whether Apply Updates was chosen. */
        confirm(found) {
            const items = [];
            found.plugins.forEach(plugin => items.push(`<li class="update-plugin" data-plugin="${escape(plugin.id)}"><strong>${escape(plugin.name)}</strong> plugin: ${escape(plugin.current)} to ${escape(plugin.version)}</li>`));
            if (found.app) items.push(`<li class="update-app"><strong>Task Proxy</strong>: ${escape(found.app.currentVersion)} to ${escape(found.app.version)}</li>`);
            const restart = found.app
                ? `<p>${found.plugins.length ? 'Plugins are updated first. Then ' : ''}Task Proxy updates and restarts. What you have open is saved first.</p>`
                : '';
            const failed = found.errors.map(error => `<webui-alert theme="warning" show>${escape(error)}</webui-alert>`).join('');
            const content = `<p>These updates are available:</p><ul class="update-list">${items.join('')}</ul>${restart}${failed}`;
            return new Promise(resolve => {
                let confirmed = false;
                webui.dialog({
                    title: 'Updates available',
                    content,
                    confirm: 'Apply Updates',
                    cancel: 'Cancel',
                    onconfirm: () => { confirmed = true; return true; },
                    onclose: () => resolve(confirmed),
                }).catch(() => resolve(false));
            });
        },
        /** Installs the plugins, then the app, which restarts. A failure is said and the rest still go ahead. */
        async apply(found) {
            const t = this;
            const done = [];
            const left = { app: found.app, plugins: [], errors: [] };
            for (const plugin of found.plugins) {
                const installed = await webui.proxy.plugins.installCatalog(plugin.id, err => appAlert(`${plugin.name} couldn't be updated: ${err}`, 'danger'));
                if (installed) done.push(plugin);
                else left.plugins.push(plugin);
            }
            // The dialog has closed, so what was updated goes in the app's alerts.
            if (done.length) appAlert(`Updated ${done.map(plugin => `${plugin.name} to ${plugin.version}`).join(', ')}.`, 'success');
            if (!found.app) {
                t.show(left);
                return;
            }
            appAlert(`Updating Task Proxy to ${found.app.version}. It restarts once the update is installed.`, 'info');
            const result = await webui.proxy.installUpdate(err => appAlert(`Task Proxy couldn't be updated: ${err}`, 'danger'));
            if (!result) {
                t.show(left);
                return;
            }
            t.show({ app: null, plugins: left.plugins, errors: [] });
        },
        shadowTemplate: `
<style type="text/css">
:host {
display:inline-flex;
cursor:pointer;
padding:1px;
align-items:center;
justify-content:center;
}
:host([hidden]) {
display:none;
}
</style>
<slot></slot>
`
    });
}
