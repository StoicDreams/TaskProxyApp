"use strict"
{
    async function loadProjects() {
        await whenProxyReady();
        let projects = await webui.proxy.getProjects() || [];
        webui.setData('app-projects', projects);
    }
    // Other projects' files change outside the app, so their counts are checked on a timer as well.
    const changeCheckInterval = 30000;
    /** A project's name, with an icon and the number of changed files when it has any. */
    function projectHtml(name, changes) {
        // A long name wraps in the narrow sidebar, and the count stays whole beside it.
        const label = `<span class="project-name" style="min-width:0;overflow-wrap:anywhere;">${webui.escapeHtml(`${name}`)}</span>`;
        if (!changes) return label;
        const files = changes === 1 ? '1 changed file' : `${changes} changed files`;
        return `${label}<span class="project-changes" title="${files}" style="display:inline-flex;align-items:center;gap:0.25em;margin-left:auto;padding-left:1em;flex-shrink:0;"><webui-icon icon="code-commit" theme="warning" aria-hidden="true"></webui-icon>${changes}</span>`;
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
            t._counts = {};
            t.dataset.subscribe = 'app-projects:setProjects';
            loadProjects();
            t._refresh = () => t.loadChangeCounts();
            t._timer = setInterval(t._refresh, changeCheckInterval);
            window.addEventListener('focus', t._refresh);
            // The Git Controller says when it has loaded a project's changes, such as after a commit.
            document.addEventListener('app-git-changes', t._refresh);
        },
        disconnected() {
            const t = this;
            clearInterval(t._timer);
            window.removeEventListener('focus', t._refresh);
            document.removeEventListener('app-git-changes', t._refresh);
        },
        async loadChangeCounts() {
            const t = this;
            if (t._loadingCounts) {
                t._countsAgain = true;
                return;
            }
            t._loadingCounts = true;
            try {
                await whenProxyReady();
                const counts = await webui.proxy.git.getProjectChangeCounts(() => null);
                if (counts && JSON.stringify(counts) !== JSON.stringify(t._counts)) {
                    t._counts = counts;
                    t.renderOptions();
                }
            } finally {
                t._loadingCounts = false;
            }
            if (t._countsAgain) {
                t._countsAgain = false;
                t.loadChangeCounts();
            }
        },
        renderOptions() {
            const t = this;
            if (!t._projects) return [];
            const options = t._projects.map(item => ({ value: item.path, display: item.name, html: projectHtml(item.name, t._counts[item.path]) }));
            t._dropdown.setOptions(options);
            return options;
        },
        async setProjects(projects) {
            const t = this;
            projects = projects || [];
            await customElements.whenDefined('webui-dropdown');
            t._projects = projects;
            let dp = t.renderOptions();
            t.loadChangeCounts();
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
