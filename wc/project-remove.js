/*
 * Settings' Danger tab: removes the current project from Task Proxy, after asking. Its files and folders are left as
 * they are.
 */
"use strict"
{
    webui.define("app-project-remove", {
        connected() {
            const t = this;
            // Removing is for the current project, so the button is off while there is none.
            t.dataset.subscribe = 'app-current-project:projectChanged';
            if (t._button) {
                t.projectChanged(webui.getData('app-current-project'));
                return;
            }
            const intro = webui.create('p');
            intro.textContent = 'Remove the current project from Task Proxy. Its files and folders on this computer stay as they are, and you can add it again from the Projects tab.';
            t._button = webui.create('webui-button', { id: 'btn-remove', theme: 'danger', 'start-icon': 'trash', label: 'Remove Project' });
            t._button.addEventListener('click', () => t.removeProject());
            const actions = webui.create('div', { class: 'project-actions' });
            actions.append(t._button);
            t.append(intro, actions);
            t.projectChanged(webui.getData('app-current-project'));
        },
        projectChanged(project) {
            const button = this._button;
            if (!button) return;
            const open = !!project?.value;
            button.toggleAttribute('disabled', !open);
            button.setAttribute('title', open ? 'Remove the current project from Task Proxy' : 'Open a project to remove it');
        },
        removeProject() {
            const currentProject = webui.getData('app-current-project');
            if (!currentProject || !currentProject.value) {
                actionNote(this._button, 'No project is currently selected.', 'warning');
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
                    // The dialog's alert shows HTML, and errors can name the project's files. A list that couldn't be
                    // reloaded after the project was removed is said in the app's alerts, as the dialog closes.
                    let result = await webui.proxy.removeProject(currentProject.value, msg => content.alert(webui.escapeForHTML(`${msg}`), 'danger'), msg => appAlert(msg, 'warning'));
                    if (result) {
                        // The dialog closes and the project's screen goes, so this is said in the app's alerts.
                        appAlert(result, 'success');
                        webui.setData('app-current-project', null);
                        return true;
                    }
                }
            });
        },
    });
}
