"use strict"
{
    webui.define("app-script-manager", {
        linkCss: true,
        preload: '',
        constructor() {
            const t = this;
            t._fileSelector = t.template.querySelector('webui-dropdown[label="Script"]');
            t._message = t.template.querySelector('webui-input-message');
            t._btnReset = t.template.querySelector('webui-button[label="Reset"]');
            t._btnSave = t.template.querySelector('webui-button[label="Save"]');
            t._btnNew = t.template.querySelector('webui-button[label="New Script"]');
        },
        async loadScripts(selectFile) {
            let t = this;
            webui.proxy.projects.runWhenLoaded(async () => {
                let scripts = await webui.proxy.getScripts();
                let options = (scripts || []).map(fileName => {
                    return { id: fileName, value: fileName, display: fileName };
                });
                t._fileSelector.setOptions(options);

                if (selectFile) {
                    t._fileSelector.value = selectFile;
                    t.loadScript(selectFile);
                } else if (options.length > 0) {
                    t.loadScript(t._fileSelector.value);
                } else {
                    t._message.value = '';
                }
            });
        },
        async loadScript(file) {
            let t = this;
            t._message.value = '';
            if (!file) return;
            let fileContent = await webui.proxy.getProjectFile(file);
            if (fileContent !== undefined) {
                t._message.value = fileContent;
            } else {
                webui.alert('Failed to load script content', 'danger');
            }
        },
        connected() {
            const t = this;
            t._fileSelector.addEventListener('change', ev => {
                t.loadScript(t._fileSelector.value);
            });
            t._btnReset.addEventListener('click', ev => {
                t.loadScript(t._fileSelector.value);
            });
            t._btnSave.addEventListener('click', async ev => {
                let file = t._fileSelector.value;
                if (!file) return;
                let msg = await webui.proxy.saveProjectFile(file, t._message.value);
                if (msg) { webui.alert(msg, 'success'); }
            });
            t._btnNew.addEventListener('click', async ev => {
                webui.dialog({
                    title: 'New Script',
                    content: '<webui-flex column><webui-input-text name="scriptName" label="Script Name (without .ps1)"></webui-input-text></webui-flex>',
                    confirm: 'Create',
                    cancel: 'Cancel',
                    onconfirm: async (data, content) => {
                        let formData = Object.fromEntries(data);
                        let scriptName = (formData.scriptName || '').trim();
                        if (!scriptName) {
                            content.alert('Script name cannot be empty.');
                            return false;
                        }
                        let fileName = `.taskproxy/scripts/${scriptName}.ps1`;
                        let msg = await webui.proxy.saveProjectFile(fileName, '# New PowerShell Script\n');
                        if (msg) {
                            webui.alert('Script created successfully.', 'success');
                            t.loadScripts(fileName);
                            return true;
                        }
                    }
                });
            });
            t.loadScripts();
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
<webui-grid columns="1fr max-content max-content max-content">
    <webui-dropdown label="Script"></webui-dropdown>
    <webui-button theme="primary" label="New Script"></webui-button>
    <webui-button theme="warning" label="Reset"></webui-button>
    <webui-button theme="success" label="Save"></webui-button>
</webui-grid>
<webui-flex align="center" justify="start" gap="var(--padding)">
    <webui-toggle-icon data-bind="app-script-separate-window" data-default="false" label="Run in separate window" theme-on="primary"></webui-toggle-icon>
    <webui-toggle-icon data-bind="app-script-queue" data-default="false" label="Run in sequence (Queue)" theme-on="primary"></webui-toggle-icon>
</webui-flex>
<webui-input-message style="min-height: 60vh;"></webui-input-message>
`
    });
}
