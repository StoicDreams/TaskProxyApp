import { test, expect, openApp } from '../support/app.mjs';

const projects = [{ name: 'One', path: '/one' }, { name: 'Two', path: '/two' }];

test('lists projects and shows the current one', async ({ page }) => {
    await openApp(page, { project: projects[1], projects });
    await expect.poll(() => page.locator('app-project-dropdown webui-dropdown').evaluate(el => el.value)).toBe('/two');
});
test('is hidden with no projects', async ({ page }) => {
    await openApp(page, { project: null, projects: [] });
    await expect(page.locator('app-project-dropdown')).toBeHidden();
});
test('opens the first project when none is current', async ({ page }) => {
    await openApp(page, { project: null, projects });
    await expect.poll(() => page.evaluate(() => webui.getData('app-current-project')?.value)).toBe('/one');
});
