
"use strict"
{
    webui.define("app-doc-manager", {
        linkCss: true,
        preload: 'split-panes toggle-icon button input-message content',
        constructor() {
            const t = this;
            t._list = t.template.querySelector('.file-list');
            t._split = t.template.querySelector('webui-split-panes.files-split');
            t._viewToggle = t.template.querySelector('webui-toggle-icon.files-view');
            t._editorSplit = t.template.querySelector('webui-split-panes.editor-split');
            t._editorToggle = t.template.querySelector('webui-toggle-icon.editor-view');
            t._content = t.template.querySelector('webui-content');
            t._message = t.template.querySelector('webui-input-message');
            t._btnReset = t.template.querySelector('webui-button[label="Reset"]');
            t._btnSave = t.template.querySelector('webui-button[label="Save"]');
            /** The shown file's text as it is saved, to tell unsaved changes by. Null until a file has loaded. */
            t._savedContent = null;
            t.refreshButtons();
        },
        /** Save and Reset are on only while the file shown has changes that aren't saved, and not while it saves. */
        refreshButtons() {
            const t = this;
            const loaded = !!t._loadingFile && t._loadedFile === t._loadingFile && t._savedContent !== null;
            const changed = loaded && `${t._message.value ?? ''}` !== t._savedContent;
            const ready = changed && !t._saving;
            const why = action => !loaded ? 'No doc has loaded to edit' : t._saving ? 'Saving the doc' : `This doc has no changes to ${action}`;
            t._btnSave.toggleAttribute('disabled', !ready);
            t._btnSave.setAttribute('title', ready ? 'Save the changes to this doc' : why('save'));
            t._btnReset.toggleAttribute('disabled', !ready);
            t._btnReset.setAttribute('title', ready ? 'Discard the changes and show the doc as it is saved' : why('reset'));
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
                const readmes = ['readme.md', 'docs/readme.md'];
                const docs = webui.projectData.docs || [];
                // The readme is listed first, so it is the one shown.
                t._files = [...docs.filter(file => readmes.includes(file.toLowerCase())), ...docs.filter(file => !readmes.includes(file.toLowerCase()))];
                t.drawList();
                if (t._files.length > 0) t.loadFile(t._files[0]);
            });
        },
        /** Lists the docs, marking the one shown. */
        drawList() {
            const t = this;
            t._list.replaceChildren(...(t._files || []).map(file => {
                const row = webui.create('button', { type: 'button', role: 'option', class: 'file-row', 'data-file': file, title: file });
                row.textContent = file;
                row.setAttribute('aria-selected', file === t._loadingFile ? 'true' : 'false');
                row.addEventListener('click', () => {
                    t.loadFile(file);
                    t._split.showPane?.('end');
                });
                return row;
            }));
            if (!t._files?.length) {
                const empty = webui.create('p', { class: 'empty' });
                empty.textContent = 'This project has no markdown docs.';
                t._list.appendChild(empty);
            }
        },
        async loadFile(file) {
            let t = this;
            t._loadedFile = null;
            t._loadingFile = file;
            t._savedContent = null;
            t._list.querySelectorAll('.file-row').forEach(row => row.setAttribute('aria-selected', row.dataset.file === file ? 'true' : 'false'));
            t._message.value = '';
            t.refreshButtons();
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
                t._savedContent = fileContent;
                t._content.setHtml(sanitizeProjectHtml(webui.parseMarkdown(fileContent)));
                t._message.value = fileContent;
            } else {
                t._content.setHtml('Failed to load content');
            }
            t.refreshButtons();
        },
        connected() {
            const t = this;
            rememberSplit(t._split, t._viewToggle, 'app-doc-manager');
            rememberSplit(t._editorSplit, t._editorToggle, 'app-doc-editor');
            t._message.addEventListener('input', ev => {
                t._content.setHtml(sanitizeProjectHtml(webui.parseMarkdown(t._message.value)));
                t.refreshButtons();
            });
            t._btnReset.addEventListener('click', async ev => {
                let file = t._loadingFile;
                if (!file || t._saving) return;
                t.loadFile(file);
            });
            t._btnSave.addEventListener('click', async ev => {
                let file = t._loadingFile;
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
                const contents = t._message.value;
                const saving = (async () => {
                    let msg = await webui.proxy.saveProjectFile(file, contents, err => {
                        if (stillShown()) actionNote(t._btnSave, err, 'danger');
                        else appAlert(`${file} wasn't saved: ${err}`, 'danger');
                    });
                    // What was saved is the file now, so only what was typed since is left to save.
                    if (msg && stillShown()) {
                        t._savedContent = contents;
                        actionNote(t._btnSave, msg, 'success');
                    }
                })();
                t._saving = saving;
                t._savingFile = file;
                t.refreshButtons();
                try {
                    await saving;
                } finally {
                    if (t._saving === saving) { t._saving = null; t._savingFile = null; }
                    t.refreshButtons();
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
display:flex;
flex-direction:column;
gap:var(--padding);
height:100%;
box-sizing:border-box;
padding-left:var(--padding);
}
.editor-split {
flex:1 1 auto;
min-height:0;
}
.preview {
padding-right:var(--padding);
}
.editor {
height:100%;
padding-left:var(--padding);
box-sizing:border-box;
}
</style>
<webui-flex align="center" gap="0.5rem">
<webui-toggle-icon class="files-view" label="View" icon-on="square" icon-off="table-columns" title-on="Showing the list of docs or the doc, one at a time. Click to show them side by side." title-off="Showing the list of docs and the doc side by side. Click to show one at a time."></webui-toggle-icon>
</webui-flex>
<webui-split-panes class="files-split" fill min="220" ratio="0.25" show="end" start-label="Docs" end-label="Doc">
<div slot="start" class="file-list" role="listbox" aria-label="Docs"></div>
<div slot="end" class="file-view">
<webui-flex align="center" gap="0.5rem">
<webui-toggle-icon class="editor-view" label="View" icon-on="square" icon-off="table-columns" title-on="Showing the preview or the editor, one at a time. Click to show them side by side." title-off="Showing the preview and the editor side by side. Click to show one at a time."></webui-toggle-icon>
<webui-flex grow></webui-flex>
<webui-button theme="warning" label="Reset"></webui-button>
<webui-button theme="success" label="Save"></webui-button>
</webui-flex>
<webui-split-panes class="editor-split" min="280" show="end" start-label="Preview" end-label="Editor">
<webui-content slot="start" class="preview"></webui-content>
<div slot="end" class="editor"><webui-input-message aria-label="Markdown"></webui-input-message></div>
</webui-split-panes>
</div>
</webui-split-panes>
`
    });
}
