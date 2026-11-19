/*
 * Settings' Danger tab: removes the current project from Task Proxy, after asking. Its files and folders are left as
 * they are.
 */
"use strict"
{
    webui.define("app-project-remove", {
        connected() {
            const t = this;
            if (t._button) return;
            const intro = webui.create('p');
            intro.textContent = 'Remove the current project from Task Proxy. Its files and folders on this computer stay as they are, and you can add it again from the Projects tab.';
            t._button = webui.create('webui-button', { id: 'btn-remove', theme: 'danger', 'start-icon': 'trash', label: 'Remove Project' });
            t._button.addEventListener('click', () => t.removeProject());
            const actions = webui.create('div', { class: 'project-actions' });
            actions.append(t._button);
            t.append(intro, actions);
        },
        removeProject() {
            const currentProject = webui.getData('app-current-project');
            if (!currentProject || !currentProject.value) {
                webui.alert('No project is currently selected.', 'warning');
                return;
            }
            webui.dialog({
                title: 'Remove Project',
                content: `
                <p>Are you sure you want to remove the project <strong>${webui.escapeForHTML(currentProject.display)}</strong>?</p>
                <p style="background: var(--color-danger); color: var(--color-danger-offset); padding: 0.25em 0.5em; border-radius: var(--corners);">This will only remove the project from Task Proxy. No files or folders will be deleted.</p>
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
        },
    });
}
