import { test, expect, openApp, mount, calls, dialogButton, openDialog } from '../support/app.mjs';
import { actionNote, alertPopup } from '../../support/wait.mjs';

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
    await expect(actionNote(page, 'No project is currently selected.')).toHaveCount(1);
    await expect(openDialog(page)).toHaveCount(0);
});
test('Settings has it in a Danger tab, and nowhere else', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('app-project-manager #btn-remove')).toHaveCount(0);
    await expect(page.locator('app-project-remove #btn-remove')).toBeHidden();
    await page.locator('webui-button.settings-tab-danger').click();
    await expect(page.locator('app-project-remove #btn-remove')).toBeVisible();
});
test('why it could not be removed is shown in the dialog as text, never as markup', async ({ page }) => {
    const el = await remover(page);
    await page.evaluate(() => { window.__backend.handlers.remove_project = () => { throw 'No project at <img src=q onerror="window.__xss=1">'; }; });
    await el.locator('#btn-remove').click();
    await dialogButton(page, 'Remove').click();
    await expect(openDialog(page).locator('webui-alert')).toContainText('No project at <img src=q onerror="window.__xss=1">');
    await expect(openDialog(page).locator('img')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__xss)).toBeUndefined();
});
test('a project list that cannot be reloaded after removing is said, and the list is kept', async ({ page }) => {
    await openApp(page, { project: { name: 'Repo', path: '/repo' }, projects: [{ name: 'Repo', path: '/repo' }, { name: 'Other', path: '/other' }] });
    await expect.poll(() => page.evaluate(() => (webui.getData('app-projects') || []).length)).toBe(2);
    const root = await mount(page, '<app-project-remove id="r"></app-project-remove>');
    await page.evaluate(() => { window.__backend.handlers.get_projects = () => { throw 'The projects file is locked.'; }; });
    await root.locator('#r #btn-remove').click();
    await dialogButton(page, 'Remove').click();
    await expect(alertPopup(page, "The project was removed, but the project list couldn't be reloaded: The projects file is locked.")).toHaveCount(1);
    await expect(openDialog(page)).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (webui.getData('app-projects') || []).length)).toBe(2);
});
