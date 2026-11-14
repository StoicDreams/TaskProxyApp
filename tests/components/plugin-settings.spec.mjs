import { test, expect, openApp, calls, dialogButton } from '../support/app.mjs';

const jira = {
    id: 'jira', name: 'Jira', version: '0.1.0', apiVersion: 1, icon: 'ticket',
    permissions: {
        hosts: ['*.atlassian.net'],
        variables: [{ key: 'jira_site', label: 'Jira site' }, { key: 'jira_api_token', label: 'API token', secret: true }],
        git: [],
    },
    pages: [{ id: 'issues', name: 'My Issues' }, { id: 'views', name: 'Views' }],
};
const fields = (set = false) => [
    { key: 'jira_site', label: 'Jira site', help: 'Your Jira address', secret: false, isSet: set, value: set ? 'https://team.atlassian.net' : null },
    { key: 'jira_api_token', label: 'API token', help: '', secret: true, isSet: set, value: null },
];
const work = { id: 'sign-in-1', label: 'https://team.atlassian.net', projects: 2 };

async function openSettings(page, view, plugin = {}) {
    await openApp(page, {
        plugins: [{ id: 'jira', version: '0.1.0', enabled: true, signed: true, manifest: jira, ...plugin }],
        pluginSettings: { jira: view },
    });
    // Where it is used: the Plugins drawer, opened on the plugin's settings.
    await page.evaluate(() => {
        window.__changed = 0;
        document.addEventListener('plugin-settings-changed', () => window.__changed++);
        document.querySelector('app-plugins-drawer').open('jira');
    });
    const settings = page.locator('app-plugin-settings');
    await expect(settings.locator('webui-input-text').first()).toBeVisible();
    return settings;
}

test("a project's own settings can be changed, and it can stop using them", async ({ page }) => {
    const settings = await openSettings(page, { hasProject: true, signIn: 'sign-in-1', settings: fields(true), signIns: [work] });
    // Another project uses the same settings, so changing them is said to change them there.
    await expect(settings).toContainText('as one other project does');
    await expect(settings.locator('webui-input-text[name="jira_site"]')).toHaveAttribute('value', 'https://team.atlassian.net');
    await expect(settings.locator('[data-role="sign-in-choice"]')).toHaveCount(0);
    await settings.locator('webui-button', { hasText: 'Save settings' }).click();
    await expect.poll(() => calls(page, 'plugin_save_settings')).toEqual([{ id: 'jira', values: { jira_site: 'https://team.atlassian.net' } }]);
    await expect.poll(() => page.evaluate(() => window.__changed)).toBe(1);
    await settings.locator('[data-role="stop-using"]').click();
    await dialogButton(page, 'Confirm').click();
    await expect.poll(() => calls(page, 'plugin_use_sign_in')).toEqual([{ id: 'jira', signIn: null }]);
    // With none, it offers the settings other projects use, or new ones.
    await expect(settings.locator('[data-role="sign-in-choice"]')).toBeVisible();
    await expect(settings).toContainText('Or enter new settings for this project');
});

test('a project with no settings can use those of another project', async ({ page }) => {
    const settings = await openSettings(page, { hasProject: true, signIn: null, settings: fields(), signIns: [work] });
    const choice = settings.locator('[data-role="sign-in-choice"]');
    await expect(choice.locator('webui-dropdown')).toContainText('https://team.atlassian.net (2 projects)');
    await choice.locator('webui-button', { hasText: 'Use these' }).click();
    await expect.poll(() => calls(page, 'plugin_use_sign_in')).toEqual([{ id: 'jira', signIn: 'sign-in-1' }]);
    await expect(settings.locator('[data-role="stop-using"]')).toBeVisible();
    await expect(settings.locator('webui-input-text[name="jira_site"]')).toHaveAttribute('value', 'jira_site of sign-in-1');
});

test("a project's new settings are saved for it alone", async ({ page }) => {
    const settings = await openSettings(page, { hasProject: true, signIn: null, settings: fields(), signIns: [] });
    await expect(settings).toContainText('Other projects keep their own');
    await expect(settings.locator('[data-role="sign-in-choice"]')).toHaveCount(0);
    await settings.locator('webui-input-text[name="jira_site"] input').fill('https://mine.atlassian.net');
    await settings.locator('webui-input-text[name="jira_api_token"] input').fill('token-1');
    await settings.locator('webui-button', { hasText: 'Save for this project' }).click();
    await expect.poll(() => calls(page, 'plugin_save_settings')).toEqual([{ id: 'jira', values: { jira_site: 'https://mine.atlassian.net', jira_api_token: 'token-1' } }]);
});

test('with no project open, it asks for one', async ({ page }) => {
    await openApp(page, { plugins: [{ id: 'jira', version: '0.1.0', enabled: true, signed: true, manifest: jira }], pluginSettings: { jira: { hasProject: false, signIn: null, settings: fields(), signIns: [] } } });
    await page.evaluate(() => document.querySelector('app-plugins-drawer').open('jira'));
    await expect(page.locator('app-plugin-settings')).toContainText('Open one to set this plugin up for it.');
});

