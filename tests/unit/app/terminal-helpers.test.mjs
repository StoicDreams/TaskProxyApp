import { test, expect, openApp, calls, onCommand, runOutput, runEnds } from '../support/app.mjs';

const run = (page, ...args) => page.evaluate(args => webui.proxy.terminalHelpers.runScript(...args), args);
const terminal = (page, id) => page.evaluate(id => webui.proxy.terminalHelpers.getState().terminals[id], id);
const finish = (page, terminalId) => runEnds(page, { projectId: 'project-id', terminalId, code: 0 });

test.describe('webui.proxy.terminalHelpers', () => {
    test.beforeEach(async ({ page }) => {
        await openApp(page);
        await page.evaluate(() => webui.proxy.terminalHelpers.ensureListeners());
    });
    test('runScript starts a script and marks it running', async ({ page }) => {
        const result = await run(page, 'a.ps1', 'body', ['-x'], false, false);
        expect(result).toBe('Started');
        await expect.poll(() => calls(page, 'run_script')).toEqual([{ terminalId: 'a.ps1', scriptContent: 'body', args: ['-x'], inSeparateWindow: false, cols: null, rows: null, queue: false, isPageScript: false }]);
        await expect.poll(() => calls(page, 'spawn_script')).toHaveLength(1);
        await expect.poll(async () => (await terminal(page, 'a.ps1'))?.status).toBe('Running');
    });
    test('a script starts at the size of the terminal view', async ({ page }) => {
        await page.evaluate(() => webui.proxy.terminalHelpers.setViewSize({ cols: 140, rows: 35 }));
        await run(page, 'a.ps1', 'body', [], false, false);
        expect((await calls(page, 'spawn_script'))[0]).toMatchObject({ cols: 140, rows: 35 });
    });
    test('whether a script takes input comes from the backend', async ({ page }) => {
        await run(page, 'a.ps1', 'body', [], false, false);
        await expect.poll(async () => (await terminal(page, 'a.ps1'))?.interactive).toBe(true);
        await onCommand(page, 'spawn_script', () => ({ message: 'Script started', interactive: false }));
        await run(page, 'b.ps1', 'body', [], false, false);
        await expect.poll(async () => (await terminal(page, 'b.ps1'))?.interactive).toBe(false);
    });
    test('output is kept as written, colors and all', async ({ page }) => {
        await run(page, 'a.ps1', 'body', [], false, false);
        await runOutput(page, { projectId: 'project-id', terminalId: 'a.ps1', data: '\x1b[32mok\x1b[0m\r\n' });
        await runOutput(page, { projectId: 'project-id', terminalId: 'a.ps1', data: 'more' });
        await expect.poll(async () => (await terminal(page, 'a.ps1'))?.output.join('')).toBe('\x1b[32mok\x1b[0m\r\nmore');
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
        await expect.poll(async () => (await terminal(page, 'a.ps1'))?.status).toBe('Finished');
    });
    test('a failed start is not left running', async ({ page }) => {
        await page.evaluate(() => { window.__backend.handlers.spawn_script = () => { throw 'No PowerShell'; }; });
        await expect(run(page, 'a.ps1', 'x', [], false, false)).rejects.toThrow(/No PowerShell/);
        await expect.poll(async () => (await terminal(page, 'a.ps1'))?.status).toBe('Finished');
    });
    test('a separate window finishes straight away', async ({ page }) => {
        await run(page, 'a.ps1', 'x', [], true, false);
        await expect.poll(async () => (await terminal(page, 'a.ps1'))?.status).toBe('Finished');
    });
    test('queued scripts wait their turn', async ({ page }) => {
        await run(page, 'a.ps1', 'x', [], false, true);
        const result = await run(page, 'b.ps1', 'y', [], false, true);
        expect(result).toBe('Queued');
        await expect.poll(() => calls(page, 'spawn_script')).toHaveLength(1);
        await finish(page, 'a.ps1');
        await expect.poll(async () => (await calls(page, 'spawn_script')).map(call => call.terminalId)).toEqual(['a.ps1', 'b.ps1']);
    });
    test('output from another project does not reach this one', async ({ page }) => {
        await run(page, 'a.ps1', 'x', [], false, false);
        await runOutput(page, { projectId: 'other', terminalId: 'a.ps1', data: 'x' });
        await expect.poll(async () => (await terminal(page, 'a.ps1'))?.output).toEqual([]);
        await runOutput(page, { projectId: 'project-id', terminalId: 'a.ps1', data: 'y' });
        await expect.poll(async () => (await terminal(page, 'a.ps1'))?.output).toEqual(['y']);
    });
    test('terminal output stays out of webui data', async ({ page }) => {
        await run(page, 'a.ps1', 'x', [], false, false);
        await runOutput(page, { projectId: 'project-id', terminalId: 'a.ps1', data: 'UNIQUE' });
        await expect.poll(async () => (await terminal(page, 'a.ps1'))?.output).toEqual(['UNIQUE']);
        await expect.poll(() => page.evaluate(() => JSON.stringify(webui.taskProxyData))).not.toContain('UNIQUE');
    });
    test('clearOutput empties a terminal', async ({ page }) => {
        await run(page, 'a.ps1', 'x', [], false, false);
        await runOutput(page, { projectId: 'project-id', terminalId: 'a.ps1', data: 'x' });
        await expect.poll(async () => (await terminal(page, 'a.ps1'))?.output).toEqual(['x']);
        await page.evaluate(() => webui.proxy.terminalHelpers.clearOutput('a.ps1'));
        await expect.poll(async () => (await terminal(page, 'a.ps1'))?.output).toEqual([]);
        await expect.poll(async () => (await terminal(page, 'a.ps1'))?.outputSize).toBe(0);
    });
    test('getDropdownOptions lists saved scripts, page scripts, or running scripts, by filter', async ({ page }) => {
        await page.evaluate(() => { window.__backend.handlers.get_scripts = () => ['build.ps1', 'test.ps1']; });
        await run(page, 'page-script', 'x', [], false, false, true);
        await run(page, 'test.ps1', 'x', [], false, false);
        await finish(page, 'page-script');
        await expect.poll(async () => (await terminal(page, 'page-script'))?.status).toBe('Finished');
        const optionIds = filter => page.evaluate(async filter => {
            const helpers = webui.proxy.terminalHelpers;
            return (await helpers.getDropdownOptions(helpers.getState(), filter, null)).map(option => option.id);
        }, filter);
        // The live terminal has a view of its own, so no list includes it.
        await expect.poll(() => optionIds('Saved')).toEqual(['build.ps1', 'test.ps1']);
        await expect.poll(() => optionIds('Page')).toEqual(['page-script']);
        await expect.poll(() => optionIds('Running')).toEqual(['test.ps1']);
        await expect.poll(() => optionIds('Live')).toEqual([]);
    });
    test('a script that finished while being watched stays in the running lists', async ({ page }) => {
        await run(page, 'page-script', 'x', [], false, false, true);
        await finish(page, 'page-script');
        await expect.poll(async () => (await terminal(page, 'page-script'))?.status).toBe('Finished');
        const ids = await page.evaluate(async () => {
            const helpers = webui.proxy.terminalHelpers;
            return (await helpers.getDropdownOptions(helpers.getState(), 'Running', { id: 'page-script' })).map(option => option.id);
        });
        expect(ids).toEqual(['page-script']);
    });
    test('saved scripts are listed by their file names, with their paths as the tooltip', async ({ page }) => {
        await onCommand(page, 'get_scripts', () => ['PowerShell/Publish.ps1']);
        await run(page, 'PowerShell/Publish.ps1', 'x', [], false, false);
        const listed = filter => page.evaluate(async filter => {
            const helpers = webui.proxy.terminalHelpers;
            return (await helpers.getDropdownOptions(helpers.getState(), filter, null)).map(option => [option.value, option.display, option.title]);
        }, filter);
        await expect.poll(() => listed('Saved')).toEqual([['PowerShell/Publish.ps1', 'Publish.ps1 (Running)', 'PowerShell/Publish.ps1']]);
        await expect.poll(() => listed('Running')).toEqual([['PowerShell/Publish.ps1', 'Publish.ps1 (Running)', 'PowerShell/Publish.ps1']]);
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
        await expect.poll(() => page.evaluate(() => webui.proxy.terminalHelpers.parseTerminalValue('other-project::deploy.ps1'))).toEqual({ id: 'deploy.ps1', projectId: 'other-project' });
        await expect.poll(() => page.evaluate(() => webui.proxy.terminalHelpers.parseTerminalValue('test.ps1'))).toEqual({ id: 'test.ps1' });
    });
    test('Finished lists every run that has ended, in every project, the latest first, and which failed', async ({ page }) => {
        await run(page, 'test.ps1', 'x', [], false, false);
        const options = await page.evaluate(async () => {
            const helpers = webui.proxy.terminalHelpers;
            const other = helpers.getState('other-project');
            other.terminals['old.ps1'] = helpers.newTerminal('old.ps1', { status: 'Finished', projectName: 'Storefront', startedAt: 1, endedAt: 2, exitCode: 0 });
            other.terminals['broke.ps1'] = helpers.newTerminal('broke.ps1', { status: 'Finished', projectName: 'Storefront', startedAt: 1, endedAt: 3, exitCode: 1 });
            other.terminals['never.ps1'] = helpers.newTerminal('never.ps1', { status: 'Ready', projectName: 'Storefront' });
            return helpers.getDropdownOptions(helpers.getState(), 'Finished', null);
        });
        // test.ps1 is still running, and never.ps1 has not run.
        expect(options.map(option => [option.value, option.display])).toEqual([
            ['other-project::broke.ps1', 'Storefront: broke.ps1 (Failed)'],
            ['other-project::old.ps1', 'Storefront: old.ps1 (Finished)'],
        ]);
        await page.evaluate(() => window.__backend.runs.end({ projectId: 'project-id', terminalId: 'test.ps1', code: 0 }));
        await expect.poll(() => page.evaluate(async () => {
            const helpers = webui.proxy.terminalHelpers;
            return (await helpers.getDropdownOptions(helpers.getState(), 'Finished', null))[0]?.display;
        })).toBe('test.ps1 (Finished)');
    });
    test('runAndWait can run a script in another saved project, kept with that project\'s terminals', async ({ page }) => {
        await openApp(page, { projects: [{ name: 'Repo', path: '/repo' }, { name: 'Other', path: '/other' }] });
        const done = page.evaluate(() => {
            const helpers = webui.proxy.terminalHelpers;
            helpers.ensureListeners();
            return helpers.runAndWait('Before Commit', 'body', undefined, { id: 'id-/other', path: '/other', name: 'Other' });
        });
        await expect.poll(async () => (await calls(page, 'spawn_script')).length).toBe(1);
        expect((await calls(page, 'spawn_script'))[0]).toMatchObject({ terminalId: 'Before Commit', project: '/other' });
        await expect.poll(() => page.evaluate(() => {
            const term = webui.proxy.terminalHelpers.getState('id-/other').terminals['Before Commit'];
            return [term.status, term.projectName, !!webui.proxy.terminalHelpers.getState().terminals['Before Commit']];
        })).toEqual(['Running', 'Other', false]);
        await page.evaluate(() => window.__backend.runs.end({ projectId: 'id-/other', terminalId: 'Before Commit', code: 3 }));
        const code = await done;
        expect(code).toBe(3);
    });
    test('stopping another project\'s script names that project to the backend', async ({ page }) => {
        await page.evaluate(async () => {
            const helpers = webui.proxy.terminalHelpers;
            helpers.getState('other-project').terminals['deploy.ps1'] = helpers.newTerminal('deploy.ps1', { status: 'Running', interactive: false });
            await helpers.stopScript('deploy.ps1', 'other-project');
        });
        await expect.poll(() => calls(page, 'stop_run')).toEqual([{ terminalId: 'deploy.ps1', projectId: 'other-project' }]);
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
        await expect.poll(async () => (await terminal(page, 'p1'))?.script).toBe("$secret = 'RE***AL'");
        expect((await calls(page, 'spawn_script'))[0].scriptContent).toBe("$secret = 'REAL'");
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
        // Each is what removeTerminal answered, so it is read once.
        const whileRunning = await remove('p1');
        expect(whileRunning).toBe(false);
        await finish(page, 'p1');
        await expect.poll(async () => (await terminal(page, 'p1'))?.status).toBe('Finished');
        const onceFinished = await remove('p1');
        expect(onceFinished).toBe(true);
        await expect.poll(() => terminal(page, 'p1')).toBeUndefined();
        const live = await remove('live');
        expect(live).toBe(false);
    });
    test('removing the shown terminal switches to the live one', async ({ page }) => {
        await pageScript(page, 'p1', 'masked');
        await finish(page, 'p1');
        await expect.poll(async () => (await terminal(page, 'p1'))?.status).toBe('Finished');
        await page.evaluate(() => { webui.proxy.terminalHelpers.getState().activeId = 'p1'; });
        await page.evaluate(() => webui.proxy.terminalHelpers.removeTerminal('p1'));
        await expect.poll(() => page.evaluate(() => webui.proxy.terminalHelpers.getState().activeId)).toBe('live');
    });
    test('removing finished page scripts keeps running ones and other scripts', async ({ page }) => {
        await pageScript(page, 'done', 'm');
        await finish(page, 'done');
        await pageScript(page, 'running', 'm');
        await run(page, 'file.ps1', 'x', [], false, false);
        await finish(page, 'file.ps1');
        await expect.poll(async () => [(await terminal(page, 'done'))?.status, (await terminal(page, 'file.ps1'))?.status]).toEqual(['Finished', 'Finished']);
        const removed = await page.evaluate(() => webui.proxy.terminalHelpers.removeFinishedPageScripts());
        expect(removed).toBe(1);
        await expect.poll(async () => Object.keys(await page.evaluate(() => webui.proxy.terminalHelpers.getState().terminals)).sort()).toEqual(['file.ps1', 'live', 'running']);
    });
});

