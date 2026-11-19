/*
 * Settings' project list: every saved project as a row of its icon, its name, and its git status, the same badges
 * the project dropdown shows. The icon and name edit in place, as the current project's do.
 */
"use strict"
{
    webui.define("app-projects-report", {
        preload: 'app:project-icon app:project-name',
        connected() {
            const t = this;
            if (!t._table) t.build();
            t._status ??= {};
            t._ci ??= {};
            t.dataset.subscribe = 'app-projects:setProjects';
            t.setProjects(webui.getData('app-projects'));
            // The Git Controller says when it has loaded a project's changes, such as after a commit.
            t._refresh ??= () => t.loadStatus();
            document.addEventListener('app-git-changes', t._refresh);
            t.loadStatus();
        },
        disconnected() {
            document.removeEventListener('app-git-changes', this._refresh);
        },
        build() {
            const t = this;
            t._table = webui.create('table', { class: 'projects-report' });
            const head = webui.create('thead');
            const header = webui.create('tr');
            ['Icon', 'Name', 'Git status'].forEach(label => {
                const cell = webui.create('th', { scope: 'col' });
                cell.textContent = label;
                header.append(cell);
            });
            head.append(header);
            t._body = webui.create('tbody');
            t._table.append(head, t._body);
            t._empty = webui.create('p', { class: 'projects-report-empty' });
            t._empty.textContent = 'No projects yet. Add one below.';
            t.append(t._table, t._empty);
        },
        /** A row for each project, kept when the list changes so a rename in progress isn't lost. */
        setProjects(projects) {
            const t = this;
            projects = Array.isArray(projects) ? projects : [];
            t._table.hidden = !projects.length;
            t._empty.hidden = !!projects.length;
            const rows = new Map([...t._body.children].map(row => [row.dataset.project, row]));
            const ordered = projects.map(project => {
                let row = rows.get(project.path);
                if (!row) {
                    row = webui.create('tr');
                    row.dataset.project = project.path;
                    const icon = webui.create('td', { class: 'project-icon-cell' });
                    icon.append(webui.create('app-project-icon', { project: project.path }));
                    const name = webui.create('td', { class: 'project-name-cell' });
                    name.append(webui.create('app-project-name', { project: project.path, name: project.name }));
                    const status = webui.create('td', { class: 'project-status-cell' });
                    row.append(icon, name, status);
                }
                const name = row.querySelector('app-project-name');
                if (name.getAttribute('name') !== project.name) name.setAttribute('name', project.name);
                rows.delete(project.path);
                return row;
            });
            rows.forEach(row => row.remove());
            t._body.append(...ordered);
            t.renderStatus();
        },
        async loadStatus() {
            const t = this;
            if (t._loading) return;
            t._loading = true;
            try {
                await whenProxyReady();
                const [status, ci] = await Promise.all([
                    webui.proxy.git.getProjectStatus(() => null),
                    webui.proxy.git.getProjectCiStatus(),
                ]);
                if (status) t._status = status;
                if (ci) t._ci = ci;
                t.renderStatus();
            } finally {
                t._loading = false;
            }
        },
        renderStatus() {
            const t = this;
            if (!t._body.children.length || !webui.proxy?.git) return;
            const status = webui.proxy.git.withCiStatus(t._status, t._ci);
            [...t._body.children].forEach(row => {
                const cell = row.querySelector('.project-status-cell');
                // App markup from the status counts, never text from a project. A repo with nothing to show says so.
                const found = status[row.dataset.project];
                const markers = webui.proxy.git.statusMarkersHtml(found);
                const html = markers || (found ? '<span class="git-clean">Up to date</span>' : '');
                if (cell._html !== html) {
                    cell._html = html;
                    cell.innerHTML = html;
                }
            });
        },
    });
}
