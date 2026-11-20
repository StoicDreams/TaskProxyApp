import { test, expect, openApp, calls, goToPage } from '../../support/app.mjs';

// In a browser connected by Remote Connections, www.taskproxy.com's frame sets window.__taskProxyRemote before the app
// starts. The page shown is the browser's own, and the computer saves what the browser changes.
const asDevice = page => page.addInitScript(() => {
    window.__taskProxyRemote = { deviceName: 'Phone', desktopName: 'Desk' };
});
const path = page => page.evaluate(() => location.pathname);
const patches = async (page, command) => (await calls(page, command)).map(call => call.patch);

test('the app tells components it runs in a remote browser', async ({ page }) => {
    await asDevice(page);
    await openApp(page);
    await expect.poll(() => page.evaluate(() => webui.proxy.remote)).toEqual({ deviceName: 'Phone', desktopName: 'Desk' });
});

test('on the computer, webui.proxy.remote is null', async ({ page }) => {
    await openApp(page);
    await expect.poll(() => page.evaluate(() => webui.proxy.remote)).toBeNull();
});

test('a remote browser opens on its own route, not the page the computer shows', async ({ page }) => {
    await asDevice(page);
    await openApp(page, { currentPage: '/git-controller' }, '/');
    await expect(page.locator('app-home')).toBeAttached();
    await expect.poll(() => path(page)).toBe('/');
    await expect(page.locator('app-git-manager')).toHaveCount(0);
});

test('the computer opens on the project\'s last page', async ({ page }) => {
    await openApp(page, { currentPage: '/git-controller' }, '/');
    await expect(page.locator('app-git-manager')).toBeAttached();
    await expect.poll(() => path(page)).toBe('/git-controller');
});

test('a remote browser moving between pages never moves the computer\'s', async ({ page }) => {
    await asDevice(page);
    await openApp(page);
    await goToPage(page, '/git-controller');
    await expect(page.locator('app-git-manager')).toBeAttached();
    // Rust's copy of the project still has the page it had, and no patch changed it.
    await expect.poll(() => page.evaluate(() => window.__backend.savedProjects['/repo']?.currentPage ?? '/')).toBe('/');
    expect((await patches(page, 'patch_project_data')).filter(patch => patch?.fields && 'currentPage' in patch.fields)).toEqual([]);
});

test('a remote browser saves by sending its change, which the computer saves', async ({ page }) => {
    await asDevice(page);
    await openApp(page);
    await page.evaluate(() => {
        webui.taskProxyData.data.remoteNote = 'from the phone';
        return webui.proxy.saveAppData();
    });
    await expect.poll(() => patches(page, 'patch_app_data')).toContainEqual(expect.objectContaining({ set: expect.objectContaining({ remoteNote: 'from the phone' }) }));
    expect(await calls(page, 'save_app_data')).toEqual([]);
});

test('a browser that may only look is refused its change without an alert, and it is sent again later', async ({ page }) => {
    await asDevice(page);
    await openApp(page);
    const result = await page.evaluate(async () => {
        const alerts = [];
        const original = webui.alert;
        webui.alert = (...args) => { alerts.push(`${args[0]}`); return original.apply(webui, args); };
        const refuse = () => { throw 'This browser can\'t do that. Raise it to Work in Task Proxy\'s settings on the computer.'; };
        const real = window.__backend.handlers.patch_app_data;
        window.__backend.handlers.patch_app_data = refuse;
        webui.taskProxyData.data.remoteNote = 'from the phone';
        const refused = await webui.proxy.syncAppData();
        window.__backend.handlers.patch_app_data = real;
        const sent = await webui.proxy.syncAppData();
        return { refused, sent, alerts };
    });
    expect(result).toEqual({ refused: 'App Data Synced', sent: 'App Data Synced', alerts: [] });
    // Raised to Work on the computer, the same change goes through with the next sync.
    await expect.poll(() => patches(page, 'patch_app_data')).toContainEqual(expect.objectContaining({ set: expect.objectContaining({ remoteNote: 'from the phone' }) }));
});

test('a remote browser copies text and opens links itself', async ({ page }) => {
    await asDevice(page);
    await openApp(page);
    await page.evaluate(() => webui.proxy.openUrl('https://example.com/docs'));
    await expect.poll(() => calls(page, 'openUrl')).toEqual([{ url: 'https://example.com/docs' }]);
    expect(await calls(page, 'open_url')).toEqual([]);
});
