import { test, expect, openApp, calls, onCommand, runOutput, runEnds, emit } from '../support/app.mjs';

const open = async (page, state = {}) => {
    await openApp(page, state);
    await page.locator('app-terminals').click();
};
const ready = async page => {
    await page.locator('#term-content-wrapper').waitFor();
    await page.locator('#term-console').waitFor();
    await settled(page);
};
/**
 * The Terminal Manager has finished showing a terminal: its list is up to date and selects the terminal shown, and
 * the script box and the terminal view are on it too. Switching terminals and refreshing the list take several
 * steps, so tests wait for this before acting on what the manager shows.
 */
const settled = page => page.waitForFunction(() => {
    const el = document.querySelector('app-terminals');
    const runner = document.querySelector('#term-runner');
    const view = document.querySelector('#term-console');
    const list = document.querySelector('#term-dropdown');
    if (!runner?.setScript || !view?._term || !list || el._activeConsole !== view) return false;
    if (el._isRefreshing || el._refreshAgain || el._listedFilter !== el.filter()) return false;
    const shown = el._none ? null : el.viewState().activeId;
    if (runner._fileName !== (shown ?? '') || (view._terminalId ?? null) !== shown) return false;
    // The list selects the terminal shown, or is off with nothing to list. The Live view has no list.
    if (el.filter() === 'Live') return shown === 'live';
    if (list.hasAttribute('disabled')) return el._none === true;
    return list.value === webui.proxy.terminalHelpers.terminalValue(shown, el._viewProject);
});
// What the terminal shows, read from its buffer rather than the screen, so it includes scrolled out lines.
const screen = page => page.evaluate(() => document.querySelector('#term-console').getScreenText());
const output = (page, terminalId, data) => runOutput(page, { projectId: 'project-id', terminalId, data });
const placeholder = page => page.locator('#term-console .placeholder');
const start = async (page, id) => {
    await page.evaluate(id => webui.proxy.terminalHelpers.runScript(id, 'body', [], false, false), id);
    await page.evaluate(id => document.querySelector('app-terminals').switchTerminal(id), id);
    await settled(page);
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
    // Output is handled in the order it arrives, so once a.ps1's shows, b.ps1's has been dealt with.
    await output(page, 'a.ps1', 'FOR A\r\n');
    await expect.poll(() => screen(page)).toBe('FOR A');
    await page.evaluate(() => document.querySelector('app-terminals').switchTerminal('b.ps1'));
    await expect.poll(() => screen(page)).toContain('FOR B');
});
test('stop asks the backend to stop the script, which then shows it failed', async ({ page }) => {
    // Sending Ctrl+C, and forcing a script that ignores it, happen in Rust (stop_sequence in services/runs.rs).
    await open(page);
    await ready(page);
    await start(page, 'a.ps1');
    await page.locator('#btn-kill').click();
    await expect.poll(() => calls(page, 'stop_run')).toEqual([{ terminalId: 'a.ps1' }]);
    await expect.poll(() => page.evaluate(() => webui.proxy.terminalHelpers.getState().terminals['a.ps1'].stopped)).toBe(true);
    await runEnds(page, { terminalId: 'a.ps1', code: 0 });
    await expect(page.locator('#term-status')).toHaveText(/^Failed /);
    await expect.poll(() => page.locator('#btn-kill').evaluate(el => el.disabled)).toBeTruthy();
});
test('kill all also forgets the queue', async ({ page }) => {
    await open(page);
    await ready(page);
    await page.evaluate(() => webui.proxy.terminalHelpers.runScript('a.ps1', 'x', [], false, true));
    await page.evaluate(() => webui.proxy.terminalHelpers.runScript('b.ps1', 'x', [], false, true));
    await page.locator('#btn-kill-all').click();
    await expect.poll(async () => (await calls(page, 'kill_all_scripts')).length).toBe(1);
    await runEnds(page, { terminalId: 'a.ps1', code: null });
    // The app has heard that a.ps1 ended, which is when the next queued script would have started.
    await expect.poll(() => page.evaluate(() => webui.proxy.terminalHelpers.getState().terminals['a.ps1'].status)).toBe('Finished');
    await expect.poll(async () => (await calls(page, 'spawn_script')).map(call => call.terminalId)).toEqual(['a.ps1']);
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
    await expect.poll(() => page.evaluate(() => window.__copied[0])).toBe(lines.join('\n'));
    await expect.poll(() => page.evaluate(() => document.querySelector('#term-console').getSelectedText())).toContain('line 200');
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
    await expect.poll(() => page.evaluate(() => window.__copied[0])).toBe('Build started\n    Compiling\nDone');
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
    await expect.poll(() => page.evaluate(() => window.__copied)).toEqual([]);
    // With output, the same button copies it, and that is the only copy made.
    await output(page, 'a.ps1', 'now there is output\r\n');
    await expect.poll(() => screen(page)).toBe('now there is output');
    await page.locator('#btn-select-all').click();
    await expect.poll(() => page.evaluate(() => window.__copied)).toEqual(['now there is output']);
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
    await expect.poll(() => page.evaluate(() => document.querySelector('#term-dropdown')._options.map(option => option.display).join('\n'))).toContain('a.ps1 (Finished)');
});
test('finishing a script updates the kill button', async ({ page }) => {
    await open(page);
    await ready(page);
    await start(page, 'a.ps1');
    const disabled = () => page.locator('#btn-kill').evaluate(el => el.disabled);
    await expect.poll(disabled).toBeFalsy();
    await runEnds(page, { projectId: 'project-id', terminalId: 'a.ps1', code: 0 });
    await expect.poll(disabled).toBeTruthy();
});
test('markup in a script name is shown as text', async ({ page }) => {
    await open(page, { scripts: ['<img src=q onerror="window.__xss=1">.ps1'], appData: { 'app-terminals-filter': 'Saved' } });
    await ready(page);
    // The list shows the name as it was written.
    await expect.poll(() => page.evaluate(() => document.querySelector('#term-dropdown')._options.map(option => option.display).join('\n'))).toContain('<img src=q onerror="window.__xss=1">.ps1');
    await expect(page.locator('#term-dropdown img')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__xss)).toBeUndefined();
});

