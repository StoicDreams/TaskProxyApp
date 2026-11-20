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
    /** Shows the plugin manager in `target`, a Tools tab or a drawer, on one plugin when given its id. */
    function openDrawer(target, pluginId) {
        const el = typeof target === 'string' ? document.querySelector(target) : target;
        if (!el) {
            webui.log.warn('Drawer not found!');
            return;
        }
        showTool(el, getHeaderContent(), getBodyContent(pluginId));
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
        /**
         * Opens the plugin manager, as the Plugins tab of Tools when it is one, on one plugin's settings when given its
         * id. `target` is where Tools has it draw.
         */
        open(pluginId, { target = null } = {}) {
            const t = this;
            const tools = toolsPanelOf(t);
            if (tools && !target) {
                tools.show('plugins', { pluginId });
                return;
            }
            openDrawer(target || t.drawer || '.shared', pluginId);
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
