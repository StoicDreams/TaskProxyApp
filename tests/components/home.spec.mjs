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