test.describe('plugins set up per project', () => {
    const nav = page => page.locator('webui-nav.plugin-nav');

    test("a plugin not set up anywhere stays out of the nav, and its pages ask for its settings", async ({ page }) => {
        await openApp(page, {
            plugins: [{ id: 'jira', version: '0.1.0', enabled: true, signed: true, manifest: jira, configured: false, signIns: 0 }],
            pluginSettings: { jira: { hasProject: true, signIn: null, settings: fields(), signIns: [] } },
            pluginPages: { 'jira/issues': { type: 'text', text: 'The issues' } },
            currentPage: '/plugin/jira/issues',
        }, '/plugin/jira/issues');
        await expect(nav(page)).not.toContainText('Jira');
        const view = page.locator('app-plugin-page');
        await expect(view.locator('h3')).toHaveText(/^Set up Jira for /);
        await expect(view.locator('app-plugin-settings webui-input-text')).toHaveCount(2);
        expect(await calls(page, 'plugin_render')).toEqual([]);
        // Once saved, the page shows.
        await page.evaluate(() => {
            const list = window.__backend.handlers.plugin_list;
            window.__backend.handlers.plugin_list = () => list().map(plugin => ({ ...plugin, configured: true, signIns: 1 }));
        });
        await view.locator('webui-input-text[name="jira_site"] input').fill('https://mine.atlassian.net');
        await view.locator('webui-button', { hasText: 'Save for this project' }).click();
        await expect(view).toContainText('The issues');
        await expect(nav(page).locator('[url="/plugin/jira/views"]')).toHaveCount(1);
    });

    test('a project not set up for a plugin never shows it, even when other projects are', async ({ page }) => {
        await openApp(page, {
            plugins: [{ id: 'jira', version: '0.1.0', enabled: true, signed: true, manifest: jira, configured: false, signIns: 1 }],
            pluginSettings: { jira: { hasProject: true, signIn: null, settings: fields(), signIns: [work] } },
        });
        await expect(page.locator('app-plugin-settings')).toHaveCount(0);
        await expect(nav(page)).not.toContainText('Jira');
        await expect(nav(page).locator('[url^="/plugin/jira/"]')).toHaveCount(0);
        // It is set up from the Plugins drawer, which opens its settings, offering those of the other projects.
        await page.evaluate(() => document.querySelector('app-plugins-drawer').open('jira'));
        const card = page.locator('webui-drawer.shared [data-plugin="jira"]');
        await expect(card.locator('[data-role="project-state"]')).toHaveText(/not set up/);
        await expect(card.locator('[data-role="sign-in-choice"]')).toBeVisible();
        await page.evaluate(() => {
            const list = window.__backend.handlers.plugin_list;
            window.__backend.handlers.plugin_list = () => list().map(plugin => ({ ...plugin, configured: true }));
        });
        await card.locator('[data-role="sign-in-choice"] webui-button', { hasText: 'Use these' }).click();
        await expect(nav(page).locator('[url="/plugin/jira/views"]')).toHaveCount(1);
    });

    test('a plugin with no settings is turned on for each project that uses it', async ({ page }) => {
        const notes = { id: 'notes', name: 'Notes', version: '0.1.0', apiVersion: 1, icon: 'note-sticky', permissions: { hosts: [], variables: [], git: [] }, pages: [{ id: 'list', name: 'All Notes' }] };
        await openApp(page, {
            plugins: [{ id: 'notes', version: '0.1.0', enabled: true, signed: true, manifest: notes, configured: false }],
        });
        await expect(nav(page)).not.toContainText('Notes');
        await page.evaluate(() => document.querySelector('app-plugins-drawer').open('notes'));
        const card = page.locator('webui-drawer.shared [data-plugin="notes"]');
        await expect(card).toContainText('Use in this project');
        const turn = card.locator('[data-role="use-in-project"]');
        await expect(turn).toContainText('Use in this project');
        await turn.click();
        await expect.poll(() => calls(page, 'plugin_use_in_project')).toEqual([{ id: 'notes', used: true }]);
        await expect(nav(page).locator('[url="/plugin/notes/list"]')).toHaveCount(1);
        await expect(turn).toContainText('Stop using it in this project');
        await turn.click();
        await expect.poll(() => calls(page, 'plugin_use_in_project')).toHaveLength(2);
        await expect(nav(page).locator('[url^="/plugin/notes/"]')).toHaveCount(0);
    });

    test('switching projects asks again which plugins are set up', async ({ page }) => {
        await openApp(page, {
            plugins: [{ id: 'jira', version: '0.1.0', enabled: true, signed: true, manifest: jira }],
        });
        const before = (await calls(page, 'plugin_list')).length;
        await page.evaluate(() => webui.setData('app-current-project', { value: '/projects/other', display: 'Other' }));
        await expect.poll(async () => (await calls(page, 'plugin_list')).length).toBeGreaterThan(before);
    });
});
