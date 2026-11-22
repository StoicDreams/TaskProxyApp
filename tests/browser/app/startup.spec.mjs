import { test, expect, openApp, switchProject, calls, callOrder, onCommand, PROJECT } from '../../support/app.mjs';
import { installBackend } from '../../support/backend.mjs';
import { readFileSync } from 'node:fs';

test('an open project loads and its saved page is restored', async ({ page }) => {
    await openApp(page, { currentPage: '/about' });
    await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/about');
    await expect.poll(async () => (await calls(page, 'get_project_data'))[0]?.project.path).toBe(PROJECT.path);
});
test('with no project, nothing tries to load one', async ({ page }) => {
    await openApp(page, { project: null });
    await expect.poll(() => calls(page, 'get_project_data')).toEqual([]);
    await expect.poll(() => page.evaluate(() => webui.proxy.projects.isLoaded)).toBe(false);
});
test('the app version comes from the backend', async ({ page }) => {
    await openApp(page);
    await expect.poll(() => page.evaluate(() => webui.getData('app-version'))).toBe('v1.2.3');
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
    await page.clock.install();
    await installBackend(page, {});
    await page.addInitScript(() => {
        window.__backend.handlers.get_app_data = () => { throw 'State failure'; };
    });
    await page.goto('/');
    const attempts = () => page.evaluate(() => window.__backend.calls.filter(call => call.command === 'get_app_data').length);
    const reports = page.locator('.webui-alerts-popup webui-alert').filter({ hasText: 'State failure' });
    await expect(reports).toHaveCount(1);
    // A retry would come from a timer, so let a minute of them run.
    await page.clock.runFor(60000);
    await expect.poll(attempts).toBe(1);
    await expect(reports).toHaveCount(1);
});
test('the app starts even when its loading dialog cannot open', async ({ page }) => {
    // Web UI versions whose webui.dialog threw until its dialog element was ready, which a busy machine could reach first.
    await page.route(/\/webui\/dialogs(\.min)?\.js$/, async route => {
        const response = await route.fetch();
        const body = `${await response.text()}
{
    const ready = webui.dialog;
    let failed = false;
    webui.dialog = Object.assign(function (data) {
        if (!failed) {
            failed = true;
            throw new TypeError('webuiDialog._handler is not a function');
        }
        return ready(data);
    }, ready);
}`;
        await route.fulfill({ response, body });
    });
    await openApp(page);
    await expect.poll(() => page.evaluate(() => webui.dialog.toString())).toContain('webuiDialog._handler is not a function');
    await expect.poll(() => page.evaluate(() => typeof webui.proxy.projects)).toBe('object');
});
test('a project that fails to load can be selected again', async ({ page }) => {
    await openApp(page, { project: null });
    await onCommand(page, 'get_project_data', () => { throw 'Disk failure'; });
    await page.evaluate(() => webui.setData('app-current-project', { value: '/other', display: 'Other' }));
    await expect.poll(async () => (await calls(page, 'get_project_data')).length).toBe(1);
    await onCommand(page, 'get_project_data', ({ project }) => ({ id: 'other', path: project.path, currentPage: '/', docs: [], navigation: [], variables: [], data: {} }));
    await page.evaluate(() => webui.setData('app-current-project', null));
    // The project is closed before it is selected again.
    await expect.poll(async () => (await calls(page, 'clear_current_project')).length).toBe(1);
    await page.evaluate(() => webui.setData('app-current-project', { value: '/other', display: 'Other' }));
    await expect.poll(() => page.evaluate(() => webui.proxy.projects.isLoaded)).toBe(true);
});
test('clearing the current project closes it in the backend', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => webui.setData('app-current-project', null));
    await expect.poll(async () => (await calls(page, 'clear_current_project')).length).toBe(1);
    await expect.poll(() => page.evaluate(() => webui.proxy.projects.isLoaded)).toBe(false);
});
test('switching projects saves the previous one first', async ({ page }) => {
    await openApp(page);
    await onCommand(page, 'get_project_data', ({ project }) => ({ id: 'two', path: project.path, currentPage: '/', docs: [], navigation: [], variables: [], data: {} }));
    await page.evaluate(() => webui.setData('app-current-project', { value: '/two', display: 'Two' }));
    await expect.poll(() => page.evaluate(() => webui.projectData.id)).toBe('two');
    const order = await callOrder(page, 'save_project_data', 'get_project_data');
    const loaded = order.findIndex(call => call.command === 'get_project_data' && call.args.project.path === '/two');
    expect(order.slice(0, loaded).some(call => call.command === 'save_project_data' && call.args.data.id === 'project-id')).toBe(true);
});
test('runWhenLoaded waits for a project, and runs at once when one is open', async ({ page }) => {
    await openApp(page, { project: null });
    await page.evaluate(() => {
        window.__ran = [];
        webui.proxy.projects.runWhenLoaded(() => window.__ran.push('first'));
    });
    await expect.poll(() => page.evaluate(() => window.__ran)).toEqual([]);
    await onCommand(page, 'get_project_data', ({ project }) => ({ id: 'one', path: project.path, currentPage: '/', docs: [], navigation: [], variables: [], data: {} }));
    await page.evaluate(() => webui.setData('app-current-project', { value: '/repo', display: 'Repo' }));
    await expect.poll(() => page.evaluate(() => window.__ran)).toEqual(['first']);
    await page.evaluate(() => webui.proxy.projects.runWhenLoaded(() => window.__ran.push('second')));
    await expect.poll(() => page.evaluate(() => window.__ran)).toEqual(['first', 'second']);
});
test('components wait for the backend however long the app takes to start', async ({ page }) => {
    // webui.wait gives up after about 10 seconds, so components that used it ran on without webui.proxy and threw.
    await page.clock.install();
    await openApp(page, { projects: [{ name: 'Repo', path: '/repo' }, { name: 'Other', path: '/other' }] });
    await page.evaluate(() => {
        // As on a slow start, webui.proxy does not exist yet when the component loads.
        const proxy = webui.proxy;
        webui.proxy = undefined;
        webui.setData('app-projects', []);
        setTimeout(() => { webui.proxy = proxy; }, 11000);
        document.body.appendChild(document.createElement('app-project-dropdown'));
    });
    // The page's clock is moved past the 11 seconds, rather than waiting for them.
    await page.clock.runFor(12000);
    await expect.poll(() => page.evaluate(() => (webui.getData('app-projects') || []).length)).toBe(2);
});
test('the right panel can be resized and closed, docking again when it opens, and its width is remembered', async ({ page }) => {
    await page.setViewportSize({ width: 1300, height: 800 });
    await openApp(page);
    const panel = page.locator('webui-drawer.shared');
    await page.evaluate(() => document.querySelector('webui-drawer.shared').setAttribute('docked', 'true'));
    const handle = panel.locator('.resize');
    await expect(handle).toBeVisible();
    // Docking slides the panel into place, so wait until nothing in it is still moving, two frames after the last check.
    // Endless animations, such as a loading spinner in the tool it shows, never finish and don't move the panel.
    await expect.poll(() => panel.evaluate(el => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
        resolve(el.getAnimations({ subtree: true }).filter(animation => animation.playState !== 'finished' && animation.effect?.getComputedTiming().iterations !== Infinity).length);
    }))))).toBe(0);
    const savedWidth = () => panel.evaluate(el => parseInt(el.getAttribute('width') || '0', 10));
    const before = await savedWidth();
    // The handle's place is only used to drag it, as a person would.
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + 3, box.y + 50);
    await page.mouse.down();
    await page.mouse.move(box.x - 150, box.y + 50, { steps: 3 });
    await page.mouse.up();
    // Dragging the handle out makes the panel wider, and the panel records its new width.
    await expect.poll(savedWidth).toBeGreaterThan(before);
    // A real click, which also shows the page's Help button has moved up out of the panel's footer.
    await panel.locator('[slot="footer"] .drawer-close').click();
    await expect(panel).not.toHaveAttribute('docked');
    await expect(panel).not.toHaveClass(/open/);
    // Closed while docked, it docks again when it opens.
    await page.locator('header app-tools').click();
    await expect(panel).toHaveAttribute('docked');
});
test('the page a project reload passes through is never kept as the project\'s current page', async ({ page }) => {
    const projects = [{ name: 'Repo', path: '/repo' }, { name: 'Other', path: '/other' }];
    await openApp(page, { projects });
    await page.evaluate(() => {
        // The current page each time the app goes to save the project.
        window.__currentPages = [];
        const sync = webui.proxy.syncProjectData;
        webui.proxy.syncProjectData = function (...args) {
            window.__currentPages.push(webui.projectData.currentPage);
            return sync.apply(this, args);
        };
    });
    await switchProject(page, projects[1]);
    // The reload went through, since the page it ended on was kept.
    await expect.poll(() => page.evaluate(() => window.__currentPages)).toContain('/');
    expect(await page.evaluate(() => window.__currentPages.filter(path => path.includes('_reloading')))).toEqual([]);
});

