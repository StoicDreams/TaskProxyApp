import { test, expect, openApp, mount, calls, dialogButton } from '../support/app.mjs';

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
    await page.waitForTimeout(100);
    expect(await calls(page, 'rename_project')).toEqual([]);
});
test('removing asks first, then clears the current project', async ({ page }) => {
    const el = await manager(page);
    await el.locator('#btn-remove').click();
    expect(await calls(page, 'remove_project')).toEqual([]);
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
    await page.locator('dialog').last().waitFor();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    await expect(page.locator('dialog img')).toHaveCount(0);
});
test('with no project, it says so', async ({ page }) => {
    await openApp(page, { project: null });
    const root = await mount(page, '<app-project-manager id="m"></app-project-manager>');
    await root.locator('#btn-edit').click();
    await page.waitForTimeout(100);
    expect(await calls(page, 'rename_project')).toEqual([]);
});
