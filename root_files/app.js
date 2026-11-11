"use strict";
{
    const globalScope = 'global';
    const projectScope = 'project';
    // The data field holds every project value, including tokens, so it is not readable by name.
    const projectRootGetVars = ['id', 'path', 'current_page', 'docs', 'navigation', 'variables']
    const projectRootSetVars = []
    const AsyncFunction = (async () => { }).constructor;
    const patKeys = ['git_pat', 'github_pat'];
    // Output kept per terminal, by characters, so switching terminals can replay it.
    const maxTerminalOutput = 2 * 1024 * 1024;
    // How long Stop waits after sending Ctrl+C before it forces the script to end.
    const stopGraceMs = 3000;
    const terminalStates = new Map();
    const worker = new Worker("worker.min.js");
    const tauri = window.__TAURI__;
    delete window.__TAURI__;
    let firstLoad = true;
    let isLoading = {};
    const defaultErrHandler = msg => webui.alert(msg);
    const cache = {};
    let isLoadingDialog = null;
    async function showLoading(msg, during) {
        if (typeof msg === 'function') {
            during = msg;
        }
        let content = typeof msg === 'string' ? msg : 'Loading, please wait!';
        if (isLoadingDialog) {
            if (typeof during === 'function') {
                during();
            }
            return;
        }
        isLoadingDialog = webui.dialog({ isLoading: true, content });
        if (typeof during === 'function') {
            if (during.constructor == AsyncFunction) {
                await during();
            } else {
                during();
            }
            hideLoading();
        }
    }
    function hideLoading() {
        if (!isLoadingDialog) return;
        isLoadingDialog.close();
        isLoadingDialog = null;
    }
    const messages = {};
    const pendingWorkerRequests = new Map();
    async function promptForGitToken() {
        return new Promise((resolve) => {
            webui.dialog({
                title: 'Git Authentication Required',
                content: `
                    <p>Your Personal Access Token (PAT) is missing or invalid.</p>
                    <webui-flex column gap="var(--padding)">
                        <webui-input-text name="gitToken" label="Personal Access Token (PAT)"></webui-input-text>
                        <webui-toggle-icon name="isGlobal" label="Save to Global Scope (Defaults to Project)" theme-on="primary"></webui-toggle-icon>
                    </webui-flex>
                `,
                confirm: 'Save & Retry',
                cancel: 'Cancel',
                onconfirm: async (data, content) => {
                    const formData = Object.fromEntries(data);
                    const token = (formData.gitToken || '').trim();
                    const isGlobal = formData.isGlobal === true || formData.isGlobal === 'true';
                    if (!token) {
                        content.alert('Token cannot be empty.', 'danger');
                        return false;
                    }
                    if (isGlobal) {
                        webui.deleteProjectData('git_pat');
                        if (webui.projectData.variables) {
                            webui.projectData.variables = webui.projectData.variables.filter(v => v.split('|')[0] !== 'git_pat');
                        }
                        await webui.proxy.saveProjectData();

                        webui.setGlobalData('git_pat', token);
                        await webui.proxy.saveAppData();
                    } else {
                        webui.setProjectData('git_pat', token);
                        if (!webui.projectData.variables) webui.projectData.variables = [];
                        if (!webui.projectData.variables.some(v => v.split('|')[0] === 'git_pat')) {
                            webui.projectData.variables.push('git_pat|secret|');
                            webui.projectData.variables.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
                        }
                        await webui.proxy.saveProjectData();
                    }
                    resolve(true);
                    return true;
                },
                oncancel: () => resolve(false)
            });
        });
    }
    // A command for a project that is not open never asks for a token, since the prompt saves to the open project.
    const plural = (count, one, many) => count === 1 ? `1 ${one}` : `${count} ${many}`;
    // Each kind has its own color, and its number matches its icon.
    const gitStatusMarkers = [
        { key: 'changes', icon: 'code-commit', theme: 'info', title: count => plural(count, 'changed file', 'changed files') },
        { key: 'behind', icon: 'download', theme: 'danger', title: count => `${plural(count, 'commit', 'commits')} behind the remote` },
        { key: 'ahead', icon: 'upload', theme: 'success', title: count => `${plural(count, 'commit', 'commits')} ahead of the remote` },
    ];
    /**
     * A project or repo name for an html-options dropdown, with an icon and number for its changed files and its
     * commits behind and ahead of the remote. The name is shown as text.
     */
    function gitStatusHtml(name, status) {
        // The list widens to fit a name and its counts on one line. In a narrow picker a long name wraps, and the
        // counts move below it when there is no room beside it.
        const label = `<span class="git-name" style="flex:1 1 auto;min-width:0;overflow-wrap:anywhere;text-align:start;">${webui.escapeHtml(`${name}`)}</span>`;
        const shown = gitStatusMarkers
            .filter(marker => status?.[marker.key] > 0)
            .map(marker => {
                const count = status[marker.key];
                return `<span class="git-${marker.key}" title="${marker.title(count)}" style="display:inline-flex;align-items:center;gap:0.15em;color:var(--color-${marker.theme});"><webui-icon icon="${marker.icon}" theme="${marker.theme}" aria-hidden="true"></webui-icon>${count}</span>`;
            });
        if (shown.length === 0) return label;
        const markers = `<span class="git-status" style="display:inline-flex;align-items:center;gap:0.45em;margin-left:auto;flex-shrink:0;">${shown.join('')}</span>`;
        return `<span class="git-option" style="display:flex;flex-wrap:wrap;align-items:center;column-gap:1em;flex:1 1 auto;min-width:0;">${label}${markers}</span>`;
    }
    const invokeGit = async (command, args = {}, errHandler = defaultErrHandler) => {
        try {
            const result = await tauri.core.invoke(command, args);
            return result || undefined;
        } catch (err) {
            if (typeof err === 'string' && err.includes('Credentials Missing/Invalid') && !args.project) {
                const tokenSaved = await promptForGitToken();
                if (tokenSaved) {
                    return await invokeGit(command, args, errHandler);
                } else {
                    if (errHandler) errHandler("Git operation cancelled: Authentication required.");
                    return undefined;
                }
            }
            if (errHandler) {
                errHandler(err);
            }
            return undefined;
        }
    };
    class Tauri {
        openUrl = tauri.opener.openUrl;
        constructor() {
            const t = this;
            worker.onmessage = (event) => {
                if (!event.isTrusted) return;
                let data = JSON.parse(event.data);
                if (data.id && pendingWorkerRequests.has(data.id)) {
                    const { resolve, reject, timer } = pendingWorkerRequests.get(data.id);
                    clearTimeout(timer);
                    pendingWorkerRequests.delete(data.id);
                    if (data.message && data.message.ok) {
                        resolve(data.message.msg);
                    } else {
                        reject(data.message ? data.message.msg : 'Unknown error');
                    }
                }
            };
        }
        getVersion(errHandler) {
            errHandler ??= defaultErrHandler;
            return tauri.core.invoke('get_version', {}).catch(errHandler);
        }
        loading = {
            show: showLoading,
            hide: hideLoading
        }
        worker = {
            send: (toRun, data, timeout = 60000) => {
                let msg = { id: webui.uuid(), run: toRun, data: data };
                let json = JSON.stringify(msg);
                return new Promise((resolve, reject) => {
                    const timer = setTimeout(() => {
                        if (pendingWorkerRequests.has(msg.id)) {
                            pendingWorkerRequests.delete(msg.id);
                            reject('Message never returned');
                        }
                    }, timeout);
                    pendingWorkerRequests.set(msg.id, { resolve, reject, timer });
                    worker.postMessage(json);
                });
            }
        }
        git = {
            // project is the path of the project to commit in, when it is not the open one.
            commit: (repo, files, message, err, project) => invokeGit('git_commit', project ? { repo, files, message, project } : { repo, files, message }, err),
            getChanges: (path, err, project) => invokeGit('get_git_changes', project ? { path, project } : { path }, err),
            getChangeStats: (repo, err) => invokeGit('get_git_change_stats', { repo }, err),
            getFileDiff: (repo, file, err) => invokeGit('get_git_file_diff', { repo, file }, err),
            getRepos: (err) => invokeGit('get_git_repos', {}, err),
            /** Changed files and commits ahead and behind, by repo, for the open project. */
            getRepoStatus: (err) => invokeGit('get_git_repo_status', {}, err),
            statusHtml: gitStatusHtml,
            /** Changed files and commits ahead and behind, by project path, for every saved project. */
            getProjectStatus: (err) => {
                // The open project's repo choice is sent along, since a new choice may not have been synced yet.
                let currentRepo = webui.projectData?.path ? webui.getProjectData('selectedGitRepo') : undefined;
                if (currentRepo && typeof currentRepo === 'object') currentRepo = currentRepo.value;
                return invokeGit('get_project_git_status', typeof currentRepo === 'string' ? { currentRepo } : {}, err);
            },
            // Runs in the background, so it never asks for a token or reports a failure.
            fetchProjectRemotes: () => tauri.core.invoke('fetch_project_remotes').catch(() => undefined),
            getBranches: (repo, err) => invokeGit('get_git_branches', { repo }, err),
            switchBranch: (repo, branch, err) => invokeGit('git_switch_branch', { repo, branch }, err),
            createBranch: (repo, branch, baseBranch, err) => invokeGit('git_create_branch', { repo, branch, baseBranch }, err),
            deleteBranch: (repo, branch, err) => invokeGit('git_delete_branch', { repo, branch }, err),
            mergeBranch: (repo, branch, err) => invokeGit('git_merge_branch', { repo, branch }, err),
            pull: (repo, err, project) => invokeGit('git_pull', project ? { repo, project } : { repo }, err),
            pullOverwrite: (repo, err) => invokeGit('git_pull_overwrite', { repo }, err),
            push: (repo, err, project) => invokeGit('git_push', project ? { repo, project } : { repo }, err),
            sync: (repo, err, project) => invokeGit('git_sync', project ? { repo, project } : { repo }, err),
            getRemoteStatus: (repo, err) => invokeGit('get_git_remote_status', { repo }, err),
            fetch: (repo, err) => invokeGit('git_fetch', { repo }, err),
            // For automatic refreshes, which should not interrupt the user about credentials.
            fetchQuiet: (repo) => tauri.core.invoke('git_fetch', { repo }).catch(() => undefined),
            stash: (repo, message, err) => invokeGit('git_stash', { repo, message }, err),
            stashPop: (repo, err) => invokeGit('git_stash_pop', { repo }, err),
            restoreFile: (repo, file, err) => invokeGit('git_restore_file', { repo, file }, err),
            restoreAll: (repo, err) => invokeGit('git_restore_all', { repo }, err),
            deleteFile: (repo, file, err) => invokeGit('git_delete_file', { repo, file }, err),
        }
        projects = {
            isLoaded: false,
            waiting: [],
            setLoaded(isLoaded) {
                this.isLoaded = isLoaded;
                if (isLoaded) {
                    this.waiting.splice(0).forEach(handler => handler());
                }
            },
            runWhenLoaded(handler) {
                if (this.isLoaded) {
                    handler();
                } else {
                    this.waiting.push(handler);
                }
            }
        }
        terminal = {
            start: (id, scriptContent, args, inSeparateWindow, size) => tauri.core.invoke('start_script', { terminalId: id, scriptContent, args, inSeparateWindow: !!inSeparateWindow, cols: size?.cols ?? null, rows: size?.rows ?? null }),
            kill: (id) => tauri.core.invoke('kill_script', { terminalId: id }),
            killAll: () => tauri.core.invoke('kill_all_scripts', {}),
            /** Typed input, including control keys such as Ctrl+C, for a script running in a terminal. */
            write: (id, data) => tauri.core.invoke('write_terminal_input', { terminalId: id, data }),
            resize: (id, cols, rows) => tauri.core.invoke('resize_terminal', { terminalId: id, cols, rows }),
            onData: (callback) => tauri.event.listen('terminal-data', callback),
            onFinished: (callback) => tauri.event.listen('terminal-finished', callback),
            getPowerShellStatus: (errHandler) => tauri.core.invoke('get_powershell_status', {}).catch(errHandler ?? defaultErrHandler),
            autoInstallPowerShell: (errHandler) => tauri.core.invoke('auto_install_powershell', {}).catch(errHandler ?? defaultErrHandler)
        }
        async addProject(name, errHandler) {
            errHandler ??= defaultErrHandler;
            let result = await tauri.core.invoke('add_project', { name: name }).catch(errHandler);
            if (!result) return;
            let projects = await webui.proxy.getProjects().catch(errHandler) || [];
            projects.forEach(p => { if (p && p.path) p.path = p.path.replace(/\\/g, '/'); });
            webui.setData('app-projects', projects);
            return result;
        }
        async addProjectsMulti(errHandler) {
            errHandler ??= defaultErrHandler;
            let result = await tauri.core.invoke('add_projects_multi', {}).catch(errHandler);
            if (!result) return;
            let projects = await webui.proxy.getProjects().catch(errHandler) || [];
            projects.forEach(p => { if (p && p.path) p.path = p.path.replace(/\\/g, '/'); });
            webui.setData('app-projects', projects);
            return result;
        }
        checkUpdate(errHandler) {
            errHandler ??= defaultErrHandler;
            return tauri.core.invoke('check_update', {}).catch(errHandler);
        }
        installUpdate(errHandler) {
            errHandler ??= defaultErrHandler;
            return tauri.core.invoke('install_update', {}).catch(errHandler);
        }
        async renameProject(path, newName, errHandler) {
            errHandler ??= defaultErrHandler;
            let result = await tauri.core.invoke('rename_project', { path: path, newName: newName }).catch(errHandler);
            if (!result) return;
            let projects = await webui.proxy.getProjects().catch(errHandler) || [];
            webui.setData('app-projects', projects);
            return result;
        }
        async removeProject(path, errHandler) {
            errHandler ??= defaultErrHandler;
            let result = await tauri.core.invoke('remove_project', { path: path }).catch(errHandler);
            if (!result) return;
            let projects = await webui.proxy.getProjects().catch(errHandler) || [];
            webui.setData('app-projects', projects);
            return result;
        }
        deleteSecurityKey(errHandler) {
            errHandler ??= defaultErrHandler;
            return tauri.core.invoke('delete_securitykey', {}).catch(errHandler);
        }
        getAppData(errHandler) {
            errHandler ??= defaultErrHandler;
            return tauri.core.invoke('get_app_data', {}).catch(errHandler)
        }
        getProjectFile(filePath, errHandler) {
            errHandler ??= defaultErrHandler;
            let cleanPath = (filePath || '').replace(/\\/g, '/');
            return tauri.core.invoke('get_project_file', { filePath: cleanPath }).catch(errHandler);
        }
        /** A file's bytes as base64, for previewing images and other files that are not text. */
        getProjectFileBase64(filePath, errHandler) {
            errHandler ??= defaultErrHandler;
            let cleanPath = (filePath || '').replace(/\\/g, '/');
            return tauri.core.invoke('get_project_file_base64', { filePath: cleanPath }).catch(errHandler);
        }
        searchProjectFiles(filter, display, errHandler) {
            errHandler ??= defaultErrHandler;
            return tauri.core.invoke('search_project_files', { filter: filter, display: display }).catch(errHandler);
        }
        saveProjectFile(filePath, contents, errHandler) {
            errHandler ??= defaultErrHandler;
            let cleanPath = (filePath || '').replace(/\\/g, '/');
            return tauri.core.invoke('save_project_file', { filePath: cleanPath, contents: contents }).catch(errHandler);
        }
        getProjectData(project, errHandler) {
            errHandler ??= defaultErrHandler;
            return tauri.core.invoke('get_project_data', { project: project }).catch(errHandler);
        }
        async getProjects(errHandler) {
            errHandler ??= defaultErrHandler;
            const interceptKeychainError = (err) => {
                if (typeof err === 'string' && err.includes('Failed to retrieve security key')) {
                    return [];
                }
                return errHandler(err);
            };
            if (firstLoad) {
                firstLoad = false;
                isLoading.projects = true;
                let projects = await tauri.core.invoke('load_projects', {}).catch(interceptKeychainError);
                delete isLoading.projects;
                return projects;
            } else {
                let counter = 0;
                while (counter++ < 1000 && isLoading.projects) {
                    await webui.wait(10);
                }
                return await tauri.core.invoke('get_projects', {}).catch(interceptKeychainError);
            }
        }
        async getScripts(errHandler) {
            errHandler ??= defaultErrHandler;
            return tauri.core.invoke('get_scripts', {}).catch(errHandler);
        }
        hasSecurityKey(errHandler) {
            errHandler ??= defaultErrHandler;
            return tauri.core.invoke('has_securitykey', {}).catch(errHandler);
        }
        saveAppData(errHandler) {
            errHandler ??= defaultErrHandler;
            return tauri.core.invoke('save_app_data', { data: webui.taskProxyData }).catch(errHandler);
        }
        /** Update the backend's copy without writing to disk, for changes that happen often. */
        syncAppData(errHandler) {
            errHandler ??= defaultErrHandler;
            return tauri.core.invoke('sync_app_data', { data: webui.taskProxyData }).catch(errHandler);
        }
        /** Saves the open project, or data, a project that is no longer open, without making it the open one. */
        saveProjectData(errHandler, data) {
            errHandler ??= defaultErrHandler;
            if (data && data !== webui.projectData) {
                if (!data.id) return;
                return tauri.core.invoke('save_project_data', { data }).catch(errHandler);
            }
            if (!webui.projectData || !webui.projectData.id) {
                return;
            }
            webui.setData('app-nav-routes', webui.projectData.navigation);
            return tauri.core.invoke('save_project_data', { data: webui.projectData }).catch(errHandler);
        }
        initEmojiSearch(supportedEmojis, errHandler) {
            errHandler ??= defaultErrHandler;
            return tauri.core.invoke('init_emoji_search', { supportedEmojis: supportedEmojis }).catch(errHandler);
        }
        searchEmojis(query, errHandler) {
            errHandler ??= defaultErrHandler;
            return tauri.core.invoke('search_emojis', { query: query }).catch(errHandler);
        }
        setSecurityKey(secKey, errHandler) {
            errHandler ??= defaultErrHandler;
            return tauri.core.invoke('set_securitykey', { securityKey: secKey }).catch(errHandler);
        }
        closeProject(errHandler) {
            errHandler ??= defaultErrHandler;
            return tauri.core.invoke('clear_current_project', {}).catch(errHandler);
        }
        /** Pick up changes made to shared project files on disk, such as by a git pull. */
        async reloadProjectFiles(errHandler) {
            errHandler ??= defaultErrHandler;
            if (!webui.projectData || !webui.projectData.id) return;
            await this.syncProjectData(errHandler);
            const projectId = webui.projectData.id;
            const reloaded = await tauri.core.invoke('reload_project_files', {}).catch(errHandler);
            if (!reloaded || webui.projectData.id !== projectId) return;
            webui.projectData.navigation = reloaded.navigation;
            webui.projectData.variables = reloaded.variables;
            webui.setData('app-nav-routes', reloaded.navigation);
        }
        /** Page scripts come from the repository, so ask before running any from a new project. */
        confirmProjectScript(script) {
            const path = webui.projectData?.path;
            const trusted = webui.getData('app-trusted-projects') || [];
            if (!path || trusted.includes(path)) return Promise.resolve(true);
            return new Promise(resolve => {
                webui.dialog({
                    title: 'Run Script From This Project?',
                    content: `
                        <p>This script comes from the files in <strong>${webui.escapeForHTML(path)}</strong> and can do anything your user account can do. Only continue if you trust this project.</p>
                        <pre style="max-height:40vh;overflow:auto;">${webui.escapeForHTML(script)}</pre>
                    `,
                    confirm: 'Trust Project & Run',
                    cancel: 'Cancel',
                    onconfirm: () => {
                        webui.setData('app-trusted-projects', [...trusted, path]);
                        resolve(true);
                        return true;
                    },
                    oncancel: () => resolve(false)
                });
            });
        }
        syncProjectData(errHandler) {
            errHandler ??= defaultErrHandler;
            if (!webui.projectData || !webui.projectData.id) {
                return;
            }
            return tauri.core.invoke('sync_project_data', { data: webui.projectData }).catch(errHandler);
        }
        terminalHelpers = {
            _listenersAttached: false,
            /**
             * Terminal state for a project. Kept out of webui data because every setData
             * clones and compares its value, which grows with the amount of script output.
             */
            getState(projectId) {
                const id = projectId ?? webui.projectData?.id ?? '';
                if (!terminalStates.has(id)) {
                    terminalStates.set(id, {
                        activeId: 'live',
                        allScripts: [],
                        queue: [],
                        terminals: {
                            'live': this.newTerminal('live', { name: 'Live Command' })
                        }
                    });
                }
                return terminalStates.get(id);
            },
            /** Output is kept as the text the script wrote, colors and cursor movement included. */
            newTerminal(id, fields) {
                return { id: id, name: id, status: 'Ready', script: '', output: [], outputSize: 0, interactive: false, isLive: id === 'live', ...fields };
            },
            /** The size of the terminal view, so scripts start at the width they will be shown at. */
            viewSize: null,
            setViewSize(size) {
                if (size && size.cols > 0 && size.rows > 0) this.viewSize = { cols: size.cols, rows: size.rows };
            },
            appendOutput(term, data) {
                term.output.push(data);
                term.outputSize += data.length;
                if (term.outputSize <= maxTerminalOutput) return;
                while (term.output.length > 1 && term.outputSize - term.output[0].length > maxTerminalOutput) {
                    term.outputSize -= term.output.shift().length;
                }
                // Start the kept output on a new line, so a replay never begins inside a color code.
                const first = term.output[0];
                const cut = Math.max(0, first.length - (maxTerminalOutput - (term.outputSize - first.length)));
                const lineStart = first.indexOf('\n', cut);
                const trimmed = lineStart === -1 ? '' : first.substring(lineStart + 1);
                term.outputSize -= first.length - trimmed.length;
                term.output[0] = trimmed;
            },
            /**
             * Asks a running script to stop the way Ctrl+C does in a terminal, and forces it to end if it is
             * still running after a few seconds. Scripts without a terminal are ended straight away.
             */
            async stopScript(id) {
                const state = this.getState();
                const term = state.terminals[id];
                if (!term || term.status !== 'Running') return;
                const forceStop = () => webui.proxy.terminal.kill(id).catch(() => {
                    // The finished event updates the status and starts the next queued script.
                    this._scriptFinished(id);
                });
                if (!term.interactive) return forceStop();
                const sent = await webui.proxy.terminal.write(id, '\x03').then(() => true, () => false);
                if (!sent) return forceStop();
                for (let waited = 0; waited < stopGraceMs && term.status === 'Running'; waited += 100) {
                    await webui.wait(100);
                }
                if (term.status === 'Running') return forceStop();
            },
            /**
             * `displayScript` is what the Terminal Manager shows. Page scripts pass a copy with
             * injected values masked, since what runs can contain secrets.
             */
            async runScript(id, scriptContent, args, inSeparateWindow, useQueue, isPageScript, displayScript) {
                let state = this.getState();
                if (state.terminals[id] && state.terminals[id].status === 'Running') {
                    throw 'Script is already running. You can manage it in the Terminal Manager.';
                }
                if (useQueue) {
                    let isRunning = Object.values(state.terminals).some(t => t.status === 'Running');
                    if (isRunning) {
                        state.queue.push({ id, scriptContent, args, inSeparateWindow, isPageScript, displayScript });
                        return 'Queued';
                    }
                }
                return await this._executeScript(id, scriptContent, args, inSeparateWindow, isPageScript, displayScript);
            },
            async _executeScript(id, scriptContent, args, inSeparateWindow, isPageScript, displayScript) {
                let state = this.getState();
                if (!state.terminals[id]) {
                    state.terminals[id] = this.newTerminal(id, { args: args, isPageScript: !!isPageScript });
                } else {
                    state.terminals[id].isPageScript = !!isPageScript;
                }
                state.terminals[id].interactive = false;
                state.terminals[id].status = 'Running';
                state.terminals[id].script = displayScript ?? scriptContent;
                state.terminals[id].exitCode = null;
                // Settles with the exit code when this run ends. Made before starting, since a short script can end first.
                state.terminals[id].finished = new Promise(resolve => state.terminals[id]._resolveFinished = resolve);
                if (!state.allScripts.includes(id) && id !== 'live' && !isPageScript) {
                    state.allScripts.push(id);
                }
                this.clearOutput(id);
                webui.setData('app-terminal-refresh', Date.now());
                try {
                    const started = await webui.proxy.terminal.start(id, scriptContent, args, inSeparateWindow, this.viewSize);
                    state.terminals[id].interactive = !!started?.interactive;
                    webui.setData('app-terminal-refresh', Date.now());
                    if (inSeparateWindow) {
                        this._scriptFinished(id);
                    }
                    return 'Started';
                } catch (err) {
                    this._scriptFinished(id);
                    throw err;
                }
            },
            /** `code` is the exit code, or null when the script was stopped or its exit code is unknown. */
            _scriptFinished(id, projectId, code) {
                let state = this.getState(projectId);
                const term = state.terminals[id];
                if (term) {
                    term.status = 'Finished';
                    term.exitCode = Number.isInteger(code) ? code : null;
                    term._resolveFinished?.(term.exitCode);
                    term._resolveFinished = null;
                    webui.setData('app-terminal-refresh', Date.now());
                }
                this.runNextQueued();
            },
            /**
             * Runs a script now and resolves with its exit code once it ends, or null when it was stopped.
             * Throws when it cannot start, such as when the same terminal is already running a script.
             */
            async runAndWait(id, scriptContent, displayScript) {
                const state = this.getState();
                await this.runScript(id, scriptContent, [], false, false, false, displayScript);
                return state.terminals[id].finished;
            },
            /** Scripts run in the open project, so another project's queue waits until it reopens. */
            runNextQueued() {
                let state = this.getState();
                if (Object.values(state.terminals).some(t => t.status === 'Running')) return;
                let next = state.queue.shift();
                if (next) {
                    this._executeScript(next.id, next.scriptContent, next.args || [], next.inSeparateWindow, next.isPageScript, next.displayScript).catch(err => webui.alert(err, 'danger'));
                }
            },
            /** Forget a terminal and its output. Running scripts and the live terminal are kept. */
            removeTerminal(id) {
                let state = this.getState();
                const term = state.terminals[id];
                if (!term || term.isLive || term.status === 'Running') return false;
                delete state.terminals[id];
                if (state.activeId === id) state.activeId = 'live';
                return true;
            },
            /** Forget every page script that is not running. Returns how many were removed. */
            removeFinishedPageScripts() {
                let state = this.getState();
                return Object.values(state.terminals)
                    .filter(term => term.isPageScript && term.status !== 'Running')
                    .filter(term => this.removeTerminal(term.id))
                    .length;
            },
            ensureListeners() {
                if (this._listenersAttached || !webui.proxy?.terminal) return;
                this._listenersAttached = true;
                webui.proxy.terminal.onData((event) => {
                    const data = event.payload;
                    const term = this.getState(data.projectId).terminals[data.terminalId];
                    if (!term || typeof data.data !== 'string') return;
                    this.appendOutput(term, data.data);
                    document.dispatchEvent(new CustomEvent('term-data', { detail: data }));
                });
                webui.proxy.terminal.onFinished((event) => {
                    const data = event.payload;
                    this._scriptFinished(data.terminalId, data.projectId, data.code);
                });
            },
            async getDropdownOptions(state, showAll) {
                let options = [];
                const liveTerm = state.terminals['live'];
                options.push({ id: 'live', value: 'live', display: `Live (${liveTerm.status})` });
                let showPageScripts = webui.getData('app-terminals-page-scripts') === true || webui.getData('app-terminals-page-scripts') === 'true';
                if (showAll) {
                    state.allScripts = await webui.proxy.getScripts() || [];
                    state.allScripts.forEach(path => {
                        if (path.indexOf('taskproxy_tmp_') !== -1) return;
                        const term = state.terminals[path];
                        const status = term ? term.status : 'Ready';
                        options.push({ id: path, value: path, display: `${path} (${status})` });
                    });
                }
                Object.values(state.terminals).forEach(term => {
                    if (term.id === 'live') return;
                    if (term.isPageScript && !showPageScripts && state.activeId !== term.id) return;
                    if (!options.find(o => o.id === term.id)) {
                        options.push({ id: term.id, value: term.id, display: `${term.name} (${term.status})` });
                    }
                });
                return options;
            },
            clearOutput(id) {
                let state = this.getState();
                if (state.terminals[id]) {
                    state.terminals[id].output = [];
                    state.terminals[id].outputSize = 0;
                    webui.setData('app-terminal-cleared', { terminalId: id, tick: Date.now() });
                }
            }
        }
    }
    const ignoreAppDataFields = ['app-api', 'app-name', 'app-company-singular', 'app-company-possessive', 'app-domain', 'app-not-found-html', 'app-data-endpoint', 'app-content-endpoint', 'webui-version', 'app-projects', 'page-path']
    runWhenWebUIReady(async () => {
        webui.isclosing = (msg) => {
            webui.dialog({ content: msg, isLoading: true });
        };
        webui._appSettings.isDesktopApp = true;
        webui.proxy = new Tauri();
        tauri.event.listen('webui-isclosing', event => webui.isclosing(event.payload));
        // A failure has already been shown. Carrying on with blank data could overwrite what was saved.
        let data = await webui.proxy.getAppData();
        if (!data) return;
        let version = await webui.proxy.getVersion();
        if (version) data.data['app-version'] = `v${version}`;
        webui.taskProxyData = data;
        // Terminal state used to be stored here, along with all of its output.
        let keysDeleted = 'app-terminal-state' in webui.taskProxyData.data;
        delete webui.taskProxyData.data['app-terminal-state'];
        const globalVarKeys = (webui.taskProxyData.variables || []).map(v => v.split('|')[0]);
        Object.keys(webui.taskProxyData.data).forEach(key => {
            const isAppKey = key.startsWith("app-") || key.startsWith("session-") || ["page-path", "page-title", "page-subtitle", "webui-version"].includes(key);
            const isGlobalVar = globalVarKeys.includes(key);
            if (!isAppKey && !isGlobalVar) {
                delete webui.taskProxyData.data[key];
                keysDeleted = true;
            }
        });
        if (keysDeleted) {
            webui.proxy.saveAppData();
        }
        webui.projectData = { navigation: [], data: {} };
        webui.projectData.data ??= {};
        webui.projectData.navigation ??= [];
        const getData = webui.getData.bind(webui);
        const setData = webui.setData.bind(webui);
        webui.getData = function (key) {
            let ks = key.indexOf('.') !== -1 ? key.split('.') : [null, key];
            const scope = ks[0];
            key = ks[1];
            const isAppKey = key.startsWith("app-") || key.startsWith("session-") || ["page-path", "page-title", "page-subtitle"].includes(key);
            // Tokens are read with getProjectData or getGlobalData, never by page content.
            if (patKeys.includes(key)) return undefined;
            if (scope !== projectScope && scope !== globalScope && (isAppKey || getData('app-env-page-enabled'))) {
                // Check Page Data
                let value = getData(key);
                if (value !== undefined) return value;
            }
            if (scope !== globalScope && (isAppKey || getData('app-env-project-enabled'))) {
                // Check Project Data. Project fields need the scope, or they would hide variables of the same name.
                let value = scope === projectScope && projectRootGetVars.indexOf(key) !== -1 ? webui.projectData[key] : webui.projectData.data[key];
                if (value !== undefined) return value;
            }
            if (!isAppKey && !getData('app-env-global-enabled')) return undefined;
            // Return Global Data
            return webui.taskProxyData.data[key];
        }
        webui.setData = function (key, value) {
            let ks = key.indexOf('.') !== -1 ? key.split('.') : [null, key];
            const scope = ks[0];
            key = ks[1];
            if (scope === projectScope) {
                webui.setProjectData(key, value);
            } else if (scope === globalScope) {
                webui.setGlobalData(key, value);
            }
            setData(key, value);
        }
        /**
         * The value of a variable, for injecting into scripts. Unlike getData, this never falls back
         * to framework settings such as app-name, which a script's $name must not pick up.
         */
        webui.getVariable = function (key) {
            if (patKeys.includes(key)) return undefined;
            if (/^(app|session|page)-/.test(webui.toSnake(key, '-'))) return undefined;
            if (getData('app-env-page-enabled')) {
                let value = webui.getNestedData(key, window.appData);
                if (value !== undefined) return value;
            }
            if (getData('app-env-project-enabled')) {
                let value = webui.projectData.data[key];
                if (value !== undefined) return value;
            }
            return getData('app-env-global-enabled') ? webui.taskProxyData.data[key] : undefined;
        }
        webui.getProjectData = function (key) {
            if (projectRootGetVars.indexOf(key) !== -1) {
                return webui.projectData[key];
            }
            return webui.projectData.data[key];
        }
        webui.getGlobalData = function (key) {
            return webui.taskProxyData.data[key];
        }
        webui.setProjectData = function (key, value) {
            if (projectRootSetVars.indexOf(key) !== -1) {
                webui.projectData[key] = value;
                return;
            }
            webui.projectData.data[key] = value;
        }
        webui.setGlobalData = function (key, value) {
            webui.taskProxyData.data[key] = value;
            if (!webui.taskProxyData.variables) webui.taskProxyData.variables = [];
            if (!webui.taskProxyData.variables.some(v => v.split('|')[0] === key)) {
                webui.taskProxyData.variables.push(`${key}|secret|`);
                webui.taskProxyData.variables.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
            }
        }
        webui.deleteProjectData = function(key) {
            delete webui.projectData.data[key];
        }
        webui.deleteGlobalData = function(key) {
            delete webui.taskProxyData.data[key];
            if (!webui.taskProxyData.variables) webui.taskProxyData.variables = [];
            webui.taskProxyData.variables = webui.taskProxyData.variables.filter(v => v.split('|')[0] !== key);
        }
        Object.entries(data.data).forEach(([key, value]) => {
            if (ignoreAppDataFields.indexOf(key) !== -1 || patKeys.includes(key)) return;
            // Global variables are read from webui.taskProxyData. Copying them into page data would hide a
            // project value of the same name until the page changed.
            const isAppKey = key.startsWith("app-") || key.startsWith("session-") || ["page-path", "page-title", "page-subtitle"].includes(key);
            if (!isAppKey) return;
            webui.setData(key, value);
        });
        // Variables work until a scope is switched off, including on a new install.
        ['app-env-page-enabled', 'app-env-project-enabled', 'app-env-global-enabled'].forEach(key => {
            if (data.data[key] === undefined) setData(key, true);
        });
        webui.watchAppDataChanges(queueAppDataChanges);
        let currentProject = webui.getData('app-current-project');
        if (currentProject) {
            await queueProjectChange(() => loadProject({
                name: currentProject.display,
                path: currentProject.value
            }));
        }
        hideLoading();
    });
    let queueId = '';
    const syncQueueTimeout = 500;
    async function handlePagePath(pagePath, forceReload = false) {
        let navTo = pagePath === '/root' ? '/' : pagePath;
        if (forceReload) {
            webui.navigateTo('_reloading');
            await webui.wait(50);
        } else if (location.pathname === navTo) {
            return;
        }
        webui.navigateTo(navTo);
    }
    async function queueAppDataChanges(changes, appData) {
        handleChanges(changes);
        handleUpdatedAppData(appData);
    }
    async function handleChanges(changes) {
        switch (changes.property) {
            case 'page-path':
                let project = webui.getData('app-current-project');
                webui.projectData.currentPage = changes.newValue == '/root' ? '/' : changes.newValue;
                webui.proxy.syncProjectData();
                break;
            case 'app-current-project':
                if (changes.newValue && changes.newValue.value) {
                    await queueProjectChange(() => loadProject({
                        name: changes.newValue.display,
                        path: changes.newValue.value.replace(/\\/g, '/')
                    }));
                } else {
                    await queueProjectChange(closeProject);
                }
                break;
        }

    }
    /** Project changes run one at a time, so a quick switch cannot interleave with the last. */
    let projectChanges = Promise.resolve();
    function queueProjectChange(change) {
        projectChanges = projectChanges.then(change, change);
        return projectChanges;
    }
    async function closeProject() {
        await webui.proxy.saveProjectData();
        cache.currentProjectPath = null;
        webui.proxy.projects.setLoaded(false);
        webui.projectData = { id: null, path: null, currentPage: '/', navigation: [], data: {} };
        webui.setData('app-nav-routes', []);
        await webui.proxy.closeProject();
        handlePagePath('/', true);
    }
    async function loadProject(project) {
        if (project && project.path) {
            project.path = project.path.replace(/\\/g, '/');
        }
        if (cache.currentProjectPath === project.path) return;
        cache.currentProjectPath = project.path;
        showLoading('Saving Project!');
        try {
            await webui.proxy.saveProjectData();
            hideLoading();
            showLoading('Loading Project!');
            webui.setData('app-nav-routes', []);
            let projectData = await webui.proxy.getProjectData(project);
            // Selecting a project that failed to load tries again.
            if (!projectData) cache.currentProjectPath = null;
            webui.projectData = projectData || { id: null, path: null, currentPage: '/', navigation: [], data: {} };
            if (webui.projectData && webui.projectData.path) {
                webui.projectData.path = webui.projectData.path.replace(/\\/g, '/');
            }
            webui.proxy.projects.setLoaded(!!webui.projectData.id);
            webui.proxy.terminalHelpers.runNextQueued();
            webui.setData('app-nav-routes', webui.projectData.navigation);
            let startPage = webui.projectData.currentPage || '/';
            setTimeout(() => {
                handlePagePath(startPage, true);
            }, 300);
        } catch (ex) {
            cache.currentProjectPath = null;
            webui.alert(ex);
            handlePagePath('/', true);
        } finally {
            hideLoading();
        }
    }
    async function handleUpdatedAppData(appData) {
        let myId = webui.uuid();
        let oldId = queueId;
        queueId = myId;
        Object.keys(appData).forEach((key) => {
            if (
                key.startsWith("app-") ||
                key.startsWith("session-") ||
                ["page-path", "page-title", "page-subtitle"].includes(key)
            ) {
                webui.taskProxyData.data[key] = appData[key];
            }
        });
        if (oldId === '') {
            await syncAppData();
            setTimeout(() => {
                if (queueId === '' || queueId !== myId) return;
                queueId = '';
            }, syncQueueTimeout);
        } else {
            setTimeout(async () => {
                if (queueId !== '' && queueId !== myId) return;
                await syncAppData();
                if (queueId === '' || queueId !== myId) return;
                queueId = '';
            }, syncQueueTimeout);
        }
    }
    async function syncAppData() {
        await tauri.core.invoke('sync_app_data', { data: webui.taskProxyData }).catch(msg => webui.alert(msg));
    }
    async function runWhenWebUIReady(action) {
        // Only waiting for the framework retries. Repeating the action would stack up its side effects.
        if (typeof webui === 'undefined' || typeof webui.dialog !== 'function') {
            setTimeout(() => runWhenWebUIReady(action), 10);
            return;
        }
        try {
            // The loading dialog is only there to look at, so the app still starts if it cannot open.
            try {
                await showLoading('Loading App!');
            } catch (ex) {
                console.warn('The loading dialog could not open', ex);
            }
            await action();
        } catch (ex) {
            console.error('Task Proxy failed to start', ex);
            webui.alert(`Task Proxy failed to start: ${ex}`);
        } finally {
            hideLoading();
        }
    }
}

