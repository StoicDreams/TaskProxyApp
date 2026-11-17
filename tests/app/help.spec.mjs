import { test, expect, openApp, calls } from '../support/app.mjs';

// Each page's help opens from a bubble instead of sitting below the page.
const pages = [
    ['/git-controller', 'Git Controller Help', 'Committing & Syncing'],
    ['/script-manager', 'Script & Terminal Management Help', null],
    ['/docs', 'Documentation & Navigation Help', null],
    ['/nav-manager', 'Documentation & Navigation Help', null],
];
for (const [path, heading] of pages) {
    test(`help on ${path} opens from a bubble`, async ({ page }) => {
        await openApp(page, { currentPage: path }, path);
        const help = page.locator('webui-page-help');
        const bubble = help.locator('button.bubble');
        await expect(bubble).toBeVisible();
        await expect(help.locator('webui-tabs').first()).toBeHidden();
        await bubble.click();
        await expect(help.locator('.panel h2')).toHaveText(heading);
        // The help stays in the page, and is shown inside the panel through a slot.
        await expect(help.locator('webui-tabs').first()).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(help.locator('.panel')).toBeHidden();
    });
}
test('the Git Controller can be used with its help open', async ({ page }) => {
    await openApp(page, { currentPage: '/git-controller', git: { changes: ['M  a.txt'] }, files: { 'a.txt': 'x' } }, '/git-controller');
    const manager = page.locator('app-git-manager');
    await manager.locator('.files button.file').first().waitFor();
    await page.locator('webui-page-help button.bubble').click();
    await expect(page.locator('webui-page-help .panel')).toBeVisible();
    const textarea = manager.locator('webui-input-message[label="Commit Message"] textarea');
    await textarea.fill('written while reading the help');
    await expect(textarea).toHaveValue('written while reading the help');
    const before = (await calls(page, 'get_git_changes')).length;
    await manager.locator('webui-button[label="Refresh"]').click();
    await expect.poll(async () => (await calls(page, 'get_git_changes')).length).toBeGreaterThan(before);
    await expect(page.locator('webui-page-help .panel')).toBeVisible();
});
test('the app footer never covers the help bubble', async ({ page }) => {
    await openApp(page, { currentPage: '/script-manager' }, '/script-manager');
    // Wait for the footer, which renders shortly after the page.
    await page.locator('webui-app > footer[slot="footer"]').waitFor();
    // A real click, which Playwright refuses when another element, such as the footer, would take it.
    const bubble = page.locator('webui-page-help button.bubble');
    await bubble.click();
    await expect(page.locator('webui-page-help .panel')).toBeVisible();
});
