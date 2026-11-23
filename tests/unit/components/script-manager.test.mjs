import { test, expect, openApp, calls, dialogButton, openDialog } from '../support/app.mjs';

const open = async (page, state) => {
    await openApp(page, { currentPage: '/script-manager', ...state }, '/script-manager');
    await page.locator('app-script-manager').waitFor();
};
const editor = page => page.locator('app-script-manager app-script-runner webui-input-message textarea');

test('the first script loads', async ({ page }) => {
    await open(page, { scripts: ['a.ps1', 'b.ps1'], files: { 'a.ps1': 'first', 'b.ps1': 'second' } });
    await expect(editor(page)).toHaveValue('first');
});
test('selecting a script loads it', async ({ page }) => {
    await open(page, { scripts: ['a.ps1', 'b.ps1'], files: { 'a.ps1': 'first', 'b.ps1': 'second' } });
    await expect(editor(page)).toHaveValue('first');
    await page.locator('app-script-manager .file-row[data-file="b.ps1"]').click();
    await expect(editor(page)).toHaveValue('second');
    await expect(page.locator('app-script-manager .file-row[aria-selected="true"]')).toHaveText(['b.ps1']);
});
test('new script asks for a name, then selects the result', async ({ page }) => {
    await open(page, { scripts: [] });
    await page.locator('app-script-manager webui-button[label="New Script"]').click();
    await page.locator('webui-input-text[name="scriptName"] input').fill('fresh');
    await dialogButton(page, 'Save').click();
    await expect.poll(async () => (await calls(page, 'save_project_file')).length).toBe(1);
    await expect.poll(async () => (await calls(page, 'get_scripts')).length).toBeGreaterThan(1);
});
test('markup in a script name is shown as text', async ({ page }) => {
    const name = '<img src=q onerror="window.__xss=1">.ps1';
    await open(page, { scripts: [name], files: { [name]: 'body' } });
    await expect(editor(page)).toHaveValue('body');
    await expect.poll(() => page.evaluate(() => window.__xss)).toBeUndefined();
    await expect(page.locator('app-script-manager .file-list img')).toHaveCount(0);
    await expect(page.locator('app-script-manager .file-row')).toHaveText([name]);
});
test('new script with unsaved changes asks first, and Keep Editing starts nothing new', async ({ page }) => {
    await open(page, { scripts: ['a.ps1'], files: { 'a.ps1': 'first' } });
    await expect(editor(page)).toHaveValue('first');
    await editor(page).fill('mine');
    await page.locator('app-script-manager webui-button[label="New Script"]').click();
    await expect(openDialog(page)).toContainText('Discard Unsaved Changes?');
    await dialogButton(page, 'Keep Editing').click();
    await expect(openDialog(page)).toHaveCount(0);
    await expect(editor(page)).toHaveValue('mine');
    await page.locator('app-script-manager webui-button[label="New Script"]').click();
    await dialogButton(page, 'Discard').click();
    await expect(openDialog(page)).toContainText('Save Script As');
    await expect(editor(page)).toHaveValue('');
});
test('selecting another script with unsaved changes, then Keep Editing, still names the script shown', async ({ page }) => {
    await open(page, { scripts: ['a.ps1', 'b.ps1'], files: { 'a.ps1': 'first', 'b.ps1': 'second' } });
    await expect(editor(page)).toHaveValue('first');
    await editor(page).fill('mine');
    await page.locator('app-script-manager .file-row[data-file="b.ps1"]').click();
    await dialogButton(page, 'Keep Editing').click();
    await expect(openDialog(page)).toHaveCount(0);
    await expect(editor(page)).toHaveValue('mine');
    await expect(page.locator('app-script-manager .file-row[aria-selected="true"]')).toHaveText(['a.ps1']);
});
test('the View toggle shows the list or the script one at a time, and is remembered', async ({ page }) => {
    await open(page, { scripts: ['a.ps1', 'b.ps1'], files: { 'a.ps1': 'first', 'b.ps1': 'second' } });
    await expect(editor(page)).toHaveValue('first');
    const split = page.locator('app-script-manager webui-split-panes');
    await expect(split).not.toHaveAttribute('single');
    await page.locator('app-script-manager webui-toggle-icon[label="View"]').click();
    await expect(split).toHaveAttribute('single', '');
    await expect.poll(() => page.evaluate(() => webui.getData('app-script-manager-single'))).toBe(true);
    // One at a time, picking a script from the list shows it.
    await split.evaluate(el => el.showPane('start'));
    await expect(split).toHaveAttribute('show', 'start');
    await page.locator('app-script-manager .file-row[data-file="b.ps1"]').click();
    await expect(editor(page)).toHaveValue('second');
    await expect(split).toHaveAttribute('show', 'end');
});
test('a View chosen before is kept when the page opens', async ({ page }) => {
    await open(page, { scripts: ['a.ps1'], files: { 'a.ps1': 'first' }, appData: { 'app-script-manager-single': true } });
    await expect(page.locator('app-script-manager webui-split-panes')).toHaveAttribute('single', '');
});