/**
 * Lets keyboard and screen reader users use an element that responds to clicks: it is announced as a button,
 * Tab reaches it, and Enter or Space clicks it. Its title, or the label given here, names it.
 */
function makeButton(el, label) {
    if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    if (label) el.setAttribute('aria-label', label);
    if (el._isButton) return el;
    el._isButton = true;
    el.addEventListener('keydown', ev => {
        if (ev.target !== el || ev.altKey || ev.ctrlKey || ev.metaKey) return;
        if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            el.click();
        }
    });
    return el;
}
/**
 * Resolves once webui.proxy exists. Unlike webui.wait, it never gives up, since the app can take longer to start
 * than webui.wait allows on a slow connection, and code that ran on without the proxy would throw.
 */
function whenProxyReady() {
    return new Promise(resolve => {
        // The loader declares webui as a global, not a window property, so typeof is the safe check before it loads.
        const check = () => typeof webui !== 'undefined' && webui.proxy ? resolve(webui.proxy) : setTimeout(check, 50);
        check();
    });
}
/**
 * Clean HTML built from project files before it reaches the DOM. Those files come from
 * repositories, and scripts running in this window could reach every app command.
 */
function sanitizeProjectHtml(dirty) {
    if (typeof dirty !== 'string') return '';
    const blockedTags = new Set(['script', 'iframe', 'object', 'embed', 'base', 'head', 'link', 'meta', 'applet', 'frame', 'frameset', 'style', 'animate', 'animatetransform', 'animatemotion', 'set']);
    const urlAttributes = new Set(['href', 'xlink:href', 'src', 'action', 'formaction', 'data', 'poster', 'background']);
    const unsafeUrl = /^(javascript|vbscript|data:text\/html)/;
    const doc = new DOMParser().parseFromString(dirty.replace(/\0/g, ''), 'text/html');
    const clean = (node) => {
        Array.from(node.childNodes).forEach(child => {
            if (child.nodeType === Node.COMMENT_NODE) {
                child.remove();
                return;
            }
            if (child.nodeType !== Node.ELEMENT_NODE) return;
            if (blockedTags.has(child.localName.toLowerCase())) {
                child.remove();
                return;
            }
            Array.from(child.attributes).forEach(attr => {
                const name = attr.name.toLowerCase();
                const value = attr.value.replace(/[\s\x00-\x1f]+/g, '').toLowerCase();
                if (name.startsWith('on') || name === 'srcdoc' || (urlAttributes.has(name) && unsafeUrl.test(value))) {
                    child.removeAttribute(attr.name);
                }
            });
            // Template content is not part of childNodes, and components stamp it out later.
            if (child.content) clean(child.content);
            clean(child);
        });
    };
    clean(doc.body);
    return doc.body.innerHTML;
}

