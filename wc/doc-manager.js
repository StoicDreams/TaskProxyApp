
"use strict"
{
    webui.define("app-doc-manager", {
        linkCss: true,
        preload: 'select input-message content',
        constructor() {
            const t = this;
            t._fileSelector = t.template.querySelector('webui-select[label="File"]');
            t._content = t.template.querySelector('webui-content');
            t._message = t.template.querySelector('webui-input-message');
            t._btnReset = t.template.querySelector('webui-button[label="Reset"]');
            t._btnSave = t.template.querySelector('webui-button[label="Save"]');
        },
        attr: [],
        flags: [],
        attrChanged: (property, value) => {
            switch (property) {
            }
        },
        async loadFiles() {
            let t = this;
            await whenProxyReady();
            webui.proxy.projects.runWhenLoaded(() => {
                t._files = webui.projectData.docs || [];
                let options = [];
                t._files.forEach(fileName => {
                    let item = {
                        id: fileName,
                        value: fileName,
                        display: fileName
                    };
                    if (['readme.md', 'docs/readme.md'].indexOf(fileName.toLowerCase()) !== -1) {
                        options.unshift(item);
                    } else {
                        options.push(item);
                    }
                });
                t._fileSelector.setOptions(options);
                if (options.length > 0) {
                    t.loadFile(t._fileSelector.value);
                }
            });
        },
        async loadFile(file) {
            let t = this;
            t._loadedFile = null;
            t._loadingFile = file;
            t._message.value = '';
            // What Save said was about the file shown before.
            clearActionNote(t._btnSave);
            if (!file) return;
            await whenProxyReady();
            // A save of this file still writing could be read back before it lands, showing the old text.
            if (t._saving && t._savingFile === file) await t._saving.catch(() => { });
            if (t._loadingFile !== file) return;
            let fileContent = await webui.proxy.getProjectFile(file);
            await customElements.whenDefined('webui-content');
            // Another file was selected while this one loaded.
            if (t._loadingFile !== file) return;
            if (fileContent !== undefined) {
                t._loadedFile = file;
                t._content.setHtml(sanitizeProjectHtml(webui.parseMarkdown(fileContent)));
                t._message.value = fileContent;
            } else {
                t._content.setHtml('Failed to load content');
            }
        },
        connected() {
            const t = this;
            t._fileSelector.addEventListener('change', ev => {
                let file = t._fileSelector.value;
                t.loadFile(file);
            });
            t._message.addEventListener('input', ev => {
                t._content.setHtml(sanitizeProjectHtml(webui.parseMarkdown(t._message.value)));
            });
            t._btnReset.addEventListener('click', async ev => {
                let file = t._fileSelector.value;
                if (!file || t._saving) return;
                t.loadFile(file);
            });
            t._btnSave.addEventListener('click', async ev => {
                let file = t._fileSelector.value;
                if (!file || t._saving) return;
                // Until a file has loaded, the editor is empty and saving would erase it.
                if (t._loadedFile !== file) {
                    actionNote(t._btnSave, 'This file has not loaded, so it was not saved.', 'warning');
                    return;
                }
                clearActionNote(t._btnSave);
                // A save that finishes after another file was picked says nothing under that file, and a failed one
                // says so in the app's alerts, since what is shown is no longer the file it is about.
                const stillShown = () => t._loadingFile === file;
                // Saving again, or resetting, before it finishes could write or show the file out of order.
                // Loading a file waits for this, so switching away and back never reads it before the write lands.
                t._btnSave.setAttribute('disabled', '');
                t._btnReset.setAttribute('disabled', '');
                const saving = (async () => {
                    let msg = await webui.proxy.saveProjectFile(file, t._message.value, err => {
                        if (stillShown()) actionNote(t._btnSave, err, 'danger');
                        else appAlert(`${file} wasn't saved: ${err}`, 'danger');
                    });
                    if (msg && stillShown()) actionNote(t._btnSave, msg, 'success');
                })();
                t._saving = saving;
                t._savingFile = file;
                try {
                    await saving;
                } finally {
                    if (t._saving === saving) { t._saving = null; t._savingFile = null; }
                    t._btnSave.removeAttribute('disabled');
                    t._btnReset.removeAttribute('disabled');
                }
            });
            t.loadFiles();
        },
        disconnected() { },
        shadowTemplate: `
<style type="text/css">
:host {
display:flex;
flex-direction:column;
gap:var(--padding);
}
slot {
display:none;
}
</style>
<webui-grid columns="1fr max-content max-content">
<webui-select label="File"></webui-select>
<webui-button theme="warning" label="Reset"></webui-button>
<webui-button theme="success" label="Save"></webui-button>
</webui-grid>
<webui-grid columns="1fr 1fr">
<webui-content></webui-content>
<webui-input-message aria-label="Markdown"></webui-input-message>
</webui-grid>
`
    });
}
