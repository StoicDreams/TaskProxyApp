"use strict"
{
    webui.define("app-update-manager", {
        constructor() {
            const t = this;
            t._btnCheck = t.template.querySelector('#btn-check');
            t._btnInstall = t.template.querySelector('#btn-install');
            t._alert = t.template.querySelector('webui-alert');
        },
        connected() {
            const t = this;
            const handleError = (ex) => {
                t._alert.setValue({ text: ex, theme: 'danger' });
            };
            t._btnCheck.addEventListener('click', webui.eventSoloProcess(async _ => {
                t._alert.setValue({ text: 'Checking for updates...', theme: 'info' });
                let hasUpdate = await webui.proxy.checkUpdate(handleError);
                if (hasUpdate === true) {
                    t._alert.setValue({ text: 'An update is available. Click Install Updates to proceed.', theme: 'success' });
                    t._btnInstall.removeAttribute('disabled');
                } else if (hasUpdate === false) {
                    t._alert.setValue({ text: 'App is up to date.', theme: 'info' });
                    t._btnInstall.setAttribute('disabled', 'true');
                }
            }, handleError));
            t._btnInstall.addEventListener('click', webui.eventSoloProcess(async _ => {
                t._alert.setValue({ text: 'Downloading and installing update... Please wait.', theme: 'info' });
                let result = await webui.proxy.installUpdate(handleError);
                if (result) {
                    t._alert.setValue({ text: result, theme: 'success' });
                    t._btnInstall.setAttribute('disabled', 'true');
                }
            }, handleError));
        },
        shadowTemplate: `
<style type="text/css">
:host {
    display: flex;
    flex-direction: column;
    gap: var(--padding);
}
</style>
<webui-flex gap="var(--padding)" align="center">
    <webui-button id="btn-check" theme="primary">Check for Updates</webui-button>
    <webui-button id="btn-install" theme="success" disabled>Install Updates</webui-button>
    <webui-alert variant="info" show fixed>Current Version: <strong data-subscribe="app-version:innerHTML"></strong></webui-alert>
</webui-flex>
<webui-alert></webui-alert>
`
    });
}
