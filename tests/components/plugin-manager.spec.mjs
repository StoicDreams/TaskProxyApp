import { test, expect, openApp, calls, dialogButton } from '../support/app.mjs';

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

async function openManager(page, state = {}, path = '/plugins') {
    await openApp(page, { plugins: installed, pluginSettings: settings, currentPage: path, ...state }, path);
    // The page before the project reload can still be leaving, with its own manager.
    await expect(page.locator('app-plugin-manager')).toHaveCount(1);
    const manager = page.locator('app-plugin-manager');
    await expect(manager.locator('webui-button', { hasText: 'Install from folder' })).toBeVisible();
    return manager;
}

test('installed plugins show what they can reach', async ({ page }) => {
    const manager = await openManager(page);
    const card = manager.locator('[data-plugin="jira"]');
    await expect(card.locator('h3')).toHaveText('Jira');
    await expect(card.locator('.plugin-badge')).toHaveText('Signed');
    await expect(card.locator('.plugin-permissions')).toContainText('Connect to *.atlassian.net');
    await expect(card.locator('.plugin-permissions')).toContainText('Read its settings: Jira site, API token');
    await expect(card.locator('.plugin-permissions')).toContainText('Create a branch when you click its button');
    await expect(card.locator('.plugin-permissions')).toContainText('.taskproxy/plugins/jira');
});

test('with none installed, the page says so', async ({ page }) => {
    const manager = await openManager(page, { plugins: [] });
    await expect(manager.locator('.plugin-list .plugin-empty')).toHaveText('No plugins are installed yet.');
});

test('installing from a folder shows the permissions first, and Cancel installs nothing', async ({ page }) => {
    const manager = await openManager(page, { plugins: [], pickedFolder: '/home/me/jira', pluginFolder: { manifest: jira } });
    await manager.locator('webui-button', { hasText: 'Install from folder' }).click();
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toContainText('Jira 0.1.0');
    await expect(dialog).toContainText('Connect to *.atlassian.net');
    await expect(dialog).toContainText('not signed');
    await dialogButton(page, 'Cancel').click();
    await expect(dialog).toHaveCount(0);
    expect(await calls(page, 'plugin_install_folder')).toEqual([]);
    await manager.locator('webui-button', { hasText: 'Install from folder' }).click();
    await dialogButton(page, 'Install').click();
    await expect(manager.locator('[data-plugin="jira"] .plugin-badge')).toHaveText('From a folder');
    expect(await calls(page, 'plugin_install_folder')).toEqual([{ folder: '/home/me/jira' }]);
    await expect(page.locator('webui-nav.plugin-nav [url="/plugin/jira/issues"]')).toHaveCount(1);
});

test('choosing no folder does nothing', async ({ page }) => {
    const manager = await openManager(page, { pickedFolder: null });
    await manager.locator('webui-button', { hasText: 'Install from folder' }).click();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    expect(await calls(page, 'plugin_inspect_folder')).toEqual([]);
});

test('settings keep a saved secret unless a new one is typed', async ({ page }) => {
    const manager = await openManager(page);
    const card = manager.locator('[data-plugin="jira"]');
    await card.locator('details summary').click();
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
    await card.locator('details summary').click();
    await card.locator('webui-button', { hasText: 'Clear API token' }).click();
    await dialogButton(page, 'Confirm').click();
    await expect.poll(() => calls(page, 'plugin_save_settings')).toEqual([{ id: 'jira', values: { jira_api_token: '' } }]);
});

test('a plugin can be turned off and removed', async ({ page }) => {
    const manager = await openManager(page);
    const card = manager.locator('[data-plugin="jira"]');
    await card.locator('webui-button', { hasText: 'Turn off' }).click();
    await expect(card).toContainText('Turned off');
    expect(await calls(page, 'plugin_set_enabled')).toEqual([{ id: 'jira', enabled: false }]);
    await expect(page.locator('webui-nav.plugin-nav [url="/plugin/jira/issues"]')).toHaveCount(0);
    await card.locator('webui-button', { hasText: 'Remove' }).click();
    await expect(page.locator('dialog[open]')).toContainText('with its settings and saved data');
    await dialogButton(page, 'Confirm').click();
    await expect(manager.locator('[data-plugin="jira"]')).toHaveCount(0);
    expect(await calls(page, 'plugin_remove')).toEqual([{ id: 'jira' }]);
});

test("a plugin's settings link opens its settings", async ({ page }) => {
    const manager = await openManager(page, {}, '/plugins?plugin=jira');
    const card = manager.locator('[data-plugin="jira"]');
    await expect(card).toHaveClass(/plugin-highlight/);
    await expect(card.locator('webui-input-text[name="jira_site"]')).toBeVisible();
});

test.describe('catalog', () => {
    const entry = (version) => ({
        id: 'jira', name: 'Jira', version, apiVersion: 1, description: 'Jira Cloud in Task Proxy.', category: 'issue-tracking',
        permissions: jira.permissions,
    });

    test('a catalog plugin installs after showing its permissions', async ({ page }) => {
        const manager = await openManager(page, { plugins: [], catalog: [entry('0.1.0')], catalogManifests: { jira } });
        const card = manager.locator('[data-catalog="jira"]');
        await card.locator('webui-button', { hasText: 'Install' }).click();
        const dialog = page.locator('dialog[open]');
        await expect(dialog).toContainText('Connect to *.atlassian.net');
        await expect(dialog).toContainText('Signed by Stoic Dreams');
        await dialogButton(page, 'Install').click();
        await expect(card.locator('.plugin-badge')).toHaveText('Installed');
        await expect(manager.locator('[data-plugin="jira"] .plugin-badge').first()).toHaveText('Signed');
        expect(await calls(page, 'plugin_install_catalog')).toEqual([{ id: 'jira' }]);
    });

    test('a newer version is offered as an update', async ({ page }) => {
        const manager = await openManager(page, { catalog: [entry('0.10.0')], catalogManifests: { jira: { ...jira, version: '0.10.0' } } });
        await expect(manager.locator('[data-catalog="jira"] webui-button')).toHaveText('Update to v0.10.0');
    });

    test('a catalog that cannot be reached says so, and installed plugins still show', async ({ page }) => {
        const manager = await openManager(page);
        // webui-flex copies its class to its own slot, so name the element.
        await expect(manager.locator('webui-flex.plugin-catalog')).toContainText('could not be reached');
        await expect(manager.locator('[data-plugin="jira"]')).toBeVisible();
    });
});
