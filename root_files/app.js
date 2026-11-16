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
    const terminalStates = new Map();
    /** This screen, so it can ignore its own changes when Rust sends them to every screen. */
    const screenId = crypto.randomUUID();
    /** What Rust last had of app and project data, so a sync sends only what changed since. */
    const syncedCopy = { app: null, project: null };
    const isAppKey = key => key.startsWith('app-') || key.startsWith('session-') || ['page-path', 'page-title', 'page-subtitle'].includes(key);
    /**
     * App state each screen keeps for itself, such as the page it shows and how its panels are set. Rust keeps and
     * saves them like the rest, but a screen ignores another screen's.
     */
    const screenKeys = ['page-path', 'page-title', 'page-subtitle', 'app-nav-routes', 'app-terminals-filter', 'app-terminal-refresh', 'app-terminal-cleared', 'app-home-state'];
    const isScreenKey = key => screenKeys.includes(key) || key.startsWith('session-');
    const copyOf = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    /** What changed from `before` to `after`: values set and removed in their `data`, and other fields given whole. */
    function patchFrom(before, after, skipFields = []) {
        const set = {}, remove = [], fields = {};
        const was = before?.data || {}, now = after?.data || {};
        Object.entries(now).forEach(([key, value]) => { if (value !== undefined && !same(value, was[key])) set[key] = copyOf(value); });
        Object.keys(was).forEach(key => { if (now[key] === undefined) remove.push(key); });
        Object.entries(after || {}).forEach(([key, value]) => {
            if (key !== 'data' && !skipFields.includes(key) && !same(value, before?.[key])) fields[key] = copyOf(value);
        });
        return Object.keys(set).length || remove.length || Object.keys(fields).length ? { set, remove, fields } : null;
    }
    function applyPatch(target, patch) {
        target.data ??= {};
        (patch.remove || []).forEach(key => delete target.data[key]);
        Object.entries(patch.set || {}).forEach(([key, value]) => { target.data[key] = copyOf(value); });
        Object.entries(patch.fields || {}).forEach(([key, value]) => {
            if (!['data', 'id', 'path'].includes(key)) target[key] = copyOf(value);
        });
    }
    /**
     * Sends what changed in app data or the open project's since the last sync, which Rust passes to every other
     * screen. What was sent counts as synced at once, so changes made meanwhile go in the next patch.
     */
    function sendPatch(scope, data, errHandler) {
        const isProject = scope === 'project';
        const base = isProject ? (syncedCopy.project?.id === data.id ? syncedCopy.project : null) : syncedCopy.app;
        const patch = patchFrom(base, data, isProject ? ['id', 'path'] : []);
        if (!patch) return Promise.resolve(isProject ? 'Project data synced' : 'App Data Synced');
        const sent = copyOf(data);
        syncedCopy[scope] = sent;
        const sending = isProject
            ? tauri.core.invoke('patch_project_data', { id: data.id, patch, screen: screenId })
            : tauri.core.invoke('patch_app_data', { patch, screen: screenId });
        return sending
            .then(() => isProject ? 'Project data synced' : 'App Data Synced')
            .catch(err => {
                // Sent again with the next sync.
                if (syncedCopy[scope] === sent) syncedCopy[scope] = base;
                return errHandler(err);
            });
    }
    /** Applies a change another screen made, which Rust sent to every screen. */
    function applyDataChange(change) {
        if (!change || change.screen === screenId) return;
        if (change.scope === 'app') {
            if (!webui.taskProxyData) return;
            if (syncedCopy.app) applyPatch(syncedCopy.app, change);
            const shared = {
                set: Object.fromEntries(Object.entries(change.set || {}).filter(([key]) => !isScreenKey(key))),
                remove: (change.remove || []).filter(key => !isScreenKey(key)),
                fields: change.fields,
            };
            applyPatch(webui.taskProxyData, shared);
            // App state shows through webui data, as it does when the app starts.
            Object.entries(shared.set).forEach(([key, value]) => {
                if (isAppKey(key) && !ignoreAppDataFields.includes(key)) webui.setData(key, copyOf(value));
            });
            shared.remove.forEach(key => { if (isAppKey(key)) webui.setData(key, undefined); });
        } else if (change.scope === 'project') {
            if (!webui.projectData?.id || webui.projectData.id !== change.id) return;
            applyPatch(webui.projectData, change);
            if (syncedCopy.project?.id === change.id) applyPatch(syncedCopy.project, change);
            if (change.fields?.navigation) webui.setData('app-nav-routes', webui.projectData.navigation);
        }
        document.dispatchEvent(new CustomEvent('app-data-changed', { detail: change }));
    }
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
    // The result of the CI runs, such as GitHub Actions, for the commit a repo last pushed.
    const ciMarkers = {
        running: { icon: 'spinner', theme: 'info', title: 'is running for the last push' },
        success: { icon: 'check', theme: 'success', title: 'passed for the last push' },
        failure: { icon: 'xmark', theme: 'danger', title: 'failed for the last push' },
    };
    function ciStatusHtml(ci) {
        const marker = ciMarkers[ci?.state];
        if (!marker) return '';
        const title = webui.escapeHtml(`${ci.service || 'CI'} ${marker.title}`);
        return `<span class="git-ci git-ci-${ci.state}" title="${title}" style="display:inline-flex;align-items:center;color:var(--color-${marker.theme});"><webui-icon icon="${marker.icon}" theme="${marker.theme}" aria-hidden="true"></webui-icon></span>`;
    }
    /** Each entry's git status, from `status`, with its CI result, from `ci`, added as `ci`. */
    function withCiStatus(status, ci) {
        const combined = { ...(status || {}) };
        Object.entries(ci || {}).forEach(([key, value]) => combined[key] = { ...combined[key], ci: value });
        return combined;
    }
    /**
     * A project or repo name for an html-options dropdown, with icons for its CI result, changed files, and commits
     * behind and ahead of the remote. Each count is a badge on its icon. The name is shown as text.
     */
    function gitStatusHtml(name, status) {
        // The list widens to fit a name and its counts on one line. In a narrow picker a long name wraps, and the
        // counts move below it when there is no room beside it.
        const label = `<span class="git-name" style="flex:1 1 auto;min-width:0;overflow-wrap:anywhere;text-align:start;">${webui.escapeHtml(`${name}`)}</span>`;
        const shown = gitStatusMarkers
            .filter(marker => status?.[marker.key] > 0)
            .map(marker => {
                const count = status[marker.key];
                // The number shows as a badge over the icon's top right, which takes less room than beside it.
                return `<span class="git-${marker.key}" title="${marker.title(count)}" style="display:inline-flex;align-items:center;color:var(--color-${marker.theme});"><webui-icon icon="${marker.icon}" theme="${marker.theme}" count="${count}" aria-hidden="true"></webui-icon></span>`;
            });
        const ci = ciStatusHtml(status?.ci);
        if (ci) shown.unshift(ci);
        if (shown.length === 0) return label;
        const markers = `<span class="git-status" style="display:inline-flex;align-items:center;gap:0;margin-left:auto;flex-shrink:0;">${shown.join('')}</span>`;
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
            /**
             * Makes a commit, which Rust runs: its Run Before Commit script, the commit, then a sync when asked. `args`
             * are { project, repo, message, files, excluded, ignored, syncAfter, script: { path, content }, queue }.
             */
            commitEnqueue: (args, errHandler) => tauri.core.invoke('commit_enqueue', args).catch(errHandler ?? defaultErrHandler),
            commitJobs: () => tauri.core.invoke('commit_jobs', {}),
            commitCancel: (id) => tauri.core.invoke('commit_cancel', { id }),
            onCommitJobs: (callback) => tauri.event.listen('commit-jobs-changed', callback),
            getChanges: (path, err, project) => invokeGit('get_git_changes', project ? { path, project } : { path }, err),
            getChangeStats: (repo, err) => invokeGit('get_git_change_stats', { repo }, err),
            getFileDiff: (repo, file, err) => invokeGit('get_git_file_diff', { repo, file }, err),
            getRepos: (err) => invokeGit('get_git_repos', {}, err),
            /** Changed files and commits ahead and behind, by repo, for the open project. */
            getRepoStatus: (err) => invokeGit('get_git_repo_status', {}, err),
            statusHtml: gitStatusHtml,
            withCiStatus,
            /** Changed files and commits ahead and behind, by project path, for every saved project. */
            getProjectStatus: (err) => {
                // The open project's repo choice is sent along, since a new choice may not have been synced yet.
                let currentRepo = webui.projectData?.path ? webui.getProjectData('selectedGitRepo') : undefined;
                if (currentRepo && typeof currentRepo === 'object') currentRepo = currentRepo.value;
                return invokeGit('get_project_git_status', typeof currentRepo === 'string' ? { currentRepo } : {}, err);
            },
            // Runs in the background, so it never asks for a token or reports a failure.
            fetchProjectRemotes: () => tauri.core.invoke('fetch_project_remotes').catch(() => undefined),
            /**
             * The CI result, such as GitHub Actions, for the commit each project's repo last pushed, by project path.
             * It asks Git servers over the network, so it runs in the background and never asks for a token.
             */
            getProjectCiStatus: () => {
                let currentRepo = webui.projectData?.path ? webui.getProjectData('selectedGitRepo') : undefined;
                if (currentRepo && typeof currentRepo === 'object') currentRepo = currentRepo.value;
                return tauri.core.invoke('get_project_ci_status', typeof currentRepo === 'string' ? { currentRepo } : {}).catch(() => undefined);
            },
            /** The CI result for the commit each repo in the open project last pushed, by repo. */
            getRepoCiStatus: () => tauri.core.invoke('get_git_repo_ci_status').catch(() => undefined),
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
        /**
         * Installed WebAssembly plugins, such as Jira. Plugins describe their screens as data, which app-plugin-page
         * draws, so no plugin code runs in this window. A plugin only reaches what its plugin.json declares.
         */
        plugins = {
            list: (err) => tauri.core.invoke('plugin_list').catch(err ?? defaultErrHandler),
            /** The plugins Stoic Dreams publishes. Quiet on failure, since the catalog is optional to the page. */
            catalog: (err) => tauri.core.invoke('plugin_catalog').catch(err ?? (() => undefined)),
            /** Installs or updates a catalog plugin, after the backend checks its signatures. */
            installCatalog: (id, err) => tauri.core.invoke('plugin_install_catalog', { id }).catch(err ?? defaultErrHandler),
            /** Asks the user for a folder holding plugin.json and plugin.wasm, as a plugin's build writes them. */
            pickFolder: () => tauri.dialog.open({ directory: true, multiple: false, title: 'Choose a plugin folder' }).catch(() => undefined),
            /** The manifest in a plugin folder, read without installing, so its permissions can be shown first. */
            inspectFolder: (folder, err) => tauri.core.invoke('plugin_inspect_folder', { folder }).catch(err ?? defaultErrHandler),
            installFolder: (folder, err) => tauri.core.invoke('plugin_install_folder', { folder }).catch(err ?? defaultErrHandler),
            remove: (id, err) => tauri.core.invoke('plugin_remove', { id }).then(() => true).catch(err ?? defaultErrHandler),
            setEnabled: (id, enabled, err) => tauri.core.invoke('plugin_set_enabled', { id, enabled }).then(() => true).catch(err ?? defaultErrHandler),
            /** The plugin's declared variables, for its settings form. Secret values are never sent here. */
            settings: (id, err) => tauri.core.invoke('plugin_settings', { id }).catch(err ?? defaultErrHandler),
            /** Saves settings. A key left out keeps its value, and an empty value removes it. */
            saveSettings: (id, values, err) => tauri.core.invoke('plugin_save_settings', { id, values }).then(() => true).catch(err ?? defaultErrHandler),
            /** Has the open project use one of the plugin's sign-ins, or none with null. */
            useSignIn: (id, signIn, err) => tauri.core.invoke('plugin_use_sign_in', { id, signIn }).then(() => true).catch(err ?? defaultErrHandler),
            /** Turns a plugin with no settings on or off for the open project. */
            useInProject: (id, used, err) => tauri.core.invoke('plugin_use_in_project', { id, used }).then(() => true).catch(err ?? defaultErrHandler),
            render: (id, page, params, err) => tauri.core.invoke('plugin_render', { id, page, params }).catch(err ?? defaultErrHandler),
            /** request is { page, pageParams, action, params, form }. */
            action: (id, request, err) => tauri.core.invoke('plugin_action', { id, request }).catch(err ?? defaultErrHandler),
            /** A card from each plugin that has something to say about the selected repo's branch. */
            branchInfo: () => tauri.core.invoke('plugin_branch_info').catch(() => undefined),
            hostAction: (id, action, err) => tauri.core.invoke('plugin_host_action', { id, action }).catch(err ?? defaultErrHandler),
            /** Each plugin's notifications, as [{ id, name, items }] or [{ id, name, error }]. */
            notifications: () => tauri.core.invoke('plugin_notifications').catch(() => undefined),
            notificationRead: (id, notification, err) => tauri.core.invoke('plugin_notification_read', { id, notification }).then(() => true).catch(err ?? defaultErrHandler),
            /** Shows plugins' notifications in the Alerts panel, and keeps them current. */
            get alerts() { return pluginAlerts; },
            /** Rebuilds the Plugins part of the nav from the enabled plugins' pages. */
            refreshNav: refreshPluginNav,
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
        /**
         * The MyFi account Task Proxy is signed in to, approved in the user's browser on StoicDreams.com. The session
         * stays in the backend and the OS keychain, so the window only ever sees the account's id and name.
         */
        myfi = {
            /** { id, displayName, offline }, or null when signed out. offline means it is the saved account. */
            account: () => tauri.core.invoke('myfi_account').catch(() => null),
            /** Opens the approval page in the browser, and resolves with { code, url }: the code it should show. */
            signInStart: (err) => tauri.core.invoke('myfi_sign_in_start').catch(err ?? defaultErrHandler),
            /** Resolves with the account once approved, or null when cancelled. Rejects with why the sign-in ended. */
            signInWait: () => tauri.core.invoke('myfi_sign_in_wait'),
            signInCancel: () => tauri.core.invoke('myfi_sign_in_cancel').catch(() => { }),
            signOut: (err) => tauri.core.invoke('myfi_sign_out').then(() => true).catch(err ?? defaultErrHandler),
        }
        /** The Task Manager: the user's own processes, read only while it is open. */
        taskManager = {
            /** Lists processes, with the ports each listens on when `ports` is set, which takes longer to read. */
            list: (ports, errHandler) => tauri.core.invoke('list_processes', { ports: !!ports }).catch(errHandler ?? defaultErrHandler),
            /**
             * Asks a process to stop, or with `force` ends it at once, and with `children` everything it started.
             * `started` names the run, so a process that ended and whose pid was reused is never stopped.
             */
            stop: (pid, started, children, force) => tauri.core.invoke('stop_process', { pid, started, children: !!children, force: !!force }),
            /** Lets go of the process list while the Task Manager is closed. */
            close: () => tauri.core.invoke('close_task_manager', {}).catch(() => { }),
        }
        terminal = {
            /**
             * Starts a run in Rust, which keeps its state, output, and the queue. `project` is the path of a saved
             * project to run in, when it is not the open one, as for a queued commit.
             */
            run: (args) => tauri.core.invoke('run_script', args),
            runs: () => tauri.core.invoke('get_runs', {}),
            /** Output after batch `since` of run `run`, or everything kept, for a screen catching up. */
            output: (id, projectId, run, since) => tauri.core.invoke('get_run_output', { terminalId: id, projectId, run, since }),
            // projectId names the project a script runs in, when it is not the open one, as in All Running.
            stop: (id, projectId) => tauri.core.invoke('stop_run', projectId ? { terminalId: id, projectId } : { terminalId: id }),
            killAll: () => tauri.core.invoke('kill_all_scripts', {}),
            clear: (id, projectId) => tauri.core.invoke('clear_run_output', projectId ? { terminalId: id, projectId } : { terminalId: id }),
            remove: (id, projectId) => tauri.core.invoke('remove_run', projectId ? { terminalId: id, projectId } : { terminalId: id }),
            removeFinishedPageScripts: () => tauri.core.invoke('remove_finished_page_scripts', {}),
            /** Typed input, including control keys such as Ctrl+C, for a script running in a terminal. */
            write: (id, data, projectId) => tauri.core.invoke('write_terminal_input', projectId ? { terminalId: id, data, projectId } : { terminalId: id, data }),
            resize: (id, cols, rows, projectId) => tauri.core.invoke('resize_terminal', projectId ? { terminalId: id, cols, rows, projectId } : { terminalId: id, cols, rows }),
            onData: (callback) => tauri.event.listen('terminal-data', callback),
            onRunChanged: (callback) => tauri.event.listen('run-changed', callback),
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
        /** A file's size in bytes, for the file preview. */
        getProjectFileSize(filePath, errHandler) {
            errHandler ??= defaultErrHandler;
            let cleanPath = (filePath || '').replace(/\\/g, '/');
            return tauri.core.invoke('get_project_file_size', { filePath: cleanPath }).catch(errHandler);
        }
        /**
         * An address the window can load a project file from, for previews. The backend streams it, so a video
         * loads a piece at a time instead of being sent whole (see services/file_server.rs).
         */
        async projectFileUrl(filePath, errHandler) {
            errHandler ??= defaultErrHandler;
            cache.fileServerBase ??= await tauri.core.invoke('get_file_server_base').catch(err => { errHandler(err); return undefined; });
            if (!cache.fileServerBase) return undefined;
            return `${cache.fileServerBase}/${encodeURIComponent((filePath || '').replace(/\\/g, '/'))}`;
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
            syncedCopy.app = copyOf(webui.taskProxyData);
            return tauri.core.invoke('save_app_data', { data: webui.taskProxyData }).catch(errHandler);
        }
        /** Update the backend's copy, and every other screen's, without writing to disk, for changes that happen often. */
        syncAppData(errHandler) {
            errHandler ??= defaultErrHandler;
            if (!webui.taskProxyData) return;
            return sendPatch('app', webui.taskProxyData, errHandler);
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
            syncedCopy.project = copyOf(webui.projectData);
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
            // Rust read these, so it has them already.
            if (syncedCopy.project?.id === projectId) {
                syncedCopy.project.navigation = copyOf(reloaded.navigation);
                syncedCopy.project.variables = copyOf(reloaded.variables);
            }
            webui.setData('app-nav-routes', reloaded.navigation);
        }
        /** A page script filled with its values, masked, for showing. `pageValues` are those typed or set on the page. */
        pageScriptPreview(script, pageValues, errHandler) {
            errHandler ??= defaultErrHandler;
            return tauri.core.invoke('page_script_preview', { script, pageValues: pageValues || {} }).catch(errHandler);
        }
        /** Runs a page script in the open project, filled with its values by Rust. Resolves to its run. */
        runPageScript(terminalId, script, pageValues, errHandler) {
            errHandler ??= defaultErrHandler;
            return tauri.core.invoke('run_page_script', { terminalId, script, pageValues: pageValues || {} }).catch(errHandler);
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
                        const nowTrusted = [...trusted, path];
                        webui.setData('app-trusted-projects', nowTrusted);
                        // Rust checks trust before it runs a page script, so it must have this first.
                        webui.taskProxyData.data['app-trusted-projects'] = nowTrusted;
                        resolve(Promise.resolve(webui.proxy.syncAppData()).then(() => true, () => true));
                        return true;
                    },
                    oncancel: () => resolve(false)
                });
            });
        }
        /** Update the backend's copy of the open project, and every other screen's, without writing to disk. */
        syncProjectData(errHandler) {
            errHandler ??= defaultErrHandler;
            if (!webui.projectData || !webui.projectData.id) {
                return;
            }
            return sendPatch('project', webui.projectData, errHandler);
        }
        terminalHelpers = {
            _listenersAttached: false,
            /** What runAndWait waits for, by run number. */
            _waits: new Map(),
            /**
             * A copy of the runs Rust keeps for a project (`services/runs.rs`), which the `run-changed` and
             * `terminal-data` events keep current. Which terminal is shown is this screen's own. Kept out of webui
             * data because every setData clones and compares its value, which grows with the amount of output.
             */
            getState(projectId) {
                const id = projectId ?? webui.projectData?.id ?? '';
                if (!terminalStates.has(id)) {
                    terminalStates.set(id, {
                        activeId: 'live',
                        allScripts: [],
                        terminals: {
                            'live': this.newTerminal('live', { name: 'Live Command' })
                        }
                    });
                }
                return terminalStates.get(id);
            },
            /** Output is kept as the text the script wrote, colors and cursor movement included. */
            newTerminal(id, fields) {
                return { id: id, name: id, status: 'Ready', script: '', output: [], outputSize: 0, interactive: false, isLive: id === 'live', run: 0, rev: 0, seq: 0, cleared: 0, ...fields };
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
            /** Brings this screen's copy of a run up to date. An update older than the copy is ignored. */
            applyRun(info) {
                if (!info?.id) return null;
                const state = this.getState(info.projectId);
                let term = state.terminals[info.id];
                if (term && term.rev > info.rev) return term;
                term ??= state.terminals[info.id] = this.newTerminal(info.id);
                const newRun = term.run !== info.run;
                const cleared = term.cleared !== info.cleared;
                Object.assign(term, {
                    name: info.name, status: info.status, exitCode: info.exitCode ?? null, stopped: !!info.stopped,
                    startedAt: info.startedAt, endedAt: info.endedAt ?? null, isPageScript: !!info.isPageScript,
                    isLive: !!info.isLive, script: info.script ?? '', args: info.args || [], interactive: !!info.interactive,
                    projectId: info.projectId, projectName: info.projectName, run: info.run, rev: info.rev, cleared: info.cleared,
                });
                if (newRun) term.seq = 0;
                if (newRun || cleared) this._clearCopy(term, info.projectId);
                if (!term.isPageScript && !term.isLive && !state.allScripts.includes(term.id)) state.allScripts.push(term.id);
                if (term.status === 'Finished') {
                    const resolve = this._waits.get(term.run);
                    this._waits.delete(term.run);
                    resolve?.(term.stopped ? null : term.exitCode);
                }
                webui.setData('app-terminal-refresh', Date.now());
                return term;
            },
            _clearCopy(term, projectId) {
                term.output = [];
                term.outputSize = 0;
                webui.setData('app-terminal-cleared', { terminalId: term.id, projectId: this.otherProject(projectId), tick: Date.now() });
            },
            _removeCopy(projectId, terminalId) {
                const state = this.getState(projectId);
                const term = state.terminals[terminalId];
                if (!term || term.isLive || term.status === 'Running') return;
                delete state.terminals[terminalId];
                if (state.activeId === terminalId) state.activeId = 'live';
                webui.setData('app-terminal-refresh', Date.now());
            },
            /**
             * Fetches the output this screen is missing, such as after it reloads, or when a batch was missed.
             * Batches that arrive meanwhile are covered by fetching again.
             */
            async catchUp(term, projectId) {
                if (term._catchingUp) {
                    term._catchUpAgain = true;
                    return;
                }
                term._catchingUp = true;
                try {
                    do {
                        term._catchUpAgain = false;
                        const run = term.run;
                        const missing = await webui.proxy.terminal.output(term.id, projectId, run, term.seq || null).catch(() => null);
                        if (!missing || missing.run !== term.run || run !== term.run) continue;
                        if (missing.reset) {
                            term.output = [];
                            term.outputSize = 0;
                            if (missing.data) this.appendOutput(term, missing.data);
                            term.seq = missing.seq;
                            webui.setData('app-terminal-cleared', { terminalId: term.id, projectId: this.otherProject(projectId), tick: Date.now() });
                        } else if (missing.seq > term.seq) {
                            if (missing.data) this.appendOutput(term, missing.data);
                            term.seq = missing.seq;
                            if (missing.data) document.dispatchEvent(new CustomEvent('term-data', { detail: { projectId, terminalId: term.id, data: missing.data } }));
                        }
                    } while (term._catchUpAgain);
                } finally {
                    term._catchingUp = false;
                }
            },
            /** Asks Rust to stop a run: Ctrl+C for a script in a terminal, forced after a few seconds if it keeps running. */
            async stopScript(id, projectId) {
                const term = this.getState(projectId).terminals[id];
                if (!term || term.status !== 'Running') return;
                await webui.proxy.terminal.stop(id, this.otherProject(projectId)).catch(err => webui.alert(err));
            },
            /**
             * Runs a script in a terminal of the open project, resolving with Started, or Queued when `useQueue` has it
             * wait for what is running. `displayScript` is what the Terminal Manager shows. Page scripts pass a copy
             * with injected values masked, since what runs can contain secrets.
             */
            async runScript(id, scriptContent, args, inSeparateWindow, useQueue, isPageScript, displayScript) {
                return (await this._start(id, scriptContent, args, inSeparateWindow, useQueue, isPageScript, displayScript)).result;
            },
            /** `project`, as `{ id, path, name }`, runs it in another saved project, kept with that project's terminals. */
            async _start(id, scriptContent, args, inSeparateWindow, queue, isPageScript, displayScript, project) {
                this.ensureListeners();
                const other = project && this.otherProject(project.id) ? project : null;
                const started = await webui.proxy.terminal.run({
                    terminalId: id, scriptContent, args: args || [], inSeparateWindow: !!inSeparateWindow,
                    cols: this.viewSize?.cols ?? null, rows: this.viewSize?.rows ?? null,
                    ...(other ? { project: other.path } : {}),
                    queue: !!queue, isPageScript: !!isPageScript, ...(displayScript !== undefined ? { displayScript } : {}),
                });
                if (started?.run) this.applyRun(started.run);
                return started || { result: 'Started', run: null };
            },
            /**
             * Runs a script now and resolves with its exit code once it ends, or null when it was stopped.
             * Throws when it cannot start, such as when the same terminal is already running a script.
             */
            async runAndWait(id, scriptContent, displayScript, project) {
                const started = await this._start(id, scriptContent, [], false, false, false, displayScript, project);
                const info = started.run;
                if (!info) return null;
                const term = this.getState(info.projectId).terminals[info.id];
                if (term?.run === info.run && term.status === 'Finished') return term.stopped ? null : term.exitCode;
                return new Promise(resolve => this._waits.set(info.run, resolve));
            },
            /**
             * How a terminal's last run went: `state` is Running, Finished, or Failed, and `elapsed` is how long it ran,
             * or has run so far, in milliseconds. Null when it has not run. A run fails when it was stopped or exited
             * with an error code. One whose exit code is unknown, such as in its own window, counts as finished.
             */
            runStatus(term, now = Date.now()) {
                if (!term?.startedAt) return null;
                const running = term.status === 'Running';
                const failed = !running && (term.stopped || (Number.isInteger(term.exitCode) && term.exitCode !== 0));
                return {
                    state: running ? 'Running' : failed ? 'Failed' : 'Finished',
                    elapsed: Math.max(0, (running ? now : term.endedAt ?? now) - term.startedAt),
                };
            },
            /** A duration in milliseconds as hours, minutes, seconds, and milliseconds, as in 00:23:45.473. */
            formatElapsed(ms) {
                ms = Math.max(0, Math.floor(ms || 0));
                const pad = (value, size = 2) => `${value}`.padStart(size, '0');
                const hours = Math.floor(ms / 3600000);
                return `${pad(hours)}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
            },
            /** Forget a terminal and its output, on every screen. Running scripts and the live terminal are kept. */
            removeTerminal(id, projectId) {
                let state = this.getState(projectId);
                const term = state.terminals[id];
                if (!term || term.isLive || term.status === 'Running') return false;
                delete state.terminals[id];
                if (state.activeId === id) state.activeId = 'live';
                if (term.run) webui.proxy.terminal.remove(id, this.otherProject(projectId)).catch(() => { });
                return true;
            },
            /** Forget every page script that is not running, on every screen. Returns how many were removed. */
            removeFinishedPageScripts() {
                let state = this.getState();
                const ids = Object.values(state.terminals)
                    .filter(term => term.isPageScript && !term.isLive && term.status !== 'Running')
                    .map(term => term.id);
                ids.forEach(id => {
                    delete state.terminals[id];
                    if (state.activeId === id) state.activeId = 'live';
                });
                if (ids.length) webui.proxy.terminal.removeFinishedPageScripts().catch(() => { });
                return ids.length;
            },
            /** Listens for run updates and output, and loads the runs Rust already has, such as after a reload. */
            ensureListeners() {
                if (this._listenersAttached || !webui.proxy?.terminal) return;
                this._listenersAttached = true;
                webui.proxy.terminal.onRunChanged((event) => {
                    const { projectId, terminalId, run } = event.payload || {};
                    if (run) this.applyRun(run);
                    else this._removeCopy(projectId, terminalId);
                });
                webui.proxy.terminal.onData((event) => {
                    const data = event.payload;
                    const term = this.getState(data.projectId).terminals[data.terminalId];
                    if (!term || typeof data.data !== 'string' || data.run !== term.run || data.seq <= term.seq) return;
                    // A batch is missing, so fetch everything after the last one this screen has.
                    if (data.seq !== term.seq + 1 || term._catchingUp) return this.catchUp(term, data.projectId);
                    term.seq = data.seq;
                    this.appendOutput(term, data.data);
                    document.dispatchEvent(new CustomEvent('term-data', { detail: data }));
                });
                Promise.resolve(webui.proxy.terminal.runs()).then(runs => {
                    (runs || []).forEach(info => {
                        const term = this.applyRun(info);
                        if (term && term.run === info.run && !term.seq) this.catchUp(term, info.projectId);
                    });
                }).catch(() => { });
            },
            /**
             * The Terminal Manager's views, for its switch: the live terminal, saved scripts, this project's page
             * scripts, what is running in this project, what is running in every project, and what has finished in
             * every project.
             */
            filters: ['Live', 'Saved', 'Page', 'Running', 'All Running', 'Finished'],
            /** The views that list running scripts, and that a run opens the Terminal Manager on. */
            runningFilters: ['Running', 'All Running'],
            /** The project id to send with a terminal command, which is only needed for a project that is not open. */
            otherProject(projectId) {
                return projectId && projectId !== (webui.projectData?.id ?? '') ? projectId : undefined;
            },
            /** A dropdown value for a terminal: its id, or for another project's terminal, `<project id>::<id>`. */
            terminalValue(id, projectId) {
                return this.otherProject(projectId) ? `${projectId}::${id}` : id;
            },
            /** A dropdown value as `{ id, projectId }`, where projectId is undefined for the open project. */
            parseTerminalValue(value) {
                const at = `${value ?? ''}`.indexOf('::');
                if (at === -1) return { id: value, projectId: undefined };
                return { id: value.substring(at + 2), projectId: value.substring(0, at) };
            },
            /**
             * The Terminal Manager's script list for one of its `filters`. Live has none, since it is the live terminal.
             * In the running views, `watching`, as `{ id, projectId }`, stays listed after it finishes, so a script being
             * watched does not vanish from the list the moment it ends.
             */
            async getDropdownOptions(state, filter, watching) {
                const options = [];
                const add = (id, display, projectId) => {
                    const value = this.terminalValue(id, projectId);
                    if (!options.some(option => option.value === value)) options.push({ id: value, value, display });
                };
                const nameOf = (term, projectId) => {
                    const name = term.id === 'live' ? 'Live Command' : term.name;
                    return this.otherProject(projectId) ? `${term.projectName || 'Another project'}: ${name}` : name;
                };
                const isWatched = (term, projectId) => watching?.id === term.id
                    && (this.otherProject(watching.projectId) ?? '') === (this.otherProject(projectId) ?? '');
                const listed = (term, projectId) => term.status === 'Running' || isWatched(term, projectId);
                if (filter === 'Saved') {
                    state.allScripts = await webui.proxy.getScripts() || [];
                    state.allScripts.forEach(path => {
                        if (path.indexOf('taskproxy_tmp_') !== -1) return;
                        add(path, `${path} (${state.terminals[path]?.status ?? 'Ready'})`);
                    });
                } else if (filter === 'Page') {
                    Object.values(state.terminals).forEach(term => {
                        if (term.isPageScript) add(term.id, `${term.name} (${term.status})`);
                    });
                } else if (filter === 'Running') {
                    Object.values(state.terminals).forEach(term => {
                        if (listed(term)) add(term.id, `${nameOf(term)} (${term.status})`);
                    });
                } else if (filter === 'All Running') {
                    for (const [projectId, projectState] of terminalStates) {
                        Object.values(projectState.terminals).forEach(term => {
                            if (listed(term, projectId)) add(term.id, `${nameOf(term, projectId)} (${term.status})`, projectId);
                        });
                    }
                } else if (filter === 'Finished') {
                    // Every run that has ended, in every project, the latest first, saying whether it failed.
                    const ended = [];
                    for (const [projectId, projectState] of terminalStates) {
                        Object.values(projectState.terminals).forEach(term => {
                            const run = this.runStatus(term);
                            if (run && (run.state !== 'Running' || isWatched(term, projectId))) ended.push({ term, projectId, run });
                        });
                    }
                    ended.sort((a, b) => (b.term.endedAt ?? Infinity) - (a.term.endedAt ?? Infinity));
                    ended.forEach(({ term, projectId, run }) => add(term.id, `${nameOf(term, projectId)} (${run.state})`, projectId));
                }
                return options;
            },
            /** Empties a terminal's output, on every screen. */
            clearOutput(id, projectId) {
                let state = this.getState(projectId);
                const term = state.terminals[id];
                if (!term) return;
                this._clearCopy(term, projectId);
                if (term.run) webui.proxy.terminal.clear(id, this.otherProject(projectId)).catch(() => { });
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
        // Rust keeps the runs, so a window that reloads still shows what is running and what it wrote.
        webui.proxy.terminalHelpers.ensureListeners();
        // A failure has already been shown. Carrying on with blank data could overwrite what was saved.
        let data = await webui.proxy.getAppData();
        if (!data) return;
        let version = await webui.proxy.getVersion();
        if (version) data.data['app-version'] = `v${version}`;
        webui.taskProxyData = data;
        syncedCopy.app = copyOf(data);
        tauri.event.listen('data-changed', event => applyDataChange(event.payload));
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
        refreshPluginNav();
        pluginAlerts.start();
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
        refreshPluginNav();
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
            syncedCopy.project = projectData ? copyOf(projectData) : null;
            if (webui.projectData && webui.projectData.path) {
                webui.projectData.path = webui.projectData.path.replace(/\\/g, '/');
            }
            webui.proxy.projects.setLoaded(!!webui.projectData.id);
            // Plugins' settings belong to projects, so their pages and notifications change with the project.
            refreshPluginNav();
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
    /**
     * A nav folder for each enabled plugin that the open project is set up for, with its pages. A project is set up
     * for a plugin by giving it settings, such as a sign-in, or, for a plugin with none, by turning it on there, so
     * no project's nav shows plugins it does not use. Setting one up is done in the Plugins drawer.
     */
    function pluginNav(plugins) {
        const escape = text => webui.escapeForHTML(`${text ?? ''}`);
        return (plugins || [])
            .filter(plugin => plugin.enabled && plugin.manifest)
            .map(plugin => {
                const manifest = plugin.manifest;
                const pages = (manifest.pages || []).filter(page => !page.hidden);
                const route = { name: escape(manifest.name), icon: manifest.icon || 'puzzle-piece', children: [] };
                if (plugin.configured === true) {
                    route.children = pages.map(page => ({
                        name: escape(page.name),
                        icon: page.icon || manifest.icon || 'puzzle-piece',
                        url: `/plugin/${manifest.id}/${page.id}`
                    }));
                }
                return route;
            })
            .filter(route => route.children.length);
    }
    async function refreshPluginNav() {
        const plugins = await webui.proxy.plugins.list(() => undefined);
        webui.setData('session-plugin-nav', pluginNav(plugins));
        // A plugin turned on, off, or set up changes which notifications there are.
        pluginAlerts.refresh();
        return plugins;
    }
    /**
     * Plugins' notifications, in the Alerts panel the bell opens. They are asked for every two minutes. New ones
     * pop up, except those found when the app starts, which only join the list. One the plugin stops listing, as
     * when it was read in Jira, is removed, and closing one tells the plugin to mark it read.
     */
    const pluginAlerts = {
        /** Each shown notification's alert, by `<plugin id>:<notification id>`. */
        shown: new Map(),
        timer: null,
        started: false,
        refreshing: null,
        intervalMs: 2 * 60 * 1000,
        start() {
            if (this.timer) return;
            this.timer = setInterval(() => this.refresh(), this.intervalMs);
            this.refresh();
        },
        refresh() {
            // One refresh at a time, so a notification is never shown twice.
            if (this.refreshing) return this.refreshing;
            this.refreshing = this._refresh().finally(() => { this.refreshing = null; });
            return this.refreshing;
        },
        async _refresh() {
            if (!webui.proxy?.plugins) return;
            const lists = await webui.proxy.plugins.notifications();
            if (!Array.isArray(lists)) return;
            // The Alerts panel loads with the page, which can be after the first check when the app starts.
            for (let tries = 0; typeof webui.addAlert !== 'function' && tries < 100; tries++) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            const popup = this.started;
            this.started = true;
            const listed = new Set(lists.map(list => list.id));
            for (const list of lists) {
                // A plugin that failed keeps what it showed, rather than clearing it until it works again.
                if (list.error || !Array.isArray(list.items)) {
                    if (list.error) console.warn(`${list.name} notifications`, list.error);
                    continue;
                }
                const current = new Set();
                for (const item of list.items) {
                    if (!item?.id) continue;
                    const key = `${list.id}:${item.id}`;
                    current.add(key);
                    if (this.shown.has(key)) continue;
                    const theme = ['info', 'success', 'warning', 'danger'].includes(item.theme) ? item.theme : 'info';
                    const alert = await webui.addAlert?.(notificationNode(list, item), theme, { popup });
                    // Web UI alerts from before webui.addAlert cannot say when one is closed, so none are shown.
                    if (!alert?.addEventListener) continue;
                    this.shown.set(key, alert);
                    alert.addEventListener('close', () => {
                        if (this.shown.get(key) !== alert) return;
                        this.shown.delete(key);
                        webui.proxy.plugins.notificationRead(list.id, item.id);
                    });
                }
                this.dismiss(key => key.startsWith(`${list.id}:`) && !current.has(key));
            }
            // A plugin turned off, or removed.
            this.dismiss(key => !listed.has(key.slice(0, key.indexOf(':'))));
        },
        dismiss(gone) {
            for (const [key, alert] of [...this.shown]) {
                if (!gone(key)) continue;
                this.shown.delete(key);
                // Another notification may share this alert, when both read the same.
                if (![...this.shown.values()].includes(alert)) alert.dismiss?.();
            }
        },
    };
    /** A notification as an alert's content: its title, when, and text, with its issues as links to their pages. */
    function notificationNode(list, item) {
        const box = document.createElement('div');
        box.className = 'plugin-notification';
        box.dataset.plugin = list.id;
        const head = document.createElement('div');
        const title = document.createElement('strong');
        appendLinked(title, `${item.title ?? ''}`, list.id, item.links);
        head.appendChild(title);
        const meta = document.createElement('small');
        meta.className = 'plugin-muted';
        meta.textContent = [list.name, item.time].filter(Boolean).join(' · ');
        box.append(head, meta);
        if (item.text) {
            const text = document.createElement('div');
            appendLinked(text, `${item.text}`, list.id, item.links);
            box.appendChild(text);
        }
        return box;
    }
    /** Adds text, with each place a link's text appears as a link to that plugin page. */
    function appendLinked(parent, text, pluginId, links) {
        const usable = (Array.isArray(links) ? links : []).filter(link => link?.text && link.page);
        let rest = text;
        while (rest) {
            let found = null;
            for (const link of usable) {
                const at = rest.indexOf(link.text);
                if (at !== -1 && (!found || at < found.at)) found = { at, link };
            }
            if (!found) {
                parent.append(rest);
                return;
            }
            if (found.at > 0) parent.append(rest.slice(0, found.at));
            const anchor = makeButton(document.createElement('a'), `Open ${found.link.text}`);
            anchor.className = 'plugin-link';
            anchor.textContent = found.link.text;
            anchor.addEventListener('click', ev => {
                ev.preventDefault();
                ev.stopPropagation();
                const query = new URLSearchParams();
                Object.entries(found.link.params || {}).forEach(([key, value]) => {
                    if (value !== undefined && value !== null && value !== '') query.set(key, typeof value === 'string' ? value : JSON.stringify(value));
                });
                const search = query.toString();
                document.querySelector('webui-drawer.shared.open')?.classList.remove('open');
                webui.navigateTo(`/plugin/${encodeURIComponent(pluginId)}/${encodeURIComponent(found.link.page)}${search ? `?${search}` : ''}`);
            });
            parent.appendChild(anchor);
            rest = rest.slice(found.at + found.link.text.length);
        }
    }
    async function syncAppData() {
        if (webui.taskProxyData) await sendPatch('app', webui.taskProxyData, msg => webui.alert(msg));
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
