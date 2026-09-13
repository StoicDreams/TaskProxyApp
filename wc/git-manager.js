"use strict"
{
    webui.define("app-git-manager", {
        linkCss: true,
        watchVisibility: false,
        isInput: false,
        preload: 'tabs',
        constructor() {
            const t = this;
            t._repos = t.template.querySelector('webui-dropdown[label="Repo"]');
            t._branches = t.template.querySelector('webui-dropdown[label="Branch"]');
            t._fileName = t.template.querySelector('h3');
            t._filesContainer = t.template.querySelector('.files');
            t._viewNew = t.template.querySelector('.view-new');
            t._viewOld = t.template.querySelector('.view-old');
            t._message = t.template.querySelector('webui-input-message[label="Commit Message"]');
            t._alert = t.template.querySelector('webui-alert');
            t._btnRefresh = t.template.querySelector('webui-button[label="Refresh"]');
            t._btnCommit = t.template.querySelector('webui-button[label="Commit"]');
            t._btnSync = t.template.querySelector('webui-button[label="Sync"]');
            t._btnPush = t.template.querySelector('webui-button[label="Push"]');
            t._btnPull = t.template.querySelector('webui-button[label="Pull"]');
            t._btnFetch = t.template.querySelector('#btn-fetch');
            t._btnCreateBranch = t.template.querySelector('webui-button[label="New Branch"]');
            t._btnMergeBranch = t.template.querySelector('webui-button[label="Merge"]');
            t._btnDeleteBranch = t.template.querySelector('webui-button[label="Delete"]');
            t._instructions = t.template.querySelector('.instructions');
            t._btnRemoteTab = t.template.querySelector('#tab-remote');
            t._remoteStatusContainer = t.template.querySelector('#remote-status-container');
            t._isSwitchingBranch = false;
        },
        async loadRepos() {
            let t = this;
            let repos = await webui.proxy.git.getRepos();
            if (repos.length === 0) {
                t._repos.classList.add('hidden');
                t._branches.classList.add('hidden');
            } else {
                let options = repos.map(item => { return { id: item, value: item, display: item === '' ? 'Root' : item } });
                t._repos.setOptions(options);
                t._repos.classList.remove('hidden');
                if (webui.projectData.data.selectedGitRepo) {
                    t._repos.value = webui.projectData.data.selectedGitRepo;
                }
                await t.loadBranches();
            }
        },
        async loadBranches() {
            let t = this;
            let repo = t._repos.value;
            if (repo === undefined) return;
            let branchInfo = await webui.proxy.git.getBranches(repo, msg => t.setAlert(msg));
            if (branchInfo && branchInfo.branches) {
                t._branches.classList.remove('hidden');
                t._branchList = branchInfo.branches;
                let options = branchInfo.branches.map(b => { return { id: b, value: b, display: b } });
                t._branches.setOptions(options);
                t._isSwitchingBranch = true;
                t._branches.value = branchInfo.current_branch;
                t._isSwitchingBranch = false;
            } else {
                t._branches.classList.add('hidden');
            }
        },
        async loadRemoteStatus() {
            let t = this;
            let repo = t._repos.value;
            if (repo === undefined) return;
            t._remoteStatusContainer.innerHTML = '<em>Checking remote sync status...</em>';
            let status = await webui.proxy.git.getRemoteStatus(repo, msg => t.setAlert(msg));
            if (!status) {
                t._remoteStatusContainer.innerHTML = '<em style="color: var(--color-danger);">Failed to retrieve remote status.</em>';
                return;
            }
            let html = `<webui-flex column gap="0.5rem">`;
            html += `<div><strong>Remote URL:</strong> ${status.remoteUrl || 'No origin defined'}</div>`;
            if (status.hasUpstream) {
                html += `<div><strong>Tracking Branch:</strong> ${status.upstreamName}</div>`;
                html += `<div><strong>Sync Status:</strong> `;
                if (status.ahead === 0 && status.behind === 0) {
                    html += `<span style="color: var(--color-success);">Up to date with remote</span>`;
                } else {
                    if (status.ahead > 0) html += `<span style="color: var(--color-secondary); margin-right: 1rem;">${status.ahead} Commits Ahead (Pending Push)</span> `;
                    if (status.behind > 0) html += `<span style="color: var(--color-warning);">${status.behind} Commits Behind (Pending Pull)</span>`;
                }
                html += `</div>`;
            } else {
                html += `<div><span style="color: var(--color-danger);">No remote tracking branch set. Publish this branch to synchronize.</span></div>`;
            }
            html += `</webui-flex>`;
            t._remoteStatusContainer.innerHTML = html;
        },
        async loadFileDiff(changeDetail) {
            let t = this;
            await customElements.whenDefined('webui-canvas');
            t._fileName.innerHTML = `<em>Loading</em> ${changeDetail.display}`;
            t._viewOld.setLines([]);
            t._viewNew.setLines([]);
            if (changeDetail.fileName.endsWith('/')) {
                return;
            }
            let data = { change: changeDetail.change, isCompare: false };
            let fullFilePath = changeDetail.repo === '' ? changeDetail.fileName : `${changeDetail.repo}/${changeDetail.fileName}`;
            data.fileDiff = changeDetail.change !== 'Add' ? await webui.proxy.git.getFileDiff(changeDetail.repo, changeDetail.fileName) : '';
            switch (changeDetail.change) {
                case "Add":
                    t._viewOld.classList.add('hidden');
                    t._viewNew.style.setProperty('grid-column', '1/3');
                    break;
                case "Delete":
                    t._viewOld.classList.add('hidden');
                    t._viewNew.style.setProperty('grid-column', '1/3');
                    break;
                default:
                    data.isCompare = data.fileDiff !== undefined;
                    t._viewOld.classList.remove('hidden');
                    t._viewNew.style.removeProperty('grid-column');
                    break;
            }
            if (changeDetail.change === 'Delete') {
                let a = data.fileDiff.split('@@');
                data.fileContent = a.length > 1 ? a[a.length - 1].substring(1) : '';
            } else {
                data.fileContent = await webui.proxy.getProjectFile(fullFilePath);
            }
            if (data.fileContent !== undefined) {
                let result = await webui.proxy.worker.send('processFileDiff', data);
                t._viewOld.setLines(result.old);
                t._viewNew.setLines(result.new);
            }
            t._fileName.innerHTML = changeDetail.display;
        },
        async loadRepoChanges() {
            let t = this;
            t._filesContainer.innerText = '';
            let repo = t._repos.value;
            if (repo === undefined) return;
            let changes = await webui.proxy.git.getChanges(repo);
            t._fileName.innerHTML = '';
            await customElements.whenDefined('webui-canvas');
            t._viewOld.setLines([]);
            t._viewNew.setLines([]);
            let first = null;
            t._files = [];
            changes.forEach(fileName => {
                let changeDetail = fileName.trim().split(' ');
                let changeType = changeDetail[0];
                let theme = "info";
                switch (changeType) {
                    case 'M':
                        changeType = 'Modify';
                        break;
                    case 'D':
                        changeType = 'Delete';
                        theme = 'danger';
                        break;
                    case '??':
                        changeType = 'Add';
                        theme = 'success';
                        break;
                }
                let display = changeDetail[1].split('/');
                display = display[display.length - 1];
                let details = {
                    repo: repo,
                    change: changeType,
                    fileName: changeDetail[1],
                    display: `<span class="change-type">${changeType}</span> <strong>${display}</strong>`,
                    isIncluded: true,
                };
                t._files.push(details);
                let btn = webui.create('webui-button', { label: details.display, title: details.fileName, align: 'left', theme: theme });
                let options = [
                    { value: '1', display: `Include` },
                    { value: '0', display: `Exclude` },
                    { value: '2', display: `Ignore` }
                ];
                let include = webui.create('webui-dropdown', {});
                t._filesContainer.appendChild(include);
                t._filesContainer.appendChild(btn);
                include.setOptions(options);
                const fullPath = `${details.repo}/${details.fileName}`;
                function setTheme() {
                    switch (include.value) {
                        case '0':
                            include.setAttribute('theme', 'info');
                            details.isIncluded = false;
                            break;
                        case '2':
                            include.setAttribute('theme', 'warning');
                            details.isIncluded = false;
                            break;
                        default:
                            details.isIncluded = true;
                            include.setAttribute('theme', 'success');
                            break;
                    }
                }
                include.addEventListener('change', _ => {
                    if (include.value === '2') {
                        if (!webui.projectData.data.gitIgnoreFiles) {
                            webui.projectData.data.gitIgnoreFiles = [];
                        }
                        if (webui.projectData.data.gitIgnoreFiles.indexOf(fullPath) === -1) {
                            webui.projectData.data.gitIgnoreFiles.push(fullPath);
                        }
                    } else if (webui.projectData.data.gitIgnoreFiles && webui.projectData.data.gitIgnoreFiles.indexOf(fullPath) !== -1) {
                        webui.projectData.data.gitIgnoreFiles.splice(webui.projectData.data.gitIgnoreFiles.indexOf(fullPath), 1);
                    }
                    webui.proxy.syncProjectData();
                    setTheme();
                });
                if (webui.projectData.data.gitIgnoreFiles && webui.projectData.data.gitIgnoreFiles.indexOf(fullPath) !== -1) {
                    include.value = 2;
                }
                setTheme();
                btn.addEventListener('click', _ => {
                    t.loadFileDiff(details);
                });
                if (!first) {
                    first = true;
                    t.loadFileDiff(details);
                }
                t.loadRemoteStatus();
            });
        },
        setAlert(msg, severity) {
            let t = this;
            t._alert.setValue(!msg ? null : { theme: severity, html: msg });
        },
        connected() {
            const t = this;
            webui.proxy.projects.runWhenLoaded(() => {
                t.loadRepos();
            });
            t._repos.addEventListener('change', async _ => {
                webui.projectData.data.selectedGitRepo = t._repos.value;
                await t.loadBranches();
                t.loadRepoChanges();
                if (t._remoteStatusContainer.innerHTML !== '') t.loadRemoteStatus();
            });
            t._branches.addEventListener('change', async _ => {
                if (t._isSwitchingBranch) return;
                t.setAlert();
                let repo = t._repos.value;
                let targetBranch = t._branches.value;
                if (!repo || !targetBranch) return;
                let result = await webui.proxy.git.switchBranch(repo, targetBranch, msg => {
                    t.setAlert(msg);
                    t.loadBranches();
                });
                if (result) {
                    t.setAlert(result, 'success');
                    t.loadRepoChanges();
                    if (t._remoteStatusContainer.innerHTML !== '') t.loadRemoteStatus();
                }
            });
            t._btnFetch.addEventListener('click', async _ => {
                let repo = t._repos.value;
                if (!repo) return t.setAlert('No repo is set!');
                t.setAlert('Fetching updates from remote...', 'info');
                let result = await webui.proxy.git.fetch(repo, msg => t.setAlert(msg));
                if (result) {
                    t.setAlert(result, 'success');
                    await t.loadRemoteStatus();
                }
            });
            t._btnRemoteTab.addEventListener('click', _ => {
                t.loadRemoteStatus();
            });
            t._btnCreateBranch.addEventListener('click', async _ => {
                let repo = t._repos.value;
                if (repo === undefined) return t.setAlert('No repo is set!');
                await webui.dialog({
                    title: 'Create New Branch',
                    content: `<webui-flex column><webui-input-text name="branchName" label="Branch Name"></webui-input-text></webui-flex>`,
                    confirm: 'Create',
                    cancel: 'Cancel',
                    onconfirm: async (data, content) => {
                        let branchName = Object.fromEntries(data).branchName.trim();
                        if (!branchName) return content.alert('Branch name cannot be empty.');
                        let result = await webui.proxy.git.createBranch(repo, branchName, msg => content.alert(msg));
                        if (result) {
                            t.setAlert(result, 'success');
                            await t.loadBranches();
                            t.loadRepoChanges();
                            return true;
                        }
                    }
                });
            });
            t._btnDeleteBranch.addEventListener('click', async _ => {
                let repo = t._repos.value;
                if (repo === undefined) return t.setAlert('No repo is set!');
                let branchOptions = (t._branchList || []).filter(b => b !== t._branches.value)
                    .map(b => ({ id: b, value: b, display: b }));
                let dpId = `dp-delete-${webui.uuid()}`;
                setTimeout(async () => {
                    let dp = document.getElementById(dpId);
                    if (dp) {
                        await customElements.whenDefined('webui-dropdown');
                        dp.setOptions(branchOptions);
                        if(branchOptions.length > 0) dp.value = branchOptions[0].value;
                    }
                }, 50);
                await webui.dialog({
                    title: 'Delete Branch',
                    content: `
                        <webui-flex column>
                            <label>Select branch to delete:</label>
                            <webui-dropdown id="${dpId}" name="branchName" style="margin-top: 0.5rem;"></webui-dropdown>
                        </webui-flex>`,
                    confirm: 'Delete',
                    cancel: 'Cancel',
                    onconfirm: async (data, content) => {
                        let branchName = Object.fromEntries(data).branchName;
                        if (!branchName) return content.alert('No branch selected.');
                        let result = await webui.proxy.git.deleteBranch(repo, branchName, msg => content.alert(msg));
                        if (result) {
                            t.setAlert(result, 'success');
                            await t.loadBranches();
                            return true;
                        }
                    }
                });
            });
            t._btnMergeBranch.addEventListener('click', async _ => {
                let repo = t._repos.value;
                if (repo === undefined) return t.setAlert('No repo is set!');
                let branchOptions = (t._branchList || []).filter(b => b !== t._branches.value)
                    .map(b => ({ id: b, value: b, display: b }));
                let dpId = `dp-merge-${webui.uuid()}`;
                setTimeout(async () => {
                    let dp = document.getElementById(dpId);
                    if (dp) {
                        await customElements.whenDefined('webui-dropdown');
                        dp.setOptions(branchOptions);
                        if(branchOptions.length > 0) dp.value = branchOptions[0].value;
                    }
                }, 50);
                await webui.dialog({
                    title: 'Merge Branch',
                    content: `
                        <webui-flex column>
                            <label>Select branch to merge into current (${t._branches.value}):</label>
                            <webui-dropdown id="${dpId}" name="branchName" style="margin-top: 0.5rem;"></webui-dropdown>
                        </webui-flex>`,
                    confirm: 'Merge',
                    cancel: 'Cancel',
                    onconfirm: async (data, content) => {
                        let branchName = Object.fromEntries(data).branchName;
                        if (!branchName) return content.alert('No branch selected.');
                        let result = await webui.proxy.git.mergeBranch(repo, branchName, msg => content.alert(msg));
                        if (result) {
                            t.setAlert(result, 'success');
                            await t.loadBranches();
                            t.loadRepoChanges();
                            return true;
                        }
                    }
                });
            });
            t._viewNew.addEventListener('change', _ => {
                if (typeof t._viewNew.getScroll !== 'function' || typeof t._viewOld.setScroll !== 'function') return;
                if (t._viewOld.getScroll() === t._viewNew.getScroll()) return;
                t._viewOld.setScroll(t._viewNew.getScroll());
            });
            t._viewOld.addEventListener('change', _ => {
                if (typeof t._viewOld.getScroll !== 'function' || typeof t._viewNew.setScroll !== 'function') return;
                if (t._viewOld.getScroll() === t._viewNew.getScroll()) return;
                t._viewNew.setScroll(t._viewOld.getScroll());
            });
            t._btnCommit.addEventListener('click', async _ => {
                let message = t._message.value.trim();
                t.setAlert();
                if (!message) {
                    t.setAlert('You forgot to set your message!');
                    return;
                }
                let files = [];
                t._files.forEach(item => {
                    if (item.isIncluded) {
                        files.push(item.fileName);
                    }
                });
                if (files.length === 0) {
                    t.setAlert('There are no files to commit!');
                    return;
                }
                let repo = t._repos.value;
                if (repo === undefined) {
                    t.setAlert('No repo is set!');
                    return;
                }
                let result = await webui.proxy.git.commit(repo, files, message, msg => t.setAlert(msg));
                if (result) {
                    t.setAlert(result, 'success');
                }
                t.loadRepoChanges();
            });
            t._btnPull.addEventListener('click', async _ => {
                t.setAlert();
                let repo = t._repos.value;
                if (repo === undefined) {
                    t.setAlert('No repo is set!');
                    return;
                }
                let result = await webui.proxy.git.pull(repo, msg => t.setAlert(msg));
                if (result) {
                    t.setAlert(result, 'success');
                }
                t.loadRepoChanges();
            });
            t._btnRefresh.addEventListener('click', async _ => {
                t.loadRepos();
                t.loadRemoteStatus();
            });
            t._btnPush.addEventListener('click', async _ => {
                t.setAlert();
                let repo = t._repos.value;
                if (repo === undefined) {
                    t.setAlert('No repo is set!');
                    return;
                }
                let result = await webui.proxy.git.push(repo, msg => t.setAlert(msg));
                if (result) {
                    t.setAlert(result, 'success');
                }
                t.loadRemoteStatus();
            });
            t._btnSync.addEventListener('click', async _ => {
                t.setAlert();
                let repo = t._repos.value;
                if (repo === undefined) {
                    t.setAlert('No repo is set!');
                    return;
                }
                let result = await webui.proxy.git.sync(repo, msg => t.setAlert(msg));
                if (result) {
                    t.setAlert(result, 'success');
                }
                t.loadRepoChanges();
            });
            t._instructions.innerHTML = webui.parseMarkdown(`
Select which files you want to commit, create your commit message, and press Commit to save your current changes.

### File Options

- <webui-button theme="success">Include</webui-button> *Default* Include file with commit.
- <webui-button theme="info">Exclude</webui-button> Exclude file from current commit.
- <webui-button theme="warning">Ignore</webui-button> Always exclude file from commits.
`)
        },
        disconnected() { },
        shadowTemplate: `
<style type="text/css">
:host {
    display: flex;
    flex-direction: column;
    gap: var(--padding);
}
pre {
    margin:0;
    padding:0;
}
</style>
<webui-flex align="center">
    <webui-button theme="info" label="Refresh"></webui-button>
    <webui-dropdown class="hidden" label="Repo"></webui-dropdown>
</webui-flex>
<webui-alert></webui-alert>
<webui-tabs theme="secondary" index="0" transition-timing="200">
    <webui-button slot="tabs">Commit</webui-button>
    <webui-content slot="content" nodetach>
        <webui-flex justify="flex-end" style="margin-bottom: var(--padding);">
            <webui-button theme="primary" label="Commit"></webui-button>
        </webui-flex>
        <webui-grid columns="2fr 3fr" gap="var(--padding)">
            <webui-quote theme="title" class="instructions"></webui-quote>
            <webui-input-message class="h-fill" theme="title" label="Commit Message"></webui-input-message>
        </webui-grid>
        <webui-grid columns="max-content 1fr" gap="var(--padding)" style="margin-top: var(--padding);">
            <webui-grid columns="max-content 1fr" class="files"></webui-grid>
            <webui-flex column>
                <h3></h3>
                <webui-grid columns="1fr 1fr">
                    <webui-canvas height="60vh" theme="black" line-numbers class="view-old" data-subscribe="git-canvas-scroll:setScroll" data-trigger="git-canvas-scroll:getScroll"></webui-canvas>
                    <webui-canvas height="60vh" theme="black" line-numbers class="view-new" data-subscribe="git-canvas-scroll:setScroll" data-trigger="git-canvas-scroll:getScroll"></webui-canvas>
                    <webui-grid gap="0" columns="max-content 1fr" class="view-olds"></webui-grid>
                    <webui-grid gap="0" columns="max-content 1fr" class="view-news"></webui-grid>
                </webui-grid>
            </webui-flex>
        </webui-grid>
    </webui-content>
    <webui-button slot="tabs">Branches</webui-button>
    <webui-content slot="content" nodetach>
        <webui-flex gap="var(--padding)" align="center" style="margin-top: var(--padding);">
            <webui-dropdown class="hidden" label="Branch"></webui-dropdown>
            <webui-button theme="secondary" label="New Branch"></webui-button>
            <webui-button theme="warning" label="Merge"></webui-button>
            <webui-button theme="danger" label="Delete"></webui-button>
        </webui-flex>
    </webui-content>
    <webui-button slot="tabs" id="tab-remote">Remote</webui-button>
    <webui-content slot="content" nodetach>
        <webui-flex column gap="var(--padding)" style="margin-top: var(--padding);">
            <div id="remote-status-container" style="padding: var(--padding); background: var(--site-background-color); color: var(--site-background-offset); border: 1px solid var(--color-info); border-radius: 4px;">
                <!-- Dynamically populated -->
            </div>
            <webui-flex gap="var(--padding)" align="center">
                <webui-button theme="info" label="Fetch" id="btn-fetch"></webui-button>
                <webui-button theme="tertiary" label="Pull"></webui-button>
                <webui-button theme="secondary" label="Push"></webui-button>
                <webui-button theme="success" label="Sync"></webui-button>
            </webui-flex>
        </webui-flex>
    </webui-content>
</webui-tabs>
`
    });
}