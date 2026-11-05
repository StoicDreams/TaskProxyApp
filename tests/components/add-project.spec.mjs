import { test, expect, openApp, mount, calls, onCommand } from '../support/app.mjs';

async function adder(page) {
    await openApp(page, { project: null });
    const root = await mount(page, '<app-add-project id="a"></app-add-project>');
    return root.locator('#a');
}
test('adds a project using the typed name', async ({ page }) => {
    const el = await adder(page);
    await el.locator('webui-input-text input').fill('My Project');
    await el.locator('webui-button[theme="primary"]').click();
    await expect.poll(async () => (await calls(page, 'add_project')).length).toBe(1);
    expect((await calls(page, 'add_project'))[0]).toEqual({ name: 'My Project' });
    await expect(el.locator('webui-alert')).toContainText('Successfully Added');
});
test('cancelling the folder picker shows the reason', async ({ page }) => {
    const el = await adder(page);
    await onCommand(page, 'add_project', () => { throw 'Folder selection cancelled'; });
    await el.locator('webui-button[theme="primary"]').click();
    await expect.poll(async () => (await calls(page, 'add_project')).length).toBe(1);
});
test('adding several shows each result', async ({ page }) => {
    const el = await adder(page);
    await onCommand(page, 'add_projects_multi', () => ["Added 'one'", "Skipped 'two': Folder already used."]);
    await el.locator('webui-button[theme="secondary"]').click();
    await expect(el.locator('webui-alert')).toContainText("Added 'one'");
    await expect(el.locator('webui-alert')).toContainText('Skipped');
});
