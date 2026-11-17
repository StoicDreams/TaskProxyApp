/*
 * Remote Access (Docs/RemoteAccess.md): pairing a phone or laptop, signed in to the same Stoic Dreams account, to use
 * this desktop's Task Proxy from taskproxy.com.
 *
 * <app-remote-access></app-remote-access> is the panel in Settings: the switch, a QR code to pair a device, the
 * paired devices, and their activity.
 * <app-remote-access indicator></app-remote-access> is the header's button. It shows only while a device is connected,
 * and opens the panel. The indicator also raises each notice the backend sends, such as a device pairing.
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
    const levelName = level => ({ view: 'View', work: 'Work', commit: 'Commit' })[level] || level;
    const daysName = days => days === 0 ? 'For good' : `${days} days without connecting`;

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

    function dropdown(label, role, options, value) {
        const input = el('webui-dropdown', { label, 'data-role': role });
        input.setAttribute('options', JSON.stringify(options.map(option => ({ id: `${option.value}`, value: `${option.value}`, display: option.display }))));
        input.setAttribute('value', `${value}`);
        return input;
    }

    function when(ms) {
        if (!ms) return 'never';
        return new Date(ms).toLocaleString();
    }

    /** Refreshes every panel, and raises a notice in the Alerts panel. */
    function listen() {
        if (listening) return;
        listening = true;
        webui.wait(() => webui.proxy?.remoteAccess).then(() => webui.proxy.remoteAccess.onChanged(({ notice }) => {
            if (notice?.text) webui.alert(webui.escapeHtml(notice.text), notice.severity || 'info');
            panels.forEach(panel => panel.load());
        }));
    }

    webui.define("app-remote-access", {
        preload: 'button dropdown input-text alert icon',
        constructor() {
            this._load = 0;
        },
        connected() {
            const t = this;
            panels.add(t);
            if (t.hasAttribute('indicator')) {
                listen();
                t.hidden = true;
                if (!t._icon) {
                    t._icon = el('webui-icon', { icon: 'mobile|theme:success|fill|backing|bordered', 'aria-hidden': 'true' });
                    t.appendChild(t._icon);
                    t.addEventListener('click', () => webui.dialog({
                        title: 'Remote Access',
                        minWidth: '80%',
                        content: '<app-remote-access></app-remote-access>',
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
            await webui.wait(() => webui.proxy?.remoteAccess);
            const status = await webui.proxy.remoteAccess.status(() => null);
            if (load !== t._load || !status) return;
            t._status = status;
            if (t.hasAttribute('indicator')) {
                t.showIndicator(status);
            } else {
                t.render(status);
            }
        },
        showIndicator(status) {
            const t = this;
            const connected = status.enabled ? status.devices.filter(device => device.connected) : [];
            t.hidden = connected.length === 0;
            const title = connected.length ? `Remote Access: ${connected.map(device => device.name).join(', ')} connected` : 'Remote Access';
            t.setAttribute('title', title);
            t.setAttribute('aria-label', title);
        },
        /** Runs a change and draws the status it returns. */
        async apply(change) {
            const status = await change();
            if (status) {
                this._status = status;
                this.render(status);
            }
            return status;
        },
        render(status) {
            const t = this;
            const box = el('webui-flex', { column: true, gap: 'var(--padding)', class: 'remote-access' });
            box.appendChild(t.renderSwitch(status));
            if (status.enabled) {
                box.appendChild(t.renderPairing(status));
            }
            box.appendChild(t.renderDevices(status));
            box.appendChild(t.renderActivity());
            t.replaceChildren(box);
        },
        renderSwitch(status) {
            const t = this;
            const part = el('div', { class: 'remote-switch' });
            const line = el('p', { class: 'remote-state' });
            line.appendChild(el('strong', {}, status.enabled ? 'Remote Access is on.' : 'Remote Access is off.'));
            line.appendChild(document.createTextNode(status.enabled
                ? ` Devices paired with ${status.desktopName} can reach it from taskproxy.com, signed in to your Stoic Dreams account.`
                : ' Turn it on to use this desktop\'s Task Proxy from your phone or laptop, signed in to the same Stoic Dreams account.'));
            part.appendChild(line);
            if (!status.signedIn) {
                part.appendChild(el('p', { class: 'remote-signed-out' }, 'Sign in to your Stoic Dreams account first, from the account button at the top.'));
            }
            if (status.enabled && status.reachability?.error) {
                const alert = el('webui-alert', { show: true, severity: 'warning', class: 'remote-error' });
                alert.textContent = `api.myfi.ws can't be reached right now, so devices can't reach this desktop: ${status.reachability.error}`;
                part.appendChild(alert);
            }
            if (status.fingerprint && status.enabled) {
                part.appendChild(el('p', { class: 'remote-fingerprint' }, `This desktop's key starts ${status.fingerprint}. taskproxy.com shows the same when you pair.`));
            }
            const actions = el('webui-flex', { gap: 'var(--padding)', justify: 'start', align: 'center' });
            const turn = status.enabled
                ? button('Turn Off', 'secondary', 'power', 'turn-off')
                : button('Turn On', 'primary', 'power', 'turn-on');
            turn.addEventListener('click', async () => {
                if (t._busy) return;
                t._busy = true;
                try {
                    await t.apply(() => webui.proxy.remoteAccess.setEnabled(!status.enabled));
                } finally {
                    t._busy = false;
                }
            });
            actions.appendChild(turn);
            if (!status.signedIn) {
                const signIn = button('Sign In', 'primary', 'user', 'sign-in');
                signIn.addEventListener('click', () => document.querySelector('app-account')?.open?.());
                actions.appendChild(signIn);
            }
            part.appendChild(actions);
            return part;
        },
        renderPairing(status) {
            const t = this;
            const part = el('div', { class: 'remote-pairing' });
            part.appendChild(el('h3', {}, 'Pair a Device'));
            const invite = status.invite;
            if (invite) {
                part.appendChild(el('p', {}, `Scan this with ${invite.name} to pair it at the ${levelName(invite.level)} level, lasting ${daysName(invite.days).toLowerCase()}. On the device, sign in to the same Stoic Dreams account when taskproxy.com asks.`));
                const img = el('img', { class: 'remote-qr', alt: 'QR code to pair a device', width: 240, height: 240 });
                img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(invite.svg)}`;
                img.style.background = '#fff';
                img.style.padding = '8px';
                part.appendChild(img);
                part.appendChild(el('p', { class: 'remote-expires' }, `It works once, until ${new Date(invite.expiresAt).toLocaleTimeString()}. Or open this link on the device:`));
                part.appendChild(el('code', { class: 'remote-link', style: 'word-break:break-all;user-select:all;' }, invite.link));
                const actions = el('webui-flex', { gap: 'var(--padding)', justify: 'start' });
                const copy = button('Copy Link', 'info', 'copy', 'copy-link');
                copy.addEventListener('click', async () => {
                    await navigator.clipboard?.writeText(invite.link);
                    webui.alert('The pairing link is copied. Send it only to your own device.', 'info');
                });
                const cancel = button('Cancel', 'secondary', 'xmark', 'cancel-invite');
                cancel.addEventListener('click', () => t.apply(() => webui.proxy.remoteAccess.cancelInvite()));
                actions.append(copy, cancel);
                part.appendChild(actions);
                return part;
            }
            part.appendChild(el('p', {}, 'Choose what the device may do and how long it stays paired, then scan the QR code with it.'));
            const name = el('webui-input-text', { label: 'Device name', 'data-role': 'device-name', value: 'Phone' });
            const level = dropdown('What it may do', 'level', LEVELS, 'view');
            const days = dropdown('How long it stays paired', 'days', (status.pairingDays || [7, 30, 90, 0]).map(days => ({ value: days, display: daysName(days) })), 30);
            const show = button('Show QR Code', 'primary', 'qrcode', 'show-qr');
            show.addEventListener('click', () => t.apply(() => webui.proxy.remoteAccess.invite(
                `${name.value ?? 'Phone'}`.trim() || 'Phone',
                level.value || 'view',
                parseInt(days.value ?? '30', 10),
            )));
            part.append(name, level, days, show);
            return part;
        },
        renderDevices(status) {
            const t = this;
            const part = el('div', { class: 'remote-devices' });
            part.appendChild(el('h3', {}, 'Paired Devices'));
            if (!status.devices.length) {
                part.appendChild(el('p', { class: 'remote-none' }, 'No devices are paired.'));
                return part;
            }
            status.devices.forEach(device => {
                const row = el('webui-flex', { column: true, gap: 'calc(var(--padding) / 2)', class: 'remote-device', 'data-device': device.id });
                const title = el('p', { class: 'remote-device-name' });
                title.appendChild(el('strong', {}, device.name));
                title.appendChild(document.createTextNode(device.connected ? ' (connected now)' : ''));
                row.appendChild(title);
                row.appendChild(el('p', { class: 'remote-device-details' },
                    `Paired ${when(device.pairedAt)}. Last connected ${device.lastSeen ? when(device.lastSeen) : 'never'}. ${device.days === 0 ? 'Stays paired for good.' : `Unpaired after ${device.days} days without connecting, on ${when(device.expiresAt)}.`}`));
                const actions = el('webui-flex', { gap: 'var(--padding)', align: 'end', justify: 'start' });
                const level = dropdown('What it may do', 'device-level', LEVELS, device.level);
                level.addEventListener('change', () => {
                    if (level.value && level.value !== device.level) {
                        t.apply(() => webui.proxy.remoteAccess.updateDevice(device.id, { level: level.value }));
                    }
                });
                actions.appendChild(level);
                const rename = button('Rename', 'info', 'pencil', 'rename');
                rename.addEventListener('click', () => webui.dialog({
                    title: 'Rename Device',
                    content: `<webui-input-text name="name" label="Name" value="${webui.escapeHtml(device.name)}"></webui-input-text>`,
                    confirm: 'Rename',
                    cancel: 'Cancel',
                    onconfirm: async (data) => {
                        const name = `${Object.fromEntries(data).name ?? ''}`.trim();
                        if (!name) return false;
                        return !!await t.apply(() => webui.proxy.remoteAccess.updateDevice(device.id, { name }));
                    },
                }));
                actions.appendChild(rename);
                if (device.connected) {
                    const disconnect = button('Disconnect', 'warning', 'plug', 'disconnect');
                    disconnect.addEventListener('click', () => t.apply(() => webui.proxy.remoteAccess.disconnectDevice(device.id)));
                    actions.appendChild(disconnect);
                }
                const remove = button('Unpair', 'danger', 'trash', 'remove');
                remove.addEventListener('click', () => webui.dialog({
                    title: 'Unpair Device',
                    content: `<p>Unpair ${webui.escapeHtml(device.name)}? It can't reach this desktop until you pair it again.</p>`,
                    confirm: 'Unpair',
                    cancel: 'Cancel',
                    onconfirm: async () => !!await t.apply(() => webui.proxy.remoteAccess.removeDevice(device.id)),
                }));
                actions.appendChild(remove);
                row.appendChild(actions);
                part.appendChild(row);
            });
            return part;
        },
        renderActivity() {
            const t = this;
            const part = el('div', { class: 'remote-activity' });
            part.appendChild(el('h3', {}, 'Activity'));
            const list = el('div', { class: 'remote-log' });
            const show = button('Show Activity', 'info', 'list', 'show-activity');
            show.addEventListener('click', async () => {
                const entries = await webui.proxy.remoteAccess.log();
                if (!entries) return;
                list.replaceChildren();
                if (!entries.length) {
                    list.appendChild(el('p', {}, 'No device has sent anything yet.'));
                    return;
                }
                const table = el('ul', { class: 'remote-log-entries' });
                entries.forEach(entry => {
                    table.appendChild(el('li', { class: entry.ok ? 'remote-log-ok' : 'remote-log-failed' },
                        `${when(entry.at)}: ${entry.deviceName || 'A device'} ${entry.cmd}${entry.ok ? '' : `, refused: ${entry.error || 'no reason given'}`}`));
                });
                list.appendChild(table);
            });
            part.append(el('p', {}, 'Every command a device sends is logged here, without what it sent.'), show, list);
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
