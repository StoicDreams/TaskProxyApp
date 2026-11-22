import { test, expect, openApp, switchProject } from '../support/app.mjs';

// What waits for a loaded project (webui.proxy.projects in root_files/app.js) runs for the project the user chose
// last: one still loading when another is chosen doesn't run it, and one that throws doesn't stop the others.
test('a project still loading when another is chosen runs nothing waiting for a loaded project', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => {
        window.__loadedFor = [];
        webui.proxy.projects.onLoaded(() => window.__loadedFor.push(webui.projectData.path));
        const original = window.__backend.handlers.get_project_data;
        window.__backend.handlers.get_project_data = args => args?.project?.path === '/first'
            ? new Promise(resolve => { window.__releaseFirst = () => resolve(original(args)); })
            : original(args);
        webui.setData('app-current-project', { value: '/first', display: 'First' });
    });
    await expect.poll(() => page.evaluate(() => typeof window.__releaseFirst)).toBe('function');
    await page.evaluate(() => webui.setData('app-current-project', { value: '/second', display: 'Second' }));
    await page.evaluate(() => window.__releaseFirst());
    await expect.poll(() => page.evaluate(() => webui.projectData.path)).toBe('/second');
    await expect.poll(() => page.evaluate(() => window.__loadedFor)).toEqual(['/second']);
});

test('a handler that fails is reported, and the others still run', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => {
        window.__ran = [];
        webui.proxy.projects.onLoaded(() => { throw new Error('First handler broke.'); });
        webui.proxy.projects.onLoaded(async () => { throw new Error('Second handler broke later.'); });
        webui.proxy.projects.onLoaded(() => window.__ran.push(webui.projectData.path));
    });
    await switchProject(page, { name: 'Other', path: '/other' });
    await expect.poll(() => page.evaluate(() => window.__ran)).toEqual(['/other']);
    await expect.poll(() => page.evaluate(() => webui.projectData.path)).toBe('/other');
    await expect(page.locator('.webui-alerts-popup webui-alert', { hasText: 'First handler broke.' })).toHaveCount(1);
    await expect(page.locator('.webui-alerts-popup webui-alert', { hasText: 'Second handler broke later.' })).toHaveCount(1);
});

test('a project that fails to load runs what waits for a loaded project for the one still open', async ({ page }) => {
    await openApp(page);
    const open = await page.evaluate(() => webui.projectData.path);
    await page.evaluate(() => {
        window.__ran = [];
        const save = webui.proxy.saveProjectData;
        webui.proxy.saveProjectData = () => {
            webui.proxy.saveProjectData = save;
            return Promise.reject(new Error('Saving broke.'));
        };
        webui.setData('app-current-project', { value: '/broken', display: 'Broken' });
        webui.proxy.projects.runWhenLoaded(() => window.__ran.push(webui.projectData.path));
    });
    await expect(page.locator('.webui-alerts-popup webui-alert', { hasText: 'Saving broke.' })).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => window.__ran)).toEqual([open]);
});

test('a project that fails to load while another is chosen leaves what waits for the one chosen', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => {
        window.__ran = [];
        const save = webui.proxy.saveProjectData;
        webui.proxy.saveProjectData = () => new Promise((resolve, reject) => {
            webui.proxy.saveProjectData = save;
            window.__failSave = () => reject(new Error('Saving broke.'));
        });
        webui.setData('app-current-project', { value: '/broken', display: 'Broken' });
    });
    await expect.poll(() => page.evaluate(() => typeof window.__failSave)).toBe('function');
    await page.evaluate(() => {
        // Held, so the second project's load waits behind the first's failure.
        const original = window.__backend.handlers.get_project_data;
        window.__backend.handlers.get_project_data = args => new Promise(resolve => {
            window.__releaseOther = () => resolve(original(args));
        });
        webui.setData('app-current-project', { value: '/other', display: 'Other' });
        webui.proxy.projects.runWhenLoaded(() => window.__ran.push(webui.projectData.path));
        window.__failSave();
    });
    await expect(page.locator('.webui-alerts-popup webui-alert', { hasText: 'Saving broke.' })).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => typeof window.__releaseOther)).toBe('function');
    await expect.poll(() => page.evaluate(() => window.__ran)).toEqual([]);
    await page.evaluate(() => window.__releaseOther());
    await expect.poll(() => page.evaluate(() => window.__ran)).toEqual(['/other']);
});
