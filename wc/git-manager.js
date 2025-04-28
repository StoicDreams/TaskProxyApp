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
            t._viewOld.innerHTML = '';
            t._viewNew.innerHTML = '';
            if (changeDetail.fileName.endsWith('/')) {
                return;
            }
            let fullFilePath = changeDetail.repo === '' ? changeDetail.fileName : `${changeDetail.repo}/${changeDetail.fileName}`;
            let fileDiff = changeDetail.change !== 'Add' ? await webui.proxy.git.getFileDiff(changeDetail.repo, changeDetail.fileName) : '';
            let lineNumber = 0;
            let lineOld = 0;
            let isCompare = false;
            let oldFragment = document.createDocumentFragment();
            let newFragment = document.createDocumentFragment();

            const { added, removed } = await parseGitDiff(fileDiff || '');
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
                    isCompare = fileDiff !== undefined;
                    t._viewOld.classList.remove('hidden');
                    t._viewNew.style.removeProperty('grid-column');
                    break;
            }

            let fileLines = [];
            let fileContent = undefined;

            if (changeDetail.change === 'Delete') {
                let a = fileDiff.split('@@');
                fileContent = a[a.length - 1].substring(1);
            } else {
                fileContent = await webui.proxy.getProjectFile(fullFilePath);
            }
            fileLines = fileContent.split('\n');

            async function processFile() {
                while (lineNumber < fileLines.length) {
                    requestIdleCallback(processChunk);
                    await webui.wait(1);
                }
            }

            function processChunk(deadline) {
                let stopAt = Math.min(lineNumber + 10, fileLines.length);
                while ((deadline.timeRemaining() > 0 || deadline.didTimeout) && lineNumber < stopAt) {
                    let line = fileLines[lineNumber++];
                    if (isCompare) {
                        if (added[lineNumber] !== undefined) {
                            if (removed[lineOld + 1] !== undefined) {
                                lineOld++;
                                buildLine(oldFragment, removed[lineOld], lineOld, 'danger');
                            } else {
                                buildLine(oldFragment, line, ' ', 'transparent');
                            }
                        } else {
                            lineOld++;
                            if (removed[lineOld] !== undefined) {
                                buildLine(oldFragment, removed[lineOld], lineOld, 'danger');
                                lineOld++;
                            }
                            buildLine(oldFragment, line, lineOld);
                        }
                    }
                    {
                        let theme = added[lineNumber] !== undefined ? 'success' : null;
                        buildLine(newFragment, line, lineNumber, theme);
                    }
                }
            }

            if (fileContent !== undefined) {
                await processFile();
                t._viewOld.appendChild(oldFragment);
                t._viewNew.appendChild(newFragment);
            }
            t._fileName.innerHTML = changeDetail.display;

            function buildLine(body, line, lineNumber, theme) {
                let ln = webui.create('webui-flex', { text: lineNumber, align: 'center', justify: 'end', class: 'line-number pr-1' });
                ln.style.setProperty('--min', '0');
                let pre = webui.create('pre');
                let code = webui.create('code');
                if (theme) {
                    pre.setAttribute('theme', theme);
                }
                code.innerText = line;
                body.appendChild(ln);
                pre.appendChild(code);
                body.appendChild(pre);
            }
        },
        loadRepoChanges: async function () {
            let t = this;
            t._filesContainer.innerText = '';
            let repo = t._repos.value;
            if (repo === undefined) return;
            let changes = await webui.proxy.git.getChanges(repo);
            t._fileName.innerHTML = '';
            t._viewOld.innerHTML = '';
            t._viewNew.innerHTML = '';
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
                let details = {
                    repo: repo,
                    change: changeType,
                    fileName: changeDetail[1],
                    display: `<span class="change-type">${changeType}</span> <strong>${changeDetail[1]}</strong>`,
                    isIncluded: true,
                };
                t._files.push(details);
                let btn = webui.create('webui-button', { label: details.display, align: 'left', theme: theme });
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
                if (!repo) {
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
                if (!repo) {
                    t.setAlert('No repo is set!');
                    return;
                }
                let result = await webui.proxy.git.pull(repo, msg => t.setAlert(msg));
                if (result) {
                    t.setAlert(result, 'success');
                }
                t.loadRepoChanges();
            });
            t._btnPush.addEventListener('click', async _ => {
                t.setAlert();
                let repo = t._repos.value;
                if (!repo) {
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
                if (!repo) {
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
<webui-grid gap="0" columns="max-content 1fr" class="view-old"></webui-grid>
<webui-grid gap="0" columns="max-content 1fr" class="view-new"></webui-grid>
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