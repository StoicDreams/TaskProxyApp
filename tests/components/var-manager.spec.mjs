import { test, expect, openApp, openTool, openPage, calls, dialogButton, openDialog } from '../support/app.mjs';
import { alertPopup } from '../support/wait.mjs';

const open = async page => {
    await openTool(page, 'variables');
    await page.locator('#env-selector').waitFor({ state: 'attached' });
    // The lists are filled in the same step that makes the drawer's controls work, and the drawer opens after it.
    await page.locator('#var-project-list > *').first().waitFor({ state: 'attached' });
    await expect(page.locator('webui-drawer.shared')).toHaveClass(/open/);
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
test('values show masked as page scripts show them, and in full while their field is being edited', async ({ page }) => {
    await openApp(page, { data: { token: 'abcdef123456xyz' }, variables: ['token|text|'], appData: { short: 'abcdef' }, appVariables: ['short|text|'] });
    await open(page);
    const field = page.locator('#var-project-list webui-input-text input');
    await expect(field).toHaveValue('abc***xyz');
    // Six characters or fewer show as they are, as in page scripts.
    await expect(page.locator('#var-global-list webui-input-text input')).toHaveValue('abcdef');
    await field.click();
    await expect(field).toHaveValue('abcdef123456xyz');
    await field.fill('replaced-value-99');
    await expect.poll(() => page.evaluate(() => webui.getProjectData('token'))).toBe('replaced-value-99');
    await field.press('Tab');
    await expect(field).toHaveValue('rep***-99');
    // Leaving the field never saves the masked copy.
    await expect.poll(() => page.evaluate(() => webui.getProjectData('token'))).toBe('replaced-value-99');
});
test('scope switches show on for a new install', async ({ page }) => {
    await openApp(page, { newInstall: true });
    await open(page);
    for (const key of ['app-env-page-enabled', 'app-env-project-enabled', 'app-env-global-enabled']) {
        await expect.poll(() => page.locator(`webui-toggle-icon[data-bind="${key}"]`).evaluate(el => el.value), key).toBe(true);
    }
});
test('variable names from project files are shown as text', async ({ page }) => {
    const name = '<img src=x onerror="window.__xss=1">';
    await openApp(page, { variables: [`${name}|text|`], data: { [name]: 'v' } });
    await open(page);
    await expect(page.locator('#var-project-list span').first()).toHaveText(name);
    await expect.poll(() => page.evaluate(() => window.__xss)).toBeUndefined();
    await expect(page.locator('#var-project-list img')).toHaveCount(0);
});
test('typing a project value updates the project and its environment', async ({ page }) => {
    await openApp(page, { variables: ['one|text|'] });
    await open(page);
    await page.locator('#var-project-list webui-input-text input').fill('typed');
    await expect.poll(() => page.evaluate(() => webui.getProjectData('one'))).toBe('typed');
    await expect.poll(() => page.evaluate(() => webui.projectData.data._environments[0].variables.one)).toBe('typed');
    await expect.poll(async () => page.evaluate(() => window.__backend.savedProjects['/repo'].data.one)).toBe('typed');
});
test('typing a global value writes to disk once, after a pause', async ({ page }) => {
    await page.clock.install();
    await openApp(page, { appVariables: ['two|text|'] });
    await open(page);
    // The drawer selects its starting tab again a moment after it opens, which would undo choosing another before then.
    await page.clock.runFor(1000);
    await page.locator('webui-tabs webui-button', { hasText: 'Global' }).click();
    await expect(page.locator('#var-global-list webui-input-text input')).toBeEditable();
    // The page's clock stops, so the pause after typing is as long as the test makes it.
    await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
    const saves = async () => (await calls(page, 'save_app_data')).map(call => call.data.data.two);
    const before = await saves();
    await page.locator('#var-global-list webui-input-text input').pressSequentially('abcdef');
    await expect.poll(() => page.evaluate(() => webui.taskProxyData.data.two)).toBe('abcdef');
    await page.clock.runFor(400);
    await expect.poll(saves).toEqual(before);
    await page.clock.runFor(200);
    await expect.poll(saves).toEqual([...before, 'abcdef']);
    await page.clock.runFor(60000);
    await expect.poll(saves).toEqual([...before, 'abcdef']);
    // The backend's copy stays current between saves, in case the app closes.
    await expect.poll(() => page.evaluate(() => window.__backend.appData.data.two)).toBe('abcdef');
});
test('adding a variable defines it, and duplicates are refused', async ({ page }) => {
    await openApp(page);
    await open(page);
    await page.locator('input#input-proj-var').fill('new_one');
    await page.locator('#btn-add-proj').click();
    await expect.poll(() => page.evaluate(() => webui.projectData.variables)).toContain('new_one|text|');
    await page.locator('input#input-proj-var').fill('new_one');
    await page.locator('#btn-add-proj').click();
    await expect(alertPopup(page, 'Project variable already exists')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => webui.projectData.variables.filter(v => v.startsWith('new_one')))).toHaveLength(1);
});
test('deleting a project variable lets a global value of that name show through', async ({ page }) => {
    await openApp(page, { data: { shared: 'project' }, variables: ['shared|text|'], appData: { shared: 'global' }, appVariables: ['shared|text|'] });
    await open(page);
    await page.locator('#var-project-list webui-icon[title="Delete Variable"]').click();
    await dialogButton(page, 'Delete').click();
    await expect.poll(() => page.evaluate(() => webui.projectData.variables)).toEqual([]);
    await expect.poll(() => page.evaluate(() => webui.getData('shared'))).toBe('global');
});

