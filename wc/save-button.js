
/* Template for Web UI components. */
"use strict"
{
    let isSavingProject = false;
    let isSavingApp = false;
    webui.define("app-save-button", {
        connected: function (t) {
            t.setAttribute('title', 'Save Project & App Data');
            let icon = webui.create('webui-icon', { theme: 'success', 'icon': 'save|fill' });
            t.appendChild(icon);
            function saveProject() {
                if (isSavingProject) return;
                isSavingProject = true;
                webui.proxy.saveProjectData().then((msg) => {
                    isSavingProject = false;
                    webui.alert(msg, 'success');
                }).catch(msg => {
                    isSavingProject = false;
                    webui.alert(msg);
                });
            }
            function saveApp() {
                if (isSavingApp) return;
                isSavingApp = true;
                webui.proxy.saveAppData().then((msg) => {
                    isSavingApp = false;
                    webui.alert(msg, 'success');
                }).catch(msg => {
                    isSavingApp = false;
                    webui.alert(msg);
                });
            }
            t.addEventListener('click', _ => {
                saveProject();
                saveApp();
            });
        },
        disconnected: function (t) { },
        shadowTemplate: `
<style type="text/css">
:host {
cursor:pointer;
}
</style>
<slot></slot>
`
    });
}