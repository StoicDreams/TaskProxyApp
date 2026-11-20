import { test, expect, openApp, dialogButton, calls } from '../support/app.mjs';

const source = page => page.evaluate(() => webui.getData('app-home-source'));

test('with no security key, it starts with first run setup', async ({ page }) => {
    await openApp(page, { project: null, hasKey: false });
    await expect.poll(() => source(page)).toBe('d/first_run.md');
});
test('saving the first security key moves on to adding a project, and deleting it goes back', async ({ page }) => {
    await openApp(page, { project: null, projects: [], hasKey: false });
    await expect.poll(() => source(page)).toBe('d/first_run.md');
    const setter = page.locator('app-security-key-setter');
    await setter.locator('webui-input-message textarea').fill('a key that is long enough');
    await setter.locator('webui-button[theme="primary"]').click();
    await expect.poll(() => source(page)).toBe('d/home_new_project.md');
    await expect(page.locator('app-add-project')).toBeVisible();
    await page.locator('app-security-key-setter webui-button[theme="danger"]').click();
    await dialogButton(page, 'Confirm').click();
    await expect.poll(() => source(page)).toBe('d/first_run.md');
});
test('adding the first project at a drive\'s root opens it and moves on to settings, and removing it goes back', async ({ page }) => {
    // A drive's root has no folder name, so the project is named as typed, and its path is the root itself.
    await openApp(page, { project: null, projects: [], pickedFolder: 'C:/' });
    await expect.poll(() => source(page)).toBe('d/home_new_project.md');
    await page.locator('app-add-project webui-input-text input').fill('Backup');
    await page.locator('app-add-project webui-button[theme="primary"]').click();
    await expect.poll(() => source(page)).toBe('d/home_settings.md');
    await expect.poll(() => page.evaluate(() => webui.getData('app-current-project'))).toEqual({ value: 'C:/', display: 'Backup' });
    await expect.poll(async () => (await calls(page, 'get_project_data')).at(-1)?.project.path).toBe('C:/');
    await page.evaluate(async () => {
        await webui.proxy.removeProject('C:/');
        webui.setData('app-current-project', null);
    });
    await expect.poll(() => source(page)).toBe('d/home_new_project.md');
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
});
test('every update control shows whole in the settings side column', async ({ page }) => {
    // The window size where the buttons once ran out of the card and were cut off.
    await page.setViewportSize({ width: 1297, height: 808 });
    await openApp(page);
    const updates = page.locator('app-update-manager');
    for (const control of [updates.getByText('Check for Updates'), updates.getByText('Install Updates'), updates.getByText('Current Version')]) {
        await expect(control).toBeInViewport({ ratio: 0.95 });
    }
});
