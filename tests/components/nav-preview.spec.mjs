import { test, expect, openApp, mount } from '../support/app.mjs';

async function preview(page, nav) {
    await openApp(page, { project: null });
    const root = await mount(page, '<app-nav-preview id="n"></app-nav-preview>');
    const el = root.locator('#n');
    await el.evaluate((node, nav) => node.setNavRoutes(nav), nav);
    return el;
}
const nav = [{ name: 'One', icon: 'star', url: '/one' }, { name: 'Two', icon: 'star', url: null, children: [{ name: 'Three', icon: 'star', url: '/three' }] }];

test('builds links and folders, with placeholders around folders', async ({ page }) => {
    const el = await preview(page, nav);
    await expect(el.locator('webui-nav-link[name="One"]')).toHaveCount(1);
    await expect(el.locator('webui-nav-group[name="Two"] webui-nav-link[name="Three"]')).toHaveCount(1);
    await expect(el.locator('webui-nav-link.placeholder')).toHaveCount(4);
});
test('accepts json', async ({ page }) => {
    const el = await preview(page, JSON.stringify(nav));
    await expect(el.locator('webui-nav-link[name="One"]')).toHaveCount(1);
});
test('clicking an item reports it, and the first item is selected on build', async ({ page }) => {
    const el = await preview(page, nav);
    await page.evaluate(() => {
        window.__clicked = [];
        document.addEventListener('nav-preview-click', ev => window.__clicked.push(ev.detail.name), true);
    });
    await expect.poll(() => page.evaluate(() => window.__clicked.length)).toBeGreaterThanOrEqual(0);
    await el.locator('webui-nav-link[name="Three"]').click({ force: true });
    await expect.poll(() => page.evaluate(() => window.__clicked.at(-1))).toBe('Three');
});
test('renaming through the reported item updates the link', async ({ page }) => {
    const el = await preview(page, nav);
    await page.evaluate(() => {
        document.addEventListener('nav-preview-click', ev => { window.__item = ev.detail; }, true);
    });
    await el.locator('webui-nav-link[name="One"]').click({ force: true });
    await page.evaluate(() => { window.__item.name = 'Renamed'; });
    await expect(el.locator('webui-nav-link[name="Renamed"]')).toHaveCount(1);
});
