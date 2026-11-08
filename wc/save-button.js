
/* Template for Web UI components. */
"use strict"
{
    let isSavingProject = false;
    let isSavingApp = false;
    webui.define("app-save-button", {
        connected() {
            const t = this;
            t.setAttribute('title', 'Save Project & App Data');
            makeButton(t);
            let icon = webui.create('webui-icon', { theme: 'success', 'icon': 'emoji-floppy_disk|fill' });
            t.appendChild(icon);
            function saveProject() {
                if (isSavingProject) return;
                isSavingProject = true;
                Promise.resolve(webui.proxy.saveProjectData()).then((msg) => {
                    isSavingProject = false;
                    // Errors have already been shown, and resolve with no message.
                    if (msg) webui.alert(msg, 'success');
                }).catch(msg => {
                    isSavingProject = false;
                    webui.alert(msg);
                });
            }
            function saveApp() {
                if (isSavingApp) return;
                isSavingApp = true;
                Promise.resolve(webui.proxy.saveAppData()).then((msg) => {
                    isSavingApp = false;
                    if (msg) webui.alert(msg, 'success');
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
        disconnected() { },
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