test.describe('page scripts', () => {
    const runPageScript = async (page, id) => {
        await page.evaluate(id => webui.proxy.terminalHelpers.runScript(id, "$secret = 'REALSECRET'", [], false, false, true, "$secret = 'REA***RET'"), id);
        await page.evaluate(id => document.querySelector('app-terminals').switchTerminal(id), id);
        await settled(page);
    };
    test('show masked values and cannot be run or saved from here', async ({ page }) => {
        await open(page);
        await ready(page);
        await runPageScript(page, 'p1');
        await expect(page.locator('#term-runner webui-input-message textarea')).toHaveValue("$secret = 'REA***RET'");
        await expect.poll(() => page.evaluate(() => document.body.innerHTML.includes('REALSECRET'))).toBe(false);
        await expect(page.locator('#term-runner webui-button[label="Run"]')).toBeHidden();
        await expect(page.locator('#term-runner webui-button[label="Save"]')).toBeHidden();
        await expect(page.locator('#term-runner .read-only-note')).toBeVisible();
        // The click is refused as it is handled, before anything is sent, so there is nothing later to wait for.
        await page.locator('#term-runner').evaluate(el => el._btnRun.click());
        await expect.poll(() => calls(page, 'spawn_script')).toHaveLength(1);
    });
    test('file scripts can still be run from here', async ({ page }) => {
        await open(page);
        await ready(page);
        await runPageScript(page, 'p1');
        await start(page, 'a.ps1');
        await expect(page.locator('#term-runner webui-button[label="Run"]')).toBeVisible();
        await expect(page.locator('#term-runner .read-only-note')).toBeHidden();
    });
    test('a finished page script can be removed from the list', async ({ page }) => {
        await open(page);
        await ready(page);
        await runPageScript(page, 'p1');
        await expect.poll(() => page.locator('#btn-remove-script').evaluate(el => el.disabled)).toBeTruthy();
        await runEnds(page, { projectId: 'project-id', terminalId: 'p1', code: 0 });
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
            await runEnds(page, { projectId: 'project-id', terminalId: id, code: 0 });
        }
        await expect(page.locator('#btn-remove-finished')).toBeVisible();
        await page.locator('#btn-remove-finished').click();
        await expect.poll(() => page.evaluate(() => Object.keys(webui.proxy.terminalHelpers.getState().terminals))).toEqual(['live']);
        await expect(page.locator('#btn-remove-finished')).toBeHidden();
    });
});
test('terminal updates that arrive before the app has set up its backend are ignored', async ({ page }) => {
    await openApp(page);
    const error = await page.evaluate(() => {
        const el = document.querySelector('app-terminals');
        const proxy = webui.proxy;
        webui.proxy = undefined;
        try {
            el.onTerminalRefresh();
            el.onTerminalCleared({ terminalId: 'x', tick: 1 });
            return null;
        } catch (err) {
            return `${err}`;
        } finally {
            webui.proxy = proxy;
        }
    });
    expect(error).toBeNull();
});

