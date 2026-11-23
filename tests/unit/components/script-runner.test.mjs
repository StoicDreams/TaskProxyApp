import { test, expect, openApp, mount, calls, dialogButton, openDialog } from '../support/app.mjs';
import { actionNote } from '../../support/wait.mjs';

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
    await expect.poll(async () => (await calls(page, 'spawn_script')).length).toBe(1);
    expect((await calls(page, 'spawn_script'))[0]).toMatchObject({ terminalId: 'a.ps1', args: ['-Name', 'val', '-Force'] });
    expect((await calls(page, 'save_project_file'))[0].filePath).toBe('a.ps1');
});
test('a script that could not be saved says why, and does not run', async ({ page }) => {
    const el = await runner(page);
    await setScript(el, 'a.ps1', 'Write-Host hi');
    await page.evaluate(() => { window.__backend.handlers.save_project_file = () => { throw 'The disk is full.'; }; });
    await click(el, 'Run');
    await expect(actionNote(page, 'The disk is full.')).toHaveCount(1);
    await expect.poll(() => calls(page, 'spawn_script')).toEqual([]);
});
test('Run is off for an empty script, saying why, and on once there is a script', async ({ page }) => {
    const el = await runner(page);
    const run = el.locator('webui-button[label="Run"]');
    await setScript(el, 'a.ps1', '   ');
    await expect(run).toHaveAttribute('disabled');
    await expect(run).toHaveAttribute('title', 'Write a script to run');
    await el.locator('webui-input-message textarea').fill('Write-Host hi');
    await expect(run).not.toHaveAttribute('disabled');
    await el.locator('webui-input-message textarea').fill('');
    await expect(run).toHaveAttribute('disabled');
    expect(await calls(page, 'spawn_script')).toEqual([]);
});
test('what the buttons said goes when another script is shown, or loaded, and stays for the same one', async ({ page }) => {
    const el = await runner(page, { files: { 'b.ps1': 'Write-Host b' } });
    await page.evaluate(() => { window.__backend.handlers.save_project_file = () => { throw 'The disk is full.'; }; });
    await setScript(el, 'a.ps1', 'Write-Host a');
    await click(el, 'Run');
    await expect(actionNote(el, 'The disk is full.')).toHaveCount(1);
    await setScript(el, 'a.ps1', 'Write-Host a');
    await expect(actionNote(el, 'The disk is full.')).toHaveCount(1);
    await setScript(el, 'other.ps1', 'Write-Host other');
    await expect(actionNote(el, 'The disk is full.')).toHaveCount(0);
    await setScript(el, 'a.ps1', 'Write-Host a');
    await click(el, 'Run');
    await expect(actionNote(el, 'The disk is full.')).toHaveCount(1);
    await el.evaluate(node => node.loadScript('b.ps1'));
    await expect(el.locator('webui-input-message textarea')).toHaveValue('Write-Host b');
    await expect(actionNote(el, 'The disk is full.')).toHaveCount(0);
});
test('what the buttons said goes when the script is shown read-only', async ({ page }) => {
    const el = await runner(page);
    await page.evaluate(() => { window.__backend.handlers.save_project_file = () => { throw 'The disk is full.'; }; });
    await setScript(el, 'a.ps1', 'Write-Host a');
    await click(el, 'Run');
    await expect(actionNote(el, 'The disk is full.')).toHaveCount(1);
    await el.evaluate(node => node.setReadOnly(true));
    await expect(el.locator('webui-button[label="Run"]')).toBeHidden();
    await expect(actionNote(el, 'The disk is full.')).toHaveCount(0);
});
test('a page script is never saved as a file, even with a dot in its name', async ({ page }) => {
    const el = await runner(page);
    for (const name of ['Repo_Page_Deploy v1.2 now', 'Repo_Page_Run deploy.ps1']) {
        await page.evaluate(name => webui.proxy.terminalHelpers.runScript(name, "$secret = 'injected'", [], false, false, true), name);
        await page.evaluate(name => window.__backend.runs.end({ projectId: 'project-id', terminalId: name, code: 0 }), name);
        await setScript(el, name, "$secret = 'injected'");
        const started = (await calls(page, 'spawn_script')).length;
        await click(el, 'Run');
        // A script file is saved before it starts, so once this has started it was not saved.
        await expect.poll(async () => (await calls(page, 'spawn_script')).length).toBe(started + 1);
        await expect.poll(() => calls(page, 'save_project_file')).toEqual([]);
    }
});
test('saving a page script asks for a file name instead', async ({ page }) => {
    const el = await runner(page);
    await setScript(el, 'Repo_Page_Deploy v1.2', 'x');
    await click(el, 'Save');
    await expect(page.getByText('Save Script As')).toBeVisible();
    await expect.poll(() => calls(page, 'save_project_file')).toEqual([]);
});
test('reset on the live terminal keeps it as the live terminal', async ({ page }) => {
    const el = await runner(page);
    await setScript(el, 'live', 'old');
    await click(el, 'Reset');
    await el.locator('webui-input-message textarea').fill('Write-Host new');
    await click(el, 'Run');
    await expect.poll(async () => (await calls(page, 'spawn_script')).length).toBe(1);
    expect((await calls(page, 'spawn_script'))[0].terminalId).toBe('live');
});
test('typed changes are asked about before another script is shown, and kept on Keep Editing', async ({ page }) => {
    const el = await runner(page);
    await setScript(el, 'a.ps1', 'Write-Host a');
    await el.locator('webui-input-message textarea').fill('Write-Host mine');
    // Not awaited, since it waits for the question to be answered.
    await el.evaluate(node => { node.setScript('b.ps1', 'Write-Host b'); });
    await dialogButton(page, 'Keep Editing').click();
    await expect(openDialog(page)).toHaveCount(0);
    await expect(el.locator('webui-input-message textarea')).toHaveValue('Write-Host mine');
    await expect.poll(() => el.evaluate(node => node._fileName)).toBe('a.ps1');
    // Saved, they are no longer asked about.
    await click(el, 'Save');
    await expect.poll(() => calls(page, 'save_project_file')).toEqual([{ filePath: 'a.ps1', contents: 'Write-Host mine' }]);
    await setScript(el, 'b.ps1', 'Write-Host b');
    await expect(el.locator('webui-input-message textarea')).toHaveValue('Write-Host b');
    await expect(openDialog(page)).toHaveCount(0);
});
test('reset reloads a script file', async ({ page }) => {
    const el = await runner(page, { files: { 'a.ps1': 'from disk' } });
    await el.evaluate(node => node.loadScript('a.ps1'));
    await expect(el.locator('webui-input-message textarea')).toHaveValue('from disk');
    await el.locator('webui-input-message textarea').fill('changed');
    await click(el, 'Reset');
    await expect(el.locator('webui-input-message textarea')).toHaveValue('from disk');
});
test('a script that fails to load cannot be saved over', async ({ page }) => {
    const el = await runner(page);
    await el.evaluate(node => node.loadScript('missing.ps1'));
    await expect.poll(() => el.evaluate(node => node._fileName)).toBe('');
    // With nothing written, there is nothing to save.
    await expect(el.locator('webui-button[label="Save"]')).toHaveAttribute('disabled');
    await el.locator('webui-input-message textarea').fill('x');
    await click(el, 'Save');
    await expect(page.getByText('Save Script As')).toBeVisible();
    await expect.poll(() => calls(page, 'save_project_file')).toEqual([]);
});
test('Save and Reset are off until the script changes, and off again once it is saved', async ({ page }) => {
    const el = await runner(page, { files: { 'a.ps1': 'Write-Host a' } });
    const save = el.locator('webui-button[label="Save"]');
    const reset = el.locator('webui-button[label="Reset"]');
    await el.evaluate(node => node.loadScript('a.ps1'));
    await expect(el.locator('webui-input-message textarea')).toHaveValue('Write-Host a');
    await expect(save).toHaveAttribute('disabled');
    await expect(save).toHaveAttribute('title', 'This script has no changes to save');
    await expect(reset).toHaveAttribute('disabled');
    await el.locator('webui-input-message textarea').fill('Write-Host b');
    await expect(save).not.toHaveAttribute('disabled');
    await expect(reset).not.toHaveAttribute('disabled');
    // Typed back as it is saved, there is nothing to save again.
    await el.locator('webui-input-message textarea').fill('Write-Host a');
    await expect(save).toHaveAttribute('disabled');
    await el.locator('webui-input-message textarea').fill('Write-Host c');
    await click(el, 'Save');
    await expect.poll(() => calls(page, 'save_project_file')).toEqual([{ filePath: 'a.ps1', contents: 'Write-Host c' }]);
    await expect(save).toHaveAttribute('disabled');
    await expect(reset).toHaveAttribute('disabled');
    // Run saves the script too.
    await el.locator('webui-input-message textarea').fill('Write-Host d');
    await expect(save).not.toHaveAttribute('disabled');
    await click(el, 'Run');
    await expect.poll(async () => (await calls(page, 'spawn_script')).length).toBe(1);
    await expect(save).toHaveAttribute('disabled');
});
test('Save and Reset are off for an empty script with no file, which Save As still saves', async ({ page }) => {
    const el = await runner(page);
    const save = el.locator('webui-button[label="Save"]');
    await setScript(el, 'live', '');
    await expect(save).toHaveAttribute('disabled');
    await expect(save).toHaveAttribute('title', 'Write a script to save');
    await expect(el.locator('webui-button[label="Reset"]')).toHaveAttribute('disabled');
    await expect(el.locator('webui-button[label="Save As"]')).not.toHaveAttribute('disabled');
    await el.locator('webui-input-message textarea').fill('Write-Host hi');
    await expect(save).not.toHaveAttribute('disabled');
    await expect(el.locator('webui-button[label="Reset"]')).not.toHaveAttribute('disabled');
});
test('Clear Params is off until a parameter has a value, and off again once cleared', async ({ page }) => {
    const el = await runner(page);
    const clear = el.locator('webui-button[label="Clear Params"]');
    await setScript(el, 'a.ps1', 'Write-Host a');
    await expect(clear).toHaveAttribute('disabled');
    await expect(clear).toHaveAttribute('title', 'This script has no parameters');
    await setScript(el, 'b.ps1', 'param([string]$Name)\nx');
    await expect(clear).toHaveAttribute('disabled');
    await expect(clear).toHaveAttribute('title', 'No parameter has a value to clear');
    await el.locator('webui-input-text[data-param="Name"] input').fill('val');
    await expect(clear).not.toHaveAttribute('disabled');
    await click(el, 'Clear Params');
    await expect(clear).toHaveAttribute('disabled');
});
test('an empty script file loads, and stays attached to its file', async ({ page }) => {
    const el = await runner(page, { files: { 'empty.ps1': '' } });
    await el.evaluate(node => node.loadScript('empty.ps1'));
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
    await expect(openDialog(page).getByText('A script with that name already exists.')).toBeVisible();
    await expect.poll(() => calls(page, 'save_project_file')).toEqual([]);
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

test('save as that fails keeps the dialog open, saying why', async ({ page }) => {
    const el = await runner(page);
    await setScript(el, 'live', 'body');
    await page.evaluate(() => { window.__backend.handlers.save_project_file = () => { throw 'The disk is full.'; }; });
    await click(el, 'Save As');
    await page.locator('webui-input-text[name="scriptName"] input').fill('fresh');
    await dialogButton(page, 'Save').click();
    await expect(openDialog(page).getByText('The disk is full.')).toBeVisible();
    await expect(page.locator('webui-input-text[name="scriptName"] input')).toHaveValue('fresh');
});

test.describe('Write with AI', () => {
    const AI = { providers: [{ id: 'p', name: 'Local', kind: 'openAi', baseUrl: 'http://localhost:11434/v1', models: [{ id: 'm', name: 'Model' }], hidden: [] }] };
    const DRAFT = "param(\n  [string]$Name = 'world'\n)\nWrite-Host \"Hello $Name\"";
    const write = async (el, page, asked) => {
        await el.locator('#ai-script webui-button.ai-run').click();
        await page.locator('textarea[name="ai_request"]').fill(asked);
        await dialogButton(page, 'Write with AI').click();
    };

    test('it writes the script into the editor unsaved, with its parameters, from the script open now', async ({ page }) => {
        const el = await runner(page, { ai: AI, appData: { 'app-ai-integrations': { scripts: true } }, aiReplies: { scripts: DRAFT } });
        await setScript(el, 'hello.ps1', 'Write-Host hi');
        await write(el, page, 'Greet a name given as a parameter');
        await expect(el.locator('webui-input-message textarea')).toHaveValue(DRAFT);
        await expect.poll(() => paramNames(el)).toEqual([['Name', 'webui-input-text']]);
        await expect.poll(() => calls(page, 'ai_write').then(list => list.map(call => call.request.integration))).toEqual(['scripts']);
        const sent = (await calls(page, 'ai_write')).at(-1).request;
        expect(sent.context).toContain('hello.ps1');
        expect(sent.context).toContain('Write-Host hi');
        expect(sent.request).toContain('Greet a name given as a parameter');
        await expect.poll(() => calls(page, 'save_project_file')).toEqual([]);
    });

    test('a script changed while it writes keeps the changes, and the draft is not used', async ({ page }) => {
        const el = await runner(page, { ai: AI, appData: { 'app-ai-integrations': { scripts: true } }, aiReplies: { scripts: DRAFT } });
        await setScript(el, 'hello.ps1', 'Write-Host hi');
        await page.evaluate(() => {
            const original = window.__backend.handlers.ai_write;
            window.__backend.handlers.ai_write = args => new Promise(resolve => { window.__release = () => resolve(original(args)); });
        });
        await write(el, page, 'Greet a name');
        await expect.poll(() => page.evaluate(() => typeof window.__release)).toBe('function');
        await el.locator('webui-input-message textarea').fill('Write-Host mine');
        await page.evaluate(() => window.__release());
        await expect(el.locator('#ai-script webui-alert.ai-problem[show]')).toHaveText(/changed while AI was writing, so the draft wasn't used/);
        await expect(el.locator('webui-input-message textarea')).toHaveValue('Write-Host mine');
    });

    test('an empty answer leaves the script as it was', async ({ page }) => {
        const el = await runner(page, { ai: AI, appData: { 'app-ai-integrations': { scripts: true } }, aiReplies: { scripts: '' } });
        await setScript(el, 'hello.ps1', 'Write-Host hi');
        await write(el, page, 'Greet a name');
        await expect(el.locator('#ai-script webui-alert.ai-problem[show]')).toHaveText(/The AI answer was empty/);
        await expect(el.locator('webui-input-message textarea')).toHaveValue('Write-Host hi');
    });

    test('a draft shows as not saved, in place of what Save said before', async ({ page }) => {
        const el = await runner(page, { ai: AI, appData: { 'app-ai-integrations': { scripts: true } }, aiReplies: { scripts: DRAFT } });
        await setScript(el, 'hello.ps1', 'Write-Host hi');
        await el.locator('webui-input-message textarea').fill('Write-Host hello');
        await click(el, 'Save');
        await expect.poll(() => calls(page, 'save_project_file')).toHaveLength(1);
        await expect(el.locator('webui-alert.action-note[show]')).toHaveAttribute('variant', 'success');
        await write(el, page, 'Greet a name');
        await expect(el.locator('webui-input-message textarea')).toHaveValue(DRAFT);
        await expect(actionNote(el, 'Not saved yet. Check the script, then Save it.')).toHaveCount(1);
        await expect(el.locator('webui-alert.action-note[show]')).toHaveCount(1);
    });

    test('showing another script asks before discarding a draft, and keeps it unless told to discard it', async ({ page }) => {
        const el = await runner(page, { ai: AI, appData: { 'app-ai-integrations': { scripts: true } }, aiReplies: { scripts: DRAFT } });
        await setScript(el, 'hello.ps1', 'Write-Host hi');
        await write(el, page, 'Greet a name');
        await expect(el.locator('webui-input-message textarea')).toHaveValue(DRAFT);
        // Not awaited, since it waits for the question to be answered.
        await el.evaluate(node => { node.setScript('other.ps1', 'Write-Host other'); });
        await dialogButton(page, 'Keep Editing').click();
        await expect(openDialog(page)).toHaveCount(0);
        await expect(el.locator('webui-input-message textarea')).toHaveValue(DRAFT);
        await expect.poll(() => el.evaluate(node => node._fileName)).toBe('hello.ps1');
        await el.evaluate(node => { node.setScript('other.ps1', 'Write-Host other'); });
        await dialogButton(page, 'Discard').click();
        await expect(el.locator('webui-input-message textarea')).toHaveValue('Write-Host other');
        // Nothing is unsaved now, so the next script is shown without asking.
        await setScript(el, 'third.ps1', 'Write-Host third');
        await expect(el.locator('webui-input-message textarea')).toHaveValue('Write-Host third');
        await expect(openDialog(page)).toHaveCount(0);
    });

    test('a draft discarded, by Reset or for the same script, no longer shows as not saved', async ({ page }) => {
        const el = await runner(page, { ai: AI, appData: { 'app-ai-integrations': { scripts: true } }, aiReplies: { scripts: DRAFT }, files: { 'hello.ps1': 'Write-Host hi' } });
        const notSaved = actionNote(el, 'Not saved yet. Check the script, then Save it.');
        await setScript(el, 'hello.ps1', 'Write-Host hi');
        await write(el, page, 'Greet a name');
        await expect(notSaved).toHaveCount(1);
        await click(el, 'Reset');
        await expect(el.locator('webui-input-message textarea')).toHaveValue('Write-Host hi');
        await expect(notSaved).toHaveCount(0);
        await write(el, page, 'Greet a name');
        await expect(notSaved).toHaveCount(1);
        await el.evaluate(node => { node.setScript('hello.ps1', 'Write-Host again'); });
        await dialogButton(page, 'Discard').click();
        await expect(el.locator('webui-input-message textarea')).toHaveValue('Write-Host again');
        await expect(notSaved).toHaveCount(0);
    });

    test('a saved draft is shown over without asking', async ({ page }) => {
        const el = await runner(page, { ai: AI, appData: { 'app-ai-integrations': { scripts: true } }, aiReplies: { scripts: DRAFT } });
        await setScript(el, 'hello.ps1', 'Write-Host hi');
        await write(el, page, 'Greet a name');
        await expect(actionNote(el, 'Not saved yet. Check the script, then Save it.')).toHaveCount(1);
        await click(el, 'Save');
        await expect.poll(() => calls(page, 'save_project_file')).toEqual([{ filePath: 'hello.ps1', contents: DRAFT }]);
        await expect(actionNote(el, 'Not saved yet. Check the script, then Save it.')).toHaveCount(0);
        await setScript(el, 'other.ps1', 'Write-Host other');
        await expect(el.locator('webui-input-message textarea')).toHaveValue('Write-Host other');
        await expect(openDialog(page)).toHaveCount(0);
    });

    test('a script holding a code fence is sent inside a longer fence', async ({ page }) => {
        const el = await runner(page, { ai: AI, appData: { 'app-ai-integrations': { scripts: true } }, aiReplies: { scripts: DRAFT } });
        const script = "$md = @'\n```pwsh\nWrite-Host inner\n```\n'@";
        await setScript(el, 'hello.ps1', script);
        await write(el, page, 'Explain it');
        await expect.poll(() => calls(page, 'ai_write')).toHaveLength(1);
        const sent = (await calls(page, 'ai_write'))[0].request.context;
        expect(sent).toContain('\n\n````powershell\n' + script + '\n````');
    });

    test('a page script, shown read-only, has no Write with AI', async ({ page }) => {
        const el = await runner(page, { ai: AI, appData: { 'app-ai-integrations': { scripts: true } } });
        await expect(el.locator('#ai-script')).toBeVisible();
        await el.evaluate(node => node.setReadOnly(true));
        await expect(el.locator('#ai-script')).toBeHidden();
    });
});
