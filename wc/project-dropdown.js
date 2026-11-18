"use strict"
{
    async function loadProjects() {
        await whenProxyReady();
        let projects = await webui.proxy.getProjects() || [];
        webui.setData('app-projects', projects);
    }
    // Other projects' files change outside the app, so their counts are checked on a timer as well.
    const changeCheckInterval = 30000;
    // Behind only shows what the last fetch saw, so every project's remote is fetched now and then.
    const remoteFetchInterval = 300000;
    webui.define("app-project-dropdown", {
        linkCss: false,
        watchVisibility: false,
        isInput: false,
        preload: 'select',
        constructor() {
            const t = this;
            t._dropdown = t.template.querySelector('webui-select');
            // Only the project's name and path are kept as the current project, not its icon or status markup.
            t._dropdown.addEventListener('change', () => {
                const chosen = (t._projects || []).find(item => item.path === t._dropdown.value);
                if (chosen) webui.setData('app-current-project', { value: chosen.path, display: chosen.name });
            });
        },
        attr: [],
        flags: [],
        attrChanged(property, value) {
            const t = this;
            switch (property) {
            }
        },
        connected() {
            const t = this;
            t._status = {};
            t._ci = {};
            t.dataset.subscribe = 'app-projects:setProjects|app-current-project:setCurrent';
            loadProjects();
            t._refresh = () => t.loadStatus();
            t._timer = setInterval(t._refresh, changeCheckInterval);
            t._fetchTimer = setInterval(() => t.fetchRemotes(), remoteFetchInterval);
            window.addEventListener('focus', t._refresh);
            // The Git Controller says when it has loaded a project's changes, such as after a commit.
            document.addEventListener('app-git-changes', t._refresh);
            // Settings says when a project's icon changes.
            t._iconsChanged = () => t.loadIcons();
            document.addEventListener('app-project-icons-changed', t._iconsChanged);
        },
        disconnected() {
            const t = this;
            clearInterval(t._timer);
            clearInterval(t._fetchTimer);
            window.removeEventListener('focus', t._refresh);
            document.removeEventListener('app-git-changes', t._refresh);
            document.removeEventListener('app-project-icons-changed', t._iconsChanged);
        },
        async loadStatus() {
            const t = this;
            if (t._loadingStatus) {
                t._statusAgain = true;
                return;
            }
            t._loadingStatus = true;
            try {
                await whenProxyReady();
                const status = await webui.proxy.git.getProjectStatus(() => null);
                if (status && JSON.stringify(status) !== JSON.stringify(t._status)) {
                    t._status = status;
                    t.renderOptions();
                }
            } finally {
                t._loadingStatus = false;
            }
            if (t._statusAgain) {
                t._statusAgain = false;
                t.loadStatus();
            }
            // Apart from the counts, since it waits on Git servers. The backend keeps finished results and asks
            // again about unfinished ones at most once a minute, so asking this often is cheap.
            t.loadCiStatus();
        },
        async loadCiStatus() {
            const t = this;
            if (t._loadingCi) return;
            t._loadingCi = true;
            try {
                await whenProxyReady();
                const ci = await webui.proxy.git.getProjectCiStatus();
                if (ci && JSON.stringify(ci) !== JSON.stringify(t._ci)) {
                    t._ci = ci;
                    t.renderOptions();
                }
            } finally {
                t._loadingCi = false;
            }
        },
        /** Fetches every project's remote quietly, then shows the new ahead and behind counts. */
        async fetchRemotes() {
            const t = this;
            if (t._fetching) return;
            t._fetching = true;
            try {
                await whenProxyReady();
                await webui.proxy.git.fetchProjectRemotes();
            } finally {
                t._fetching = false;
            }
            t.loadStatus();
        },
        /** Reads every project's icon, and shows them once they arrive. */
        async loadIcons() {
            const t = this;
            const load = (t._iconLoad || 0) + 1;
            t._iconLoad = load;
            await whenProxyReady();
            const found = await webui.proxy.projectIcons.all();
            if (load !== t._iconLoad) return;
            const icons = Object.fromEntries((found || []).filter(item => item.icon).map(item => [item.path, item.icon]));
            if (JSON.stringify(icons) === JSON.stringify(t._icons || {})) return;
            t._icons = icons;
            t.renderOptions();
        },
        renderOptions() {
            const t = this;
            if (!t._projects) return [];
            // An empty list can arrive before webui.proxy exists, so it is only used for projects to show.
            const status = t._projects.length ? webui.proxy.git.withCiStatus(t._status, t._ci) : {};
            // Each project's icon, from its .taskproxy/Project.json, and its git status beside its name.
            const options = t._projects.map(item => ({
                value: item.path,
                display: item.name,
                image: t._icons?.[item.path] || '',
                badge: webui.proxy.git.statusMarkersHtml(status[item.path]),
            }));
            t._dropdown.setOptions(options);
            return options;
        },
        /** Shows the project that is open, when another part of the app opens one. */
        setCurrent(current) {
            const t = this;
            if (current?.value && t._projects && t._dropdown.value !== current.value) t._dropdown.value = current.value;
        },
        async setProjects(projects) {
            const t = this;
            projects = projects || [];
            await customElements.whenDefined('webui-select');
            t._projects = projects;
            let dp = t.renderOptions();
            t.loadIcons();
            t.loadStatus();
            if (!t._fetchedOnce) {
                t._fetchedOnce = true;
                t.fetchRemotes();
            }
            if (projects.length === 0) {
                t.classList.remove('show');
            } else {
                t.classList.add('show');
                let current = webui.getData('app-current-project');
                if (current && current.value) {
                    t._dropdown.value = current.value;
                }
                setTimeout(() => {
                    let value = webui.getData('app-current-project');
                    if (!value) {
                        webui.setData('app-current-project', { value: dp[0].value, display: dp[0].display });
                    } else if (value.value && t._dropdown.value !== value.value) {
                        t._dropdown.value = value.value;
                    }
                }, 100);
            }
        },
        shadowTemplate: `
<style type="text/css">
:host {
display:none;
}
:host(.show) {
display:block;
}
</style>
<webui-select title="Projects" aria-label="Project" item-size="8em"></webui-select>
`
    });
}
