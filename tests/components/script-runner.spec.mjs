import { test, expect, openApp, mount, calls, dialogButton } from '../support/app.mjs';

async function runner(page, state = {}) {
    await openApp(page, state);
    const root = await mount(page, '<app-script-runner id="r"></app-script-runner>');
    await page.waitForFunction(() => document.querySelector('#r')._btnRun && document.querySelector('#r')._previewPanel?.setValue);
    return root.locator('#r');
}
const setScript = (el, name, content) => el.evaluate((node, [name, content]) => node.setScript(name, content), [name, content]);
const click = (el, label) => el.locator(`webui-button[label="${label}"]`).first().click();
const paramNames = el => el.locator('.params-container > *').evaluateAll(nodes => nodes.map(node => [node.getAttribute('data-param'), node.localName]));

test('parameters from a param block become inputs', async ({ page }) => {
    const el = await runner(page);
    await setScript(el, 'a.ps1', "# Comment\n[CmdletBinding()]\nparam(\n  [string]$Name = 'a, b',\n  [ValidateSet('x','y')][string]$Kind,\n  [switch]$Force\n)\nWrite-Host $Other");
    await expect.poll(() => paramNames(el)).toEqual([['Name', 'webui-input-text'], ['Kind', 'webui-input-text'], ['Force', 'webui-toggle-icon']]);
});
test('a script with no param block has no inputs', async ({ page }) => {
    const el = await runner(page);
    await setScript(el, 'a.ps1', 'Write-Host $name');
    await expect.poll(() => paramNames(el)).toEqual([]);
});
test('the preview shows the command, with parameters', async ({ page }) => {
    const el = await runner(page);
    await setScript(el, 'scripts/a b.ps1', 'param([string]$Name)\nx');
    await el.locator('webui-input-text[data-param="Name"] input').fill('val');
    await expect.poll(() => el.locator('webui-code').evaluate(node => node.value)).toBe('& "./scripts/a b.ps1" -Name "val"');
});
test('run saves the file and passes parameters as arguments', async ({ page }) => {
    const el = await runner(page);
    await setScript(el, 'a.ps1', 'param([string]$Name,[switch]$Force)\nx');
    await el.locator('webui-input-text[data-param="Name"] input').fill('val');
    await el.locator('webui-toggle-icon[data-param="Force"]').click();
    await click(el, 'Run');
    await expect.poll(async () => (await calls(page, 'start_script')).length).toBe(1);
    expect((await calls(page, 'start_script'))[0]).toMatchObject({ terminalId: 'a.ps1', args: ['-Name', 'val', '-Force'] });
    expect((await calls(page, 'save_project_file'))[0].filePath).toBe('a.ps1');
});
test('an empty script does not run', async ({ page }) => {
    const el = await runner(page);
    await setScript(el, 'a.ps1', '   ');
    await click(el, 'Run');
    await page.waitForTimeout(100);
    expect(await calls(page, 'start_script')).toEqual([]);
});
test('a page script is never saved as a file, even with a dot in its name', async ({ page }) => {
    const el = await runner(page);
    for (const name of ['Repo_Page_Deploy v1.2 now', 'Repo_Page_Run deploy.ps1']) {
        await page.evaluate(name => webui.proxy.terminalHelpers.runScript(name, "$secret = 'injected'", [], false, false, true), name);
        await page.evaluate(name => window.__backend.emit('terminal-finished', { projectId: 'project-id', terminalId: name, code: 0 }), name);
        await setScript(el, name, "$secret = 'injected'");
        await click(el, 'Run');
        await page.waitForTimeout(100);
        expect(await calls(page, 'save_project_file')).toEqual([]);
    }
});
test('saving a page script asks for a file name instead', async ({ page }) => {
    const el = await runner(page);
    await setScript(el, 'Repo_Page_Deploy v1.2', 'x');
    await click(el, 'Save');
    await expect(page.getByText('Save Script As')).toBeVisible();
    expect(await calls(page, 'save_project_file')).toEqual([]);
});
test('reset on the live terminal keeps it as the live terminal', async ({ page }) => {
    const el = await runner(page);
    await setScript(el, 'live', 'old');
    await click(el, 'Reset');
    await el.locator('webui-input-message textarea').fill('Write-Host new');
    await click(el, 'Run');
    await expect.poll(async () => (await calls(page, 'start_script')).length).toBe(1);
    expect((await calls(page, 'start_script'))[0].terminalId).toBe('live');
});
test('reset reloads a script file', async ({ page }) => {
    const el = await runner(page, { files: { 'a.ps1': 'from disk' } });
    await setScript(el, 'a.ps1', 'changed');
    await click(el, 'Reset');
    await expect(el.locator('webui-input-message textarea')).toHaveValue('from disk');
});
test('a script that fails to load cannot be saved over', async ({ page }) => {
    const el = await runner(page);
    await el.evaluate(node => node.loadScript('missing.ps1'));
    await click(el, 'Save');
    await expect(page.getByText('Save Script As')).toBeVisible();
    expect(await calls(page, 'save_project_file')).toEqual([]);
});
test('an empty script file loads, and stays attached to its file', async ({ page }) => {
    const el = await runner(page, { files: { 'empty.ps1': '' } });
    await el.evaluate(node => node.loadScript('empty.ps1'));
    await page.waitForTimeout(100);
    await el.locator('webui-input-message textarea').fill('new');
    await click(el, 'Save');
    await expect.poll(async () => (await calls(page, 'save_project_file')).length).toBe(1);
    expect((await calls(page, 'save_project_file'))[0].filePath).toBe('empty.ps1');
});
test('save as refuses a name already in use', async ({ page }) => {
    const el = await runner(page, { scripts: ['.taskproxy/scripts/taken.ps1'] });
    await setScript(el, 'live', 'x');
    await click(el, 'Save As');
    await page.locator('webui-input-text[name="scriptName"] input').fill('taken');
    await dialogButton(page, 'Save').click();
    await page.waitForTimeout(200);
    expect(await calls(page, 'save_project_file')).toEqual([]);
});
test('save as writes a new script', async ({ page }) => {
    const el = await runner(page);
    await setScript(el, 'live', 'body');
    await click(el, 'Save As');
    await page.locator('webui-input-text[name="scriptName"] input').fill('fresh');
    await dialogButton(page, 'Save').click();
    await expect.poll(async () => (await calls(page, 'save_project_file')).length).toBe(1);
    expect((await calls(page, 'save_project_file'))[0]).toEqual({ filePath: '.taskproxy/scripts/fresh.ps1', contents: 'body' });
});
