import { test, expect, openApp, openTool } from '../support/app.mjs';

// The Plugins tab of Tools (wc/plugins-drawer.js), which shows the plugin manager.

const manifest = { id: 'jira', name: 'Jira', version: '0.1.0', apiVersion: 1, permissions: { variables: [{ key: 'jira_site', label: 'Jira site' }] }, pages: [] };
const plugins = [{ id: 'jira', version: '0.1.0', enabled: true, signed: true, manifest }];

test('the Plugins tab of Tools shows the plugin manager in the right drawer', async ({ page }) => {
    await openApp(page, { plugins });
    const tab = await openTool(page, 'plugins');
    await expect(page.locator('webui-drawer.shared')).toHaveClass(/open/);
    await expect(tab.getByRole('heading', { name: 'Plugins' })).toHaveCount(1);
    await expect(tab.locator('app-plugin-manager [data-plugin="jira"]')).toBeVisible();
    // The page itself stays where it was.
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
});

test("it can open on one plugin's settings", async ({ page }) => {
    await openApp(page, { plugins, pluginSettings: { jira: [{ key: 'jira_site', label: 'Jira site', help: '', secret: false, isSet: false, value: null }] } });
    await page.evaluate(() => document.querySelector('app-plugins-drawer').open('jira'));
    const card = page.locator('webui-drawer.shared .plugin-detail [data-plugin="jira"]');
    await expect(card).toHaveClass(/plugin-highlight/);
    await expect(card.locator('webui-input-text[name="jira_site"]')).toBeVisible();
});
