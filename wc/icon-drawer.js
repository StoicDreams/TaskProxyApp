"use strict"
{
    function getHeaderContent() {
        const container = webui.create('header');
        container.style.padding = 'var(--padding)';
        container.setAttribute('slot', 'header');
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
    function openDrawer(drawer) {
        let el = document.querySelector(drawer);
        if (!el) {
            webui.log.warn('Drawer not found!');
            return;
        }
        if (el.classList.contains('open')) {
            el.classList.remove('open');
            setTimeout(() => openDrawer(drawer), 500);
            return;
        }
        el.innerHTML = '';
        el.appendChild(getHeaderContent());
        el.appendChild(getBodyContent());
        setTimeout(() => {
            el.classList.add('open');
        }, 100);
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
            t.addEventListener('click', _ev => {
                openDrawer(t.drawer);
                return true;
            });
        },
        disconnected() { },
        shadowTemplate: `
<webui-icon icon="emoji-symbols"></webui-icon>
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