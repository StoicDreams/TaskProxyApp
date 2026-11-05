import { test, expect, openApp } from '../support/app.mjs';

const state = { data: { shared: 'project', only_project: 'p' }, variables: ['shared|text|', 'only_project|text|'], appData: { shared: 'global', only_global: 'g' }, appVariables: ['shared|text|', 'only_global|text|'] };

test('webui.getData resolves page, then project, then global', async ({ page }) => {
    await openApp(page, state);
    expect(await page.evaluate(() => webui.getData('only_global'))).toBe('g');
    expect(await page.evaluate(() => webui.getData('only_project'))).toBe('p');
    expect(await page.evaluate(() => webui.getData('shared'))).toBe('project');
    await page.evaluate(() => webui.setData('shared', 'page'));
    expect(await page.evaluate(() => webui.getData('shared'))).toBe('page');
});
test('project.key and global.key read and write that scope directly', async ({ page }) => {
    await openApp(page, state);
    expect(await page.evaluate(() => webui.getData('global.shared'))).toBe('global');
    await page.evaluate(() => {
        webui.setData('project.new_key', 'a');
        webui.setData('global.other_key', 'b');
    });
    expect(await page.evaluate(() => webui.projectData.data.new_key)).toBe('a');
    expect(await page.evaluate(() => webui.taskProxyData.data.other_key)).toBe('b');
    expect(await page.evaluate(() => webui.taskProxyData.variables)).toContain('other_key|secret|');
});
test('a scope that is switched off is skipped', async ({ page }) => {
    await openApp(page, { ...state, appData: { ...state.appData, 'app-env-project-enabled': false } });
    expect(await page.evaluate(() => webui.getData('shared'))).toBe('global');
    await page.evaluate(() => webui.setData('app-env-global-enabled', false));
    expect(await page.evaluate(() => webui.getData('only_global'))).toBeUndefined();
});
test('on a new install, variables work without switching anything on', async ({ page }) => {
    await openApp(page, { ...state, newInstall: true });
    expect(await page.evaluate(() => webui.getData('only_project'))).toBe('p');
    expect(await page.evaluate(() => webui.getData('only_global'))).toBe('g');
    expect(await page.evaluate(() => webui.getVariable('only_project'))).toBe('p');
});
test('a scope switched off stays off after a restart', async ({ page }) => {
    await openApp(page, { ...state, appData: { 'app-env-global-enabled': false } });
    expect(await page.evaluate(() => webui.getData('only_global'))).toBeUndefined();
});
test('app keys are readable when every scope is switched off', async ({ page }) => {
    await openApp(page, { appData: { 'app-env-page-enabled': false, 'app-env-project-enabled': false, 'app-env-global-enabled': false, 'app-custom': 'kept' } });
    expect(await page.evaluate(() => webui.getData('app-custom'))).toBe('kept');
});
test('tokens are never readable through webui.getData', async ({ page }) => {
    await openApp(page, { data: { git_pat: 'SECRET1' }, appData: { github_pat: 'SECRET2' }, appVariables: ['github_pat|secret|'] });
    expect(await page.evaluate(() => [webui.getData('git_pat'), webui.getData('project.git_pat'), webui.getData('github_pat'), webui.getData('global.github_pat')].every(value => value === undefined))).toBe(true);
    expect(await page.evaluate(() => JSON.stringify([webui.getData('data'), webui.getData('project.data')]))).not.toContain('SECRET1');
    expect(await page.evaluate(() => webui.getProjectData('git_pat'))).toBe('SECRET1');
});
test('components can still read framework settings by their short name', async ({ page }) => {
    await openApp(page);
    expect(await page.evaluate(() => webui.getData('appName'))).toBeTruthy();
});
test('webui.getVariable only sees values set as variables', async ({ page }) => {
    await openApp(page, state);
    expect(await page.evaluate(() => webui.getVariable('shared'))).toBe('project');
    expect(await page.evaluate(() => webui.getVariable('only_global'))).toBe('g');
    // These are framework settings and project fields, which a variable of that name must not pick up.
    for (const name of ['name', 'version', 'path', 'id', 'data', 'docs', 'navigation', 'variables', 'git_pat']) {
        expect(await page.evaluate(name => webui.getVariable(name), name), name).toBeUndefined();
    }
    await page.evaluate(() => webui.setData('name', 'mine'));
    expect(await page.evaluate(() => webui.getVariable('name'))).toBe('mine');
});
test('app state changes reach the backend, and variables do not', async ({ page }) => {
    await openApp(page, state);
    await page.evaluate(() => {
        webui.setData('app-smoke', { a: 1 });
        webui.setData('not_app_state', 'x');
    });
    await expect.poll(() => page.evaluate(() => window.__backend.calls.filter(call => call.command === 'sync_app_data').some(call => call.args.data.data['app-smoke']?.a === 1))).toBe(true);
    expect(await page.evaluate(() => webui.taskProxyData.data.not_app_state)).toBeUndefined();
});
