"use strict"
{
    async function loadProjects() {
        if (webui.proxy) {
            let projects = await webui.proxy.getProjects() || [];
            webui.setData('app-projects', projects);
        } else {
            setTimeout(loadProjects, 100);
        }
    }
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
        connected: function (t) {
            t.dataset.subscribe = 'app-projects:setProjects';
            loadProjects();
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
                setTimeout(() => {
                    let value = webui.getData('app-current-project');
                    if (!value) {
                        webui.setData('app-current-project', dp[0]);
                    }
                }, 3000);
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