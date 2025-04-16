"use strict"
{
    webui.define("app-project-dropdown", {
        linkCss: false,
        watchVisibility: false,
        isInput: false,
        preload: 'webui-dropdown',
        constructor: (t) => {
            t._dropdown = t.template.querySelector('webui-dropdown');
        },
        attr: [],
        flags: [],
        attrChanged: (t, property, value) => {
            switch (property) {
            }
        },
        connected: async function (t) {
            t.dataset.subscribe = 'app-projects:setProjects';
            let projects = await window.__TAURI__.core.invoke('get_projects', {});
            projects = projects || [];
            webui.setData('app-projects', projects);
        },
        disconnected: function (t) { },
        setProjects(projects) {
            let t = this;
            projects = projects || [];
            if (!t._dropdown.setOptions) {
                setTimeout(() => t.setProjects(projects), 10);
                return;
            }
            let dp = projects.map(item => { return { value: item.path, display: item.name } });
            t._dropdown.setOptions(dp);
            if (projects.length === 0) {
                t.classList.remove('show');
            } else {
                t.classList.add('show');
            }
        },
        shadowTemplate: `
<style type="text/css">
:host {
display:none;
}
:host(.show) {
display:block;
}
</style>
<webui-dropdown title="Project" data-name="app-current-project"></webui-dropdown>
`
    });
}