test.describe('the service worker', () => {
    /** Stands in for navigator.serviceWorker, which Playwright blocks, recording what the page asks of it. */
    const recordServiceWorker = page => page.addInitScript(() => {
        window.__sw = { registered: [], unregistered: 0 };
        Object.defineProperty(navigator, 'serviceWorker', {
            configurable: true,
            value: {
                register: url => { window.__sw.registered.push(url); return Promise.resolve({}); },
                getRegistrations: () => Promise.resolve([{ unregister: () => { window.__sw.unregistered++; return Promise.resolve(true); } }]),
            },
        });
    });

    test('inside Task Proxy none is registered, and one left from before is removed', async ({ page }) => {
        // WebKitGTK aborted the dev build's web process when it stopped an idle service worker, turning the window gray.
        await recordServiceWorker(page);
        await openApp(page);
        await expect.poll(() => page.evaluate(() => window.__sw.unregistered)).toBe(1);
        expect(await page.evaluate(() => window.__sw.registered)).toEqual([]);
    });

    test('in a browser, such as a remote one, it is registered', async ({ page }) => {
        // The page's own registration script, run where there is no Task Proxy around it.
        const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
        const script = html.match(/<script type="text\/javascript">([\s\S]*?serviceWorker[\s\S]*?)<\/script>/)[1];
        await recordServiceWorker(page);
        await page.route('**/sw-check', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><script>${script}</script>` }));
        await page.goto('/sw-check');
        await expect.poll(() => page.evaluate(() => window.__sw.registered)).toEqual(['service-worker.min.js']);
        expect(await page.evaluate(() => window.__sw.unregistered)).toBe(0);
    });
});
