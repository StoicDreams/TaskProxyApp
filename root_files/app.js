"use strict";
{
    const ignoreAppDataFields = ['app-api', 'app-name', 'app-company-singular', 'app-company-possessive', 'app-domain', 'webui-version', 'app-projects']
    runWhenWebUIReady(async () => {
        webui._appSettings.isDesktopApp = true;
        let data = await window.__TAURI__.core.invoke('get_app_data', {}).catch(msg => webui.alert(msg));
        webui.taskProxyData = data;
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
    });
    let queueId = '';
    const queueTimeout = 2000;
    function handlePagePath(pagePath) {
        let navTo = pagePath === '/root' ? '/' : pagePath;
        webui.navigateTo(navTo);
    }
    async function queueAppDataChanges(_, appData) {
        let myId = webui.uuid();
        let oldId = queueId;
        queueId = myId;
        if (oldId === '') {
            await saveAppData(appData);
            setTimeout(() => {
                if (queueId === '' || queueId !== myId) return;
                queueId = '';
            }, queueTimeout);
        } else {
            setTimeout(async () => {
                if (queueId !== '' && queueId !== myId) return;
                await saveAppData(appData);
                if (queueId === '' || queueId !== myId) return;
                queueId = '';
            }, queueTimeout);
        }
    }
    async function saveAppData(appData) {
        if (!appData) return;
        webui.taskProxyData.data = appData;
        await window.__TAURI__.core.invoke('save_app_data', { data: webui.taskProxyData }).catch(msg => webui.alert(msg));
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