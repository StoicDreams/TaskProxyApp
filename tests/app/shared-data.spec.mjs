import { test, expect, openApp, calls } from '../support/app.mjs';

// App and project data reach Rust as patches of what changed (services/shared_data.rs), which Rust sends to every
// other screen, so two screens changing different values keep both.
const lastPatch = async (page, command) => (await calls(page, command)).at(-1)?.patch;
const saved = page => page.evaluate(() => window.__backend.savedProjects['/repo'].data);

test('a sync sends only the values that changed', async ({ page }) => {
    await openApp(page, { data: { one: '1', two: '2', gone: 'x' } });
    await page.evaluate(() => {
        webui.setProjectData('one', 'changed');
        webui.deleteProjectData('gone');
        return webui.proxy.syncProjectData();
    });
    await expect.poll(() => lastPatch(page, 'patch_project_data')).toEqual({ set: { one: 'changed' }, remove: ['gone'], fields: {} });
    await expect.poll(() => saved(page)).toEqual({ one: 'changed', two: '2' });
    // Nothing changed since, so nothing is sent.
    const sent = (await calls(page, 'patch_project_data')).length;
    await page.evaluate(() => webui.proxy.syncProjectData());
    await expect.poll(() => calls(page, 'patch_project_data')).toHaveLength(sent);
});

test('a field such as the variable list is sent whole, and the project is named', async ({ page }) => {
    await openApp(page, { variables: ['one|text|'] });
    await page.evaluate(() => {
        webui.projectData.variables = ['one|text|', 'two|secret|'];
        return webui.proxy.syncProjectData();
    });
    expect((await calls(page, 'patch_project_data')).at(-1)).toMatchObject({
        id: 'project-id', patch: { set: {}, remove: [], fields: { variables: ['one|text|', 'two|secret|'] } },
    });
});

test("another screen's change shows here, and is not sent back", async ({ page }) => {
    await openApp(page, { data: { one: '1' } });
    const before = (await calls(page, 'patch_project_data')).length;
    await page.evaluate(() => window.__backend.otherScreen('project', { set: { one: 'from the phone' } }));
    await expect.poll(() => page.evaluate(() => webui.getProjectData('one'))).toBe('from the phone');
    await page.evaluate(() => webui.proxy.syncProjectData());
    await expect.poll(() => calls(page, 'patch_project_data')).toHaveLength(before);
});

test('two screens changing different values keep both', async ({ page }) => {
    await openApp(page, { data: { one: '1', two: '2' } });
    await page.evaluate(() => {
        webui.setProjectData('one', 'from the desk');
        window.__backend.otherScreen('project', { set: { two: 'from the phone' } });
        return webui.proxy.syncProjectData();
    });
    await expect.poll(() => saved(page)).toEqual({ one: 'from the desk', two: 'from the phone' });
    await expect.poll(() => page.evaluate(() => webui.projectData.data)).toEqual({ one: 'from the desk', two: 'from the phone' });
});

test("app state is shared, but the page another screen shows is not", async ({ page }) => {
    await openApp(page);
    const path = await page.evaluate(() => location.pathname);
    await page.evaluate(() => window.__backend.otherScreen('app', {
        set: { 'app-trusted-projects': ['/repo', '/phone'], 'page-path': '/elsewhere', 'app-terminals-filter': 'Finished', 'session-x': 1 },
    }));
    await expect.poll(() => page.evaluate(() => webui.getData('app-trusted-projects'))).toEqual(['/repo', '/phone']);
    await expect.poll(() => page.evaluate(() => [webui.getData('page-path'), webui.getData('app-terminals-filter'), webui.getData('session-x')]))
        .not.toContain('/elsewhere');
    await expect.poll(() => page.evaluate(() => webui.getData('app-terminals-filter'))).not.toBe('Finished');
    await expect.poll(() => page.evaluate(() => location.pathname)).toBe(path);
});

test('a global variable set on another screen reaches this one', async ({ page }) => {
    await openApp(page, { appVariables: ['token|secret|'] });
    await page.evaluate(() => window.__backend.otherScreen('app', { set: { token: 'abc' } }));
    await expect.poll(() => page.evaluate(() => webui.getGlobalData('token'))).toBe('abc');
});

test('changing a value sends it to the backend through a patch', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => webui.setData('app-smoke', { a: 1 }));
    await expect.poll(async () => (await lastPatch(page, 'patch_app_data'))?.set?.['app-smoke']).toEqual({ a: 1 });
    await expect.poll(() => page.evaluate(() => window.__backend.appData.data['app-smoke'])).toEqual({ a: 1 });
});
