import { test, expect, openApp, calls, onCommand, dialogButton } from '../support/app.mjs';

const open = async (page, git = {}, state = {}) => {
    await openApp(page, { currentPage: '/git-controller', git: { changes: ['M  a.txt', '?? b.txt', ' D c.txt'], ...git }, ...state, files: { 'a.txt': 'one', 'b.txt': 'two', ...(state.files || {}) } }, '/git-controller');
    await page.locator('app-git-manager .files webui-button').first().waitFor();
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
const include = (page, file) => manager(page).locator(`.files webui-button[title="${file}"]`).evaluateHandle(button => button.previousElementSibling);

test('changes are listed with their type', async ({ page }) => {
    await open(page);
    await expect(manager(page).locator('.files webui-button[title="a.txt"]')).toContainText('Modify');
    await expect(manager(page).locator('.files webui-button[title="b.txt"]')).toContainText('Add');
    await expect(manager(page).locator('.files webui-button[title="c.txt"]')).toContainText('Delete');
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
    await (await include(page, 'b.txt')).evaluate(dropdown => { dropdown.value = '0'; dropdown.dispatchEvent(new Event('change')); });
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
    await (await include(page, 'a.txt')).evaluate(dropdown => { dropdown.value = '2'; dropdown.dispatchEvent(new Event('change')); });
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
    await expect(manager(page).locator('.files webui-button[title="a -> b.txt"]')).toHaveCount(1);
});
test('a renamed file uses its new name', async ({ page }) => {
    await open(page, { changes: ['R  old.txt -> new.txt'] }, { files: { 'new.txt': 'x' } });
    await expect(manager(page).locator('.files webui-button[title="new.txt"]')).toHaveCount(1);
});
test('a binary file does not interrupt with a popup', async ({ page }) => {
    await openApp(page, { project: { name: 'Repo', path: '/repo' } });
    await onCommand(page, 'get_project_file', () => { throw 'Failed to load file: stream did not contain valid UTF-8'; });
    await page.evaluate(() => {
        window.__alerts = [];
        const original = webui.alert;
        webui.alert = function (...args) { window.__alerts.push(args); return original.apply(this, args); };
        window.__backend.git.changes = ['M  logo.png'];
        webui.navigateTo('/git-controller');
    });
    await page.locator('app-git-manager .files webui-button').first().waitFor();
    await expect(manager(page).locator('webui-alert').first()).toContainText('valid UTF-8');
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
    await manager(page).locator('.files webui-button[title="a.txt"]').click();
    await manager(page).locator('.files webui-button[title="b.txt"]').click();
    await page.waitForTimeout(700);
    await expect.poll(() => manager(page).evaluate(el => el._fileName.textContent)).toContain('b.txt');
});
test('reverting a modified file restores it, and removing a new file deletes it', async ({ page }) => {
    await open(page);
    await manager(page).locator('.files webui-button[title="Revert changes to this file"]').first().click();
    await dialogButton(page, 'Revert').click();
    await expect.poll(async () => (await calls(page, 'git_restore_file')).length).toBe(1);
    expect((await calls(page, 'git_restore_file'))[0]).toEqual({ repo: '', file: 'a.txt' });
    await manager(page).locator('.files webui-button[title="Delete new file"]').first().click();
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
