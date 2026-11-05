import { test, expect, openApp, calls } from '../support/app.mjs';

const navigation = [
    { name: 'Folder', icon: 'diamond', url: null, children: [{ name: 'Inner', icon: 'star', url: '/inner', children: null }] },
    { name: 'Top', icon: 'star', url: '/top', children: null },
];
const open = async page => {
    await openApp(page, { currentPage: '/nav-manager', navigation }, '/nav-manager');
    await page.locator('app-nav-preview webui-nav-link[name="Top"]').waitFor();
    await page.waitForTimeout(600);
};
const manager = page => page.locator('app-nav-manager');
const button = (page, label) => manager(page).locator(`webui-button[label="${label}"]`);
const savedNav = async page => {
    await expect.poll(async () => (await calls(page, 'save_project_data')).length).toBeGreaterThan(0);
    return (await calls(page, 'save_project_data')).at(-1).data.navigation;
};
const names = list => list.map(item => item.children ? [item.name, names(item.children)] : item.name);

test('shows the navigation', async ({ page }) => {
    await open(page);
    await expect(page.locator('app-nav-preview webui-nav-group')).toHaveCount(1);
    await expect(page.locator('app-nav-preview webui-nav-link[name="Inner"]')).toHaveCount(1);
});
test('saving keeps the structure', async ({ page }) => {
    await open(page);
    await button(page, 'Save').click();
    expect(names(await savedNav(page))).toEqual([['Folder', ['Inner']], 'Top']);
});
test('adding a page gives it a unique url', async ({ page }) => {
    await open(page);
    await button(page, 'Add Page').click();
    await button(page, 'Save').click();
    const nav = await savedNav(page);
    expect(nav).toHaveLength(3);
    expect(nav[2].url).toMatch(/^\/[0-9a-f-]{36}$/);
});
test('adding a folder gives it children instead of a url', async ({ page }) => {
    await open(page);
    await button(page, 'Add Folder').click();
    await button(page, 'Save').click();
    const nav = await savedNav(page);
    expect(nav[2].children).toEqual([]);
    expect(nav[2].url).toBeFalsy();
});
test('a nested page can be deleted', async ({ page }) => {
    await open(page);
    await page.locator('app-nav-preview webui-nav-link[name="Inner"]').click({ force: true });
    await page.waitForTimeout(200);
    await button(page, 'Delete').click();
    await button(page, 'Save').click();
    expect(names(await savedNav(page))).toEqual([['Folder', []], 'Top']);
});
test('renaming applies to the selected item', async ({ page }) => {
    await open(page);
    await page.locator('app-nav-preview webui-nav-link[name="Top"]').click({ force: true });
    await page.waitForTimeout(200);
    await manager(page).locator('webui-input-text[label="Name"] input').fill('Renamed');
    await button(page, 'Save').click();
    expect(names(await savedNav(page))).toEqual([['Folder', ['Inner']], 'Renamed']);
});
test('cancel discards changes', async ({ page }) => {
    await open(page);
    await button(page, 'Add Page').click();
    await button(page, 'Cancel').click();
    await expect(page.locator('app-nav-preview > webui-nav-link[name=""]')).toHaveCount(0);
});
test('saving updates the app navigation', async ({ page }) => {
    await open(page);
    await button(page, 'Add Page').click();
    await button(page, 'Save').click();
    await expect.poll(() => page.evaluate(() => webui.getData('app-nav-routes').length)).toBe(3);
});
test('saving from the header does not discard unsaved navigation edits', async ({ page }) => {
    await open(page);
    await button(page, 'Add Page').click();
    await page.waitForTimeout(100);
    await page.evaluate(() => webui.proxy.saveProjectData());
    await page.waitForTimeout(300);
    await button(page, 'Save').click();
    await expect.poll(async () => (await calls(page, 'save_project_data')).at(-1).data.navigation.length).toBe(3);
});
