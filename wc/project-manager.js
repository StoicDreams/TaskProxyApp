/*
 * The current project in Settings: its icon and name in the heading, where clicking the name renames it in place.
 * Removing it is in Settings' Danger tab (wc/project-remove.js). Drawn in the page rather than a shadow root, so the page's heading styles apply.
 */
"use strict"
{
    webui.define("app-project-manager", {
        preload: 'app:project-icon app:project-name',
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
            t._name = webui.create('app-project-name');
            t._heading.append(t._icon, t._name);
            t.append(t._heading);
        },
        /** Shows the current project's name. A rename in progress stops only when another project opens. */
        setProject(project) {
            const t = this;
            const current = project && project.value ? project : null;
            t._heading.hidden = !current;
            if (!current) {
                // With no project, the name is for none, so what its rename said goes too.
                t._name.removeAttribute('project');
                return;
            }
            if (t._name.getAttribute('project') !== current.value) t._name.setAttribute('project', current.value);
            t._name.setAttribute('name', `${current.display ?? ''}`);
        },
    });
}
