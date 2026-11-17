import { test, expect, openApp, openPage, calls, dialogButton } from '../support/app.mjs';

const open = async page => {
    await page.locator('app-var-manager').click();
    await page.locator('#env-selector').waitFor({ state: 'attached' });
    await page.locator('#var-project-list').waitFor({ state: 'attached' });
    await page.waitForTimeout(150);
};
const selectEnv = (page, name) => page.locator('#env-selector').evaluate((el, name) => {
    el.value = name;
    el.dispatchEvent(new Event('change', { bubbles: true }));
}, name);
const envData = environments => ({ _environments: environments, _activeEnvironment: environments[0].name });

test('project and global variables are listed with their values', async ({ page }) => {
    await openApp(page, { data: { one: 'first' }, variables: ['one|text|'], appData: { two: 'second' }, appVariables: ['two|text|'] });
    await open(page);
    await expect(page.locator('#var-project-list webui-input-text input')).toHaveValue('first');
    await expect(page.locator('#var-global-list webui-input-text input')).toHaveValue('second');
});
test('scope switches show on for a new install', async ({ page }) => {
    await openApp(page, { newInstall: true });
    await open(page);
    for (const key of ['app-env-page-enabled', 'app-env-project-enabled', 'app-env-global-enabled']) {
        expect(await page.locator(`webui-toggle-icon[data-bind="${key}"]`).evaluate(el => el.value), key).toBe(true);
    }
});
test('variable names from project files are shown as text', async ({ page }) => {
    const name = '<img src=x onerror="window.__xss=1">';
    await openApp(page, { variables: [`${name}|text|`], data: { [name]: 'v' } });
    await open(page);
    await expect(page.locator('#var-project-list span').first()).toHaveText(name);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    await expect(page.locator('#var-project-list img')).toHaveCount(0);
});
test('typing a project value updates the project and its environment', async ({ page }) => {
    await openApp(page, { variables: ['one|text|'] });
    await open(page);
    await page.locator('#var-project-list webui-input-text input').fill('typed');
    expect(await page.evaluate(() => webui.getProjectData('one'))).toBe('typed');
    expect(await page.evaluate(() => webui.projectData.data._environments[0].variables.one)).toBe('typed');
    await expect.poll(async () => page.evaluate(() => window.__backend.savedProjects['/repo'].data.one)).toBe('typed');
});
test('typing a global value writes to disk once, after a pause', async ({ page }) => {
    await openApp(page, { appVariables: ['two|text|'] });
    await open(page);
    const before = (await calls(page, 'save_app_data')).length;
    await page.locator('webui-tabs webui-button', { hasText: 'Global' }).click();
    await page.locator('#var-global-list webui-input-text input').pressSequentially('abcdef');
    await expect.poll(() => page.evaluate(() => webui.taskProxyData.data.two)).toBe('abcdef');
    await expect.poll(async () => (await calls(page, 'save_app_data')).length).toBe(before + 1);
    expect((await calls(page, 'save_app_data')).at(-1).data.data.two).toBe('abcdef');
    // The backend's copy stays current between saves, in case the app closes.
    expect(await page.evaluate(() => window.__backend.appData.data.two)).toBe('abcdef');
});
test('adding a variable defines it, and duplicates are refused', async ({ page }) => {
    await openApp(page);
    await open(page);
    await page.locator('input#input-proj-var').fill('new_one');
    await page.locator('#btn-add-proj').click();
    await expect.poll(() => page.evaluate(() => webui.projectData.variables)).toContain('new_one|text|');
    await page.locator('input#input-proj-var').fill('new_one');
    await page.locator('#btn-add-proj').click();
    expect(await page.evaluate(() => webui.projectData.variables.filter(v => v.startsWith('new_one')))).toHaveLength(1);
});
test('deleting a project variable lets a global value of that name show through', async ({ page }) => {
    await openApp(page, { data: { shared: 'project' }, variables: ['shared|text|'], appData: { shared: 'global' }, appVariables: ['shared|text|'] });
    await open(page);
    await page.locator('#var-project-list webui-icon[title="Delete Variable"]').click();
    await dialogButton(page, 'Delete').click();
    await expect.poll(() => page.evaluate(() => webui.projectData.variables)).toEqual([]);
    expect(await page.evaluate(() => webui.getData('shared'))).toBe('global');
});

