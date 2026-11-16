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
    webui.define("app-account", {
        connected() {
            const t = this;
            buttons.add(t);
            makeButton(t, 'Account');
            if (!t._icon) {
                t._icon = webui.create('webui-icon', { 'aria-hidden': 'true' });
                t.appendChild(t._icon);
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
                    webui.alert('Task Proxy is signed out of your Stoic Dreams account.', 'info');
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
                const dialog = webui.dialog({
                    title: 'Sign In',
                    content: `
<div class="myfi-sign-in">
<p>Your browser opened StoicDreams.com. Sign in there if it asks, then approve the sign-in if it shows this code:</p>
<p class="myfi-code" style="font-size:2em;font-family:monospace;letter-spacing:0.15em;text-align:center;margin:0.5em 0;">${esc(started.code)}</p>
<p>This closes by itself once you approve.</p>
</div>`,
                    confirm: 'Open the Page Again',
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
                        webui.alert(`Signed in as ${esc(result.displayName)}.`, 'success');
                    }
                } catch (err) {
                    if (done) return;
                    done = true;
                    dialog.close?.();
                    webui.alert(esc(err), 'warning');
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
}
</style>
<slot></slot>
`
    });
}
