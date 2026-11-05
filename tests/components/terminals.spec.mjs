import { test, expect, openApp, calls, emit } from '../support/app.mjs';

const open = async (page, state = {}) => {
    await openApp(page, state);
    await page.locator('app-terminals').click();
};
const ready = async page => {
    await page.locator('#term-content-wrapper').waitFor();
    await page.locator('#term-console').waitFor();
    await page.waitForFunction(() => document.querySelector('#term-runner')?.setScript && document.querySelector('#term-console')?.appendLines);
    await page.waitForTimeout(100);
};
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
test('output for the shown terminal appears live', async ({ page }) => {
    await open(page);
    await ready(page);
    await start(page, 'a.ps1');
    await emit(page, 'terminal-output', { projectId: 'project-id', terminalId: 'a.ps1', lines: [{ content: 'LIVE OUTPUT', isError: false }] });
    await expect(page.locator('#term-console .console-container')).toContainText('LIVE OUTPUT');
});
test('output for another terminal is kept for later', async ({ page }) => {
    await open(page);
    await ready(page);
    await start(page, 'a.ps1');
    await page.evaluate(() => webui.proxy.terminalHelpers.runScript('b.ps1', 'body', [], false, false));
    await emit(page, 'terminal-output', { projectId: 'project-id', terminalId: 'b.ps1', lines: [{ content: 'FOR B', isError: false }] });
    await expect(page.locator('#term-console .console-container')).not.toContainText('FOR B');
    await page.evaluate(() => document.querySelector('app-terminals').switchTerminal('b.ps1'));
    await expect(page.locator('#term-console .console-container')).toContainText('FOR B');
});
test('kill stops the running script', async ({ page }) => {
    await open(page);
    await ready(page);
    await start(page, 'a.ps1');
    await page.locator('#btn-kill').click();
    await expect.poll(async () => (await calls(page, 'kill_script')).length).toBe(1);
    expect((await calls(page, 'kill_script'))[0]).toEqual({ terminalId: 'a.ps1' });
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
    await emit(page, 'terminal-output', { projectId: 'project-id', terminalId: 'a.ps1', lines: [{ content: 'GONE', isError: false }] });
    await page.locator('#btn-clear').click();
    await expect(page.locator('#term-console .console-container')).toHaveText('No terminal output.');
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
