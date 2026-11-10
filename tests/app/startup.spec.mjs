import { test, expect, openApp, calls, onCommand, PROJECT } from '../support/app.mjs';
import { installBackend } from '../support/backend.mjs';

test('an open project loads and its saved page is restored', async ({ page }) => {
    await openApp(page, { currentPage: '/about' });
    await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/about');
    expect((await calls(page, 'get_project_data'))[0].project.path).toBe(PROJECT.path);
});
test('with no project, nothing tries to load one', async ({ page }) => {
    await openApp(page, { project: null });
    expect(await calls(page, 'get_project_data')).toEqual([]);
    expect(await page.evaluate(() => webui.proxy.projects.isLoaded)).toBe(false);
});
test('the app version comes from the backend', async ({ page }) => {
    await openApp(page);
    expect(await page.evaluate(() => webui.getData('app-version'))).toBe('v1.2.3');
});
test('old terminal state and stray values are removed from saved app data', async ({ page }) => {
    await openApp(page, { appData: { 'app-terminal-state': { terminals: {} }, stray: 'x', kept_var: 'y' }, appVariables: ['kept_var|text|'] });
    const data = await page.evaluate(() => webui.taskProxyData.data);
    expect(data['app-terminal-state']).toBeUndefined();
    expect(data.stray).toBeUndefined();
    expect(data.kept_var).toBe('y');
    await expect.poll(async () => (await calls(page, 'save_app_data')).length).toBeGreaterThan(0);
});
test('a startup failure is reported once instead of retrying forever', async ({ page }) => {
    await installBackend(page, {});
    await page.addInitScript(() => {
        window.__backend.handlers.get_app_data = () => { throw 'State failure'; };
    });
    await page.goto('/');
    const attempts = () => page.evaluate(() => window.__backend.calls.filter(call => call.command === 'get_app_data').length);
    await expect.poll(attempts).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    expect(await attempts()).toBe(1);
});
test('a project that fails to load can be selected again', async ({ page }) => {
    await openApp(page, { project: null });
    await onCommand(page, 'get_project_data', () => { throw 'Disk failure'; });
    await page.evaluate(() => webui.setData('app-current-project', { value: '/other', display: 'Other' }));
    await expect.poll(async () => (await calls(page, 'get_project_data')).length).toBe(1);
    await onCommand(page, 'get_project_data', ({ project }) => ({ id: 'other', path: project.path, currentPage: '/', docs: [], navigation: [], variables: [], data: {} }));
    await page.evaluate(() => webui.setData('app-current-project', null));
    await page.waitForTimeout(100);
    await page.evaluate(() => webui.setData('app-current-project', { value: '/other', display: 'Other' }));
    await expect.poll(() => page.evaluate(() => webui.proxy.projects.isLoaded)).toBe(true);
});
test('clearing the current project closes it in the backend', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => webui.setData('app-current-project', null));
    await expect.poll(async () => (await calls(page, 'clear_current_project')).length).toBe(1);
    expect(await page.evaluate(() => webui.proxy.projects.isLoaded)).toBe(false);
});
test('switching projects saves the previous one first', async ({ page }) => {
    await openApp(page);
    await onCommand(page, 'get_project_data', ({ project }) => ({ id: 'two', path: project.path, currentPage: '/', docs: [], navigation: [], variables: [], data: {} }));
    await page.evaluate(() => webui.setData('app-current-project', { value: '/two', display: 'Two' }));
    await expect.poll(() => page.evaluate(() => webui.projectData.id)).toBe('two');
    const saved = await calls(page, 'save_project_data');
    expect(saved.at(-1).data.id).toBe('project-id');
});
test('runWhenLoaded waits for a project, and runs at once when one is open', async ({ page }) => {
    await openApp(page, { project: null });
    await page.evaluate(() => {
        window.__ran = [];
        webui.proxy.projects.runWhenLoaded(() => window.__ran.push('first'));
    });
    expect(await page.evaluate(() => window.__ran)).toEqual([]);
    await onCommand(page, 'get_project_data', ({ project }) => ({ id: 'one', path: project.path, currentPage: '/', docs: [], navigation: [], variables: [], data: {} }));
    await page.evaluate(() => webui.setData('app-current-project', { value: '/repo', display: 'Repo' }));
    await expect.poll(() => page.evaluate(() => window.__ran)).toEqual(['first']);
    await page.evaluate(() => webui.proxy.projects.runWhenLoaded(() => window.__ran.push('second')));
    expect(await page.evaluate(() => window.__ran)).toEqual(['first', 'second']);
});
test('components wait for the backend however long the app takes to start', async ({ page }) => {
    // webui.wait gives up after about 10 seconds, so components that used it ran on without webui.proxy and threw.
    test.setTimeout(60000);
    await openApp(page, { projects: [{ name: 'Repo', path: '/repo' }, { name: 'Other', path: '/other' }] });
    await page.evaluate(() => {
        // As on a slow start, webui.proxy does not exist yet when the component loads.
        const proxy = webui.proxy;
        webui.proxy = undefined;
        webui.setData('app-projects', []);
        setTimeout(() => { webui.proxy = proxy; }, 11000);
        document.body.appendChild(document.createElement('app-project-dropdown'));
    });
    await expect.poll(() => page.evaluate(() => (webui.getData('app-projects') || []).length), { timeout: 20000 }).toBe(2);
});
test('the right panel can be resized and closed, and its width is remembered', async ({ page }) => {
    await page.setViewportSize({ width: 1300, height: 800 });
    await openApp(page);
    const panel = page.locator('webui-drawer.shared');
    await page.evaluate(() => document.querySelector('webui-drawer.shared').setAttribute('docked', 'true'));
    const handle = panel.locator('.resize');
    await expect(handle).toBeVisible();
    // Docking slides the panel into place, so wait for it to stop moving.
    let last;
    await expect.poll(async () => {
        const box = JSON.stringify(await panel.boundingBox());
        const settled = box === last;
        last = box;
        return settled;
    }, { intervals: [100] }).toBe(true);
    const before = await panel.evaluate(el => el.getBoundingClientRect().width);
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + 3, box.y + 50);
    await page.mouse.down();
    await page.mouse.move(box.x - 150, box.y + 50, { steps: 3 });
    await page.mouse.up();
    await expect(panel).toHaveAttribute('width', `${Math.round(Math.max(240, before + 153))}`);
    // The width is one of the attributes Web UI saves for the panel.
    expect(await panel.evaluate(el => el.dataset.state.split('|'))).toContain('width');
    // A real click, which also shows the page's Help button has moved up out of the panel's footer.
    await panel.locator('[slot="footer"] .drawer-close').click();
    await expect(panel).not.toHaveAttribute('docked');
    await expect(panel).not.toHaveClass(/open/);
});
