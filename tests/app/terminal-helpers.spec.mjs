import { test, expect, openApp, calls, emit, onCommand } from '../support/app.mjs';

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
        expect((await calls(page, 'start_script'))[0]).toEqual({ terminalId: 'a.ps1', scriptContent: 'body', args: ['-x'], inSeparateWindow: false, cols: null, rows: null });
        expect((await terminal(page, 'a.ps1')).status).toBe('Running');
    });
    test('a script starts at the size of the terminal view', async ({ page }) => {
        await page.evaluate(() => webui.proxy.terminalHelpers.setViewSize({ cols: 140, rows: 35 }));
        await run(page, 'a.ps1', 'body', [], false, false);
        expect((await calls(page, 'start_script'))[0]).toMatchObject({ cols: 140, rows: 35 });
    });
    test('whether a script takes input comes from the backend', async ({ page }) => {
        await run(page, 'a.ps1', 'body', [], false, false);
        expect((await terminal(page, 'a.ps1')).interactive).toBe(true);
        await onCommand(page, 'start_script', () => ({ message: 'Script started', interactive: false }));
        await run(page, 'b.ps1', 'body', [], false, false);
        expect((await terminal(page, 'b.ps1')).interactive).toBe(false);
    });
    test('output is kept as written, colors and all', async ({ page }) => {
        await run(page, 'a.ps1', 'body', [], false, false);
        await emit(page, 'terminal-data', { projectId: 'project-id', terminalId: 'a.ps1', data: '\x1b[32mok\x1b[0m\r\n' });
        await emit(page, 'terminal-data', { projectId: 'project-id', terminalId: 'a.ps1', data: 'more' });
        expect((await terminal(page, 'a.ps1')).output.join('')).toBe('\x1b[32mok\x1b[0m\r\nmore');
    });
    test('kept output is trimmed by size, starting on a new line', async ({ page }) => {
        const kept = await page.evaluate(() => {
            const helpers = webui.proxy.terminalHelpers;
            const term = helpers.newTerminal('big');
            const line = 'x'.repeat(1023) + '\n';
            for (let i = 0; i < 3 * 1024; i++) helpers.appendOutput(term, `\x1b[31m${i}\x1b[0m` + line);
            const text = term.output.join('');
            return { size: term.outputSize, length: text.length, start: text.substring(0, 12) };
        });
        expect(kept.size).toBe(kept.length);
        expect(kept.size).toBeLessThanOrEqual(2 * 1024 * 1024);
        expect(kept.size).toBeGreaterThan(1.9 * 1024 * 1024);
        expect(kept.start.startsWith('\x1b[31m')).toBe(true);
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
    test('output from another project does not reach this one', async ({ page }) => {
        await run(page, 'a.ps1', 'x', [], false, false);
        await emit(page, 'terminal-data', { projectId: 'other', terminalId: 'a.ps1', data: 'x' });
        expect((await terminal(page, 'a.ps1')).output).toEqual([]);
        await emit(page, 'terminal-data', { projectId: 'project-id', terminalId: 'a.ps1', data: 'y' });
        expect((await terminal(page, 'a.ps1')).output).toEqual(['y']);
    });
    test('terminal output stays out of webui data', async ({ page }) => {
        await run(page, 'a.ps1', 'x', [], false, false);
        await emit(page, 'terminal-data', { projectId: 'project-id', terminalId: 'a.ps1', data: 'UNIQUE' });
        expect((await terminal(page, 'a.ps1')).output).toEqual(['UNIQUE']);
        expect(await page.evaluate(() => JSON.stringify(webui.taskProxyData))).not.toContain('UNIQUE');
    });
    test('clearOutput empties a terminal', async ({ page }) => {
        await run(page, 'a.ps1', 'x', [], false, false);
        await emit(page, 'terminal-data', { projectId: 'project-id', terminalId: 'a.ps1', data: 'x' });
        expect((await terminal(page, 'a.ps1')).output).toEqual(['x']);
        await page.evaluate(() => webui.proxy.terminalHelpers.clearOutput('a.ps1'));
        expect((await terminal(page, 'a.ps1')).output).toEqual([]);
        expect((await terminal(page, 'a.ps1')).outputSize).toBe(0);
    });
    test('getDropdownOptions lists saved scripts, page scripts, or running scripts, by filter', async ({ page }) => {
        await page.evaluate(() => { window.__backend.handlers.get_scripts = () => ['build.ps1', 'test.ps1']; });
        await run(page, 'page-script', 'x', [], false, false, true);
        await run(page, 'test.ps1', 'x', [], false, false);
        await finish(page, 'page-script');
        const optionIds = filter => page.evaluate(async filter => {
            const helpers = webui.proxy.terminalHelpers;
            return (await helpers.getDropdownOptions(helpers.getState(), filter, null)).map(option => option.id);
        }, filter);
        // The live terminal has a view of its own, so no list includes it.
        expect(await optionIds('Saved')).toEqual(['build.ps1', 'test.ps1']);
        expect(await optionIds('Page')).toEqual(['page-script']);
        expect(await optionIds('Running')).toEqual(['test.ps1']);
        expect(await optionIds('Live')).toEqual([]);
    });
    test('a script that finished while being watched stays in the running lists', async ({ page }) => {
        await run(page, 'page-script', 'x', [], false, false, true);
        await finish(page, 'page-script');
        const ids = await page.evaluate(async () => {
            const helpers = webui.proxy.terminalHelpers;
            return (await helpers.getDropdownOptions(helpers.getState(), 'Running', { id: 'page-script' })).map(option => option.id);
        });
        expect(ids).toEqual(['page-script']);
    });
    test('All Running lists running scripts in every project, named by project', async ({ page }) => {
        await run(page, 'test.ps1', 'x', [], false, false);
        const options = await page.evaluate(async () => {
            const helpers = webui.proxy.terminalHelpers;
            // A script still running in a project the user switched away from.
            const other = helpers.getState('other-project');
            other.terminals['deploy.ps1'] = helpers.newTerminal('deploy.ps1', { status: 'Running', projectId: 'other-project', projectName: 'Storefront' });
            other.terminals['old.ps1'] = helpers.newTerminal('old.ps1', { status: 'Finished', projectName: 'Storefront' });
            return helpers.getDropdownOptions(helpers.getState(), 'All Running', null);
        });
        expect(options.map(option => [option.value, option.display])).toEqual([
            ['test.ps1', 'test.ps1 (Running)'],
            ['other-project::deploy.ps1', 'Storefront: deploy.ps1 (Running)'],
        ]);
        expect(await page.evaluate(() => webui.proxy.terminalHelpers.parseTerminalValue('other-project::deploy.ps1'))).toEqual({ id: 'deploy.ps1', projectId: 'other-project' });
        expect(await page.evaluate(() => webui.proxy.terminalHelpers.parseTerminalValue('test.ps1'))).toEqual({ id: 'test.ps1' });
    });
    test('stopping another project\'s script names that project to the backend', async ({ page }) => {
        await page.evaluate(async () => {
            const helpers = webui.proxy.terminalHelpers;
            helpers.getState('other-project').terminals['deploy.ps1'] = helpers.newTerminal('deploy.ps1', { status: 'Running', interactive: false });
            await helpers.stopScript('deploy.ps1', 'other-project');
        });
        expect(await calls(page, 'kill_script')).toEqual([{ terminalId: 'deploy.ps1', projectId: 'other-project' }]);
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
