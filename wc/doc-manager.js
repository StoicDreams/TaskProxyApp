
"use strict"
{
    webui.define("app-doc-manager", {
        linkCss: true,
        preload: '',
        constructor: (t) => {
            t._fileSelector = t.template.querySelector('webui-dropdown[label="File"]');
            t._content = t.template.querySelector('webui-content');
            t._message = t.template.querySelector('webui-input-message');
            t._btnReset = t.template.querySelector('webui-button[label="Reset"]');
            t._btnSave = t.template.querySelector('webui-button[label="Save"]');
        },
        attr: [],
        flags: [],
        attrChanged: (t, property, value) => {
            switch (property) {
            }
        },
        loadFiles: async function () {
            let t = this;
            let counter = 0;
            while (webui.projectData.docs === undefined && counter++ < 1000) {
                await webui.wait(10);
            }
            t._files = webui.projectData.docs || [];
            let options = [];
            t._files.forEach(fileName => {
                let item = {
                    id: fileName,
                    value: fileName,
                    display: fileName
                };
                if (['readme.md', 'docs\\readme.md'].indexOf(fileName.toLowerCase()) !== -1) {
                    options.unshift(item);
                } else {
                    options.push(item);
                }
            });
            t._fileSelector.setOptions(options);
            if (options.length > 0) {
                t.loadFile(t._fileSelector.value);
            }
        },
        loadFile: async function (file) {
            let t = this;
            t._message.value = '';
            if (!file) return;
            let fileContent = await webui.proxy.getProjectFile(file);
            let counter = 0;
            while (!t._content.setHtml && counter++ < 1000) {
                await webui.wait(10);
            }
            if (fileContent !== undefined) {
                t._content.setHtml(webui.parseMarkdown(fileContent));
                t._message.value = fileContent;
            } else {
                t._content.setHtml('Failed to load content');
            }
        },
        connected: function (t) {
            t._fileSelector.addEventListener('change', ev => {
                let file = t._fileSelector.value;
                t.loadFile(file);
            });
            t._message.addEventListener('input', ev => {
                t._content.setHtml(webui.parseMarkdown(t._message.value));
            });
            t._btnReset.addEventListener('click', async ev => {
                let file = t._fileSelector.value;
                if (!file) return;
                t.loadFile(file);
            });
            t._btnSave.addEventListener('click', async ev => {
                let file = t._fileSelector.value;
                if (!file) return;
                let msg = await webui.proxy.saveProjectFile(file, t._message.value);
                if (msg) { webui.alert(msg, 'success'); }
            });
            t.loadFiles();
        },
        disconnected: function (t) { },
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
<webui-dropdown label="File"></webui-dropdown>
<webui-button theme="warning" label="Reset"></webui-button>
<webui-button theme="success" label="Save"></webui-button>
</webui-grid>
<webui-grid columns="1fr 1fr">
<webui-content></webui-content>
<webui-input-message></webui-input-message>
</webui.grid>
`
    });
}