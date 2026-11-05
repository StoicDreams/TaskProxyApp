import { test, expect, openApp, calls } from '../support/app.mjs';

test('saves the project and app data', async ({ page }) => {
    await openApp(page);
    await page.locator('app-save-button').click();
    await expect.poll(async () => (await calls(page, 'save_project_data')).length).toBeGreaterThan(0);
    await expect.poll(async () => (await calls(page, 'save_app_data')).length).toBeGreaterThan(0);
});
test('with no project it only saves app data', async ({ page }) => {
    await openApp(page, { project: null });
    await page.locator('app-save-button').click();
    await expect.poll(async () => (await calls(page, 'save_app_data')).length).toBeGreaterThan(0);
    expect(await calls(page, 'save_project_data')).toEqual([]);
});
