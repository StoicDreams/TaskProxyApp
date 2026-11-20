import { test, expect, openApp, calls, dialogButton, openDialog } from '../../support/app.mjs';

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

test('installed plugins are listed with their state, and the chosen one shows what it can reach', async ({ page }) => {
    const manager = await openManager(page, { plugins: [...installed, { id: 'notes', version: '1.0.0', enabled: false, signed: false, manifest: notes }] });
    await expect(tabButton(manager, 'installed')).toHaveText('Installed (2)');
    await expect(list(manager, 'installed').locator('.plugin-pick')).toHaveText([/Jira v0\.1\.0\s*Set up here\s*$/, /Notes v1\.0\.0\s*Turned off\s*$/]);
    await expect(list(manager, 'installed').locator('.plugin-pick[aria-selected="true"]')).toHaveAttribute('data-pick', 'jira');
    const card = detail(manager, 'installed').locator('[data-plugin="jira"]');
    await expect(card.locator('h3')).toHaveText('Jira');
    await expect(card.locator('webui-badge.plugin-badge')).toHaveText('Signed');
    await expect(card.locator('.plugin-permissions')).toContainText('Connect to *.atlassian.net');
    await expect(card.locator('.plugin-permissions')).toContainText('Read its settings: Jira site, API token');
    await expect(card.locator('.plugin-permissions')).toContainText('Create a branch when you click its button');
    await expect(card.locator('.plugin-permissions')).toContainText('.taskproxy/plugins/jira');
    // Its settings for the open project show with it, with nothing to open first.
    await expect(card.locator('webui-input-text[name="jira_site"]')).toBeVisible();
    await choose(manager, 'installed', 'notes');
    await expect(detail(manager, 'installed').locator('[data-plugin="notes"]')).toContainText('From a folder');
    await expect(detail(manager, 'installed').locator('[data-plugin="jira"]')).toHaveCount(0);
    await expect(list(manager, 'installed').locator('.plugin-pick[aria-selected="true"]')).toHaveAttribute('data-pick', 'notes');
});

test.describe('catalog', () => {
    const entry = (version, extra = {}) => ({
        id: 'jira', name: 'Jira', version, apiVersion: 1, description: 'Jira Cloud in Task Proxy.', category: 'issue-tracking',
        permissions: jira.permissions, ...extra,
    });

    test('each catalog plugin is chosen from the list', async ({ page }) => {
        const manager = await openManager(page, { plugins: [], catalog: [entry('0.1.0'), { ...notes, permissions: {} }] });
        await tabButton(manager, 'available').click();
        await expect(list(manager, 'available').locator('.plugin-pick')).toHaveText([/Jira v0\.1\.0/, /Notes v1\.0\.0/]);
        await choose(manager, 'available', 'notes');
        await expect(detail(manager, 'available').locator('[data-catalog="notes"]')).toContainText('Notes beside your work.');
        await expect(detail(manager, 'available').locator('[data-catalog="jira"]')).toHaveCount(0);
    });

});

test('in a narrow drawer, the list and the chosen plugin take turns', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 800 });
    const manager = await openManager(page, { plugins: [...installed, { id: 'notes', version: '1.0.0', enabled: true, signed: true, manifest: notes }] });
    const split = manager.locator('.plugin-installed webui-split-panes');
    await page.evaluate(() => { document.querySelector('webui-drawer.shared').style.width = '360px'; });
    await expect(split).toHaveAttribute('narrow', '');
    // It opens on the chosen plugin, with a strip back to the list.
    await expect(detail(manager, 'installed').locator('[data-plugin="jira"]')).toBeVisible();
    await split.getByRole('button', { name: 'Installed plugins' }).click();
    await expect(split).toHaveAttribute('show', 'start');
    await list(manager, 'installed').locator('[data-pick="notes"]').click();
    await expect(split).toHaveAttribute('show', 'end');
    await expect(detail(manager, 'installed').locator('[data-plugin="notes"]')).toBeVisible();
    await split.getByRole('button', { name: 'Installed plugins' }).click();
    await expect(split).toHaveAttribute('show', 'start');
    await expect(list(manager, 'installed').locator('[data-pick="jira"]')).toBeVisible();
});
