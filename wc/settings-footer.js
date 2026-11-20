/*
 * The bottom of Settings, where the app's footer used to be: the Stoic Dreams sign-in, then the copyright and
 * Powered by Web UI. `since` is the first year of the copyright, and `company` whose it is.
 */
"use strict"
{
    webui.define("app-settings-footer", {
        preload: 'app:account poweredby',
        attr: ['since', 'company'],
        attrChanged() {
            this.showCopyright();
        },
        connected() {
            const t = this;
            if (t._copyright) return;
            t._account = webui.create('app-account', { labeled: '' });
            t._line = webui.create('div', { class: 'settings-footer-line' });
            // Powered by adds its own children as it is made, which createElement does not allow, so it is parsed.
            t._line.innerHTML = '<span class="settings-copyright"></span><webui-poweredby></webui-poweredby>';
            t._copyright = t._line.querySelector('.settings-copyright');
            t.append(t._account, t._line);
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
