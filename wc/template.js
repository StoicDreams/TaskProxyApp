/* Template for Web UI components. */
"use strict"
{
    webui.define("app-template", {
        constructor() {
            const t = this;
        },
        attr: ['example'],
        attrChanged(property, value) {
            switch (property) {
                case 'example':
                    break;
            }
        },
        connected() { },
        disconnected() { }
    });
}

/* Template for Web UI components. */
"use strict"
{
    webui.define("app-shadow-template", {
        linkCss: false,
        watchVisibility: false,
        isInput: false,
        preload: '',
        constructor: () => {
            const t = this;
            t._slotMain = t.template.querySelector('slot:not([name])');
            t._slotSomething = t.template.querySelector('slot[name="something"]');
        },
        attr: ['example'],
        flags: [],
        attrChanged: (property, value) => {
            const t = this;
            switch (property) {
                case 'example':
                    break;
            }
        },
        connected: function () { },
        disconnected: function () { },
        shadowTemplate: `
<style type="text/css">
:host {
}
</style>
<slot></slot>
<slot name="something"></slot>
`
    });
}