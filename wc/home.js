/* Template for Web UI components. */
"use strict"
{
    webui.define("app-home", {
        preload: 'content',
        constructor() {
            const t = this;
        },
        connected() {
            const t = this;
            t.checkAppState();
        },
        disconnected() { },
        async checkAppState(k, v) {
            const t = this;
            await whenProxyReady();
            let hasSecurityKey = await webui.proxy.hasSecurityKey();
            if (!hasSecurityKey) {
                webui.setData('app-nav-home', 'Security Key');
                webui.setData('app-home-source', "d/first_run.md");
                return;
            }
            t.loadProjects();
        },
        async loadProjects() {
            const t = this;
            await whenProxyReady();
            let projects = await webui.proxy.getProjects() || [];
            webui.setData('app-projects', projects);
            if (projects.length === 0) {
                webui.setData('app-nav-home', 'First Project');
                webui.setData('app-home-source', "d/home_new_project.md");
            } else {
                webui.setData('app-nav-home', 'Settings');
                webui.setData('app-home-source', "d/home_settings.md");
            }
        }
    });
}
