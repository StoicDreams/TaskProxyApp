"use strict"
{
    // The color of each run state in the Terminal label.
    const statusThemes = { Running: 'info', Finished: 'success', Failed: 'danger' };
    // How often a running script's time updates, in milliseconds. Often enough for the milliseconds to move.
    const statusTick = 100;
    const hiddenStatusTick = 500;
    webui.define("app-terminals", {
        linkCss: false,
        watchVisibility: false,
        isInput: false,
        preload: 'app:script-runner app:terminal-view select toggle-icon input-message dialogs split-panes',
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
            t._tools = toolsPanelOf(t);
        },
        disconnected() { },
        /**
         * Opens the Terminal Manager, as the Terminals tab of Tools when it is one. `run` is set when a script was just
         * started, which opens it on a running view unless one is already chosen, so the script shows. `target` is
         * where Tools has it draw itself.
         */
        openDrawer({ run = false, target = null, terminalId = null, projectId } = {}) {
            const t = this;
            const tools = toolsPanelOf(t);
            if (tools && !target) {
                tools.show('terminals', { run, terminalId, projectId });
                return;
            }
            let el = target || document.querySelector(t.drawer);
            if (!el) {
                // The app's own setup is wrong, with no screen to say it on.
                appAlert('Drawer not found!');
                return;
            }
            if (run && !webui.proxy.terminalHelpers.runningFilters.includes(t.filter())) {
                t.setFilter('Running');
            }
            // A run names the terminal it started in, which is the one shown.
            if (terminalId) {
                const helpers = webui.proxy.terminalHelpers;
                const other = helpers.otherProject(projectId);
                helpers.getState(other).activeId = terminalId;
                t._viewProject = other || undefined;
            }
            // The run just started stays listed in the running views until another script is shown, since a quick
            // script can finish before the list is drawn.
            if (run) t._justRun = terminalId ? { id: terminalId, projectId: t._viewProject } : null;
            // Already shown there, as when a script runs while the Terminals tab is open, it stays as it is and only
            // moves to the run, rather than being drawn again.
            if (t._filterSwitch && el.contains(t._filterSwitch) && t._runner?.isConnected) {
                if (t._filterSwitch.value !== t.filter()) t._filterSwitch.setValue?.(t.filter());
                t.refreshDropdown();
                if (run || terminalId) t.switchTerminal(t.viewState().activeId, t._viewProject);
                return;
            }
            const header = webui.create('div');
            header.style.padding = 'var(--padding)';
            header.setAttribute('slot', 'header');
            // A drawer's title, not a second banner for the page.
            header.setAttribute('role', 'heading');
            header.setAttribute('aria-level', '2');
            header.style.alignItems = 'center';
            header.innerHTML = `<span>Terminal Manager</span>
<webui-toggle-icon id="term-single" label="View" style="margin-left: auto;" icon-on="square" icon-off="table-columns" title-on="Showing the script or the terminal, one at a time. Click to show them side by side." title-off="Showing the script and the terminal side by side. Click to show one at a time."></webui-toggle-icon>
<webui-switch id="term-filter" label="Show scripts" title="Live: the live terminal. Saved: the scripts saved in this project. Page: the scripts run from this project's pages. Running: what is running in this project. All Running: what is running in every project. Finished: the runs that have ended, in every project."></webui-switch>`;
            t._filterSwitch = header.querySelector('#term-filter');
            // One pane at a time, the script or the terminal, is the user's choice, and kept.
            t._singleToggle = header.querySelector('#term-single');
            customElements.whenDefined('webui-toggle-icon').then(() => {
                if (typeof t._singleToggle.setValue !== 'function') customElements.upgrade(t._singleToggle);
                t._singleToggle.setValue(webui.getData('app-terminal-single') === true);
            });
            t._singleToggle.addEventListener('click', () => {
                // The toggle flips itself as it is clicked, so its new value is read once it has.
                setTimeout(() => {
                    const single = t._singleToggle.value === true;
                    webui.setData('app-terminal-single', single);
                    t.applySingle();
                }, 0);
            });
            customElements.whenDefined('webui-switch').then(() => {
                if (typeof t._filterSwitch.setOptions !== 'function') customElements.upgrade(t._filterSwitch);
                t._filterSwitch.setOptions(webui.proxy.terminalHelpers.filters);
                t._filterSwitch.setValue(t.filter());
            });
            t._filterSwitch.addEventListener('change', () => {
                // A view the user picks lists what it lists, so the run that opened the panel is not kept in it.
                if (t._filterSwitch.value !== t.filter()) t._justRun = null;
                webui.setData('app-terminals-filter', t._filterSwitch.value);
                t.refreshDropdown();
            });
            showTool(el, header, t.getBodyContent());
        },
        /** Shows the script and the terminal one at a time, when the user chose that, or side by side when there is room. */
        applySingle() {
            const t = this;
            if (!t._split) return;
            t._split.toggleAttribute('single', webui.getData('app-terminal-single') === true);
        },
        getBodyContent() {
            const t = this;
            webui.proxy.terminalHelpers.ensureListeners();
            const state = webui.proxy.terminalHelpers.getState();
            // In Tools, the tab sizes it to the room below the header (tools.js), so the tab never needs to scroll.
            const container = webui.create('section', { class: 'tools-fill' });
            container.style.display = 'flex';
            container.style.flexDirection = 'column';
            container.style.gap = 'var(--padding)';
            container.style.height = 'calc(100% - var(--header-height, 60px))';
            container.style.boxSizing = 'border-box';
            container.innerHTML = `
<div id="term-content-wrapper" style="display:none; flex-direction:column; gap:var(--padding); height:100%;">
    <webui-flex gap="0.5rem" align="center" wrap="wrap">
        <webui-select label="Script" id="term-dropdown" style="flex: 1 1 15em;"></webui-select>
        <webui-button id="btn-kill-all" theme="danger" label="Kill All" title="End every running script now"></webui-button>
        <webui-button id="btn-remove-script" theme="secondary" label="Remove" title="Remove this finished page script from the list"></webui-button>
        <webui-button id="btn-remove-finished" theme="secondary" label="Remove Finished Page Scripts"></webui-button>
    </webui-flex>
    <!-- The script and the terminal side by side, each scrolling on its own, or one at a time when narrow. -->
    <webui-split-panes id="term-split" class="term-split" fill min="320" show="end" start-label="Script" end-label="Terminal">
    <webui-flex slot="start" column class="term-script-pane" style="padding-right: var(--padding);">
        <app-script-runner id="term-runner" label="Script Content:" style="min-height: 120px;"></app-script-runner>
    </webui-flex>
    <webui-flex slot="end" column class="term-output-pane" style="height: 100%; padding-left: var(--padding); box-sizing: border-box;">
        <webui-flex gap="0.5rem" align="center" wrap="wrap" style="margin-bottom: 0.25rem;">
            <span style="font-weight: bold;" title="Click the terminal and type to answer a running script's prompts. Ctrl+C copies selected text, and otherwise stops the script.">Terminal: <span id="term-status" class="term-status" style="display:inline-block; contain:layout paint; font-variant-numeric:tabular-nums;"></span></span>
            <webui-flex grow></webui-flex>
            <webui-button id="btn-kill" theme="warning" label="Stop" title="Stop the script the way Ctrl+C does, and force it to end if it is still running after a few seconds"></webui-button>
            <webui-button id="btn-select-all" theme="secondary" label="Select All" title="Select all of this terminal's output and copy it to the clipboard"></webui-button>
            <webui-button id="btn-clear" theme="secondary" label="Clear Output"></webui-button>
        </webui-flex>
        <app-terminal-view id="term-console" style="flex-grow: 1; min-height: 12em;"></app-terminal-view>
    </webui-flex>
    </webui-split-panes>
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
                                clearActionNote(btnInstallPwsh);
                                let msg = await webui.proxy.terminal.autoInstallPowerShell(err => actionNote(btnInstallPwsh, err, 'danger'));
                                webui.proxy.loading.hide();
                                if (msg) {
                                    // The Terminal Manager is drawn again in its place, so this is said in the app's alerts.
                                    appAlert(msg, 'success');
                                    t.openDrawer();
                                }
                            });
                        }
                    }
                    return;
                }
                contentWrapper.style.display = 'flex';
                // The split between the script and the terminal is remembered, as the user last left it.
                const split = container.querySelector('#term-split');
                t._split = split;
                t.applySingle();
                const ratio = Number(webui.getData('app-terminal-split'));
                if (ratio > 0 && ratio < 1) split.setAttribute('ratio', `${ratio}`);
                split.addEventListener('change', ev => {
                    if (ev.target === split && typeof ev.detail?.ratio === 'number') webui.setData('app-terminal-split', ev.detail.ratio);
                });
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
                    clearActionNote(t._btnKill);
                    await webui.proxy.terminalHelpers.stopScript(t.viewState().activeId, t._viewProject, err => actionNote(t._btnKill, err, 'danger'));
                });
                btnKillAll.addEventListener('click', async () => {
                    // Rust forgets the project's queue first, so finishing scripts do not start the next one.
                    clearActionNote(btnKillAll);
                    await webui.proxy.terminal.killAll().catch(err => actionNote(btnKillAll, err, 'danger'));
                });
                const btnSelectAll = container.querySelector('#btn-select-all');
                btnSelectAll.addEventListener('click', async () => {
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
                        actionNote(btnSelectAll, 'Copied the terminal output.', 'success');
                    } catch (err) {
                        actionNote(btnSelectAll, `The terminal output could not be copied: ${err?.message ?? err}`, 'danger');
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
            // The latest switch wins: an earlier one still waiting, or its runner update still pending, is dropped,
            // so it cannot bring back the script it was showing.
            const turn = t._switchTurn = (t._switchTurn || 0) + 1;
            clearTimeout(t._runnerUpdate);
            const helpersNow = webui.proxy.terminalHelpers;
            if (t._justRun && (t._justRun.id !== id || helpersNow.otherProject(t._justRun.projectId) !== helpersNow.otherProject(projectId))) t._justRun = null;
            await webui.wait(() => t._runner && typeof t._runner.setScript === 'function' && typeof t._activeConsole?.attach === 'function');
            if (turn !== t._switchTurn) return;
            const helpers = webui.proxy.terminalHelpers;
            // What Stop said is about the terminal shown before, so it goes when another is shown.
            const before = t._none ? null : helpers.terminalValue(t.viewState().activeId, t._viewProject);
            if (before !== (id ? helpers.terminalValue(id, projectId) : null)) clearActionNote(t._btnKill);
            t._none = !id;
            if (t._none) {
                t.renderConsole();
                t.renderStatus();
                t.refreshButtons();
                await t.showInRunner(turn, null, '', true);
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
                    // Only a saved script is a file. Any other terminal, such as a page script's, has no file to show.
                    scriptContent = await webui.proxy.getProjectFile(id, () => '') || '';
                    if (turn !== t._switchTurn) return;
                }
                state.terminals[id] ??= helpers.newTerminal(id, { script: scriptContent });
            }
            const current = state.terminals[id];
            t.renderConsole();
            t.renderStatus();
            t.refreshDropdown();
            t.refreshButtons();
            // Another project's script is only watched here, since its files are not the open project's.
            const readOnly = !!current.isPageScript || !!t._viewProject;
            t._runnerUpdate = setTimeout(() => t.showInRunner(turn, current, current.script || '', readOnly), 10);
        },
        /**
         * Puts the terminal being switched to in the script runner, which first asks whether to discard a draft that
         * isn't saved. Kept, the terminal it belongs to is shown again, and the list selects it.
         */
        async showInRunner(turn, terminal, script, readOnly) {
            const t = this;
            // Asked before the runner changes, so a newer switch, which gets the same answer, is the only one to change it.
            const keep = await t._runner.keepUnsaved(script);
            if (turn !== t._switchTurn) return;
            if (!keep) {
                await t._runner.setScript(terminal?.id ?? '', script, { discard: true });
                if (turn !== t._switchTurn) return;
                t._runner.setReadOnly(readOnly);
                t._runnerShows = { id: terminal?.id ?? null, projectId: t._viewProject, filter: t.filter() };
                return;
            }
            const kept = t._runnerShows;
            if (!kept) return;
            t._none = !kept.id;
            t._viewProject = webui.proxy.terminalHelpers.otherProject(kept.projectId) || undefined;
            if (kept.id) t.viewState().activeId = kept.id;
            if (t.filter() !== kept.filter) t.setFilter(kept.filter);
            // Listed as the one being watched, so the list keeps it, as one that finished while shown.
            t._listedFilter = kept.filter;
            t.renderConsole();
            t.renderStatus();
            t.refreshButtons();
            t.refreshDropdown();
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
                const watching = t._justRun ?? (filter === t._listedFilter ? viewing : null);
                const options = await helpers.getDropdownOptions(helpers.getState(), filter, watching);
                if (!options.length) {
                    t._activeDropdown.setOptions([{ id: '', value: '', display: 'None', icon: 'xmark' }]);
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
                // Switching to a terminal refreshes the list again, which then selects it. Switching to nothing does
                // not, so a refresh asked for meanwhile, such as by a status change, runs here rather than being lost.
                const again = t._refreshAgain;
                t._refreshAgain = false;
                await t.switchTerminal(next.id, next.projectId);
                if (!next.id && (again || t._refreshAgain)) {
                    t._refreshAgain = false;
                    t.refreshDropdown();
                }
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
                t._statusTick = 0;
                return;
            }
            const helpers = webui.proxy.terminalHelpers;
            const state = t.viewState();
            const run = t._none ? null : helpers.runStatus(state.terminals[state.activeId]);
            // While a script runs this ticks 10 times a second, so nothing is redrawn while the label can't be seen,
            // such as with the drawer closed, and only what changed is written.
            const shown = label.checkVisibility?.() !== false;
            const text = run ? `${run.state} ${helpers.formatElapsed(run.elapsed)}` : '';
            const upToDate = label.textContent === text;
            if (shown) {
                if (!upToDate) label.textContent = text;
                const stateName = run ? run.state.toLowerCase() : '';
                if ((label.dataset.state ?? '') !== stateName) label.dataset.state = stateName;
                // Theme colors are made for backgrounds, so each is mixed with the label's text color to stay readable.
                const color = run ? `color-mix(in srgb, var(--color-${statusThemes[run.state]}) 60%, currentColor)` : '';
                if (label._color !== color) {
                    label._color = color;
                    label.style.color = color;
                }
            }
            // A running script's time counts up while it shows. A hidden label is checked twice a second until it shows,
            // so a run that ended while it was hidden still says so.
            const running = run?.state === 'Running';
            const tick = running ? (shown ? statusTick : hiddenStatusTick) : (shown || upToDate ? 0 : hiddenStatusTick);
            if (t._statusTick !== tick) {
                clearInterval(t._statusTimer);
                t._statusTimer = tick ? setInterval(() => t.renderStatus(), tick) : null;
                t._statusTick = tick;
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
            // How many scripts are running, in every project.
            const running = webui.proxy.terminalHelpers.runningCount();
            this.icon.setAttribute('count', running > 0 ? running : '');
            toolsPanelOf(this)?.setCount('terminals', running);
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
<webui-icon icon="circle_terminal|theme:black|fill|backing|bordered"></webui-icon>
`
    });
}
