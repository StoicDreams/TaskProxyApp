/* Template for Web UI components. */
"use strict"
{
    let firstLoad = true;
    webui.define("app-home", {
        constructor: (t) => {
        },
        connected: function (t) {
            t.checkAppState();
        },
        disconnected: function (t) { },
        checkAppState: async function (k, v) {
            let t = this;
            let hasSecurityKey = await window.__TAURI__.core.invoke('has_securitykey', {}).catch(msg => webui.alert(msg));
            if (!hasSecurityKey) {
                webui.setData('home-source', "d/en-US/first_run.md");
                return;
            }
            t.loadProjects();
        },
        loadProjects: async function () {
            let t = this;
            console.log("Is First Load?", firstLoad);
            let projects = [];
            if (firstLoad) {
                firstLoad = false;
                projects = await window.__TAURI__.core.invoke('load_projects', {}).catch(msg => webui.alert(msg));
            } else {
                projects = await window.__TAURI__.core.invoke('get_projects', {}).catch(msg => webui.alert(msg));
            }

            if (!projects || projects.length === 0) {
                webui.setData('home-source', "d/en-US/home_new_project.md");
            } else {
                webui.setData('home-source', "d/en-US/home_projects.md");
            }
        }
    });
}