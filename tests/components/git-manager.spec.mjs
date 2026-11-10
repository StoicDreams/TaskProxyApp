import { test, expect, openApp, calls, onCommand, dialogButton } from '../support/app.mjs';

const open = async (page, git = {}, state = {}) => {
    await openApp(page, { currentPage: '/git-controller', git: { changes: ['M  a.txt', '?? b.txt', ' D c.txt'], ...git }, ...state, files: { 'a.txt': 'one', 'b.txt': 'two', ...(state.files || {}) } }, '/git-controller');
    await page.locator('app-git-manager .files button.file').first().waitFor();
};
const manager = page => page.locator('app-git-manager');
const commit = async (page, message = 'msg') => {
    // On a slow load the textarea can take text before the component listens to it, so fill until it has the message.
    await expect(async () => {
        await manager(page).locator('webui-input-message[label="Commit Message"] textarea').fill(message);
        expect(await manager(page).evaluate(el => el._message.value)).toBe(message);
    }).toPass({ timeout: 5000 });
    await manager(page).locator('webui-button[label="Commit"]').click();
};
// A click on a tab is ignored until the tabs have loaded, so click until the branch list shows.
const openBranches = page => expect(async () => {
    await manager(page).locator('webui-button[slot="tabs"]', { hasText: 'Branches' }).click();
    await expect(manager(page).locator('webui-button.btn-switch').first()).toBeVisible({ timeout: 1000 });
}).toPass({ timeout: 10000 });
// Rows are found by data-path, because Web UI moves title into aria-label once the mouse is over it.
const include = (page, file) => manager(page).locator(`.files .file-row[data-path="${file}"] select.include`);

