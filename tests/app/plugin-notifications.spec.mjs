import { test, expect, openApp, calls } from '../support/app.mjs';

const manifest = {
    id: 'test', name: 'Test Plugin', version: '0.1.0', apiVersion: 1, icon: 'flask',
    permissions: { hosts: [], variables: [], git: [] },
    pages: [{ id: 'issue', name: 'Issue', hidden: true }],
    contributes: ['notifications'],
};
const plugins = [{ id: 'test', version: '0.1.0', enabled: true, signed: true, manifest }];
const mention = {
    id: 'bell:n-1', title: 'Sam Lee mentioned you on ATL-142', text: 'Show CI status: can you look?', theme: 'warning',
    time: '2026-11-11 15:30', links: [{ text: 'ATL-142', page: 'issue', params: { key: 'ATL-142' } }],
};
const popup = page => page.locator('.webui-alerts-popup webui-alert');
const bellCount = page => page.locator('webui-alerts webui-icon').getAttribute('count');
const setNotifications = (page, items) => page.evaluate(items => {
    window.__backend.handlers.plugin_notifications = () => [{ id: 'test', name: 'Test Plugin', items }];
}, items);
const refresh = page => page.evaluate(() => webui.proxy.plugins.alerts.refresh());

test("plugins' notifications join the alerts when the app starts, without popping up", async ({ page }) => {
    await openApp(page, { plugins, pluginNotifications: [{ id: 'test', name: 'Test Plugin', items: [mention] }] });
    await expect.poll(() => bellCount(page)).toBe('1');
    await expect(popup(page)).toHaveCount(0);
    await page.locator('webui-alerts').click();
    const listed = page.locator('webui-drawer.shared webui-alert');
    await expect(listed).toContainText('Sam Lee mentioned you on ATL-142');
    await expect(listed).toContainText('Test Plugin · 2026-11-11 15:30');
    await expect(listed).toHaveAttribute('variant', 'warning');
    // Each issue it names opens that issue's page.
    await expect(listed.locator('.plugin-link')).toHaveText(['ATL-142']);
    await listed.locator('.plugin-link').click();
    await expect(page).toHaveURL(/\/plugin\/test\/issue\?key=ATL-142$/);
});

test('closing a notification tells its plugin to mark it read', async ({ page }) => {
    await openApp(page, { plugins, pluginNotifications: [{ id: 'test', name: 'Test Plugin', items: [mention] }] });
    await expect.poll(() => bellCount(page)).toBe('1');
    await page.locator('webui-alerts').click();
    await page.locator('webui-drawer.shared webui-alert').locator('#close').click();
    await expect.poll(() => calls(page, 'plugin_notification_read')).toEqual([{ id: 'test', notification: 'bell:n-1' }]);
    await expect.poll(() => bellCount(page)).toBe('');
});

test('new notifications pop up, and ones read elsewhere go away', async ({ page }) => {
    await openApp(page, { plugins, pluginNotifications: [{ id: 'test', name: 'Test Plugin', items: [mention] }] });
    await expect.poll(() => bellCount(page)).toBe('1');
    const assigned = { id: 'change:h1:assignee', title: 'Priya assigned ATL-151 to you', links: [{ text: 'ATL-151', page: 'issue', params: { key: 'ATL-151' } }] };
    await setNotifications(page, [mention, assigned]);
    await refresh(page);
    await expect(popup(page)).toContainText('Priya assigned ATL-151 to you');
    await expect.poll(() => bellCount(page)).toBe('2');
    // Read in Jira, so the plugin no longer lists it.
    await setNotifications(page, [assigned]);
    await refresh(page);
    await expect.poll(() => bellCount(page)).toBe('1');
    expect(await calls(page, 'plugin_notification_read')).toEqual([]);
    // A plugin that fails keeps what it showed.
    await page.evaluate(() => { window.__backend.handlers.plugin_notifications = () => [{ id: 'test', name: 'Test Plugin', error: 'Jira is down' }]; });
    await refresh(page);
    await expect.poll(() => bellCount(page)).toBe('1');
    // Turned off, its notifications go.
    await page.evaluate(() => { window.__backend.handlers.plugin_notifications = () => []; });
    await refresh(page);
    await expect.poll(() => bellCount(page)).toBe('');
});
