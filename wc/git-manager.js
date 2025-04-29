"use strict"
{
    async function parseGitDiff(diffText) {
        const added = {};
        const removed = {};
        const lines = diffText.split("\n");
        let oldLineNum = 0;
        let newLineNum = 0;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // Match hunk header like: @@ -1,5 +1,6 @@
            const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (i % 20 === 0) {
                await webui.wait(1);
            }
            if (hunkMatch) {
                oldLineNum = parseInt(hunkMatch[1], 10);
                newLineNum = parseInt(hunkMatch[2], 10);
                continue;
            }
            if (line.startsWith("+") && !line.startsWith("+++")) {
                added[newLineNum] = line.slice(1);
                newLineNum++;
            } else if (line.startsWith("-") && !line.startsWith("---")) {
                removed[oldLineNum] = line.slice(1);
                oldLineNum++;
            } else {
                // Context line, increment both
                oldLineNum++;
                newLineNum++;
            }
        }
        return { added, removed };
    }

    webui.define("app-git-manager", {
        linkCss: true,
        watchVisibility: false,
        isInput: false,
        preload: '',
        constructor: (t) => {
            t._repos = t.template.querySelector('webui-dropdown[label="Repo"]');
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
            t._instructions = t.template.querySelector('.instructions');
        },
        loadRepos: async function () {
            let t = this;
            let repos = await webui.proxy.git.getRepos();
            if (repos.length === 0) {
                t._repos.classList.add('hidden');
            } else {
                let options = repos.map(item => { return { id: item, value: item, display: item === '' ? 'Root' : item } });
                t._repos.setOptions(options);
                t._repos.classList.remove('hidden');
                if (webui.projectData.data.selectedGitRepo) {
                    t._repos.value = webui.projectData.data.selectedGitRepo;
                }
            }

        },
        loadFileDiff: async function (changeDetail) {
            let t = this;
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
                let a = fileDiff.split('@@');
                data.fileContent = a[a.length - 1].substring(1);
            } else {
                data.fileContent = await webui.proxy.getProjectFile(fullFilePath);
            }
            if (data.fileContent !== undefined) {
                let result = await webui.proxy.worker.send('processFileDiff', data);
                console.log('worker result', result);
                t._viewOld.setLines(result.old);
                t._viewNew.setLines(result.new);
            }
            t._fileName.innerHTML = changeDetail.display;
        },
        loadRepoChanges: async function () {
            let t = this;
            t._filesContainer.innerText = '';
            let repo = t._repos.value;
            if (repo === undefined) return;
            let changes = await webui.proxy.git.getChanges(repo);
            t._fileName.innerHTML = '';
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
            });
        },
        setAlert: function (msg, severity) {
            let t = this;
            console.log('set alert', msg);
            t._alert.setValue(!msg ? null : { theme: severity, html: msg });
        },
        connected: function (t) {
            webui.proxy.projects.runWhenLoaded(() => {
                t.loadRepos();
            });
            t._repos.addEventListener('change', _ => {
                webui.projectData.data.selectedGitRepo = t._repos.value;
                t.loadRepoChanges();
            });
            t._viewNew.addEventListener('change', _ => {
                console.log('new scroll change', t._viewNew.getScroll(), t._viewOld.getScroll());
                if (t._viewOld.getScroll() === t._viewNew.getScroll()) return;
                t._viewOld.setScroll(t._viewNew.getScroll());
            });
            t._viewOld.addEventListener('change', _ => {
                console.log('old scroll change', t._viewNew.getScroll(), t._viewOld.getScroll());
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
            });
            t._btnPush.addEventListener('click', async _ => {
                t.setAlert();
                let repo = t._repos.value;
                if (repo === undefined) {
                    t.setAlert('No repo is set!');
                    return;
                }
                console.log('push');
                let result = await webui.proxy.git.push(repo, msg => t.setAlert(msg));
                console.log('result', result);
                if (result) {
                    t.setAlert(result, 'success');
                }
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
        disconnected: function (t) { },
        shadowTemplate: `
<webui-flex>
<webui-button theme="info" label="Refresh"></webui-button>
<webui-dropdown class="hidden" label="Repo"></webui-dropdown>
<webui-button theme="info" label="Sync"></webui-button>
<webui-button theme="tertiary" label="Pull"></webui-button>
<webui-button theme="secondary" label="Push"></webui-button>
<webui-button theme="primary" label="Commit"></webui-button>
</webui-flex>
<webui-alert></webui-alert>
<webui-grid columns="2fr 3fr">
<webui-quote theme="title" class="instructions"></webui-quote>
<webui-input-message class="h-fill" theme="title" label="Commit Message"></webui-input-message>
</webui-grid>
<webui-grid columns="max-content 1fr">
<webui-grid columns="max-content 1fr" class="files"></webui-grid>
<webui-flex column>
<h3></h3>
<webui-grid columns="1fr 1fr">
<webui-canvas theme="black" line-numbers class="view-old" data-subscribe="git-canvas-scroll:setScroll" data-trigger="git-canvas-scroll:getScroll"></webui-canvas>
<webui-canvas theme="black" line-numbers class="view-new" data-subscribe="git-canvas-scroll:setScroll" data-trigger="git-canvas-scroll:getScroll"></webui-canvas>
<webui-grid gap="0" columns="max-content 1fr" class="view-olds"></webui-grid>
<webui-grid gap="0" columns="max-content 1fr" class="view-news"></webui-grid>
</webui-grid>
</webui-flex>
</webui-grid>
<style type="text/css">
:host {
}
pre {
margin:0;
padding:0;
}
</style>
`
    });
}