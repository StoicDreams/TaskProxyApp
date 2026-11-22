/* The header's account button: signs Task Proxy in to a Stoic Dreams (MyFi) account, approved in the browser. */
"use strict"
{
    // Shared by every app-account, so signing in or out updates them all. undefined until read, null when signed out.
    let account;
    let reading = null;
    let signingIn = false;
    const buttons = new Set();
    const esc = text => webui.escapeHtml(`${text ?? ''}`);
    function setAccount(value) {
        account = value || null;
        buttons.forEach(button => button.show());
    }
    function readAccount() {
        reading ??= whenProxyReady()
            .then(proxy => proxy.myfi.account())
            .then(setAccount)
            .finally(() => reading = null);
        return reading;
    }
    /**
     * What the sign-in dialog shows: the code StoicDreams.com should show, as a button that copies it, and the page's
     * address when the browser didn't open it.
     */
    function signInContent(started) {
        const box = webui.create('div', { class: 'myfi-sign-in' });
        // What a copy did, in an alert under the code.
        // Screen readers hear it as it changes.
        const status = webui.create('webui-alert', { class: 'myfi-copied', 'aria-live': 'polite' });
        const say = (variant, text) => setNote(status, text, variant);
        const copyButton = (label, text, done, attrs = {}) => {
            const button = webui.create('button', { type: 'button', ...attrs });
            button.textContent = label;
            button.addEventListener('click', async ev => {
                ev.preventDefault();
                ev.stopPropagation();
                if (await webui.proxy.copyText(text, err => say('danger', `${err}`))) say('success', done);
            });
            return button;
        };
        box.append(webui.create('p', {
            text: started.opened
                ? 'Your browser opened StoicDreams.com. Sign in there if it asks, then approve the sign-in if it shows this code:'
                : 'Your browser didn\'t open, so open this page in it. Sign in there if it asks, then approve the sign-in if it shows this code:',
        }));
        if (!started.opened) {
            const link = webui.create('p', { class: 'myfi-link', style: 'display:flex;flex-wrap:wrap;align-items:center;gap:0.5em;word-break:break-all;' });
            link.append(webui.create('code', { text: started.url }), copyButton('Copy Link', started.url, 'Copied the link.', { class: 'myfi-copy-link' }));
            box.append(link);
        }
        box.append(
            copyButton(started.code, started.code, 'Copied the code.', {
                class: 'myfi-code',
                title: 'Copy the code',
                'aria-label': `Copy the code ${started.code}`,
                style: 'display:block;margin:0.5em auto;padding:0.2em 0.6em;font-size:2em;font-family:monospace;letter-spacing:0.15em;cursor:pointer;',
            }),
            webui.create('p', { text: 'Select the code to copy it. This closes by itself once you approve.' }),
            status,
        );
        return box;
    }
    webui.define("app-account", {
        connected() {
            const t = this;
            buttons.add(t);
            makeButton(t, 'Account');
            if (!t._icon) {
                t._icon = webui.create('webui-icon', { 'aria-hidden': 'true' });
                t.appendChild(t._icon);
                // With labeled, as at the bottom of Settings, it says what it does beside the icon.
                if (t.hasAttribute('labeled')) {
                    t._label = webui.create('span', { class: 'account-label' });
                    t.appendChild(t._label);
                }
                t.addEventListener('click', () => t.open());
            }
            t.show();
            if (account === undefined) readAccount();
        },
        disconnected() {
            buttons.delete(this);
        },
        show() {
            const t = this;
            if (!t._icon) return;
            const title = !account
                ? 'Sign in to your Stoic Dreams account'
                : account.offline
                    ? `Signed in as ${account.displayName} (Stoic Dreams can't be reached right now)`
                    : `Signed in as ${account.displayName}`;
            t.setAttribute('title', title);
            t.setAttribute('aria-label', title);
            t.dataset.state = !account ? 'signed-out' : account.offline ? 'offline' : 'signed-in';
            if (t._label) t._label.textContent = !account ? 'Sign in to Stoic Dreams' : `Signed in as ${account.displayName}`;
            t._icon.setAttribute('icon', !account
                ? 'user|theme:tertiary|backing|bordered'
                : `user-check|theme:${account.offline ? 'warning' : 'success'}|fill|backing|bordered`);
        },
        async open() {
            const t = this;
            if (account === undefined) await readAccount();
            if (account) {
                t.showAccount();
            } else {
                t.signIn();
            }
        },
        showAccount() {
            const offline = account.offline
                ? `<p>Stoic Dreams can't be reached right now, so this is the account saved on this computer.</p>`
                : '';
            webui.dialog({
                title: 'Your Account',
                content: `
<div class="myfi-account">
<p>Task Proxy is signed in as <strong>${esc(account.displayName)}</strong>.</p>
${offline}
<p>Signing out forgets this sign-in on this computer.</p>
</div>`,
                confirm: 'Sign Out',
                cancel: 'Close',
                onconfirm: async () => {
                    if (!await webui.proxy.myfi.signOut()) return false;
                    setAccount(null);
                    // The dialog closes as this is said, so it goes in the app's alerts.
                    appAlert('Task Proxy is signed out of your Stoic Dreams account.', 'info');
                    return true;
                },
            });
        },
        /**
         * Starts signing in, which opens StoicDreams.com in the browser, and waits there for the user to approve it.
         * The dialog shows the code the page should show, so the user can tell it is this sign-in they approve.
         */
        async signIn() {
            if (signingIn) return;
            signingIn = true;
            try {
                const started = await webui.proxy.myfi.signInStart();
                if (!started) return;
                let done = false;
                const content = signInContent(started);
                const dialog = webui.dialog({
                    title: 'Sign In',
                    content,
                    confirm: started.opened ? 'Open the Page Again' : 'Open the Page',
                    cancel: 'Cancel',
                    onconfirm: () => {
                        webui.proxy.openUrl(started.url);
                        return false;
                    },
                });
                Promise.resolve(dialog).catch(() => {
                    if (done) return;
                    done = true;
                    webui.proxy.myfi.signInCancel();
                });
                try {
                    const result = await webui.proxy.myfi.signInWait();
                    if (done) return;
                    done = true;
                    dialog.close?.();
                    if (result) {
                        setAccount(result);
                        // The sign-in dialog has closed, so this goes in the app's alerts.
                        appAlert(`Signed in as ${result.displayName}.`, 'success');
                    }
                } catch (err) {
                    if (done) return;
                    done = true;
                    dialog.close?.();
                    // The sign-in dialog has closed, so why it failed goes in the app's alerts.
                    appAlert(err, 'warning');
                }
            } finally {
                signingIn = false;
            }
        },
        shadowTemplate: `
<style type="text/css">
:host {
    display:inline-flex;
    cursor:pointer;
    padding:1px;
    align-items:center;
    justify-content:center;
    gap:0.5em;
}
</style>
<slot></slot>
`
    });
}
