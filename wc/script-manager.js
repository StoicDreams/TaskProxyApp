"use strict"
{
    webui.define("app-script-manager", {
        linkCss: true,
        preload: 'app:script-runner',
        constructor() {
            const t = this;
            t._fileSelector = t.template.querySelector('webui-dropdown[label="Script"]');
            t._message = t.template.querySelector('webui-input-message');
            t._runner = t.template.querySelector('app-script-runner');
            t._btnNew = t.template.querySelector('webui-button[label="New Script"]');
        },
        async loadScripts(selectFile) {
            let t = this;
            await webui.wait(() => !!webui.proxy);
            webui.proxy.projects.runWhenLoaded(async () => {
                let scripts = await webui.proxy.getScripts();
                let options = (scripts || []).map(fileName => {
                    return { id: fileName, value: fileName, display: fileName };
                });
                t._fileSelector.setOptions(options);
                if (selectFile) {
                    t._fileSelector.value = selectFile;
                    t.loadScript(selectFile);
                } else if (options.length > 0) {
                    t.loadScript(t._fileSelector.value);
                } else {
                    t._message.value = '';
                }
            });
        },
        async loadScript(file) {
            let t = this;
            if (!file) return;
            await webui.wait(() => !!t._runner.loadScript);
            t._runner.loadScript(file);
        },
        connected() {
            const t = this;
            t._fileSelector.addEventListener('change', ev => {
                t.loadScript(t._fileSelector.value);
            });
            t.loadScripts();
        },
        disconnected() { },
        shadowTemplate: `
<style type="text/css">
:host {
    display:flex;
    flex-direction:column;
    gap:var(--padding);
}
</style>
<webui-flex align="center">
    <webui-dropdown label="Script"></webui-dropdown>
    <webui-button theme="primary" label="New Script"></webui-button>
</webui-flex>
<app-script-runner style="min-height: 70vh;"></app-script-runner>
`
    });
}
