/* Template for Web UI components. */
"use strict"
{
    webui.define("app-home", {
        constructor: (t) => {
        },
        connected: function () {
            const t = this;
            t.checkAppState();
        },
        disconnected: function (t) { },
        checkAppState: async function (k, v) {
            const t = this;
            let hasSecurityKey = await webui.proxy.hasSecurityKey();
            if (!hasSecurityKey) {
                webui.setData('app-nav-home', 'Security Key');
                webui.setData('home-source', "d/first_run.md");
                return;
            }
            t.loadProjects();
        },
        loadProjects: async function () {
            const t = this;
            let projects = await webui.proxy.getProjects() || [];
            webui.setData('app-projects', projects);
            if (projects.length === 0) {
                webui.setData('app-nav-home', 'First Project');
                webui.setData('home-source', "d/home_new_project.md");
            } else {
                webui.setData('app-nav-home', 'Settings');
                webui.setData('home-source', "d/home_settings.md");
            }
        }
    });
}