import { test, expect, openApp } from '../support/app.mjs';

const manifest = { id: 'jira', name: 'Jira', version: '0.1.0', apiVersion: 1, permissions: { variables: [{ key: 'jira_site', label: 'Jira site' }] }, pages: [] };
const plugins = [{ id: 'jira', version: '0.1.0', enabled: true, signed: true, manifest }];

test('the Plugins button sits beside Icons & Emojis and opens the plugin manager in the right drawer', async ({ page }) => {
    await openApp(page, { plugins });
    const button = page.getByRole('button', { name: 'Plugins', exact: true });
    await expect(button).toHaveCount(1);
    expect(await page.evaluate(() => document.querySelector('app-plugins-drawer').nextElementSibling.localName)).toBe('app-icon-drawer');
    await button.click();
    const drawer = page.locator('webui-drawer.shared');
    await expect(drawer).toHaveClass(/open/);
    await expect(drawer.getByRole('heading', { name: 'Plugins' })).toHaveCount(1);
    await expect(drawer.locator('app-plugin-manager [data-plugin="jira"]')).toBeVisible();
    // The page itself stays where it was.
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
});

test('it opens from the keyboard', async ({ page }) => {
    await openApp(page, { plugins });
    await page.getByRole('button', { name: 'Plugins', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('webui-drawer.shared app-plugin-manager')).toBeVisible();
});

test("it can open on one plugin's settings", async ({ page }) => {
    await openApp(page, { plugins, pluginSettings: { jira: [{ key: 'jira_site', label: 'Jira site', help: '', secret: false, isSet: false, value: null }] } });
    await page.evaluate(() => document.querySelector('app-plugins-drawer').open('jira'));
    const card = page.locator('webui-drawer.shared [data-plugin="jira"]');
    await expect(card).toHaveClass(/plugin-highlight/);
    await expect(card.locator('webui-input-text[name="jira_site"]')).toBeVisible();
});
