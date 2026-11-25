import { test, expect, openApp, switchProject, goToPage, calls, callOrder, onCommand, dialogButton, openDialog, emit } from '../support/app.mjs';
import { actionNote, alertPopup, spyOnAlerts, alerts } from '../../support/wait.mjs';

const open = async (page, git = {}, state = {}) => {
    await openApp(page, { currentPage: '/git-controller', git: { changes: ['M  a.txt', '?? b.txt', ' D c.txt'], ...git }, ...state, files: { 'a.txt': 'one', 'b.txt': 'two', ...(state.files || {}) } }, '/git-controller');
    await page.locator('app-git-manager .files button.file').first().waitFor();
};
const manager = page => page.locator('app-git-manager');
const alertBox = page => manager(page).locator('webui-alert').first();
const messageBox = page => manager(page).locator('webui-input-message[label="Commit Message"] textarea');
// The repo's saved message is put in the box before its files are listed, so once `open` has returned, or the list
// has loaded again after choosing another repo, what is typed stays.
const commit = async (page, message = 'msg') => {
    await messageBox(page).fill(message);
    await manager(page).locator('webui-button[label="Commit"]').click();
};
const tab = (page, name) => manager(page).locator('webui-button[slot="tabs"]', { hasText: name });
// The tabs mark the one showing once they have loaded, and only take clicks from then on.
const openTab = async (page, name) => {
    await expect(manager(page).locator('webui-button[slot="tabs"][aria-current="true"]')).toHaveCount(1);
    await tab(page, name).click();
    await expect(tab(page, name)).toHaveAttribute('aria-current', 'true');
};
const openBranches = async page => {
    await openTab(page, 'Branches');
    await expect(manager(page).locator('webui-button.btn-switch').first()).toBeVisible();
};
/**
 * Loading the files again builds the list again. Mark the rows listed now with `markFiles` before doing what loads
 * them again, and `filesReloaded` passes once those rows are gone, which is when the new list is in place.
 */
const markFiles = page => manager(page).locator('.files .file-row').first().evaluate(row => row.setAttribute('data-listed-before', ''));
const filesReloaded = page => expect(manager(page).locator('.files .file-row[data-listed-before]')).toHaveCount(0);
const refresh = async page => {
    await markFiles(page);
    await manager(page).locator('webui-button[label="Refresh"]').click();
    await filesReloaded(page);
};
// Rows are found by data-path, because Web UI moves title into aria-label once the mouse is over it.
const include = (page, file) => manager(page).locator(`.files .file-row[data-path="${file}"] select.include`);

test.describe('repo dropdown', () => {
    const repoDropdown = page => manager(page).locator('webui-select[label="Repo"]');
    // The repos are tiles in the select's panel, opened from the field once the repos are listed. A click elsewhere
    // closes it, so it is opened again when needed.
    const openRepos = async page => {
        const select = repoDropdown(page);
        await expect.poll(() => select.evaluate(el => el._options?.length || 0)).toBeGreaterThan(0);
        if (!await select.evaluate(el => el.isOpen())) await select.locator('button[aria-haspopup]').click();
        await expect(select.locator('.panel')).toBeVisible();
    };
    const repoTile = async (page, value) => {
        await openRepos(page);
        return repoDropdown(page).locator(`.tile[data-value="${value}"]`);
    };
    const repoStatus = { '': { changes: 2 }, 'libs/api': { behind: 4, ahead: 1 }, docs: {} };

    test('each repo shows its changed files and commits behind and ahead', async ({ page }) => {
        await open(page, { repos: ['', 'libs/api', 'docs'], repoStatus });
        await expect((await repoTile(page, '')).locator('.git-changes webui-icon')).toHaveAttribute('count', '2');
        await expect((await repoTile(page, '')).locator('.name')).toHaveText('Root');
        await expect((await repoTile(page, 'libs/api')).locator('.git-behind webui-icon')).toHaveAttribute('count', '4');
        await expect((await repoTile(page, 'libs/api')).locator('.git-behind')).toHaveAttribute('title', '4 commits behind the remote');
        await expect((await repoTile(page, 'libs/api')).locator('.git-ahead webui-icon')).toHaveAttribute('count', '1');
        await expect((await repoTile(page, 'libs/api')).locator('.git-changes')).toHaveCount(0);
        await expect((await repoTile(page, 'docs')).locator('.name')).toHaveText('docs');
        await expect((await repoTile(page, 'docs')).locator('.git-status')).toHaveCount(0);
        // The chosen repo shows its counts in the picker too.
        await expect(repoDropdown(page).locator('.picked .git-changes webui-icon')).toHaveAttribute('count', '2');
    });
    test('each repo shows the result of the CI runs for its last push', async ({ page }) => {
        const ciStatus = { 'libs/api': { state: 'failure', service: 'GitHub Actions', url: '' }, docs: { state: 'success', service: 'GitHub Actions', url: '' } };
        await open(page, { repos: ['', 'libs/api', 'docs'], repoStatus, ciStatus });
        await expect((await repoTile(page, 'libs/api')).locator('.git-ci-failure')).toHaveAttribute('title', 'GitHub Actions failed for the last push');
        await expect((await repoTile(page, 'libs/api')).locator('.git-behind webui-icon')).toHaveAttribute('count', '4');
        await expect((await repoTile(page, 'docs')).locator('.git-ci-success webui-icon')).toHaveAttribute('icon', 'check');
        await expect((await repoTile(page, '')).locator('.git-ci')).toHaveCount(0);
    });
    test('the Repo dropdown asks again while a CI run is unfinished, and stops once it finishes', async ({ page }) => {
        await page.clock.install();
        await open(page, { repos: ['', 'libs/api'], repoStatus, ciStatus: { '': { state: 'running', service: 'GitHub Actions', url: '' } } });
        await expect((await repoTile(page, '')).locator('.git-ci-running')).toHaveCount(1);
        await page.evaluate(() => { window.__backend.git.ciStatus = { '': { state: 'success', service: 'GitHub Actions', url: '' } }; });
        await page.clock.runFor(61000);
        await expect((await repoTile(page, '')).locator('.git-ci-success')).toHaveCount(1);
        // The run has finished, and the clock only moves when the test moves it, so nothing asks in between.
        const asked = (await calls(page, 'get_git_repo_ci_status')).length;
        await page.clock.runFor(180000);
        await expect.poll(async () => (await calls(page, 'get_git_repo_ci_status')).length).toBe(asked);
    });
    test('a repo name is shown as text, not markup', async ({ page }) => {
        const odd = '<img src=x onerror="window.__xss=1">';
        await open(page, { repos: ['', odd], repoStatus: { [odd]: { changes: 1 } } });
        await openRepos(page);
        await expect(repoDropdown(page).locator('[role="option"] .git-changes webui-icon')).toHaveAttribute('count', '1');
        await expect(repoDropdown(page).locator('[role="option"] .name').nth(1)).toHaveText(odd);
        await expect(repoDropdown(page).locator('img')).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => window.__xss)).toBeUndefined();
    });
    test('counts update after the changes reload, such as after a fetch or commit', async ({ page }) => {
        await open(page, { repos: ['', 'libs/api'], repoStatus });
        await expect((await repoTile(page, 'libs/api')).locator('.git-behind webui-icon')).toHaveAttribute('count', '4');
        await page.evaluate(() => { window.__backend.git.repoStatus = { 'libs/api': { behind: 0, ahead: 0 }, '': { changes: 0, ahead: 3 } }; });
        await manager(page).locator('webui-button[label="Refresh"]').click();
        await expect((await repoTile(page, '')).locator('.git-ahead webui-icon')).toHaveAttribute('count', '3');
        await expect((await repoTile(page, 'libs/api')).locator('.git-status')).toHaveCount(0);
        await expect((await repoTile(page, '')).locator('.git-changes')).toHaveCount(0);
    });
    test('a nested repo is listed by its folder\'s name, with its path as the tooltip', async ({ page }) => {
        await open(page, { repos: ['', 'libs/api'], repoStatus });
        await expect((await repoTile(page, 'libs/api')).locator('.name')).toHaveText('api');
        await expect(await repoTile(page, 'libs/api')).toHaveAttribute('title', 'libs/api');
        await expect((await repoTile(page, '')).locator('.name')).toHaveText('Root');
    });
    test('choosing a repo from the list switches to it', async ({ page }) => {
        await open(page, { repos: ['', 'libs/api'], repoStatus });
        await (await repoTile(page, 'libs/api')).click();
        await expect.poll(() => repoDropdown(page).evaluate(el => el.value)).toBe('libs/api');
        await expect.poll(async () => (await calls(page, 'get_git_changes')).map(call => call.path)).toContain('libs/api');
    });
    test('Commit is off until the chosen repo\'s changes are listed, so no commit is made from the list of the repo before', async ({ page }) => {
        await open(page, { repos: ['', 'libs/api'], repoStatus });
        await page.evaluate(() => {
            // The first answer with the changes of libs/api is held until the test lets it go.
            const original = window.__backend.handlers.get_git_changes;
            let held = false;
            window.__backend.handlers.get_git_changes = async args => {
                if (args.path === 'libs/api' && !held) {
                    held = true;
                    await new Promise(resolve => { window.__releaseChanges = resolve; });
                }
                return original(args);
            };
        });
        await markFiles(page);
        await (await repoTile(page, 'libs/api')).click();
        await expect.poll(() => page.evaluate(() => typeof window.__releaseChanges)).toBe('function');
        await messageBox(page).fill('msg');
        const button = manager(page).locator('webui-button[label="Commit"]');
        await expect(button).toHaveAttribute('disabled');
        await expect(button).toHaveAttribute('title', 'The changes are still loading');
        await page.evaluate(() => window.__releaseChanges());
        await filesReloaded(page);
        await commit(page);
        // Only the commit made once the repo's own changes were listed went through.
        await expect.poll(async () => (await calls(page, 'git_commit')).map(call => call.repo)).toEqual(['libs/api']);
    });
});

