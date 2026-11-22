"use strict"
{
    // A script's parameters, from its param block, come from parseScriptParams in app.js, which favorites use too.
    const parseParams = parseScriptParams;
    /** Page scripts and the live terminal have names, but no file to save to. */
    function isScriptFile(name) {
        if (!/\.ps1$/i.test(name || '')) return false;
        return !webui.proxy?.terminalHelpers?.getState().terminals[name]?.isPageScript;
    }
    webui.define("app-script-runner", {
        linkCss: true,
        preload: 'code input-message',
        constructor() {
            const t = this;
            t._message = t.template.querySelector('webui-input-message');
            t._btnRun = t.template.querySelector('webui-button[label="Run"]');
            t._btnReset = t.template.querySelector('webui-button[label="Reset"]');
            t._btnSave = t.template.querySelector('webui-button[label="Save"]');
            t._btnSaveAs = t.template.querySelector('webui-button[label="Save As"]');
            t._paramsContainer = t.template.querySelector('.params-container');
            t._btnParamsClear = t.template.querySelector('webui-button[label="Clear Params"]');
            t._previewPanel = t.template.querySelector('webui-code');
            t._toggleFullPath = t.template.querySelector('webui-toggle-icon[label="Full Path"]');
            t._readOnlyNote = t.template.querySelector('.read-only-note');
            t._label = t.template.querySelector('.runner-label');
            t._ai = t.template.querySelector('#ai-script');
            t._ai.action = args => t.writeWithAi(args);
            t._fileName = '';
            t._isReadOnly = false;
        },
        /** Writes or changes the script with AI into the editor, unsaved, for the user to check before saving. */
        async writeWithAi({ model, requestId, asked, isCurrent }) {
            const t = this;
            if (t._isReadOnly) return;
            // What Save said before is about the script as it was.
            clearActionNote(t._btnSave);
            const file = t._fileName;
            const current = t._message.value || '';
            // Longer than any run of backticks in the script, so the script can't end its own fence.
            const fence = '`'.repeat(Math.max(2, ...(current.match(/`+/g) || []).map(run => run.length)) + 1);
            const context = current.trim()
                ? `The script now${file ? `, ${file}` : ''}:\n\n${fence}powershell\n${current}\n${fence}`
                : (file ? `The script will be saved as ${file}.` : '');
            const request = current.trim() ? `${asked}\n\nReply with the whole script as it should be.` : asked;
            const draft = await webui.proxy.ai.write({ integration: 'scripts', model, requestId, request, context });
            if (!isCurrent() || t._fileName !== file || t._isReadOnly) return;
            // What was typed while it wrote is kept, and the draft, written from the script before, is not used.
            if ((t._message.value || '') !== current) throw 'The script changed while AI was writing, so the draft wasn\'t used, to keep your changes. Write with AI again to start from the script as it is now.';
            if (typeof draft !== 'string' || !draft.trim()) throw 'The AI answer was empty, so the script was left as it was. Try again, or with another model.';
            t._message.setValue(draft);
            t.parseParams(draft);
            t.updatePreview();
            t.markUnsaved();
        },
        /** Shows that the editor holds a draft that isn't saved, until it is saved or discarded. */
        markUnsaved() {
            const t = this;
            t._unsaved = true;
            actionNote(t._btnSave, 'Not saved yet. Check the script, then Save it.', 'warning');
        },
        /**
         * Whether to keep an unsaved draft rather than show something else, asking before it is discarded. Showing
         * `nextContent` when it is the draft itself discards nothing.
         */
        async keepUnsaved(nextContent) {
            const t = this;
            if (!t._unsaved) return false;
            if (nextContent !== undefined && nextContent === (t._message.value || '')) return false;
            // Asked again while the question is open, as by a second quick switch: the one answer goes for both.
            if (t._asking) return t._asking;
            t._asking = t.askToDiscard();
            try {
                return await t._asking;
            } finally {
                t._asking = null;
            }
        },
        /** Asks whether to discard the unsaved draft, and discards it if so. Resolves to whether it was kept. */
        async askToDiscard() {
            const t = this;
            const discard = await new Promise(resolve => {
                webui.dialog({
                    title: 'Discard Unsaved Changes?',
                    content: `<p>The script${t._fileName ? ` <strong>${webui.escapeForHTML(t._fileName)}</strong>` : ''} has changes that aren't saved. Discard them?</p>`,
                    confirm: 'Discard',
                    cancel: 'Keep Editing',
                    onconfirm: () => {
                        resolve(true);
                        return true;
                    },
                    // Cancel, Escape, and the close button reject the dialog's promise.
                }).catch(() => resolve(false));
            });
            if (discard) t.discardDraft();
            return !discard;
        },
        /** Forgets that the editor holds a draft, and what was said about it. */
        discardDraft() {
            const t = this;
            if (t._unsaved) clearActionNote(t._btnSave);
            t._unsaved = false;
        },
        attr: ['src', 'label'],
        attrChanged(property, value) {
            const t = this;
            switch (property) {
                case 'src':
                    t.loadScript(value);
                    break;
                case 'label':
                    // A heading at the start of the button row, such as the Terminal Manager's "Script Content:".
                    t._label.textContent = value || '';
                    t._label.hidden = !value;
                    break;
            }
        },
        /** Clears what the buttons said, which was about the script shown before. */
        clearNoteFor(file) {
            const t = this;
            if (file !== t._fileName) clearActionNote(t._btnRun);
        },
        /** Shows a file's script. Resolves to false when an unsaved draft was kept instead, and true otherwise. */
        async loadScript(file, { discard = false } = {}) {
            const t = this;
            if (!discard && await t.keepUnsaved()) return false;
            t.discardDraft();
            t.clearNoteFor(file);
            t._fileName = file;
            await whenProxyReady();
            let content = await webui.proxy.getProjectFile(file);
            if (t._fileName !== file) return true;
            if (content === undefined) {
                // The failure has been shown. Saving now would replace the file with an empty script.
                t.setScript('', '', { discard: true });
                return true;
            }
            t._message.value = content;
            t.parseParams(t._message.value);
            return true;
        },
        /** Shows a script. Resolves to false when an unsaved draft was kept instead, and true otherwise. */
        async setScript(file, content, { discard = false } = {}) {
            const t = this;
            if (!discard && await t.keepUnsaved(content || '')) return false;
            t.discardDraft();
            t.clearNoteFor(file);
            t._fileName = file;
            // This can be called before the editor component has loaded.
            await customElements.whenDefined('webui-input-message');
            if (t._fileName !== file) return true;
            t._message.setValue(content || '');
            t.parseParams(content || '');
            t.updatePreview();
            return true;
        },
        /**
         * Page scripts are shown with their injected values masked, so running or saving
         * what is shown would not do what the page does.
         */
        setReadOnly(isReadOnly) {
            const t = this;
            // What the buttons said goes with them, before they are hidden.
            if (isReadOnly) clearActionNote(t._btnRun);
            t._isReadOnly = !!isReadOnly;
            t.classList.toggle('read-only', t._isReadOnly);
            // Set on each control, since webui-flex manages its own display.
            [t._btnRun, t._btnReset, t._btnSave, t._btnSaveAs, t._btnParamsClear, t._toggleFullPath, t._paramsContainer, t._ai].forEach(el => {
                el.style.display = t._isReadOnly ? 'none' : '';
            });
            if (t._isReadOnly) {
                t._message.setAttribute('disabled', 'true');
            } else {
                t._message.removeAttribute('disabled');
            }
        },
        get scriptContent() {
            return this._message ? this._message.value : '';
        },
        parseParams(scriptContent) {
            const t = this;
            let params = parseParams(scriptContent);
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
            let cmdPath = t._fileName.replace(/\\/g, '/');
            if (!isFull) {
                if (!cmdPath.startsWith('./')) {
                    cmdPath = `./${cmdPath}`;
                }
            } else if (webui.projectData && webui.projectData.path) {
                cmdPath = `${webui.projectData.path}/${cmdPath}`.replace(/\\/g, '/');
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
        runSaveAs() {
            const t = this;
            webui.dialog({
                title: 'Save Script As',
                content: '<webui-flex column><webui-input-text name="scriptName" label="Script Name (without .ps1)"></webui-input-text></webui-flex>',
                confirm: 'Save',
                cancel: 'Cancel',
                onconfirm: async (data, content) => {
                    const formData = Object.fromEntries(data);
                    const name = (formData.scriptName || '').trim();
                    if (!name) {
                        content.alert('Script name cannot be empty.', 'warning');
                        return false;
                    }
                    const targetPath = `.taskproxy/scripts/${name}.ps1`;
                    let state = webui.proxy.terminalHelpers.getState();
                    state.allScripts = await webui.proxy.getScripts() || [];
                    if (state.allScripts.includes(targetPath)) {
                        content.alert('A script with that name already exists.', 'warning');
                        return false;
                    }
                    const msg = await webui.proxy.saveProjectFile(targetPath, t._message.value, err => content.alert(webui.escapeForHTML(`${err}`), 'danger'));
                    if (msg) {
                        t._unsaved = false;
                        // The dialog closes, and the script stays open here, so it is said by its Save button.
                        actionNote(t._btnSave, msg, 'success');
                        state = webui.proxy.terminalHelpers.getState();
                        state.allScripts.push(targetPath);
                        t._fileName = targetPath;
                        webui.setData('app-terminal-refresh', Date.now());
                        t.dispatchEvent(new CustomEvent('script-saved', { detail: targetPath }));
                        return true;
                    }
                    // The dialog stays open with the error, so the name can be changed.
                    return false;
                }
            });
        },
        connected() {
            const t = this;
            t._btnReset.addEventListener('click', async () => {
                if (t._isReadOnly) return;
                // Reset is asked for, so what isn't saved is discarded without asking.
                if (!isScriptFile(t._fileName)) {
                    t.setScript(t._fileName, '', { discard: true });
                    return;
                };
                t.loadScript(t._fileName, { discard: true });
            });
            t._btnSave.addEventListener('click', async () => {
                if (t._isReadOnly) return;
                if (!isScriptFile(t._fileName)) {
                    t.runSaveAs();
                    return;
                }
                clearActionNote(t._btnSave);
                let msg = await webui.proxy.saveProjectFile(t._fileName, t._message.value, err => actionNote(t._btnSave, err, 'danger'));
                if (msg) {
                    t._unsaved = false;
                    actionNote(t._btnSave, msg, 'success');
                }
            });
            t._btnSaveAs.addEventListener('click', () => {
                if (t._isReadOnly) return;
                t.runSaveAs();
            });
            t._btnRun.addEventListener('click', async () => {
                if (t._isReadOnly) return;
                let scriptContent = t._message.value;
                clearActionNote(t._btnRun);
                if (!scriptContent.trim()) {
                    actionNote(t._btnRun, 'Script is empty.', 'warning');
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
                // What runs is what is saved, so a script that couldn't be saved doesn't run.
                if (isScriptFile(t._fileName)) {
                    if (!await webui.proxy.saveProjectFile(t._fileName, scriptContent, err => actionNote(t._btnRun, err, 'danger'))) return;
                    t._unsaved = false;
                }
                webui.proxy.terminalHelpers.ensureListeners();
                try {
                    let result = await webui.proxy.terminalHelpers.runScript(t._fileName, scriptContent, args, runInSeparateWindow, runInQueue);
                    if (result === 'Queued') {
                        actionNote(t._btnRun, 'Script added to queue.', 'info');
                    } else {
                        actionNote(t._btnRun, runInSeparateWindow ? 'Script launched in separate window.' : 'Script started in Terminal Manager.', 'success');
                    }
                } catch (err) {
                    actionNote(t._btnRun, err, 'warning');
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
                // What is typed is kept as a draft, as an AI draft is, until it is saved or discarded.
                if (!t._isReadOnly) t._unsaved = true;
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
.read-only-note {
    display: none;
}
.runner-label {
    font-weight: bold;
}
.runner-label[hidden] {
    display: none;
}
:host(.read-only) .read-only-note {
    display: block;
}
</style>
<p class="read-only-note">Page scripts run from their page, which fills in their variables. Values are masked here.</p>
<webui-flex align="center" wrap="wrap">
    <span class="runner-label" hidden></span>
    <webui-button theme="info" label="Run"></webui-button>
    <webui-button theme="warning" label="Reset"></webui-button>
    <webui-button theme="success" label="Save"></webui-button>
    <webui-button theme="info" label="Save As"></webui-button>
    <webui-button theme="secondary" label="Clear Params"></webui-button>
    <webui-toggle-icon label="Full Path" theme-on="primary"></webui-toggle-icon>
    <app-ai-action id="ai-script" integration="scripts" label="Write with AI" ask="What should the script do? Describe it, or how to change the script that is open."></app-ai-action>
</webui-flex>
<div class="params-container"></div>
<webui-flex column>
<webui-code language="powershell"></webui-code>
<webui-input-message aria-label="Script" style="min-height: 60vh;"></webui-input-message>
</webui-flex>
`
    });
}
