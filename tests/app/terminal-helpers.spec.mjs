import { test, expect, openApp, calls, emit } from '../support/app.mjs';

const run = (page, ...args) => page.evaluate(args => webui.proxy.terminalHelpers.runScript(...args), args);
const terminal = (page, id) => page.evaluate(id => webui.proxy.terminalHelpers.getState().terminals[id], id);
const finish = (page, terminalId) => emit(page, 'terminal-finished', { projectId: 'project-id', terminalId, code: 0 });

test.describe('webui.proxy.terminalHelpers', () => {
    test.beforeEach(async ({ page }) => {
        await openApp(page);
        await page.evaluate(() => webui.proxy.terminalHelpers.ensureListeners());
    });
    test('runScript starts a script and marks it running', async ({ page }) => {
        expect(await run(page, 'a.ps1', 'body', ['-x'], false, false)).toBe('Started');
        expect((await calls(page, 'start_script'))[0]).toEqual({ terminalId: 'a.ps1', scriptContent: 'body', args: ['-x'], inSeparateWindow: false });
        expect((await terminal(page, 'a.ps1')).status).toBe('Running');
    });
    test('a running script cannot start twice', async ({ page }) => {
        await run(page, 'a.ps1', 'x', [], false, false);
        await expect(run(page, 'a.ps1', 'x', [], false, false)).rejects.toThrow(/already running/);
    });
    test('the finished event updates status', async ({ page }) => {
        await run(page, 'a.ps1', 'x', [], false, false);
        await finish(page, 'a.ps1');
        expect((await terminal(page, 'a.ps1')).status).toBe('Finished');
    });
    test('a failed start is not left running', async ({ page }) => {
        await page.evaluate(() => { window.__backend.handlers.start_script = () => { throw 'No PowerShell'; }; });
        await expect(run(page, 'a.ps1', 'x', [], false, false)).rejects.toThrow(/No PowerShell/);
        expect((await terminal(page, 'a.ps1')).status).toBe('Finished');
    });
    test('a separate window finishes straight away', async ({ page }) => {
        await run(page, 'a.ps1', 'x', [], true, false);
        expect((await terminal(page, 'a.ps1')).status).toBe('Finished');
    });
    test('queued scripts wait their turn', async ({ page }) => {
        await run(page, 'a.ps1', 'x', [], false, true);
        expect(await run(page, 'b.ps1', 'y', [], false, true)).toBe('Queued');
        expect(await calls(page, 'start_script')).toHaveLength(1);
        await finish(page, 'a.ps1');
        await expect.poll(async () => (await calls(page, 'start_script')).map(call => call.terminalId)).toEqual(['a.ps1', 'b.ps1']);
    });
    test('output is stored per terminal and capped', async ({ page }) => {
        await run(page, 'a.ps1', 'x', [], false, false);
        const lines = Array.from({ length: 6000 }, (_, index) => ({ content: `line ${index}`, isError: false }));
        await emit(page, 'terminal-output', { projectId: 'project-id', terminalId: 'a.ps1', lines });
        const { output } = await terminal(page, 'a.ps1');
        expect(output).toHaveLength(5000);
        expect(output[0].text).toBe('line 1000');
    });
    test('output from another project does not reach this one', async ({ page }) => {
        await run(page, 'a.ps1', 'x', [], false, false);
        await emit(page, 'terminal-output', { projectId: 'other', terminalId: 'a.ps1', lines: [{ content: 'x', isError: false }] });
        expect((await terminal(page, 'a.ps1')).output).toEqual([]);
    });
    test('terminal output stays out of webui data', async ({ page }) => {
        await run(page, 'a.ps1', 'x', [], false, false);
        await emit(page, 'terminal-output', { projectId: 'project-id', terminalId: 'a.ps1', lines: [{ content: 'UNIQUE', isError: false }] });
        expect(await page.evaluate(() => JSON.stringify(webui.taskProxyData))).not.toContain('UNIQUE');
    });
    test('clearOutput empties a terminal', async ({ page }) => {
        await run(page, 'a.ps1', 'x', [], false, false);
        await emit(page, 'terminal-output', { projectId: 'project-id', terminalId: 'a.ps1', lines: [{ content: 'x', isError: false }] });
        await page.evaluate(() => webui.proxy.terminalHelpers.clearOutput('a.ps1'));
        expect((await terminal(page, 'a.ps1')).output).toEqual([]);
    });
    test('getDropdownOptions hides page scripts unless asked', async ({ page }) => {
        await run(page, 'page-script', 'x', [], false, false, true);
        await page.evaluate(() => webui.setData('app-terminals-page-scripts', false));
        const optionIds = () => page.evaluate(async () => {
            const helpers = webui.proxy.terminalHelpers;
            const state = helpers.getState();
            state.activeId = 'live';
            return (await helpers.getDropdownOptions(state, false)).map(option => option.id);
        });
        expect(await optionIds()).toEqual(['live']);
        await page.evaluate(() => webui.setData('app-terminals-page-scripts', true));
        expect(await optionIds()).toEqual(['live', 'page-script']);
    });
});

