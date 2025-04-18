"use strict";
{
    const tauri = window.__TAURI__;
    delete window.__TAURI__;
    let firstLoad = true;
    const defaultErrHandler = msg => webui.alert(msg);
    const cache = {};
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
        setSecurityKey(secKey, errHandler) {
            errHandler ??= defaultErrHandler;
            return tauri.core.invoke('set_securitykey', { securityKey: secKey }).catch(errHandler);
        }
    }
    const ignoreAppDataFields = ['app-api', 'app-name', 'app-company-singular', 'app-company-possessive', 'app-domain', 'webui-version', 'app-projects']
    runWhenWebUIReady(async () => {
        webui._appSettings.isDesktopApp = true;
        webui.proxy = new Tauri();
        let data = await webui.proxy.getAppData();
        webui.taskProxyData = data;
        webui.projectData = {};
        Object.entries(data.data).forEach(([key, value]) => {
            if (ignoreAppDataFields.indexOf(key) !== -1) return;
            console.log('Load data', key, value);
            if (key === 'page-path') {
                setTimeout(() => handlePagePath(value), 100);
            } else {
                webui.setData(key, value);
            }
        });
        webui.watchAppDataChanges(queueAppDataChanges);
        let currentProject = webui.getData('app-current-project');
        console.log('current project', currentProject);
        if (currentProject) {
            loadProject({
                name: currentProject.display,
                path: currentProject.value
            });
        }
    });
    let queueId = '';
    const syncQueueTimeout = 500;
    function handlePagePath(pagePath) {
        let navTo = pagePath === '/root' ? '/' : pagePath;
        webui.navigateTo(navTo);
    }
    async function queueAppDataChanges(changes, appData) {
        handleChanges(changes);
        handleUpdatedAppData(appData);
    }
    async function handleChanges(changes) {
        switch (changes.property) {
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
        webui.setData('app-nav-routes', []);
        let projectData = await webui.proxy.getProjectData(project);
        webui.projectData = projectData || {};
        console.log('Loaded project data', webui.projectData);
        console.log('nav', webui.projectData.navigation);
        webui.setData('app-nav-routes', webui.projectData.navigation);
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
            webui.isEqual(1, 1);
            action();
        } catch {
            setTimeout(() => runWhenWebUIReady(action), 10);
        }
    }
}