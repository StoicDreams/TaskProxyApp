"use strict"
{
    webui.define("app-script-manager", {
        linkCss: true,
        preload: 'app:script-runner split-panes toggle-icon button',
        constructor() {
            const t = this;
            t._list = t.template.querySelector('.file-list');
            t._split = t.template.querySelector('webui-split-panes');
            t._viewToggle = t.template.querySelector('webui-toggle-icon');
            t._runner = t.template.querySelector('app-script-runner');
            t._btnNew = t.template.querySelector('webui-button[label="New Script"]');
        },
        async loadScripts(selectFile) {
            let t = this;
            await whenProxyReady();
            webui.proxy.projects.runWhenLoaded(async () => {
                t._files = await webui.proxy.getScripts() || [];
                const file = selectFile || (t._files.includes(t._shown) ? t._shown : t._files[0]);
                t.drawList(file);
                if (file) {
                    t.loadScript(file);
                } else {
                    t._runner.setScript('', '');
                }
            });
        },
        /** Lists the scripts, marking `shown` as the one in the editor. */
        drawList(shown) {
            const t = this;
            t._shown = shown;
            t._list.replaceChildren(...(t._files || []).map(file => {
                const row = webui.create('button', { type: 'button', role: 'option', class: 'file-row', 'data-file': file, title: file });
                row.textContent = file;
                row.setAttribute('aria-selected', file === shown ? 'true' : 'false');
                row.addEventListener('click', () => {
                    t.loadScript(file);
                    t._split.showPane?.('end');
                });
                return row;
            }));
            if (!t._files?.length) {
                const empty = webui.create('p', { class: 'empty' });
                empty.textContent = 'This project has no scripts yet. New Script adds one.';
                t._list.appendChild(empty);
            }
        },
        async loadScript(file) {
            let t = this;
            if (!file) return;
            t.drawList(file);
            await webui.wait(() => !!t._runner.loadScript);
            // An unsaved draft was kept, so the list marks the script still shown.
            if (!await t._runner.loadScript(file)) t.drawList(t._runner._fileName);
        },
        connected() {
            const t = this;
            rememberSplit(t._split, t._viewToggle, 'app-script-manager');
            t._btnNew.addEventListener('click', async () => {
                // Asked first whether to discard an unsaved draft, and kept, nothing new is started.
                if (!await t._runner.setScript('', '')) return;
                t._split.showPane?.('end');
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
.file-list {
    display:flex;
    flex-direction:column;
    gap:0.25em;
    padding:0.25em 0.5em 0.25em 0;
}
.file-row {
    width:100%;
    padding:0.4em 0.6em;
    border:1px solid transparent;
    border-radius:var(--corners, 4px);
    background:none;
    color:inherit;
    font:inherit;
    text-align:start;
    overflow-wrap:anywhere;
    cursor:pointer;
}
.file-row:hover {
    background-color:color-mix(in srgb, currentColor 8%, transparent);
}
.file-row[aria-selected="true"] {
    border-color:var(--color-info);
    background-color:color-mix(in srgb, var(--color-info) 15%, transparent);
}
.empty {
    margin:0.5em;
    opacity:0.8;
}
.file-view {
    padding-left:var(--padding);
}
</style>
<webui-flex align="center" gap="0.5rem">
    <webui-toggle-icon label="View" icon-on="square" icon-off="table-columns" title-on="Showing the list of scripts or the script, one at a time. Click to show them side by side." title-off="Showing the list of scripts and the script side by side. Click to show one at a time."></webui-toggle-icon>
    <webui-flex grow></webui-flex>
    <webui-button theme="primary" label="New Script"></webui-button>
</webui-flex>
<webui-split-panes fill min="220" ratio="0.25" show="end" start-label="Scripts" end-label="Script">
    <div slot="start" class="file-list" role="listbox" aria-label="Scripts"></div>
    <div slot="end" class="file-view"><app-script-runner></app-script-runner></div>
</webui-split-panes>
`
    });
}
