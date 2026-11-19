/*
 * A project's name that renames it in place, with webui-edit-in-place: clicking the name, or its edit icon, puts a
 * field with Cancel and Save in its place. Enter saves and Escape cancels. Used for the current project in Settings'
 * heading, and for each project in Settings' project list. `project` is the project's path, and `name` its name.
 */
"use strict"
{
    webui.define("app-project-name", {
        preload: 'edit-in-place',
        attr: ['project', 'name'],
        attrChanged(property, value) {
            const t = this;
            if (!t._edit) return;
            if (property === 'project' && t._edit.editing) t._edit.cancel();
            if (property === 'name') t._edit.setAttribute('value', `${value ?? ''}`);
        },
        connected() {
            const t = this;
            if (t._edit) return;
            t._edit = webui.create('webui-edit-in-place', {
                class: 'project-name', label: 'Project name', 'edit-title': 'Rename the project', required: 'Project name cannot be empty.',
            });
            t._edit.setAttribute('value', `${t.getAttribute('name') ?? ''}`);
            // A refused name keeps the field open, so it can be corrected.
            t._edit.addEventListener('save', ev => ev.detail.waitUntil(t.rename(ev.detail.value)));
            t.append(t._edit);
        },
        /** Renames the project in the backend. Resolves to whether it was renamed. */
        async rename(newName) {
            const t = this;
            const path = t.getAttribute('project');
            if (!path) return false;
            const result = await webui.proxy.renameProject(path, newName, msg => webui.alert(msg));
            if (!result || t.getAttribute('project') !== path) return false;
            webui.alert(result, 'success');
            t.setAttribute('name', newName);
            if (webui.getData('app-current-project')?.value === path) {
                webui.setData('app-current-project', { value: path, display: newName });
            }
            return true;
        },
    });
}
