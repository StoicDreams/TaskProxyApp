"use strict";
{
    const AsyncFunction = (async () => { }).constructor;
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
            if (handler.constructor == AsyncFunction) {
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
    const invokeGit = async (command, args = {}, errHandler = defaultErrHandler) => {
        const result = await tauri.core.invoke(command, args).catch(errHandler);
        return result || undefined; // Returns undefined if result is falsy, matching your original logic
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
            commit: (repo, files, message, err) => invokeGit('git_commit', { repo, files, message }, err),
            getChanges: (path, err) => invokeGit('get_git_changes', { path }, err),
            getFileDiff: (repo, file, err) => invokeGit('get_git_file_diff', { repo, file }, err),
            getRepos: (path, err) => invokeGit('get_git_repos', { path }, err),
            getBranches: (repo, err) => invokeGit('get_git_branches', { repo }, err),
            switchBranch: (repo, branch, err) => invokeGit('git_switch_branch', { repo, branch }, err),
            createBranch: (repo, branch, baseBranch, err) => invokeGit('git_create_branch', { repo, branch, baseBranch }, err),
            deleteBranch: (repo, branch, err) => invokeGit('git_delete_branch', { repo, branch }, err),
            mergeBranch: (repo, branch, err) => invokeGit('git_merge_branch', { repo, branch }, err),
            pull: (repo, err) => invokeGit('git_pull', { repo }, err),
            push: (repo, err) => invokeGit('git_push', { repo }, err),
            sync: (repo, err) => invokeGit('git_sync', { repo }, err),
            getRemoteStatus: (repo, err) => invokeGit('get_git_remote_status', { repo }, err),
            fetch: (repo, err) => invokeGit('git_fetch', { repo }, err),
            stash: (repo, message, err) => invokeGit('git_stash', { repo, message }, err),
            stashPop: (repo, err) => invokeGit('git_stash_pop', { repo }, err),
            restoreFile: (repo, file, err) => invokeGit('git_restore_file', { repo, file }, err),
            restoreAll: (repo, err) => invokeGit('git_restore_all', { repo }, err),
        }
        projects = {
            isLoaded: false,
            runWhenLoaded: async (handler) => {
                while (!webui.proxy.projects.isLoaded) {
                    await webui.wait(10);
                }
                handler();
            }
        }
        terminal = {
            start: (id, scriptContent) => tauri.core.invoke('start_script', { terminalId: id, scriptContent }),
            kill: (id) => tauri.core.invoke('kill_script', { terminalId: id }),
            killAll: () => tauri.core.invoke('kill_all_scripts', {}),
            onOutput: (callback) => tauri.event.listen('terminal-output', callback),
            onFinished: (callback) => tauri.event.listen('terminal-finished', callback),
            getPowerShellStatus: (errHandler) => tauri.core.invoke('get_powershell_status', {}).catch(errHandler ?? defaultErrHandler),
            autoInstallPowerShell: (errHandler) => tauri.core.invoke('auto_install_powershell', {}).catch(errHandler ?? defaultErrHandler)
        }
        async addProject(name, errHandler) {
            errHandler ??= defaultErrHandler;
            let result = await tauri.core.invoke('add_project', { name: name }).catch(errHandler);
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
            return tauri.core.invoke('get_project_file', { filePath: filePath }).catch(errHandler);
        }
        saveProjectFile(filePath, contents, errHandler) {
            errHandler ??= defaultErrHandler;
            return tauri.core.invoke('save_project_file', { filePath: filePath, contents: contents }).catch(errHandler);
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
        saveProjectData(errHandler) {
            errHandler ??= defaultErrHandler;
            if (!webui.projectData || !webui.projectData.id) {
                return;
            }
            webui.setData('app-nav-routes', []);
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
        syncProjectData(errHandler) {
            errHandler ??= defaultErrHandler;
            if (!webui.projectData || !webui.projectData.id) {
                return;
            }
            return tauri.core.invoke('sync_project_data', { data: webui.projectData }).catch(errHandler);
        }
        terminalHelpers = {
            getState() {
                let state = webui.getData('app-terminal-state');
                if (!state) {
                    state = {
                        activeId: 'live',
                        consoleActiveId: 'live',
                        showAllScripts: false,
                        allScripts: [],
                        terminals: {
                            'live': { id: 'live', name: 'Live Command', status: 'Ready', script: '', output: [], isLive: true }
                        },
                        listenersAttached: false,
                        consolePanelState: { isOpen: false, isTop: false, isSticky: false }
                    };
                    webui.setData('app-terminal-state', state);
                }
                return state;
            },
            ensureListeners() {
                let state = this.getState();
                    if (state.listenersAttached || !webui.proxy?.terminal) return;

                    state.listenersAttached = true;
                    webui.setData('app-terminal-state', state);

                    webui.proxy.terminal.onOutput((event) => {
                        let currentState = this.getState();
                        const data = event.payload;
                        const term = currentState.terminals[data.terminalId];
                        if (term) {
                            term.output.push({ text: data.content, isError: data.isError });
                            webui.setData('app-terminal-state', currentState);
                            document.dispatchEvent(new CustomEvent('term-line-out', { detail: data }));
                        }
                    });

                    webui.proxy.terminal.onFinished((event) => {
                        let currentState = this.getState();
                        const data = event.payload;
                        const term = currentState.terminals[data.terminalId];
                        if (term) {
                            term.status = 'Finished';
                            webui.setData('app-terminal-refresh', Date.now());
                        }
                    });
            },
            getDropdownOptions(state, showAll) {
                let options = [];
                const liveTerm = state.terminals['live'];
                options.push({ id: 'live', value: 'live', display: `Live (${liveTerm.status})` });
                if (showAll) {
                    state.allScripts.forEach(path => {
                        const term = state.terminals[path];
                        const status = term ? term.status : 'Ready';
                        options.push({ id: path, value: path, display: `${path} (${status})` });
                    });
                } else {
                    Object.keys(state.terminals).forEach(id => {
                        if (id === 'live') return;
                        const term = state.terminals[id];
                        options.push({ id: term.id, value: term.id, display: `${term.name} (${term.status})` });
                    });
                }
                return options;
            },
            clearOutput(id) {
                let state = this.getState();
                if (state.terminals[id]) {
                    state.terminals[id].output = [];
                    webui.setData('app-terminal-state', state);
                    webui.setData('app-terminal-cleared', { terminalId: id, tick: Date.now() });
                }
            }
        }
    }
    const ignoreAppDataFields = ['app-api', 'app-name', 'app-company-singular', 'app-company-possessive', 'app-domain', 'webui-version', 'app-projects']
    runWhenWebUIReady(async () => {
        webui.isclosing = (msg) => {
            webui.dialog({ content: msg, isLoading: true });
        };
        webui._appSettings.isDesktopApp = true;
        webui.proxy = new Tauri();
        let data = await webui.proxy.getAppData();
        webui.taskProxyData = data;
        webui.projectData = {};
        Object.entries(data.data).forEach(([key, value]) => {
            if (ignoreAppDataFields.indexOf(key) !== -1) return;
            if (key === 'page-path') {
                setTimeout(() => handlePagePath(value), 100);
            } else {
                webui.setData(key, value);
            }
        });
        webui.watchAppDataChanges(queueAppDataChanges);
        let currentProject = webui.getData('app-current-project');
        if (currentProject) {
            await loadProject({
                name: currentProject.display,
                path: currentProject.value
            });
        }
        hideLoading();
    });
    let queueId = '';
    const syncQueueTimeout = 500;
    function handlePagePath(pagePath) {
        let navTo = pagePath === '/root' ? '/' : pagePath;
        if (location.pathname === pagePath) return;
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
                await loadProject({
                    name: changes.newValue.display,
                    path: changes.newValue.value
                });
                break;
        }

    }
    async function loadProject(project) {
        if (cache.currentProject === project) return;
        showLoading('Saving Project!');
        try {
            webui.proxy.saveProjectData();
            hideLoading();
            showLoading('Loading Project!');
            webui.setData('app-nav-routes', []);
            let projectData = await webui.proxy.getProjectData(project);
            webui.projectData = projectData || { navigation: [] };
            webui.proxy.projects.isLoaded = !!webui.projectData.id;
            webui.setData('app-nav-routes', webui.projectData.navigation);
            let startPage = webui.projectData.currentPage || '/';
            webui.navigateTo('/');
            setTimeout(() => {
                handlePagePath(startPage);
            }, 300);
        } catch (ex) {
            webui.alert(ex);
            handlePagePath('/');
        } finally {
            hideLoading();
        }
    }
    async function handleUpdatedAppData(appData) {
        let myId = webui.uuid();
        let oldId = queueId;
        queueId = myId;
        webui.taskProxyData.data = appData;
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
        try {
            await showLoading('Loading App!');
            action();
        } catch {
            setTimeout(() => runWhenWebUIReady(action), 10);
        } finally {
            hideLoading();
        }
    }
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
