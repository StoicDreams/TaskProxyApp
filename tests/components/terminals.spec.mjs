import { test, expect, openApp, calls, emit, onCommand } from '../support/app.mjs';

const open = async (page, state = {}) => {
    await openApp(page, state);
    await page.locator('app-terminals').click();
};
const ready = async page => {
    await page.locator('#term-content-wrapper').waitFor();
    await page.locator('#term-console').waitFor();
    await page.waitForFunction(() => document.querySelector('#term-runner')?.setScript && document.querySelector('#term-console')?._term);
    await page.waitForTimeout(100);
};
// What the terminal shows, read from its buffer rather than the screen, so it includes scrolled out lines.
const screen = page => page.evaluate(() => document.querySelector('#term-console').getScreenText());
const output = (page, terminalId, data) => emit(page, 'terminal-data', { projectId: 'project-id', terminalId, data });
const placeholder = page => page.locator('#term-console .placeholder');
const start = async (page, id) => {
    await page.evaluate(id => webui.proxy.terminalHelpers.runScript(id, 'body', [], false, false), id);
    await page.evaluate(id => document.querySelector('app-terminals').switchTerminal(id), id);
    await page.waitForTimeout(100);
};

test('shows install instructions when PowerShell is missing', async ({ page }) => {
    await open(page, { powershell: { installed: false, executable: '', canAutoInstall: true, installCommand: 'x', instructions: 'Please **install** it' } });
    await expect(page.locator('#term-install-wrapper')).toBeVisible();
    await expect(page.locator('#term-install-instructions strong')).toHaveText('install');
    await expect(page.locator('#btn-install-pwsh')).toBeVisible();
    await page.locator('#btn-install-pwsh').click();
    await expect.poll(async () => (await calls(page, 'auto_install_powershell')).length).toBe(1);
});
test('with no way to install it automatically, only the instructions show', async ({ page }) => {
    await open(page, { powershell: { installed: false, executable: '', canAutoInstall: false, installCommand: '', instructions: 'Download it from the website' } });
    await expect(page.locator('#term-install-instructions')).toContainText('Download it from the website');
    await expect(page.locator('#btn-install-pwsh')).toBeHidden();
    await expect(page.locator('#term-content-wrapper')).toBeHidden();
});
test('when detecting PowerShell fails, the install area shows instead of the terminals', async ({ page }) => {
    await openApp(page);
    await onCommand(page, 'get_powershell_status', () => { throw 'detection failed'; });
    await page.locator('app-terminals').click();
    await expect(page.locator('#term-install-wrapper')).toBeVisible();
    await expect(page.locator('#term-content-wrapper')).toBeHidden();
});
test('a failed install says why, and leaves the install area showing', async ({ page }) => {
    await open(page, { powershell: { installed: false, executable: '', canAutoInstall: true, installCommand: 'x', instructions: 'x' } });
    await onCommand(page, 'auto_install_powershell', () => { throw 'winget is not available'; });
    await page.locator('#btn-install-pwsh').click();
    await expect(page.locator('webui-alerts, webui-alert').filter({ hasText: 'winget is not available' }).first()).toBeAttached();
    await expect(page.locator('#term-install-wrapper')).toBeVisible();
});
test('output for the shown terminal appears live', async ({ page }) => {
    await open(page);
    await ready(page);
    await start(page, 'a.ps1');
    await expect(placeholder(page)).toBeVisible();
    await output(page, 'a.ps1', 'LIVE OUTPUT\r\n');
    await expect.poll(() => screen(page)).toContain('LIVE OUTPUT');
    await expect(placeholder(page)).toBeHidden();
});
test('output for another terminal is kept for later', async ({ page }) => {
    await open(page);
    await ready(page);
    await start(page, 'a.ps1');
    await page.evaluate(() => webui.proxy.terminalHelpers.runScript('b.ps1', 'body', [], false, false));
    await output(page, 'b.ps1', 'FOR B\r\n');
    await page.waitForTimeout(100);
    expect(await screen(page)).not.toContain('FOR B');
    await page.evaluate(() => document.querySelector('app-terminals').switchTerminal('b.ps1'));
    await expect.poll(() => screen(page)).toContain('FOR B');
});
test('stop sends Ctrl+C, and a script that ends from it is not forced', async ({ page }) => {
    await open(page);
    await ready(page);
    await onCommand(page, 'write_terminal_input', args => {
        if (args.data === '\x03') setTimeout(() => window.__backend.emit('terminal-finished', { projectId: 'project-id', terminalId: args.terminalId, code: 1 }), 50);
        return null;
    });
    await start(page, 'a.ps1');
    await page.locator('#btn-kill').click();
    await expect.poll(async () => (await calls(page, 'write_terminal_input')).map(call => call.data)).toEqual(['\x03']);
    await expect.poll(() => page.evaluate(() => webui.proxy.terminalHelpers.getState().terminals['a.ps1'].status)).toBe('Finished');
    await page.waitForTimeout(3200);
    expect(await calls(page, 'kill_script')).toEqual([]);
});
test('stop forces a script that ignores Ctrl+C to end after a few seconds', async ({ page }) => {
    await open(page);
    await ready(page);
    await start(page, 'a.ps1');
    await page.locator('#btn-kill').click();
    await expect.poll(async () => (await calls(page, 'write_terminal_input')).length).toBe(1);
    expect(await calls(page, 'kill_script')).toEqual([]);
    await expect.poll(async () => (await calls(page, 'kill_script')).length, { timeout: 6000 }).toBe(1);
    expect((await calls(page, 'kill_script'))[0]).toEqual({ terminalId: 'a.ps1' });
});
test('stop ends a script without a terminal straight away', async ({ page }) => {
    await open(page, { interactive: false });
    await ready(page);
    await start(page, 'a.ps1');
    await page.locator('#btn-kill').click();
    await expect.poll(async () => (await calls(page, 'kill_script')).length).toBe(1);
    expect(await calls(page, 'write_terminal_input')).toEqual([]);
});
test('kill all also clears the queue', async ({ page }) => {
    await open(page);
    await ready(page);
    await start(page, 'a.ps1');
    await page.evaluate(() => webui.proxy.terminalHelpers.runScript('b.ps1', 'x', [], false, true));
    await page.locator('#btn-kill-all').click();
    await expect.poll(async () => (await calls(page, 'kill_all_scripts')).length).toBe(1);
    expect(await page.evaluate(() => webui.proxy.terminalHelpers.getState().queue)).toEqual([]);
});
test('clear empties the console', async ({ page }) => {
    await open(page);
    await ready(page);
    await start(page, 'a.ps1');
    await output(page, 'a.ps1', 'GONE\r\n');
    await expect.poll(() => screen(page)).toContain('GONE');
    await page.locator('#btn-clear').click();
    await expect.poll(() => screen(page)).toBe('');
    await expect(placeholder(page)).toBeVisible();
});
test('select all selects every line, scrolled out ones too, and copies them', async ({ page }) => {
    await open(page);
    await ready(page);
    await start(page, 'a.ps1');
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    await output(page, 'a.ps1', lines.join('\r\n') + '\r\n');
    await expect.poll(() => screen(page)).toContain('line 200');
    await page.evaluate(() => {
        window.__copied = [];
        navigator.clipboard.writeText = async text => { window.__copied.push(text); };
    });
    await page.locator('#btn-select-all').click();
    await expect.poll(() => page.evaluate(() => window.__copied.length)).toBe(1);
    expect(await page.evaluate(() => window.__copied[0])).toBe(lines.join('\n'));
    expect(await page.evaluate(() => document.querySelector('#term-console').getSelectedText())).toContain('line 200');
    await expect(page.locator('webui-alerts, webui-alert').filter({ hasText: 'Copied the terminal output.' }).first()).toBeAttached();
    // The terminal keeps focus, so Ctrl+C copies again rather than stopping the script.
    await page.keyboard.press('Control+c');
    await expect.poll(() => page.evaluate(() => window.__copied.length)).toBe(2);
    expect((await calls(page, 'write_terminal_input')).filter(call => call.data === '\x03')).toEqual([]);
});
test('select all copies without blank lines or whitespace around the text', async ({ page }) => {
    await open(page);
    await ready(page);
    await start(page, 'a.ps1');
    await output(page, 'a.ps1', '\r\n   \r\n  Build started   \r\n\r\n\r\n    Compiling\r\n \t \r\nDone  \r\n\r\n');
    await expect.poll(() => screen(page)).toContain('Done');
    await page.evaluate(() => {
        window.__copied = [];
        navigator.clipboard.writeText = async text => { window.__copied.push(text); };
    });
    await page.locator('#btn-select-all').click();
    await expect.poll(() => page.evaluate(() => window.__copied.length)).toBe(1);
    // Indents inside the text stay, as they are part of the output.
    expect(await page.evaluate(() => window.__copied[0])).toBe('Build started\n    Compiling\nDone');
});
test('select all says so when the clipboard refuses', async ({ page }) => {
    await open(page);
    await ready(page);
    await start(page, 'a.ps1');
    await output(page, 'a.ps1', 'some output\r\n');
    await expect.poll(() => screen(page)).toContain('some output');
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Not allowed'); }; });
    await page.locator('#btn-select-all').click();
    await expect(page.locator('webui-alerts, webui-alert').filter({ hasText: 'could not be copied: Not allowed' }).first()).toBeAttached();
});
test('select all with no output copies nothing', async ({ page }) => {
    await open(page);
    await ready(page);
    await start(page, 'a.ps1');
    await page.evaluate(() => {
        window.__copied = [];
        navigator.clipboard.writeText = async text => { window.__copied.push(text); };
    });
    await page.locator('#btn-select-all').click();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.__copied)).toEqual([]);
});
test('a status change during a dropdown refresh is not lost', async ({ page }) => {
    await open(page);
    await ready(page);
    await start(page, 'a.ps1');
    await page.evaluate(() => {
        const el = document.querySelector('app-terminals');
        el.refreshDropdown();
        webui.proxy.terminalHelpers.getState().terminals['a.ps1'].status = 'Finished';
        el.refreshDropdown();
    });
    await expect.poll(() => page.evaluate(() => document.querySelector('#term-dropdown')._select.textContent)).toContain('a.ps1 (Finished)');
});
test('finishing a script updates the kill button', async ({ page }) => {
    await open(page);
    await ready(page);
    await start(page, 'a.ps1');
    const disabled = () => page.locator('#btn-kill').evaluate(el => el.disabled);
    await expect.poll(disabled).toBeFalsy();
    await emit(page, 'terminal-finished', { projectId: 'project-id', terminalId: 'a.ps1', code: 0 });
    await expect.poll(disabled).toBeTruthy();
});
test('markup in a script name is shown as text', async ({ page }) => {
    await open(page, { scripts: ['<img src=q onerror="window.__xss=1">.ps1'], appData: { 'app-terminals-all-scripts': true } });
    await ready(page);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test.describe('page scripts', () => {
    const runPageScript = async (page, id) => {
        await page.evaluate(id => webui.proxy.terminalHelpers.runScript(id, "$secret = 'REALSECRET'", [], false, false, true, "$secret = 'REA***RET'"), id);
        await page.evaluate(id => document.querySelector('app-terminals').switchTerminal(id), id);
        await page.waitForTimeout(150);
    };
    test('show masked values and cannot be run or saved from here', async ({ page }) => {
        await open(page);
        await ready(page);
        await runPageScript(page, 'p1');
        await expect(page.locator('#term-runner webui-input-message textarea')).toHaveValue("$secret = 'REA***RET'");
        expect(await page.evaluate(() => document.body.innerHTML.includes('REALSECRET'))).toBe(false);
        await expect(page.locator('#term-runner webui-button[label="Run"]')).toBeHidden();
        await expect(page.locator('#term-runner webui-button[label="Save"]')).toBeHidden();
        await expect(page.locator('#term-runner .read-only-note')).toBeVisible();
        await page.locator('#term-runner').evaluate(el => el._btnRun.click());
        await page.waitForTimeout(100);
        expect(await calls(page, 'start_script')).toHaveLength(1);
    });
    test('file scripts can still be run from here', async ({ page }) => {
        await open(page);
        await ready(page);
        await runPageScript(page, 'p1');
        await start(page, 'a.ps1');
        await page.waitForTimeout(100);
        await expect(page.locator('#term-runner webui-button[label="Run"]')).toBeVisible();
        await expect(page.locator('#term-runner .read-only-note')).toBeHidden();
    });
    test('a finished page script can be removed from the list', async ({ page }) => {
        await open(page);
        await ready(page);
        await runPageScript(page, 'p1');
        await expect.poll(() => page.locator('#btn-remove-script').evaluate(el => el.disabled)).toBeTruthy();
        await emit(page, 'terminal-finished', { projectId: 'project-id', terminalId: 'p1', code: 0 });
        await expect.poll(() => page.locator('#btn-remove-script').evaluate(el => el.disabled)).toBeFalsy();
        await page.locator('#btn-remove-script').click();
        await expect.poll(() => page.evaluate(() => webui.proxy.terminalHelpers.getState().terminals.p1)).toBeUndefined();
        await expect.poll(() => page.evaluate(() => webui.proxy.terminalHelpers.getState().activeId)).toBe('live');
        await expect(page.locator('#btn-remove-script')).toBeHidden();
    });
    test('all finished page scripts can be removed at once', async ({ page }) => {
        await open(page);
        await ready(page);
        await expect(page.locator('#btn-remove-finished')).toBeHidden();
        for (const id of ['p1', 'p2']) {
            await runPageScript(page, id);
            await emit(page, 'terminal-finished', { projectId: 'project-id', terminalId: id, code: 0 });
        }
        await expect(page.locator('#btn-remove-finished')).toBeVisible();
        await page.locator('#btn-remove-finished').click();
        await expect.poll(() => page.evaluate(() => Object.keys(webui.proxy.terminalHelpers.getState().terminals))).toEqual(['live']);
        await expect(page.locator('#btn-remove-finished')).toBeHidden();
    });
});