test.describe('run status', () => {
    const status = page => page.locator('#term-status');
    const finish = (page, terminalId, code) => runEnds(page, { projectId: 'project-id', terminalId, code });

    test('a running script shows Running with a time that keeps counting', async ({ page }) => {
        await open(page);
        await ready(page);
        await start(page, 'a.ps1');
        await expect(status(page)).toHaveText(/^Running \d\d:\d\d:\d\d\.\d{3}$/);
        await expect(status(page)).toHaveAttribute('data-state', 'running');
        const first = await status(page).textContent();
        await expect(status(page)).not.toHaveText(first);
        // The label still starts with Terminal: in its own color.
        await expect(status(page).locator('..')).toHaveText(/^Terminal: Running /);
    });
    test('a script that exits cleanly shows Finished, and its time stops', async ({ page }) => {
        // The page's clock is moved on, to show the time no longer counts.
        await page.clock.install();
        await open(page);
        await ready(page);
        await start(page, 'a.ps1');
        await finish(page, 'a.ps1', 0);
        await expect(status(page)).toHaveText(/^Finished \d\d:\d\d:\d\d\.\d{3}$/);
        await expect(status(page)).toHaveAttribute('data-state', 'finished');
        const text = await status(page).textContent();
        await page.clock.runFor(5000);
        await expect(status(page)).toHaveText(text);
    });
    test('a script that exits with an error, or is stopped, shows Failed', async ({ page }) => {
        await open(page);
        await ready(page);
        await start(page, 'a.ps1');
        await finish(page, 'a.ps1', 2);
        await expect(status(page)).toHaveText(/^Failed /);
        await expect(status(page)).toHaveAttribute('data-state', 'failed');
        // A script that ends from Ctrl+C with exit code 0 was still stopped.
        await start(page, 'b.ps1');
        await expect(status(page)).toHaveText(/^Running /);
        await page.locator('#btn-kill').click();
        await expect.poll(() => calls(page, 'stop_run')).toEqual([{ terminalId: 'b.ps1' }]);
        await expect.poll(() => page.evaluate(() => webui.proxy.terminalHelpers.getState().terminals['b.ps1'].stopped)).toBe(true);
        await finish(page, 'b.ps1', 0);
        await expect(status(page)).toHaveText(/^Failed /);
    });
    test('switching terminals shows each one\'s own status, and none for one that has not run', async ({ page }) => {
        await open(page);
        await ready(page);
        await start(page, 'a.ps1');
        await finish(page, 'a.ps1', 0);
        await expect(status(page)).toHaveText(/^Finished /);
        await page.evaluate(() => document.querySelector('app-terminals').switchTerminal('live'));
        await expect(status(page)).toHaveText('');
        await page.evaluate(() => document.querySelector('app-terminals').switchTerminal('a.ps1'));
        await expect(status(page)).toHaveText(/^Finished /);
    });
    test('the time is shown as hours, minutes, seconds, and milliseconds', async ({ page }) => {
        await openApp(page);
        const format = ms => page.evaluate(ms => webui.proxy.terminalHelpers.formatElapsed(ms), ms);
        await expect.poll(() => format(0)).toBe('00:00:00.000');
        await expect.poll(() => format(85545473)).toBe('23:45:45.473');
        await expect.poll(() => format(((1 * 60 + 23) * 60 + 45) * 1000 + 473)).toBe('01:23:45.473');
        await expect.poll(() => format(360000000)).toBe('100:00:00.000');
    });
    test('a run whose exit code is unknown, such as in its own window, counts as finished', async ({ page }) => {
        await openApp(page);
        const state = (term) => page.evaluate(term => webui.proxy.terminalHelpers.runStatus(term, 5000)?.state ?? null, term);
        await expect.poll(() => state({ status: 'Ready' })).toBe(null);
        await expect.poll(() => state({ status: 'Finished', startedAt: 1000, endedAt: 2000, exitCode: null })).toBe('Finished');
        await expect.poll(() => state({ status: 'Finished', startedAt: 1000, endedAt: 2000, exitCode: null, stopped: true })).toBe('Failed');
        await expect.poll(() => page.evaluate(() => webui.proxy.terminalHelpers.runStatus({ status: 'Running', startedAt: 1000 }, 5000).elapsed)).toBe(4000);
    });
});

