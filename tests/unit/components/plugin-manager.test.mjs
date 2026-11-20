import { test, expect, openApp, calls, dialogButton, openDialog } from '../support/app.mjs';

const jira = {
    id: 'jira', name: 'Jira', version: '0.1.0', apiVersion: 1, description: 'Jira Cloud in Task Proxy.', category: 'issue-tracking',
    permissions: {
        hosts: ['*.atlassian.net'],
        variables: [{ key: 'jira_site', label: 'Jira site' }, { key: 'jira_api_token', label: 'API token', secret: true }],
        git: ['currentBranch', 'createBranch'],
    },
    pages: [{ id: 'issues', name: 'My Issues' }],
};
const installed = [{ id: 'jira', version: '0.1.0', enabled: true, signed: true, manifest: jira }];
const settings = {
    jira: [
        { key: 'jira_site', label: 'Jira site', help: 'Your Jira address', secret: false, isSet: true, value: 'https://team.atlassian.net' },
        { key: 'jira_api_token', label: 'API token', help: '', secret: true, isSet: true, value: null },
    ],
};

const notes = { id: 'notes', name: 'Notes', version: '1.0.0', apiVersion: 1, description: 'Notes beside your work.', icon: 'note', permissions: {}, pages: [] };

/** Opens the Plugins drawer, on one plugin's settings when given its id. */
async function openManager(page, state = {}, pluginId) {
    await openApp(page, { plugins: installed, pluginSettings: settings, ...state });
    await page.evaluate(id => document.querySelector('app-plugins-drawer').open(id), pluginId);
    const manager = page.locator('webui-drawer.shared app-plugin-manager');
    await expect(manager.locator('webui-tabs.plugin-tabs')).toBeVisible();
    return manager;
}
const tabButton = (manager, name) => manager.locator(`webui-button.plugin-tab-${name}`);
const list = (manager, name) => manager.locator(`.plugin-${name} .plugin-picker`);
const detail = (manager, name) => manager.locator(`.plugin-${name} .plugin-detail`);
/** Chooses a plugin from a tab's list, going back to the list first when the drawer is too narrow for both. */
async function choose(manager, name, id) {
    const split = manager.locator(`.plugin-${name} webui-split-panes`);
    const item = list(manager, name).locator(`[data-pick="${id}"]`);
    // The split decides whether both fit once it has a width, as its size observer reports it.
    await expect.poll(() => split.evaluate(el => el.clientWidth > 0 && el.hasAttribute('narrow') === (el.clientWidth < 220 * 2 + 8))).toBe(true);
    if (await split.evaluate(el => el.hasAttribute('narrow') && el.getAttribute('show') === 'end')) {
        await split.getByRole('button', { name: name === 'installed' ? 'Installed plugins' : 'Available plugins' }).click();
    }
    await item.click();
    await expect(detail(manager, name)).toBeVisible();
}

test('settings fields that have no value are empty, not "null"', async ({ page }) => {
    const empty = { jira: [
        { key: 'jira_site', label: 'Jira site', help: '', secret: false, isSet: false, value: null },
        { key: 'jira_api_token', label: 'API token', help: '', secret: true, isSet: false, value: null },
    ] };
    const manager = await openManager(page, { pluginSettings: empty });
    for (const name of ['jira_site', 'jira_api_token']) {
        const field = manager.locator(`webui-input-text[name="${name}"]`);
        await expect(field.locator('input')).toHaveValue('');
        await expect(field).not.toHaveAttribute('placeholder');
        await expect(field.locator('input')).not.toHaveAttribute('placeholder', 'null');
    }
    await expect(manager.locator('webui-input-text[name="jira_site"]')).not.toHaveAttribute('type');
});

test('with none installed, the Installed tab says so', async ({ page }) => {
    const manager = await openManager(page, { plugins: [] });
    await expect(tabButton(manager, 'installed')).toHaveText('Installed (0)');
    await expect(list(manager, 'installed').locator('.plugin-empty')).toHaveText('No plugins are installed yet.');
});