test('changes are listed with their type', async ({ page }) => {
    await open(page);
    await expect(manager(page).locator('.files button.file[title="a.txt"]')).toContainText('Modify');
    await expect(manager(page).locator('.files button.file[title="b.txt"]')).toContainText('Add');
    await expect(manager(page).locator('.files button.file[title="c.txt"]')).toContainText('Delete');
});
test('commit sends the included files, and does not push unless asked', async ({ page }) => {
    await open(page);
    await commit(page);
    await expect.poll(() => calls(page, 'git_commit')).toEqual([{ repo: '', files: ['a.txt', 'b.txt', 'c.txt'], message: 'msg' }]);
    // The commit says how it ended once nothing is left to do, and a sync would have come before that.
    await expect(alertBox(page)).toContainText('Commit successful.');
    await expect.poll(() => calls(page, 'git_sync')).toEqual([]);
});
test('sync after commit syncs when switched on', async ({ page }) => {
    await open(page, {}, { appData: { 'app-git-autosync': true } });
    await commit(page);
    await expect.poll(async () => (await calls(page, 'git_sync')).length).toBe(1);
});
const commitActions = page => manager(page).locator('.commit-actions');
const commitState = page => manager(page).locator('.commit-state');
const cancelCommit = page => manager(page).locator('#btn-cancel-commit');
test('Processing Commit replaces the commit buttons while the commit is made', async ({ page }) => {
    await open(page);
    await expect(manager(page).locator('#toggle-queue')).toBeVisible();
    await onCommand(page, 'git_commit', () => new Promise(resolve => { window.__finishCommit = () => resolve('Commit successful.'); }));
    await commit(page);
    await expect(commitState(page)).toHaveText('Processing Commit');
    await expect(manager(page).locator('webui-button[label="Commit"]')).toBeHidden();
    await expect(manager(page).locator('#toggle-queue')).toBeHidden();
    await expect(cancelCommit(page)).toBeHidden();
    await page.evaluate(() => window.__finishCommit());
    await expect(commitActions(page)).toHaveAttribute('data-state', 'ready');
    await expect(manager(page).locator('webui-button[label="Commit"]')).toBeVisible();
});
test.describe('commits Rust runs', () => {
    const enqueue = (page, args = {}) => page.evaluate(args => window.__backend.handlers.commit_enqueue({
        repo: '', message: 'from the phone', files: ['a.txt'], excluded: ['b.txt', 'c.txt'], ignored: [], syncAfter: false, script: null, queue: false, ...args,
    }), args);
    test('a commit made on another screen shows here, and so does how it ended', async ({ page }) => {
        await open(page);
        await onCommand(page, 'git_commit', () => new Promise(resolve => { window.__finishCommit = () => resolve('Commit successful.'); }));
        await enqueue(page);
        await expect(commitState(page)).toHaveText('Processing Commit');
        await expect(manager(page).locator('#tab-queue')).toHaveText('Queue (1)');
        await page.evaluate(() => window.__finishCommit());
        await expect(commitActions(page)).toHaveAttribute('data-state', 'ready');
        await expect(alertBox(page)).toContainText('Commit successful.');
        await expect.poll(() => calls(page, 'git_commit')).toEqual([{ repo: '', files: ['a.txt'], message: 'from the phone' }]);
    });
    test('a Git Controller that opens while a commit runs shows it', async ({ page }) => {
        await openApp(page, { git: { changes: ['M  a.txt'] }, files: { 'a.txt': 'one' } });
        await onCommand(page, 'git_commit', () => new Promise(() => { }));
        await enqueue(page);
        await goToPage(page, '/git-controller');
        await manager(page).locator('.files button.file').first().waitFor();
        await expect(commitState(page)).toHaveText('Processing Commit');
        await expect(manager(page).locator('webui-button[label="Commit"]')).toBeHidden();
    });
    test('the commit is sent with what Rust needs to run it', async ({ page }) => {
        await open(page, {}, { data: { _gitIgnoreFiles: ['/b.txt'] } });
        await include(page, 'c.txt').selectOption('0');
        await commit(page);
        await expect.poll(() => calls(page, 'commit_enqueue')).toEqual([{
            project: '/repo', repo: '', message: 'msg', files: ['a.txt'], excluded: ['c.txt'], ignored: ['/b.txt'], syncAfter: false, script: null, queue: false,
        }]);
    });
});
test('Commit is off until there is a message, and on once there is', async ({ page }) => {
    await open(page);
    const button = manager(page).locator('webui-button[label="Commit"]');
    await expect(button).toHaveAttribute('disabled');
    await expect(button).toHaveAttribute('title', 'Write a commit message to commit');
    // Only spaces are no message.
    await messageBox(page).fill('   ');
    await expect(button).toHaveAttribute('disabled');
    await messageBox(page).fill('msg');
    await expect(button).not.toHaveAttribute('disabled');
    await messageBox(page).fill('');
    await expect(button).toHaveAttribute('disabled');
    await expect.poll(() => calls(page, 'commit_enqueue')).toEqual([]);
});
test('Commit is off with no file included, and on once one is', async ({ page }) => {
    await open(page);
    const button = manager(page).locator('webui-button[label="Commit"]');
    await messageBox(page).fill('msg');
    await expect(button).not.toHaveAttribute('disabled');
    await manager(page).locator('webui-button[label="Toggle All"]').click();
    await expect(button).toHaveAttribute('disabled');
    await expect(button).toHaveAttribute('title', 'Include at least one file to commit');
    await include(page, 'a.txt').selectOption('1');
    await expect(button).not.toHaveAttribute('disabled');
    await expect.poll(() => calls(page, 'commit_enqueue')).toEqual([]);
});
test('Commit and Toggle All are off with nothing changed', async ({ page }) => {
    await openApp(page, { currentPage: '/git-controller', git: { changes: [] } }, '/git-controller');
    await expect(manager(page).locator('#val-commit-files')).toHaveText('No changes');
    await messageBox(page).fill('msg');
    await expect(manager(page).locator('webui-button[label="Commit"]')).toHaveAttribute('title', 'Include at least one file to commit');
    await expect(manager(page).locator('webui-button[label="Commit"]')).toHaveAttribute('disabled');
    await expect(manager(page).locator('webui-button[label="Toggle All"]')).toHaveAttribute('disabled');
    await expect(manager(page).locator('webui-button[label="Toggle All"]')).toHaveAttribute('title', 'No files shown to include or exclude');
});
test('Toggle All is off while the filter shows no files, and on again once it does', async ({ page }) => {
    await open(page);
    const button = manager(page).locator('webui-button[label="Toggle All"]');
    await expect(button).not.toHaveAttribute('disabled');
    await manager(page).locator('input.file-filter').fill('nothing-matches');
    await expect(button).toHaveAttribute('disabled');
    await manager(page).locator('input.file-filter').fill('a.txt');
    await expect(button).not.toHaveAttribute('disabled');
    await expect(button).toHaveAttribute('title', 'Include or exclude every file shown');
});
test('excluded files are left out of the commit', async ({ page }) => {
    await open(page);
    await include(page, 'b.txt').selectOption('0');
    await commit(page);
    await expect.poll(async () => (await calls(page, 'git_commit')).map(call => call.files)).toEqual([['a.txt', 'c.txt']]);
});
test('files that changed after the list was drawn are committed too, and excluded files still are not', async ({ page }) => {
    await open(page);
    await include(page, 'b.txt').selectOption('0');
    // Edited elsewhere after the Git Controller listed the changes, with no refresh in between.
    await page.evaluate(() => { window.__backend.git.changes = ['M  a.txt', '?? b.txt', ' D c.txt', ' M later.txt']; });
    await commit(page);
    await expect.poll(async () => (await calls(page, 'git_commit')).map(call => call.files)).toEqual([['a.txt', 'c.txt', 'later.txt']]);
});
test('files marked ignore stay out of later commits', async ({ page }) => {
    await open(page, {}, { data: { _gitIgnoreFiles: ['/b.txt'] } });
    await commit(page);
    await expect.poll(async () => (await calls(page, 'git_commit')).map(call => call.files)).toEqual([['a.txt', 'c.txt']]);
});
test('marking a file ignored is stored with the project', async ({ page }) => {
    await open(page);
    await include(page, 'a.txt').selectOption('2');
    await expect.poll(() => page.evaluate(() => webui.projectData.data._gitIgnoreFiles)).toEqual(['/a.txt']);
    await expect.poll(async () => page.evaluate(() => window.__backend.savedProjects['/repo'].data._gitIgnoreFiles)).toEqual(['/a.txt']);
});
test('markup in a file name is shown as text', async ({ page }) => {
    const name = 'x<img src=q onerror="window.__xss=1">.txt';
    await open(page, { changes: [`M  ${name}`] }, { files: { [name]: 'x' } });
    // The name shows in the list, and above the comparison once the file has loaded, so any markup in it has been drawn.
    await expect(manager(page).locator('.files button.file .name')).toHaveText(name);
    await expect(manager(page).locator('.preview h2')).toHaveText(`Modify ${name}`);
    await expect(manager(page).locator('.files img')).toHaveCount(0);
    await expect(manager(page).locator('.preview h2 img')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__xss)).toBeUndefined();
});
test('markup in a branch name is shown as text', async ({ page }) => {
    const names = ['<img/src=q/onerror=window.__xss=1>', 'x"onmouseover="window.__xss=2"data-x="'];
    await open(page, { branches: [{ name: 'main', isCurrent: true, updatedDate: '' }, ...names.map(name => ({ name, isCurrent: false, updatedDate: '' }))] });
    await openBranches(page);
    // The names show in the table, so any markup in them has been drawn.
    for (const name of names) await expect(manager(page).locator('webui-table')).toContainText(name);
    await expect(manager(page).locator('webui-table img')).toHaveCount(0);
    // A quote in a name does not end the attribute its buttons keep the name in.
    await expect(manager(page).locator('webui-button.btn-switch[onmouseover]')).toHaveCount(0);
    await expect.poll(() => manager(page).locator('webui-button.btn-switch').evaluateAll(buttons => buttons.map(button => button.dataset.branch).sort())).toEqual([...names].sort());
    await expect.poll(() => page.evaluate(() => window.__xss)).toBeUndefined();
});
test('markup in the remote url is shown as text, and a token in it is hidden', async ({ page }) => {
    await open(page, { status: { hasUpstream: true, upstreamName: '<b>x</b>', ahead: 0, behind: 0, remoteUrl: 'https://user:TOKEN@example.com/<img src=q>.git' } });
    const url = manager(page).locator('#val-remote-url');
    await expect(url).toHaveText('https://example.com/<img src=q>.git');
    await expect(manager(page).locator('#val-tracking-branch')).toHaveText('<b>x</b>');
});
test('a file name containing an arrow is not treated as a rename', async ({ page }) => {
    await open(page, { changes: ['M  a -> b.txt'] }, { files: { 'a -> b.txt': 'x' } });
    await expect(manager(page).locator('.files button.file[title="a -> b.txt"]')).toHaveCount(1);
});
test('a renamed file uses its new name', async ({ page }) => {
    await open(page, { changes: ['R  old.txt -> new.txt'] }, { files: { 'new.txt': 'x' } });
    await expect(manager(page).locator('.files button.file[title="new.txt"]')).toHaveCount(1);
});
test('a binary file does not interrupt with a popup', async ({ page }) => {
    await openApp(page, { project: { name: 'Repo', path: '/repo' }, binaryFiles: { 'logo.png': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' } });
    await spyOnAlerts(page);
    await page.evaluate(() => { window.__backend.git.changes = ['M  logo.png']; });
    await goToPage(page, '/git-controller');
    await page.locator('app-git-manager .files button.file').first().waitFor();
    // It shows in the file preview instead, with no warning.
    await expect(manager(page).locator('webui-file-preview')).toBeVisible();
    await expect(alertBox(page)).not.toContainText('valid UTF-8');
    await expect.poll(() => alerts(page)).toEqual([]);
});
test('a file opened before its line counts come waits for them to learn it is binary, and is not read as text', async ({ page }) => {
    await open(page, {}, { binaryFiles: { 'data.db': 'AAECAwQF' } });
    await page.evaluate(() => {
        window.__backend.git.changes = ['M  data.db'];
        window.__backend.handlers.get_git_change_stats = () => new Promise(resolve => {
            window.__releaseStats = () => resolve([{ path: 'data.db', additions: 0, deletions: 0, binary: true }]);
        });
    });
    await refresh(page);
    await expect.poll(() => page.evaluate(() => typeof window.__releaseStats)).toBe('function');
    await expect(manager(page).locator('.file-row.selected')).toHaveAttribute('data-path', 'data.db');
    await page.evaluate(() => window.__releaseStats());
    await expect(manager(page).locator('webui-file-preview')).toBeVisible();
    await expect.poll(() => calls(page, 'get_project_file_size')).toContainEqual({ filePath: 'data.db' });
    await expect.poll(() => calls(page, 'get_git_file_diff')).not.toContainEqual(expect.objectContaining({ file: 'data.db' }));
});
test('a slow diff cannot replace the file selected after it', async ({ page }) => {
    await open(page);
    const heading = manager(page).locator('.preview h2');
    await expect(heading).toHaveText('Modify a.txt');
    await page.evaluate(() => {
        // The diff of a.txt is held until the test lets it go.
        const original = window.__backend.handlers.get_git_file_diff;
        window.__backend.handlers.get_git_file_diff = async args => {
            if (args.file === 'a.txt') await new Promise(resolve => { window.__releaseDiff = resolve; });
            return original(args);
        };
        // Every file shown as loaded above the comparison, in order.
        window.__shown = [];
        const name = document.querySelector('app-git-manager')._fileName;
        new MutationObserver(() => {
            const text = name.textContent.trim();
            if (text && !text.startsWith('Loading') && window.__shown.at(-1) !== text) window.__shown.push(text);
        }).observe(name, { childList: true, characterData: true, subtree: true });
    });
    await manager(page).locator('.files button.file[title="a.txt"]').click();
    await expect.poll(() => page.evaluate(() => typeof window.__releaseDiff)).toBe('function');
    await manager(page).locator('.files button.file[title="b.txt"]').click();
    await expect(heading).toHaveText('Add b.txt');
    // The slow diff arrives now. Had it been shown, it would be asked for before the next file selected, so it
    // would be drawn before that one is.
    await page.evaluate(() => window.__releaseDiff());
    await manager(page).locator('.files button.file[title="c.txt"]').click();
    await expect(heading).toHaveText('Delete c.txt');
    await expect.poll(() => page.evaluate(() => window.__shown)).toEqual(['Add b.txt', 'Delete c.txt']);
});
test('reverting a modified file restores it, and removing a new file deletes it', async ({ page }) => {
    await open(page);
    await manager(page).locator('.files button.revert[title="Revert changes to this file"]').first().click();
    await dialogButton(page, 'Revert').click();
    await expect.poll(() => calls(page, 'git_restore_file')).toEqual([{ repo: '', file: 'a.txt' }]);
    await expect(openDialog(page)).toHaveCount(0);
    await manager(page).locator('.files button.revert[title="Delete new file"]').first().click();
    await dialogButton(page, 'Delete').click();
    await expect.poll(async () => (await calls(page, 'git_delete_file')).length).toBe(1);
});
test('why a revert failed is shown in its dialog as text, even when a file name holds markup', async ({ page }) => {
    await open(page);
    await onCommand(page, 'git_restore_file', () => { throw 'Could not restore <img src=x onerror="window.__xss=1"><b>a.txt</b>'; });
    await manager(page).locator('.files button.revert[title="Revert changes to this file"]').first().click();
    await dialogButton(page, 'Revert').click();
    const said = openDialog(page).locator('webui-alert');
    await expect(said).toHaveText('Could not restore <img src=x onerror="window.__xss=1"><b>a.txt</b>');
    await expect(said.locator('img, b')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__xss)).toBeUndefined();
});
test('revert all asks first', async ({ page }) => {
    await open(page);
    await manager(page).locator('#btn-revert-all').click();
    await expect(dialogButton(page, 'Revert All')).toBeVisible();
    await expect.poll(() => calls(page, 'git_restore_all')).toEqual([]);
    await dialogButton(page, 'Revert All').click();
    await expect.poll(async () => (await calls(page, 'git_restore_all')).length).toBe(1);
});
test('branches cannot change with uncommitted work', async ({ page }) => {
    await open(page, { branches: [{ name: 'main', isCurrent: true, updatedDate: '' }, { name: 'other', isCurrent: false, updatedDate: '' }] });
    await openBranches(page);
    await manager(page).locator('webui-button.btn-switch').click();
    await expect(alertBox(page)).toContainText('uncommitted changes');
    await expect.poll(() => calls(page, 'git_switch_branch')).toEqual([]);
});
test('deleting a remote branch says so', async ({ page }) => {
    await open(page, { branches: [{ name: 'main', isCurrent: true, updatedDate: '' }, { name: 'origin/old', isCurrent: false, updatedDate: '' }] });
    await openBranches(page);
    await manager(page).locator('webui-button.btn-delete').click();
    // Scoped to the dialog, because the page's help text also mentions the remote.
    await expect(openDialog(page).getByText('from the remote')).toBeVisible();
});
test('pull, push, sync, and fetch call the backend', async ({ page }) => {
    await open(page);
    for (const [label, command] of [['Pull', 'git_pull'], ['Push', 'git_push'], ['Sync', 'git_sync'], ['Fetch', 'git_fetch']]) {
        const before = (await calls(page, command)).length;
        await manager(page).locator(`webui-button[label="${label}"]`).click();
        await expect.poll(async () => (await calls(page, command)).length, label).toBeGreaterThan(before);
    }
});
test('cancelling the request for a token ends the git command, and says so', async ({ page }) => {
    await open(page);
    await onCommand(page, 'git_pull', () => { throw 'Credentials Missing/Invalid'; });
    await manager(page).locator('webui-button[label="Pull"]').click();
    await expect(dialogButton(page, 'Save & Retry')).toBeVisible();
    await dialogButton(page, 'Cancel').click();
    await expect(openDialog(page)).toHaveCount(0);
    await expect(alertBox(page)).toContainText('Git operation cancelled: Authentication required.');
    await expect.poll(async () => (await calls(page, 'git_pull')).length).toBe(1);
});
test('a saved token shows masked, and only reaches the project', async ({ page }) => {
    await open(page);
    await openTab(page, 'Auth');
    await manager(page).locator('input#input-git-pat').fill('abcdefghijkl');
    await manager(page).locator('#btn-save-pat').click();
    await expect.poll(() => page.evaluate(() => webui.getProjectData('git_pat'))).toBe('abcdefghijkl');
    // The masked token shows once saving has finished.
    await expect(manager(page).locator('input#input-git-pat')).toHaveAttribute('placeholder', 'abc***jkl');
    await expect.poll(() => page.evaluate(() => webui.getData('git_pat'))).toBeUndefined();
});
test('Save Token is off until a token is typed, and off again once it is saved', async ({ page }) => {
    await open(page);
    await openTab(page, 'Auth');
    const button = manager(page).locator('#btn-save-pat');
    await expect(button).toHaveAttribute('disabled');
    await expect(button).toHaveAttribute('title', 'Type a token to save');
    await manager(page).locator('input#input-git-pat').fill('abcdefghijkl');
    await expect(button).not.toHaveAttribute('disabled');
    await button.click();
    await expect(manager(page).locator('input#input-git-pat')).toHaveAttribute('placeholder', 'abc***jkl');
    await expect(button).toHaveAttribute('disabled');
});
test('Delete Token is off until a token is saved in the scope chosen, and deletes it after asking', async ({ page }) => {
    await open(page);
    await openTab(page, 'Auth');
    const remove = manager(page).locator('#btn-delete-pat');
    await expect(remove).toHaveAttribute('disabled');
    await expect(remove).toHaveAttribute('title', 'No project token is saved to delete');
    await manager(page).locator('input#input-git-pat').fill('abcdefghijkl');
    await manager(page).locator('#btn-save-pat').click();
    await expect(remove).not.toHaveAttribute('disabled');
    await expect(remove).toHaveAttribute('title', 'Delete the project token');
    await remove.click();
    await dialogButton(page, 'Confirm').click();
    await expect.poll(() => page.evaluate(() => webui.getProjectData('git_pat'))).toBeFalsy();
    await expect(remove).toHaveAttribute('disabled');
});
test('ahead and behind counts are shown', async ({ page }) => {
    await open(page, { status: { hasUpstream: true, upstreamName: 'origin/main', ahead: 2, behind: 3, remoteUrl: 'x' } });
    await expect(manager(page).locator('#val-sync-status')).toContainText('2 Commits Ahead');
    await expect(manager(page).locator('#val-sync-status')).toContainText('3 Commits Behind');
});

test.describe('branches', () => {
    const branches = [{ name: 'main', isCurrent: true, updatedDate: '' }, { name: 'other', isCurrent: false, updatedDate: '' }];
    // With no uncommitted work, so branches can change.
    const openClean = async page => {
        await openApp(page, { currentPage: '/git-controller', git: { changes: [], branches, currentBranch: 'main' } }, '/git-controller');
        await openBranches(page);
    };
    const row = (page, name) => manager(page).locator(`webui-button[data-branch="${name}"]`);

    test('switching branches calls the backend and refreshes the files', async ({ page }) => {
        await openClean(page);
        const before = (await calls(page, 'get_git_changes')).length;
        await row(page, 'other').and(page.locator('.btn-switch')).click();
        await expect.poll(async () => (await calls(page, 'git_switch_branch'))).toEqual([{ repo: '', branch: 'other' }]);
        await expect(manager(page).locator('webui-alert').first()).toContainText('Branch switched successfully.');
        await expect.poll(async () => (await calls(page, 'get_git_changes')).length).toBeGreaterThan(before);
    });
    test('a new branch needs a name, and starts from the branch it was made from', async ({ page }) => {
        await openClean(page);
        await row(page, 'other').and(page.locator('.btn-new')).click();
        await expect(openDialog(page)).toContainText("Create New Branch from 'other'");
        await dialogButton(page, 'Create').click();
        await expect(openDialog(page)).toContainText('Branch name cannot be empty.');
        await expect.poll(() => calls(page, 'git_create_branch')).toEqual([]);
        await openDialog(page).locator('webui-input-text[name="branchName"] input').fill('  feature  ');
        await dialogButton(page, 'Create').click();
        await expect.poll(async () => (await calls(page, 'git_create_branch'))).toEqual([{ repo: '', branch: 'feature', baseBranch: 'other' }]);
        await expect(manager(page).locator('webui-alert').first()).toContainText('Branch created.');
    });
    test('a new branch cannot be made with uncommitted work', async ({ page }) => {
        await open(page, { branches, currentBranch: 'main' });
        await openBranches(page);
        await row(page, 'other').and(page.locator('.btn-new')).click();
        await expect(manager(page).locator('webui-alert').first()).toContainText('uncommitted changes');
        await expect(openDialog(page)).toHaveCount(0);
    });
    test('merging asks first, naming both branches', async ({ page }) => {
        await openClean(page);
        await row(page, 'other').and(page.locator('.btn-merge')).click();
        await expect(openDialog(page)).toContainText('merge other into the current branch (main)');
        await dialogButton(page, 'Cancel').click();
        await expect(openDialog(page)).toHaveCount(0);
        await expect.poll(() => calls(page, 'git_merge_branch')).toEqual([]);
        await row(page, 'other').and(page.locator('.btn-merge')).click();
        await dialogButton(page, 'Merge').click();
        await expect.poll(async () => (await calls(page, 'git_merge_branch'))).toEqual([{ repo: '', branch: 'other' }]);
        await expect(manager(page).locator('webui-alert').first()).toContainText('Merge successful.');
    });
    test('a merge that fails says why, and leaves the dialog open', async ({ page }) => {
        await openClean(page);
        await onCommand(page, 'git_merge_branch', () => { throw 'Merge conflicts in a.txt'; });
        await row(page, 'other').and(page.locator('.btn-merge')).click();
        await dialogButton(page, 'Merge').click();
        await expect(openDialog(page)).toContainText('Merge conflicts in a.txt');
    });
    test('the current branch cannot be merged or deleted', async ({ page }) => {
        await openClean(page);
        await expect(row(page, 'main').and(page.locator('.btn-merge'))).toHaveCount(0);
        await expect(row(page, 'main').and(page.locator('.btn-delete'))).toHaveCount(0);
        await expect(row(page, 'main').and(page.locator('.btn-switch'))).toHaveCount(0);
    });
    test('deleting a local branch asks first', async ({ page }) => {
        await openClean(page);
        await row(page, 'other').and(page.locator('.btn-delete')).click();
        await expect(openDialog(page)).toContainText('delete the branch other?');
        await expect(openDialog(page)).not.toContainText('from the remote');
        await dialogButton(page, 'Delete').click();
        await expect.poll(async () => (await calls(page, 'git_delete_branch'))).toEqual([{ repo: '', branch: 'other' }]);
        await expect(manager(page).locator('webui-alert').first()).toContainText('Branch deleted.');
    });
});

test.describe('stash and force pull', () => {
    test('stash sends the commit message, then clears it and refreshes the files', async ({ page }) => {
        await open(page);
        await manager(page).locator('webui-input-message[label="Commit Message"] textarea').fill('half done');
        const before = (await calls(page, 'get_git_changes')).length;
        await manager(page).locator('#btn-stash').click();
        await expect.poll(async () => (await calls(page, 'git_stash'))).toEqual([{ repo: '', message: 'half done' }]);
        await expect(manager(page).locator('webui-alert').first()).toContainText('Changes stashed successfully.');
        await expect(manager(page).locator('webui-input-message[label="Commit Message"] textarea')).toHaveValue('');
        await expect.poll(async () => (await calls(page, 'get_git_changes')).length).toBeGreaterThan(before);
    });
    test('with nothing changed, Stash and Revert All are off', async ({ page }) => {
        await openApp(page, { currentPage: '/git-controller', git: { changes: [] } }, '/git-controller');
        await expect(manager(page).locator('#val-commit-files')).toHaveText('No changes');
        await expect(manager(page).locator('#btn-stash')).toHaveAttribute('disabled');
        await expect(manager(page).locator('#btn-stash')).toHaveAttribute('title', 'No pending changes to stash');
        await expect(manager(page).locator('#btn-revert-all')).toHaveAttribute('disabled');
        await expect(manager(page).locator('#btn-revert-all')).toHaveAttribute('title', 'No pending changes to revert');
    });
    test('Stash and Revert All are on once there are changes', async ({ page }) => {
        await open(page);
        await expect(manager(page).locator('#btn-stash')).not.toHaveAttribute('disabled');
        await expect(manager(page).locator('#btn-revert-all')).not.toHaveAttribute('disabled');
    });
    test('pop stash calls the backend and refreshes the files', async ({ page }) => {
        await open(page);
        const before = (await calls(page, 'get_git_changes')).length;
        await manager(page).locator('#btn-stash-pop').click();
        await expect.poll(async () => (await calls(page, 'git_stash_pop')).length).toBe(1);
        await expect(manager(page).locator('webui-alert').first()).toContainText('Stash popped successfully.');
        await expect.poll(async () => (await calls(page, 'get_git_changes')).length).toBeGreaterThan(before);
    });
    test('a stash that cannot be applied says why', async ({ page }) => {
        await open(page);
        await onCommand(page, 'git_stash_pop', () => { throw '1 conflict prevents checkout'; });
        await manager(page).locator('#btn-stash-pop').click();
        await expect(manager(page).locator('webui-alert').first()).toContainText('1 conflict prevents checkout');
    });
    test('force pull asks first, and only overwrites once confirmed', async ({ page }) => {
        await open(page);
        await manager(page).locator('#btn-pull-overwrite').click();
        await expect(openDialog(page)).toContainText('overwrite all local changes');
        await dialogButton(page, 'Cancel').click();
        await expect(openDialog(page)).toHaveCount(0);
        await expect.poll(() => calls(page, 'git_pull_overwrite')).toEqual([]);
        await manager(page).locator('#btn-pull-overwrite').click();
        await dialogButton(page, 'Overwrite').click();
        await expect.poll(async () => (await calls(page, 'git_pull_overwrite'))).toEqual([{ repo: '' }]);
        await expect(manager(page).locator('webui-alert').first()).toContainText('Successfully pulled and overwrote local branch');
    });
    test('a pull picks up project files that changed underneath the app', async ({ page }) => {
        await open(page);
        const before = (await calls(page, 'reload_project_files')).length;
        await manager(page).locator('webui-button[label="Pull"]').click();
        await expect.poll(async () => (await calls(page, 'reload_project_files')).length).toBeGreaterThan(before);
    });
});

test.describe('commit message memory', () => {
    const textarea = messageBox;
    const typeMessage = (page, message) => textarea(page).fill(message);
    const waitForFiles = page => manager(page).locator('.files button.file').first().waitFor();
    const goTo = goToPage;
    const projects = [{ name: 'Repo', path: '/repo' }, { name: 'Other', path: '/other' }];
    // Loading a project opens the page it was last on.
    const openProject = async (page, project, startPage) => {
        await switchProject(page, project);
        await expect(page).toHaveURL(url => url.pathname === startPage);
    };

    test('a message is kept after leaving the page and coming back', async ({ page }) => {
        await open(page);
        await typeMessage(page, 'work in progress');
        await goTo(page, '/');
        await goTo(page, '/git-controller');
        await waitForFiles(page);
        await expect(textarea(page)).toHaveValue('work in progress');
    });
    test('the message is sent to the backend, so it survives a restart', async ({ page }) => {
        await open(page);
        await typeMessage(page, 'saved for later');
        await expect.poll(() => page.evaluate(() => window.__backend.savedProjects['/repo'].data._gitCommitMessages?.[''])).toBe('saved for later');
    });
    test('a message saved earlier is shown when the page opens', async ({ page }) => {
        await open(page, {}, { data: { _gitCommitMessages: { '': 'from last time' } } });
        await expect(textarea(page)).toHaveValue('from last time');
    });
    test('a successful commit clears the saved message', async ({ page }) => {
        await open(page);
        await typeMessage(page, 'msg');
        await manager(page).locator('webui-button[label="Commit"]').click();
        await expect.poll(async () => (await calls(page, 'git_commit')).length).toBe(1);
        await expect(textarea(page)).toHaveValue('');
        await expect.poll(() => page.evaluate(() => webui.projectData.data._gitCommitMessages[''])).toBeUndefined();
    });
    test('a failed commit keeps the message', async ({ page }) => {
        await open(page);
        await onCommand(page, 'git_commit', () => { throw 'Commit failed'; });
        await typeMessage(page, 'try again');
        await manager(page).locator('webui-button[label="Commit"]').click();
        await expect.poll(async () => (await calls(page, 'git_commit')).length).toBe(1);
        // The commit says how it ended, which is when a sent message would be cleared.
        await expect(alertBox(page)).toContainText('Commit failed');
        await expect(textarea(page)).toHaveValue('try again');
        await expect.poll(() => page.evaluate(() => webui.projectData.data._gitCommitMessages[''])).toBe('try again');
    });
    test('each repo keeps its own message', async ({ page }) => {
        await open(page, { repos: ['', 'sub'] });
        await typeMessage(page, 'root message');
        const selectRepo = repo => manager(page).locator('webui-select[label="Repo"]').evaluate((el, repo) => {
            el.value = repo;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }, repo);
        await selectRepo('sub');
        await expect(textarea(page)).toHaveValue('');
        await typeMessage(page, 'sub message');
        await selectRepo('');
        await expect(textarea(page)).toHaveValue('root message');
        await selectRepo('sub');
        await expect(textarea(page)).toHaveValue('sub message');
    });
    test('switching projects keeps each project\'s message', async ({ page }) => {
        await open(page, {}, { projects });
        await typeMessage(page, 'repo message');
        await openProject(page, projects[1], '/');
        await goTo(page, '/git-controller');
        await waitForFiles(page);
        await expect(textarea(page)).toHaveValue('');
        await typeMessage(page, 'other message');
        await openProject(page, projects[0], '/git-controller');
        await waitForFiles(page);
        await expect(textarea(page)).toHaveValue('repo message');
        await openProject(page, projects[1], '/git-controller');
        await waitForFiles(page);
        await expect(textarea(page)).toHaveValue('other message');
    });
});

test.describe('the tab shown is remembered per project', () => {
    const projects = [{ name: 'Repo', path: '/repo' }, { name: 'Other', path: '/other' }];
    const shownTab = page => manager(page).locator('webui-button[slot="tabs"][aria-current="true"]');
    // The saved tab is shown once the project's repos start loading, which is before its files are listed.
    const tabRestored = page => manager(page).evaluate(async el => { await el._restoringTab; });
    const openProject = async (page, project, startPage) => {
        await switchProject(page, project);
        await expect(page).toHaveURL(url => url.pathname === startPage);
        if (startPage !== '/git-controller') await goToPage(page, '/git-controller');
        await manager(page).locator('.files button.file').first().waitFor();
        await tabRestored(page);
    };

    test('the tab comes back after switching projects away and back, and each project keeps its own', async ({ page }) => {
        await open(page, {}, { projects });
        await openTab(page, 'Branches');
        await openProject(page, projects[1], '/');
        await expect(shownTab(page)).toHaveText('Commit');
        await openTab(page, 'Auth');
        await openProject(page, projects[0], '/git-controller');
        await expect(shownTab(page)).toHaveText('Branches');
        await openProject(page, projects[1], '/git-controller');
        await expect(shownTab(page)).toHaveText('Auth');
    });
    test('the tab is saved with the project, so it is shown after a restart', async ({ page }) => {
        await open(page, {}, { data: { _gitTab: 'tab-queue' } });
        await expect(shownTab(page)).toHaveText('Queue');
        await openTab(page, 'Commit');
        await expect.poll(() => page.evaluate(() => window.__backend.savedProjects['/repo'].data._gitTab)).toBe('tab-commit');
    });
    test('the saved tab is found by name when the Review tab moves the others', async ({ page }) => {
        await open(page, {}, { data: { _gitTab: 'tab-review' }, appData: { 'app-ai-integrations': { review: true } } });
        await expect(shownTab(page)).toHaveText('Review');
    });
    test('a saved tab that is no longer there falls back to the first tab', async ({ page }) => {
        // Review is off, so its tab is gone.
        await open(page, {}, { data: { _gitTab: 'tab-review' } });
        await tabRestored(page);
        await expect(manager(page).locator('webui-button[slot="tabs"]')).toHaveText(['Commit', 'Branches', 'Auth', 'Queue']);
        await expect(shownTab(page)).toHaveText('Commit');
    });
});

test.describe('commit messages AI wrote', () => {
    const AI = { providers: [{ id: 'p', name: 'Local', kind: 'openAi', baseUrl: 'http://localhost:11434/v1', models: [{ id: 'm', name: 'Model' }], hidden: [] }] };
    const withAi = { ai: AI, appData: { 'app-ai-integrations': { git: true } }, aiReplies: { git: 'Feature: Written while away' } };
    test('one that comes while another project is open says it will be in the box when that project opens', async ({ page }) => {
        await open(page, {}, withAi);
        const waiting = () => page.evaluate(() => webui.proxy.projects.loaded.size);
        const before = await waiting();
        await page.evaluate(() => {
            const original = window.__backend.handlers.ai_write;
            window.__backend.handlers.ai_write = args => new Promise(resolve => { window.__release = () => resolve(original(args)); });
        });
        await manager(page).locator('#ai-commit webui-button.ai-run').click();
        await expect.poll(() => page.evaluate(() => typeof window.__release)).toBe('function');
        await switchProject(page, { name: 'Other', path: '/other' });
        await goToPage(page, '/git-controller');
        await manager(page).locator('.files button.file').first().waitFor();
        await page.evaluate(() => window.__release());
        // Said by the Git Controller on screen, which shows the other project, so it is not read as written there.
        await expect(alertBox(page)).toHaveText('The commit message AI wrote is saved for Repo, and will be in its box when Repo is opened again.');
        await expect(messageBox(page)).toHaveValue('');
        await switchProject(page, { name: 'Repo', path: '/repo' });
        await goToPage(page, '/git-controller');
        await manager(page).locator('.files button.file').first().waitFor();
        await expect(messageBox(page)).toHaveValue('Feature: Written while away');
        // With no draft left waiting, it no longer waits for projects to load.
        await expect.poll(waiting).toBe(before);
    });
    test('one kept from before a restart is saved when its project opens, on whatever page it opens', async ({ page }) => {
        const other = { name: 'Other', path: '/other' };
        await open(page, {}, {
            projects: [{ name: 'Repo', path: '/repo' }, other],
            appData: { 'app-ai-pending-commit-messages': { '/other|': { path: '/other', repo: '', draft: 'Feature: From AI', before: '' } } },
        });
        await switchProject(page, other);
        await expect(page).toHaveURL(url => url.pathname === '/');
        await expect.poll(() => page.evaluate(() => webui.projectData.data._gitCommitMessages?.[''])).toBe('Feature: From AI');
        await expect.poll(() => page.evaluate(() => webui.getData('app-ai-pending-commit-messages'))).toBeFalsy();
    });
    test('one kept from before a restart is saved when the app starts on another page, with no Git Controller drawn', async ({ page }) => {
        await openApp(page, {
            currentPage: '/',
            appData: { 'app-ai-pending-commit-messages': { '/repo|': { path: '/repo', repo: '', draft: 'Feature: From AI', before: '' } } },
        }, '/');
        await expect.poll(() => page.evaluate(() => webui.projectData.data._gitCommitMessages?.[''])).toBe('Feature: From AI');
        await expect.poll(() => page.evaluate(() => webui.getData('app-ai-pending-commit-messages'))).toBeFalsy();
        await expect(manager(page)).toHaveCount(0);
    });
    test('one not used, since the message changed meanwhile, is said by the Git Controller showing its repo', async ({ page }) => {
        await open(page, {}, {
            appData: { 'app-ai-pending-commit-messages': { '/repo|': { path: '/repo', repo: '', draft: 'Feature: From AI', before: '' } } },
            data: { _gitCommitMessages: { '': 'Bug: Typed by hand' } },
        });
        await expect(alertBox(page)).toHaveText(/changed while AI was writing/);
        await expect(messageBox(page)).toHaveValue('Bug: Typed by hand');
        await expect(alertPopup(page, 'changed while AI was writing')).toHaveCount(0);
    });
});

test.describe('pending commit stats', () => {
    const lineStats = [
        { path: 'a.txt', additions: 10, deletions: 2, binary: false },
        { path: 'b.txt', additions: 5, deletions: 0, binary: false },
        { path: 'c.txt', additions: 0, deletions: 7, binary: false },
    ];
    const filesStat = page => manager(page).locator('#val-commit-files');
    const linesStat = page => manager(page).locator('#val-commit-lines');
    const setInclude = (page, file, value) => include(page, file).selectOption(value);

    test('files and lines for every included change are totalled', async ({ page }) => {
        await open(page, { lineStats });
        await expect(filesStat(page)).toHaveText('3 of 3');
        await expect(linesStat(page)).toHaveText('+15 -9');
    });
    test('excluded and ignored files are left out of the totals', async ({ page }) => {
        await open(page, { lineStats });
        await setInclude(page, 'a.txt', '0');
        await expect(filesStat(page)).toHaveText('2 of 3');
        await expect(linesStat(page)).toHaveText('+5 -7');
        await setInclude(page, 'c.txt', '2');
        await expect(filesStat(page)).toHaveText('1 of 3');
        await expect(linesStat(page)).toHaveText('+5 -0');
        await setInclude(page, 'a.txt', '1');
        await expect(linesStat(page)).toHaveText('+15 -2');
    });
    test('binary files are counted as files but not lines', async ({ page }) => {
        await open(page, { changes: ['M  a.txt', '?? image.png'], lineStats: [lineStats[0], { path: 'image.png', additions: 0, deletions: 0, binary: true }] });
        await expect(filesStat(page)).toHaveText('2 of 2');
        await expect(linesStat(page)).toHaveText('+10 -2 (1 binary file not counted)');
    });
    test('the totals use the new name of a renamed file', async ({ page }) => {
        await open(page, { changes: ['R  old.txt -> new.txt'], lineStats: [{ path: 'new.txt', additions: 1, deletions: 1, binary: false }] });
        await expect(linesStat(page)).toHaveText('+1 -1');
    });
    test('each file shows its size now, and how much it grew or shrank since the last commit', async ({ page }) => {
        await open(page, {
            changes: [' M a.txt', '?? new.txt', ' D gone.txt', ' M same.txt', 'R  old.txt -> moved.txt'],
            lineStats: [
                { path: 'a.txt', additions: 1, deletions: 0, binary: false, size: 3072, savedSize: 1024 },
                { path: 'new.txt', additions: 1, deletions: 0, binary: false, size: 512, savedSize: null },
                { path: 'gone.txt', additions: 0, deletions: 1, binary: false, size: null, savedSize: 2048 },
                { path: 'same.txt', additions: 1, deletions: 1, binary: false, size: 10, savedSize: 10 },
                { path: 'moved.txt', additions: 0, deletions: 0, binary: false, size: 2000, savedSize: 2500 },
            ],
        });
        const row = file => manager(page).locator(`.file-row[data-path="${file}"] button.file`);
        await expect(row('a.txt').locator('.size')).toHaveText('3 KB');
        await expect(row('a.txt').locator('.size-change')).toHaveText('+2 KB');
        await expect(row('new.txt').locator('.size')).toHaveText('512 Bytes');
        await expect(row('new.txt').locator('.size-change')).toHaveText('+512 Bytes');
        await expect(row('gone.txt').locator('.size')).toHaveCount(0);
        await expect(row('gone.txt').locator('.size-change')).toHaveText('-2 KB');
        await expect(row('same.txt').locator('.size-change')).toHaveText('±0 Bytes');
        await expect(row('moved.txt').locator('.size-change')).toHaveText('-500 Bytes');
    });
    test('without sizes from the backend, rows show none', async ({ page }) => {
        await open(page, { lineStats });
        await expect(manager(page).locator('.file-row .size, .file-row .size-change')).toHaveCount(0);
    });
    test('with nothing to commit, it says so', async ({ page }) => {
        await openApp(page, { currentPage: '/git-controller', git: { changes: [] } }, '/git-controller');
        await expect(filesStat(page)).toHaveText('No changes');
        await expect(linesStat(page)).toHaveText('');
    });
    test('if line counts fail, the file count still shows and there is no popup', async ({ page }) => {
        await openApp(page, { currentPage: '/git-controller', git: { changes: ['M  a.txt'] } }, '/git-controller');
        await onCommand(page, 'get_git_change_stats', () => { throw 'diff failed'; });
        await spyOnAlerts(page);
        await manager(page).locator('webui-button[label="Refresh"]').click();
        await expect(linesStat(page)).toHaveText('Unavailable');
        await expect(filesStat(page)).toHaveText('1 of 1');
        await expect.poll(() => alerts(page)).toEqual([]);
    });
    test('the files are listed before their line counts and sizes, which are added when they come', async ({ page }) => {
        await openApp(page, { currentPage: '/git-controller', git: { changes: ['M  a.txt', '?? b.txt', ' D c.txt'] } }, '/git-controller');
        await expect(filesStat(page)).toHaveText('3 of 3');
        await page.evaluate(stats => {
            window.__backend.handlers.get_git_change_stats = () => new Promise(resolve => {
                window.__releaseStats = () => resolve(stats.map(item => ({ ...item, size: 2048, savedSize: 1024 })));
            });
        }, lineStats);
        await manager(page).locator('webui-button[label="Refresh"]').click();
        await expect.poll(() => page.evaluate(() => typeof window.__releaseStats)).toBe('function');
        await expect(manager(page).locator('.file-row button.file .name')).toHaveText(['a.txt', 'b.txt', 'c.txt']);
        await expect(linesStat(page)).toHaveText('Counting');
        await page.evaluate(() => window.__releaseStats());
        await expect(linesStat(page)).toHaveText('+15 -9');
        await expect(manager(page).locator('.file-row[data-path="a.txt"] .size')).toHaveText('2 KB');
    });
    test('counts are refreshed with the file list', async ({ page }) => {
        await open(page, { lineStats });
        await expect(linesStat(page)).toHaveText('+15 -9');
        await page.evaluate(() => {
            window.__backend.git.changes = ['M  a.txt'];
            window.__backend.git.lineStats = [{ path: 'a.txt', additions: 1, deletions: 0, binary: false }];
        });
        await manager(page).locator('webui-button[label="Refresh"]').click();
        await expect(filesStat(page)).toHaveText('1 of 1');
        await expect(linesStat(page)).toHaveText('+1 -0');
    });
});

test.describe('file list', () => {
    const changes = ['M  src/app/main.cs', 'M  docs/main.cs', '?? src/app/new.cs', ' D old.txt'];
    const files = { 'src/app/main.cs': 'a', 'docs/main.cs': 'b', 'src/app/new.cs': 'c' };
    const openList = (page, git = {}) => open(page, { changes, ...git }, { files });
    const row = (page, path) => manager(page).locator(`.files .file-row[data-path="${path}"]`);
    const selected = page => manager(page).evaluate(el => el.shadowRoot.querySelector('.file-row.selected')?.dataset.path);

    test('files with the same name are told apart by their folder', async ({ page }) => {
        await openList(page);
        await expect(row(page, 'src/app/main.cs').locator('.folder')).toHaveText('src/app');
        await expect(row(page, 'docs/main.cs').locator('.folder')).toHaveText('docs');
        await expect(row(page, 'old.txt').locator('.folder')).toHaveCount(0);
    });
    test('the filter narrows the list, and Toggle All only changes the files shown', async ({ page }) => {
        await openList(page);
        await manager(page).locator('.file-filter').fill('src/');
        await expect(manager(page).locator('.files .file-row')).toHaveCount(2);
        await manager(page).locator('webui-button[label="Toggle All"]').click();
        await expect(manager(page).locator('#val-commit-files')).toHaveText('2 of 4');
        await expect(row(page, 'src/app/main.cs').locator('select')).toHaveValue('0');
        // Files the filter leaves out aren't drawn, and keep their choice.
        await expect(row(page, 'docs/main.cs')).toHaveCount(0);
        await manager(page).locator('.file-filter').fill('');
        await expect(manager(page).locator('.files .file-row')).toHaveCount(4);
        await expect(row(page, 'docs/main.cs').locator('select')).toHaveValue('1');
    });
    test('the first file opens, and the arrow keys move through the files shown', async ({ page }) => {
        await openList(page);
        await expect.poll(() => selected(page)).toBe('src/app/main.cs');
        await row(page, 'src/app/main.cs').locator('button.file').focus();
        await page.keyboard.press('ArrowDown');
        await expect.poll(() => selected(page)).toBe('docs/main.cs');
        await expect.poll(() => manager(page).evaluate(el => el._fileName.textContent)).toContain('docs');
        // With old.txt filtered out, new.cs is the last file shown, so Down stays put.
        await manager(page).locator('.file-filter').fill('.cs');
        await row(page, 'src/app/new.cs').locator('button.file').click();
        await expect.poll(() => selected(page)).toBe('src/app/new.cs');
        await page.keyboard.press('ArrowDown');
        // Up then goes to the file above new.cs, so Down moved nowhere.
        await page.keyboard.press('ArrowUp');
        await expect.poll(() => selected(page)).toBe('docs/main.cs');
        await expect(row(page, 'docs/main.cs').locator('button.file')).toBeFocused();
    });
    test('in a long list, a row with focus keeps it when the list is drawn again after measuring a row', async ({ page }) => {
        const many = Array.from({ length: 400 }, (_, i) => `M  file${i}.txt`);
        await open(page, { changes: many });
        const button = row(page, 'file2.txt').locator('button.file');
        await button.focus();
        await expect(button).toBeFocused();
        // A row's height changes after it is first drawn, as fonts and icons load, so the list is drawn twice.
        await manager(page).evaluate(el => {
            let measured = 0;
            el.rowPitch = () => (measured++ === 0 ? 30 : 40);
            el.drawFiles(true);
        });
        await expect(button).toBeFocused();
    });
    test('the open file stays open after a refresh', async ({ page }) => {
        await openList(page);
        await row(page, 'src/app/new.cs').locator('button.file').click();
        await expect.poll(() => selected(page)).toBe('src/app/new.cs');
        await refresh(page);
        await expect.poll(() => selected(page)).toBe('src/app/new.cs');
        await expect(manager(page).locator('.preview h2')).toHaveText('Add new.cs src/app');
    });
    test('a filter and include choices are applied to a refreshed list', async ({ page }) => {
        await openList(page);
        await manager(page).locator('.file-filter').fill('docs');
        await expect(manager(page).locator('.files .file-row')).toHaveCount(1);
        await refresh(page);
        await expect(manager(page).locator('#val-commit-files')).toHaveText('4 of 4');
        await expect(manager(page).locator('.files .file-row button.file')).toHaveAttribute('title', 'docs/main.cs');
    });
    // How the panes look is checked by eye. These check what a person can see and reach while using them.
    const scrollPageToBottom = page => page.evaluate(() => {
        const main = document.querySelector('webui-app').shadowRoot.querySelector('main');
        main.scrollTop = main.scrollHeight;
    });
    // Scrolling a long list, which draws only the rows in view, is checked in tests/browser.
    test('hundreds of files are listed, and the filter finds any of them', async ({ page }) => {
        const many = Array.from({ length: 600 }, (_, i) => `M  src/folder${i % 20}/file${i}.cs`);
        await openList(page, { changes: many });
        await expect(manager(page).locator('#val-commit-files')).toHaveText('600 of 600');
        await manager(page).locator('.file-filter').fill('file599.cs');
        await expect(manager(page).locator('.files .file-row button.file')).toHaveAttribute('title', 'src/folder19/file599.cs');
    });
});

test.describe('files that are not text', () => {
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const openWithImage = (page, change, stats) => open(page, { changes: [`${change}  logo.png`, 'M  a.txt'], lineStats: stats }, { binaryFiles: { 'logo.png': PNG } });
    const select = (page, file) => manager(page).locator(`.files button.file[title="${file}"]`).click();
    const preview = page => manager(page).locator('webui-file-preview');
    test('a modified file that cannot be read as text shows in the preview, without a warning', async ({ page }) => {
        // No line counts, so only reading the file shows it is not text.
        await openWithImage(page, 'M ', []);
        await select(page, 'logo.png');
        await expect(preview(page).locator('img')).toBeVisible();
        await expect(manager(page).locator('webui-alert[show]')).toHaveCount(0);
    });
    test('text files go back to the comparison', async ({ page }) => {
        await openWithImage(page, '??', [{ path: 'logo.png', additions: 0, deletions: 0, binary: true }]);
        await select(page, 'logo.png');
        await expect(preview(page).locator('img')).toBeVisible();
        await select(page, 'a.txt');
        await expect(preview(page)).toBeHidden();
        await expect(manager(page).locator('webui-content-compare')).toBeVisible();
        await expect(preview(page).locator('img')).toHaveCount(0);
    });
    test('a file too large to read as text is previewed instead, without a warning', async ({ page }) => {
        await open(page, { changes: ['M  huge.txt', 'M  a.txt'] }, { files: { 'huge.txt': 'line one' } });
        await onCommand(page, 'get_project_file', ({ filePath }) => {
            if (filePath === 'huge.txt') throw 'Get Project File: File is too large to show as text (20 MB or more)';
            return 'x';
        });
        await select(page, 'huge.txt');
        await expect(preview(page)).toBeVisible();
        await expect(preview(page)).toContainText('line one');
        await expect(manager(page).locator('webui-alert[show]')).toHaveCount(0);
    });
    test('the preview has no download link', async ({ page }) => {
        await openWithImage(page, '??', [{ path: 'logo.png', additions: 0, deletions: 0, binary: true }]);
        await select(page, 'logo.png');
        await expect(preview(page).locator('img')).toBeVisible();
        await expect(preview(page).locator('a')).toHaveCount(0);
    });
});

test.describe('before commit script', () => {
    const SCRIPT = 'PowerShell/Publish.ps1';
    const PUBLISH = `<#
.SYNOPSIS
Gets ready to publish.

.PARAMETER Version
Which part of the version to increment.
#>
[CmdletBinding()]
param(
    # A comment with a comma, and a $Fake variable.
    [ValidateSet('patch', 'minor', 'major')]
    [string]$Version = 'minor',
    [switch]$SkipMinify,
    [Parameter(Mandatory)][string]$Note,
    [string[]]$Tags,
    [int]$Count = 2,
    [bool]$Check = $true
)
function Inner { param($Ignored) }
Write-Host 'done'
`;
    const VALUES = { Version: 'major', SkipMinify: true, Note: "it's", Tags: 'a, b', Count: '3', Check: false };
    const WRAPPER = [
        `$ErrorActionPreference = 'Stop'`,
        `$PSNativeCommandUseErrorActionPreference = $true`,
        `$global:LASTEXITCODE = 0`,
        `& './PowerShell/Publish.ps1' -Version 'major' -SkipMinify -Note 'it''s' -Tags @('a', 'b') -Count 3 -Check:$false`,
        `if ($LASTEXITCODE) { exit $LASTEXITCODE }`,
        '',
    ].join('\n');
    const openWith = (page, data = {}, git = {}) => open(page, git, {
        scripts: [SCRIPT, 'other.ps1'],
        files: { [SCRIPT]: PUBLISH, 'other.ps1': 'Write-Host hi' },
        appData: { 'app-trusted-projects': ['/repo'] },
        data,
    });
    const saved = { _gitBeforeCommit: { scripts: { '': SCRIPT }, values: { [SCRIPT]: VALUES } } };
    const field = (page, name) => manager(page).locator(`.before-commit-params [data-param="${name}"]`);
    const drawerOpen = page => page.locator('webui-drawer.shared.open');
    // A webui-select opens its options as tiles, so an option is picked by opening it and clicking that tile.
    const pick = async (select, value) => {
        await select.locator('button[aria-haspopup]').click();
        await select.locator(`.tile[data-value="${value}"]`).click();
        await expect(select.locator('.panel')).toBeHidden();
    };
    const finish = (page, code) => page.evaluate(code => window.__backend.runs.end({ projectId: 'project-id', terminalId: 'Before Commit', code }), code);

    test('scripts are listed by their file names, with their paths as the tooltip', async ({ page }) => {
        await openWith(page);
        const select = manager(page).locator('#before-commit-script');
        await select.locator('button[aria-haspopup]').click();
        await expect(select.locator(`.tile[data-value="${SCRIPT}"] .name`)).toHaveText(SCRIPT.split('/').pop());
        await expect(select.locator(`.tile[data-value="${SCRIPT}"]`)).toHaveAttribute('title', SCRIPT);
        await select.locator(`.tile[data-value="${SCRIPT}"]`).click();
        await expect(select.locator('.pick-name')).toHaveText(SCRIPT.split('/').pop());
        await expect(select.locator('.pick')).toHaveAttribute('title', SCRIPT);
    });
    test('a chosen script shows a field for each of its parameters, and the choices are remembered', async ({ page }) => {
        await openWith(page);
        await pick(manager(page).locator('#before-commit-script'), SCRIPT);
        await expect(field(page, 'Version')).toHaveCount(1);
        await expect.poll(() => manager(page).locator('.before-commit-params [data-param]').evaluateAll(els => els.map(el => `${el.localName}:${el.dataset.param}`))).toEqual([
            'webui-select:Version', 'webui-toggle-icon:SkipMinify', 'webui-input-text:Note', 'webui-input-text:Tags', 'webui-input-text:Count', 'webui-toggle-icon:Check',
        ]);
        // Starting values come from the script's defaults.
        await expect.poll(() => field(page, 'Version').evaluate(el => el.value)).toBe('minor');
        await expect.poll(() => field(page, 'Check').evaluate(el => el.value)).toBe(true);
        await expect.poll(() => field(page, 'SkipMinify').evaluate(el => el.value)).toBe(false);
        await expect(field(page, 'Note')).toHaveAttribute('label', 'Note (required)');
        await expect(field(page, 'Count')).toHaveAttribute('placeholder', '2');
        await expect(field(page, 'Version')).toHaveAttribute('title', 'Which part of the version to increment.');
        await pick(field(page, 'Version'), 'major');
        await field(page, 'SkipMinify').click();
        await field(page, 'Note').locator('input').fill('hello');
        await expect.poll(async () => page.evaluate(() => window.__backend.savedProjects['/repo'].data._gitBeforeCommit)).toEqual({
            scripts: { '': SCRIPT },
            values: { [SCRIPT]: { Version: 'major', SkipMinify: true, Note: 'hello', Tags: '', Count: '', Check: true } },
        });
    });
    test('the saved script and values show when the Git Controller opens', async ({ page }) => {
        await openWith(page, saved);
        await expect.poll(() => manager(page).locator('#before-commit-script').evaluate(el => el.value)).toBe(SCRIPT);
        await expect.poll(() => field(page, 'Version').evaluate(el => el.value)).toBe('major');
        await expect.poll(() => field(page, 'SkipMinify').evaluate(el => el.value)).toBe(true);
        await expect.poll(() => field(page, 'Note').evaluate(el => el.value)).toBe("it's");
        await expect.poll(() => field(page, 'Check').evaluate(el => el.value)).toBe(false);
    });
    test('choosing Nothing stops running a script before commits', async ({ page }) => {
        await openWith(page, saved);
        await expect(field(page, 'Version')).toHaveCount(1);
        await pick(manager(page).locator('#before-commit-script'), '');
        await expect(manager(page).locator('.before-commit-params [data-param]')).toHaveCount(0);
        await expect.poll(async () => page.evaluate(() => window.__backend.savedProjects['/repo'].data._gitBeforeCommit?.scripts)).toEqual({});
        await commit(page);
        // A script would have run before the commit was made.
        await expect.poll(async () => (await calls(page, 'git_commit')).length).toBe(1);
        await expect.poll(() => calls(page, 'spawn_script')).toEqual([]);
    });
    test('commit runs the script first in the Terminals panel, then commits what it changed once it succeeds', async ({ page }) => {
        await openWith(page, saved);
        await expect(field(page, 'Version')).toHaveCount(1);
        await include(page, 'b.txt').selectOption('0');
        await commit(page);
        await expect.poll(async () => (await calls(page, 'spawn_script')).map(({ terminalId, scriptContent }) => ({ terminalId, scriptContent })))
            .toEqual([{ terminalId: 'Before Commit', scriptContent: WRAPPER }]);
        await expect(drawerOpen(page)).toHaveCount(1);
        await expect(page.locator('webui-drawer.shared app-terminal-view')).toHaveCount(1);
        // The commit waits on the script, which is running now, and only ends when the test ends it.
        await expect(commitState(page)).toHaveText('Running Publish.ps1');
        await expect.poll(() => calls(page, 'git_commit')).toEqual([]);
        // The script changes a file, which the refresh after it adds to the commit.
        await page.evaluate(() => window.__backend.git.changes.push(' M a.min.txt'));
        await finish(page, 0);
        // The file left out before the script stays out.
        await expect.poll(() => calls(page, 'git_commit')).toEqual([{ repo: '', files: ['a.txt', 'c.txt', 'a.min.txt'], message: 'msg' }]);
        await expect(drawerOpen(page)).toHaveCount(0);
    });
    test('a script that fails cancels the commit, and leaves its output showing', async ({ page }) => {
        await openWith(page, saved);
        await expect(field(page, 'Version')).toHaveCount(1);
        await commit(page);
        await expect.poll(async () => (await calls(page, 'spawn_script')).length).toBe(1);
        await finish(page, 1);
        // The commit has ended once it says how, so nothing more is sent after this.
        await expect(alertBox(page)).toContainText(`${SCRIPT} failed with exit code 1, so nothing was committed`);
        await expect(commitActions(page)).toHaveAttribute('data-state', 'ready');
        await expect.poll(() => calls(page, 'git_commit')).toEqual([]);
        await expect(drawerOpen(page)).toHaveCount(1);
        // The message stays, ready to try again.
        await expect(messageBox(page)).toHaveValue('msg');
    });
    test('a stopped script cancels the commit', async ({ page }) => {
        await openWith(page, saved);
        await expect(field(page, 'Version')).toHaveCount(1);
        await commit(page);
        await expect.poll(async () => (await calls(page, 'spawn_script')).length).toBe(1);
        await finish(page, null);
        await expect(alertBox(page)).toContainText('was stopped, so nothing was committed');
        await expect(commitActions(page)).toHaveAttribute('data-state', 'ready');
        await expect.poll(() => calls(page, 'git_commit')).toEqual([]);
    });
    test.describe('switching projects while the script runs', () => {
        const projects = [{ name: 'Repo', path: '/repo' }, { name: 'Other', path: '/other' }];
        const openBoth = page => open(page, {}, {
            projects,
            scripts: [SCRIPT],
            files: { [SCRIPT]: PUBLISH },
            appData: { 'app-trusted-projects': ['/repo'] },
            data: { ...saved, _gitIgnoreFiles: ['/c.txt'] },
        });
        const switchToOther = async page => {
            await spyOnAlerts(page, { variant: true });
            // The other project opens its last page, then the user goes to its Git Controller.
            await switchProject(page, projects[1]);
            await expect(page).toHaveURL(url => url.pathname === '/');
            await goToPage(page, '/git-controller');
            await manager(page).locator('.files button.file').first().waitFor();
        };

        test('the commit goes to the project the script started in', async ({ page }) => {
            await openBoth(page);
            await expect(field(page, 'Version')).toHaveCount(1);
            await include(page, 'b.txt').selectOption('0');
            await manager(page).evaluate(el => { el._toggleSync.value = true; });
            await commit(page);
            await expect.poll(async () => (await calls(page, 'spawn_script')).length).toBe(1);
            await switchToOther(page);
            await page.evaluate(() => window.__backend.git.changes.push(' M a.min.txt'));
            await finish(page, 0);
            // The file left out and the ignored file stay out, and the script's change goes in.
            await expect.poll(() => calls(page, 'git_commit')).toEqual([{ repo: '', files: ['a.txt', 'a.min.txt'], message: 'msg', project: '/repo' }]);
            // The files were read from that project just before committing. The open Git Controller can also be loading its own.
            await expect.poll(async () => {
                const order = await callOrder(page, 'get_git_changes', 'git_commit');
                const commitAt = order.findIndex(call => call.command === 'git_commit');
                return order.slice(0, commitAt).findLast(call => call.args.project);
            }).toEqual({ command: 'get_git_changes', args: { path: '', project: '/repo' } });
            // Sync after commit is on, so the project the script started in is synced, not the open one.
            await expect.poll(() => alerts(page)).toEqual([['Repo: Commit and Sync successful!', 'success']]);
            await expect.poll(() => calls(page, 'git_sync')).toEqual([{ repo: '', project: '/repo' }]);
            // The sent message is cleared from the project it was written in.
            await expect.poll(async () => (await calls(page, 'save_project_data')).filter(call => call.data.path === '/repo').at(-1)?.data.data._gitCommitMessages).toEqual({});
            await expect(page).toHaveURL(url => url.pathname === '/git-controller');
            await expect.poll(() => page.evaluate(() => webui.projectData.path)).toBe('/other');
        });
        test('without sync after commit, the project is only committed', async ({ page }) => {
            await openBoth(page);
            await expect(field(page, 'Version')).toHaveCount(1);
            await manager(page).evaluate(el => { el._toggleSync.value = false; });
            await commit(page);
            await expect.poll(async () => (await calls(page, 'spawn_script')).length).toBe(1);
            await switchToOther(page);
            await finish(page, 0);
            // The commit says how it ended once nothing is left to do, and a sync would have come before that.
            await expect.poll(() => alerts(page)).toEqual([['Repo: Commit successful.', 'success']]);
            await expect.poll(() => calls(page, 'git_sync')).toEqual([]);
        });
        test('a sync that fails after switching says why, and does not ask for a token for the open project', async ({ page }) => {
            await openBoth(page);
            await expect(field(page, 'Version')).toHaveCount(1);
            await manager(page).evaluate(el => { el._toggleSync.value = true; });
            await commit(page);
            await expect.poll(async () => (await calls(page, 'spawn_script')).length).toBe(1);
            await switchToOther(page);
            await onCommand(page, 'git_sync', () => { throw 'Credentials Missing/Invalid'; });
            await finish(page, 0);
            await expect.poll(() => alerts(page)).toEqual([['Repo: Commit successful. Syncing failed, so sync it from the Git Controller: Credentials Missing/Invalid', 'danger']]);
            await expect(dialogButton(page, 'Save & Retry')).toHaveCount(0);
        });
        test('a queued commit runs its script in its own project, even when another project is open by then', async ({ page }) => {
            await open(page, {}, {
                projects,
                scripts: [SCRIPT],
                files: { [SCRIPT]: PUBLISH },
                appData: { 'app-trusted-projects': ['/repo', '/other'], 'app-git-queue': true },
                data: saved,
            });
            await expect(field(page, 'Version')).toHaveCount(1);
            await commit(page, 'first');
            await expect.poll(async () => (await calls(page, 'spawn_script')).length).toBe(1);
            await page.evaluate(() => document.querySelector('webui-drawer.shared')?.classList.remove('open'));
            await switchToOther(page);
            // The other project runs the same script before its commits.
            await page.evaluate(saved => { webui.projectData.data._gitBeforeCommit = saved._gitBeforeCommit; }, saved);
            // Queue is remembered as on, and the other project's Git Controller shows it once it has its settings.
            await expect.poll(() => manager(page).evaluate(el => el._toggleQueue.value)).toBe(true);
            await commit(page, 'second');
            await expect(commitState(page)).toHaveText('Currently Queued');
            // Back in the first project, its script finishes, and the next commit's script starts in the other one.
            await switchProject(page, projects[0]);
            await finish(page, 0);
            await expect.poll(async () => (await calls(page, 'git_commit')).map(call => call.message)).toEqual(['first']);
            await expect.poll(async () => (await calls(page, 'spawn_script')).map(({ terminalId, project }) => ({ terminalId, project })))
                .toEqual([{ terminalId: 'Before Commit' }, { terminalId: 'Before Commit', project: '/other' }]);
            await page.evaluate(() => window.__backend.runs.end({ projectId: 'id-/other', terminalId: 'Before Commit', code: 0 }));
            await expect.poll(async () => (await calls(page, 'git_commit')).map(call => `${call.message}:${call.project ?? ''}`)).toEqual(['first:', 'second:/other']);
        });
        test('a script that fails after switching says which project it was for, and commits nothing', async ({ page }) => {
            await openBoth(page);
            await expect(field(page, 'Version')).toHaveCount(1);
            await commit(page);
            await expect.poll(async () => (await calls(page, 'spawn_script')).length).toBe(1);
            await switchToOther(page);
            await finish(page, 1);
            // The commit has ended once it says how, so nothing more is sent after this.
            await expect.poll(() => alerts(page)).toEqual([[`Repo: ${SCRIPT} failed with exit code 1, so nothing was committed. Its output is in the Terminals panel.`, 'danger']]);
            await expect.poll(() => calls(page, 'git_commit')).toEqual([]);
        });
    });
    test('Cancel stops the script, and nothing is committed, even when PowerShell exits with 0', async ({ page }) => {
        await openWith(page, saved);
        await expect(field(page, 'Version')).toHaveCount(1);
        await commit(page);
        await expect(commitState(page)).toHaveText('Running Publish.ps1');
        await expect(cancelCommit(page)).toHaveAttribute('label', 'Cancel');
        await page.evaluate(() => document.querySelector('webui-drawer.shared')?.classList.remove('open'));
        await cancelCommit(page).click();
        await expect.poll(async () => (await calls(page, 'commit_cancel')).length).toBe(1);
        // Rust stops the script the commit waits on, which marks the run stopped.
        await expect.poll(() => page.evaluate(() => webui.proxy.terminalHelpers.getState().terminals['Before Commit']?.stopped)).toBe(true);
        await finish(page, 0);
        await expect(alertBox(page)).toContainText('was stopped, so nothing was committed');
        await expect(commitActions(page)).toHaveAttribute('data-state', 'ready');
        await expect.poll(() => calls(page, 'git_commit')).toEqual([]);
    });
    test.describe('queue', () => {
        const repoDropdown = page => manager(page).locator('webui-select[label="Repo"]');
        /** Commits the root repo with Queue on, whose script then runs, and goes to the libs/api repo. */
        const startFirst = async page => {
            await openWith(page, saved, { repos: ['', 'libs/api'] });
            await expect(field(page, 'Version')).toHaveCount(1);
            await manager(page).locator('#toggle-queue').click();
            await expect.poll(() => manager(page).evaluate(el => el._toggleQueue.value)).toBe(true);
            await commit(page, 'first');
            await expect.poll(async () => (await calls(page, 'spawn_script')).length).toBe(1);
            await expect(commitState(page)).toHaveText('Running Publish.ps1');
            await page.evaluate(() => document.querySelector('webui-drawer.shared')?.classList.remove('open'));
            // The other repo's message and files load before a commit is typed for it.
            await markFiles(page);
            await pick(repoDropdown(page), 'libs/api');
            await expect.poll(() => repoDropdown(page).evaluate(el => el.value)).toBe('libs/api');
            await filesReloaded(page);
            await expect(commitActions(page)).toHaveAttribute('data-state', 'ready');
            await commit(page, 'second');
            await expect(commitState(page)).toHaveText('Currently Queued');
            await expect(cancelCommit(page)).toHaveAttribute('label', 'Cancel Queue');
        };

        test('a queued commit waits for the one before it, so commits run one at a time and in order', async ({ page }) => {
            // The first commit waits on its script, which only ends when the test ends it, and the second waits on the first.
            await startFirst(page);
            await expect.poll(() => calls(page, 'git_commit')).toEqual([]);
            await finish(page, 0);
            await expect.poll(async () => (await calls(page, 'git_commit')).map(call => `${call.repo}:${call.message}`)).toEqual([':first', 'libs/api:second']);
            await expect(commitActions(page)).toHaveAttribute('data-state', 'ready');
        });
        test('Cancel Queue takes a queued commit out, and the one running still commits', async ({ page }) => {
            await startFirst(page);
            await cancelCommit(page).click();
            await expect(commitActions(page)).toHaveAttribute('data-state', 'ready');
            await expect(manager(page).locator('webui-alert').first()).toContainText('taken out of the queue');
            await finish(page, 0);
            // With no commit left waiting or running, nothing more is committed.
            await expect(manager(page).locator('#tab-queue')).toHaveText('Queue');
            await expect.poll(async () => (await calls(page, 'git_commit')).map(call => call.repo)).toEqual(['']);
        });
        test('the Queue tab lists the running and queued commits, can cancel one, and shows how each ended', async ({ page }) => {
            await startFirst(page);
            await openTab(page, 'Queue');
            const view = manager(page).locator('.queue-view');
            await expect(manager(page).locator('#tab-queue')).toHaveText('Queue (2)');
            await expect(view.locator('tbody tr')).toHaveCount(2);
            await expect(view.locator('tbody tr').nth(0).locator('td')).toHaveText(['Repo', 'Root', 'first', SCRIPT, 'No', 'Running Publish.ps1', /^\s*Cancel\s*$/]);
            await expect(view.locator('tbody tr').nth(1).locator('.queue-state')).toHaveText('Queued, next');
            await view.locator('tbody tr').nth(1).locator('webui-button', { hasText: 'Cancel Queue' }).click();
            await expect(manager(page).locator('#tab-queue')).toHaveText('Queue (1)');
            await finish(page, 0);
            await expect(manager(page).locator('#tab-queue')).toHaveText('Queue');
            await expect(view).toContainText('No commits are queued or running');
            await expect(view.locator('table').last().locator('.queue-state')).toHaveText(['CommittedCommit successful.', 'CancelledTaken out of the queue.']);
        });
        test('a Cancel in the queue that fails says why under the queue, until another Cancel is pressed', async ({ page }) => {
            await startFirst(page);
            await openTab(page, 'Queue');
            const view = manager(page).locator('.queue-view');
            await page.evaluate(() => { window.__backend.handlers.commit_cancel = () => { throw 'The commit could not be cancelled.'; }; });
            await view.locator('tbody tr').nth(1).locator('webui-button', { hasText: 'Cancel Queue' }).click();
            const note = actionNote(manager(page), 'The commit could not be cancelled.');
            await expect(note).toHaveCount(1);
            // A click elsewhere in the queue leaves it.
            await view.locator('tbody tr').nth(1).locator('td').first().click();
            await expect(note).toHaveCount(1);
            await page.evaluate(() => { window.__backend.handlers.commit_cancel = () => true; });
            await view.locator('tbody tr').nth(1).locator('webui-button', { hasText: 'Cancel Queue' }).click();
            await expect(note).toHaveCount(0);
        });
        test('a Cancel that finds nothing left to stop says so, in the queue and by the Cancel button', async ({ page }) => {
            await startFirst(page);
            await openTab(page, 'Queue');
            const view = manager(page).locator('.queue-view');
            await page.evaluate(() => { window.__backend.handlers.commit_cancel = () => false; });
            await view.locator('tbody tr').nth(1).locator('webui-button', { hasText: 'Cancel Queue' }).click();
            await expect(actionNote(manager(page), 'That commit was already being made or had finished, so there was nothing to cancel.')).toHaveCount(1);
            await openTab(page, 'Commit');
            await cancelCommit(page).click();
            await expect(alertBox(page)).toHaveText('That commit was already being made or had finished, so there was nothing to cancel.');
        });
        test('the queue is remembered as on or off', async ({ page }) => {
            await open(page, {}, { appData: { 'app-git-queue': true } });
            await expect.poll(() => manager(page).evaluate(el => el._toggleQueue.value)).toBe(true);
        });
    });
    test('a required parameter must be filled in before the script runs', async ({ page }) => {
        await openWith(page, { _gitBeforeCommit: { scripts: { '': SCRIPT }, values: { [SCRIPT]: { ...VALUES, Note: ' ' } } } });
        await expect(field(page, 'Version')).toHaveCount(1);
        await commit(page);
        await expect(alertBox(page)).toContainText(`Fill in Note for ${SCRIPT}`);
        await expect.poll(() => calls(page, 'commit_enqueue')).toEqual([]);
        await expect.poll(() => calls(page, 'spawn_script')).toEqual([]);
        await expect.poll(() => calls(page, 'git_commit')).toEqual([]);
    });
    test('a script from a project that is not trusted yet asks first', async ({ page }) => {
        await open(page, {}, { scripts: [SCRIPT], files: { [SCRIPT]: PUBLISH }, data: saved });
        await expect(field(page, 'Version')).toHaveCount(1);
        await commit(page);
        await expect(dialogButton(page, 'Trust Project & Run')).toBeVisible();
        await dialogButton(page, 'Cancel').click();
        await expect(openDialog(page)).toHaveCount(0);
        // Commit only takes another click once the commit before it has been given up, so it asking again shows that.
        await manager(page).locator('webui-button[label="Commit"]').click();
        await expect(dialogButton(page, 'Trust Project & Run')).toBeVisible();
        await expect.poll(() => calls(page, 'commit_enqueue')).toEqual([]);
        await expect.poll(() => calls(page, 'spawn_script')).toEqual([]);
        await expect.poll(() => calls(page, 'git_commit')).toEqual([]);
    });
});

test.describe('plugin branch cards', () => {
    const card = {
        id: 'jira', name: 'Jira',
        card: { type: 'stack', children: [
            { type: 'row', children: [
                { type: 'badge', text: 'In Progress', theme: 'info' },
                { type: 'link', text: 'PJ-3', action: { id: 'open', label: 'Open PJ-3', params: { key: 'PJ-3' } } },
                { type: 'text', text: 'Fix login' },
            ] },
            { type: 'text', text: 'Assigned to Sam Lee', muted: true },
        ] },
    };

    test("a plugin's card about the current branch shows, and its link opens the plugin page", async ({ page }) => {
        await open(page, {}, {
            branchCards: [card, { id: 'other', name: 'Other', error: 'offline' }],
            plugins: [{ id: 'jira', version: '0.1.0', enabled: true, signed: true, manifest: { id: 'jira', name: 'Jira', version: '0.1.0', apiVersion: 1, pages: [{ id: 'issue', name: 'Issue', hidden: true }] } }],
            pluginActions: { 'jira/open': { navigate: { page: 'issue', params: { key: 'PJ-3' } } } },
            pluginPages: { 'jira/issue': { type: 'text', text: 'Issue page' } },
        });
        const cards = manager(page).locator('#plugin-branch-cards app-plugin-page');
        await expect(cards).toHaveCount(1);
        await expect(cards).toContainText('In Progress');
        await expect(cards).toContainText('Assigned to Sam Lee');
        await cards.getByText('PJ-3').click();
        await expect(page).toHaveURL(/\/plugin\/jira\/issue\?key=PJ-3$/);
        await expect(page.locator('app-plugin-page')).toHaveText('Issue page');
    });

    test('a plugin installed or updated shows its card about the branch without reloading the app', async ({ page }) => {
        await open(page);
        await expect.poll(async () => (await calls(page, 'plugin_branch_info')).length).toBeGreaterThan(0);
        await page.evaluate(card => { window.__backend.handlers.plugin_branch_info = () => [card]; }, card);
        await emit(page, 'plugins-changed', { id: 'jira' });
        await expect(manager(page).locator('#plugin-branch-cards app-plugin-page')).toContainText('Assigned to Sam Lee');
    });

    test('with no plugin cards, nothing extra shows', async ({ page }) => {
        await open(page);
        await expect.poll(async () => (await calls(page, 'plugin_branch_info')).length).toBeGreaterThan(0);
        await expect(manager(page).locator('#plugin-branch-cards app-plugin-page')).toHaveCount(0);
    });
});

test.describe('files that show something when drawn', () => {
    const select = (page, file) => manager(page).locator(`.files .file-row[data-path="${file}"] button.file`).click();
    const toggle = page => manager(page).locator('.render-toggle');
    const frame = page => manager(page).locator('iframe.rendered');
    const files = {
        'README.md': '# Title\n\n**Bold** <script>window.parent.__hacked = 1</script><img src="x" onerror="window.parent.__hacked = 2">\n\n<webui-page-segment>Segment text</webui-page-segment>',
        'icons/star.webui': 'WEBUI-ICON-STAR\nM0 -80Q20 -20 80 0Q20 20 0 80Q-20 20 -80 0Q-20 -20 0 -80z',
        'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><circle cx="5" cy="5" r="4"/></svg>',
        'page.html': '<h1 onclick="x()">Hi</h1><iframe src="https://example.com"></iframe>',
    };
    const openDrawn = page => open(page, { changes: ['?? README.md', '?? icons/star.webui', '?? logo.svg', '?? page.html', 'M  a.txt'] }, { files });

    test('markdown switches between its changes and a sandboxed preview that runs nothing from it', async ({ page }) => {
        await openDrawn(page);
        await select(page, 'README.md');
        await expect(toggle(page)).toBeVisible();
        // Raw, the comparison, comes first.
        await expect(toggle(page).getByRole('button', { name: 'Raw', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await expect(manager(page).locator('webui-content-compare')).toBeVisible();
        await expect(frame(page)).toBeHidden();
        await toggle(page).getByRole('button', { name: 'Preview', exact: true }).click();
        await expect(frame(page)).toBeVisible();
        await expect(manager(page).locator('webui-content-compare')).toBeHidden();
        // The frame may run no scripts, and its page allows none either.
        await expect(frame(page)).toHaveAttribute('sandbox', '');
        await expect(frame(page)).toHaveAttribute('srcdoc', /default-src 'none'/);
        // Images and videos from websites load, as they do on pages.
        await expect(frame(page)).toHaveAttribute('srcdoc', /img-src data: https:;/);
        await expect(frame(page)).toHaveAttribute('srcdoc', /media-src https:;/);
        await expect(frame(page)).not.toHaveAttribute('srcdoc', /<script/);
        await expect(frame(page)).not.toHaveAttribute('srcdoc', /onerror/);
        const doc = page.frameLocator('app-git-manager iframe.rendered');
        await expect(doc.locator('h1')).toHaveText('Title');
        await expect(doc.locator('strong')).toHaveText('Bold');
        await expect(doc.locator('webui-page-segment')).toHaveText('Segment text');
        await expect.poll(() => page.evaluate(() => window.__hacked)).toBeUndefined();
        // The choice stays for the next file that can be drawn, and files that cannot hide the switch.
        await select(page, 'page.html');
        await expect(doc.locator('h1')).toHaveText('Hi');
        await expect(frame(page)).not.toHaveAttribute('srcdoc', /onclick/);
        await expect(frame(page)).not.toHaveAttribute('srcdoc', /<iframe/);
        await select(page, 'a.txt');
        await expect(toggle(page)).toBeHidden();
        await expect(frame(page)).toBeHidden();
        await expect(manager(page).locator('webui-content-compare')).toBeVisible();
        await select(page, 'README.md');
        await expect(frame(page)).toBeVisible();
        await toggle(page).getByRole('button', { name: 'Raw', exact: true }).click();
        await expect(frame(page)).toBeHidden();
        await expect(manager(page).locator('webui-content-compare')).toBeVisible();
    });

    test('an SVG is drawn as an image, and a Web UI icon by the icon component at several sizes', async ({ page }) => {
        await openDrawn(page);
        await select(page, 'logo.svg');
        await toggle(page).getByRole('button', { name: 'Preview', exact: true }).click();
        await expect(frame(page)).toHaveAttribute('srcdoc', /<img alt="" src="data:image\/svg\+xml;base64,/);
        await expect(frame(page)).not.toHaveAttribute('srcdoc', /<script/);
        await select(page, 'icons/star.webui');
        await expect(frame(page)).toBeHidden();
        const icons = manager(page).locator('.icon-preview webui-icon');
        await expect(icons).toHaveCount(12);
        await expect.poll(() => icons.first().evaluate(icon => icon._definition)).toContain('WEBUI-ICON-STAR');
    });
});
