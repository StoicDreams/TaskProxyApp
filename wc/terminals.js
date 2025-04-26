
"use strict"
{
    function getHeaderContent() {
        const container = webui.create('header');
        container.style.padding = 'var(--padding)';
        container.setAttribute('slot', 'header');
        container.innerHTML = 'Terminals';
        return container;
    }

    function getBodyContent() {
        const container = webui.create('section');
        container.style.padding = 'var(--padding)';
        container.innerHTML = `<webui-alert variant="info" show>Coming Soon!</webui-alert>`;
        return container;
    }

    function openDrawer(drawer) {
        let el = document.querySelector(drawer);
        if (!el) {
            webui.alert('Drawer not found!');
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

    webui.define("app-terminals", {
        linkCss: false,
        watchVisibility: false,
        isInput: false,
        preload: '',
        constructor: (t) => {
            t.icon = t.template.querySelector('webui-icon');
        },
        attr: ['data-toggleclass'],
        flags: [],
        attrChanged: (t, property, value) => {
            switch (property) {
                case 'dataToggleclass':
                    t.drawer = value.split('|')[0];
                    break;
            }
        },
        connected: function (t) {
            t.addEventListener('click', _ev => {
                openDrawer(t.drawer);
                return true;
            });
        },
        disconnected: function (t) { },
        shadowTemplate: `
<webui-icon icon="square|theme:black|shape:circle|fill"></webui-icon>
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