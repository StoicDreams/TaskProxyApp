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
    await page.evaluate(() => {
        const el = document.querySelector('app-script-manager');
        el._fileSelector.value = 'b.ps1';
        el._fileSelector.dispatchEvent(new Event('change'));
    });
    await expect(editor(page)).toHaveValue('second');
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
    await page.evaluate(() => {
        const el = document.querySelector('app-script-manager');
        el._fileSelector.value = 'b.ps1';
        el._fileSelector.dispatchEvent(new Event('change'));
    });
    await dialogButton(page, 'Keep Editing').click();
    await expect(openDialog(page)).toHaveCount(0);
    await expect(editor(page)).toHaveValue('mine');
    await expect(page.locator('app-script-manager webui-select[label="Script"]')).toHaveJSProperty('value', 'a.ps1');
});
