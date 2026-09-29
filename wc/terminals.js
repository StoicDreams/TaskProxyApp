"use strict"
{
    webui.define("app-terminals", {
        linkCss: false,
        watchVisibility: false,
        isInput: false,
        preload: 'app:script-runner dropdown toggle-icon input-message dialogs',
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
        <webui-dropdown label="Script" id="term-dropdown"></webui-dropdown>
        <webui-toggle-icon id="term-filter-toggle" data-bind="app-terminals-all-scripts" label="All Scripts" theme-on="primary"></webui-toggle-icon>
    </webui-grid>
    <webui-flex gap="0.5rem" align="center" wrap="wrap">
        <webui-button id="btn-kill" theme="warning" label="Kill"></webui-button>
        <webui-button id="btn-kill-all" theme="danger" label="Kill All"></webui-button>
        <webui-button id="btn-clear" theme="secondary" label="Clear Output" style="margin-left: auto;"></webui-button>
    </webui-flex>
    <webui-flex column>
        <label style="font-weight: bold; margin-bottom: 0.25rem;">Script Content:</label>
        <app-script-runner id="term-runner" style="height: 100%; min-height: 120px;"></app-script-runner>
    </webui-flex>
    <webui-flex column style="min-height: 40vh;">
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
                t._filterToggle = container.querySelector('#term-filter-toggle');
                t._runner = container.querySelector('#term-runner');
                t._activeConsole = container.querySelector('#term-console');
                t._btnKill = container.querySelector('#btn-kill');
                const btnKillAll = container.querySelector('#btn-kill-all');
                const btnClear = container.querySelector('#btn-clear');
                let initState = webui.proxy.terminalHelpers.getState();
                initState.allScripts = await webui.proxy.getScripts() || [];
                t._filterToggle.addEventListener('change', () => {
                    t.refreshDropdown();
                });
                t._activeDropdown.addEventListener('change', () => t.switchTerminal(t._activeDropdown.value));
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
                    state.queue = [];
                    webui.setData('app-terminal-state', state);
                    webui.setData('app-terminal-refresh', Date.now());
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
            const t = this;
            let state = webui.proxy.terminalHelpers.getState();
            await webui.wait(() => t._runner && typeof t._runner.setScript === 'function');
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
            t.renderConsole();
            t.refreshDropdown();
            t.refreshButtons();
            setTimeout(() => {
                t._runner.setScript(current.id, current.script || '');
            }, 10);
        },
        async refreshDropdown() {
            const t = this;
            if (!t._activeDropdown) return;
            const state = webui.proxy.terminalHelpers.getState();
            t._activeDropdown.setOptions(await webui.proxy.terminalHelpers.getDropdownOptions(state, !!t._filterToggle.value));
            t._activeDropdown.value = state.activeId;
        },
        refreshButtons() {
            const state = webui.proxy.terminalHelpers.getState();
            const current = state.terminals[state.activeId];
            const isRunning = current && current.status === 'Running';
            if (this._btnKill) this._btnKill.disabled = !isRunning;
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
            const t = this;
            if (!t._activeConsole) return;
            if (t._activeConsole.firstChild && t._activeConsole.firstChild.textContent === 'No terminal output.') {
                t._activeConsole.innerHTML = '';
            }
            const line = webui.create('div');
            line.textContent = text;
            if (isError) line.style.color = 'var(--color-danger, #ff4d4d)';
            t._activeConsole.appendChild(line);
            t._activeConsole.scrollTop = this._activeConsole.scrollHeight;
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
