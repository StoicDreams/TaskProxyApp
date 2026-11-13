/*
 * The header's Plugins button, beside Icons & Emojis. It opens the shared right drawer with the plugin manager, as
 * the other header tools open theirs. open(pluginId) opens it on one plugin's settings, for a plugin's own
 * "Open settings" button.
 */
"use strict"
{
    function getHeaderContent() {
        const container = webui.create('div');
        container.style.padding = 'var(--padding)';
        container.setAttribute('slot', 'header');
        // A drawer's title, not a second banner for the page.
        container.setAttribute('role', 'heading');
        container.setAttribute('aria-level', '2');
        container.textContent = 'Plugins';
        return container;
    }
    function getBodyContent(pluginId) {
        const container = webui.create('section');
        container.style.padding = 'var(--padding)';
        container.style.overflowY = 'auto';
        container.style.height = 'calc(100% - var(--header-height, 60px))';
        const intro = webui.create('p');
        intro.textContent = 'Plugins add integrations to Task Proxy, such as Jira. Each one is installed for you on this computer, never by opening a project, and can only reach what it lists.';
        const manager = webui.create('app-plugin-manager');
        if (pluginId) manager.setAttribute('plugin', pluginId);
        container.append(intro, manager);
        return container;
    }
    function openDrawer(drawer, pluginId) {
        const el = document.querySelector(drawer);
        if (!el) {
            webui.log.warn('Drawer not found!');
            return;
        }
        if (el.classList.contains('open')) {
            el.classList.remove('open');
            setTimeout(() => openDrawer(drawer, pluginId), 500);
            return;
        }
        el.innerHTML = '';
        el.appendChild(getHeaderContent());
        el.appendChild(getBodyContent(pluginId));
        setTimeout(() => {
            el.classList.add('open');
        }, 100);
    }
    webui.define("app-plugins-drawer", {
        linkCss: false,
        watchVisibility: false,
        isInput: false,
        preload: 'app:plugin-manager',
        attr: ['data-toggleclass'],
        attrChanged(property, value) {
            const t = this;
            if (property === 'dataToggleclass') t.drawer = value.split('|')[0];
        },
        connected() {
            const t = this;
            makeButton(t, t.getAttribute('title') || 'Plugins');
            t.addEventListener('click', () => t.open());
        },
        /** Opens the drawer, on one plugin's settings when given its id. */
        open(pluginId) {
            openDrawer(this.drawer || '.shared', pluginId);
        },
        shadowTemplate: `
<webui-icon icon="cloud_puzzle-piece|theme:success|fill|backing|bordered"></webui-icon>
<style type="text/css">
:host {
    display:inline-flex;
    cursor:pointer;
    padding:1px;
    align-items:center;
    justify-content:center;
}
</style>
`
    });
}
