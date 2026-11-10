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
    const plural = (count, one, many) => count === 1 ? `1 ${one}` : `${count} ${many}`;
    // Each kind has its own color, and its number matches its icon.
    const markers = [
        { key: 'changes', icon: 'code-commit', theme: 'info', title: count => plural(count, 'changed file', 'changed files') },
        { key: 'behind', icon: 'download', theme: 'danger', title: count => `${plural(count, 'commit', 'commits')} behind the remote` },
        { key: 'ahead', icon: 'upload', theme: 'success', title: count => `${plural(count, 'commit', 'commits')} ahead of the remote` },
    ];
    /** A project's name, with an icon and number for its changed files and commits behind and ahead. */
    function projectHtml(name, status) {
        // The list widens to fit a name and its counts on one line. In the narrow picker a long name wraps, and the
        // counts move below it when there is no room beside it.
        const label = `<span class="project-name" style="flex:1 1 auto;min-width:0;overflow-wrap:anywhere;">${webui.escapeHtml(`${name}`)}</span>`;
        const shown = markers
            .filter(marker => status?.[marker.key] > 0)
            .map(marker => {
                const count = status[marker.key];
                return `<span class="project-${marker.key}" title="${marker.title(count)}" style="display:inline-flex;align-items:center;gap:0.15em;color:var(--color-${marker.theme});"><webui-icon icon="${marker.icon}" theme="${marker.theme}" aria-hidden="true"></webui-icon>${count}</span>`;
            });
        if (shown.length === 0) return label;
        const markersHtml = `<span class="project-status" style="display:inline-flex;align-items:center;gap:0.45em;margin-left:auto;flex-shrink:0;">${shown.join('')}</span>`;
        return `<span class="project-option" style="display:flex;flex-wrap:wrap;align-items:center;column-gap:1em;flex:1 1 auto;min-width:0;">${label}${markersHtml}</span>`;
    }
    webui.define("app-project-dropdown", {
        linkCss: false,
        watchVisibility: false,
        isInput: false,
        preload: 'dropdown',
        constructor() {
            const t = this;
            t._dropdown = t.template.querySelector('webui-dropdown');
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
            t.dataset.subscribe = 'app-projects:setProjects';
            loadProjects();
            t._refresh = () => t.loadStatus();
            t._timer = setInterval(t._refresh, changeCheckInterval);
            t._fetchTimer = setInterval(() => t.fetchRemotes(), remoteFetchInterval);
            window.addEventListener('focus', t._refresh);
            // The Git Controller says when it has loaded a project's changes, such as after a commit.
            document.addEventListener('app-git-changes', t._refresh);
        },
        disconnected() {
            const t = this;
            clearInterval(t._timer);
            clearInterval(t._fetchTimer);
            window.removeEventListener('focus', t._refresh);
            document.removeEventListener('app-git-changes', t._refresh);
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
        renderOptions() {
            const t = this;
            if (!t._projects) return [];
            const options = t._projects.map(item => ({ value: item.path, display: item.name, html: projectHtml(item.name, t._status[item.path]) }));
            t._dropdown.setOptions(options);
            return options;
        },
        async setProjects(projects) {
            const t = this;
            projects = projects || [];
            await customElements.whenDefined('webui-dropdown');
            t._projects = projects;
            let dp = t.renderOptions();
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
<webui-dropdown html-options title="Project" data-name="app-current-project"></webui-dropdown>
`
    });
}
