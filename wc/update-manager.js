"use strict"
{
    webui.define("app-update-manager", {
        constructor() {
            const t = this;
            t._btnCheck = t.template.querySelector('#btn-check');
            t._btnInstall = t.template.querySelector('#btn-install');
            t._alert = t.template.querySelector('webui-alert:not([fixed])');
            t._auto = t.template.querySelector('input.auto-check');
        },
        connected() {
            const t = this;
            const handleError = (ex) => {
                t._alert.setValue({ text: ex, theme: 'danger' });
            };
            t._btnCheck.addEventListener('click', webui.eventSoloProcess(async _ => {
                t._alert.setValue({ text: 'Checking for updates...', theme: 'info' });
                // The newer release, null when up to date, or undefined when the check failed.
                let update = await webui.proxy.checkUpdate(handleError);
                if (update) {
                    t._alert.setValue({ text: `Version ${update.version} is available. Click Install Updates to proceed.`, theme: 'success' });
                    t._btnInstall.removeAttribute('disabled');
                } else if (update === null) {
                    t._alert.setValue({ text: 'App is up to date.', theme: 'info' });
                    t._btnInstall.setAttribute('disabled', 'true');
                }
            }, handleError));
            // The header's Updates icon checks every 6 hours while this is on.
            t.dataset.subscribe = 'app-update-auto-check:onAutoCheck';
            t._auto.addEventListener('change', () => webui.setData('app-update-auto-check', t._auto.checked));
            t._btnInstall.addEventListener('click', webui.eventSoloProcess(async _ => {
                t._alert.setValue({ text: 'Downloading and installing update... Please wait.', theme: 'info' });
                let result = await webui.proxy.installUpdate(handleError);
                if (result) {
                    t._alert.setValue({ text: result, theme: 'success' });
                    t._btnInstall.setAttribute('disabled', 'true');
                }
            }, handleError));
        },
        onAutoCheck(value) {
            this._auto.checked = value === true || value === 'true';
        },
        shadowTemplate: `
<style type="text/css">
:host {
    display: flex;
    flex-direction: column;
    gap: var(--padding);
}
/* The buttons and version wrap, so they fit the narrow side column in Settings. */
webui-flex {
    flex-wrap: wrap;
}
</style>
<webui-flex gap="var(--padding)" align="center">
    <webui-button id="btn-check" theme="primary">Check for Updates</webui-button>
    <webui-button id="btn-install" theme="success" disabled>Install Updates</webui-button>
    <webui-alert variant="info" show fixed>Current Version: <strong data-subscribe="app-version:innerHTML"></strong></webui-alert>
</webui-flex>
<label class="auto-check-row"><input type="checkbox" class="auto-check"> Check for app and plugin updates every 6 hours</label>
<webui-alert></webui-alert>
`
    });
}
