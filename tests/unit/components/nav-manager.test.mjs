import { test, expect, openApp, calls } from '../support/app.mjs';

const navigation = [
    { name: 'Folder', icon: 'diamond', url: null, children: [{ name: 'Inner', icon: 'star', url: '/inner', children: null }] },
    { name: 'Top', icon: 'star', url: '/top', children: null },
];
const open = async page => {
    await openApp(page, { currentPage: '/nav-manager', navigation }, '/nav-manager');
    await page.locator('app-nav-preview webui-nav-link[name="Top"]').waitFor();
    // The preview selects its first item once it is built, which would replace a selection made before it.
    await expect(nameInput(page)).toHaveValue('Folder');
};
const manager = page => page.locator('app-nav-manager');
const nameInput = page => manager(page).locator('webui-input-text[label="Name"] input');
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
    await page.locator('app-nav-preview webui-nav-link[name="Inner"]').click();
    await expect(nameInput(page)).toHaveValue('Inner');
    await nameInput(page).fill('Inner Page');
    await button(page, 'Save').click();
    expect(names(await savedNav(page))).toEqual([['Folder', ['Inner Page']], 'Top']);
});
test('Save and Cancel are disabled until the navigation changes, and again once it is saved or cancelled', async ({ page }) => {
    await open(page);
    await expect(button(page, 'Save')).toHaveAttribute('disabled');
    await expect(button(page, 'Save')).toHaveAttribute('title', 'No navigation changes to save');
    await expect(button(page, 'Cancel')).toHaveAttribute('disabled');
    // Typing a name and putting it back leaves nothing to save.
    await nameInput(page).fill('Changed');
    await expect(button(page, 'Save')).not.toHaveAttribute('disabled');
    await expect(button(page, 'Cancel')).not.toHaveAttribute('disabled');
    await nameInput(page).fill('Folder');
    await expect(button(page, 'Save')).toHaveAttribute('disabled');
    await nameInput(page).fill('Changed');
    await button(page, 'Save').click();
    expect(names(await savedNav(page))).toEqual([['Changed', ['Inner']], 'Top']);
    await expect(button(page, 'Save')).toHaveAttribute('disabled');
    await expect(button(page, 'Cancel')).toHaveAttribute('disabled');
    await button(page, 'Add Page').click();
    await expect(button(page, 'Cancel')).not.toHaveAttribute('disabled');
    await button(page, 'Cancel').click();
    await expect(page.locator('app-nav-preview > webui-reorder > webui-nav-link[name=""]')).toHaveCount(0);
    await expect(button(page, 'Save')).toHaveAttribute('disabled');
    await expect(button(page, 'Cancel')).toHaveAttribute('disabled');
});
test('Delete is disabled with nothing to delete', async ({ page }) => {
    await openApp(page, { currentPage: '/nav-manager', navigation: [{ name: 'Only', icon: 'star', url: '/only', children: null }] }, '/nav-manager');
    await expect(nameInput(page)).toHaveValue('Only');
    await expect(button(page, 'Delete')).not.toHaveAttribute('disabled');
    await button(page, 'Delete').click();
    await expect(page.locator('app-nav-preview webui-nav-link[name="Only"]')).toHaveCount(0);
    await expect(button(page, 'Delete')).toHaveAttribute('disabled');
    await expect(button(page, 'Delete')).toHaveAttribute('title', 'Select a nav item to delete');
    await expect(button(page, 'Save')).not.toHaveAttribute('disabled');
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
    await page.locator('app-nav-preview webui-nav-link[name="Inner"]').click();
    await expect(nameInput(page)).toHaveValue('Inner');
    await button(page, 'Delete').click();
    await button(page, 'Save').click();
    expect(names(await savedNav(page))).toEqual([['Folder', []], 'Top']);
});
test('renaming applies to the selected item', async ({ page }) => {
    await open(page);
    await page.locator('app-nav-preview webui-nav-link[name="Top"]').click();
    await expect(nameInput(page)).toHaveValue('Top');
    await nameInput(page).fill('Renamed');
    await button(page, 'Save').click();
    expect(names(await savedNav(page))).toEqual([['Folder', ['Inner']], 'Renamed']);
});
test('cancel discards changes', async ({ page }) => {
    await open(page);
    await button(page, 'Add Page').click();
    await button(page, 'Cancel').click();
    await expect(page.locator('app-nav-preview > webui-reorder > webui-nav-link[name=""]')).toHaveCount(0);
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
    await expect(page.locator('app-nav-preview > webui-reorder > webui-nav-link[name=""]')).toHaveCount(1);
    // The header's save has been answered, and the app has dealt with it, before the next step runs in the page.
    await page.evaluate(() => webui.proxy.saveProjectData());
    await expect.poll(async () => (await calls(page, 'save_project_data')).map(call => call.data.navigation.length)).toEqual([2]);
    await expect(page.locator('app-nav-preview > webui-reorder > webui-nav-link[name=""]')).toHaveCount(1);
    await button(page, 'Save').click();
    await expect.poll(async () => (await calls(page, 'save_project_data')).map(call => call.data.navigation.length)).toEqual([2, 3]);
});