test.describe('page scripts in the terminal list', () => {
    test.beforeEach(async ({ page }) => {
        await openApp(page);
        await page.evaluate(() => webui.proxy.terminalHelpers.ensureListeners());
    });
    const pageScript = (page, id, display) => page.evaluate(([id, display]) => webui.proxy.terminalHelpers.runScript(id, "$secret = 'REAL'", [], false, false, true, display), [id, display]);
    test('the shown script is the masked copy, while the real one runs', async ({ page }) => {
        await pageScript(page, 'p1', "$secret = 'RE***AL'");
        expect((await terminal(page, 'p1')).script).toBe("$secret = 'RE***AL'");
        expect((await calls(page, 'start_script'))[0].scriptContent).toBe("$secret = 'REAL'");
    });
    test('a queued page script keeps its masked copy', async ({ page }) => {
        await run(page, 'a.ps1', 'x', [], false, true);
        await page.evaluate(() => webui.proxy.terminalHelpers.runScript('p1', 'REAL', [], false, true, true, 'MASKED'));
        await finish(page, 'a.ps1');
        await expect.poll(async () => (await terminal(page, 'p1'))?.script).toBe('MASKED');
    });
    test('a finished page script can be removed, but not a running one or the live terminal', async ({ page }) => {
        await pageScript(page, 'p1', 'masked');
        const remove = id => page.evaluate(id => webui.proxy.terminalHelpers.removeTerminal(id), id);
        expect(await remove('p1')).toBe(false);
        await finish(page, 'p1');
        expect(await remove('p1')).toBe(true);
        expect(await terminal(page, 'p1')).toBeUndefined();
        expect(await remove('live')).toBe(false);
    });
    test('removing the shown terminal switches to the live one', async ({ page }) => {
        await pageScript(page, 'p1', 'masked');
        await finish(page, 'p1');
        await page.evaluate(() => { webui.proxy.terminalHelpers.getState().activeId = 'p1'; });
        await page.evaluate(() => webui.proxy.terminalHelpers.removeTerminal('p1'));
        expect(await page.evaluate(() => webui.proxy.terminalHelpers.getState().activeId)).toBe('live');
    });
    test('removing finished page scripts keeps running ones and other scripts', async ({ page }) => {
        await pageScript(page, 'done', 'm');
        await finish(page, 'done');
        await pageScript(page, 'running', 'm');
        await run(page, 'file.ps1', 'x', [], false, false);
        await finish(page, 'file.ps1');
        expect(await page.evaluate(() => webui.proxy.terminalHelpers.removeFinishedPageScripts())).toBe(1);
        expect(Object.keys(await page.evaluate(() => webui.proxy.terminalHelpers.getState().terminals)).sort()).toEqual(['file.ps1', 'live', 'running']);
    });
});