test.describe('runs kept by the backend', () => {
    test('a window that loads while scripts run shows them, with what they wrote', async ({ page }) => {
        await openApp(page, { runs: [
            { terminalId: 'build.ps1', output: ['Compiling\r\n', 'Linking\r\n'] },
            { terminalId: 'test.ps1', output: ['ok\r\n'], code: 1 },
        ] });
        await expect.poll(() => terminal(page, 'build.ps1').then(term => term && [term.status, term.output.join(''), term.seq])).toEqual(['Running', 'Compiling\r\nLinking\r\n', 2]);
        await expect.poll(() => terminal(page, 'test.ps1').then(term => [term.status, term.exitCode])).toEqual(['Finished', 1]);
        // Output keeps arriving after what was loaded, with nothing twice.
        await runOutput(page, { terminalId: 'build.ps1', data: 'Done\r\n' });
        await expect.poll(() => terminal(page, 'build.ps1').then(term => term.output.join(''))).toBe('Compiling\r\nLinking\r\nDone\r\n');
    });
    test('a run started on another screen shows here, and so does its end', async ({ page }) => {
        await openApp(page);
        await page.evaluate(() => window.__backend.handlers.run_script({ terminalId: 'deploy.ps1', scriptContent: 'Deploy', args: [], inSeparateWindow: false }));
        await expect.poll(() => terminal(page, 'deploy.ps1').then(term => term?.status)).toBe('Running');
        await expect.poll(async () => (await terminal(page, 'deploy.ps1'))?.script).toBe('Deploy');
        await runEnds(page, { terminalId: 'deploy.ps1', code: 0 });
        await expect.poll(() => terminal(page, 'deploy.ps1').then(term => term.status)).toBe('Finished');
    });
    test('output this window missed is fetched, in order', async ({ page }) => {
        await openApp(page);
        await run(page, 'a.ps1', 'x', [], false, false);
        await runOutput(page, { terminalId: 'a.ps1', data: 'one ' });
        // A batch the window never heard about.
        await page.evaluate(() => {
            const entry = window.__backend.runs.project('project-id').terminals['a.ps1'];
            entry.output.push([++entry.seq, 'two ']);
        });
        await runOutput(page, { terminalId: 'a.ps1', data: 'three' });
        await expect.poll(() => terminal(page, 'a.ps1').then(term => term.output.join(''))).toBe('one two three');
        // The output has all arrived, so the request that fetched the missed batch has been made.
        const fetched = (await calls(page, 'get_run_output')).map(call => [call.terminalId, call.since]);
        expect(fetched).toContainEqual(['a.ps1', 1]);
    });
    test('clearing or removing a terminal reaches every screen', async ({ page }) => {
        await openApp(page);
        await run(page, 'a.ps1', 'x', [], false, false);
        await runOutput(page, { terminalId: 'a.ps1', data: 'GONE' });
        await expect.poll(() => terminal(page, 'a.ps1').then(term => term.output.join(''))).toBe('GONE');
        // Another screen clears it, then removes it once it ends.
        await page.evaluate(() => window.__backend.handlers.clear_run_output({ terminalId: 'a.ps1' }));
        await expect.poll(() => terminal(page, 'a.ps1').then(term => term.output)).toEqual([]);
        await runEnds(page, { terminalId: 'a.ps1', code: 0 });
        await page.evaluate(() => window.__backend.handlers.remove_run({ terminalId: 'a.ps1' }));
        await expect.poll(() => terminal(page, 'a.ps1')).toBeUndefined();
    });
    test('runAndWait gets the exit code of a script that ends before its start returns', async ({ page }) => {
        await openApp(page);
        await page.evaluate(() => {
            window.__backend.handlers.spawn_script = ({ terminalId }) => {
                window.__backend.runs.end({ terminalId, code: 4 });
                return { message: 'Script started', interactive: true };
            };
        });
        const code = await page.evaluate(() => webui.proxy.terminalHelpers.runAndWait('quick.ps1', 'exit 4'));
        expect(code).toBe(4);
    });
});