test.describe('environments', () => {
    const data = envData([{ name: 'dev', variables: { key: 'dev value' } }, { name: 'prod', variables: { key: 'prod value' } }]);
    test('switching loads that environment\'s values', async ({ page }) => {
        await openApp(page, { variables: ['key|text|'], data: { ...data, key: 'dev value' } });
        await open(page);
        await selectEnv(page, 'prod');
        expect(await page.evaluate(() => webui.getProjectData('key'))).toBe('prod value');
        expect(await page.evaluate(() => webui.projectData.data._activeEnvironment)).toBe('prod');
    });
    test('switching does not delete the git token', async ({ page }) => {
        await openApp(page, { variables: ['git_pat|secret|', 'key|text|'], data: { ...data, git_pat: 'TOKEN' } });
        await open(page);
        await selectEnv(page, 'prod');
        await selectEnv(page, 'dev');
        expect(await page.evaluate(() => webui.getProjectData('git_pat'))).toBe('TOKEN');
    });
    test('values set before environments existed survive switching away and back', async ({ page }) => {
        await openApp(page, { variables: ['old_key|text|'], data: { old_key: 'precious' } });
        await open(page);
        await page.evaluate(() => webui.projectData.data._environments.push({ name: 'other', variables: {} }));
        await page.locator('#btn-manage-env').click();
        await dialogButton(page, 'Done').click();
        // Clicking while the drawer is open closes it and rebuilds it about a second later,
        // so wait for the rebuilt selector to offer the new environment.
        await page.evaluate(() => document.querySelector('app-var-manager').click());
        await expect.poll(() => page.evaluate(() => {
            const el = document.querySelector('#env-selector');
            if (!el || !document.querySelector('.shared')?.classList.contains('open')) return false;
            const current = el.value;
            el.value = 'other';
            const offered = el.value === 'other';
            el.value = current;
            return offered;
        }), { timeout: 5000 }).toBe(true);
        await selectEnv(page, 'other');
        expect(await page.evaluate(() => webui.getProjectData('old_key'))).toBeUndefined();
        await selectEnv(page, 'dev');
        expect(await page.evaluate(() => webui.getProjectData('old_key'))).toBe('precious');
    });
    test('a value missing from the new environment falls back to global', async ({ page }) => {
        await openApp(page, { variables: ['shared|text|'], data: { ...envData([{ name: 'dev', variables: { shared: 'dev' } }, { name: 'empty', variables: {} }]), shared: 'dev' }, appData: { shared: 'global' }, appVariables: ['shared|text|'] });
        await open(page);
        await selectEnv(page, 'empty');
        expect(await page.evaluate(() => webui.getData('shared'))).toBe('global');
    });
    test('environments can be added', async ({ page }) => {
        await openApp(page);
        await open(page);
        await page.locator('#btn-manage-env').click();
        const input = page.locator('input[id^="new-env-input"]');
        await input.fill('staging');
        await page.locator('webui-button[id^="btn-add-env"]').click();
        await expect.poll(() => page.evaluate(() => webui.projectData.data._environments.map(env => env.name))).toEqual(['dev', 'staging']);
        await expect(page.locator('webui-button.env-del-btn')).toHaveCount(2);
    });
    test('a duplicate environment is refused', async ({ page }) => {
        await openApp(page);
        await open(page);
        await page.locator('#btn-manage-env').click();
        await page.locator('input[id^="new-env-input"]').fill('DEV');
        await page.locator('webui-button[id^="btn-add-env"]').click();
        await page.waitForTimeout(100);
        expect(await page.evaluate(() => webui.projectData.data._environments)).toHaveLength(1);
    });
    test('environments can be renamed', async ({ page }) => {
        await openApp(page, { data: envData([{ name: 'dev', variables: {} }]) });
        await open(page);
        await page.locator('#btn-manage-env').click();
        await page.locator('webui-grid:has(webui-button.env-save-btn) webui-input-text input').fill('renamed');
        await page.locator('webui-button.env-save-btn').click();
        await expect.poll(() => page.evaluate(() => [webui.projectData.data._environments[0].name, webui.projectData.data._activeEnvironment])).toEqual(['renamed', 'renamed']);
    });
    test('the last environment cannot be deleted', async ({ page }) => {
        await openApp(page, { data: envData([{ name: 'dev', variables: {} }]) });
        await open(page);
        await page.locator('#btn-manage-env').click();
        await page.locator('webui-button.env-del-btn').click();
        await page.waitForTimeout(100);
        expect(await page.evaluate(() => webui.projectData.data._environments)).toHaveLength(1);
    });
    test('deleting the active environment loads the next one\'s values', async ({ page }) => {
        await openApp(page, { variables: ['key|text|'], data: { ...data, key: 'dev value' } });
        await open(page);
        await page.locator('#btn-manage-env').click();
        await page.locator('webui-button.env-del-btn[data-env="dev"]').click();
        await expect.poll(() => page.evaluate(() => webui.projectData.data._activeEnvironment)).toBe('prod');
        expect(await page.evaluate(() => webui.getProjectData('key'))).toBe('prod value');
    });
    test('environment names are escaped in markup', async ({ page }) => {
        await openApp(page, { data: envData([{ name: '"><img src=x onerror="window.__xss=1">', variables: {} }]) });
        await open(page);
        await page.locator('#btn-manage-env').click();
        await page.locator('webui-button.env-del-btn').waitFor();
        expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    });
});

