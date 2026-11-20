import { test, expect, openApp, openTool, calls, dialogButton } from '../support/app.mjs';

const now = Math.floor(Date.now() / 1000);
const MB = 1024 * 1024;
const proc = (pid, parent, name, extra = {}) => ({
    pid, parent, name, command: name, exe: `/usr/bin/${name}`, folder: '/home/me', started: now - 600, cpu: 0, memory: 20 * MB,
    status: 'Sleeping', ports: [], terminal: false, orphan: false, taskProxy: false, project: null, ...extra,
});
// An editor's terminal (300) running cargo, and a trunk server cargo left behind, which the system adopted.
const processes = [
    proc(100, null, 'systemd', { command: '/usr/lib/systemd/systemd --user', started: now - 86400 }),
    proc(200, 100, 'zed'),
    proc(300, 200, 'bash'),
    proc(400, 300, 'cargo', { command: 'cargo tauri dev', folder: '/repo', project: 'Repo', terminal: true }),
    proc(500, 100, 'trunk', { command: 'trunk serve --port 1426', folder: '/repo/web', project: 'Repo', terminal: true, orphan: true, ports: [1426], cpu: 0.4, started: now - 7200 }),
    proc(510, 500, 'esbuild', { command: 'esbuild --service', folder: '/repo/web', project: 'Repo', terminal: true }),
    proc(600, 100, 'pipewire', { started: now - 86000 }),
    proc(700, null, 'Task Proxy', { taskProxy: true, memory: 800 * MB, cpu: 12 }),
    proc(710, 700, 'pwsh', { taskProxy: true, command: 'pwsh -File build.ps1', cpu: 6 }),
];

const open = async (page, state = {}) => {
    await openApp(page, { processes, ...state });
    await openTool(page, 'tasks');
    await expect(page.locator('webui-drawer.shared .task-manager tbody')).toBeVisible();
};
const view = page => page.locator('webui-drawer.shared .task-manager');
const shown = page => view(page).locator('tbody tr.tm-row').evaluateAll(rows => rows.map(row => Number(row.dataset.pid)));
const choose = (page, filter) => view(page).locator('.tm-filter').selectOption(filter);
/** How many times processes have been read, after moving the clock on by `ms`. */
const reads = async (page, ms = 0) => {
    if (ms) await page.clock.runFor(ms);
    return (await calls(page, 'list_processes')).length;
};
const row = (page, pid) => view(page).locator(`tr.tm-row[data-pid="${pid}"]`);

test('the Task Manager tab of Tools opens on processes started from a terminal, under what started them', async ({ page }) => {
    await open(page);
    await expect(page.locator('webui-drawer.shared').getByRole('heading', { name: 'Task Manager' })).toHaveCount(1);
    // The shells themselves stay out, and the left behind server shows with what it started below it.
    await expect.poll(() => shown(page)).toEqual([400, 500, 510]);
    await expect(row(page, 510).locator('.tm-name')).toContainText('└ esbuild');
    await expect(row(page, 500).locator('.tm-badge')).toHaveText(['Terminal', 'Orphaned']);
    await expect(row(page, 500).locator('.c-ports')).toHaveText('1426');
    await expect(row(page, 500).locator('.c-project')).toHaveText('Repo');
    await expect(row(page, 500).locator('.c-age')).toHaveText('2h 0m');
    await expect(view(page).locator('.tm-summary')).toHaveText('3 of 9 processes match. CPU 13%, memory 6.0 GB of 16.0 GB.');
    expect((await calls(page, 'list_processes'))[0]).toEqual({ ports: true });
});

test('presets find orphans, servers, project processes, busy and large ones, and everything', async ({ page }) => {
    await open(page);
    const expected = {
        orphan: [500], listening: [500], projects: [400, 500, 510], taskproxy: [700, 710], cpu: [700, 710], memory: [700], all: [100, 200, 300, 400, 500, 510, 600, 700, 710],
    };
    for (const [filter, pids] of Object.entries(expected)) {
        await choose(page, filter);
        await expect.poll(async () => (await shown(page)).slice().sort((a, b) => a - b), filter).toEqual(pids);
    }
    // Busy sorts by CPU, the most first, so the tree is not what orders it.
    await view(page).locator('.tm-tree').click();
    await expect(view(page).locator('.tm-tree')).toHaveAttribute('aria-pressed', 'false');
    await choose(page, 'cpu');
    await expect.poll(() => shown(page)).toEqual([700, 710]);
    // Started in the last hour leaves out trunk, from two hours ago, and the day old processes.
    await choose(page, 'recent');
    await expect.poll(async () => (await shown(page)).slice().sort((a, b) => a - b)).toEqual([200, 300, 400, 510, 700, 710]);
});

