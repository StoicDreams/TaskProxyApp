"use strict"
{
    webui.define("app-project-links", {
        linkCss: true,
        isInput: false,
        preload: 'nav-link',
        setProject(project) {
            const t = this;
            if (project && project.value) {
                t.classList.add('enabled');
            } else {
                t.classList.remove('enabled');
            }
        },
        connected() {
            const t = this;
            t.dataset.subscribe = 'app-current-project:setProject';
        },
        disconnected() { },
        shadowTemplate: `
<webui-nav-link icon="emoji-compass|fill|bordered|theme:success|backing|shape:circle" url="/nav-manager" title="Navigation Manager"></webui-nav-link>
<webui-nav-link icon="emoji-books|fill|theme:success|shape:circle|inverted" url="/docs" title="Docs Manager"></webui-nav-link>
<webui-nav-link icon="emoji-octopus|fill|theme:success|shape:circle|inverted" url="/git-controller" title="Git Controller"></webui-nav-link>
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