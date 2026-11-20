import { test, expect, openApp, mount, calls, onCommand, runOutput, runEnds } from '../../support/app.mjs';

const VIEW = '<app-terminal-view id="view" style="display:block;width:800px;height:300px"></app-terminal-view>';
/** A view showing terminal a.ps1, which is running in a terminal unless told otherwise. */
async function view(page, terminal = {}, state = {}) {
    await openApp(page, state);
    await page.evaluate(async terminal => {
        const helpers = webui.proxy.terminalHelpers;
        helpers.ensureListeners();
        const { status = 'Running', interactive = true, ...fields } = terminal;
        if (status !== 'Running') {
            helpers.getState().terminals['a.ps1'] = helpers.newTerminal('a.ps1', { status, interactive, ...fields });
            return;
        }
        // A running script is one the backend runs, so its updates and its end reach the view.
        window.__backend.handlers.spawn_script = () => ({ message: 'Script started', interactive });
        await helpers.runScript('a.ps1', 'body', [], false, false);
        Object.assign(helpers.getState().terminals['a.ps1'], fields);
    }, terminal);
    const root = await mount(page, VIEW);
    await page.waitForFunction(() => document.querySelector('#view')?._term);
    await page.evaluate(() => document.querySelector('#view').attach('a.ps1'));
    return root.locator('#view');
}
const write = (page, data, terminalId = 'a.ps1') => runOutput(page, { projectId: 'project-id', terminalId, data });
const screen = page => page.evaluate(() => document.querySelector('#view').getScreenText());
const sent = async page => (await calls(page, 'write_terminal_input')).map(call => call.data).join('');