test.describe('script filter', () => {
    const filter = page => page.locator('webui-drawer.shared [slot="header"] webui-switch');
    const choose = (page, name) => filter(page).locator('button', { hasText: new RegExp(`^${name}$`) }).click();
    // The names of the scripts the list offers, as the earlier status test reads them.
    const listed = page => page.locator('#term-dropdown').evaluate(el => el._options.map(option => option.display));

    const dropdown = page => page.locator('#term-dropdown');
    const shown = page => page.evaluate(() => webui.proxy.terminalHelpers.getState().activeId);

    test('sits beside the title, and lists what each choice asks for', async ({ page }) => {
        await open(page, { scripts: ['build.ps1', 'test.ps1'] });
        await ready(page);
        await expect(filter(page).locator('button')).toHaveText(['Live', 'Saved', 'Page', 'Running', 'All Running', 'Finished']);
        await choose(page, 'Saved');
        await expect.poll(() => listed(page)).toEqual(['build.ps1 (Ready)', 'test.ps1 (Ready)']);
        await start(page, 'test.ps1');
        await choose(page, 'Running');
        await expect.poll(() => listed(page)).toEqual(['test.ps1 (Running)']);
        await expect.poll(() => page.evaluate(() => webui.getData('app-terminals-filter'))).toBe('Running');
    });

    test('Live shows the live terminal, with the list cleared and turned off', async ({ page }) => {
        await open(page, { scripts: ['build.ps1'] });
        await ready(page);
        await expect(filter(page).locator('button[aria-checked="true"]').first()).toHaveText('Live');
        await expect.poll(() => listed(page)).toEqual([]);
        await expect(dropdown(page)).toHaveAttribute('disabled');
        await expect(dropdown(page).getByRole('button', { name: 'Script' })).toBeDisabled();
        await expect.poll(() => shown(page)).toBe('live');
        await choose(page, 'Saved');
        await expect(dropdown(page)).not.toHaveAttribute('disabled');
        await choose(page, 'Live');
        await expect.poll(() => shown(page)).toBe('live');
        await expect.poll(() => listed(page)).toEqual([]);
    });

    test('a script that is shown is listed only where it belongs, not under every choice', async ({ page }) => {
        await open(page, { scripts: ['build.ps1'] });
        await ready(page);
        await page.evaluate(() => webui.proxy.terminalHelpers.runScript('page-run', 'body', [], false, false, true));
        await page.evaluate(() => document.querySelector('app-terminals').switchTerminal('page-run'));
        await expect.poll(() => listed(page)).toEqual(['page-run (Running)']);
        await choose(page, 'Saved');
        await expect.poll(() => listed(page)).toEqual(['build.ps1 (Ready)']);
        await expect.poll(() => shown(page)).toBe('build.ps1');
        await choose(page, 'All Running');
        await expect.poll(() => listed(page)).toEqual(['page-run (Running)']);
        await runEnds(page, { projectId: 'project-id', terminalId: 'page-run', code: 0 });
        // Finished while shown, it stays until the choice changes.
        await expect.poll(() => listed(page)).toEqual(['page-run (Finished)']);
        await settled(page);
        await expect.poll(() => listed(page)).toEqual(['page-run (Finished)']);
        await choose(page, 'Running');
        await expect.poll(() => listed(page)).toEqual(['None']);
        await choose(page, 'Page');
        await expect.poll(() => listed(page)).toEqual(['page-run (Finished)']);
    });

    test('changing choices shows the first script listed when the one shown is not', async ({ page }) => {
        await open(page, { scripts: ['build.ps1', 'test.ps1'] });
        await ready(page);
        await choose(page, 'Saved');
        await expect.poll(() => shown(page)).toBe('build.ps1');
        await expect(dropdown(page)).toHaveJSProperty('value', 'build.ps1');
        await page.evaluate(() => document.querySelector('app-terminals').switchTerminal('test.ps1'));
        await expect.poll(() => dropdown(page).evaluate(el => el.value)).toBe('test.ps1');
        // Still listed, so it stays.
        await choose(page, 'Saved');
        await settled(page);
        await expect.poll(() => shown(page)).toBe('test.ps1');
        await expect(dropdown(page)).toHaveJSProperty('value', 'test.ps1');
    });

    test('with nothing to list, the list says None and is turned off, and the terminal is empty', async ({ page }) => {
        await open(page, { scripts: ['build.ps1'] });
        await ready(page);
        await choose(page, 'Running');
        await expect.poll(() => listed(page)).toEqual(['None']);
        await expect(dropdown(page)).toHaveAttribute('disabled');
        await expect(page.locator('#term-status')).toHaveText('');
        await expect(page.locator('#btn-kill')).toHaveJSProperty('disabled', true);
        await expect(placeholder(page)).toBeVisible();
        await page.locator('#btn-clear').click();
        await expect.poll(() => calls(page, 'stop_run')).toEqual([]);
    });

    test('a run that opens the Terminal Manager shows it under Running, unless All Running is chosen', async ({ page }) => {
        await openApp(page, { appData: { 'app-terminals-filter': 'Saved' } });
        await page.evaluate(async () => {
            await webui.proxy.terminalHelpers.runScript('page-run', 'body', [], false, false, true);
            document.querySelector('app-terminals').openDrawer({ run: true });
        });
        await ready(page);
        await expect.poll(() => page.evaluate(() => webui.getData('app-terminals-filter'))).toBe('Running');
        await expect.poll(() => listed(page)).toEqual(['page-run (Running)']);
        await choose(page, 'All Running');
        await settled(page);
        // Opening it while it is open closes it and builds it again, so wait for the new one.
        await page.evaluate(() => {
            document.querySelector('#term-console').dataset.before = 'true';
            document.querySelector('app-terminals').openDrawer({ run: true });
        });
        await expect(page.locator('#term-console[data-before]')).toHaveCount(0);
        await ready(page);
        await expect(page.locator('webui-drawer.shared')).toHaveClass(/open/);
        await expect.poll(() => page.evaluate(() => webui.getData('app-terminals-filter'))).toBe('All Running');
        await expect(filter(page).locator('button[aria-checked="true"]').first()).toHaveText('All Running');
    });

    test('Kill All sits beside the list, and Script Content shares a row with its buttons', async ({ page }) => {
        await open(page);
        await ready(page);
        // Each pair shares one row, after the item it belongs with. How the row looks is checked by eye.
        const rowOf = selector => page.locator(selector).locator('xpath=ancestor::webui-flex[1]');
        await expect(rowOf('#term-dropdown').locator('#btn-kill-all')).toHaveCount(1);
        const label = page.locator('#term-runner .runner-label');
        await expect(label).toHaveText('Script Content:');
        await expect(rowOf('#term-runner .runner-label').locator('webui-button[label="Run"]')).toHaveCount(1);
    });

    test("All Running shows another project's running script, and Stop reaches it there", async ({ page }) => {
        await open(page, { appData: { 'app-terminals-filter': 'All Running' } });
        await ready(page);
        await page.evaluate(() => {
            const helpers = webui.proxy.terminalHelpers;
            helpers.getState('other-project').terminals['deploy.ps1'] = helpers.newTerminal('deploy.ps1', {
                status: 'Running', interactive: false, projectId: 'other-project', projectName: 'Storefront', startedAt: Date.now(),
                script: 'Deploy-Site', output: ['Deploying from the other project\r\n'],
            });
            webui.setData('app-terminal-refresh', Date.now());
        });
        await expect.poll(() => listed(page)).toContain('Storefront: deploy.ps1 (Running)');
        await page.locator('#term-dropdown').evaluate(el => {
            el.value = 'other-project::deploy.ps1';
            el.dispatchEvent(new Event('change'));
        });
        await expect.poll(() => screen(page)).toContain('Deploying from the other project');
        // Output for that script, from that project, keeps arriving.
        await runOutput(page, { projectId: 'other-project', terminalId: 'deploy.ps1', data: 'Done\r\n' });
        await expect.poll(() => screen(page)).toContain('Done');
        await expect(page.locator('#term-status')).toContainText('Running');
        await page.locator('#btn-kill').click();
        await expect.poll(() => calls(page, 'stop_run')).toEqual([{ terminalId: 'deploy.ps1', projectId: 'other-project' }]);
    });

    test('Stop, Select All, and Clear Output sit beside the terminal status', async ({ page }) => {
        await open(page);
        await ready(page);
        const row = page.locator('#term-status').locator('xpath=ancestor::webui-flex[1]');
        for (const id of ['#btn-kill', '#btn-select-all', '#btn-clear']) await expect(row.locator(id)).toHaveCount(1);
    });
});
test('the Terminals button counts the scripts running in every project', async ({ page }) => {
    await openApp(page);
    const count = page.locator('app-terminals webui-icon');
    await expect(count).not.toHaveAttribute('count', /\d/);
    await page.evaluate(() => webui.proxy.terminalHelpers.runScript('a.ps1', 'body', [], false, false));
    await expect(count).toHaveAttribute('count', '1');
    await emit(page, 'run-changed', {
        projectId: 'other-project', terminalId: 'deploy.ps1',
        run: { id: 'deploy.ps1', projectId: 'other-project', projectName: 'Storefront', status: 'Running', run: 900, rev: 1, cleared: 0, startedAt: Date.now() },
    });
    await expect(count).toHaveAttribute('count', '2');
    await runEnds(page, { projectId: 'project-id', terminalId: 'a.ps1', code: 0 });
    await expect(count).toHaveAttribute('count', '1');
    await emit(page, 'run-changed', {
        projectId: 'other-project', terminalId: 'deploy.ps1',
        run: { id: 'deploy.ps1', projectId: 'other-project', projectName: 'Storefront', status: 'Finished', exitCode: 0, run: 900, rev: 2, cleared: 0, startedAt: Date.now(), endedAt: Date.now() },
    });
    await expect(count).not.toHaveAttribute('count', /\d/);
});
