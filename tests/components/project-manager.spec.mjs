import { test, expect, openApp, mount, calls, dialogButton, openDialog } from '../support/app.mjs';
import { alertPopup } from '../support/wait.mjs';

async function manager(page, project = { name: 'Repo', path: '/repo' }) {
    await openApp(page, { project });
    const root = await mount(page, '<app-project-manager id="m"></app-project-manager>');
    return root.locator('#m');
}
// The dialog fills in the current name once its input has loaded, so wait for that before typing.
async function openRename(page, el) {
    await el.locator('#btn-edit').click();
    const input = page.locator('webui-input-text[name="projectName"] input');
    await expect(input).toHaveValue('Repo');
    return input;
}
test('renaming sends the new name and updates the current project', async ({ page }) => {
    const el = await manager(page);
    const input = await openRename(page, el);
    await input.fill('New Name');
    await dialogButton(page, 'Rename').click();
    await expect.poll(async () => (await calls(page, 'rename_project')).length).toBe(1);
    expect((await calls(page, 'rename_project'))[0]).toEqual({ path: '/repo', newName: 'New Name' });
    await expect.poll(() => page.evaluate(() => webui.getData('app-current-project').display)).toBe('New Name');
});
test('a blank name is refused', async ({ page }) => {
    const el = await manager(page);
    const input = await openRename(page, el);
    await input.fill('   ');
    await dialogButton(page, 'Rename').click();
    await expect(openDialog(page).getByText('Project name cannot be empty.')).toBeVisible();
    await expect.poll(() => calls(page, 'rename_project')).toEqual([]);
});
test('removing asks first, then clears the current project', async ({ page }) => {
    const el = await manager(page);
    await el.locator('#btn-remove').click();
    await expect(dialogButton(page, 'Remove')).toBeVisible();
    await expect.poll(() => calls(page, 'remove_project')).toEqual([]);
    await dialogButton(page, 'Remove').click();
    await expect.poll(async () => (await calls(page, 'remove_project')).length).toBe(1);
    await expect.poll(async () => (await calls(page, 'clear_current_project')).length).toBe(1);
});
test('a name with special characters shows as written', async ({ page }) => {
    const el = await manager(page, { name: 'Tom & "Co"', path: '/repo' });
    await el.locator('#btn-edit').click();
    await expect(page.locator('webui-input-text[name="projectName"] input')).toHaveValue('Tom & "Co"');
});
test('markup in a project name does not run', async ({ page }) => {
    const name = '"><img src=q onerror="window.__xss=1">';
    const el = await manager(page, { name, path: '/repo' });
    await el.locator('#btn-remove').click();
    // The name is shown as it was written, so it was not read as markup.
    await expect(openDialog(page).locator('strong')).toHaveText(name);
    await expect(openDialog(page).locator('img')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__xss)).toBeUndefined();
});
test('with no project, it says so', async ({ page }) => {
    await openApp(page, { project: null });
    const root = await mount(page, '<app-project-manager id="m"></app-project-manager>');
    await root.locator('#btn-edit').click();
    await expect(alertPopup(page, 'No project is currently selected.')).toHaveCount(1);
    await expect(openDialog(page)).toHaveCount(0);
    await expect.poll(() => calls(page, 'rename_project')).toEqual([]);
});
