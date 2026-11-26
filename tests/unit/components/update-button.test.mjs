import { test, expect, openApp, calls, callOrder, onCommand, dialogButton, openDialog } from '../support/app.mjs';
import { alertPopup } from '../../support/wait.mjs';

const jira = { id: 'jira', name: 'Jira', version: '2.1.0', apiVersion: 1, permissions: {}, pages: [] };
const installed = [{ id: 'jira', version: '2.1.0', enabled: true, signed: true, manifest: jira }];
const newerJira = { id: 'jira', name: 'Jira', version: '2.2.0', permissions: {} };
const appUpdate = { version: '9.1.0', currentVersion: '9.0.0', notes: null };

const button = page => page.locator('header app-update-button');
const icon = page => button(page).locator('webui-icon');

test('sits left of Save, and says when there are no updates', async ({ page }) => {
    await openApp(page, { plugins: installed, catalog: [{ ...jira }] });
    await expect(page.locator('header app-update-button + app-save-button')).toHaveCount(1);
    await expect(icon(page)).toHaveAttribute('icon', 'refresh|theme:info|fill|backing|bordered');
    await button(page).click();
    await expect(alertPopup(page, 'No updates available.')).toHaveCount(1);
    await expect.poll(async () => (await calls(page, 'check_update')).length).toBe(1);
    await expect(openDialog(page)).toHaveCount(0);
});

test('lists the updates found, and Apply Updates updates plugins before the app', async ({ page }) => {
    await openApp(page, { plugins: installed, catalog: [newerJira], catalogManifests: { jira: { ...jira, version: '2.2.0' } } });
    await onCommand(page, 'check_update', () => ({ version: '9.1.0', currentVersion: '9.0.0', notes: null }));
    await button(page).click();
    const dialog = openDialog(page);
    await expect(dialog.locator('li.update-plugin')).toHaveText('Jira plugin: 2.1.0 to 2.2.0');
    await expect(dialog.locator('li.update-app')).toHaveText('Task Proxy: 9.0.0 to 9.1.0');
    // What was found shows on the icon too.
    await expect(icon(page)).toHaveAttribute('count', '2');
    await dialogButton(page, 'Apply Updates').click();
    await expect.poll(() => callOrder(page, 'plugin_install_catalog', 'install_update')).toEqual([
        { command: 'plugin_install_catalog', args: { id: 'jira' } },
        { command: 'install_update', args: {} },
    ]);
    await expect(alertPopup(page, 'Updated Jira to 2.2.0.')).toHaveCount(1);
});

test('Cancel applies nothing', async ({ page }) => {
    await openApp(page, { plugins: installed, catalog: [newerJira] });
    await button(page).click();
    await expect(openDialog(page).locator('li.update-plugin')).toHaveCount(1);
    await expect(openDialog(page).locator('li.update-app')).toHaveCount(0);
    await dialogButton(page, 'Cancel').click();
    await expect(openDialog(page)).toHaveCount(0);
    await expect.poll(() => callOrder(page, 'plugin_install_catalog', 'install_update')).toEqual([]);
    await expect(icon(page)).toHaveAttribute('count', '1');
});

test('a check that fails says why rather than that there are no updates', async ({ page }) => {
    await openApp(page, { plugins: [] });
    await onCommand(page, 'check_update', () => { throw 'Network down'; });
    await button(page).click();
    await expect(alertPopup(page, 'Task Proxy couldn\'t be checked for an update: Network down')).toHaveCount(1);
    await expect(alertPopup(page, 'No updates available.')).toHaveCount(0);
});

test('with automatic checks on, it checks every 6 hours and shows what it found on the icon', async ({ page }) => {
    await page.clock.install();
    await openApp(page, { plugins: installed, catalog: [newerJira] });
    await page.evaluate(update => { window.__backend.handlers.check_update = () => update; }, appUpdate);
    await page.evaluate(() => webui.setData('app-update-auto-check', true));
    // Never checked before, so it checks at once.
    await page.clock.runFor(1000);
    await expect.poll(async () => (await calls(page, 'check_update')).length).toBe(1);
    await expect(icon(page)).toHaveAttribute('icon', 'download|theme:warning|fill|backing|bordered');
    await expect(icon(page)).toHaveAttribute('count', '2');
    await expect(button(page)).toHaveAttribute('title', '2 updates available');
    await expect(openDialog(page)).toHaveCount(0);
    await page.clock.runFor(5 * 60 * 60 * 1000);
    await expect.poll(async () => (await calls(page, 'check_update')).length).toBe(1);
    await page.clock.runFor(60 * 60 * 1000);
    await expect.poll(async () => (await calls(page, 'check_update')).length).toBe(2);
    // Turned off, it stops.
    await page.evaluate(() => webui.setData('app-update-auto-check', false));
    await page.clock.runFor(7 * 60 * 60 * 1000);
    await expect.poll(async () => (await calls(page, 'check_update')).length).toBe(2);
});
