/*
 * Settings' project list: every saved project as a tile of its icon, its name, its folder, and its git status (the
 * same badges the project dropdown shows), in a webui-tiles, which fits as many to a row as it can and finds them by
 * name or folder. The icon and name edit in place, as the current project's do.
 */
"use strict"
{
    webui.define("app-projects-report", {
        preload: 'app:project-icon app:project-name tiles',
        connected() {
            const t = this;
            if (!t._grid) t.build();
            t._status ??= {};
            t._ci ??= {};
            t.dataset.subscribe = 'app-projects:setProjects|app-current-project:markCurrent';
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
            t._grid = webui.create('webui-tiles', {
                class: 'projects-report', label: 'Your projects', find: 'Find a project',
                'count-label': 'project|projects', empty: 'No project matches that.', min: '16em',
            });
            t._empty = webui.create('p', { class: 'projects-report-empty' });
            t._empty.textContent = 'No projects yet. Add one below.';
            t.append(t._grid, t._empty);
        },
        /** A tile for each project, kept when the list changes so a rename in progress isn't lost. */
        setProjects(projects) {
            const t = this;
            projects = Array.isArray(projects) ? projects : [];
            t._grid.hidden = !projects.length;
            t._empty.hidden = !!projects.length;
            const tiles = new Map([...t._grid.children].map(tile => [tile.dataset.project, tile]));
            const ordered = projects.map(project => {
                let tile = tiles.get(project.path);
                if (!tile) {
                    tile = webui.create('div', { role: 'listitem', class: 'project-tile' });
                    tile.dataset.project = project.path;
                    const icon = webui.create('app-project-icon', { project: project.path });
                    const text = webui.create('div', { class: 'project-tile-text' });
                    const name = webui.create('app-project-name', { project: project.path, name: project.name });
                    const line = webui.create('div', { class: 'project-tile-line' });
                    const path = webui.create('span', { class: 'project-tile-path' });
                    path.textContent = project.path;
                    path.title = project.path;
                    const status = webui.create('span', { class: 'project-status-cell' });
                    line.append(path, status);
                    text.append(name, line);
                    tile.append(icon, text);
                }
                const name = tile.querySelector('app-project-name');
                if (name.getAttribute('name') !== project.name) name.setAttribute('name', project.name);
                // What the find field looks in: the name and the folder, not the git badges.
                const words = `${project.name} ${project.path}`;
                if (tile.dataset.find !== words) tile.dataset.find = words;
                tiles.delete(project.path);
                return tile;
            });
            tiles.forEach(tile => tile.remove());
            t._grid.append(...ordered);
            t.markCurrent();
            t.renderStatus();
        },
        /** Marks the open project's tile. */
        markCurrent() {
            const t = this;
            if (!t._grid) return;
            const current = webui.getData('app-current-project')?.value;
            [...t._grid.children].forEach(tile => {
                if (tile.dataset.project === current) tile.setAttribute('aria-current', 'true');
                else tile.removeAttribute('aria-current');
            });
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
            if (!t._grid.children.length || !webui.proxy?.git) return;
            const status = webui.proxy.git.withCiStatus(t._status, t._ci);
            [...t._grid.children].forEach(tile => {
                const cell = tile.querySelector('.project-status-cell');
                // App markup from the status counts, never text from a project. A repo with nothing to show says so.
                const found = status[tile.dataset.project];
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
