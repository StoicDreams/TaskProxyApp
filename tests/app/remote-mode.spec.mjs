import { test, expect, openApp, calls, goToPage } from '../support/app.mjs';

// On a paired device, taskproxy.com's frame sets window.__taskProxyRemote before the app starts
// (Docs/RemoteAccess.md, 2.4). The page shown is the device's own, and the desktop saves what the device changes.
const asDevice = (page, level = 'work') => page.addInitScript(level => {
    window.__taskProxyRemote = { level, deviceName: 'Phone', desktopName: 'Desk' };
}, level);
const path = page => page.evaluate(() => location.pathname);
const patches = async (page, command) => (await calls(page, command)).map(call => call.patch);

test('the app tells components it runs on a device, and the desktop says it does not', async ({ page }) => {
    await asDevice(page);
    await openApp(page);
    await expect.poll(() => page.evaluate(() => webui.proxy.remote)).toEqual({ level: 'work', deviceName: 'Phone', desktopName: 'Desk' });
});

test('on the desktop, webui.proxy.remote is null', async ({ page }) => {
    await openApp(page);
    await expect.poll(() => page.evaluate(() => webui.proxy.remote)).toBeNull();
});

test('a device opens on its own route, not the page the desktop shows', async ({ page }) => {
    await asDevice(page);
    await openApp(page, { currentPage: '/git-controller' }, '/');
    await expect(page.locator('app-home')).toBeAttached();
    await expect.poll(() => path(page)).toBe('/');
    await expect(page.locator('app-git-manager')).toHaveCount(0);
});

test('the desktop opens on the project\'s last page', async ({ page }) => {
    await openApp(page, { currentPage: '/git-controller' }, '/');
    await expect(page.locator('app-git-manager')).toBeAttached();
    await expect.poll(() => path(page)).toBe('/git-controller');
});

test('a device moving between pages never moves the desktop\'s', async ({ page }) => {
    await asDevice(page);
    await openApp(page);
    await goToPage(page, '/git-controller');
    await expect(page.locator('app-git-manager')).toBeAttached();
    // Rust's copy of the project still has the page it had, and no patch changed it.
    await expect.poll(() => page.evaluate(() => window.__backend.savedProjects['/repo']?.currentPage ?? '/')).toBe('/');
    expect((await patches(page, 'patch_project_data')).filter(patch => patch?.fields && 'currentPage' in patch.fields)).toEqual([]);
});

test('a Work device saves by sending its change, which the desktop saves', async ({ page }) => {
    await asDevice(page, 'work');
    await openApp(page);
    await page.evaluate(() => {
        webui.taskProxyData.data.remoteNote = 'from the phone';
        return webui.proxy.saveAppData();
    });
    await expect.poll(() => patches(page, 'patch_app_data')).toContainEqual(expect.objectContaining({ set: expect.objectContaining({ remoteNote: 'from the phone' }) }));
    expect(await calls(page, 'save_app_data')).toEqual([]);
});

test('a View device keeps its changes to itself, since the desktop would refuse them', async ({ page }) => {
    await asDevice(page, 'view');
    await openApp(page);
    const sent = await page.evaluate(async () => {
        webui.taskProxyData.data.remoteNote = 'from the phone';
        return [await webui.proxy.syncAppData(), await webui.proxy.saveAppData()];
    });
    expect(sent).toEqual(['App Data Synced', 'App Data Synced']);
    expect((await patches(page, 'patch_app_data')).filter(patch => patch?.set && 'remoteNote' in patch.set)).toEqual([]);
    expect(await calls(page, 'save_app_data')).toEqual([]);
});
