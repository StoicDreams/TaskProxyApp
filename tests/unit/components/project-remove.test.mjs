import { test, expect, openApp, mount, calls, dialogButton, openDialog } from '../support/app.mjs';
import { alertPopup } from '../../support/wait.mjs';

// Settings' Danger tab (wc/project-remove.js): removing the current project from Task Proxy, after asking.
async function remover(page, project = { name: 'Repo', path: '/repo' }) {
    await openApp(page, { project });
    const root = await mount(page, '<app-project-remove id="r"></app-project-remove>');
    const el = root.locator('#r');
    await expect(el.locator('#btn-remove')).toBeVisible();
    return el;
}

test('removing asks first, then clears the current project', async ({ page }) => {
    const el = await remover(page);
    await expect(el).toContainText('Its files and folders on this computer stay as they are');
    await el.locator('#btn-remove').click();
    await expect(dialogButton(page, 'Remove')).toBeVisible();
    await expect.poll(() => calls(page, 'remove_project')).toEqual([]);
    await dialogButton(page, 'Remove').click();
    await expect.poll(() => calls(page, 'remove_project')).toEqual([{ path: '/repo' }]);
    await expect.poll(async () => (await calls(page, 'clear_current_project')).length).toBe(1);
});
test('a removed project is no longer saved as the current project, so the app does not reopen it', async ({ page }) => {
    await openApp(page, { project: { name: 'Repo', path: '/repo' }, projects: [{ name: 'Repo', path: '/repo' }, { name: 'Other', path: '/other' }] });
    await expect.poll(() => page.evaluate(() => window.__backend.appData.data['app-current-project']?.value)).toBe('/repo');
    const root = await mount(page, '<app-project-remove id="r"></app-project-remove>');
    await root.locator('#r #btn-remove').click();
    await dialogButton(page, 'Remove').click();
    // The project list no longer has it, so the next project opens instead.
    await expect.poll(() => page.evaluate(() => window.__backend.appData.data['app-current-project']?.value)).not.toBe('/repo');
});
test('cancelling removes nothing', async ({ page }) => {
    const el = await remover(page);
    await el.locator('#btn-remove').click();
    await dialogButton(page, 'Cancel').click();
    await expect(openDialog(page)).toHaveCount(0);
    await expect.poll(() => calls(page, 'remove_project')).toEqual([]);
});
test("the project's name is shown as written in the question, never run as markup", async ({ page }) => {
    const name = '"><img src=q onerror="window.__xss=1">';
    const el = await remover(page, { name, path: '/repo' });
    await el.locator('#btn-remove').click();
    await expect(openDialog(page).locator('strong')).toHaveText(name);
    await expect(openDialog(page).locator('img')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__xss)).toBeUndefined();
});
test('with no project, removing says so', async ({ page }) => {
    await openApp(page, { project: null });
    const root = await mount(page, '<app-project-remove id="r"></app-project-remove>');
    await root.locator('#r #btn-remove').click();
    await expect(alertPopup(page, 'No project is currently selected.')).toHaveCount(1);
    await expect(openDialog(page)).toHaveCount(0);
});
test('Settings has it in a Danger tab, and nowhere else', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('app-project-manager #btn-remove')).toHaveCount(0);
    await expect(page.locator('app-project-remove #btn-remove')).toBeHidden();
    await page.locator('webui-button.settings-tab-danger').click();
    await expect(page.locator('app-project-remove #btn-remove')).toBeVisible();
});
