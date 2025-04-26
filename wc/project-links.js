
"use strict"
{
    webui.define("app-project-links", {
        linkCss: true,
        watchVisibility: false,
        isInput: false,
        preload: '',
        constructor: (t) => {
        },
        attr: ['example'],
        flags: [],
        attrChanged: (t, property, value) => {
            switch (property) {
                case 'example':
                    break;
            }
        },
        setProject: function (project) {
            console.log('set project', project);
            let t = this;
            if (project && project.value) {
                t.classList.add('enabled');
            } else {
                t.classList.remove('enabled');
            }
        },
        connected: function (t) {
            t.dataset.subscribe = 'app-current-project:setProject';
        },
        disconnected: function (t) { },
        shadowTemplate: `
<webui-nav-link icon="compass|fill|bordered|theme:success|backing|shape:circle" url="/nav-manager" title="Navigation Manager"></webui-nav-link>
<webui-nav-link icon="squares|fill|theme:success|shape:circle|inverted" url="/docs" title="Docs Manager"></webui-nav-link>
<webui-nav-link icon="diamond|fill|theme:success|shape:circle|inverted" url="/git-controller" title="Git Controller"></webui-nav-link>
<style type="text/css">
:host {
display:none;
justify-content:center;
gap:var(--padding);
margin:auto 0 0;
}
:host(.enabled) {
display:flex;
}
</style>
`
    });
}