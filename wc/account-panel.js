/*
 * The Account tab of Tools: the Stoic Dreams sign-in at the top, room below it for what the account will offer, and
 * the copyright and Powered by Web UI at the bottom, where the app's footer used to be. `since` is the first year of
 * the copyright, and `company` whose it is. Content added later goes in its .account-body.
 */
"use strict"
{
    webui.define("app-account-panel", {
        preload: 'app:account poweredby',
        attr: ['since', 'company'],
        attrChanged() {
            this.showCopyright();
        },
        connected() {
            const t = this;
            if (t._copyright) return;
            t.classList.add('tools-fill');
            t._account = webui.create('app-account', { labeled: '' });
            t._body = webui.create('div', { class: 'account-body' });
            t._line = webui.create('div', { class: 'account-footer' });
            // Powered by adds its own children as it is made, which createElement does not allow, so it is parsed.
            t._line.innerHTML = '<span class="account-copyright"></span><webui-poweredby></webui-poweredby>';
            t._copyright = t._line.querySelector('.account-copyright');
            t.append(t._account, t._body, t._line);
            t.showCopyright();
        },
        /** © and the years, such as © 2016-2026 Stoic Dreams All Rights Reserved. */
        showCopyright() {
            const t = this;
            if (!t._copyright) return;
            const now = new Date().getFullYear();
            const since = parseInt(t.getAttribute('since')) || now;
            const years = since < now ? `${since}-${now}` : `${now}`;
            t._copyright.textContent = `© ${years} ${t.getAttribute('company') || ''} All Rights Reserved`.replace(/\s+/g, ' ');
        },
    });
}
