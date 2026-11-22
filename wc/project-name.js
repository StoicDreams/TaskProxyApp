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
            // Reused for another project, as the current project's heading is, it says nothing of the last one's rename.
            if (property === 'project') setNote(t._note, '');
            if (!t._edit) return;
            if (property === 'project' && t._edit.editing) t._edit.cancel();
            if (property === 'name') t._edit.setAttribute('value', `${value ?? ''}`);
        },
        connected() {
            const t = this;
            if (t._edit) return;
            // Not `required`, which webui-edit-in-place says in the app's alerts: a blank name is said by the name here.
            t._edit = webui.create('webui-edit-in-place', {
                class: 'project-name', label: 'Project name', 'edit-title': 'Rename the project',
            });
            t._edit.setAttribute('value', `${t.getAttribute('name') ?? ''}`);
            // A blank name's warning is about the edit, so it goes when the edit is cancelled.
            t._edit.addEventListener('cancel', () => setNote(t._note, ''));
            // A refused name keeps the field open, so it can be corrected.
            t._edit.addEventListener('save', ev => {
                // The backend saves the name trimmed, so a name of only spaces is blank, and it is shown as saved.
                const name = `${ev.detail.value ?? ''}`.trim();
                if (!name) {
                    ev.preventDefault();
                    setNote(t.note(), 'Project name cannot be empty.', 'warning');
                    return;
                }
                ev.detail.waitUntil(t.rename(name));
            });
            t.append(t._edit);
        },
        disconnected() {
            // Its alert sits outside it, after the heading, so it would stay behind with nothing to say it about.
            setNote(this._note, '');
        },
        /** The alert for what a rename did, after the name, or after the heading the name is in. */
        note() {
            const t = this;
            if (t._note?.isConnected) return t._note;
            t._note = webui.create('webui-alert', { class: 'action-note', style: 'flex-basis:100%;margin-top:calc(0.5 * var(--padding, 8px));' });
            (t.closest('h1, h2, h3, h4, h5, h6') || t).after(t._note);
            return t._note;
        },
        /** Renames the project in the backend. Resolves to whether it was renamed. */
        async rename(newName) {
            const t = this;
            const path = t.getAttribute('project');
            if (!path) return false;
            // Said under the name, as it is renamed.
            setNote(t._note, '');
            let reloadProblem = '';
            const result = await webui.proxy.renameProject(path, newName, msg => {
                if (t.getAttribute('project') === path) setNote(t.note(), msg, 'danger');
            }, msg => { reloadProblem = `${msg}`; });
            if (!result || t.getAttribute('project') !== path) return false;
            // Renamed, but the list showing it couldn't be reloaded: the message says both.
            if (reloadProblem) setNote(t.note(), reloadProblem, 'warning');
            else setNote(t.note(), result, 'success');
            t.setAttribute('name', newName);
            if (webui.getData('app-current-project')?.value === path) {
                webui.setData('app-current-project', { value: path, display: newName });
            }
            return true;
        },
    });
}
