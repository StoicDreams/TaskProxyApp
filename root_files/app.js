"use strict";
{
    const AsyncFunction = (async () => { }).constructor;
    const tauri = window.__TAURI__;
    delete window.__TAURI__;
    let firstLoad = true;
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
        getProjects(errHandler) {
            errHandler ??= defaultErrHandler;
            if (firstLoad) {
                firstLoad = false;
                return tauri.core.invoke('load_projects', {}).catch(errHandler);
            } else {
                return tauri.core.invoke('get_projects', {}).catch(errHandler);
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
        showLoading();
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
            webui.projectData = projectData || {};
            webui.setData('app-nav-routes', webui.projectData.navigation);
            handlePagePath(webui.projectData.currentPage || '/');
        } catch (ex) {
            webui.alert(ex);
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
    function runWhenWebUIReady(action) {
        try {
            showLoading();
            action();
        } catch {
            setTimeout(() => runWhenWebUIReady(action), 10);
        }
    }
}