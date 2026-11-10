import { test, expect, openApp } from '../support/app.mjs';

const source = page => page.evaluate(() => webui.getData('app-home-source'));

test('with no security key, it starts with first run setup', async ({ page }) => {
    await openApp(page, { project: null, hasKey: false });
    await expect.poll(() => source(page)).toBe('d/first_run.md');
});
test('with a key and no projects, it asks for a project', async ({ page }) => {
    await openApp(page, { project: null, projects: [] });
    await expect.poll(() => source(page)).toBe('d/home_new_project.md');
});
test('with projects, it shows settings', async ({ page }) => {
    await openApp(page);
    await expect.poll(() => source(page)).toBe('d/home_settings.md');
});
test('the site links show on settings and not on other pages', async ({ page }) => {
    const links = page.locator('webui-app webui-link[href="/about"], webui-app webui-link[href="/terms"]');
    await openApp(page);
    await expect(links).toHaveCount(2);
    await expect(page.locator('webui-app webui-link[href="/about"]')).toHaveText('About Task Proxy');
    await expect(page.locator('webui-app webui-stoic-social-links')).toHaveCount(1);
    await openApp(page, { currentPage: '/git-controller' }, '/git-controller');
    await expect(page.locator('app-git-manager')).toBeAttached();
    await expect(links).toHaveCount(0);
    await expect(page.locator('webui-app > [slot="content-footer"]')).toHaveCount(0);
    // The copyright stays in the app's bottom bar.
    await expect(page.locator('webui-app > footer[slot="footer"]')).toContainText('Stoic Dreams');
});