test('installing from a folder shows the permissions first, and Cancel installs nothing', async ({ page }) => {
    const manager = await openManager(page, { plugins: [], pickedFolder: '/home/me/jira', pluginFolder: { manifest: jira } });
    await tabButton(manager, 'folder').click();
    const install = manager.locator('webui-button', { hasText: 'Install from folder' });
    await install.click();
    const dialog = openDialog(page);
    await expect(dialog).toContainText('Jira 0.1.0');
    await expect(dialog).toContainText('Connect to *.atlassian.net');
    await expect(dialog).toContainText('not signed');
    await dialogButton(page, 'Cancel').click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => calls(page, 'plugin_install_folder')).toEqual([]);
    await install.click();
    await dialogButton(page, 'Install').click();
    // The new plugin shows on the Installed tab, chosen, where its settings are.
    await expect(detail(manager, 'installed').locator('[data-plugin="jira"] webui-badge.plugin-badge')).toHaveText('From a folder');
    await expect(detail(manager, 'installed')).toBeVisible();
    await expect.poll(() => calls(page, 'plugin_install_folder')).toEqual([{ folder: '/home/me/jira' }]);
    await expect(page.locator('webui-nav.plugin-nav [url="/plugin/jira/issues"]')).toHaveCount(1);
});

test('choosing no folder does nothing', async ({ page }) => {
    const manager = await openManager(page, { pickedFolder: null, pluginFolder: { manifest: jira } });
    await tabButton(manager, 'folder').click();
    const install = manager.locator('webui-button', { hasText: 'Install from folder' });
    await install.click();
    await expect(openDialog(page)).toHaveCount(0);
    await expect.poll(() => calls(page, 'plugin_inspect_folder')).toEqual([]);
    // Choosing a folder the next time reads only that folder, so the first time read nothing.
    await page.evaluate(() => { webui.proxy.plugins.pickFolder = async () => '/home/me/jira'; });
    await install.click();
    await expect(openDialog(page)).toContainText('Jira 0.1.0');
    await expect.poll(() => calls(page, 'plugin_inspect_folder')).toEqual([{ folder: '/home/me/jira' }]);
});

test('settings keep a saved secret unless a new one is typed', async ({ page }) => {
    const manager = await openManager(page);
    const card = manager.locator('[data-plugin="jira"]');
    const site = card.locator('webui-input-text[name="jira_site"] input');
    await expect(site).toHaveValue('https://team.atlassian.net');
    await expect(card.locator('webui-input-text[name="jira_api_token"] input')).toHaveAttribute('type', 'password');
    await site.fill('https://other.atlassian.net');
    await card.locator('webui-button', { hasText: 'Save settings' }).click();
    await expect.poll(() => calls(page, 'plugin_save_settings')).toEqual([{ id: 'jira', values: { jira_site: 'https://other.atlassian.net' } }]);
    await card.locator('webui-input-text[name="jira_api_token"] input').fill('new-token');
    await card.locator('webui-button', { hasText: 'Save settings' }).click();
    await expect.poll(async () => (await calls(page, 'plugin_save_settings')).at(-1)).toEqual({
        id: 'jira', values: { jira_site: 'https://other.atlassian.net', jira_api_token: 'new-token' },
    });
});

test('a saved secret can be cleared', async ({ page }) => {
    const manager = await openManager(page);
    const card = manager.locator('[data-plugin="jira"]');
    await card.locator('webui-button', { hasText: 'Clear API token' }).click();
    await dialogButton(page, 'Confirm').click();
    await expect.poll(() => calls(page, 'plugin_save_settings')).toEqual([{ id: 'jira', values: { jira_api_token: '' } }]);
});

test('a plugin can be turned off and removed', async ({ page }) => {
    const manager = await openManager(page);
    const card = manager.locator('[data-plugin="jira"]');
    await card.locator('webui-button', { hasText: 'Turn off' }).click();
    await expect(card).toContainText('Turned off');
    await expect(list(manager, 'installed').locator('[data-pick="jira"]')).toContainText('Turned off');
    await expect.poll(() => calls(page, 'plugin_set_enabled')).toEqual([{ id: 'jira', enabled: false }]);
    await expect(page.locator('webui-nav.plugin-nav [url="/plugin/jira/issues"]')).toHaveCount(0);
    await card.locator('webui-button', { hasText: 'Remove' }).click();
    await expect(openDialog(page)).toContainText('with its settings and saved data');
    await dialogButton(page, 'Confirm').click();
    await expect(manager.locator('[data-plugin="jira"]')).toHaveCount(0);
    await expect(tabButton(manager, 'installed')).toHaveText('Installed (0)');
    await expect.poll(() => calls(page, 'plugin_remove')).toEqual([{ id: 'jira' }]);
});

