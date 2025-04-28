"use strict";
{
    const AsyncFunction = (async () => { }).constructor;
    const tauri = window.__TAURI__;
    delete window.__TAURI__;
    let firstLoad = true;
    let isLoading = {};
    const defaultErrHandler = msg => webui.alert(msg);
    const cache = {};
    let isLoadingDialog = null;
    async function showLoading(during) {
        if (isLoadingDialog) {
            if (typeof during === 'function') {
                during();
            }
            return;
        }
        isLoadingDialog = webui.dialog({ isLoading: true });
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
    class Tauri {
        openUrl = tauri.opener.openUrl;
        constructor() {
        }
        git = {
            commit: async (repo, files, message, errHandler) => {
                errHandler ??= defaultErrHandler;
                let result = await tauri.core.invoke('git_commit', { repo: repo, files: files, message: message }).catch(errHandler);
                if (!result) return;
                return result;
            },
            getChanges: async (path, errHandler) => {
                errHandler ??= defaultErrHandler;
                let result = await tauri.core.invoke('get_git_changes', { path: path }).catch(errHandler);
                if (!result) return;
                return result;
            },
            getFileDiff: async (repo, file, errHandler) => {
                errHandler ??= defaultErrHandler;
                let result = await tauri.core.invoke('get_git_file_diff', { repo: repo, file: file }).catch(errHandler);
                if (!result) return;
                return result;
            },
            getRepos: async (path, errHandler) => {
                errHandler ??= defaultErrHandler;
                let result = await tauri.core.invoke('get_git_repos', { path: path }).catch(errHandler);
                if (!result) return;
                return result;
            },
            pull: async (repo, errHandler) => {
                errHandler ??= defaultErrHandler;
                let result = await tauri.core.invoke('git_pull', { repo: repo }).catch(errHandler);
                if (!result) return;
                return result;
            },
            push: async (repo, errHandler) => {
                errHandler ??= defaultErrHandler;
                let result = await tauri.core.invoke('git_push', { repo: repo }).catch(errHandler);
                if (!result) return;
                return result;
            },
            sync: async (repo, errHandler) => {
                errHandler ??= defaultErrHandler;
                let result = await tauri.core.invoke('git_sync', { repo: repo }).catch(errHandler);
                if (!result) return;
                return result;
            }
        }
        projects = {
            isLoaded: false,
            runWhenLoaded: async (handler) => {
                while (!webui.proxy.projects.isLoaded) {
                    console.log('waiting for project to load');
                    await webui.wait(10);
                }
                console.log('done waiting for project');
                handler();
            }
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
            if (firstLoad) {
                firstLoad = false;
                isLoading.projects = true;
                let projects = await tauri.core.invoke('load_projects', {}).catch(errHandler);
                delete isLoading.projects;
                return projects;
            } else {
                let counter = 0;
                while (counter++ < 1000 && isLoading.projects) {
                    await webui.wait(10);
                }
                return await tauri.core.invoke('get_projects', {}).catch(errHandler);
            }
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
    }
    const ignoreAppDataFields = ['app-api', 'app-name', 'app-company-singular', 'app-company-possessive', 'app-domain', 'webui-version', 'app-projects']
    runWhenWebUIReady(async () => {
        webui.isclosing = (msg) => {
            webui.dialog({ content: msg, isLoading: true });
        };
        document.querySelector('dialog.isloading').remove();
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
        showLoading();
        try {
            await webui.proxy.saveProjectData();
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
            await showLoading();
            action();
        } catch {
            setTimeout(() => runWhenWebUIReady(action), 10);
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