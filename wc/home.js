/* Template for Web UI components. */
"use strict"
webui.define("app-home", {
    constructor: (t) => {
    },
    attr: ['example'],
    attrChanged: (t, property, value) => {
        switch (property) {
            case 'example':
                break;
        }
    },
    connected: function () {
        let t = this;
        t.checkAppState();
    },
    disconnected: function () { },
    checkAppState: async function () {
        let t = this;
        let hasPassphrase = await window.__TAURI__.core.invoke('has_securitykey', {}).catch(msg => console.log(msg));
        if (!hasPassphrase) {
            webui.setData('home-source', "d/en-US/first_run.md");
            return;
        }
        t.loadProjects();
    },
    loadProjects: async function () {
        let t = this;
        let projects = await window.__TAURI__.core.invoke('get_projects', {}).catch(msg => console.log(msg));
        if (!projects) {
            console.log('No projects found');
            webui.setData('home-source', "d/en-US/home_new_project.md");
        } else {
            console.log('Found projects', projects);
            webui.setData('')
            webui.setData('home-source', "d/en-US/home_projects.md");
        }
    }
});
