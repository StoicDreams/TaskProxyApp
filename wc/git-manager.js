"use strict"
{
    webui.define("app-git-manager", {
        linkCss: true,
        watchVisibility: false,
        isInput: false,
        preload: 'tabs table',
        constructor() {
            const t = this;
            t._repos = t.template.querySelector('webui-dropdown[label="Repo"]');
            t._fileName = t.template.querySelector('h3');
            t._filesContainer = t.template.querySelector('.files');
            t._diffViewer = t.template.querySelector('webui-content-compare');
            t._message = t.template.querySelector('webui-input-message[label="Commit Message"]');
            t._alert = t.template.querySelector('webui-alert');
            t._btnRefresh = t.template.querySelector('webui-button[label="Refresh"]');
            t._btnRevertAll = t.template.querySelector('#btn-revert-all');
            t._btnStash = t.template.querySelector('#btn-stash');
            t._btnStashPop = t.template.querySelector('#btn-stash-pop');
            t._btnCommit = t.template.querySelector('webui-button[label="Commit"]');
            t._toggleSync = t.template.querySelector('#toggle-sync');
            t._btnSync = t.template.querySelector('webui-button[label="Sync"]');
            t._btnPush = t.template.querySelector('webui-button[label="Push"]');
            t._btnPull = t.template.querySelector('webui-button[label="Pull"]');
            t._btnFetch = t.template.querySelector('#btn-fetch');
            t._instructions = t.template.querySelector('.instructions');
            t._btnRemoteTab = t.template.querySelector('#tab-remote');
            t._remoteStatusContainer = t.template.querySelector('#remote-status-container');
            t._branchTable = t.template.querySelector('#branch-table');
            t._hasPendingChanges = false;
            t._branchList = [];
            t._currentBranch = '';
        },
        async loadRepos() {
            let t = this;
            let repos = await webui.proxy.git.getRepos();
            if (repos.length === 0) {
                t._repos.classList.add('hidden');
                webui.setData('git-branches', []);
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
                t._branchList = branchInfo.branches;
                t._currentBranch = branchInfo.currentBranch;
            } else {
                t._branchList = [];
                t._currentBranch = '';
            }
            t.renderBranchesTable();
        },
        renderBranchesTable() {
            let t = this;
            if (!t._branchTable) return;
            let tableData = (t._branchList || []).map(b => {
                let isCurrent = b.isCurrent;
                return {
                    ...b,
                    nameHtml: `${isCurrent ? '<webui-icon icon="star|fill|theme:warning" style="margin-right: 0.5rem;"></webui-icon>' : ''}${b.name}`,
                    actionsHtml: `
                        <webui-flex gap="0.5rem" justify="right" align="center">
                            ${!isCurrent ? `<webui-button theme="info" class="btn-switch" data-branch="${b.name}" style="padding: 0.25rem 0.5rem; min-height: unset; font-size: 0.85rem;">Switch</webui-button>` : `<span style="padding: 0.25rem 0.5rem; font-size: 0.85rem; color: var(--color-success); font-weight: bold;">Active</span>`}
                            <webui-button theme="secondary" class="btn-new" data-branch="${b.name}" style="padding: 0.25rem 0.5rem; min-height: unset; font-size: 0.85rem;">New</webui-button>
                            ${!isCurrent ? `<webui-button theme="warning" class="btn-merge" data-branch="${b.name}" style="padding: 0.25rem 0.5rem; min-height: unset; font-size: 0.85rem;">Merge</webui-button>` : ''}
                            ${!isCurrent ? `<webui-button theme="danger" class="btn-delete" data-branch="${b.name}" style="padding: 0.25rem 0.5rem; min-height: unset; font-size: 0.85rem;">Delete</webui-button>` : ''}
                        </webui-flex>
                    `
                };
            });
            webui.setData('git-branches', tableData);
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
            await customElements.whenDefined('webui-content-compare');
            t._fileName.innerHTML = `<em>Loading</em> ${changeDetail.display}`;
            t._diffViewer.clear?.();
            if (changeDetail.fileName.endsWith('/')) {
                return;
            }
            let data = { change: changeDetail.change, isCompare: false };
            let fullFilePath = changeDetail.repo === '' ? changeDetail.fileName : `${changeDetail.repo}/${changeDetail.fileName}`;
            data.fileDiff = changeDetail.change !== 'Add' ? await webui.proxy.git.getFileDiff(changeDetail.repo, changeDetail.fileName) : '';
            data.isCompare = data.fileDiff !== undefined && changeDetail.change !== 'Add' && changeDetail.change !== 'Delete';
            if (changeDetail.change === 'Delete') {
                if (data.fileDiff) {
                    let lines = data.fileDiff.split('\n');
                    let contentLines = [];
                    let inDiff = false;
                    for (let line of lines) {
                        if (line.startsWith('@@')) {
                            inDiff = true;
                            continue;
                        }
                        if (inDiff) {
                            if (line.startsWith('-') || line.startsWith(' ')) {
                                contentLines.push(line.substring(1));
                            }
                        }
                    }
                    data.fileContent = contentLines.join('\n');
                } else {
                    data.fileContent = '';
                }
            } else {
                data.fileContent = await webui.proxy.getProjectFile(fullFilePath);
            }
            if (data.fileContent !== undefined) {
                let result = await webui.proxy.worker.send('processFileDiff', data);
                if (typeof t._diffViewer.setDiff !== 'function') {
                    customElements.upgrade(t._diffViewer);
                }
                t._diffViewer.setDiff?.(result.old, result.new, changeDetail.change);
            }
            t._fileName.innerHTML = changeDetail.display;
        },
        async loadRepoChanges() {
            let t = this;
            t._filesContainer.innerText = '';
            let repo = t._repos.value;
            if (repo === undefined) return;
            let changes = await webui.proxy.git.getChanges(repo);
            t._hasPendingChanges = changes && changes.length > 0;
            t._fileName.innerHTML = '';
            await customElements.whenDefined('webui-content-compare');
            t._diffViewer.clear?.();
            let first = null;
            t._files = [];
            changes.forEach(line => {
                if (!line || line.length < 3) return;
                let status = line.substring(0, 2);
                let filePath = line.substring(3).trim();
                if (filePath.includes(' -> ')) {
                    filePath = filePath.split(' -> ')[1];
                }
                let changeType = 'Modify';
                let theme = 'info';
                if (status === '??' || status.includes('A')) {
                    changeType = 'Add';
                    theme = 'success';
                } else if (status.includes('D')) {
                    changeType = 'Delete';
                    theme = 'danger';
                }
                let displayParts = filePath.split('/');
                let display = displayParts[displayParts.length - 1];
                let details = {
                    repo: repo,
                    change: changeType,
                    fileName: filePath,
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
                let btnRevert = webui.create('webui-button', { theme: 'danger', title: 'Revert changes to this file' });
                btnRevert.innerHTML = `<webui-icon icon="emoji-wastebasket"></webui-icon>`;
                btnRevert.style.padding = "0 0.5rem";
                t._filesContainer.appendChild(include);
                t._filesContainer.appendChild(btn);
                t._filesContainer.appendChild(btnRevert);
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
                btnRevert.addEventListener('click', async _ => {
                    await webui.dialog({
                        title: 'Revert File',
                        content: `<p>Are you sure you want to discard all uncommitted changes in <strong>${display}</strong>?</p><p style="color: var(--color-danger);">This action cannot be undone.</p>`,
                        confirm: 'Revert',
                        cancel: 'Cancel',
                        onconfirm: async (data, content) => {
                            let result = await webui.proxy.git.restoreFile(repo, details.fileName, msg => content.alert(msg));
                            if (result) {
                                t.setAlert(result, 'success');
                                t.loadRepoChanges();
                                return true;
                            }
                        }
                    });
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
            });
            t.loadRemoteStatus();
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
            t._branchTable.addEventListener('click', async ev => {
                let btn = webui.closest(ev, 'webui-button');
                if (!btn) return;
                let targetBranch = btn.getAttribute('data-branch');
                if (!targetBranch) return;
                let repo = t._repos.value;
                if (btn.classList.contains('btn-switch') || btn.classList.contains('btn-new')) {
                    if (t._hasPendingChanges) {
                        t.setAlert('Cannot change branches with uncommitted changes. Please commit or stash your changes first.', 'warning');
                        return;
                    }
                }
                if (btn.classList.contains('btn-switch')) {
                    t.setAlert();
                    let result = await webui.proxy.git.switchBranch(repo, targetBranch, msg => {
                        t.setAlert(msg);
                        t.loadBranches();
                    });
                    if (result) {
                        t.setAlert(result, 'success');
                        t.loadRepoChanges();
                        if (t._remoteStatusContainer.innerHTML !== '') t.loadRemoteStatus();
                    }
                } else if (btn.classList.contains('btn-new')) {
                    await webui.dialog({
                        title: `Create New Branch from '${targetBranch}'`,
                        content: `<webui-flex column><webui-input-text name="branchName" label="New Branch Name"></webui-input-text></webui-flex>`,
                        confirm: 'Create',
                        cancel: 'Cancel',
                        onconfirm: async (data, content) => {
                            let formData = Object.fromEntries(data);
                            let inputEl = content.querySelector('[name="branchName"]');
                            let branchName = (formData.branchName || (inputEl ? inputEl.value : '')).trim();
                            if (!branchName) return content.alert('Branch name cannot be empty.');
                            let result = await webui.proxy.git.createBranch(repo, branchName, targetBranch, msg => content.alert(msg));
                            if (result) {
                                t.setAlert(result, 'success');
                                await t.loadBranches();
                                return true;
                            }
                        }
                    });
                } else if (btn.classList.contains('btn-merge')) {
                    await webui.dialog({
                        title: 'Merge Branch',
                        content: `<p>Are you sure you want to merge <strong>${targetBranch}</strong> into the current branch (<strong>${t._currentBranch}</strong>)?</p>`,
                        confirm: 'Merge',
                        cancel: 'Cancel',
                        onconfirm: async (data, content) => {
                            let result = await webui.proxy.git.mergeBranch(repo, targetBranch, msg => content.alert(msg));
                            if (result) {
                                t.setAlert(result, 'success');
                                await t.loadBranches();
                                t.loadRepoChanges();
                                return true;
                            }
                        }
                    });
                } else if (btn.classList.contains('btn-delete')) {
                    await webui.dialog({
                        title: 'Delete Branch',
                        content: `<p>Are you sure you want to delete the branch <strong>${targetBranch}</strong>?</p>`,
                        confirm: 'Delete',
                        cancel: 'Cancel',
                        onconfirm: async (data, content) => {
                            let result = await webui.proxy.git.deleteBranch(repo, targetBranch, msg => content.alert(msg));
                            if (result) {
                                t.setAlert(result, 'success');
                                await t.loadBranches();
                                return true;
                            }
                        }
                    });
                }
            });
            t._btnRevertAll.addEventListener('click', async _ => {
                let repo = t._repos.value;
                if (repo === undefined) return t.setAlert('No repo is set!');
                if (!t._hasPendingChanges) return t.setAlert('No pending changes to revert.', 'info');
                await webui.dialog({
                    title: 'Revert All Changes',
                    content: `
                        <p>Are you sure you want to discard <strong>all</strong> uncommitted changes in this repository?</p>
                        <p style="color: var(--color-danger); font-weight: bold;">This action cannot be undone. All modified tracked files and untracked additions will be deleted.</p>
                    `,
                    confirm: 'Revert All',
                    cancel: 'Cancel',
                    onconfirm: async (data, content) => {
                        let result = await webui.proxy.git.restoreAll(repo, msg => content.alert(msg));
                        if (result) {
                            t.setAlert(result, 'success');
                            await t.loadRepoChanges();
                            return true;
                        }
                    }
                });
            });
            t._btnStash.addEventListener('click', async _ => {
                let repo = t._repos.value;
                if (repo === undefined) return t.setAlert('No repo is set!');
                if (!t._hasPendingChanges) return t.setAlert('No pending changes to stash.', 'info');
                t.setAlert('Stashing changes...', 'info');
                let message = t._message.value.trim() || '';
                let result = await webui.proxy.git.stash(repo, message, msg => t.setAlert(msg));
                if (result) {
                    t.setAlert(result, 'success');
                    t._message.value = '';
                    await t.loadRepoChanges();
                }
            });
            t._btnStashPop.addEventListener('click', async _ => {
                let repo = t._repos.value;
                if (repo === undefined) return t.setAlert('No repo is set!');
                t.setAlert('Popping stash...', 'info');
                let result = await webui.proxy.git.stashPop(repo, msg => t.setAlert(msg));
                if (result) {
                    t.setAlert(result, 'success');
                    await t.loadRepoChanges();
                }
            });
            t._btnFetch.addEventListener('click', async _ => {
                let repo = t._repos.value;
                if (repo === undefined) return t.setAlert('No repo is set!');
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
                    t._message.value = '';
                    if (t._toggleSync.value === true || t._toggleSync.value === 'true') {
                        t.setAlert('Commit successful. Syncing with remote...', 'info');
                        let syncResult = await webui.proxy.git.sync(repo, msg => t.setAlert(msg));
                        if (syncResult) {
                            t.setAlert('Commit and Sync successful!', 'success');
                        }
                    }
                }
                t.loadRepoChanges();
                if (t._remoteStatusContainer.innerHTML !== '') t.loadRemoteStatus();
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
    <webui-flex align="center" gap="0.5rem" style="margin-left: auto;">
        <webui-button id="btn-revert-all" theme="danger" label="Revert All"></webui-button>
        <webui-button id="btn-stash" theme="warning" label="Stash"></webui-button>
        <webui-button id="btn-stash-pop" theme="secondary" label="Pop Stash"></webui-button>
    </webui-flex>
</webui-flex>
<webui-alert></webui-alert>
<webui-tabs theme="secondary" index="0" transition-timing="200">
    <webui-button slot="tabs">Commit</webui-button>
    <webui-content slot="content" nodetach>
        <webui-flex justify="flex-end" align="center" gap="var(--padding)" style="margin-bottom: var(--padding);">
            <webui-toggle-icon id="toggle-sync" label="Sync after commit" data-bind="app-git-autosync" data-default="true" theme-on="primary"></webui-toggle-icon>
            <webui-button theme="primary" label="Commit"></webui-button>
        </webui-flex>
        <webui-grid columns="2fr 3fr" gap="var(--padding)">
            <webui-quote theme="title" class="instructions"></webui-quote>
            <webui-input-message class="h-fill" theme="title" label="Commit Message"></webui-input-message>
        </webui-grid>
        <webui-grid columns="max-content 1fr" gap="var(--padding)" style="margin-top: var(--padding);">
            <webui-grid columns="max-content 1fr max-content" style="--min:3ch;" class="files"></webui-grid>
            <webui-flex column>
                <h3></h3>
                <webui-content-compare style="height: 60vh;"></webui-content-compare>
            </webui-flex>
        </webui-grid>
    </webui-content>
    <webui-button slot="tabs">Branches</webui-button>
    <webui-content slot="content" nodetach>
        <div style="margin-top: var(--padding); overflow-x: auto;">
            <webui-table
                id="branch-table"
                theme="secondary"
                columns="Branch|nameHtml;Created|createdDate;Updated|updatedDate;:Actions:|actionsHtml"
                column-formats="nameHtml:html;actionsHtml:html"
                sortable="nameHtml;createdDate;updatedDate"
                data-subscribe="git-branches:setData"
                bordered>
            </webui-table>
        </div>
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
