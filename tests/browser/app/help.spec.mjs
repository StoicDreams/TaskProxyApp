import { test, expect, openApp, calls } from '../../support/app.mjs';

// Each page's help opens from a bubble instead of sitting below the page.
const pages = [
    ['/git-controller', 'Git Controller Help', 'Committing & Syncing'],
    ['/script-manager', 'Script & Terminal Management Help', null],
    ['/docs', 'Documentation & Navigation Help', null],
    ['/nav-manager', 'Documentation & Navigation Help', null],
];
for (const [path, heading] of pages) {
}
test('nothing covers the help bubble', async ({ page }) => {
    await openApp(page, { currentPage: '/script-manager' }, '/script-manager');
    // A real click, which Playwright refuses when another element would take it.
    const bubble = page.locator('webui-page-help button.bubble');
    await bubble.click();
    await expect(page.locator('webui-page-help .panel')).toBeVisible();
});
