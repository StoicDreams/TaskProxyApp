import { test, expect, openApp, calls, dialogButton } from '../support/app.mjs';

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
    await page.getByRole('button', { name: 'Task Manager', exact: true }).click();
    await expect(page.locator('webui-drawer.shared .task-manager tbody')).toBeVisible();
};
const view = page => page.locator('webui-drawer.shared .task-manager');
const shown = page => view(page).locator('tbody tr.tm-row').evaluateAll(rows => rows.map(row => Number(row.dataset.pid)));
const choose = (page, filter) => view(page).locator('.tm-filter').selectOption(filter);
const row = (page, pid) => view(page).locator(`tr.tm-row[data-pid="${pid}"]`);

test('the button sits between Terminals and the alerts, and opens on processes started from a terminal, under what started them', async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => {
        const button = document.querySelector('app-task-manager');
        return [button.previousElementSibling.localName, button.nextElementSibling.localName];
    })).toEqual(['app-terminals', 'webui-alerts']);
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
    await details.getByRole('button', { name: 'Stop with 1 started by it' }).click();
    await expect(dialogButton(page, 'Stop')).toBeVisible();
    expect(await calls(page, 'stop_process')).toEqual([]);
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
    await open(page);
    await view(page).locator('.tm-pace').selectOption('1000');
    await expect.poll(async () => (await calls(page, 'list_processes')).length, { timeout: 5000 }).toBeGreaterThan(2);
    await view(page).locator('.tm-pace').selectOption('0');
    await expect(view(page).locator('.tm-summary')).toContainText('Paused.');
    const paused = (await calls(page, 'list_processes')).length;
    await page.waitForTimeout(1500);
    expect((await calls(page, 'list_processes')).length).toBe(paused);
    await view(page).getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(async () => (await calls(page, 'list_processes')).length).toBe(paused + 1);
    await view(page).locator('.tm-pace').selectOption('1000');
    // The open drawer covers the header in a small window, so the other drawer is opened as its button would.
    await page.evaluate(() => document.querySelector('app-plugins-drawer').open());
    await expect(page.locator('webui-drawer.shared app-plugin-manager')).toHaveCount(1);
    await expect.poll(async () => (await calls(page, 'close_task_manager')).length, { timeout: 5000 }).toBe(1);
    const closed = (await calls(page, 'list_processes')).length;
    await page.waitForTimeout(1500);
    expect((await calls(page, 'list_processes')).length).toBe(closed);
});

test('a refresh keeps the list where it was scrolled to, and only redraws the rows that changed', async ({ page }) => {
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
    const wrap = view(page).locator('.tm-table-wrap');
    await expect.poll(() => wrap.evaluate(el => el.scrollHeight > el.clientHeight + 400)).toBe(true);
    await wrap.evaluate(el => { el.scrollTop = 400; });
    const kept = await row(page, 1100).elementHandle();
    const reads = (await calls(page, 'list_processes')).length;
    await expect.poll(async () => (await calls(page, 'list_processes')).length, { timeout: 5000 }).toBeGreaterThan(reads + 1);
    await expect(row(page, 1005).locator('.c-cpu')).not.toHaveText('0%');
    expect(await wrap.evaluate(el => el.scrollTop)).toBe(400);
    expect(await kept.evaluate(el => el.isConnected)).toBe(true);
});
