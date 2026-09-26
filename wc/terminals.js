"use strict"
{
    webui.define("app-terminals", {
        linkCss: false,
        watchVisibility: false,
        isInput: false,
        preload: 'dropdown toggle-icon input-message dialogs',
        constructor() {
            const t = this;
            t.icon = t.template.querySelector('webui-icon');
        },
        attr: ['data-toggleclass'],
        flags: [],
        attrChanged(property, value) {
            const t = this;
            if (property === 'dataToggleclass') t.drawer = value.split('|')[0];
        },
        connected() {
            const t = this;
            t.addEventListener('click', () => {
                t.openDrawer();
                return true;
            });
        },
        disconnected() { },
        openDrawer() {
            const t = this;
            let el = document.querySelector(t.drawer);
            if (!el) {
                webui.alert('Drawer not found!');
                return;
            }
            if (el.classList.contains('open')) {
                el.classList.remove('open');
                setTimeout(() => t.openDrawer(), 500);
                return;
            }
            el.innerHTML = '';
            const header = webui.create('header');
            header.style.padding = 'var(--padding)';
            header.setAttribute('slot', 'header');
            header.innerHTML = 'Terminal Manager';
            header.style.width = '2000px';
            header.style.maxWidth = '100%';
            el.appendChild(header);
            el.appendChild(t.getBodyContent());
            setTimeout(() => {
                el.classList.add('open');
            }, 100);
        },
        getBodyContent() {
            const t = this;
            webui.proxy.terminalHelpers.ensureListeners();
            const state = webui.proxy.terminalHelpers.getState();
            const container = webui.create('section');
            container.style.padding = 'var(--padding)';
            container.style.display = 'flex';
            container.style.flexDirection = 'column';
            container.style.gap = 'var(--padding)';
            container.style.height = 'calc(100% - var(--header-height, 60px))';
            container.style.boxSizing = 'border-box';
            container.innerHTML = `
<div id="term-content-wrapper" style="display:none; flex-direction:column; gap:var(--padding); height:100%;">
    <webui-grid columns="1fr max-content" gap="var(--padding)" align="center">
        <webui-dropdown label="Terminal / Script" id="term-dropdown"></webui-dropdown>
        <webui-toggle-icon id="term-filter-toggle" label="All Scripts" theme-on="primary"></webui-toggle-icon>
    </webui-grid>
    <webui-flex gap="0.5rem" align="center" wrap="wrap">
        <webui-button id="btn-run" theme="primary" label="Run"></webui-button>
        <webui-button id="btn-kill" theme="warning" label="Kill"></webui-button>
        <webui-button id="btn-kill-all" theme="danger" label="Kill All"></webui-button>
        <webui-button id="btn-save" theme="success" label="Save"></webui-button>
        <webui-button id="btn-save-as" theme="info" label="Save As"></webui-button>
        <webui-button id="btn-clear" theme="secondary" label="Clear Output" style="margin-left: auto;"></webui-button>
    </webui-flex>
    <webui-flex column style="flex: 1 1 50%; min-height: 0;">
        <label style="font-weight: bold; margin-bottom: 0.25rem;">Script Content:</label>
        <webui-input-message id="term-editor" style="height: 100%; min-height: 120px;"></webui-input-message>
    </webui-flex>
    <webui-flex column style="flex: 1 1 50%; min-height: 0;">
        <label style="font-weight: bold; margin-bottom: 0.25rem;">Console Output:</label>
        <div id="term-console" style="
            flex: 1; background: #111; color: #eee; padding: 0.5rem;
            border-radius: 4px; overflow-y: auto; font-family: monospace;
            border: 1px solid var(--site-background-offset, #444); min-height: 140px;
        "></div>
    </webui-flex>
</div>
<div id="term-install-wrapper" style="display:none; flex-direction:column; gap:var(--padding); align-items:center; text-align:center; padding: 2rem;">
    <webui-icon icon="emoji-warning" style="font-size: 3rem; margin-bottom: 1rem; color: var(--color-warning);"></webui-icon>
    <h2>PowerShell Not Found</h2>
    <webui-content id="term-install-instructions"></webui-content>
    <webui-button id="btn-install-pwsh" theme="success" label="Install PowerShell" style="display:none; margin-top: 1rem;"></webui-button>
</div>
`;
            setTimeout(async () => {
                const contentWrapper = container.querySelector('#term-content-wrapper');
                const installWrapper = container.querySelector('#term-install-wrapper');
                const psStatus = await webui.proxy.terminal.getPowerShellStatus(err => {
                    webui.log.warn('PowerShell detection failed:', err);
                    return null;
                });
                if (!psStatus || !psStatus.installed) {
                    installWrapper.style.display = 'flex';
                    if (psStatus) {
                        await customElements.whenDefined('webui-content');
                        const installInstructions = container.querySelector('#term-install-instructions');
                        installInstructions.setHtml(webui.parseMarkdown(psStatus.instructions));
                        if (psStatus.canAutoInstall) {
                            const btnInstallPwsh = container.querySelector('#btn-install-pwsh');
                            btnInstallPwsh.style.display = 'inline-flex';
                            btnInstallPwsh.addEventListener('click', async () => {
                                webui.proxy.loading.show('Installing PowerShell...');
                                let msg = await webui.proxy.terminal.autoInstallPowerShell(err => webui.alert(err, 'danger'));
                                webui.proxy.loading.hide();
                                if (msg) {
                                    webui.alert(msg, 'success');
                                    t.openDrawer();
                                }
                            });
                        }
                    }
                    return;
                }
                contentWrapper.style.display = 'flex';
                t._activeDropdown = container.querySelector('#term-dropdown');
                const filterToggle = container.querySelector('#term-filter-toggle');
                t._activeEditor = container.querySelector('#term-editor');
                t._activeConsole = container.querySelector('#term-console');
                t._btnRun = container.querySelector('#btn-run');
                t._btnKill = container.querySelector('#btn-kill');
                const btnKillAll = container.querySelector('#btn-kill-all');
                t._btnSave = container.querySelector('#btn-save');
                const btnSaveAs = container.querySelector('#btn-save-as');
                const btnClear = container.querySelector('#btn-clear');
                let initState = webui.proxy.terminalHelpers.getState();
                initState.allScripts = await webui.proxy.getScripts() || [];
                webui.setData('app-terminal-state', initState);
                filterToggle.value = initState.showAllScripts;
                filterToggle.addEventListener('change', () => {
                    let state = webui.proxy.terminalHelpers.getState();
                    state.showAllScripts = !!filterToggle.value;
                    webui.setData('app-terminal-state', state);
                    t.refreshDropdown();
                });
                t._activeDropdown.addEventListener('change', () => t.switchTerminal(t._activeDropdown.value));
                t._activeEditor.addEventListener('input', () => {
                    let state = webui.proxy.terminalHelpers.getState();
                    if (state.terminals[state.activeId]) {
                        state.terminals[state.activeId].script = t._activeEditor.value;
                        webui.setData('app-terminal-state', state);
                    }
                });
                t._btnRun.addEventListener('click', async () => {
                    let state = webui.proxy.terminalHelpers.getState();
                    const current = state.terminals[state.activeId];
                    if (!current) return;
                    const scriptText = t._activeEditor.value;
                    if (!scriptText || !scriptText.trim()) {
                        webui.alert('Please enter a script to run.', 'warning');
                        return;
                    }
                    if (current.status === 'Running') {
                        await webui.proxy.terminal.kill(current.id).catch(console.warn);
                    }
                    state = webui.proxy.terminalHelpers.getState();
                    state.terminals[state.activeId].status = 'Running';
                    webui.setData('app-terminal-state', state);
                    webui.proxy.terminalHelpers.clearOutput(state.activeId);
                    webui.setData('app-terminal-refresh', Date.now());
                    try {
                        await webui.proxy.terminal.start(state.activeId, scriptText);
                    } catch (err) {
                        webui.alert(err, 'danger');
                        state = webui.proxy.terminalHelpers.getState();
                        if (state.terminals[state.activeId]) {
                            state.terminals[state.activeId].status = 'Finished';
                            webui.setData('app-terminal-state', state);
                        }
                        webui.setData('app-terminal-refresh', Date.now());
                    }
                });
                t._btnKill.addEventListener('click', async () => {
                    let state = webui.proxy.terminalHelpers.getState();
                    const current = state.terminals[state.activeId];
                    if (!current || current.status !== 'Running') return;
                    await webui.proxy.terminal.kill(current.id);

                    state = webui.proxy.terminalHelpers.getState();
                    if (state.terminals[state.activeId]) {
                        state.terminals[state.activeId].status = 'Finished';
                        webui.setData('app-terminal-state', state);
                    }
                    webui.setData('app-terminal-refresh', Date.now());
                });
                btnKillAll.addEventListener('click', async () => {
                    await webui.proxy.terminal.killAll();
                    let state = webui.proxy.terminalHelpers.getState();
                    Object.values(state.terminals).forEach(term => {
                        if (term.status === 'Running') term.status = 'Finished';
                    });
                    webui.setData('app-terminal-state', state);
                    webui.setData('app-terminal-refresh', Date.now());
                });
                t._btnSave.addEventListener('click', async () => {
                    let state = webui.proxy.terminalHelpers.getState();
                    if (state.activeId === 'live') return;
                    const msg = await webui.proxy.saveProjectFile(state.activeId, t._activeEditor.value);
                    if (msg) webui.alert(msg, 'success');
                });
                btnSaveAs.addEventListener('click', () => {
                    webui.dialog({
                        title: 'Save Script As',
                        content: '<webui-flex column><webui-input-text name="scriptName" label="Script Name (without .ps1)"></webui-input-text></webui-flex>',
                        confirm: 'Save',
                        cancel: 'Cancel',
                        onconfirm: async (data, content) => {
                            const formData = Object.fromEntries(data);
                            const name = (formData.scriptName || '').trim();
                            if (!name) {
                                content.alert('Script name cannot be empty.');
                                return false;
                            }
                            const targetPath = `.taskproxy/scripts/${name}.ps1`;
                            let state = webui.proxy.terminalHelpers.getState();
                            state.allScripts = await webui.proxy.getScripts() || [];
                            if (state.allScripts.includes(targetPath)) {
                                content.alert('A script with that name already exists.');
                                return false;
                            }
                            const msg = await webui.proxy.saveProjectFile(targetPath, t._activeEditor.value);
                            if (msg) {
                                webui.alert(msg, 'success');
                                state = webui.proxy.terminalHelpers.getState();
                                state.allScripts.push(targetPath);
                                webui.setData('app-terminal-state', state);
                                webui.setData('app-terminal-refresh', Date.now());
                                await t.switchTerminal(targetPath);
                                return true;
                            }
                        }
                    });
                });
                btnClear.addEventListener('click', () => {
                    let state = webui.proxy.terminalHelpers.getState();
                    webui.proxy.terminalHelpers.clearOutput(state.activeId);
                    webui.setData('app-terminal-refresh', Date.now());
                });
                t.switchTerminal(initState.activeId);
                if (!t._streamAttached) {
                    t._streamAttached = true;
                    document.addEventListener('term-line-out', (ev) => {
                        let state = webui.proxy.terminalHelpers.getState();
                        const data = ev.detail;
                        if (state.activeId === data.terminalId) {
                            t.appendConsoleLine(data.content, data.isError);
                        }
                    });
                }
            }, 0);
            return container;
        },
        async switchTerminal(id) {
            let state = webui.proxy.terminalHelpers.getState();
            state.activeId = id;
            if (!state.terminals[id]) {
                let scriptContent = '';
                if (id !== 'live') {
                    scriptContent = await webui.proxy.getProjectFile(id) || '';
                }
                state.terminals[id] = { id: id, name: id, status: 'Ready', script: scriptContent, output: [], isLive: id === 'live' };
            }
            webui.setData('app-terminal-state', state);
            const current = state.terminals[id];
            if (this._activeEditor) this._activeEditor.value = current.script || '';
            this.renderConsole();
            this.refreshDropdown();
            this.refreshButtons();
        },
        refreshDropdown() {
            if (!this._activeDropdown) return;
            const state = webui.proxy.terminalHelpers.getState();
            this._activeDropdown.setOptions(webui.proxy.terminalHelpers.getDropdownOptions(state, state.showAllScripts));
            this._activeDropdown.value = state.activeId;
        },
        refreshButtons() {
            const state = webui.proxy.terminalHelpers.getState();
            const current = state.terminals[state.activeId];
            const isRunning = current && current.status === 'Running';
            const isLive = state.activeId === 'live';
            if (this._btnRun) this._btnRun.innerHTML = isRunning ? 'Restart' : 'Run';
            if (this._btnKill) this._btnKill.disabled = !isRunning;
            if (this._btnSave) this._btnSave.style.display = isLive ? 'none' : 'inline-flex';
        },
        renderConsole() {
            if (!this._activeConsole) return;
            this._activeConsole.innerHTML = '';
            const state = webui.proxy.terminalHelpers.getState();
            const current = state.terminals[state.activeId];
            if (!current || !current.output.length) {
                const placeholder = webui.create('div');
                placeholder.style.color = 'var(--site-background-offset, #888)';
                placeholder.style.fontStyle = 'italic';
                placeholder.textContent = 'No terminal output.';
                this._activeConsole.appendChild(placeholder);
                return;
            }
            current.output.forEach(entry => this.appendConsoleLine(entry.text, entry.isError));
        },
        appendConsoleLine(text, isError) {
            if (!this._activeConsole) return;
            if (this._activeConsole.firstChild && this._activeConsole.firstChild.textContent === 'No terminal output.') {
                this._activeConsole.innerHTML = '';
            }
            const line = webui.create('div');
            line.textContent = text;
            if (isError) line.style.color = 'var(--color-danger, #ff4d4d)';
            this._activeConsole.appendChild(line);
            this._activeConsole.scrollTop = this._activeConsole.scrollHeight;
        },
        onTerminalOutput(data) {
            if (!data) return;
            const state = webui.proxy.terminalHelpers.getState();
            if (state.activeId === data.terminalId) {
                this.appendConsoleLine(data.content, data.isError);
            }
        },
        onTerminalRefresh() {
            this.refreshDropdown();
            this.refreshButtons();
        },
        onTerminalCleared(data) {
            if (!data) return;
            const state = webui.proxy.terminalHelpers.getState();
            if (state.activeId === data.terminalId) {
                this.renderConsole();
            }
        },
        shadowTemplate: `
<style type="text/css">
:host { display:inline-flex; cursor:pointer; padding:1px; align-items:center; justify-content:center; }
</style>
<span style="display:none;" data-subscribe="app-terminal-output:onTerminalOutput"></span>
<span style="display:none;" data-subscribe="app-terminal-refresh:onTerminalRefresh"></span>
<span style="display:none;" data-subscribe="app-terminal-cleared:onTerminalCleared"></span>

<webui-icon icon="emoji-pager|theme:black|shape:circle|fill"></webui-icon>
`
    });
}
