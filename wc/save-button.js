
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
            let icon = webui.create('webui-icon', { icon: 'save|theme:success|fill|backing|bordered' });
            t.appendChild(icon);
            // This is the header's Save icon, with no room by it for a message, so what saving did goes in the app's
            // alerts.
            function saveProject() {
                if (isSavingProject) return;
                isSavingProject = true;
                Promise.resolve(webui.proxy.saveProjectData()).then((msg) => {
                    isSavingProject = false;
                    // Errors have already been shown, and resolve with no message.
                    if (msg) appAlert(msg, 'success');
                }).catch(msg => {
                    isSavingProject = false;
                    appAlert(msg);
                });
            }
            function saveApp() {
                if (isSavingApp) return;
                isSavingApp = true;
                Promise.resolve(webui.proxy.saveAppData()).then((msg) => {
                    isSavingApp = false;
                    if (msg) appAlert(msg, 'success');
                }).catch(msg => {
                    isSavingApp = false;
                    appAlert(msg);
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
display:inline-flex;
cursor:pointer;
padding:1px;
align-items:center;
justify-content:center;
}
</style>
<slot></slot>
`
    });
}