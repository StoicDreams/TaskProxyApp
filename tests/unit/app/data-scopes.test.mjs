import { test, expect, openApp } from '../support/app.mjs';

const state = { data: { shared: 'project', only_project: 'p' }, variables: ['shared|text|', 'only_project|text|'], appData: { shared: 'global', only_global: 'g' }, appVariables: ['shared|text|', 'only_global|text|'] };

test('webui.getData resolves page, then project, then global', async ({ page }) => {
    await openApp(page, state);
    await expect.poll(() => page.evaluate(() => webui.getData('only_global'))).toBe('g');
    await expect.poll(() => page.evaluate(() => webui.getData('only_project'))).toBe('p');
    await expect.poll(() => page.evaluate(() => webui.getData('shared'))).toBe('project');
    await page.evaluate(() => webui.setData('shared', 'page'));
    await expect.poll(() => page.evaluate(() => webui.getData('shared'))).toBe('page');
});
test('project.key and global.key read and write that scope directly', async ({ page }) => {
    await openApp(page, state);
    await expect.poll(() => page.evaluate(() => webui.getData('global.shared'))).toBe('global');
    await page.evaluate(() => {
        webui.setData('project.new_key', 'a');
        webui.setData('global.other_key', 'b');
    });
    await expect.poll(() => page.evaluate(() => webui.projectData.data.new_key)).toBe('a');
    await expect.poll(() => page.evaluate(() => webui.taskProxyData.data.other_key)).toBe('b');
    await expect.poll(() => page.evaluate(() => webui.taskProxyData.variables)).toContain('other_key|secret|');
});
test('a scope that is switched off is skipped', async ({ page }) => {
    await openApp(page, { ...state, appData: { ...state.appData, 'app-env-project-enabled': false } });
    await expect.poll(() => page.evaluate(() => webui.getData('shared'))).toBe('global');
    await page.evaluate(() => webui.setData('app-env-global-enabled', false));
    await expect.poll(() => page.evaluate(() => webui.getData('only_global'))).toBeUndefined();
});
test('on a new install, variables work without switching anything on', async ({ page }) => {
    await openApp(page, { ...state, newInstall: true });
    await expect.poll(() => page.evaluate(() => webui.getData('only_project'))).toBe('p');
    await expect.poll(() => page.evaluate(() => webui.getData('only_global'))).toBe('g');
    await expect.poll(() => page.evaluate(() => webui.getVariable('only_project'))).toBe('p');
});
test('a scope switched off stays off after a restart', async ({ page }) => {
    await openApp(page, { ...state, appData: { 'app-env-global-enabled': false } });
    await expect.poll(() => page.evaluate(() => webui.getData('only_global'))).toBeUndefined();
});
test('app keys are readable when every scope is switched off', async ({ page }) => {
    await openApp(page, { appData: { 'app-env-page-enabled': false, 'app-env-project-enabled': false, 'app-env-global-enabled': false, 'app-custom': 'kept' } });
    await expect.poll(() => page.evaluate(() => webui.getData('app-custom'))).toBe('kept');
});
test('tokens are never readable through webui.getData', async ({ page }) => {
    await openApp(page, { data: { git_pat: 'SECRET1' }, appData: { github_pat: 'SECRET2' }, appVariables: ['github_pat|secret|'] });
    await expect.poll(() => page.evaluate(() => [webui.getData('git_pat'), webui.getData('project.git_pat'), webui.getData('github_pat'), webui.getData('global.github_pat')].every(value => value === undefined))).toBe(true);
    await expect.poll(() => page.evaluate(() => JSON.stringify([webui.getData('data'), webui.getData('project.data')]))).not.toContain('SECRET1');
    await expect.poll(() => page.evaluate(() => webui.getProjectData('git_pat'))).toBe('SECRET1');
});
test('components can still read framework settings by their short name', async ({ page }) => {
    await openApp(page);
    await expect.poll(() => page.evaluate(() => webui.getData('appName'))).toBeTruthy();
});
test('webui.getVariable only sees values set as variables', async ({ page }) => {
    await openApp(page, state);
    await expect.poll(() => page.evaluate(() => webui.getVariable('shared'))).toBe('project');
    await expect.poll(() => page.evaluate(() => webui.getVariable('only_global'))).toBe('g');
    // These are framework settings and project fields, which a variable of that name must not pick up.
    for (const name of ['name', 'version', 'path', 'id', 'data', 'docs', 'navigation', 'variables', 'git_pat']) {
        await expect.poll(() => page.evaluate(name => webui.getVariable(name), name), name).toBeUndefined();
    }
    await page.evaluate(() => webui.setData('name', 'mine'));
    await expect.poll(() => page.evaluate(() => webui.getVariable('name'))).toBe('mine');
});
test('app state changes reach the backend, and variables do not', async ({ page }) => {
    await openApp(page, state);
    await page.evaluate(() => {
        webui.setData('app-smoke', { a: 1 });
        webui.setData('not_app_state', 'x');
    });
    await expect.poll(() => page.evaluate(() => window.__backend.appData.data['app-smoke']?.a === 1)).toBe(true);
    await expect.poll(() => page.evaluate(() => webui.taskProxyData.data.not_app_state)).toBeUndefined();
});
test('global variables are not copied into page data at startup, where they would hide project values', async ({ page }) => {
    await openApp(page, state);
    await expect.poll(() => page.evaluate(() => webui.getNestedData('shared', window.appData))).toBeUndefined();
    await expect.poll(() => page.evaluate(() => webui.getData('global.shared'))).toBe('global');
});
test('an AI setting saves to a project whose data has never held anything', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => {
        delete webui.projectData.data;
        webui.proxy.ai.setScope('project', 'instructions', 'git', 'Project git');
    });
    await expect.poll(() => page.evaluate(() => webui.projectData.data?._ai?.instructions?.git)).toBe('Project git');
});