test('redrawn progress shows only its latest state, as in a terminal', async ({ page }) => {
    await view(page);
    await write(page, '[+1/x0] A.Test.dll (2s)\r\n[+0/x0] B.Test.dll (2s)\r\n');
    // Move up two lines, clear to the end of the screen, and draw the update in place.
    await write(page, '\x1b[2A\x1b[J[+9/x0] A.Test.dll (5s)\r\n[+4/x0] B.Test.dll (5s)\r\n');
    await expect.poll(() => screen(page)).toBe('[+9/x0] A.Test.dll (5s)\n[+4/x0] B.Test.dll (5s)');
});
test('a carriage return progress bar shows only its last value', async ({ page }) => {
    await view(page);
    await write(page, 'Downloading 10%\rDownloading 55%\rDownloading 100%\r\nDone\r\n');
    await expect.poll(() => screen(page)).toBe('Downloading 100%\nDone');
});
test('colors are shown', async ({ page }) => {
    const el = await view(page);
    await write(page, 'plain \x1b[31mred\x1b[0m \x1b[1;32mbold green\x1b[0m\r\n');
    await expect(el.locator('.xterm-rows span.xterm-fg-1')).toHaveText('red');
    // Bold text is drawn in the bright version of its color, as most terminals do.
    await expect(el.locator('.xterm-rows span.xterm-bold')).toHaveText('bold green');
});
test('output kept for a terminal is shown when it is attached, and only once', async ({ page }) => {
    await view(page, { output: ['earlier output\r\n'], outputSize: 16 });
    await expect.poll(() => screen(page)).toBe('earlier output');
    await page.evaluate(() => document.querySelector('#view').attach('a.ps1'));
    // The terminal writes in order, so output shown twice would be above what is written next.
    await write(page, 'next\r\n');
    await expect.poll(() => screen(page)).toBe('earlier output\nnext');
});
test('output for other terminals and projects is left out', async ({ page }) => {
    await view(page);
    await write(page, 'other\r\n', 'b.ps1');
    await runOutput(page, { projectId: 'another-project', terminalId: 'a.ps1', data: 'elsewhere\r\n' });
    await write(page, 'mine\r\n');
    await expect.poll(() => screen(page)).toBe('mine');
});
test('switching terminals shows the other terminal\'s output', async ({ page }) => {
    await view(page, { output: ['from a\r\n'], outputSize: 8 });
    await page.evaluate(() => {
        const helpers = webui.proxy.terminalHelpers;
        helpers.getState().terminals['b.ps1'] = helpers.newTerminal('b.ps1', { output: ['from b\r\n'], outputSize: 8 });
        document.querySelector('#view').attach('b.ps1');
    });
    await expect.poll(() => screen(page)).toBe('from b');
});
test('typing reaches a script running in a terminal', async ({ page }) => {
    const el = await view(page);
    await el.click();
    await page.keyboard.type('yes');
    await page.keyboard.press('Enter');
    await expect.poll(() => sent(page)).toBe('yes\r');
    expect((await calls(page, 'write_terminal_input'))[0].terminalId).toBe('a.ps1');
});
test('Ctrl+C without a selection stops the script, as in a terminal', async ({ page }) => {
    const el = await view(page, { startedAt: Date.now() });
    await el.click();
    await page.keyboard.press('Control+C');
    await expect.poll(() => sent(page)).toBe('\x03');
    // A script stopped this way failed, even when PowerShell exits with 0, so a commit waiting on it does not go ahead.
    await expect.poll(() => page.evaluate(() => webui.proxy.terminalHelpers.getState().terminals['a.ps1'].stopped)).toBe(true);
    await runEnds(page, { projectId: 'project-id', terminalId: 'a.ps1', code: 0 });
    await expect.poll(() => page.evaluate(() => webui.proxy.terminalHelpers.runStatus(webui.proxy.terminalHelpers.getState().terminals['a.ps1'])?.state)).toBe('Failed');
});
test('replayed questions to the terminal are not answered into the script', async ({ page }) => {
    // PowerShell asks where the cursor is while waiting at a prompt. Live, the terminal answers it.
    await view(page, { output: ['Name: \x1b[6n'], outputSize: 11 });
    // The replay has been written, question included, once the view stops replaying.
    await expect.poll(() => screen(page)).toBe('Name: ');
    await expect.poll(() => page.evaluate(() => document.querySelector('#view')._replaying)).toBe(false);
    await expect.poll(() => calls(page, 'write_terminal_input')).toEqual([]);
    await write(page, '\x1b[6n');
    await expect.poll(() => sent(page)).toMatch(/^\x1b\[\d+;\d+R$/);
});
test('typing does not reach a finished script, or one without a terminal', async ({ page }) => {
    const el = await view(page, { status: 'Finished' });
    await el.click();
    await page.keyboard.type('ignored');
    await page.evaluate(() => {
        const term = webui.proxy.terminalHelpers.getState().terminals['a.ps1'];
        term.status = 'Running';
        term.interactive = false;
    });
    await page.keyboard.type('also ignored');
    await expect.poll(() => calls(page, 'write_terminal_input')).toEqual([]);
    // Keys arrive in the order they were typed, so one that is sent shows the earlier ones were dealt with, and dropped.
    await page.evaluate(() => { webui.proxy.terminalHelpers.getState().terminals['a.ps1'].interactive = true; });
    await page.keyboard.type('y');
    await expect.poll(() => sent(page)).toBe('y');
});
test('the view reports its size, and a running script is told when it changes', async ({ page }) => {
    const el = await view(page);
    await expect.poll(() => page.evaluate(() => webui.proxy.terminalHelpers.viewSize?.cols)).toBeGreaterThan(40);
    const before = await page.evaluate(() => webui.proxy.terminalHelpers.viewSize);
    await el.evaluate(node => { node.style.width = '500px'; node.style.height = '200px'; });
    await expect.poll(async () => (await calls(page, 'resize_terminal'))
        .some(resized => resized.terminalId === 'a.ps1' && resized.cols < before.cols && resized.rows < before.rows)).toBe(true);
});
test('a finished script is not told about size changes', async ({ page }) => {
    const el = await view(page, { status: 'Finished' });
    const columns = () => page.evaluate(() => webui.proxy.terminalHelpers.viewSize?.cols);
    await expect.poll(columns).toBeGreaterThan(40);
    const before = await columns();
    await el.evaluate(node => { node.style.width = '500px'; });
    // The view has taken its new size, which is when it would tell a running script.
    await expect.poll(columns).toBeLessThan(before);
    await expect.poll(() => calls(page, 'resize_terminal')).toEqual([]);
});
test('a placeholder shows until there is output', async ({ page }) => {
    const el = await view(page);
    await expect(el.locator('.placeholder')).toBeVisible();
    await write(page, 'hello\r\n');
    await expect(el.locator('.placeholder')).toBeHidden();
});
test('if the terminal cannot be loaded, it says so', async ({ page }) => {
    await page.route('**/vendor/xterm/xterm.js', route => route.abort());
    await openApp(page);
    const root = await mount(page, VIEW);
    await expect(root.locator('#view .placeholder')).toContainText('could not be loaded');
});
