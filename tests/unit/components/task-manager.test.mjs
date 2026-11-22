import { test, expect, openApp, openTool, calls, dialogButton } from '../support/app.mjs';
import { actionNote } from '../../support/wait.mjs';

// The Task Manager's messages (wc/task-manager.js). What needs a real browser, such as its virtual list scrolling,
// is in tests/browser/components/task-manager.spec.mjs.
const now = Math.floor(Date.now() / 1000);
const MB = 1024 * 1024;
const proc = (pid, parent, name, extra = {}) => ({
    pid, parent, name, command: name, exe: `/usr/bin/${name}`, folder: '/home/me', started: now - 600, cpu: 0, memory: 20 * MB,
    status: 'Sleeping', ports: [], terminal: false, orphan: false, taskProxy: false, project: null, ...extra,
});
// A trunk server left behind in a terminal, with esbuild under it.
const processes = [
    proc(100, null, 'systemd', { started: now - 86400 }),
    proc(400, 100, 'cargo', { command: 'cargo tauri dev', folder: '/repo', project: 'Repo', terminal: true }),
    proc(500, 100, 'trunk', { command: 'trunk serve --port 1426', folder: '/repo/web', project: 'Repo', terminal: true, orphan: true, ports: [1426], started: now - 7200 }),
    proc(510, 500, 'esbuild', { command: 'esbuild --service', folder: '/repo/web', project: 'Repo', terminal: true }),
    proc(600, 100, 'pipewire'),
];

const view = page => page.locator('webui-drawer.shared .task-manager');
const message = page => view(page).locator('.tm-message');
const row = (page, pid) => view(page).locator(`tr.tm-row[data-pid="${pid}"]`);
/** Opens the Task Manager, paused, so only the Refresh button reads processes. */
async function open(page) {
    await openApp(page, { processes });
    await openTool(page, 'tasks');
    await expect(row(page, 500)).toHaveCount(1);
    await view(page).locator('.tm-pace').selectOption('0');
    await expect(view(page).locator('.tm-summary')).toContainText('Paused.');
}
/** Makes reading processes fail until the returned function is called. */
async function failReads(page) {
    await page.evaluate(() => {
        window.__list = window.__backend.handlers.list_processes;
        window.__backend.handlers.list_processes = () => { throw 'Processes could not be read.'; };
    });
    return () => page.evaluate(() => { window.__backend.handlers.list_processes = window.__list; });
}
async function stopTrunk(page) {
    await row(page, 500).click();
    await view(page).locator('tr.tm-details').getByRole('button', { name: 'Stop with children (1)' }).click();
    await dialogButton(page, 'Stop').click();
    await expect(message(page)).toHaveText('Asked to stop 500.');
}

test('a read that fails says why, until a read works again', async ({ page }) => {
    await open(page);
    const readsAgain = await failReads(page);
    await view(page).getByRole('button', { name: 'Refresh' }).click();
    await expect(message(page)).toHaveText('Processes could not be read.');
    await expect(message(page)).toHaveAttribute('variant', 'danger');
    await readsAgain();
    const read = (await calls(page, 'list_processes')).length;
    await view(page).getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(async () => (await calls(page, 'list_processes')).length).toBe(read + 1);
    await expect(message(page)).not.toHaveAttribute('show');
});

test('what a stop said stays when the read after it works, though the read before it failed', async ({ page }) => {
    await open(page);
    const readsAgain = await failReads(page);
    await view(page).getByRole('button', { name: 'Refresh' }).click();
    await expect(message(page)).toHaveText('Processes could not be read.');
    await readsAgain();
    await stopTrunk(page);
    // The read after the stop has worked once the stopped process is gone.
    await expect(row(page, 500)).toHaveCount(0);
    await expect(message(page)).toHaveText('Asked to stop 500.');
    await expect(message(page)).toHaveAttribute('show');
    await expect(message(page)).toHaveAttribute('variant', 'success');
});

test('what a stop said goes with the next thing done, such as Refresh, another filter, or choosing a process', async ({ page }) => {
    await open(page);
    const stop = async pid => {
        await row(page, pid).click();
        await view(page).locator('tr.tm-details').getByRole('button', { name: 'Stop', exact: true }).click();
        await dialogButton(page, 'Stop').click();
        await expect(message(page)).toHaveText(`Asked to stop ${pid}.`);
        await expect(row(page, pid)).toHaveCount(0);
    };
    await stopTrunk(page);
    await expect(row(page, 500)).toHaveCount(0);
    await view(page).getByRole('button', { name: 'Refresh' }).click();
    await expect(message(page)).not.toHaveAttribute('show');
    await stop(400);
    await view(page).locator('.tm-filter').selectOption('all');
    await expect(message(page)).not.toHaveAttribute('show');
    await stop(600);
    await row(page, 100).click();
    await expect(view(page).locator('tr.tm-details')).toHaveCount(1);
    await expect(message(page)).not.toHaveAttribute('show');
});

test('why a stop failed goes with the next thing done, but a read that failed stays until a read works', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { window.__backend.handlers.stop_process = () => { throw 'It could not be stopped.'; }; });
    await row(page, 500).click();
    await view(page).locator('tr.tm-details').getByRole('button', { name: 'Stop', exact: true }).click();
    await dialogButton(page, 'Stop').click();
    await expect(message(page)).toHaveText('It could not be stopped.');
    await expect(message(page)).toHaveAttribute('variant', 'danger');
    await row(page, 400).click();
    await expect(view(page).locator('tr.tm-details')).toHaveCount(1);
    await expect(message(page)).not.toHaveAttribute('show');
    // A list that couldn't be read is not about an action, so choosing a process keeps it.
    await failReads(page);
    await view(page).getByRole('button', { name: 'Refresh' }).click();
    await expect(message(page)).toHaveText('Processes could not be read.');
    await row(page, 510).click();
    await expect(view(page).locator('tr.tm-details[data-for="510"]')).toHaveCount(1);
    await expect(message(page)).toHaveText('Processes could not be read.');
    await expect(message(page)).toHaveAttribute('show');
});

test('a filter saved with no name says so by Save, as a warning, and saving it with a name says it was saved', async ({ page }) => {
    await open(page);
    await view(page).locator('.tm-rules summary').click();
    await view(page).getByRole('button', { name: 'Copy to Custom' }).click();
    await expect(view(page).locator('.tm-filter')).toHaveValue('custom');
    const save = view(page).getByRole('button', { name: 'Save', exact: true });
    await save.click();
    const why = actionNote(view(page).locator('.tm-rules-body'), 'Give the filter a name to save it.');
    await expect(why).toHaveCount(1);
    await expect(why).toHaveAttribute('variant', 'warning');
    await expect(message(page)).not.toHaveAttribute('show');
    await view(page).locator('[data-part="name"]').fill('Mine');
    await save.click();
    await expect(view(page).locator('.tm-filter')).toHaveValue('saved:Mine');
    await expect(message(page)).toHaveText('Saved the filter Mine.');
    await expect(why).toHaveCount(0);
    // Changing the rules after is another action, so what saving said goes.
    await view(page).getByRole('button', { name: 'Add a rule' }).click();
    await expect(message(page)).not.toHaveAttribute('show');
});
