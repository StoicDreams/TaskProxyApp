/*
 * A project's name that renames it in place: clicking the name, or its edit icon, puts a field with Cancel and Save
 * in its place. Enter saves and Escape cancels. Used for the current project in Settings' heading, and for each
 * project in Settings' project list. `project` is the project's path, and `name` its name.
 */
"use strict"
{
    webui.define("app-project-name", {
        preload: 'input-text button',
        attr: ['project', 'name'],
        attrChanged(property, value) {
            const t = this;
            if (!t._name) return;
            if (property === 'project' && t._editing) t.stopEditing(false);
            if (property === 'name') t._nameText.textContent = `${value ?? ''}`;
        },
        constructor() {
            const t = this;
            t._editing = false;
        },
        connected() {
            const t = this;
            if (t._name) return;
            // The name, with an edit icon, is one button that starts renaming.
            t._name = webui.create('button', { type: 'button', class: 'project-name', title: 'Rename the project' });
            t._nameText = webui.create('span', { class: 'project-name-text' });
            // Text, never markup: names come from the user and from project lists.
            t._nameText.textContent = `${t.getAttribute('name') ?? ''}`;
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
            t.append(t._name, t._rename);
        },
        async startEditing() {
            const t = this;
            if (!t.getAttribute('project') || t._editing) return;
            t._editing = true;
            t._name.hidden = true;
            t._rename.hidden = false;
            await customElements.whenDefined('webui-input-text');
            if (!t._editing) return;
            t._input.value = `${t.getAttribute('name') ?? ''}`;
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
            const path = t.getAttribute('project');
            if (!t._editing || t._saving || !path) return;
            const newName = `${t._input.value || ''}`.trim();
            if (!newName) {
                webui.alert('Project name cannot be empty.', 'warning');
                return;
            }
            if (newName === t.getAttribute('name')) {
                t.stopEditing(true);
                return;
            }
            t._saving = true;
            const result = await webui.proxy.renameProject(path, newName, msg => webui.alert(msg));
            t._saving = false;
            // A refused name keeps the field open, so it can be corrected.
            if (!result || !t._editing || t.getAttribute('project') !== path) return;
            webui.alert(result, 'success');
            t.setAttribute('name', newName);
            if (webui.getData('app-current-project')?.value === path) {
                webui.setData('app-current-project', { value: path, display: newName });
            }
            t.stopEditing(true);
        },
    });
}
