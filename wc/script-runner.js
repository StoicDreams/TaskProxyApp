"use strict"
{
    webui.define("app-script-runner", {
        linkCss: true,
        preload: 'code input-message',
        constructor() {
            const t = this;
            t._message = t.template.querySelector('webui-input-message');
            t._btnRun = t.template.querySelector('webui-button[label="Run"]');
            t._btnReset = t.template.querySelector('webui-button[label="Reset"]');
            t._btnSave = t.template.querySelector('webui-button[label="Save"]');
            t._paramsContainer = t.template.querySelector('.params-container');
            t._btnParamsClear = t.template.querySelector('webui-button[label="Clear Params"]');
            t._previewPanel = t.template.querySelector('webui-code');
            t._toggleFullPath = t.template.querySelector('webui-toggle-icon[label="Full Path"]');
            t._fileName = '';
        },
        attr: ['src'],
        attrChanged(property, value) {
            const t = this;
            switch (property) {
                case 'src':
                    t.loadScript(value);
                    break;
            }
        },
        async loadScript(file) {
            const t = this;
            t._fileName = file;
            await webui.wait(()=>!!webui.proxy);
            t._message.value = await webui.proxy.getProjectFile(file) || '';
            t.parseParams(t._message.value);
        },
        parseParams(scriptContent) {
            const t = this;
            let params = [];
            let match = scriptContent.match(/^\s*(?:(?:<#[\s\S]*?#>|#[^\n]*)\s*)*param\s*\(([\s\S]*?)\)/i);
            if (match) {
                let paramBlock = match[1];
                let parts = paramBlock.split('$');
                for (let i = 1; i < parts.length; i++) {
                    let prefix = parts[i - 1];
                    let nameMatch = parts[i].match(/^([a-zA-Z0-9_]+)/);
                    if (nameMatch) {
                        let pName = nameMatch[1];
                        let isSwitch = /\[.*switch.*\]/i.test(prefix);
                        if (!params.find(p => p.name === pName)) {
                            params.push({ name: pName, isSwitch: isSwitch });
                        }
                    }
                }
            }
            let currentParams = Array.from(t._paramsContainer.children).map(el => ({
                name: el.getAttribute('data-param'),
                isSwitch: el.tagName.toLowerCase() === 'webui-toggle-icon'
            }));
            if (JSON.stringify(currentParams) !== JSON.stringify(params)) {
                t._paramsContainer.innerHTML = '';
                params.forEach(p => {
                    let input;
                    if (p.isSwitch) {
                        input = webui.create('webui-toggle-icon', {
                            label: p.name,
                            'data-bind': `script-${p.name}`,
                            'data-param': p.name,
                            'theme-on': 'primary'
                        });
                        input.addEventListener('change', () => t.updatePreview());
                    } else {
                        input = webui.create('webui-input-text', {
                            label: p.name,
                            'data-bind': `script-${p.name}`,
                            'data-param': p.name
                        });
                        input.addEventListener('input', () => t.updatePreview());
                    }
                    t._paramsContainer.appendChild(input);
                });
            }
            t.updatePreview();
        },
        async updatePreview() {
            const t = this;
            await webui.wait(() => t._previewPanel.setValue);
            if (!t._fileName) {
                t._previewPanel.value = '';
                return;
            }
            let isFull = t._toggleFullPath.value === true || t._toggleFullPath.value === 'true';
            let cmdPath = t._fileName;
            if (!isFull) {
                let parts = t._fileName.split(/[\/\\]/);
                cmdPath = `.\\${parts[parts.length - 1]}`;
            } else if (webui.projectData && webui.projectData.path) {
                cmdPath = `${webui.projectData.path}/${t._fileName}`.replace(/\\/g, '/');
            }
            let cmd = cmdPath.includes(' ') ? `& "${cmdPath}"` : cmdPath;
            let params = Array.from(t._paramsContainer.children);
            params.forEach(input => {
                let pName = input.getAttribute('data-param');
                let pVal = webui.getData(`script-${pName}`) || input.value;
                let isSwitch = input.tagName.toLowerCase() === 'webui-toggle-icon';
                if (isSwitch) {
                    if (pVal === true || pVal === 'true') {
                        cmd += ` -${pName}`;
                    }
                } else {
                    if (pVal !== undefined && pVal !== null && pVal !== '') {
                        cmd += ` -${pName} "${pVal}"`;
                    }
                }
            });
            t._previewPanel.value = cmd;
        },
        connected() {
            const t = this;
            t._btnReset.addEventListener('click', async () => {
                if (!t._fileName) return;
                t.loadScript(t._fileName, fileContent);
            });
            t._btnSave.addEventListener('click', async () => {
                if (!t._fileName) return;
                let msg = await webui.proxy.saveProjectFile(t._fileName, t._message.value);
                if (msg) { webui.alert(msg, 'success'); }
            });
            t._btnRun.addEventListener('click', async () => {
                if (!t._fileName) {
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
                let args = [];
                let params = Array.from(t._paramsContainer.children);
                params.forEach(input => {
                    let pName = input.getAttribute('data-param');
                    let pVal = webui.getData(`script-${pName}`) || input.value;
                    let isSwitch = input.tagName.toLowerCase() === 'webui-toggle-icon';
                    if (isSwitch) {
                        if (pVal === true || pVal === 'true') {
                            args.push(`-${pName}`);
                        }
                    } else {
                        if (pVal !== undefined && pVal !== null && pVal !== '') {
                            args.push(`-${pName}`);
                            args.push(`${pVal}`);
                        }
                    }
                });
                await webui.proxy.saveProjectFile(t._fileName, scriptContent);
                webui.proxy.terminalHelpers.ensureListeners();
                try {
                    let result = await webui.proxy.terminalHelpers.runScript(t._fileName, scriptContent, args, runInSeparateWindow, runInQueue);
                    if (result === 'Queued') {
                        webui.alert('Script added to queue.', 'info');
                    } else {
                        webui.alert(runInSeparateWindow ? 'Script launched in separate window.' : 'Script started in Terminal Manager.', 'success');
                    }
                } catch (err) {
                    webui.alert(err, 'warning');
                }
            });
            t._btnParamsClear.addEventListener('click', () => {
                let params = Array.from(t._paramsContainer.children);
                params.forEach(input => {
                    let pName = input.getAttribute('data-param');
                    let isSwitch = input.tagName.toLowerCase() === 'webui-toggle-icon';
                    let resetVal = isSwitch ? false : '';
                    webui.setData(`script-${pName}`, resetVal);
                    input.value = resetVal;
                });
                t.updatePreview();
            });
            t._message.addEventListener('input', () => {
                t.parseParams(t._message.value);
            });
            t._toggleFullPath.addEventListener('change', () => {
                t.updatePreview();
            });
            t.updatePreview();
        },
        disconnected() { },
        shadowTemplate: `
<style type="text/css">
:host {
    display: flex;
    flex-direction: column;
    gap: var(--padding);
}
.params-container {
    display: flex;
    flex-wrap: wrap;
    gap: var(--padding);
}
.params-container:empty {
    display: none;
}
</style>
<webui-flex align="center">
    <webui-button theme="info" label="Run"></webui-button>
    <webui-button theme="warning" label="Reset"></webui-button>
    <webui-button theme="success" label="Save"></webui-button>
</webui-flex>
<div class="params-container"></div>
<webui-flex align="center" gap="var(--padding)">
    <webui-button theme="secondary" label="Clear Params"></webui-button>
    <webui-toggle-icon label="Full Path" data-default="false" theme-on="primary"></webui-toggle-icon>
</webui-flex>
<webui-page-segment>
<webui-code lang="powershell"></webui-code>
</webui-page-segment>
<webui-input-message style="min-height: 60vh;"></webui-input-message>
`
    });
}