test('search narrows any filter by name, command, folder, PID, or port, and columns sort when clicked', async ({ page }) => {
    await open(page);
    await choose(page, 'all');
    await view(page).locator('.tm-search').fill('1426');
    await expect.poll(() => shown(page)).toEqual([500]);
    await view(page).locator('.tm-search').fill('repo serve');
    await expect.poll(() => shown(page)).toEqual([500]);
    await view(page).locator('.tm-search').fill('');
    await view(page).locator('.tm-tree').click();
    await expect(view(page).locator('.tm-tree')).toHaveAttribute('aria-pressed', 'false');
    await view(page).locator('[data-sort="memory"]').click();
    await expect.poll(async () => (await shown(page))[0]).toBe(700);
    await expect(view(page).locator('th[aria-sort="descending"]')).toHaveText('Memory ▾');
    await view(page).locator('[data-sort="memory"]').click();
    await expect.poll(async () => (await shown(page)).at(-1)).toBe(700);
});

test('a preset is copied to a custom filter, whose rules can be changed, saved by name, and kept', async ({ page }) => {
    await open(page);
    await view(page).locator('.tm-rules summary').click();
    // A preset's rules show, but cannot be changed.
    await expect(view(page).locator('.tm-rule select[data-part="field"]')).toBeDisabled();
    await view(page).getByRole('button', { name: 'Copy to Custom' }).click();
    await expect(view(page).locator('.tm-filter')).toHaveValue('custom');
    await view(page).getByRole('button', { name: 'Add a rule' }).click();
    const added = view(page).locator('.tm-rule').nth(1);
    await added.locator('[data-part="field"]').selectOption('port');
    await added.locator('[data-part="op"]').selectOption('=');
    await added.locator('[data-part="value"]').fill('1426');
    await expect.poll(() => shown(page)).toEqual([500]);
    // Either rule, rather than both.
    await view(page).locator('[data-part="match"]').selectOption('any');
    await expect.poll(() => shown(page)).toEqual([400, 500, 510]);
    await view(page).locator('[data-part="name"]').fill('Dev servers');
    await view(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(view(page).locator('.tm-filter')).toHaveValue('saved:Dev servers');
    await expect.poll(() => page.evaluate(() => webui.getData('app-task-manager'))).toMatchObject({
        filter: 'saved:Dev servers',
        saved: [{ name: 'Dev servers', match: 'any', rules: [{ field: 'kind', op: 'is', value: 'terminal' }, { field: 'port', op: '=', value: '1426' }] }],
    });
    await view(page).getByRole('button', { name: 'Delete' }).click();
    await expect(view(page).locator('.tm-filter')).toHaveValue('custom');
    await expect(view(page).locator('.tm-filter option[value="saved:Dev servers"]')).toHaveCount(0);
});

test('saved settings that cannot be read fall back to the defaults', async ({ page }) => {
    await open(page, { appData: { 'app-task-manager': { filter: 7, pace: 3, sort: { key: 'nope' }, custom: { rules: [{ field: 'nope' }, null] }, saved: 'x' } } });
    await expect.poll(() => shown(page)).toEqual([400, 500, 510]);
    await expect(view(page).locator('.tm-pace')).toHaveValue('2000');
});

test('a process shows its details, and stopping it with what it started asks first, then refreshes', async ({ page }) => {
    await open(page);
    await row(page, 500).click();
    const details = view(page).locator('tr.tm-details');
    await expect(details).toContainText('trunk serve --port 1426');
    await expect(details).toContainText('/repo/web (Repo)');
    await expect(details.locator('[data-select="100"]')).toHaveText('systemd (100)');
    await expect(details.locator('[data-select="510"]')).toHaveText('esbuild (510)');
    // Each button says what it does, and what it leaves alone.
    await expect(details.getByRole('button', { name: 'Stop', exact: true })).toHaveAttribute('title', /Asks only this process to stop.*The 1 process under it is not asked/);
    await expect(details.getByRole('button', { name: 'Force close', exact: true })).toHaveAttribute('title', /Ends only this process at once.*the 1 process under it keeps running/);
    await expect(details.getByRole('button', { name: 'Force close with children (1)' })).toHaveAttribute('title', /Ends this process and the 1 process under it/);
    await details.getByRole('button', { name: 'Stop with children (1)' }).click();
    await expect(dialogButton(page, 'Stop')).toBeVisible();
    await expect.poll(() => calls(page, 'stop_process')).toEqual([]);
    await dialogButton(page, 'Stop').click();
    await expect.poll(() => calls(page, 'stop_process')).toEqual([{ pid: 500, started: now - 7200, children: true, force: false }]);
    await expect(view(page).locator('.tm-message')).toHaveText('Asked to stop 500.');
    await expect.poll(() => shown(page)).toEqual([400]);
});

test('force close says what it does, a refusal is shown, and the parent link selects the parent', async ({ page }) => {
    await open(page, { stopErrors: { 400: 'cargo (400) could not be closed.' } });
    await row(page, 400).click();
    await view(page).locator('tr.tm-details').getByRole('button', { name: 'Force close', exact: true }).click();
    await expect(page.getByText('Force close cargo (400)? It ends at once, without saving or cleaning up.')).toBeVisible();
    await dialogButton(page, 'Force Close').click();
    await expect.poll(() => calls(page, 'stop_process')).toEqual([{ pid: 400, started: now - 600, children: false, force: true }]);
    await expect(view(page).locator('.tm-message')).toHaveText('cargo (400) could not be closed.');
    await expect(view(page).locator('.tm-message')).toHaveClass(/error/);
    // bash is not shown by the Terminal preset, so its details show above the list.
    await view(page).locator('tr.tm-details [data-select="300"]').click();
    await expect(view(page).locator('tr.tm-details')).toContainText('bash (300) does not match the filter.');
});

test('it reads processes only while open, at the chosen pace, and lets go once another drawer replaces it', async ({ page }) => {
    // The page's clock is moved on to reach the next refresh, rather than waiting for it.
    await page.clock.install();
    await open(page);
    await view(page).locator('.tm-pace').selectOption('1000');
    const opened = await reads(page);
    await expect.poll(() => reads(page, 1000)).toBeGreaterThan(opened + 2);
    await view(page).locator('.tm-pace').selectOption('0');
    await expect(view(page).locator('.tm-summary')).toContainText('Paused.');
    // Paused, a minute passes with nothing read, so the one read after it is the Refresh button's.
    const paused = await reads(page);
    await page.clock.runFor(60000);
    await view(page).getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(() => reads(page)).toBe(paused + 1);
    await page.clock.runFor(60000);
    await expect.poll(() => reads(page)).toBe(paused + 1);
    await view(page).locator('.tm-pace').selectOption('1000');
    // The open drawer covers the header in a small window, so the other drawer is opened as its button would.
    await page.evaluate(() => document.querySelector('app-plugins-drawer').open());
    await expect(page.locator('webui-drawer.shared app-plugin-manager')).toHaveCount(1);
    await expect.poll(async () => { await page.clock.runFor(1000); return (await calls(page, 'close_task_manager')).length; }).toBe(1);
    const closed = await reads(page);
    await page.clock.runFor(60000);
    await expect.poll(() => reads(page)).toBe(closed);
});

test('a refresh keeps the list where it was scrolled to, and only redraws the rows that changed', async ({ page }) => {
    // The page's clock is moved on to reach the next refresh, rather than waiting for it.
    await page.clock.install();
    const many = Array.from({ length: 120 }, (_, i) => proc(1000 + i, 400, `worker-${i}`, { terminal: true }));
    await open(page, { processes: [...processes, ...many] });
    // Each read reports a different CPU for one process, as a real refresh would.
    await page.evaluate(() => {
        const list = webui.proxy.taskManager.list;
        let reads = 0;
        webui.proxy.taskManager.list = async (...args) => {
            const result = await list(...args);
            reads++;
            result.processes.find(p => p.pid === 1005).cpu = reads;
            return result;
        };
    });
    await view(page).locator('.tm-pace').selectOption('1000');
    const first = view(page).locator('tr.tm-row').first();
    // Scrolled down the list, as a person would, until a row in the middle of it shows and the first row is out of
    // view. Rows sort by name, so worker-50 is in the middle.
    // Found and scrolled in one step in the page, since a redraw between Playwright finding the row and scrolling it
    // would leave it holding a row that is gone.
    await expect.poll(() => view(page).evaluate(list => {
        const target = list.querySelector('tr.tm-row[data-pid="1050"]');
        target?.scrollIntoView({ block: 'center' });
        return !!target;
    })).toBe(true);
    await expect(row(page, 1050)).toBeInViewport();
    await expect(first).not.toBeInViewport();
    const kept = await row(page, 1050).elementHandle();
    const before = await reads(page);
    await expect.poll(() => reads(page, 1000)).toBeGreaterThan(before + 1);
    await expect(row(page, 1005).locator('.c-cpu')).not.toHaveText('0%');
    // After the refreshes the same rows show: the list didn't jump back to the top.
    await expect(row(page, 1050)).toBeInViewport();
    await expect(first).not.toBeInViewport();
    await expect.poll(() => kept.evaluate(el => el.isConnected)).toBe(true);
});

test('processes that start between reads keep the list where it was scrolled to, and a list scrolled to its end stays there', async ({ page }) => {
    // The page's clock is moved on to reach the next refresh, rather than waiting for it.
    await page.clock.install();
    const many = Array.from({ length: 120 }, (_, i) => proc(1000 + i, 400, `worker-${i}`, { terminal: true }));
    await open(page, { processes: [...processes, ...many] });
    // Each of the first reads finds two more processes cargo started.
    await page.evaluate(() => {
        const list = webui.proxy.taskManager.list;
        let reads = 0;
        webui.proxy.taskManager.list = async (...args) => {
            const result = await list(...args);
            reads++;
            const extra = Array.from({ length: Math.min(reads, 6) * 2 }, (_, i) => ({ ...result.processes.find(p => p.pid === 1000), pid: 900 + i, name: `new-${i}` }));
            result.processes.push(...extra);
            return result;
        };
    });
    const wrap = view(page).locator('.tm-table-wrap');
    await view(page).locator('.tm-pace').selectOption('1000');
    const first = view(page).locator('tr.tm-row').first();
    await row(page, 1050).scrollIntoViewIfNeeded();
    await expect(row(page, 1050)).toBeInViewport();
    await expect(first).not.toBeInViewport();
    const before = await reads(page);
    await expect.poll(() => reads(page, 1000)).toBeGreaterThan(before + 1);
    await expect.poll(() => view(page).locator('tr.tm-row[data-pid="902"]').count()).toBe(1);
    // New processes arrived. They sort above worker-50, so they push it down, but the list didn't jump back to the top.
    await expect(first).not.toBeInViewport();
    // Scrolled to the end, the last row shows, and keeps showing as more processes arrive.
    await wrap.evaluate(el => { el.scrollTop = el.scrollHeight; });
    const last = view(page).locator('tr.tm-row').last();
    await expect(last).toBeInViewport();
    const end = await reads(page);
    await expect.poll(() => reads(page, 1000)).toBeGreaterThan(end + 1);
    await expect(view(page).locator('tr.tm-row').last()).toBeInViewport();
});

test('a refresh leaves the header as it is, since WebKit moved the list when the header and summary were rewritten together', async ({ page }) => {
    // The page's clock is moved on to reach the next refresh, rather than waiting for it.
    await page.clock.install();
    await open(page);
    await page.evaluate(() => {
        window.__headerChanges = 0;
        new MutationObserver(records => { window.__headerChanges += records.length; })
            .observe(document.querySelector('webui-drawer.shared .task-manager thead'), { subtree: true, childList: true, characterData: true, attributes: true });
    });
    await view(page).locator('.tm-pace').selectOption('1000');
    const before = await reads(page);
    await expect.poll(() => reads(page, 1000)).toBeGreaterThan(before + 1);
    // Each read is drawn before the next is asked for, so the reads after the first have been drawn.
    await expect.poll(() => page.evaluate(() => window.__headerChanges)).toBe(0);
    // Sorting still changes it.
    await view(page).locator('[data-sort="cpu"]').click();
    await expect(view(page).locator('th[aria-sort="descending"]')).toHaveText('CPU ▾');
});

test('a guide below the list says what each way of stopping does, and stays closed once closed', async ({ page }) => {
    await open(page);
    const guide = view(page).locator('details.tm-guide');
    await expect(guide).toHaveAttribute('open', '');
    await expect(guide.locator('dt')).toHaveText(['Stop', 'Stop with children', 'Force close', 'Force close with children']);
    await expect(guide).toContainText('What it started keeps running.');
    // The drawer stops the default action of clicks, so the guide opens and closes in code.
    await guide.locator('summary').click();
    await expect(guide).not.toHaveAttribute('open');
    await expect.poll(() => page.evaluate(() => webui.getData('app-task-manager')?.guide)).toBe(false);
    await page.evaluate(() => document.querySelector('app-plugins-drawer').open());
    await expect(page.locator('webui-drawer.shared app-plugin-manager')).toHaveCount(1);
    await page.evaluate(() => document.querySelector('app-task-manager').open());
    await expect(view(page).locator('details.tm-guide')).toHaveCount(1);
    await expect(view(page).locator('details.tm-guide')).not.toHaveAttribute('open');
});
