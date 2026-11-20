import { test, expect, openApp, mount, calls, onCommand } from '../support/app.mjs';

test('searches project files and publishes them to its bound key', async ({ page }) => {
    await openApp(page);
    await onCommand(page, 'search_project_files', () => [{ value: 'a.ps1', display: 'a' }]);
    await mount(page, '<app-files filter="*.ps1" display="[file]" data-trigger="my-files"></app-files>');
    await expect.poll(() => page.evaluate(() => webui.getData('my-files'))).toEqual([{ value: 'a.ps1', display: 'a' }]);
    await expect.poll(() => calls(page, 'search_project_files')).toEqual([{ filter: '*.ps1', display: '[file]' }]);
});
test('does nothing without a filter', async ({ page }) => {
    await openApp(page);
    await mount(page, '<app-files data-trigger="my-files"></app-files>');
    // A second one, with a filter, starts after the first, so its search shows the first has had its turn.
    await page.evaluate(() => document.getElementById('test-root').insertAdjacentHTML('beforeend', '<app-files filter="*.md" display="[file]" data-trigger="other-files"></app-files>'));
    await expect.poll(() => calls(page, 'search_project_files')).toEqual([{ filter: '*.md', display: '[file]' }]);
});
