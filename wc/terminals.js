"use strict"
{
    webui.define("app-terminals", {
        linkCss: false,
        watchVisibility: false,
        isInput: false,
        preload: 'app:script-runner app:terminal-view dropdown toggle-icon input-message dialogs',
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
            // Subscribed here, since a subscriber's handler must be a method of that element.
            t.dataset.subscribe = 'app-terminal-refresh:onTerminalRefresh|app-terminal-cleared:onTerminalCleared';
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
    <webui-grid columns="1fr max-content max-content" gap="var(--padding)" align="center">
        <webui-dropdown label="Script" id="term-dropdown"></webui-dropdown>
        <webui-toggle-icon id="term-page-scripts-toggle" data-bind="app-terminals-page-scripts" data-default="app-terminals-page-scripts:true" label="Page" title="Show Activated Page Scripts" theme-on="primary"></webui-toggle-icon>
        <webui-toggle-icon id="term-filter-toggle" data-bind="app-terminals-all-scripts" label="All" title="Show All Scripts" theme-on="primary"></webui-toggle-icon>
    </webui-grid>
    <webui-flex gap="0.5rem" align="center" wrap="wrap">
        <webui-button id="btn-kill" theme="warning" label="Stop" title="Stop the script the way Ctrl+C does, and force it to end if it is still running after a few seconds"></webui-button>
        <webui-button id="btn-kill-all" theme="danger" label="Kill All" title="End every running script now"></webui-button>
        <webui-button id="btn-remove-script" theme="secondary" label="Remove" title="Remove this finished page script from the list"></webui-button>
        <webui-button id="btn-remove-finished" theme="secondary" label="Remove Finished Page Scripts"></webui-button>
        <webui-button id="btn-clear" theme="secondary" label="Clear Output" style="margin-left: auto;"></webui-button>
    </webui-flex>
    <webui-flex column>
        <label style="font-weight: bold; margin-bottom: 0.25rem;">Script Content:</label>
        <app-script-runner id="term-runner" style="height: 100%; min-height: 120px;"></app-script-runner>
    </webui-flex>
    <webui-flex column style="min-height: 40vh; flex-grow: 1;">
        <label style="font-weight: bold; margin-bottom: 0.25rem;" title="Click the terminal and type to answer a running script's prompts. Ctrl+C copies selected text, and otherwise stops the script.">Terminal:</label>
        <app-terminal-view id="term-console" style="flex-grow: 1;"></app-terminal-view>
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
                t._pageScriptsToggle = container.querySelector('#term-page-scripts-toggle');
                t._filterToggle = container.querySelector('#term-filter-toggle');
                t._runner = container.querySelector('#term-runner');
                t._activeConsole = container.querySelector('#term-console');
                t._btnKill = container.querySelector('#btn-kill');
                const btnKillAll = container.querySelector('#btn-kill-all');
                const btnClear = container.querySelector('#btn-clear');
                t._btnRemove = container.querySelector('#btn-remove-script');
                t._btnRemoveFinished = container.querySelector('#btn-remove-finished');
                t._btnRemove.addEventListener('click', () => {
                    const helpers = webui.proxy.terminalHelpers;
                    if (helpers.removeTerminal(helpers.getState().activeId)) {
                        t.switchTerminal(helpers.getState().activeId);
                    }
                });
                t._btnRemoveFinished.addEventListener('click', () => {
                    const helpers = webui.proxy.terminalHelpers;
                    if (helpers.removeFinishedPageScripts() > 0) {
                        t.switchTerminal(helpers.getState().activeId);
                    }
                });
                let initState = webui.proxy.terminalHelpers.getState();
                initState.allScripts = await webui.proxy.getScripts() || [];
                t._pageScriptsToggle.addEventListener('change', () => {
                    t.refreshDropdown();
                });
                t._filterToggle.addEventListener('change', () => {
                    t.refreshDropdown();
                });
                t._activeDropdown.addEventListener('change', () => {
                    if (t._isRefreshing) return;
                    let currentState = webui.proxy.terminalHelpers.getState();
                    if (t._activeDropdown.value && t._activeDropdown.value !== currentState.activeId) {
                        t.switchTerminal(t._activeDropdown.value);
                    }
                });
                t._btnKill.addEventListener('click', async () => {
                    let state = webui.proxy.terminalHelpers.getState();
                    await webui.proxy.terminalHelpers.stopScript(state.activeId);
                });
                btnKillAll.addEventListener('click', async () => {
                    // Clear the queue first, so finishing scripts do not start the next one.
                    webui.proxy.terminalHelpers.getState().queue = [];
                    await webui.proxy.terminal.killAll().catch(err => webui.alert(err));
                });
                btnClear.addEventListener('click', () => {
                    let state = webui.proxy.terminalHelpers.getState();
                    webui.proxy.terminalHelpers.clearOutput(state.activeId);
                    webui.setData('app-terminal-refresh', Date.now());
                });
                t.switchTerminal(initState.activeId);
            }, 0);
            return container;
        },
        async switchTerminal(id) {
            const t = this;
            await webui.wait(() => t._runner && typeof t._runner.setScript === 'function' && typeof t._activeConsole?.attach === 'function');
            let state = webui.proxy.terminalHelpers.getState();
            state.activeId = id;
            if (!state.terminals[id]) {
                let scriptContent = '';
                if (id !== 'live') {
                    scriptContent = await webui.proxy.getProjectFile(id).catch(() => '') || '';
                }
                state.terminals[id] = webui.proxy.terminalHelpers.newTerminal(id, { script: scriptContent });
            }
            const current = state.terminals[id];
            t.renderConsole();
            t.refreshDropdown();
            t.refreshButtons();
            setTimeout(() => {
                t._runner.setScript(current.id, current.script || '');
                t._runner.setReadOnly(!!current.isPageScript);
            }, 10);
        },
        async refreshDropdown() {
            const t = this;
            if (!t._activeDropdown) return;
            // A status change during a refresh must not be lost, so refresh once more afterwards.
            if (t._isRefreshing) {
                t._refreshAgain = true;
                return;
            }
            t._isRefreshing = true;
            const state = webui.proxy.terminalHelpers.getState();
            t._activeDropdown.setOptions(await webui.proxy.terminalHelpers.getDropdownOptions(state, !!t._filterToggle.value));
            await webui.wait(50);
            if (t._activeDropdown && t._activeDropdown.value !== state.activeId) {
                t._activeDropdown.value = state.activeId;
                await webui.wait(50);
            }
            t._isRefreshing = false;
            if (t._refreshAgain) {
                t._refreshAgain = false;
                t.refreshDropdown();
            }
        },
        refreshButtons() {
            const state = webui.proxy.terminalHelpers.getState();
            const current = state.terminals[state.activeId];
            const isRunning = current && current.status === 'Running';
            if (this._btnKill) this._btnKill.disabled = !isRunning;
            if (this._btnRemove) {
                this._btnRemove.style.display = current?.isPageScript ? '' : 'none';
                this._btnRemove.disabled = isRunning;
            }
            if (this._btnRemoveFinished) {
                const hasFinished = Object.values(state.terminals).some(term => term.isPageScript && term.status !== 'Running');
                this._btnRemoveFinished.style.display = hasFinished ? '' : 'none';
            }
        },
        /** Shows the active terminal. Its output is only replayed when it changes, or when `force` is set. */
        renderConsole(force) {
            if (typeof this._activeConsole?.attach !== 'function') return;
            const state = webui.proxy.terminalHelpers.getState();
            this._activeConsole.attach(state.activeId, !!force);
        },
        onTerminalRefresh() {
            this.refreshDropdown();
            this.refreshButtons();
            this.renderConsole();
        },
        onTerminalCleared(data) {
            if (!data) return;
            const state = webui.proxy.terminalHelpers.getState();
            if (state.activeId === data.terminalId) {
                this.renderConsole(true);
            }
        },
        shadowTemplate: `
<style type="text/css">
:host { display:inline-flex; cursor:pointer; padding:1px; align-items:center; justify-content:center; }
</style>
<webui-icon icon="circle_emoji-pager|theme:black|fill"></webui-icon>
`
    });
}
