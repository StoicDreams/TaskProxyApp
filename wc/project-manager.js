"use strict"
{
    webui.define("app-project-manager", {
        constructor() {
            const t = this;
            t._btnEdit = t.template.querySelector('#btn-edit');
            t._btnRemove = t.template.querySelector('#btn-remove');
        },
        connected() {
            const t = this;
            t._btnEdit.addEventListener('click', async _ => {
                let currentProject = webui.getData('app-current-project');
                if (!currentProject || !currentProject.value) {
                    webui.alert('No project is currently selected.', 'warning');
                    return;
                }
                webui.dialog({
                    title: 'Rename Project',
                    content: `
                        <webui-flex column><webui-input-text name="projectName" label="New Project Name" value="${currentProject.display}">
                        </webui-input-text></webui-flex>
                        `,
                    confirm: 'Rename',
                    cancel: 'Cancel',
                    onconfirm: async (data, content) => {
                        let formData = Object.fromEntries(data);
                        let newName = (formData.projectName || '').trim();
                        if (!newName) {
                            content.alert('Project name cannot be empty.');
                            return false;
                        }
                        let result = await webui.proxy.renameProject(currentProject.value, newName, msg => content.alert(msg));
                        if (result) {
                            webui.alert(result, 'success');
                            webui.setData('app-current-project', { value: currentProject.value, display: newName });
                            return true;
                        }
                    }
                });
            });
            t._btnRemove.addEventListener('click', async _ => {
                let currentProject = webui.getData('app-current-project');
                if (!currentProject || !currentProject.value) {
                    webui.alert('No project is currently selected.', 'warning');
                    return;
                }
                webui.dialog({
                    title: 'Remove Project',
                    content: `
                    <p>Are you sure you want to remove the project <strong>${currentProject.display}</strong>?</p>
                    <p style="color: var(--color-danger);">This will only remove the project from Task Proxy. No files or folders will be deleted.</p>
                    `,
                    confirm: 'Remove',
                    cancel: 'Cancel',
                    onconfirm: async (data, content) => {
                        let result = await webui.proxy.removeProject(currentProject.value, msg => content.alert(msg));
                        if (result) {
                            webui.alert(result, 'success');
                            webui.setData('app-current-project', null);
                            return true;
                        }
                    }
                });
            });
        },
        shadowTemplate: `
<style type="text/css">
:host {
    display: flex;
    gap: var(--padding);
    flex-wrap: wrap;
}
</style>
<webui-button id="btn-edit" theme="primary">Edit Name</webui-button>
<webui-button id="btn-remove" theme="danger">Remove Project</webui-button>
`
    });
}
