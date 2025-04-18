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
            t._btn.addEventListener('click', webui.eventSoloProcess(async _ => {
                let name = webui.getData('new-project-name') || '';
                if (!name) {
                    alert('Please set the name of the project before selecting your project folder');
                    return;
                }
                alert('Selecting folder', 'info');
                let result = await webui.proxy.addProject(name);
                console.log('Got result', result);
                if (!result) return;
                alert(result, 'success');
                webui.setData('home-state', 'project-added');
                webui.setData('new-project-name', '');
            }, alert));
            function alert(ex, theme) {
                console.log('Alert', ex);
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