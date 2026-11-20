import { test, expect, openApp, switchProject, goToPage, calls, callOrder, onCommand, dialogButton, openDialog } from '../../support/app.mjs';

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

const commitActions = page => manager(page).locator('.commit-actions');
const commitState = page => manager(page).locator('.commit-state');
const cancelCommit = page => manager(page).locator('#btn-cancel-commit');

test.describe('file list', () => {
    const changes = ['M  src/app/main.cs', 'M  docs/main.cs', '?? src/app/new.cs', ' D old.txt'];
    const files = { 'src/app/main.cs': 'a', 'docs/main.cs': 'b', 'src/app/new.cs': 'c' };
    const openList = (page, git = {}) => open(page, { changes, ...git }, { files });
    const row = (page, path) => manager(page).locator(`.files .file-row[data-path="${path}"]`);
    const selected = page => manager(page).evaluate(el => el.shadowRoot.querySelector('.file-row.selected')?.dataset.path);

    // How the panes look is checked by eye. These check what a person can see and reach while using them.
    const scrollPageToBottom = page => page.evaluate(() => {
        const main = document.querySelector('webui-app').shadowRoot.querySelector('main');
        main.scrollTop = main.scrollHeight;
    });
    test('the file list scrolls on its own, keeping the commit controls and the comparison in view', async ({ page }) => {
        await page.setViewportSize({ width: 1400, height: 800 });
        const many = Array.from({ length: 150 }, (_, i) => `M  src/file${i}.cs`);
        await openList(page, { changes: many });
        const rows = manager(page).locator('.files .file-row');
        await expect(rows).toHaveCount(150);
        // Too many files to show at once: the last is out of view until the list is scrolled.
        await expect(rows.last()).not.toBeInViewport();
        await manager(page).locator('.files').evaluate(files => { files.scrollTop = files.scrollHeight; });
        await expect(rows.last()).toBeInViewport();
        // Only the list moved: the page didn't scroll its controls away.
        await expect(manager(page).locator('webui-button[label="Commit"]')).toBeInViewport();
        await expect(manager(page).locator('webui-content-compare')).toBeInViewport();
        await expect(manager(page).locator('webui-button[label="Refresh"]')).toBeInViewport();
    });
    test('a long branch list on its hidden tab does not make the page scroll', async ({ page }) => {
        await page.setViewportSize({ width: 1400, height: 800 });
        const branches = Array.from({ length: 40 }, (_, i) => ({ name: `feature/${i}`, isCurrent: i === 0, updatedDate: '2026-01-01' }));
        await openList(page, { branches });
        // With the branches hidden, there is nothing below the panes to scroll to, so the top controls stay put.
        await scrollPageToBottom(page);
        await expect(manager(page).locator('webui-button[label="Refresh"]')).toBeInViewport();
        await expect(manager(page).locator('webui-button[label="Commit"]')).toBeInViewport();
        // Shown, the long list can be scrolled to its last branch.
        await openBranches(page);
        const last = manager(page).locator('webui-button.btn-switch').last();
        await last.scrollIntoViewIfNeeded();
        await expect(last).toBeInViewport();
    });
    test('the panes keep showing when something else holds the page taller than them', async ({ page }) => {
        await page.setViewportSize({ width: 1400, height: 800 });
        await page.clock.install();
        await openList(page);
        const firstFile = manager(page).locator('.files .file-row').first();
        await expect(firstFile).toBeInViewport();
        // A hidden tab that stays tall once made the panes shrink a little more on every fit, until they were gone.
        await manager(page).evaluate(el => {
            const hidden = el.shadowRoot.querySelectorAll('webui-tabs > [slot="content"]')[1];
            hidden.style.cssText = 'height:1500px !important;min-height:1500px !important;';
        });
        // The panes are fitted again every half second, and every fit is a chance to shrink further, so give it many.
        await page.clock.runFor(10000);
        await expect(firstFile).toBeInViewport();
        await expect(manager(page).locator('webui-content-compare')).toBeInViewport();
        await expect(manager(page).locator('webui-button[label="Commit"]')).toBeInViewport();
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
        await expect.poll(() => calls(page, 'get_project_file_size')).toContainEqual({ filePath: 'logo.png' });
        await expect(preview(page).locator('img')).toHaveAttribute('src', 'http://files.localhost/token/logo.png');
    });
    test('a video is streamed to the preview, without reading or diffing it as text', async ({ page }) => {
        // A tracked video with no line counts yet, as when the Git Controller has just opened.
        await open(page, { changes: ['M  media/demo clip.mp4', 'M  a.txt'] }, { binaryFiles: { 'media/demo clip.mp4': 'AAAAIGZ0eXBpc29t' } });
        await select(page, 'media/demo clip.mp4');
        // These bytes are not a real video, so the player gives up, but only after loading it from the backend's file server.
        await expect.poll(() => page.__fileRequests.map(request => request.path)).toContain('media/demo clip.mp4');
        await expect(preview(page)).toContainText('video/mp4 - 12 Bytes');
        // The preview is the last step of showing a file, so anything read as text was read before it showed.
        await expect.poll(() => calls(page, 'get_project_file_size')).toContainEqual({ filePath: 'media/demo clip.mp4' });
        await expect.poll(() => calls(page, 'get_project_file')).not.toContainEqual({ filePath: 'media/demo clip.mp4' });
        await expect.poll(() => calls(page, 'get_git_file_diff')).not.toContainEqual(expect.objectContaining({ file: 'media/demo clip.mp4' }));
    });
});

