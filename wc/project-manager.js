/*
 * The current project in Settings: its icon and name in the heading, where clicking the name renames it in place, and
 * removing it from Task Proxy. Drawn in the page rather than a shadow root, so the page's heading styles apply.
 */
"use strict"
{
    webui.define("app-project-manager", {
        preload: 'app:project-icon',
        constructor() {
            const t = this;
            t._editing = false;
        },
        connected() {
            const t = this;
            if (!t._heading) t.build();
            t.dataset.subscribe = 'app-current-project:setProject';
            t.setProject(webui.getData('app-current-project'));
        },
        build() {
            const t = this;
            t._heading = webui.create('h3', { class: 'current-project' });
            t._heading.append(document.createTextNode('Current project:'));
            t._icon = webui.create('app-project-icon');
            // The name, with an edit icon, is one button that starts renaming.
            t._name = webui.create('button', { type: 'button', class: 'project-name', title: 'Rename the project' });
            t._nameText = webui.create('span', { class: 'project-name-text' });
            const pencil = webui.create('webui-icon', { icon: 'pencil', 'aria-hidden': 'true' });
            t._name.append(t._nameText, pencil);
            t._name.addEventListener('click', () => t.startEditing());
            t._rename = webui.create('span', { class: 'project-rename' });
            t._rename.hidden = true;
            t._input = webui.create('webui-input-text', { 'aria-label': 'Project name' });
            t._cancel = webui.create('webui-button', { theme: 'secondary', 'start-icon': 'xmark', label: 'Cancel' });
            t._save = webui.create('webui-button', { theme: 'primary', 'start-icon': 'save', label: 'Save' });
            t._rename.append(t._input, t._cancel, t._save);
            t._cancel.addEventListener('click', () => t.stopEditing(true));
            t._save.addEventListener('click', () => t.saveName());
            t._input.addEventListener('keydown', ev => {
                if (ev.key === 'Enter') {
                    ev.preventDefault();
                    t.saveName();
                } else if (ev.key === 'Escape') {
                    ev.preventDefault();
                    ev.stopPropagation();
                    t.stopEditing(true);
                }
            });
            t._heading.append(t._icon, t._name, t._rename);
            const remove = webui.create('webui-button', { id: 'btn-remove', theme: 'danger', label: 'Remove Project' });
            remove.addEventListener('click', () => t.removeProject());
            const actions = webui.create('div', { class: 'project-actions' });
            actions.append(remove);
            t.append(t._heading, actions);
        },
        /** Shows the current project's name, leaving a rename in progress alone unless the project changed. */
        setProject(project) {
            const t = this;
            const changed = t._project?.value !== project?.value;
            t._project = project && project.value ? project : null;
            t._heading.hidden = !t._project;
            // Text, never markup: names come from the user and from project lists.
            t._nameText.textContent = t._project ? `${t._project.display ?? ''}` : '';
            if (changed && t._editing) t.stopEditing(false);
        },
        async startEditing() {
            const t = this;
            if (!t._project || t._editing) return;
            t._editing = true;
            t._name.hidden = true;
            t._rename.hidden = false;
            await customElements.whenDefined('webui-input-text');
            if (!t._editing) return;
            t._input.value = `${t._project.display ?? ''}`;
            t._input._field?.focus();
            t._input._field?.select();
        },
        stopEditing(refocus) {
            const t = this;
            t._editing = false;
            t._saving = false;
            t._rename.hidden = true;
            t._name.hidden = false;
            if (refocus) t._name.focus();
        },
        async saveName() {
            const t = this;
            if (!t._editing || t._saving || !t._project) return;
            const project = t._project;
            const newName = `${t._input.value || ''}`.trim();
            if (!newName) {
                webui.alert('Project name cannot be empty.', 'warning');
                return;
            }
            if (newName === project.display) {
                t.stopEditing(true);
                return;
            }
            t._saving = true;
            const result = await webui.proxy.renameProject(project.value, newName, msg => webui.alert(msg));
            t._saving = false;
            // A refused name keeps the field open, so it can be corrected.
            if (!result || !t._editing || t._project?.value !== project.value) return;
            webui.alert(result, 'success');
            webui.setData('app-current-project', { value: project.value, display: newName });
            t.stopEditing(true);
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