test.describe('values kept on the desktop', () => {
    // A remote device is sent { $secret: true } in place of each secret value.
    const kept = { $secret: true };
    test('show as set, with an empty field that replaces them', async ({ page }) => {
        await openApp(page, { data: { db_password: kept }, variables: ['db_password|secret|'], appData: { api_key: kept }, appVariables: ['api_key|secret|'] });
        await open(page);
        for (const list of ['#var-project-list', '#var-global-list']) {
            const field = page.locator(`${list} webui-input-text`).first();
            await expect(field.locator('input')).toHaveValue('');
            await expect(field).toHaveAttribute('placeholder', 'Set. Type to replace it.');
        }
        expect(await page.locator('app-var-manager, webui-drawer.shared').first().evaluate(() => document.body.innerText)).not.toContain('[object Object]');
        await page.locator('#var-project-list webui-input-text input').fill('new password');
        expect(await page.evaluate(() => webui.getProjectData('db_password'))).toBe('new password');
    });
    test('cannot be copied to another scope or the clipboard from here', async ({ page }) => {
        await openApp(page, { data: { db_password: kept }, variables: ['db_password|secret|'] });
        await open(page);
        await page.evaluate(() => {
            window.__copied = [];
            webui.copyToClipboard = text => window.__copied.push(text);
        });
        await page.locator('#var-project-list webui-icon[title="Copy Value to Global Scope"]').first().click();
        await page.locator('#var-project-list webui-icon[title="Copy Value to Clipboard"]').first().click();
        await page.waitForTimeout(100);
        expect(await page.evaluate(() => webui.getGlobalData('db_password'))).toBeUndefined();
        expect(await page.evaluate(() => window.__copied)).toEqual([]);
    });
});
test('the Variables button counts the variables on the page shown, and none on pages without them', async ({ page }) => {
    await openPage(page, '<webui-input-text data-bind="first"></webui-input-text>\n\n<webui-input-text data-bind="second"></webui-input-text>\n\n<webui-data data-third="3"></webui-data>');
    const count = page.locator('app-var-manager webui-icon');
    await expect(count).toHaveAttribute('count', '3');
    await page.evaluate(() => webui.navigateTo('/'));
    await expect(count).not.toHaveAttribute('count', /\d/);
});
