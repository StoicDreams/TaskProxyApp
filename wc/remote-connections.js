/*
 * Remote Connections: using this computer's Task Proxy from a browser on www.taskproxy.com, signed in to the same
 * Stoic Dreams account. A new browser must be approved once, after checking its code matches the one on its screen.
 *
 * <app-remote-connections></app-remote-connections> is the panel in Settings: turning it on under a name for this
 * computer, the approved browsers, the browsers waiting to be approved, and what browsers did.
 * <app-remote-connections indicator></app-remote-connections> is the header's button. It shows while a browser is
 * connected or waiting to be approved, and opens the panel. The indicator also raises each notice the backend sends,
 * such as a new browser asking to connect.
 *
 * In a browser connected over Remote Connections the panel shows only the two lists, which is how a new phone is
 * approved away from home. Turning it on or off and changing what a browser may do stay on the computer.
 */
"use strict"
{
    const panels = new Set();
    let listening = false;
    const LEVELS = [
        { value: 'view', display: 'View: look at projects, changes, and runs' },
        { value: 'work', display: 'Work: also edit, set variables, and run trusted scripts' },
        { value: 'commit', display: 'Commit: also commit, pull, push, and change branches' },
    ];

    function el(tag, attrs, text) {
        const node = document.createElement(tag);
        Object.entries(attrs || {}).forEach(([name, value]) => {
            if (value === undefined || value === null || value === false) return;
            node.setAttribute(name, value === true ? '' : `${value}`);
        });
        if (text !== undefined) node.textContent = `${text}`;
        return node;
    }

    function button(label, theme, icon, role) {
        const btn = el('webui-button', { theme, 'start-icon': icon || null, 'data-role': role || null });
        btn.appendChild(el('span', {}, label));
        return btn;
    }

    function choice(label, role, options, value) {
        const input = el('webui-select', { label, 'data-role': role });
        input.setAttribute('options', JSON.stringify(options.map(option => ({ id: `${option.value}`, value: `${option.value}`, display: option.display }))));
        input.setAttribute('value', `${value}`);
        return input;
    }

    const when = ms => ms ? new Date(ms).toLocaleString() : 'never';

    /** A browser's name with its code, which is what people compare across the two screens. */
    function title(browser, extra) {
        const line = el('p', { class: 'remote-browser-name' });
        line.appendChild(el('strong', {}, browser.name));
        line.appendChild(document.createTextNode(' '));
        line.appendChild(el('code', { class: 'remote-code', title: 'Check this code matches the one the browser shows' }, browser.code));
        if (extra) line.appendChild(document.createTextNode(` ${extra}`));
        return line;
    }

    /** Refreshes every panel, and raises a notice in the Alerts panel. */
    function listen() {
        if (listening) return;
        listening = true;
        // whenProxyReady waits however long the app takes to start, where webui.wait gives up after about 10 seconds.
        whenProxyReady().then(proxy => proxy.remoteConnections.onChanged(({ notice }) => {
            if (notice?.text) webui.alert(webui.escapeHtml(notice.text), notice.severity || 'info');
            panels.forEach(panel => panel.load());
        }));
    }

    webui.define("app-remote-connections", {
        preload: 'button select input-text alert icon',
        constructor() {
            this._load = 0;
        },
        connected() {
            const t = this;
            panels.add(t);
            listen();
            if (t.hasAttribute('indicator')) {
                t.hidden = true;
                if (!t._icon) {
                    t._icon = el('webui-icon', { icon: 'mobile|theme:success|fill|backing|bordered', 'aria-hidden': 'true' });
                    t.appendChild(t._icon);
                    t.addEventListener('click', () => webui.dialog({
                        title: 'Remote Connections',
                        minWidth: '80%',
                        content: '<app-remote-connections></app-remote-connections>',
                        cancel: 'Close',
                    }));
                }
            }
            t.load();
        },
        disconnected() {
            panels.delete(this);
            this._load++;
        },
        async load() {
            const t = this;
            const load = ++t._load;
            const proxy = await whenProxyReady();
            if (proxy.remote) {
                // The computer's own indicator is not this browser's to show.
                if (t.hasAttribute('indicator')) return;
                const lists = await proxy.remoteConnections.browsers(() => null);
                if (load !== t._load || !lists) return;
                t.renderLists(lists);
                return;
            }
            const status = await proxy.remoteConnections.status(() => null);
            if (load !== t._load || !status) return;
            if (t.hasAttribute('indicator')) {
                t.showIndicator(status);
            } else {
                t.render(status);
            }
        },
        showIndicator(status) {
            const t = this;
            const connected = status.enabled ? status.approved.filter(browser => browser.connected) : [];
            const waiting = status.enabled ? status.waiting : [];
            t.hidden = connected.length === 0 && waiting.length === 0;
            const parts = [];
            if (waiting.length) parts.push(`${waiting.map(browser => browser.name).join(', ')} waiting to be approved`);
            if (connected.length) parts.push(`${connected.map(browser => browser.name).join(', ')} connected`);
            const title = parts.length ? `Remote Connections: ${parts.join('; ')}` : 'Remote Connections';
            t.setAttribute('title', title);
            t.setAttribute('aria-label', title);
        },
        /** Runs a change and draws the status it returns. */
        async apply(change) {
            const status = await change();
            if (status) this.render(status);
            return status;
        },
        /** Runs a change to the browser lists, then draws what the computer has now. */
        async change(change) {
            const lists = await change();
            if (!lists) return lists;
            if (webui.proxy.remote) this.renderLists(lists);
            else await this.load();
            return lists;
        },
        render(status) {
            const t = this;
            const box = el('webui-flex', { column: true, gap: 'var(--padding)', class: 'remote-connections' });
            box.appendChild(t.renderSwitch(status));
            box.appendChild(t.renderWaiting(status.waiting, status.enabled));
            if (status.refused?.length) box.appendChild(t.renderRefused(status.refused));
            box.appendChild(t.renderApproved(status.approved, true));
            box.appendChild(t.renderActivity());
            t.replaceChildren(box);
        },
        /** The two lists alone, as a connected browser sees them. */
        renderLists(lists) {
            const t = this;
            const box = el('webui-flex', { column: true, gap: 'var(--padding)', class: 'remote-connections' });
            const name = webui.proxy.remote?.desktopName;
            box.appendChild(el('p', { class: 'remote-state' }, `These are the browsers that may connect to ${name || 'this computer'}. Turning Remote Connections on or off, and changing what a browser may do, is done in Task Proxy on the computer.`));
            box.appendChild(t.renderWaiting(lists.waiting, true));
            box.appendChild(t.renderApproved(lists.approved, false));
            t.replaceChildren(box);
        },
        renderSwitch(status) {
            const t = this;
            const part = el('div', { class: 'remote-switch' });
            const line = el('p', { class: 'remote-state' });
            line.appendChild(el('strong', {}, status.enabled ? 'Remote Connections is on.' : 'Remote Connections is off.'));
            line.appendChild(document.createTextNode(status.enabled
                ? ` ${status.name} is listed on www.taskproxy.com for your Stoic Dreams account, and browsers you approve here can use its Task Proxy.`
                : ' Turn it on to use this computer\'s Task Proxy from a browser on www.taskproxy.com, signed in to the same Stoic Dreams account.'));
            part.appendChild(line);
            if (status.enabled && status.reachability?.error) {
                const alert = el('webui-alert', { show: true, severity: 'warning', class: 'remote-error' });
                alert.textContent = `api.myfi.ws can't be reached right now, so browsers can't ask to connect: ${status.reachability.error}`;
                part.appendChild(alert);
            }
            if (status.enabled && status.keepAwake) {
                if (status.awakeError) {
                    const alert = el('webui-alert', { show: true, severity: 'warning', class: 'remote-awake-error' });
                    alert.textContent = `${status.awakeError} It may sleep, and browsers can't reach it while it does.`;
                    part.appendChild(alert);
                } else if (status.awake) {
                    part.appendChild(el('p', { class: 'remote-awake' }, 'This computer is kept awake, so your browsers can reach it. Its screen can still turn off.'));
                }
            }
            const name = el('webui-input-text', { label: 'This computer\'s name', 'data-role': 'computer-name', value: status.name || '', maxlength: 100 });
            const typed = () => `${name.value ?? status.name ?? ''}`.trim();
            const actions = el('webui-flex', { wrap: true, gap: 'var(--padding)', justify: 'start', align: 'end', class: 'remote-row' });
            name.style.flex = '1 1 16em';
            actions.appendChild(name);
            const run = async change => {
                if (t._busy) return;
                t._busy = true;
                try {
                    await t.apply(change);
                } finally {
                    t._busy = false;
                }
            };
            if (status.enabled) {
                const rename = button('Save Name', 'info', 'pencil', 'rename');
                rename.addEventListener('click', () => run(() => webui.proxy.remoteConnections.setEnabled(true, typed())));
                const off = button('Turn Off', 'secondary', 'power', 'turn-off');
                off.addEventListener('click', () => run(() => webui.proxy.remoteConnections.setEnabled(false)));
                actions.append(rename, off);
            } else {
                const on = button('Turn On', 'primary', 'power', 'turn-on');
                on.addEventListener('click', () => run(() => webui.proxy.remoteConnections.setEnabled(true, typed())));
                actions.appendChild(on);
            }
            part.appendChild(actions);
            const keep = choice('While it\'s on', 'keep-awake', [
                { value: 'awake', display: 'Keep this computer awake' },
                { value: 'sleep', display: 'Let this computer sleep as usual' },
            ], status.keepAwake ? 'awake' : 'sleep');
            keep.addEventListener('change', () => {
                const keepAwake = (keep.value || 'awake') === 'awake';
                if (keepAwake !== status.keepAwake) t.apply(() => webui.proxy.remoteConnections.settings(keepAwake));
            });
            part.appendChild(keep);
            return part;
        },
        renderWaiting(waiting, enabled) {
            const t = this;
            const part = el('div', { class: 'remote-waiting' });
            part.appendChild(el('h3', {}, 'Waiting for Approval'));
            if (!waiting.length) {
                part.appendChild(el('p', { class: 'remote-none' }, enabled
                    ? 'No browser is waiting. A new browser shows here when it tries to connect from www.taskproxy.com.'
                    : 'No browser is waiting.'));
                return part;
            }
            part.appendChild(el('p', { class: 'remote-check' }, 'Approve a browser only when its code here matches the code on that browser\'s screen.'));
            waiting.forEach(browser => {
                const row = el('webui-flex', { column: true, gap: 'calc(var(--padding) / 2)', class: 'remote-browser', 'data-browser': browser.key });
                row.appendChild(title(browser));
                row.appendChild(el('p', { class: 'remote-browser-details' }, `Asked ${when(browser.asked)}.`));
                const actions = el('webui-flex', { gap: 'var(--padding)', justify: 'start' });
                const approve = button('Approve', 'success', 'check', 'approve');
                approve.addEventListener('click', () => t.change(() => webui.proxy.remoteConnections.approve(browser.key)));
                const refuse = button('Refuse', 'danger', 'xmark', 'refuse');
                refuse.addEventListener('click', () => t.change(() => webui.proxy.remoteConnections.remove(browser.key)));
                actions.append(approve, refuse);
                row.appendChild(actions);
                part.appendChild(row);
            });
            return part;
        },
        renderRefused(refused) {
            const t = this;
            const part = el('div', { class: 'remote-refused' });
            part.appendChild(el('h3', {}, 'Refused'));
            part.appendChild(el('p', {}, 'A refused browser can\'t ask again for 10 minutes, unless you allow it to.'));
            refused.forEach(browser => {
                const row = el('webui-flex', { column: true, gap: 'calc(var(--padding) / 2)', class: 'remote-browser', 'data-browser': browser.key });
                row.appendChild(title(browser));
                row.appendChild(el('p', { class: 'remote-browser-details' }, `Refused ${when(browser.refused)}.`));
                const allow = button('Allow to Ask Again', 'info', 'rotate', 'allow');
                allow.addEventListener('click', () => t.apply(() => webui.proxy.remoteConnections.allow(browser.key)));
                row.appendChild(allow);
                part.appendChild(row);
            });
            return part;
        },
        /** The approved browsers. `onComputer` adds what only the computer's own window may do. */
        renderApproved(approved, onComputer) {
            const t = this;
            const part = el('div', { class: 'remote-approved' });
            part.appendChild(el('h3', {}, 'Approved Browsers'));
            if (!approved.length) {
                part.appendChild(el('p', { class: 'remote-none' }, 'No browser is approved.'));
                return part;
            }
            approved.forEach(browser => {
                const row = el('webui-flex', { column: true, gap: 'calc(var(--padding) / 2)', class: 'remote-browser', 'data-browser': browser.key });
                const extra = browser.current ? '(this browser)' : browser.connected ? `(connected now${browser.route ? `: ${browser.route}` : ''})` : '';
                row.appendChild(title(browser, extra));
                row.appendChild(el('p', { class: 'remote-browser-details' }, `Added ${when(browser.added)}.`));
                const actions = el('webui-flex', { wrap: true, gap: 'var(--padding)', align: 'end', justify: 'start' });
                if (onComputer) {
                    const level = choice('What it may do', 'level', LEVELS, browser.level);
                    level.addEventListener('change', () => {
                        if (level.value && level.value !== browser.level) {
                            t.apply(() => webui.proxy.remoteConnections.setLevel(browser.key, level.value));
                        }
                    });
                    actions.appendChild(level);
                    if (browser.connected) {
                        const disconnect = button('Disconnect', 'warning', 'plug', 'disconnect');
                        disconnect.addEventListener('click', () => t.apply(() => webui.proxy.remoteConnections.disconnect(browser.key)));
                        actions.appendChild(disconnect);
                    }
                }
                const remove = button('Remove', 'danger', 'trash', 'remove');
                remove.addEventListener('click', () => webui.dialog({
                    title: 'Remove Browser',
                    content: `<p>Remove ${webui.escapeHtml(browser.name)} (${webui.escapeHtml(browser.code)})? ${browser.current ? 'This is the browser you are using, so it disconnects now.' : 'It is disconnected now.'} It can't connect again until it is approved again.</p>`,
                    confirm: 'Remove',
                    cancel: 'Cancel',
                    onconfirm: async () => {
                        // A browser that removes itself gets no answer, only its connection closing.
                        if (browser.current) {
                            webui.proxy.remoteConnections.remove(browser.key, () => null);
                            return true;
                        }
                        return !!await t.change(() => webui.proxy.remoteConnections.remove(browser.key));
                    },
                }));
                actions.appendChild(remove);
                row.appendChild(actions);
                part.appendChild(row);
            });
            return part;
        },
        renderActivity() {
            const part = el('div', { class: 'remote-activity' });
            part.appendChild(el('h3', {}, 'Activity'));
            const list = el('div', { class: 'remote-log' });
            const show = button('Show Activity', 'info', 'list', 'show-activity');
            show.addEventListener('click', async () => {
                const entries = await webui.proxy.remoteConnections.log();
                if (!entries) return;
                list.replaceChildren();
                if (!entries.length) {
                    list.appendChild(el('p', {}, 'No browser has done anything yet.'));
                    return;
                }
                const table = el('ul', { class: 'remote-log-entries' });
                entries.forEach(entry => {
                    const who = [entry.browserName || 'A browser', entry.browser ? `(${entry.browser})` : ''].filter(Boolean).join(' ');
                    table.appendChild(el('li', { class: entry.ok ? 'remote-log-ok' : 'remote-log-failed' },
                        `${when(entry.at)}: ${who} ${entry.cmd}${entry.ok ? '' : `, refused: ${entry.error || 'no reason given'}`}`));
                });
                list.appendChild(table);
            });
            part.append(el('p', {}, 'Every command a browser sends is logged here, without what it sent.'), show, list);
            return part;
        },
        shadowTemplate: `
<style type="text/css">
:host([indicator]) {
    display:inline-flex;
    cursor:pointer;
    padding:1px;
    align-items:center;
    justify-content:center;
}
:host([indicator][hidden]) {
    display:none;
}
:host(:not([indicator])) {
    display:block;
}
</style>
<slot></slot>
`
    });
}