test('changes are listed with their type', async ({ page }) => {
    await open(page);
    await expect(manager(page).locator('.files button.file[title="a.txt"]')).toContainText('Modify');
    await expect(manager(page).locator('.files button.file[title="b.txt"]')).toContainText('Add');
    await expect(manager(page).locator('.files button.file[title="c.txt"]')).toContainText('Delete');
});
test('commit sends the included files, and does not push unless asked', async ({ page }) => {
    await open(page);
    await commit(page);
    await expect.poll(async () => (await calls(page, 'git_commit')).length).toBe(1);
    expect((await calls(page, 'git_commit'))[0]).toEqual({ repo: '', files: ['a.txt', 'b.txt', 'c.txt'], message: 'msg' });
    await page.waitForTimeout(200);
    expect(await calls(page, 'git_sync')).toEqual([]);
});
test('sync after commit syncs when switched on', async ({ page }) => {
    await open(page, {}, { appData: { 'app-git-autosync': true } });
    await commit(page);
    await expect.poll(async () => (await calls(page, 'git_sync')).length).toBe(1);
});
test('a commit needs a message', async ({ page }) => {
    await open(page);
    await commit(page, '   ');
    await page.waitForTimeout(100);
    expect(await calls(page, 'git_commit')).toEqual([]);
});
test('a commit with nothing selected is refused', async ({ page }) => {
    await open(page);
    await manager(page).locator('webui-button[label="Toggle All"]').click();
    await commit(page);
    await page.waitForTimeout(100);
    expect(await calls(page, 'git_commit')).toEqual([]);
    await expect(manager(page).locator('webui-alert').first()).toContainText('Select at least one file');
});
test('excluded files are left out of the commit', async ({ page }) => {
    await open(page);
    await include(page, 'b.txt').selectOption('0');
    await commit(page);
    await expect.poll(async () => (await calls(page, 'git_commit')).length).toBe(1);
    expect((await calls(page, 'git_commit'))[0].files).toEqual(['a.txt', 'c.txt']);
});
test('files marked ignore stay out of later commits', async ({ page }) => {
    await open(page, {}, { data: { _gitIgnoreFiles: ['/b.txt'] } });
    await commit(page);
    await expect.poll(async () => (await calls(page, 'git_commit')).length).toBe(1);
    expect((await calls(page, 'git_commit'))[0].files).toEqual(['a.txt', 'c.txt']);
});
test('marking a file ignored is stored with the project', async ({ page }) => {
    await open(page);
    await include(page, 'a.txt').selectOption('2');
    expect(await page.evaluate(() => webui.projectData.data._gitIgnoreFiles)).toEqual(['/a.txt']);
    await expect.poll(async () => (await calls(page, 'sync_project_data')).at(-1)?.data.data._gitIgnoreFiles).toEqual(['/a.txt']);
});
test('markup in a file name is shown as text', async ({ page }) => {
    const name = 'x<img src=q onerror="window.__xss=1">.txt';
    await open(page, { changes: [`M  ${name}`] }, { files: { [name]: 'x' } });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    await expect(manager(page).locator('.files img')).toHaveCount(0);
    await expect(manager(page).locator('h3 img')).toHaveCount(0);
});
test('markup in a branch name is shown as text', async ({ page }) => {
    await open(page, { branches: [{ name: 'main', isCurrent: true, updatedDate: '' }, { name: '<img/src=q/onerror=window.__xss=1>', isCurrent: false, updatedDate: '' }] });
    await openBranches(page);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    await expect(manager(page).locator('webui-table img')).toHaveCount(0);
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
    await openApp(page, { project: { name: 'Repo', path: '/repo' } });
    await onCommand(page, 'get_project_file', () => { throw 'Failed to load file: stream did not contain valid UTF-8'; });
    await onCommand(page, 'get_project_file_base64', () => 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=');
    await page.evaluate(() => {
        window.__alerts = [];
        const original = webui.alert;
        webui.alert = function (...args) { window.__alerts.push(args); return original.apply(this, args); };
        window.__backend.git.changes = ['M  logo.png'];
        webui.navigateTo('/git-controller');
    });
    await page.locator('app-git-manager .files button.file').first().waitFor();
    // It shows in the file preview instead, with no warning.
    await expect(manager(page).locator('webui-file-preview')).toBeVisible();
    await expect(manager(page).locator('webui-alert').first()).not.toContainText('valid UTF-8');
    expect(await page.evaluate(() => window.__alerts)).toEqual([]);
});
test('a slow diff cannot replace the file selected after it', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
        const original = window.__backend.handlers.get_git_file_diff;
        window.__backend.handlers.get_git_file_diff = async args => {
            if (args.file === 'a.txt') await new Promise(resolve => setTimeout(resolve, 400));
            return original(args);
        };
    });
    await manager(page).locator('.files button.file[title="a.txt"]').click();
    await manager(page).locator('.files button.file[title="b.txt"]').click();
    await page.waitForTimeout(700);
    await expect.poll(() => manager(page).evaluate(el => el._fileName.textContent)).toContain('b.txt');
});
test('reverting a modified file restores it, and removing a new file deletes it', async ({ page }) => {
    await open(page);
    await manager(page).locator('.files button.revert[title="Revert changes to this file"]').first().click();
    await dialogButton(page, 'Revert').click();
    await expect.poll(async () => (await calls(page, 'git_restore_file')).length).toBe(1);
    expect((await calls(page, 'git_restore_file'))[0]).toEqual({ repo: '', file: 'a.txt' });
    await manager(page).locator('.files button.revert[title="Delete new file"]').first().click();
    await dialogButton(page, 'Delete').click();
    await expect.poll(async () => (await calls(page, 'git_delete_file')).length).toBe(1);
});
test('revert all asks first', async ({ page }) => {
    await open(page);
    await manager(page).locator('#btn-revert-all').click();
    expect(await calls(page, 'git_restore_all')).toEqual([]);
    await dialogButton(page, 'Revert All').click();
    await expect.poll(async () => (await calls(page, 'git_restore_all')).length).toBe(1);
});
test('branches cannot change with uncommitted work', async ({ page }) => {
    await open(page, { branches: [{ name: 'main', isCurrent: true, updatedDate: '' }, { name: 'other', isCurrent: false, updatedDate: '' }] });
    await openBranches(page);
    await manager(page).locator('webui-button.btn-switch').click();
    await page.waitForTimeout(100);
    expect(await calls(page, 'git_switch_branch')).toEqual([]);
    await expect(manager(page).locator('webui-alert').first()).toContainText('uncommitted changes');
});
test('deleting a remote branch says so', async ({ page }) => {
    await open(page, { branches: [{ name: 'main', isCurrent: true, updatedDate: '' }, { name: 'origin/old', isCurrent: false, updatedDate: '' }] });
    await openBranches(page);
    await manager(page).locator('webui-button.btn-delete').click();
    // Scoped to the dialog, because the page's help text also mentions the remote.
    await expect(page.locator('dialog').getByText('from the remote')).toBeVisible();
});
test('pull, push, sync, and fetch call the backend', async ({ page }) => {
    await open(page);
    for (const [label, command] of [['Pull', 'git_pull'], ['Push', 'git_push'], ['Sync', 'git_sync'], ['Fetch', 'git_fetch']]) {
        const before = (await calls(page, command)).length;
        await manager(page).locator(`webui-button[label="${label}"]`).click();
        await expect.poll(async () => (await calls(page, command)).length, label).toBeGreaterThan(before);
    }
});
test('a saved token shows masked, and only reaches the project', async ({ page }) => {
    await open(page);
    await manager(page).locator('#tab-remote').click();
    await manager(page).locator('input#input-git-pat').fill('abcdefghijkl');
    await manager(page).locator('#btn-save-pat').click();
    await expect.poll(() => page.evaluate(() => webui.getProjectData('git_pat'))).toBe('abcdefghijkl');
    expect(await page.evaluate(() => webui.getData('git_pat'))).toBeUndefined();
    await expect(manager(page).locator('input#input-git-pat')).toHaveAttribute('placeholder', 'abc***jkl');
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
        await expect(page.locator('dialog[open]')).toContainText("Create New Branch from 'other'");
        await dialogButton(page, 'Create').click();
        await expect(page.locator('dialog[open]')).toContainText('Branch name cannot be empty.');
        expect(await calls(page, 'git_create_branch')).toEqual([]);
        await page.locator('dialog[open] webui-input-text[name="branchName"] input').fill('  feature  ');
        await dialogButton(page, 'Create').click();
        await expect.poll(async () => (await calls(page, 'git_create_branch'))).toEqual([{ repo: '', branch: 'feature', baseBranch: 'other' }]);
        await expect(manager(page).locator('webui-alert').first()).toContainText('Branch created.');
    });
    test('a new branch cannot be made with uncommitted work', async ({ page }) => {
        await open(page, { branches, currentBranch: 'main' });
        await openBranches(page);
        await row(page, 'other').and(page.locator('.btn-new')).click();
        await expect(manager(page).locator('webui-alert').first()).toContainText('uncommitted changes');
        await expect(page.locator('dialog[open]')).toHaveCount(0);
    });
    test('merging asks first, naming both branches', async ({ page }) => {
        await openClean(page);
        await row(page, 'other').and(page.locator('.btn-merge')).click();
        await expect(page.locator('dialog[open]')).toContainText('merge other into the current branch (main)');
        await dialogButton(page, 'Cancel').click();
        await page.waitForTimeout(100);
        expect(await calls(page, 'git_merge_branch')).toEqual([]);
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
        await expect(page.locator('dialog[open]')).toContainText('Merge conflicts in a.txt');
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
        await expect(page.locator('dialog[open]')).toContainText('delete the branch other?');
        await expect(page.locator('dialog[open]')).not.toContainText('from the remote');
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
    test('with nothing changed, there is nothing to stash', async ({ page }) => {
        await openApp(page, { currentPage: '/git-controller', git: { changes: [] } }, '/git-controller');
        await expect(manager(page).locator('#val-commit-files')).toHaveText('No changes');
        await manager(page).locator('#btn-stash').click();
        await expect(manager(page).locator('webui-alert').first()).toContainText('No pending changes to stash.');
        expect(await calls(page, 'git_stash')).toEqual([]);
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
        await expect(page.locator('dialog[open]')).toContainText('overwrite all local changes');
        await dialogButton(page, 'Cancel').click();
        await page.waitForTimeout(100);
        expect(await calls(page, 'git_pull_overwrite')).toEqual([]);
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
    const textarea = page => manager(page).locator('webui-input-message[label="Commit Message"] textarea');
    const typeMessage = (page, message) => expect(async () => {
        await textarea(page).fill(message);
        expect(await manager(page).evaluate(el => el._message.value)).toBe(message);
    }).toPass({ timeout: 5000 });
    const waitForFiles = page => manager(page).locator('.files button.file').first().waitFor();
    const goTo = async (page, path) => {
        await page.evaluate(path => webui.navigateTo(path), path);
        await page.waitForURL(`**${path}`);
    };
    // Loading a project opens its last page shortly after, so wait for that page.
    const switchProject = async (page, path, name, startPage) => {
        await page.evaluate(([path, name]) => webui.setData('app-current-project', { value: path, display: name }), [path, name]);
        await expect.poll(() => page.evaluate(() => webui.projectData.path)).toBe(path);
        await expect.poll(() => page.evaluate(() => location.pathname)).toBe(startPage);
        await page.waitForTimeout(100);
    };
    const projects = [{ name: 'Repo', path: '/repo' }, { name: 'Other', path: '/other' }];

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
        await expect.poll(async () => (await calls(page, 'sync_project_data')).some(call => call.data.data._gitCommitMessages?.[''] === 'saved for later')).toBe(true);
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
        expect(await page.evaluate(() => webui.projectData.data._gitCommitMessages[''])).toBeUndefined();
    });
    test('a failed commit keeps the message', async ({ page }) => {
        await open(page);
        await onCommand(page, 'git_commit', () => { throw 'Commit failed'; });
        await typeMessage(page, 'try again');
        await manager(page).locator('webui-button[label="Commit"]').click();
        await expect.poll(async () => (await calls(page, 'git_commit')).length).toBe(1);
        await page.waitForTimeout(200);
        await expect(textarea(page)).toHaveValue('try again');
        expect(await page.evaluate(() => webui.projectData.data._gitCommitMessages[''])).toBe('try again');
    });
    test('each repo keeps its own message', async ({ page }) => {
        await open(page, { repos: ['', 'sub'] });
        await typeMessage(page, 'root message');
        const selectRepo = repo => manager(page).locator('webui-dropdown[label="Repo"]').evaluate((el, repo) => {
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
        await switchProject(page, '/other', 'Other', '/');
        await goTo(page, '/git-controller');
        await waitForFiles(page);
        await expect(textarea(page)).toHaveValue('');
        await typeMessage(page, 'other message');
        await switchProject(page, '/repo', 'Repo', '/git-controller');
        await waitForFiles(page);
        await expect(textarea(page)).toHaveValue('repo message');
        await switchProject(page, '/other', 'Other', '/git-controller');
        await waitForFiles(page);
        await expect(textarea(page)).toHaveValue('other message');
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
    test('with nothing to commit, it says so', async ({ page }) => {
        await openApp(page, { currentPage: '/git-controller', git: { changes: [] } }, '/git-controller');
        await expect(filesStat(page)).toHaveText('No changes');
        await expect(linesStat(page)).toHaveText('');
    });
    test('if line counts fail, the file count still shows and there is no popup', async ({ page }) => {
        await openApp(page, { currentPage: '/git-controller', git: { changes: ['M  a.txt'] } }, '/git-controller');
        await onCommand(page, 'get_git_change_stats', () => { throw 'diff failed'; });
        await page.evaluate(() => {
            window.__alerts = [];
            const original = webui.alert;
            webui.alert = function (...args) { window.__alerts.push(args); return original.apply(this, args); };
        });
        await manager(page).locator('webui-button[label="Refresh"]').click();
        await expect(linesStat(page)).toHaveText('Unavailable');
        await expect(filesStat(page)).toHaveText('1 of 1');
        expect(await page.evaluate(() => window.__alerts)).toEqual([]);
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
    // Loading the project reopens its start page shortly after startup, which replaces the component,
    // so wait for one that stays before interacting with it.
    const openList = async (page, git = {}) => {
        await open(page, { changes, ...git }, { files });
        await expect(async () => {
            await manager(page).evaluate(el => { el.__marker ??= Math.random(); window.__marker = el.__marker; });
            await page.waitForTimeout(400);
            expect(await manager(page).evaluate(el => el.__marker === window.__marker)).toBe(true);
        }).toPass({ timeout: 10000 });
        await manager(page).locator('.files button.file').first().waitFor();
    };
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
        await expect(manager(page).locator('.files .file-row:not([hidden])')).toHaveCount(2);
        await manager(page).locator('webui-button[label="Toggle All"]').click();
        await expect(manager(page).locator('#val-commit-files')).toHaveText('2 of 4');
        await expect(row(page, 'src/app/main.cs').locator('select')).toHaveValue('0');
        await expect(row(page, 'docs/main.cs').locator('select')).toHaveValue('1');
        await manager(page).locator('.file-filter').fill('');
        await expect(manager(page).locator('.files .file-row:not([hidden])')).toHaveCount(4);
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
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(100);
        expect(await selected(page)).toBe('src/app/new.cs');
        await page.keyboard.press('ArrowUp');
        await expect.poll(() => selected(page)).toBe('docs/main.cs');
    });
    test('the open file stays open after a refresh', async ({ page }) => {
        await openList(page);
        await row(page, 'src/app/new.cs').locator('button.file').click();
        await expect.poll(() => selected(page)).toBe('src/app/new.cs');
        await manager(page).locator('webui-button[label="Refresh"]').click();
        await expect.poll(async () => (await calls(page, 'get_git_changes')).length).toBeGreaterThan(1);
        await page.waitForTimeout(200);
        expect(await selected(page)).toBe('src/app/new.cs');
    });
    test('a filter and include choices are applied to a refreshed list', async ({ page }) => {
        await openList(page);
        await manager(page).locator('.file-filter').fill('docs');
        await manager(page).locator('webui-button[label="Refresh"]').click();
        await expect.poll(async () => (await calls(page, 'get_git_changes')).length).toBeGreaterThan(1);
        await page.waitForTimeout(200);
        await expect(manager(page).locator('.files .file-row:not([hidden])')).toHaveCount(1);
    });
    test('the file list and preview fill the window and scroll on their own', async ({ page }) => {
        await page.setViewportSize({ width: 1400, height: 800 });
        const many = Array.from({ length: 150 }, (_, i) => `M  src/file${i}.cs`);
        await openList(page, { changes: many });
        const layout = () => manager(page).evaluate(el => {
            const root = el.shadowRoot;
            let scroller = el.assignedSlot || el.parentElement;
            while (scroller && !['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)) scroller = scroller.assignedSlot || scroller.parentElement || scroller.getRootNode().host;
            const files = root.querySelector('.files');
            const panes = root.querySelector('.commit-panes').getBoundingClientRect();
            return {
                listScrolls: files.scrollHeight > files.clientHeight,
                panesBottom: Math.round(panes.bottom),
                visibleBottom: Math.round(scroller.getBoundingClientRect().bottom),
                pageScroll: scroller.scrollTop,
            };
        });
        await expect.poll(async () => (await layout()).listScrolls).toBe(true);
        const before = await layout();
        // The panes stop at the bottom of the visible page, less its padding, give or take rounding.
        expect(before.panesBottom).toBeLessThanOrEqual(before.visibleBottom + 1);
        expect(before.panesBottom).toBeGreaterThan(before.visibleBottom - 10);
        await manager(page).locator('.files').evaluate(files => { files.scrollTop = files.scrollHeight; });
        await page.waitForTimeout(100);
        expect((await layout()).pageScroll).toBe(0);
        await expect(manager(page).locator('webui-button[label="Commit"]')).toBeInViewport();
        await expect(manager(page).locator('webui-content-compare')).toBeInViewport();
    });
    test('hundreds of files are listed', async ({ page }) => {
        const many = Array.from({ length: 600 }, (_, i) => `M  src/folder${i % 20}/file${i}.cs`);
        await openList(page, { changes: many });
        await expect(manager(page).locator('.files .file-row')).toHaveCount(600);
        await expect(manager(page).locator('#val-commit-files')).toHaveText('600 of 600');
    });
});

test.describe('files that are not text', () => {
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const openWithImage = (page, change, stats) => open(page, { changes: [`${change}  logo.png`, 'M  a.txt'], lineStats: stats }, { binaryFiles: { 'logo.png': PNG } });
    const select = (page, file) => manager(page).locator(`.files button.file[title="${file}"]`).click();
    const preview = page => manager(page).locator('webui-file-preview');
    test('an added image git marks as binary shows in the file preview', async ({ page }) => {
        await openWithImage(page, '??', [{ path: 'logo.png', additions: 0, deletions: 0, binary: true }]);
        await select(page, 'logo.png');
        await expect(preview(page).locator('img')).toHaveAttribute('alt', 'logo.png');
        await expect.poll(() => preview(page).locator('img').evaluate(img => img.naturalWidth)).toBe(1);
        await expect(manager(page).locator('webui-content-compare')).toBeHidden();
        expect((await calls(page, 'get_project_file_base64'))[0]).toEqual({ filePath: 'logo.png' });
    });
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
    // Web UI dropdowns open a list of options rather than the native select, so an option is picked from that list.
    const pick = async (dropdown, value) => {
        await dropdown.locator('button').first().click();
        await dropdown.locator(`[role="option"][data-value="${value}"]`).click();
    };
    const finish = (page, code) => page.evaluate(code => window.__backend.emit('terminal-finished', { projectId: 'project-id', terminalId: 'Before Commit', code }), code);

    test('a chosen script shows a field for each of its parameters, and the choices are remembered', async ({ page }) => {
        await openWith(page);
        await pick(manager(page).locator('#before-commit-script'), SCRIPT);
        await expect(field(page, 'Version')).toHaveCount(1);
        expect(await manager(page).locator('.before-commit-params [data-param]').evaluateAll(els => els.map(el => `${el.localName}:${el.dataset.param}`))).toEqual([
            'webui-dropdown:Version', 'webui-toggle-icon:SkipMinify', 'webui-input-text:Note', 'webui-input-text:Tags', 'webui-input-text:Count', 'webui-toggle-icon:Check',
        ]);
        // Starting values come from the script's defaults.
        await expect.poll(() => field(page, 'Version').evaluate(el => el.value)).toBe('minor');
        expect(await field(page, 'Check').evaluate(el => el.value)).toBe(true);
        expect(await field(page, 'SkipMinify').evaluate(el => el.value)).toBe(false);
        await expect(field(page, 'Note')).toHaveAttribute('label', 'Note (required)');
        await expect(field(page, 'Count')).toHaveAttribute('placeholder', '2');
        await expect(field(page, 'Version')).toHaveAttribute('title', 'Which part of the version to increment.');
        await pick(field(page, 'Version'), 'major');
        await field(page, 'SkipMinify').click();
        await field(page, 'Note').locator('input').fill('hello');
        await expect.poll(async () => (await calls(page, 'sync_project_data')).at(-1)?.data?.data?._gitBeforeCommit).toEqual({
            scripts: { '': SCRIPT },
            values: { [SCRIPT]: { Version: 'major', SkipMinify: true, Note: 'hello', Tags: '', Count: '', Check: true } },
        });
    });
    test('the saved script and values show when the Git Controller opens', async ({ page }) => {
        await openWith(page, saved);
        await expect.poll(() => manager(page).locator('#before-commit-script').evaluate(el => el.value)).toBe(SCRIPT);
        await expect.poll(() => field(page, 'Version').evaluate(el => el.value)).toBe('major');
        expect(await field(page, 'SkipMinify').evaluate(el => el.value)).toBe(true);
        expect(await field(page, 'Note').evaluate(el => el.value)).toBe("it's");
        expect(await field(page, 'Check').evaluate(el => el.value)).toBe(false);
    });
    test('choosing Nothing stops running a script before commits', async ({ page }) => {
        await openWith(page, saved);
        await expect(field(page, 'Version')).toHaveCount(1);
        await pick(manager(page).locator('#before-commit-script'), '');
        await expect(manager(page).locator('.before-commit-params [data-param]')).toHaveCount(0);
        await expect.poll(async () => (await calls(page, 'sync_project_data')).at(-1)?.data?.data?._gitBeforeCommit?.scripts).toEqual({});
        await commit(page);
        await expect.poll(async () => (await calls(page, 'git_commit')).length).toBe(1);
        expect(await calls(page, 'start_script')).toEqual([]);
    });
    test('commit runs the script first in the Terminals panel, then commits what it changed once it succeeds', async ({ page }) => {
        await openWith(page, saved);
        await expect(field(page, 'Version')).toHaveCount(1);
        await include(page, 'b.txt').selectOption('0');
        await commit(page);
        await expect.poll(async () => (await calls(page, 'start_script')).length).toBe(1);
        const started = (await calls(page, 'start_script'))[0];
        expect(started.terminalId).toBe('Before Commit');
        expect(started.scriptContent).toBe(WRAPPER);
        await expect(drawerOpen(page)).toHaveCount(1);
        await expect(page.locator('webui-drawer.shared app-terminal-view')).toHaveCount(1);
        await page.waitForTimeout(100);
        expect(await calls(page, 'git_commit')).toEqual([]);
        // The script changes a file, which the refresh after it adds to the commit.
        await page.evaluate(() => window.__backend.git.changes.push(' M a.min.txt'));
        await finish(page, 0);
        await expect.poll(async () => (await calls(page, 'git_commit')).length).toBe(1);
        // The file left out before the script stays out.
        expect((await calls(page, 'git_commit'))[0]).toEqual({ repo: '', files: ['a.txt', 'c.txt', 'a.min.txt'], message: 'msg' });
        await expect(drawerOpen(page)).toHaveCount(0);
    });
    test('a script that fails cancels the commit, and leaves its output showing', async ({ page }) => {
        await openWith(page, saved);
        await expect(field(page, 'Version')).toHaveCount(1);
        await commit(page);
        await expect.poll(async () => (await calls(page, 'start_script')).length).toBe(1);
        await finish(page, 1);
        await expect(manager(page).locator('webui-alert').first()).toContainText(`${SCRIPT} failed with exit code 1, so nothing was committed`);
        await page.waitForTimeout(200);
        expect(await calls(page, 'git_commit')).toEqual([]);
        await expect(drawerOpen(page)).toHaveCount(1);
        // The message stays, ready to try again.
        expect(await manager(page).evaluate(el => el._message.value)).toBe('msg');
    });
    test('a stopped script cancels the commit', async ({ page }) => {
        await openWith(page, saved);
        await expect(field(page, 'Version')).toHaveCount(1);
        await commit(page);
        await expect.poll(async () => (await calls(page, 'start_script')).length).toBe(1);
        await finish(page, null);
        await expect(manager(page).locator('webui-alert').first()).toContainText('was stopped, so nothing was committed');
        expect(await calls(page, 'git_commit')).toEqual([]);
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
            await page.evaluate(() => {
                window.__alerts = [];
                const original = webui.alert;
                webui.alert = function (...args) { window.__alerts.push(args); return original.apply(this, args); };
                webui.setData('app-current-project', { value: '/other', display: 'Other' });
            });
            await expect.poll(() => page.evaluate(() => webui.projectData.path)).toBe('/other');
            // The other project opens its last page, then the user goes to its Git Controller.
            await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/');
            await page.waitForTimeout(100);
            await page.evaluate(() => webui.navigateTo('/git-controller'));
            await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/git-controller');
            await manager(page).locator('.files button.file').first().waitFor();
        };
        const alerts = page => page.evaluate(() => window.__alerts);

        test('the commit goes to the project the script started in', async ({ page }) => {
            await openBoth(page);
            await expect(field(page, 'Version')).toHaveCount(1);
            await include(page, 'b.txt').selectOption('0');
            await manager(page).evaluate(el => { el._toggleSync.value = true; });
            await commit(page);
            await expect.poll(async () => (await calls(page, 'start_script')).length).toBe(1);
            await switchToOther(page);
            await page.evaluate(() => window.__backend.git.changes.push(' M a.min.txt'));
            await finish(page, 0);
            await expect.poll(async () => (await calls(page, 'git_commit')).length).toBe(1);
            // The file left out and the ignored file stay out, and the script's change goes in.
            expect((await calls(page, 'git_commit'))[0]).toEqual({ repo: '', files: ['a.txt', 'a.min.txt'], message: 'msg', project: '/repo' });
            expect((await calls(page, 'get_git_changes')).at(-1)).toEqual({ path: '', project: '/repo' });
            // Sync after commit is on, so the project the script started in is synced, not the open one.
            await expect.poll(() => alerts(page)).toEqual([['Repo: Commit and Sync successful!', 'success']]);
            expect(await calls(page, 'git_sync')).toEqual([{ repo: '', project: '/repo' }]);
            // The sent message is cleared from the project it was written in.
            await expect.poll(async () => (await calls(page, 'save_project_data')).filter(call => call.data.path === '/repo').at(-1)?.data.data._gitCommitMessages).toEqual({});
            expect(page.url()).toContain('/git-controller');
            expect(await page.evaluate(() => webui.projectData.path)).toBe('/other');
        });
        test('without sync after commit, the project is only committed', async ({ page }) => {
            await openBoth(page);
            await expect(field(page, 'Version')).toHaveCount(1);
            await manager(page).evaluate(el => { el._toggleSync.value = false; });
            await commit(page);
            await expect.poll(async () => (await calls(page, 'start_script')).length).toBe(1);
            await switchToOther(page);
            await finish(page, 0);
            await expect.poll(() => alerts(page)).toEqual([['Repo: Commit successful.', 'success']]);
            expect(await calls(page, 'git_sync')).toEqual([]);
        });
        test('a sync that fails after switching says why, and does not ask for a token for the open project', async ({ page }) => {
            await openBoth(page);
            await expect(field(page, 'Version')).toHaveCount(1);
            await manager(page).evaluate(el => { el._toggleSync.value = true; });
            await commit(page);
            await expect.poll(async () => (await calls(page, 'start_script')).length).toBe(1);
            await switchToOther(page);
            await onCommand(page, 'git_sync', () => { throw 'Credentials Missing/Invalid'; });
            await finish(page, 0);
            await expect.poll(() => alerts(page)).toEqual([['Repo: Commit successful. Syncing failed, so sync it from the Git Controller: Credentials Missing/Invalid', 'danger']]);
            await expect(dialogButton(page, 'Save & Retry')).toHaveCount(0);
        });
        test('a script that fails after switching says which project it was for, and commits nothing', async ({ page }) => {
            await openBoth(page);
            await expect(field(page, 'Version')).toHaveCount(1);
            await commit(page);
            await expect.poll(async () => (await calls(page, 'start_script')).length).toBe(1);
            await switchToOther(page);
            await finish(page, 1);
            await expect.poll(() => alerts(page)).toEqual([[`Repo: ${SCRIPT} failed with exit code 1, so nothing was committed. Its output is in the Terminals panel.`, 'danger']]);
            await page.waitForTimeout(200);
            expect(await calls(page, 'git_commit')).toEqual([]);
        });
    });
    test('a required parameter must be filled in before the script runs', async ({ page }) => {
        await openWith(page, { _gitBeforeCommit: { scripts: { '': SCRIPT }, values: { [SCRIPT]: { ...VALUES, Note: ' ' } } } });
        await expect(field(page, 'Version')).toHaveCount(1);
        await commit(page);
        await expect(manager(page).locator('webui-alert').first()).toContainText(`Fill in Note for ${SCRIPT}`);
        expect(await calls(page, 'start_script')).toEqual([]);
        expect(await calls(page, 'git_commit')).toEqual([]);
    });
    test('a script from a project that is not trusted yet asks first', async ({ page }) => {
        await open(page, {}, { scripts: [SCRIPT], files: { [SCRIPT]: PUBLISH }, data: saved });
        await expect(field(page, 'Version')).toHaveCount(1);
        await commit(page);
        await expect(dialogButton(page, 'Trust Project & Run')).toBeVisible();
        await dialogButton(page, 'Cancel').click();
        await page.waitForTimeout(100);
        expect(await calls(page, 'start_script')).toEqual([]);
        expect(await calls(page, 'git_commit')).toEqual([]);
    });
});
