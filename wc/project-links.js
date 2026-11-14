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
            // Subscribers are not told when a value is cleared, and closing a project clears it.
            t._onDataChange = changes => {
                if (changes.property === 'app-current-project') t.setProject(changes.newValue);
            };
            webui.watchAppDataChanges(t._onDataChange);
            t.setProject(webui.getData('app-current-project'));
        },
        disconnected() {
            webui.unwatchAppDataChanges(this._onDataChange);
        },
        shadowTemplate: `
<webui-nav-link icon="circle_list-tree|fill|bordered|theme:success|backing" url="/nav-manager" title="Navigation Manager"></webui-nav-link>
<webui-nav-link icon="circle_book-open|fill|theme:success|inverted" url="/docs" title="Docs Manager"></webui-nav-link>
<webui-nav-link icon="circle_code|fill|bordered|theme:success|backing" url="/script-manager" title="Script Manager"></webui-nav-link>
<webui-nav-link icon="circle_git|fill|theme:success|inverted" url="/git-controller" title="Git Controller"></webui-nav-link>
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
