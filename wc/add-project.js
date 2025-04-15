"use strict"
{
    webui.define("app-add-project", {
        linkCss: false,
        watchVisibility: false,
        isInput: false,
        preload: '',
        constructor: (t) => {
            t._alert = t.template.querySelector('webui-alert');
            t._btn = t.template.querySelector('webui-button[theme="primary"]');
        },
        connected: function (t) {
            t._btn.addEventListener('click', webui.trySoloProcess(async _ => {
                let name = webui.getData('new-project-name') || '';
                if (!name) {
                    alert('Please set the name of the project before selecting your project folder');
                    return;
                }
                alert('Selecting folder', 'info');
                let result = await window.__TAURI__.core.invoke('add_project', { name: name });
                if (!result) return;
                alert(result, 'success');
                webui.setData('home-state', 'project-added');
                webui.setData('new-project-name', '');
                projects = await window.__TAURI__.core.invoke('get_projects', {});
                projects = projects || [];
                webui.setData('app-projects', projects);
            }, alert));
            function alert(ex, theme) {
                t._alert.setValue({ text: ex, theme: theme || 'danger' });
            }
        },
        disconnected: function () { },
        shadowTemplate: `
<style type="text/css">
:host {
display:flex;
flex-direction:column;
gap:var(--padding);
}
</style>
<webui-flex style="max-width:700px" gap="var(--padding)">
<webui-input-text label="Project Name" data-trigger="new-project-name" data-subscribe="new-project-name:value"></webui-input-text>
<webui-button theme="primary">Select Project Folder</webui-button>
</webui-flex>
<webui-alert id="alert"></webui-alert>
`
    });
}