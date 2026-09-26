"use strict"
{
    webui.define("app-script-manager", {
        linkCss: true,
        preload: '',
        constructor() {
            const t = this;
            t._fileSelector = t.template.querySelector('webui-dropdown[label="Script"]');
            t._message = t.template.querySelector('webui-input-message');
            t._btnRun = t.template.querySelector('webui-button[label="Run"]');
            t._btnReset = t.template.querySelector('webui-button[label="Reset"]');
            t._btnSave = t.template.querySelector('webui-button[label="Save"]');
            t._btnNew = t.template.querySelector('webui-button[label="New Script"]');
        },
        async loadScripts(selectFile) {
            let t = this;
            await webui.wait(() => !!webui.proxy);
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
            await webui.wait(()=>!!webui.proxy);
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
            t._btnRun.addEventListener('click', async ev => {
                let file = t._fileSelector.value;
                if (!file) {
                    webui.alert('No script selected.', 'warning');
                    return;
                }
                let scriptContent = t._message.value;
                if (!scriptContent.trim()) {
                    webui.alert('Script is empty.', 'warning');
                    return;
                }
                let runInSeparateWindow = webui.getData('app-script-separate-window') === true || webui.getData('app-script-separate-window') === 'true';
                let runInQueue = webui.getData('app-script-queue') === true || webui.getData('app-script-queue') === 'true';
                await webui.proxy.saveProjectFile(file, scriptContent);
                webui.proxy.terminalHelpers.ensureListeners();
                let state = webui.proxy.terminalHelpers.getState();
                if (!state.terminals[file]) {
                    state.terminals[file] = { id: file, name: file, status: 'Ready', script: scriptContent, output: [], isLive: false };
                }
                if (state.terminals[file].status === 'Running') {
                    webui.alert('Script is already running. You can manage it in the Terminal Manager.', 'warning');
                    return;
                }
                state.terminals[file].status = 'Running';
                state.terminals[file].script = scriptContent;
                if (!state.allScripts.includes(file)) {
                    state.allScripts.push(file);
                }
                webui.setData('app-terminal-state', state);
                webui.proxy.terminalHelpers.clearOutput(file);
                webui.setData('app-terminal-refresh', Date.now());
                try {
                    await webui.proxy.terminal.start(file, scriptContent);
                    webui.alert('Script started in Terminal Manager.', 'success');
                } catch (err) {
                    webui.alert(err, 'danger');
                    let currentState = webui.proxy.terminalHelpers.getState();
                    if (currentState.terminals[file]) {
                        currentState.terminals[file].status = 'Finished';
                        webui.setData('app-terminal-state', currentState);
                        webui.setData('app-terminal-refresh', Date.now());
                    }
                }
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
<webui-flex align="center">
    <webui-dropdown label="Script"></webui-dropdown>
    <webui-button theme="info" label="Run"></webui-button>
    <webui-button theme="primary" label="New Script"></webui-button>
    <webui-button theme="warning" label="Reset"></webui-button>
    <webui-button theme="success" label="Save"></webui-button>
</webui-flex>
<webui-flex align="center" justify="start" gap="var(--padding)">
    <webui-toggle-icon data-bind="app-script-separate-window" data-default="false" label="Run in separate window" theme-on="primary"></webui-toggle-icon>
    <webui-toggle-icon data-bind="app-script-queue" data-default="false" label="Run in sequence (Queue)" theme-on="primary"></webui-toggle-icon>
</webui-flex>
<webui-input-message style="min-height: 60vh;"></webui-input-message>
`
    });
}
