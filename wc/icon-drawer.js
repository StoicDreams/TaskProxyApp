"use strict"
{
    function getHeaderContent() {
        const container = webui.create('div');
        container.style.padding = 'var(--padding)';
        container.setAttribute('slot', 'header');
        // A drawer's title, not a second banner for the page.
        container.setAttribute('role', 'heading');
        container.setAttribute('aria-level', '2');
        container.innerHTML = 'Icons & Emojis';
        return container;
    }
    function getBodyContent() {
        const container = webui.create('section');
        container.style.padding = 'var(--padding)';
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.height = 'calc(100% - var(--header-height, 60px))';
        container.innerHTML = `
<webui-tabs theme="secondary" index="0" transition-timing="200" style="flex-grow:1; display:flex; flex-direction:column;">
    <webui-button slot="tabs">Icons & Emojis</webui-button>
    <webui-content slot="content" nodetach style="overflow-y:auto;">
        <webui-icon-search></webui-icon-search>
    </webui-content>
</webui-tabs>
`;
        return container;
    }
    /** Shows the icon and emoji search in `target`, a Tools tab or a drawer. */
    function openDrawer(target) {
        const el = typeof target === 'string' ? document.querySelector(target) : target;
        if (!el) {
            webui.log.warn('Drawer not found!');
            return;
        }
        showTool(el, getHeaderContent(), getBodyContent());
    }
    webui.define("app-icon-drawer", {
        linkCss: false,
        watchVisibility: false,
        isInput: false,
        preload: 'icon-search tabs',
        constructor() {
            const t = this;
            t.icon = t.template.querySelector('webui-icon');
        },
        attr: ['data-toggleclass'],
        flags: [],
        attrChanged(property, value) {
            const t = this;
            switch (property) {
                case 'dataToggleclass':
                    t.drawer = value.split('|')[0];
                    break;
            }
        },
        connected() {
            const t = this;
            makeButton(t);
            t.addEventListener('click', _ev => {
                t.open();
                return true;
            });
        },
        /** Opens the search, as the Icons & Emojis tab of Tools when it is one. `target` is where Tools has it draw. */
        open({ target = null } = {}) {
            const t = this;
            const tools = toolsPanelOf(t);
            if (tools && !target) {
                tools.show('icons');
                return;
            }
            openDrawer(target || t.drawer);
        },
        disconnected() { },
        shadowTemplate: `
<webui-icon icon="circle_icons|fill|backing|bordered"></webui-icon>
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
