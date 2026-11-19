import { test, expect, openApp, mount, calls } from '../support/app.mjs';
import { alertPopup } from '../support/wait.mjs';

// The current project in Settings (wc/project-manager.js): its icon and name in the heading, renamed in place by
// clicking the name. Removing it is in project-remove.spec.mjs.
async function manager(page, project = { name: 'Repo', path: '/repo' }) {
    await openApp(page, { project });
    const root = await mount(page, '<app-project-manager id="m"></app-project-manager>');
    const el = root.locator('#m');
    await expect(el.locator('.project-name')).toBeVisible();
    return el;
}
const nameButton = el => el.locator('.project-name');
const input = el => el.locator('.project-rename webui-input-text input');
const button = (el, label) => el.locator('.project-rename webui-button', { hasText: label });
// Clicking the name puts a field with the name in its place.
async function openRename(el, name = 'Repo') {
    await nameButton(el).click();
    await expect(input(el)).toHaveValue(name);
    await expect(input(el)).toBeFocused();
}

test('the heading shows the project name, with an edit icon, after its label and icon', async ({ page }) => {
    const el = await manager(page);
    await expect(el.locator('h3.current-project')).toContainText('Current project:');
    await expect(nameButton(el)).toHaveText('Repo');
    await expect(nameButton(el).locator('webui-icon')).toHaveAttribute('icon', 'pencil');
    await expect(nameButton(el)).toHaveAttribute('title', 'Rename the project');
    await expect(el.locator('h3.current-project > app-project-icon + app-project-name')).toHaveCount(1);
    // No Edit Name button: the name itself starts renaming.
    await expect(el.locator('webui-button', { hasText: 'Edit Name' })).toHaveCount(0);
    await expect(el.locator('#btn-remove')).toHaveCount(0);
    await expect(el.locator('.project-rename')).toBeHidden();
});
test('clicking the edit icon starts renaming too', async ({ page }) => {
    const el = await manager(page);
    await nameButton(el).locator('webui-icon').click();
    await expect(input(el)).toHaveValue('Repo');
    await expect(nameButton(el)).toBeHidden();
});
test('Save sends the new name and shows it in the heading', async ({ page }) => {
    const el = await manager(page);
    await openRename(el);
    await input(el).fill('New Name');
    await button(el, 'Save').click();
    await expect.poll(() => calls(page, 'rename_project')).toEqual([{ path: '/repo', newName: 'New Name' }]);
    await expect.poll(() => page.evaluate(() => webui.getData('app-current-project').display)).toBe('New Name');
    await expect(nameButton(el)).toHaveText('New Name');
    await expect(el.locator('.project-rename')).toBeHidden();
    await expect(nameButton(el)).toBeFocused();
});
test('Enter saves, and Escape cancels', async ({ page }) => {
    const el = await manager(page);
    await openRename(el);
    await input(el).fill('Typed');
    await input(el).press('Escape');
    await expect(nameButton(el)).toHaveText('Repo');
    await expect(el.locator('.project-rename')).toBeHidden();
    await openRename(el);
    await input(el).fill('Entered');
    await input(el).press('Enter');
    await expect.poll(() => calls(page, 'rename_project')).toEqual([{ path: '/repo', newName: 'Entered' }]);
    await expect(nameButton(el)).toHaveText('Entered');
});
test('Cancel puts the name back without renaming', async ({ page }) => {
    const el = await manager(page);
    await openRename(el);
    await input(el).fill('Not this');
    await button(el, 'Cancel').click();
    await expect(nameButton(el)).toHaveText('Repo');
    await expect(nameButton(el)).toBeFocused();
    await openRename(el);
    await expect.poll(() => calls(page, 'rename_project')).toEqual([]);
});
test('a blank name is refused, and the field stays open', async ({ page }) => {
    const el = await manager(page);
    await openRename(el);
    await input(el).fill('   ');
    await button(el, 'Save').click();
    await expect(alertPopup(page, 'Project name cannot be empty.')).toHaveCount(1);
    await expect(input(el)).toBeVisible();
    await expect.poll(() => calls(page, 'rename_project')).toEqual([]);
});
test('a rename the backend refuses says why, and keeps the field open to correct it', async ({ page }) => {
    const el = await manager(page);
    await page.evaluate(() => { window.__backend.handlers.rename_project = () => { throw 'A project named Other already exists.'; }; });
    await openRename(el);
    await input(el).fill('Other');
    await button(el, 'Save').click();
    await expect(alertPopup(page, 'A project named Other already exists.')).toHaveCount(1);
    await expect(input(el)).toHaveValue('Other');
    await expect.poll(() => page.evaluate(() => webui.getData('app-current-project').display)).toBe('Repo');
});
test('saving the same name closes the field without renaming', async ({ page }) => {
    const el = await manager(page);
    await openRename(el);
    await button(el, 'Save').click();
    await expect(el.locator('.project-rename')).toBeHidden();
    await expect.poll(() => calls(page, 'rename_project')).toEqual([]);
});
test('a name with special characters shows as written', async ({ page }) => {
    const el = await manager(page, { name: 'Tom & "Co"', path: '/repo' });
    await expect(nameButton(el)).toHaveText('Tom & "Co"');
    await openRename(el, 'Tom & "Co"');
});
test('markup in a project name does not run', async ({ page }) => {
    const name = '"><img src=q onerror="window.__xss=1">';
    const el = await manager(page, { name, path: '/repo' });
    await expect(nameButton(el)).toHaveText(name);
    await expect(nameButton(el).locator('img')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__xss)).toBeUndefined();
});
test('with no project, there is no name to edit', async ({ page }) => {
    await openApp(page, { project: null });
    const root = await mount(page, '<app-project-manager id="m"></app-project-manager>');
    await expect(root.locator('#m .current-project')).toBeHidden();
});
