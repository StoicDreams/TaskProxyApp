"use strict"
{
    // The color of each run state in the Terminal label.
    const statusThemes = { Running: 'info', Finished: 'success', Failed: 'danger' };
    // How often a running script's time updates, in milliseconds. Often enough for the milliseconds to move.
    const statusTick = 50;
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
            makeButton(t);
            t.addEventListener('click', () => {
                t.openDrawer();
                return true;
            });
        },
        disconnected() { },
        /**
         * Opens the Terminal Manager. `run` is set when a script was just started, which opens it on a running view
         * unless one is already chosen, so the script shows.
         */
        openDrawer({ run = false } = {}) {
            const t = this;
            let el = document.querySelector(t.drawer);
            if (!el) {
                webui.alert('Drawer not found!');
                return;
            }
            if (run && !webui.proxy.terminalHelpers.runningFilters.includes(t.filter())) {
                t.setFilter('Running');
            }
            if (el.classList.contains('open')) {
                el.classList.remove('open');
                setTimeout(() => t.openDrawer(), 500);
                return;
            }
            el.innerHTML = '';
            const header = webui.create('div');
            header.style.padding = 'var(--padding)';
            header.setAttribute('slot', 'header');
            // A drawer's title, not a second banner for the page.
            header.setAttribute('role', 'heading');
            header.setAttribute('aria-level', '2');
            header.style.alignItems = 'center';
            header.innerHTML = `<span>Terminal Manager</span>
<webui-switch id="term-filter" style="margin-left: auto;" label="Show scripts" title="Live: the live terminal. Saved: the scripts saved in this project. Page: the scripts run from this project's pages. Running: what is running in this project. All Running: what is running in every project."></webui-switch>`;
            t._filterSwitch = header.querySelector('#term-filter');
            customElements.whenDefined('webui-switch').then(() => {
                if (typeof t._filterSwitch.setOptions !== 'function') customElements.upgrade(t._filterSwitch);
                t._filterSwitch.setOptions(webui.proxy.terminalHelpers.filters);
                t._filterSwitch.setValue(t.filter());
            });
            t._filterSwitch.addEventListener('change', () => {
                webui.setData('app-terminals-filter', t._filterSwitch.value);
                t.refreshDropdown();
            });
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
    <webui-flex gap="0.5rem" align="center" wrap="wrap">
        <webui-dropdown label="Script" id="term-dropdown" style="flex: 1 1 15em;"></webui-dropdown>
        <webui-button id="btn-kill-all" theme="danger" label="Kill All" title="End every running script now"></webui-button>
        <webui-button id="btn-remove-script" theme="secondary" label="Remove" title="Remove this finished page script from the list"></webui-button>
        <webui-button id="btn-remove-finished" theme="secondary" label="Remove Finished Page Scripts"></webui-button>
    </webui-flex>
    <!-- The script scrolls when it is long, so the terminal below always keeps its space. -->
    <webui-flex column style="flex: 0 1 auto; min-height: 120px; overflow: auto;">
        <app-script-runner id="term-runner" label="Script Content:" style="min-height: 120px;"></app-script-runner>
    </webui-flex>
    <webui-flex column style="flex: 1 0 40vh; min-height: 40vh;">
        <webui-flex gap="0.5rem" align="center" wrap="wrap" style="margin-bottom: 0.25rem;">
            <span style="font-weight: bold;" title="Click the terminal and type to answer a running script's prompts. Ctrl+C copies selected text, and otherwise stops the script.">Terminal: <span id="term-status" class="term-status"></span></span>
            <webui-flex grow></webui-flex>
            <webui-button id="btn-kill" theme="warning" label="Stop" title="Stop the script the way Ctrl+C does, and force it to end if it is still running after a few seconds"></webui-button>
            <webui-button id="btn-select-all" theme="secondary" label="Select All" title="Select all of this terminal's output and copy it to the clipboard"></webui-button>
            <webui-button id="btn-clear" theme="secondary" label="Clear Output"></webui-button>
        </webui-flex>
        <app-terminal-view id="term-console" style="flex-grow: 1;"></app-terminal-view>
    </webui-flex>
</div>
<div id="term-install-wrapper" style="display:none; flex-direction:column; gap:var(--padding); align-items:center; text-align:center; padding: 2rem;">
    <webui-icon icon="triangle_exclamation|fill" style="font-size: 3rem; margin-bottom: 1rem; color: var(--color-warning);"></webui-icon>
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
                t._runner = container.querySelector('#term-runner');
                t._activeConsole = container.querySelector('#term-console');
                t._status = container.querySelector('#term-status');
                t._btnKill = container.querySelector('#btn-kill');
                const btnKillAll = container.querySelector('#btn-kill-all');
                const btnClear = container.querySelector('#btn-clear');
                t._btnRemove = container.querySelector('#btn-remove-script');
                t._btnRemoveFinished = container.querySelector('#btn-remove-finished');
                t._btnRemove.addEventListener('click', () => {
                    const helpers = webui.proxy.terminalHelpers;
                    if (helpers.removeTerminal(t.viewState().activeId, t._viewProject)) {
                        t.switchTerminal(t.viewState().activeId, t._viewProject);
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
                t._activeDropdown.addEventListener('change', () => {
                    if (t._isRefreshing || !t._activeDropdown.value) return;
                    const helpers = webui.proxy.terminalHelpers;
                    if (t._activeDropdown.value === helpers.terminalValue(t.viewState().activeId, t._viewProject)) return;
                    const chosen = helpers.parseTerminalValue(t._activeDropdown.value);
                    t.switchTerminal(chosen.id, chosen.projectId);
                });
                t._btnKill.addEventListener('click', async () => {
                    if (t._none) return;
                    await webui.proxy.terminalHelpers.stopScript(t.viewState().activeId, t._viewProject);
                });
                btnKillAll.addEventListener('click', async () => {
                    // Clear the queue first, so finishing scripts do not start the next one.
                    webui.proxy.terminalHelpers.getState().queue = [];
                    await webui.proxy.terminal.killAll().catch(err => webui.alert(err));
                });
                container.querySelector('#btn-select-all').addEventListener('click', async () => {
                    // The terminal pads rows with spaces and keeps blank rows, so only the lines with text are copied.
                    const text = t._activeConsole.selectAll()
                        .split(/\r?\n/)
                        .map(line => line.trimEnd())
                        .filter(line => line.trim() !== '')
                        .join('\n')
                        .trim();
                    if (!text) return;
                    try {
                        await navigator.clipboard.writeText(text);
                        webui.alert('Copied the terminal output.', 'success');
                    } catch (err) {
                        webui.alert(`The terminal output could not be copied: ${err?.message ?? err}`, 'danger');
                    }
                });
                btnClear.addEventListener('click', () => {
                    if (t._none) return;
                    webui.proxy.terminalHelpers.clearOutput(t.viewState().activeId, t._viewProject);
                    webui.setData('app-terminal-refresh', Date.now());
                });
                t.switchTerminal(initState.activeId);
            }, 0);
            return container;
        },
        /** Chooses which scripts the list shows, and marks it on the switch. */
        setFilter(value) {
            webui.setData('app-terminals-filter', value);
            if (typeof this._filterSwitch?.setValue === 'function' && this._filterSwitch.value !== value) this._filterSwitch.setValue(value);
        },
        /** Which scripts the list shows: one of terminalHelpers.filters. */
        filter() {
            const value = webui.getData('app-terminals-filter');
            return webui.proxy.terminalHelpers.filters.includes(value) ? value : 'Live';
        },
        /**
         * The terminal state being shown: the open project's, or another project's when a script running there was
         * picked from All Running.
         */
        viewState() {
            const helpers = webui.proxy.terminalHelpers;
            if (!helpers.otherProject(this._viewProject)) this._viewProject = undefined;
            return helpers.getState(this._viewProject);
        },
        /**
         * Shows a terminal, in another project when `projectId` names one. With no id it shows none, for a view
         * with nothing in it.
         */
        async switchTerminal(id, projectId) {
            const t = this;
            await webui.wait(() => t._runner && typeof t._runner.setScript === 'function' && typeof t._activeConsole?.attach === 'function');
            const helpers = webui.proxy.terminalHelpers;
            t._none = !id;
            if (t._none) {
                t.renderConsole();
                t.renderStatus();
                t.refreshButtons();
                t._runner.setScript('', '');
                t._runner.setReadOnly(true);
                return;
            }
            t._viewProject = helpers.otherProject(projectId);
            const state = t.viewState();
            // The Live view only shows the live terminal, so showing a script moves to a view that lists it.
            if (id !== 'live' && t.filter() === 'Live') {
                const term = state.terminals[id];
                t.setFilter(term?.status === 'Running' ? 'Running' : term?.isPageScript ? 'Page' : 'Saved');
            }
            state.activeId = id;
            if (!state.terminals[id]) {
                let scriptContent = '';
                if (id !== 'live' && !t._viewProject) {
                    scriptContent = await webui.proxy.getProjectFile(id).catch(() => '') || '';
                }
                state.terminals[id] = helpers.newTerminal(id, { script: scriptContent });
            }
            const current = state.terminals[id];
            t.renderConsole();
            t.renderStatus();
            t.refreshDropdown();
            t.refreshButtons();
            setTimeout(() => {
                t._runner.setScript(current.id, current.script || '');
                // Another project's script is only watched here, since its files are not the open project's.
                t._runner.setReadOnly(!!current.isPageScript || !!t._viewProject);
            }, 10);
        },
        /**
         * Lists the scripts the chosen view shows. When the terminal being shown is not one of them, as after
         * changing views, the first one shows instead, and with none the list says None and is turned off. The Live
         * view has no list, since it is the live terminal.
         */
        async refreshDropdown() {
            const t = this;
            if (!t._activeDropdown) return;
            // A status change during a refresh must not be lost, so refresh once more afterwards.
            if (t._isRefreshing) {
                t._refreshAgain = true;
                return;
            }
            t._isRefreshing = true;
            const helpers = webui.proxy.terminalHelpers;
            const filter = t.filter();
            const viewing = t._none ? null : { id: t.viewState().activeId, projectId: t._viewProject };
            let next;
            if (filter === 'Live') {
                t._activeDropdown.setOptions([]);
                t.setListEnabled(false);
                if (!viewing || viewing.id !== 'live' || viewing.projectId) next = { id: 'live' };
            } else {
                // A script that finished while shown stays listed until the view changes, so it does not vanish.
                const watching = filter === t._listedFilter ? viewing : null;
                const options = await helpers.getDropdownOptions(helpers.getState(), filter, watching);
                if (!options.length) {
                    t._activeDropdown.setOptions([{ id: '', value: '', display: 'None' }]);
                    t.setListEnabled(false);
                    if (viewing) next = { id: null };
                } else {
                    t._activeDropdown.setOptions(options);
                    t.setListEnabled(true);
                    const selected = viewing && helpers.terminalValue(viewing.id, viewing.projectId);
                    if (!selected || !options.some(option => option.value === selected)) {
                        next = helpers.parseTerminalValue(options[0].value);
                    } else {
                        await webui.wait(50);
                        if (t._activeDropdown.value !== selected) t._activeDropdown.value = selected;
                    }
                }
            }
            t._listedFilter = filter;
            await webui.wait(50);
            t._isRefreshing = false;
            if (next) {
                // Switching refreshes the list again, which then selects what it switched to.
                t.switchTerminal(next.id, next.projectId);
                return;
            }
            if (t._refreshAgain) {
                t._refreshAgain = false;
                t.refreshDropdown();
            }
        },
        /** Turns the script list on or off. */
        setListEnabled(enabled) {
            this._activeDropdown.toggleAttribute('disabled', !enabled);
        },
        refreshButtons() {
            const state = this.viewState();
            const current = this._none ? null : state.terminals[state.activeId];
            const isRunning = current && current.status === 'Running';
            if (this._btnKill) this._btnKill.disabled = !isRunning;
            if (this._btnRemove) {
                this._btnRemove.style.display = current?.isPageScript ? '' : 'none';
                this._btnRemove.disabled = isRunning;
            }
            if (this._btnRemoveFinished) {
                // It removes the open project's page scripts, so it is hidden while another project's script shows.
                const hasFinished = !this._viewProject && Object.values(state.terminals).some(term => term.isPageScript && term.status !== 'Running');
                this._btnRemoveFinished.style.display = hasFinished ? '' : 'none';
            }
        },
        /** The active terminal's last run, as in Running 00:23:45.473, ticking while it runs. */
        renderStatus() {
            const t = this;
            const label = t._status;
            if (!label?.isConnected || !webui.proxy?.terminalHelpers) {
                clearInterval(t._statusTimer);
                t._statusTimer = null;
                return;
            }
            const helpers = webui.proxy.terminalHelpers;
            const state = t.viewState();
            const run = t._none ? null : helpers.runStatus(state.terminals[state.activeId]);
            const text = run ? `${run.state} ${helpers.formatElapsed(run.elapsed)}` : '';
            if (label.textContent !== text) label.textContent = text;
            label.dataset.state = run ? run.state.toLowerCase() : '';
            // Theme colors are made for backgrounds, so each is mixed with the label's text color to stay readable.
            label.style.color = run ? `color-mix(in srgb, var(--color-${statusThemes[run.state]}) 60%, currentColor)` : '';
            if (run?.state === 'Running') {
                t._statusTimer ??= setInterval(() => t.renderStatus(), statusTick);
            } else {
                clearInterval(t._statusTimer);
                t._statusTimer = null;
            }
        },
        /** Shows the active terminal. Its output is only replayed when it changes, or when `force` is set. */
        renderConsole(force) {
            if (typeof this._activeConsole?.attach !== 'function') return;
            this._activeConsole.attach(this._none ? null : this.viewState().activeId, !!force, this._viewProject);
        },
        onTerminalRefresh() {
            // Saved data can reach this before app.js has set up the proxy, when there is nothing to refresh yet.
            if (!webui.proxy?.terminalHelpers) return;
            this.refreshDropdown();
            this.refreshButtons();
            this.renderConsole();
            this.renderStatus();
        },
        onTerminalCleared(data) {
            if (!data || !webui.proxy?.terminalHelpers) return;
            const state = this.viewState();
            if (state.activeId === data.terminalId && (data.projectId ?? undefined) === (this._viewProject ?? undefined)) {
                this.renderConsole(true);
            }
        },
        shadowTemplate: `
<style type="text/css">
:host { display:inline-flex; cursor:pointer; padding:1px; align-items:center; justify-content:center; }
</style>
<webui-icon icon="circle_terminal|theme:black|fill"></webui-icon>
`
    });
}