test("a plugin's settings link opens it on the Installed tab, chosen, even after another tab was left open", async ({ page }) => {
    await openApp(page, { plugins: [{ id: 'notes', version: '1.0.0', enabled: true, signed: true, manifest: notes }, ...installed], pluginSettings: settings });
    await page.evaluate(() => webui.setData('session-plugins-tab-index', 2));
    await page.evaluate(() => document.querySelector('app-plugins-drawer').open('jira'));
    const manager = page.locator('webui-drawer.shared app-plugin-manager');
    const card = detail(manager, 'installed').locator('[data-plugin="jira"]');
    await expect(card).toHaveClass(/plugin-highlight/);
    await expect(card.locator('webui-input-text[name="jira_site"]')).toBeVisible();
    await expect(list(manager, 'installed').locator('.plugin-pick[aria-selected="true"]')).toHaveAttribute('data-pick', 'jira');
});

test('the tab chosen is remembered the next time the drawer opens', async ({ page }) => {
    const manager = await openManager(page);
    await tabButton(manager, 'folder').click();
    await expect(manager.locator('webui-button', { hasText: 'Install from folder' })).toBeVisible();
    await page.evaluate(() => document.querySelector('app-plugins-drawer').open());
    await expect(page.locator('webui-drawer.shared app-plugin-manager webui-button', { hasText: 'Install from folder' })).toBeVisible();
});

test.describe('catalog', () => {
    const entry = (version, extra = {}) => ({
        id: 'jira', name: 'Jira', version, apiVersion: 1, description: 'Jira Cloud in Task Proxy.', category: 'issue-tracking',
        permissions: jira.permissions, ...extra,
    });

    test('a catalog plugin shows what it would reach, and installs after showing its permissions', async ({ page }) => {
        const manager = await openManager(page, { plugins: [], catalog: [entry('0.1.0')], catalogManifests: { jira } });
        await tabButton(manager, 'available').click();
        const card = detail(manager, 'available').locator('[data-catalog="jira"]');
        await expect(card.locator('.plugin-permissions')).toContainText('Connect to *.atlassian.net');
        await card.locator('webui-button', { hasText: 'Install' }).click();
        const dialog = openDialog(page);
        await expect(dialog).toContainText('Connect to *.atlassian.net');
        await expect(dialog).toContainText('Signed by Stoic Dreams');
        await dialogButton(page, 'Install').click();
        await expect(card.locator('[data-role="installed"]')).toHaveText('Installed (v0.1.0)');
        await expect(list(manager, 'available').locator('[data-pick="jira"]')).toContainText('Installed');
        await expect(detail(manager, 'installed').locator('[data-plugin="jira"] webui-badge.plugin-badge').first()).toHaveText('Signed');
        await expect.poll(() => calls(page, 'plugin_install_catalog')).toEqual([{ id: 'jira' }]);
    });

    test('a newer version is offered as an update, on both tabs', async ({ page }) => {
        const manager = await openManager(page, { catalog: [entry('0.10.0')], catalogManifests: { jira: { ...jira, version: '0.10.0' } } });
        await expect(tabButton(manager, 'available')).toHaveText('Available (1 update)');
        await expect(list(manager, 'installed').locator('[data-pick="jira"]')).toContainText('Update');
        await expect(detail(manager, 'installed').locator('webui-button', { hasText: 'Update to v0.10.0' })).toBeVisible();
        await tabButton(manager, 'available').click();
        await expect(detail(manager, 'available').locator('[data-catalog="jira"] webui-button')).toHaveText('Update to v0.10.0');
    });

    test('a plugin for a plugin spec this app does not support says which side to update, and offers no install', async ({ page }) => {
        const reason = 'Jira supports plugin spec 0.2.0, and this version of Task Proxy supports 0.1.1. Update Task Proxy to use it.';
        const manager = await openManager(page, { plugins: [], catalog: [entry('0.4.0', { spec: ['0.2.0'], incompatible: reason })] });
        await tabButton(manager, 'available').click();
        await expect(list(manager, 'available').locator('[data-pick="jira"]')).toContainText('Needs an update');
        const card = detail(manager, 'available').locator('[data-catalog="jira"]');
        await expect(card.locator('[data-role="incompatible"]')).toHaveText(reason);
        await expect(card.locator('webui-button')).toHaveCount(0);
    });

    test('a catalog that cannot be reached says so, and installed plugins still show', async ({ page }) => {
        const manager = await openManager(page);
        await tabButton(manager, 'available').click();
        await expect(manager.locator('[data-role="catalog-state"]')).toContainText('could not be reached');
        await tabButton(manager, 'installed').click();
        await expect(manager.locator('[data-plugin="jira"]')).toBeVisible();
    });
});