function getDragNDropSetup(getSegments) {
    const setup = (segment, onSet) => {
        if (segment._isDNDEnabled) return;
        segment._isDNDEnabled = true;
        let canStart = false;
        let ismoving = false;
        let mouseisdown = false;
        let offsetX = 0, offsetY = 0;
        let placeholder = webui.create('div', { class: 'placeholder', theme: 'success', 'moving': true });
        let segments = [];
        function onMove(ev) {
            if (!mouseisdown) return;
            ev.preventDefault();
            ev.stopPropagation();
            if (ismoving) {
                let left = ev.clientX - offsetX;
                let top = ev.clientY - offsetY;
                segment.style.left = `${left}px`;
                segment.style.top = `${top}px`;
                let closest = null;
                let minDistance = Infinity;
                let aboveOrBelow = null;
                segments.forEach(el => {
                    if (el === segment) {
                        return;
                    }
                    const rect = el.getBoundingClientRect();
                    const centerY = rect.top + rect.height / 2;
                    const distance = Math.abs(ev.clientY - centerY);
                    if (distance < minDistance) {
                        minDistance = distance;
                        closest = el;
                        aboveOrBelow = closest.getAttribute('place') || (ev.clientY < centerY ? 'above' : 'below');
                    }
                });
                if (closest) {
                    if (aboveOrBelow === 'below') {
                        closest.after(placeholder);
                    } else {
                        closest.before(placeholder);
                    }
                }
                return;
            }
            if (canStart) {
                ismoving = true;
                canStart = false;
                document.body.classList.add('dragging');
                segment.style.width = `${segment.clientWidth}px`;
                segment.style.height = `${segment.clientHeight}px`;
                segment.classList.add('moving');
                segment.after(placeholder);
                if (document.getSelection) {
                    document.getSelection().empty();
                } else if (window.getSelection) {
                    window.getSelection().removeAllRanges();
                }
            }
        }
        function onRemove(ev) {
            mouseisdown = false;
            ismoving = false;
            canStart = false;
            placeholder.after(segment);
            if (typeof onSet === 'function') {
                onSet();
            }
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onRemove);
            segment.classList.remove('moving');
            segment.style.left = '';
            segment.style.top = '';
            segment.style.width = '';
            segment.style.height = '';
            placeholder.remove();
            document.body.classList.remove('dragging');
        }
        // Alt+Up and Alt+Down move the item one place, as a drag does, for people who do not use a mouse.
        segment.addEventListener('keydown', ev => {
            if (!ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
            const handle = webui.closest(ev, '.drag-handle');
            // Keys pressed on an item inside this one, such as a page in a folder, move that item instead.
            if (!handle || (handle !== segment && handle.getRootNode().host !== segment)) return;
            ev.preventDefault();
            ev.stopPropagation();
            const focused = ev.composedPath()[0];
            const others = getSegments(handle).filter(el => el !== segment && !segment.contains(el));
            const down = ev.key === 'ArrowDown';
            const candidates = down
                ? others.filter(el => segment.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
                : others.filter(el => segment.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING).reverse();
            const parent = segment.parentNode;
            const next = segment.nextSibling;
            // Placeholders, such as the start of a folder, say which side of them an item goes.
            for (const target of candidates) {
                const place = target.getAttribute('place') || (down ? 'below' : 'above');
                if (place === 'below') target.after(segment);
                else target.before(segment);
                if (segment.parentNode !== parent || segment.nextSibling !== next) break;
            }
            if (typeof onSet === 'function') {
                onSet();
            }
            focused?.focus?.();
        });
        segment.addEventListener('mousedown', ev => {
            if (ev.buttons !== 1 || mouseisdown) return;
            const target = webui.closest(ev, '.drag-handle');
            if (!target) return;
            ev.preventDefault();
            ev.stopPropagation();
            mouseisdown = true;
            let cs = segment.getClientRects()[0];
            offsetX = ev.clientX - cs.x;
            offsetY = ev.clientY - cs.y;
            setTimeout(() => {
                if (mouseisdown) {
                    segments = getSegments(target);
                    canStart = true;
                }
            }, 200);
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onRemove, { once: true });
        });
    };
    return setup;
}
