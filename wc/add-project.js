"use strict"
{
    webui.define("app-add-project", {
        linkCss: false,
        watchVisibility: false,
        isInput: false,
        preload: '',
        constructor() {
            const t = this;
            t._alert = t.template.querySelector('webui-alert');
            t._btnSingle = t.template.querySelector('webui-button[theme="primary"]');
            t._btnMulti = t.template.querySelector('webui-button[theme="secondary"]');
        },
        connected() {
            const t = this;
            t._btnSingle.addEventListener('click', webui.eventSoloProcess(async _ => {
                let name = webui.getData('new-project-name') || '';
                alert('Selecting folder', 'info');
                let result = await webui.proxy.addProject(name);
                if (!result) return;
                alert(result, 'success');
                webui.setData('home-state', 'project-added');
                webui.setData('new-project-name', '');
            }, alert));
            t._btnMulti.addEventListener('click', webui.eventSoloProcess(async _ => {
                alert('Selecting folders', 'info');
                let results = await webui.proxy.addProjectsMulti();
                if (!results) return;
                let successCount = results.filter(msg => msg.startsWith('Added')).length;
                let errorCount = results.length - successCount;
                if (successCount > 0) {
                    webui.setData('home-state', 'project-added');
                }
                let theme = errorCount === 0 ? 'success' : (successCount === 0 ? 'danger' : 'warning');
                alert(results.join('<br>'), theme);
            }, alert));
            function alert(ex, theme) {
                t._alert.setValue({ text: ex, theme: theme || 'danger' });
            }
        },
        disconnected() { },
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
<webui-button theme="secondary">Add Multiple Projects</webui-button>
</webui-flex>
<webui-alert id="alert"></webui-alert>
`
    });
}
