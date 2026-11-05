import { test, expect, openApp } from '../support/app.mjs';

test('links show only with a project open', async ({ page }) => {
    await openApp(page, { projects: [] });
    await expect(page.locator('app-project-links')).toBeVisible();
    await page.evaluate(() => webui.setData('app-current-project', null));
    await expect(page.locator('app-project-links')).toBeHidden();
});
test('links go to each project tool', async ({ page }) => {
    await openApp(page);
    for (const url of ['/nav-manager', '/docs', '/script-manager', '/git-controller']) {
        await expect(page.locator(`app-project-links webui-nav-link[url="${url}"]`)).toHaveCount(1);
    }
});
