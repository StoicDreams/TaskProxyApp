"use strict"
{
    webui.define("app-script-manager", {
        linkCss: true,
        preload: 'app:script-runner select',
        constructor() {
            const t = this;
            t._fileSelector = t.template.querySelector('webui-select[label="Script"]');
            t._runner = t.template.querySelector('app-script-runner');
            t._btnNew = t.template.querySelector('webui-button[label="New Script"]');
        },
        async loadScripts(selectFile) {
            let t = this;
            await whenProxyReady();
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
                    t._runner.setScript('', '');
                }
            });
        },
        async loadScript(file) {
            let t = this;
            if (!file) return;
            await webui.wait(() => !!t._runner.loadScript);
            // An unsaved draft was kept, so the list names the script still shown.
            if (!await t._runner.loadScript(file)) t._fileSelector.value = t._runner._fileName;
        },
        connected() {
            const t = this;
            t._fileSelector.addEventListener('change', ev => {
                t.loadScript(t._fileSelector.value);
            });
            t._btnNew.addEventListener('click', async () => {
                // Asked first whether to discard an unsaved draft, and kept, nothing new is started.
                if (!await t._runner.setScript('', '')) return;
                t._runner.runSaveAs();
            });
            t._runner.addEventListener('script-saved', ev => {
                t.loadScripts(ev.detail);
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
    <webui-select label="Script"></webui-select>
    <webui-button theme="primary" label="New Script"></webui-button>
</webui-flex>
<app-script-runner style="min-height: 70vh;"></app-script-runner>
`
    });
}