test.describe('environments', () => {
    const data = envData([{ name: 'dev', variables: { key: 'dev value' } }, { name: 'prod', variables: { key: 'prod value' } }]);
    test('switching loads that environment\'s values', async ({ page }) => {
        await openApp(page, { variables: ['key|text|'], data: { ...data, key: 'dev value' } });
        await open(page);
        await selectEnv(page, 'prod');
        await expect.poll(() => page.evaluate(() => webui.getProjectData('key'))).toBe('prod value');
        await expect.poll(() => page.evaluate(() => webui.projectData.data._activeEnvironment)).toBe('prod');
    });
    test('switching does not delete the git token', async ({ page }) => {
        await openApp(page, { variables: ['git_pat|secret|', 'key|text|'], data: { ...data, git_pat: 'TOKEN' } });
        await open(page);
        await selectEnv(page, 'prod');
        await selectEnv(page, 'dev');
        await expect.poll(() => page.evaluate(() => webui.getProjectData('git_pat'))).toBe('TOKEN');
    });
    test('values set before environments existed survive switching away and back', async ({ page }) => {
        await openApp(page, { variables: ['old_key|text|'], data: { old_key: 'precious' } });
        await open(page);
        await page.evaluate(() => webui.projectData.data._environments.push({ name: 'other', variables: {} }));
        await page.locator('#btn-manage-env').click();
        await dialogButton(page, 'Done').click();
        // Showing it again rebuilds it, so wait for the rebuilt selector to offer the new environment.
        await page.evaluate(() => document.querySelector('app-tools').show('variables'));
        await expect.poll(() => page.evaluate(() => {
            const el = document.querySelector('#env-selector');
            if (!el || !document.querySelector('.shared')?.classList.contains('open')) return false;
            const current = el.value;
            el.value = 'other';
            const offered = el.value === 'other';
            el.value = current;
            return offered;
        })).toBe(true);
        await selectEnv(page, 'other');
        await expect.poll(() => page.evaluate(() => webui.getProjectData('old_key'))).toBeUndefined();
        await selectEnv(page, 'dev');
        await expect.poll(() => page.evaluate(() => webui.getProjectData('old_key'))).toBe('precious');
    });
    test('a value missing from the new environment falls back to global', async ({ page }) => {
        await openApp(page, { variables: ['shared|text|'], data: { ...envData([{ name: 'dev', variables: { shared: 'dev' } }, { name: 'empty', variables: {} }]), shared: 'dev' }, appData: { shared: 'global' }, appVariables: ['shared|text|'] });
        await open(page);
        await selectEnv(page, 'empty');
        await expect.poll(() => page.evaluate(() => webui.getData('shared'))).toBe('global');
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
        await expect(openDialog(page).getByText('Environment already exists')).toBeVisible();
        await expect.poll(() => page.evaluate(() => webui.projectData.data._environments)).toHaveLength(1);
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
        await expect(openDialog(page).getByText('You must have at least one environment.')).toBeVisible();
        await expect.poll(() => page.evaluate(() => webui.projectData.data._environments)).toHaveLength(1);
    });
    test('deleting the active environment loads the next one\'s values', async ({ page }) => {
        await openApp(page, { variables: ['key|text|'], data: { ...data, key: 'dev value' } });
        await open(page);
        await page.locator('#btn-manage-env').click();
        await page.locator('webui-button.env-del-btn[data-env="dev"]').click();
        await expect.poll(() => page.evaluate(() => webui.projectData.data._activeEnvironment)).toBe('prod');
        await expect.poll(() => page.evaluate(() => webui.getProjectData('key'))).toBe('prod value');
    });
    test('environment names are escaped in markup', async ({ page }) => {
        await openApp(page, { data: envData([{ name: '"><img src=x onerror="window.__xss=1">', variables: {} }]) });
        await open(page);
        await page.locator('#btn-manage-env').click();
        await page.locator('webui-button.env-del-btn').waitFor();
        await expect.poll(() => page.evaluate(() => window.__xss)).toBeUndefined();
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
        await expect.poll(() => page.locator('app-var-manager, webui-drawer.shared').first().evaluate(() => document.body.innerText)).not.toContain('[object Object]');
        await page.locator('#var-project-list webui-input-text input').fill('new password');
        await expect.poll(() => page.evaluate(() => webui.getProjectData('db_password'))).toBe('new password');
    });
    test('cannot be copied to another scope or the clipboard from here', async ({ page }) => {
        await openApp(page, { data: { db_password: kept }, variables: ['db_password|secret|'] });
        await open(page);
        await page.evaluate(() => {
            window.__copied = [];
            webui.copyToClipboard = text => window.__copied.push(text);
            // Each refusal says why, so the messages show both clicks were dealt with.
            window.__alerts = [];
            const alert = webui.alert;
            webui.alert = function (...args) { window.__alerts.push(`${args[0]}`); return alert.apply(this, args); };
        });
        const refused = 'db_password is kept on the desktop, so copy it there.';
        await page.locator('#var-project-list webui-icon[title="Copy Value to Global Scope"]').first().click();
        await expect.poll(() => page.evaluate(() => window.__alerts)).toEqual([refused]);
        await page.locator('#var-project-list webui-icon[title="Copy Value to Clipboard"]').first().click();
        await expect.poll(() => page.evaluate(() => window.__alerts)).toEqual([refused, refused]);
        await expect.poll(() => page.evaluate(() => webui.getGlobalData('db_password'))).toBeUndefined();
        await expect.poll(() => page.evaluate(() => window.__copied)).toEqual([]);
    });
});
test('the Variables tab counts the variables on the page shown, and none on pages without them', async ({ page }) => {
    await openPage(page, '<webui-input-text data-bind="first"></webui-input-text>\n\n<webui-input-text data-bind="second"></webui-input-text>\n\n<webui-data data-third="3"></webui-data>');
    await openTool(page, 'variables');
    const count = page.locator('webui-drawer.shared webui-button.tools-tab-variables webui-badge');
    await expect(count).toHaveText('3');
    await page.evaluate(() => webui.navigateTo('/'));
    await expect(count).toBeHidden();
});
