"use strict"
{
    const autoFetchInterval = 60000;
    /** Stored with the project's data, since only fields known to the backend are saved. */
    function getIgnoredFiles() {
        webui.projectData.data._gitIgnoreFiles ??= [];
        return webui.projectData.data._gitIgnoreFiles;
    }
    /** Unsent commit messages by repo, kept with the project's local data so switching projects keeps each one. */
    function getCommitMessages() {
        webui.projectData.data._gitCommitMessages ??= {};
        return webui.projectData.data._gitCommitMessages;
    }
    const messageSyncDelay = 500;
    const minPanesHeight = 360;
    const includeStates = { include: '1', exclude: '0', ignore: '2' };
    const includeTitle = 'Include: commit this file. Exclude: leave it out of this commit. Ignore: always leave it out.';
    const changeClasses = { Modify: 'modify', Add: 'add', Delete: 'delete', Conflict: 'conflict' };
    /**
     * Waits for a Web UI element's definition. Elements in a template that has not joined the page yet
     * do not upgrade when the definition arrives, so upgrade them directly.
     */
    async function whenReady(el) {
        await customElements.whenDefined(el.localName);
        if (!customElements.get(el.localName) || el instanceof customElements.get(el.localName)) return el;
        customElements.upgrade(el);
        return el;
    }
    /** The element that scrolls the page, which the commit panes are sized to fit. */
    function findScroller(el) {
        let node = el.assignedSlot || el.parentElement || el.getRootNode().host;
        while (node && node !== document.documentElement) {
            const overflow = getComputedStyle(node).overflowY;
            if (overflow === 'auto' || overflow === 'scroll') return node;
            node = node.assignedSlot || node.parentElement || node.getRootNode().host;
        }
        return null;
    }
    /** Parses one `git status` style line from the backend into what the file list shows. */
    function parseChange(line, repo) {
        let status = line.substring(0, 2);
        let fileName = line.substring(3).trim();
        if (status.includes('R') && fileName.includes(' -> ')) {
            fileName = fileName.split(' -> ')[1];
        }
        let change = 'Modify';
        if (status.includes('C')) {
            change = 'Conflict';
        } else if (status === '??' || status.includes('A')) {
            change = 'Add';
        } else if (status.includes('D')) {
            change = 'Delete';
        }
        const trimmed = fileName.endsWith('/') ? fileName.slice(0, -1) : fileName;
        const slash = trimmed.lastIndexOf('/');
        const name = trimmed.substring(slash + 1) + (fileName.endsWith('/') ? '/' : '');
        const folder = slash === -1 ? '' : trimmed.substring(0, slash);
        return {
            repo,
            change,
            fileName,
            name,
            folder,
            display: `<span class="change-type">${change}</span> <strong>${webui.escapeForHTML(name)}</strong>${folder ? ` <span class="folder">${webui.escapeForHTML(folder)}</span>` : ''}`,
            isIncluded: true,
            state: includeStates.include,
        };
    }
    /** A theme color as text on the page is hard to read, so status text shows on the color, in its paired text color. */
    function badge(theme, html) {
        return `<span class="badge" style="background: var(--color-${theme}); color: var(--color-${theme}-offset);">${html}</span>`;
    }
    /** A warning in a dialog, shown on the danger color so it is easy to read. */
    function dangerNote(html, bold) {
        return `<p style="background: var(--color-danger); color: var(--color-danger-offset); padding: 0.25em 0.5em; border-radius: var(--corners);${bold ? ' font-weight: bold;' : ''}">${html}</p>`;
    }
    function rowHtml(details, index) {
        const isNew = details.change === 'Add';
        const options = [[includeStates.include, 'Include'], [includeStates.exclude, 'Exclude'], [includeStates.ignore, 'Ignore']]
            .map(([value, label]) => `<option value="${value}"${value === details.state ? ' selected' : ''}>${label}</option>`).join('');
        const path = webui.escapeForHTML(details.fileName);
        return `<div class="file-row ${changeClasses[details.change]}" data-index="${index}" data-path="${path}">`
            + `<select class="include" data-state="${details.state}" title="${includeTitle}" aria-label="Include ${path}">${options}</select>`
            + `<button type="button" class="file" title="${path}"><span class="change-type">${details.change}</span> <strong class="name">${webui.escapeForHTML(details.name)}</strong>`
            + (details.folder ? ` <span class="folder">${webui.escapeForHTML(details.folder)}</span>` : '')
            + `</button>`
            + `<button type="button" class="revert" title="${isNew ? 'Delete new file' : 'Revert changes to this file'}" aria-label="${isNew ? 'Delete' : 'Revert'} ${path}">🗑️</button>`
            + `</div>`;
    }
    webui.define("app-git-manager", {
        linkCss: true,
        watchVisibility: false,
        isInput: false,
        preload: 'tabs table dropdown input-message input-text toggle-icon alert content-compare file-preview',
        constructor() {
            const t = this;
            t._repos = t.template.querySelector('webui-dropdown[label="Repo"]');
            t._fileName = t.template.querySelector('.preview h2');
            t._filesContainer = t.template.querySelector('.files');
            t._diffViewer = t.template.querySelector('webui-content-compare');
            t._filePreview = t.template.querySelector('webui-file-preview');
            t._previewPane = t.template.querySelector('.preview');
            t._message = t.template.querySelector('webui-input-message[label="Commit Message"]');
            t._alert = t.template.querySelector('webui-alert');
            t._btnRefresh = t.template.querySelector('webui-button[label="Refresh"]');
            t._btnRevertAll = t.template.querySelector('#btn-revert-all');
            t._btnStash = t.template.querySelector('#btn-stash');
            t._btnStashPop = t.template.querySelector('#btn-stash-pop');
            t._btnCommit = t.template.querySelector('webui-button[label="Commit"]');
            t._btnToggleAll = t.template.querySelector('webui-button[label="Toggle All"]');
            t._toggleSync = t.template.querySelector('#toggle-sync');
            t._btnSync = t.template.querySelector('webui-button[label="Sync"]');
            t._btnPush = t.template.querySelector('webui-button[label="Push"]');
            t._btnPull = t.template.querySelector('webui-button[label="Pull"]');
            t._btnPullOverwrite = t.template.querySelector('#btn-pull-overwrite');
            t._btnFetch = t.template.querySelector('#btn-fetch');
            t._panes = t.template.querySelector('.commit-panes');
            t._fileFilter = t.template.querySelector('.file-filter');
            t._remoteStatusContainer = t.template.querySelector('#remote-status-container');
            t._valRemoteUrl = t.template.querySelector('#val-remote-url');
            t._valTrackingBranch = t.template.querySelector('#val-tracking-branch');
            t._valSyncStatus = t.template.querySelector('#val-sync-status');
            t._valCommitFiles = t.template.querySelector('#val-commit-files');
            t._valCommitLines = t.template.querySelector('#val-commit-lines');
            t._lineStats = new Map();
            t._branchTable = t.template.querySelector('#branch-table');
            t._inputPat = t.template.querySelector('#input-git-pat');
            t._dropdownPatScope = t.template.querySelector('#dropdown-pat-scope');
            t._btnSavePat = t.template.querySelector('#btn-save-pat');
            t._hasPendingChanges = false;
            t._branchList = [];
            t._currentBranch = '';
        },
        /** Shows the message saved for the selected repo, and makes it the one that edits are saved to. */
        async restoreMessage() {
            const t = this;
            const repo = t._repos.value;
            t._messageRepo = repo;
            t._messagePath = webui.projectData.path;
            await customElements.whenDefined('webui-input-message');
            t._message.value = (repo !== undefined && getCommitMessages()[repo]) || '';
        },
        rememberMessage(value) {
            const t = this;
            // Only save into the project and repo the message was loaded for.
            if (t._messageRepo === undefined || webui.projectData.path !== t._messagePath) return;
            const messages = getCommitMessages();
            if (value) {
                messages[t._messageRepo] = value;
            } else {
                delete messages[t._messageRepo];
            }
            clearTimeout(t._messageSyncTimer);
            t._messageSyncTimer = setTimeout(() => webui.proxy.syncProjectData(), messageSyncDelay);
        },
        clearMessage() {
            const t = this;
            t._message.value = '';
            t.rememberMessage('');
        },
        async loadRepos() {
            let t = this;
            await whenProxyReady();
            let repos = await webui.proxy.git.getRepos() || [];
            if (repos.length === 0) {
                t._repos.classList.add('hidden');
                webui.setData('git-branches', []);
            } else {
                let options = repos.map(item => { return { id: item, value: item, display: item === '' ? 'Root' : item } });
                // On a slow load the dropdown definition can arrive after this component starts.
                await whenReady(t._repos);
                t._repos.setOptions(options);
                t._repos.classList.remove('hidden');
                let selectedGitRepo = webui.getProjectData('selectedGitRepo');
                if (selectedGitRepo) {
                    t._repos.value = selectedGitRepo;
                }
                await t.restoreMessage();
                await t.loadBranches();
                t.loadRepoChanges();
            }
        },
        async loadBranches() {
            let t = this;
            let repo = t._repos.value;
            if (repo === undefined) return;
            await whenProxyReady();
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
                // Branch names come from the remote, and can contain markup.
                let name = webui.escapeForHTML(b.name);
                return {
                    ...b,
                    nameHtml: `${isCurrent ? '<webui-icon icon="star|fill|theme:warning" style="margin-right: 0.5rem;"></webui-icon>' : ''}${name}`,
                    actionsHtml: `
                        <webui-flex gap="0.5rem" justify="right" align="center">
                            ${!isCurrent ? `<webui-button theme="info" class="btn-switch" data-branch="${b.name}" style="padding: 0.25rem 0.5rem; min-height: unset; font-size: 0.85rem;">Switch</webui-button>` : `<span class="badge" style="background: var(--color-success); color: var(--color-success-offset); font-size: 0.85rem; font-weight: bold;">Active</span>`}
                            <webui-button theme="secondary" class="btn-new" data-branch="${b.name}" style="padding: 0.25rem 0.5rem; min-height: unset; font-size: 0.85rem;">New</webui-button>
                            ${!isCurrent ? `<webui-button theme="warning" class="btn-merge" data-branch="${b.name}" style="padding: 0.25rem 0.5rem; min-height: unset; font-size: 0.85rem;">Merge</webui-button>` : ''}
                            ${!isCurrent ? `<webui-button theme="danger" class="btn-delete" data-branch="${b.name}" style="padding: 0.25rem 0.5rem; min-height: unset; font-size: 0.85rem;">Delete</webui-button>` : ''}
                        </webui-flex>
                    `
                };
            });
            webui.setData('git-branches', tableData);
        },
        loadExistingPat() {
            let t = this;
            let projPat = webui.projectData.data['git_pat'];
            let globPat = webui.taskProxyData.data['git_pat'];
            if (projPat) {
                t._inputPat.placeholder = projPat.length > 5 ? `${projPat.substring(0,3)}***${projPat.substring(projPat.length-3)}` : projPat;
                t._dropdownPatScope.value = 'Project';
            } else if (globPat) {
                t._inputPat.placeholder = globPat.length > 5 ? `${globPat.substring(0,3)}***${globPat.substring(globPat.length-3)}` : globPat;
                t._dropdownPatScope.value = 'Global';
            } else {
                t._inputPat.placeholder = undefined;
            }
        },
        /** Keep remote status current without a network call on every refresh. */
        async autoFetch(repo) {
            let t = this;
            t._lastFetch ??= {};
            if (Date.now() - (t._lastFetch[repo] || 0) < autoFetchInterval) return;
            t._lastFetch[repo] = Date.now();
            let result = await webui.proxy.git.fetchQuiet(repo);
            if (result && t._repos.value === repo) {
                t.loadRemoteStatus();
            }
        },
        /** Totals the files set to Include, so the counts match what Commit sends. */
        updateCommitStats() {
            const t = this;
            const files = t._files || [];
            if (files.length === 0) {
                t._valCommitFiles.textContent = 'No changes';
                t._valCommitLines.textContent = '';
                return;
            }
            const included = files.filter(f => f.isIncluded);
            t._valCommitFiles.textContent = `${included.length} of ${files.length}`;
            if (!t._lineStats) {
                t._valCommitLines.innerHTML = '<em>Unavailable</em>';
                return;
            }
            let additions = 0, deletions = 0, binary = 0;
            included.forEach(file => {
                const stats = t._lineStats.get(file.fileName);
                if (!stats) return;
                if (stats.binary) {
                    binary++;
                    return;
                }
                additions += stats.additions;
                deletions += stats.deletions;
            });
            const binaryNote = binary ? ` <span class="binary-note">(${binary} binary ${binary === 1 ? 'file' : 'files'} not counted)</span>` : '';
            t._valCommitLines.innerHTML = `${badge('success', `+${additions.toLocaleString()}`)} ${badge('danger', `-${deletions.toLocaleString()}`)}${binaryNote}`;
        },
        async loadRemoteStatus() {
            let t = this;
            let repo = t._repos.value;
            if (repo === undefined) return;
            t._valSyncStatus.innerHTML = '<em>Checking remote sync status...</em>';
            t.loadExistingPat();
            await whenProxyReady();
            let status = await webui.proxy.git.getRemoteStatus(repo, msg => t.setAlert(msg));
            if (!status) {
                t._valSyncStatus.innerHTML = badge('danger', '<em>Failed to retrieve remote status.</em>');
                return;
            }
            // A URL can hold a token, as in https://user:token@host.
            t._valRemoteUrl.textContent = (status.remoteUrl || 'No origin defined').replace(/\/\/[^/@]+@/, '//');
            if (status.hasUpstream) {
                t._valTrackingBranch.textContent = status.upstreamName;
                let syncHtml = '';
                if (status.ahead === 0 && status.behind === 0) {
                    syncHtml = badge('success', 'Up to date with remote');
                } else {
                    if (status.ahead > 0) syncHtml += `${badge('info', `${status.ahead} Commits Ahead (Pending Push)`)} `;
                    if (status.behind > 0) syncHtml += badge('warning', `${status.behind} Commits Behind (Pending Pull)`);
                }
                t._valSyncStatus.innerHTML = syncHtml;
            } else {
                t._valTrackingBranch.innerHTML = '<em>None</em>';
                t._valSyncStatus.innerHTML = badge('danger', 'No remote tracking branch set. Publish this branch to synchronize.');
            }
        },
        async loadFileDiff(changeDetail) {
            let t = this;
            const request = t._diffRequest = {};
            const showError = msg => t.setAlert(msg, 'warning');
            await customElements.whenDefined('webui-content-compare');
            t._fileName.innerHTML = `<em>Loading</em> ${changeDetail.display}`;
            t._diffViewer.clear?.();
            t.showFilePreview(false);
            if (changeDetail.fileName.endsWith('/')) {
                return;
            }
            await whenProxyReady();
            let data = { change: changeDetail.change, isCompare: false };
            let fullFilePath = changeDetail.repo === '' ? changeDetail.fileName : `${changeDetail.repo}/${changeDetail.fileName}`;
            data.fileDiff = changeDetail.change !== 'Add' ? await webui.proxy.git.getFileDiff(changeDetail.repo, changeDetail.fileName, showError) : '';
            if (t._diffRequest !== request) return;
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
                // Images and other files that are not text are shown as they are, rather than compared line by line.
                let isBinary = !!t._lineStats?.get(changeDetail.fileName)?.binary;
                if (!isBinary) {
                    let readError = null;
                    data.fileContent = await webui.proxy.getProjectFile(fullFilePath, err => { readError = `${err}`; });
                    if (t._diffRequest !== request) return;
                    // Git can call a file text that is not valid UTF-8, and only reading it shows that.
                    isBinary = data.fileContent === undefined && /UTF-8/i.test(readError || '');
                    if (readError && !isBinary) showError(readError);
                }
                if (isBinary) {
                    await t.loadFilePreview(changeDetail, fullFilePath, request);
                    return;
                }
            }
            if (data.fileContent !== undefined) {
                let result = await webui.proxy.worker.send('processFileDiff', data);
                if (t._diffRequest !== request) return;
                if (typeof t._diffViewer.setDiff !== 'function') {
                    customElements.upgrade(t._diffViewer);
                }
                t._diffViewer.setDiff?.(result.old, result.new, changeDetail.change);
            }
            t._fileName.innerHTML = changeDetail.display;
        },
        /** Shows the file preview in place of the comparison, or the comparison again. */
        showFilePreview(show) {
            const t = this;
            t._previewPane.classList.toggle('showing-file', show);
            if (!show) t._filePreview.clear?.();
        },
        async loadFilePreview(changeDetail, fullFilePath, request) {
            const t = this;
            const base64 = await webui.proxy.getProjectFileBase64(fullFilePath, msg => t.setAlert(msg, 'warning'));
            if (t._diffRequest !== request) return;
            t._fileName.innerHTML = changeDetail.display;
            if (base64 === undefined) return;
            await customElements.whenDefined('webui-file-preview');
            if (t._diffRequest !== request) return;
            if (typeof t._filePreview.setFile !== 'function') customElements.upgrade(t._filePreview);
            const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
            t.showFilePreview(true);
            // The name's extension tells the preview what kind of file it is.
            t._filePreview.setFile({ name: changeDetail.fileName.split('/').pop(), content: bytes });
        },
        async loadRepoChanges() {
            let t = this;
            let repo = t._repos.value;
            if (repo === undefined) return;
            await whenProxyReady();
            // Line counts are extra detail, so a failure shows as unavailable rather than an alert.
            let [changes, lineStats] = await Promise.all([
                webui.proxy.git.getChanges(repo),
                webui.proxy.git.getChangeStats(repo, () => { }),
            ]);
            changes = changes || [];
            t._lineStats = lineStats ? new Map(lineStats.map(stats => [stats.path, stats])) : null;
            t._hasPendingChanges = changes.length > 0;
            const ignoredFiles = new Set(getIgnoredFiles());
            t._files = changes
                .filter(line => line && line.length >= 3)
                .map(line => parseChange(line, repo));
            t._files.forEach(details => {
                if (ignoredFiles.has(`${details.repo}/${details.fileName}`)) {
                    details.state = includeStates.ignore;
                    details.isIncluded = false;
                }
            });
            // Plain elements built in one pass, since a component per row is slow with hundreds of files.
            t._filesContainer.innerHTML = t._files.map(rowHtml).join('');
            t.applyFileFilter();
            t.updateCommitStats();
            // Keep the file that was open, when it still has changes.
            const keep = t._files.findIndex(f => f.fileName === t._selectedFile && f.repo === t._selectedRepo);
            const index = keep !== -1 ? keep : (t._files.length ? 0 : -1);
            if (index === -1) {
                t._selectedFile = undefined;
                t._fileName.innerHTML = '';
                t._diffViewer.clear?.();
                t.showFilePreview(false);
            } else {
                t.selectFile(index);
            }
            t.loadRemoteStatus();
            t.autoFetch(repo);
            webui.proxy.reloadProjectFiles();
        },
        getRow(index) {
            return this._filesContainer.querySelector(`.file-row[data-index="${index}"]`);
        },
        selectFile(index) {
            const t = this;
            const details = t._files[index];
            if (!details) return;
            t._filesContainer.querySelector('.file-row.selected')?.classList.remove('selected');
            const row = t.getRow(index);
            row?.classList.add('selected');
            t._selectedFile = details.fileName;
            t._selectedRepo = details.repo;
            t.loadFileDiff(details);
        },
        setIncludeState(index, state) {
            const t = this;
            const details = t._files[index];
            if (!details) return;
            details.state = state;
            details.isIncluded = state === includeStates.include;
            const select = t.getRow(index)?.querySelector('select.include');
            if (select) {
                select.value = state;
                select.dataset.state = state;
            }
        },
        applyFileFilter() {
            const t = this;
            const filter = (t._fileFilter.value || '').trim().toLowerCase();
            t._filesContainer.querySelectorAll('.file-row').forEach(row => {
                const details = t._files[row.dataset.index];
                row.hidden = !!filter && !details.fileName.toLowerCase().includes(filter);
            });
        },
        visibleIndexes() {
            return Array.from(this._filesContainer.querySelectorAll('.file-row:not([hidden])')).map(row => Number(row.dataset.index));
        },
        confirmRevert(index) {
            const t = this;
            const details = t._files[index];
            if (!details) return;
            const isNew = details.change === 'Add';
            const name = webui.escapeForHTML(details.name);
            const repo = details.repo;
            webui.dialog({
                title: isNew ? 'Delete File' : 'Revert File',
                content: isNew
                    ? `<p>Are you sure you want to permanently delete <strong>${name}</strong>?</p>${dangerNote(`This action cannot be undone.`)}`
                    : `<p>Are you sure you want to discard all uncommitted changes in <strong>${name}</strong>?</p>${dangerNote(`This action cannot be undone.`)}`,
                confirm: isNew ? 'Delete' : 'Revert',
                cancel: 'Cancel',
                onconfirm: async (data, content) => {
                    let result;
                    if (isNew) {
                        result = await webui.proxy.git.deleteFile(repo, details.fileName, msg => content.alert(msg));
                    } else {
                        result = await webui.proxy.git.restoreFile(repo, details.fileName, msg => content.alert(msg));
                    }
                    if (result) {
                        t.setAlert(result, 'success');
                        t.loadRepoChanges();
                        return true;
                    }
                }
            }).catch(() => { });
        },
        /** Sizes the commit panes to the visible page, so the file list and preview each scroll on their own. */
        fitPanes() {
            const t = this;
            const panes = t._panes;
            if (!panes || !panes.isConnected) return;
            t._scroller ??= findScroller(t);
            const scroller = t._scroller;
            if (!scroller) return;
            const panesRect = panes.getBoundingClientRect();
            // A hidden tab has no size, so leave it until it shows.
            if (panesRect.width === 0) return;
            const scrollerRect = scroller.getBoundingClientRect();
            const style = getComputedStyle(scroller);
            const bottom = scrollerRect.bottom - (parseFloat(style.borderBottomWidth) || 0) - (parseFloat(style.paddingBottom) || 0);
            // Measured as if the page were scrolled to the top, so scrolling does not change the size.
            const top = panesRect.top + scroller.scrollTop;
            const height = Math.max(minPanesHeight, Math.floor(bottom - top));
            if (Math.abs(height - (t._panesHeight || 0)) > 1) {
                t._panesHeight = height;
                panes.style.setProperty('--panes-height', `${height}px`);
            }
        },
        setAlert(msg, severity) {
            let t = this;
            t._alert.setValue(!msg ? null : { theme: severity, text: `${msg}` });
        },
        connected() {
            const t = this;
            setTimeout(async () => {
                await whenProxyReady();
                webui.proxy.projects.runWhenLoaded(() => {
                    t.loadRepos();
                });
            }, 50);
            t._message.addEventListener('input', _ => t.rememberMessage(t._message.value));
            t._repos.addEventListener('change', async _ => {
                await webui.wait(20);
                await t.restoreMessage();
                await t.loadBranches();
                t.loadRepoChanges();
            });
            t._branchTable.addEventListener('click', async ev => {
                let btn = webui.closest(ev, 'webui-button');
                if (!btn) return;
                let targetBranch = btn.getAttribute('data-branch');
                if (!targetBranch) return;
                let safeBranch = webui.escapeForHTML(targetBranch);
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
                        await t.loadBranches();
                        t.loadRepoChanges();
                    }
                } else if (btn.classList.contains('btn-new')) {
                    await webui.dialog({
                        title: `Create New Branch from '${safeBranch}'`,
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
                                t.loadRepoChanges();
                                return true;
                            }
                        }
                    });
                } else if (btn.classList.contains('btn-merge')) {
                    await webui.dialog({
                        title: 'Merge Branch',
                        content: `<p>Are you sure you want to merge <strong>${safeBranch}</strong> into the current branch (<strong>${webui.escapeForHTML(t._currentBranch)}</strong>)?</p>`,
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
                        content: targetBranch.startsWith('origin/')
                            ? `<p>Are you sure you want to delete <strong>${safeBranch}</strong> from the remote?</p>${dangerNote(`This removes the branch for everyone using this remote.`)}`
                            : `<p>Are you sure you want to delete the branch <strong>${safeBranch}</strong>?</p>`,
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
                        ${dangerNote('This action cannot be undone. All modified tracked files and untracked additions will be deleted.', true)}
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
                    t.clearMessage();
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
            // Applies to the files shown by the filter, and leaves ignored files alone.
            t._btnToggleAll.addEventListener('click', _ => {
                const indexes = t.visibleIndexes().filter(index => t._files[index].state !== includeStates.ignore);
                if (indexes.length === 0) return;
                const includedCount = indexes.filter(index => t._files[index].isIncluded).length;
                const target = includedCount > Math.floor(indexes.length / 2) ? includeStates.exclude : includeStates.include;
                indexes.forEach(index => t.setIncludeState(index, target));
                t.updateCommitStats();
            });
            t._filesContainer.addEventListener('change', ev => {
                const select = ev.target.closest('select.include');
                if (!select) return;
                const index = Number(select.closest('.file-row').dataset.index);
                const details = t._files[index];
                const ignoredFiles = getIgnoredFiles();
                const fullPath = `${details.repo}/${details.fileName}`;
                const ignoredIndex = ignoredFiles.indexOf(fullPath);
                if (select.value === includeStates.ignore) {
                    if (ignoredIndex === -1) ignoredFiles.push(fullPath);
                } else if (ignoredIndex !== -1) {
                    ignoredFiles.splice(ignoredIndex, 1);
                }
                webui.proxy.syncProjectData();
                t.setIncludeState(index, select.value);
                t.updateCommitStats();
            });
            t._filesContainer.addEventListener('click', ev => {
                const button = ev.target.closest('button');
                if (!button) return;
                const index = Number(button.closest('.file-row').dataset.index);
                if (button.classList.contains('revert')) {
                    t.confirmRevert(index);
                } else if (button.classList.contains('file')) {
                    t.selectFile(index);
                }
            });
            // Up and down move through the files shown.
            t._filesContainer.addEventListener('keydown', ev => {
                if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
                const button = ev.target.closest('button.file');
                if (!button) return;
                const visible = t.visibleIndexes();
                const position = visible.indexOf(Number(button.closest('.file-row').dataset.index));
                const next = visible[position + (ev.key === 'ArrowDown' ? 1 : -1)];
                if (next === undefined) return;
                ev.preventDefault();
                t.getRow(next).querySelector('button.file').focus();
                t.selectFile(next);
            });
            t._fileFilter.addEventListener('input', () => t.applyFileFilter());
            // Anything above the panes that grows or shrinks moves them, such as the alert or the status lines.
            t._resizeObserver = new ResizeObserver(() => t.fitPanes());
            t._resizeObserver.observe(t);
            t._resizeObserver.observe(t._panes);
            [t._alert, t._remoteStatusContainer, t._repos.parentElement, t.template.querySelector('webui-tabs')].forEach(el => {
                if (el) t._resizeObserver.observe(el);
            });
            webui.wait(() => !!findScroller(t)).then(() => {
                t._scroller = findScroller(t);
                if (t._scroller && t._resizeObserver) t._resizeObserver.observe(t._scroller);
                t.fitPanes();
            });
            // The app's header, footer, and drawers can move the page without resizing anything observed
            // here, so check again now and then. It only measures, and writes when the size changes.
            clearInterval(t._fitTimer);
            t._fitTimer = setInterval(() => {
                if (!document.hidden) t.fitPanes();
            }, 500);
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
            whenReady(t._dropdownPatScope).then(() => {
                t._dropdownPatScope.setOptions([
                    { value: 'Project', display: 'Project Level' },
                    { value: 'Global', display: 'Global Level' }
                ]);
                t._dropdownPatScope.value = 'Project';
            });
            t._btnSavePat.addEventListener('click', async () => {
                let token = t._inputPat.value.trim();
                let scope = t._dropdownPatScope.value;
                if (!token) {
                    if (scope === 'Project') {
                        if (!webui.getProjectData('git_pat')) return;
                        webui.dialog.confirm(`Confirm you want to delete this project's PAT token.`, async () => {
                            webui.deleteProjectData('git_pat');
                            await webui.proxy.saveProjectData();
                            t.loadExistingPat();
                            t.setAlert('Project PAT successfully deleted.', 'success');
                            return true;
                        });
                    } else {
                        if (!webui.getGlobalData('git_pat')) return;
                        webui.dialog.confirm(`Confirm you want to delete your global PAT token.`, async () => {
                            webui.deleteGlobalData('git_pat');
                            await webui.proxy.saveAppData();
                            t.loadExistingPat();
                            t.setAlert('Global PAT successfully deleted.', 'success');
                            return true;
                        });
                    }
                    return;
                }
                if (scope === 'Project') {
                    webui.setProjectData('git_pat', token);
                    await webui.proxy.saveProjectData();
                } else {
                    webui.deleteProjectData('git_pat');
                    await webui.proxy.saveProjectData();
                    webui.setGlobalData('git_pat', token);
                    await webui.proxy.saveAppData();
                }
                t._inputPat.value = ''
                t._inputPat.placeholder = token.length > 5 ? `${token.substring(0,3)}***${token.substring(token.length-3)}` : token;
                t.setAlert(`PAT successfully saved to ${scope} scope.`, 'success');
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
                let repo = t._repos.value;
                if (repo === undefined) {
                    t.setAlert('No repo is set!');
                    return;
                }
                if (files.length === 0) {
                    t.setAlert('Select at least one file to commit.', 'warning');
                    return;
                }
                let result = await webui.proxy.git.commit(repo, files, message, msg => t.setAlert(msg));
                if (result) {
                    t.setAlert(result, 'success');
                    t.clearMessage();
                    if (t._toggleSync.value === true || t._toggleSync.value === 'true') {
                        t.setAlert('Commit successful. Syncing with remote...', 'info');
                        let syncResult = await webui.proxy.git.sync(repo, msg => t.setAlert(msg));
                        if (syncResult) {
                            t.setAlert('Commit and Sync successful!', 'success');
                        }
                    }
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
            t._btnPullOverwrite.addEventListener('click', async _ => {
                t.setAlert();
                let repo = t._repos.value;
                if (repo === undefined) {
                    t.setAlert('No repo is set!');
                    return;
                }
                await webui.dialog({
                    title: 'Force Pull (Overwrite Local)',
                    content: `<p>Are you sure you want to pull and <strong>overwrite all local changes</strong>?</p>${dangerNote(`This action cannot be undone.`)}`,
                    confirm: 'Overwrite',
                    cancel: 'Cancel',
                    onconfirm: async (data, content) => {
                        let result = await webui.proxy.git.pullOverwrite(repo, msg => content.alert(msg));
                        if (result) {
                            t.setAlert(result, 'success');
                            await t.loadRepoChanges();
                            return true;
                        }
                    }
                });
            });
            t._btnRefresh.addEventListener('click', async _ => {
                await t.loadRepos();
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
        },
        disconnected() {
            const t = this;
            t._resizeObserver?.disconnect();
            t._resizeObserver = null;
            clearInterval(t._fitTimer);
            t._scroller = null;
        },
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
.status {
    padding: var(--padding);
    background: var(--site-background-color);
    color: var(--site-background-offset);
    border: 1px solid var(--color-info);
    border-radius: 4px;
}
.status-lines {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
}
.status-line {
    display: flex;
    flex-wrap: wrap;
    column-gap: 1.5rem;
    row-gap: 0.25rem;
}
#val-remote-url {
    overflow-wrap: anywhere;
}
.binary-note {
    opacity: 0.8;
    font-size: 0.9em;
}
.commit-panes {
    display: grid;
    grid-template-columns: minmax(320px, 2fr) 3fr;
    gap: var(--padding);
    height: var(--panes-height, 70vh);
    min-height: 360px;
}
.commit-side,
.preview {
    display: flex;
    flex-direction: column;
    gap: var(--padding);
    min-height: 0;
    min-width: 0;
}
.commit-actions,
.list-tools {
    display: flex;
    align-items: center;
    gap: var(--padding);
}
.commit-actions {
    justify-content: flex-end;
}
.file-filter {
    flex: 1;
    min-width: 0;
    font: inherit;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--color-info);
    border-radius: var(--corners);
    background: var(--site-background-color);
    color: var(--site-background-offset);
}
.files {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.file-row {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr) max-content;
    gap: 2px;
    --row-color: var(--color-info);
    --row-color-offset: var(--color-info-offset);
}
.file-row[hidden] {
    display: none;
}
.file-row.add {
    --row-color: var(--color-success);
    --row-color-offset: var(--color-success-offset);
}
.file-row.delete {
    --row-color: var(--color-danger);
    --row-color-offset: var(--color-danger-offset);
}
.file-row.conflict {
    --row-color: var(--color-warning);
    --row-color-offset: var(--color-warning-offset);
}
.file-row select,
.file-row button {
    font: inherit;
    border: none;
    border-radius: var(--corners);
    cursor: pointer;
}
select.include {
    font-size: 0.85em;
    padding: 0 0.25rem;
    background: var(--color-success);
    color: var(--color-success-offset);
}
select.include[data-state="0"] {
    background: var(--color-info);
    color: var(--color-info-offset);
}
select.include[data-state="2"] {
    background: var(--color-warning);
    color: var(--color-warning-offset);
}
button.file {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    min-width: 0;
    padding: 0.2rem 0.5rem;
    text-align: left;
    background: var(--row-color);
    color: var(--row-color-offset);
}
.file-row.selected button.file {
    box-shadow: inset 0 0 0 2px var(--row-color-offset);
}
button.file .name {
    white-space: nowrap;
}
.folder {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.85em;
    font-weight: normal;
}
.badge {
    padding: 0 0.4em;
    border-radius: var(--corners);
}
button.revert {
    padding: 0 0.5rem;
    background: var(--color-danger);
    color: var(--color-danger-offset);
}
.preview h2 {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.preview webui-content-compare {
    flex: 1;
    min-height: 0;
}
.preview webui-file-preview {
    flex: 1;
    min-height: 0;
    overflow: auto;
}
.preview.showing-file webui-content-compare,
.preview:not(.showing-file) webui-file-preview {
    display: none;
}
/* Side by side panes are too narrow on small windows, so stack them and let the page scroll. */
@media (max-width: 900px) {
    .commit-panes {
        grid-template-columns: 1fr;
        height: auto;
    }
    .files {
        max-height: 50vh;
    }
    .preview webui-content-compare {
        height: 60vh;
    }
}
</style>
<webui-flex align="center">
    <webui-button theme="info" label="Refresh"></webui-button>
    <webui-dropdown class="hidden" data-bind="project.selectedGitRepo" label="Repo"></webui-dropdown>
    <webui-flex align="center" gap="0.5rem" style="margin-left: auto;">
        <webui-button id="btn-revert-all" theme="danger" label="Revert All"></webui-button>
        <webui-button id="btn-stash" theme="warning" label="Stash"></webui-button>
        <webui-button id="btn-stash-pop" theme="secondary" label="Pop Stash"></webui-button>
    </webui-flex>
</webui-flex>
<webui-flex id="remote-status-container" class="status" justify="space-between" align="center" gap="var(--padding)" wrap>
    <div class="status-lines">
        <div class="status-line">
            <span><strong>Remote URL:</strong> <span id="val-remote-url"></span></span>
            <span><strong>Tracking Branch:</strong> <span id="val-tracking-branch"></span></span>
            <span><strong>Sync Status:</strong> <span id="val-sync-status"></span></span>
        </div>
        <div class="status-line">
            <span><strong>Files to Commit:</strong> <span id="val-commit-files"></span></span>
            <span><strong>Lines Changed:</strong> <span id="val-commit-lines"></span></span>
        </div>
    </div>
    <webui-flex gap="var(--padding)" grow>
        <webui-flex grow></webui-flex>
        <webui-button theme="info" label="Fetch" id="btn-fetch"></webui-button>
        <webui-button theme="tertiary" label="Pull"></webui-button>
        <webui-button theme="danger" label="Force Pull" id="btn-pull-overwrite" title="Pull and overwrite local changes"></webui-button>
        <webui-button theme="secondary" label="Push"></webui-button>
        <webui-button theme="success" label="Sync"></webui-button>
    </webui-flex>
</webui-flex>
<webui-alert></webui-alert>
<webui-tabs theme="secondary" index="0" transition-timing="200">
    <webui-button slot="tabs">Commit</webui-button>
    <webui-content slot="content" nodetach>
        <div class="commit-panes">
            <div class="commit-side">
                <webui-input-message theme="title" label="Commit Message" max-height="12em"></webui-input-message>
                <div class="commit-actions">
                    <webui-toggle-icon id="toggle-sync" label="Sync after commit" data-bind="app-git-autosync" theme-on="primary"></webui-toggle-icon>
                    <webui-button theme="primary" label="Commit"></webui-button>
                </div>
                <div class="list-tools">
                    <webui-button theme="info" label="Toggle All" title="Include or exclude every file shown"></webui-button>
                    <input type="search" class="file-filter" placeholder="Filter files" aria-label="Filter files" />
                </div>
                <div class="files"></div>
            </div>
            <div class="preview">
                <h2></h2>
                <webui-content-compare></webui-content-compare>
                <webui-file-preview nodownload noframes></webui-file-preview>
            </div>
        </div>
    </webui-content>
    <webui-button slot="tabs">Branches</webui-button>
    <webui-content slot="content" nodetach>
        <div style="margin-top: var(--padding); overflow-x: auto;">
            <webui-table
                id="branch-table"
                theme="secondary"
                columns="Branch|nameHtml;Updated|updatedDate;:Actions:|actionsHtml"
                column-formats="nameHtml:html;actionsHtml:html"
                sortable="nameHtml;updatedDate"
                data-subscribe="git-branches:setData"
                bordered>
            </webui-table>
        </div>
    </webui-content>
    <webui-button slot="tabs" id="tab-remote">Auth</webui-button>
    <webui-content slot="content" nodetach>
        <webui-flex column gap="var(--padding)">
            <h2>Authentication Settings</h2>
            <p class="pa-1">Set your Personal Access Token (PAT) for remote Git operations.</p>
            <webui-grid columns="1fr max-content max-content" gap="var(--padding)" align="end">
                <webui-input-text id="input-git-pat" label="Personal Access Token (PAT)"></webui-input-text>
                <webui-dropdown id="dropdown-pat-scope" label="Scope"></webui-dropdown>
                <webui-button id="btn-save-pat" theme="success" label="Save Token"></webui-button>
            </webui-grid>
        </webui-flex>
    </webui-content>
</webui-tabs>
`
    });
}
