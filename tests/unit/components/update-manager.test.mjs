import { test, expect, openApp, mount, calls, onCommand } from '../support/app.mjs';

async function manager(page) {
    await openApp(page, { project: null });
    const root = await mount(page, '<app-update-manager id="u"></app-update-manager>');
    return root.locator('#u');
}
test('install stays disabled when up to date', async ({ page }) => {
    const el = await manager(page);
    await el.locator('#btn-check').click();
    await expect(el.locator('webui-alert').last()).toContainText('up to date');
    await expect(el.locator('#btn-install')).toHaveAttribute('disabled');
});
test('install is offered when an update exists', async ({ page }) => {
    const el = await manager(page);
    await onCommand(page, 'check_update', () => ({ version: '2.0.0', currentVersion: '1.2.3', notes: null }));
    await el.locator('#btn-check').click();
    await expect(el.locator('webui-alert').last()).toContainText('Version 2.0.0 is available');
    await expect(el.locator('#btn-install')).not.toHaveAttribute('disabled');
    await el.locator('#btn-install').click();
    await expect.poll(async () => (await calls(page, 'install_update')).length).toBe(1);
});
test('a failed check shows the error', async ({ page }) => {
    const el = await manager(page);
    await onCommand(page, 'check_update', () => { throw 'Network down'; });
    await el.locator('#btn-check').click();
    await expect(el.locator('webui-alert').last()).toContainText('Network down');
});
test('shows the current version', async ({ page }) => {
    const el = await manager(page);
    await expect(el.locator('strong')).toHaveText('v1.2.3');
});
test('automatic checks are turned on and off here, and kept with the app\'s data', async ({ page }) => {
    const el = await manager(page);
    const box = el.locator('input.auto-check');
    await expect(box).not.toBeChecked();
    await box.check();
    await expect.poll(() => page.evaluate(() => webui.getData('app-update-auto-check'))).toBe(true);
    await page.evaluate(() => webui.setData('app-update-auto-check', false));
    await expect(box).not.toBeChecked();
});
