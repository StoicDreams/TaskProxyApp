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
            const options = t._projects.map(item => ({ value: item.path, display: item.name, html: webui.proxy.git.statusHtml(item.name, t._status[item.path]) }));
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
