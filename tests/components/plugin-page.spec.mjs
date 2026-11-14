import { test, expect, openApp, calls, dialogButton, onCommand } from '../support/app.mjs';

const manifest = {
    id: 'test', name: 'Test Plugin', version: '0.1.0', apiVersion: 1, icon: 'flask',
    permissions: { hosts: ['*.example.com'], variables: [], git: ['createBranch'] },
    pages: [{ id: 'home', name: 'Test Home' }, { id: 'item', name: 'Item', hidden: true }],
};
const plugins = [{ id: 'test', version: '0.1.0', enabled: true, signed: true, manifest }];
const text = value => ({ type: 'text', text: value });
const action = (id, label, extra = {}) => ({ id, label, ...extra });

/** Opens a plugin page with the given content, and waits for it to draw. */
async function openPlugin(page, node, state = {}, path = '/plugin/test/home') {
    // Opening a project returns to its current page, so that is the plugin page.
    await openApp(page, { plugins, currentPage: path, ...state, pluginPages: { 'test/home': node, ...(state.pluginPages || {}) } }, path);
    await expect(page.locator('app-plugin-page')).toBeVisible();
    await expect(page.locator('app-plugin-page')).not.toContainText('Loading');
    await spyOnAlerts(page);
}

/** Records the messages shown with webui.alert, which alerts() returns. */
function spyOnAlerts(page) {
    return page.evaluate(() => {
        window.__alerts = [];
        const original = webui.alert;
        webui.alert = function (...args) { window.__alerts.push(`${args[0]}`); return original.apply(this, args); };
    });
}
const alerts = page => page.evaluate(() => window.__alerts);

test('each kind of node is drawn, and plugin text is never markup', async ({ page }) => {
    await openPlugin(page, {
        type: 'stack', children: [
            { type: 'heading', text: 'Issues <b>bold</b>', level: 2 },
            { type: 'text', text: '<img src=x onerror="window.__hacked=1">', muted: true },
            { type: 'markdown', text: '**Strong** <script>window.__hacked = 2</script><a href="javascript:alert(1)">bad</a>' },
            { type: 'badge', text: 'In Progress', theme: 'info' },
            { type: 'properties', items: [{ label: 'Assignee', value: text('Sam Lee') }] },
            { type: 'notice', text: 'Heads up', theme: 'warning' },
            { type: 'empty', text: 'Nothing here' },
            { type: 'somethingNewer' },
        ],
    });
    const view = page.locator('app-plugin-page');
    await expect(view.locator('h3')).toHaveText('Issues <b>bold</b>');
    await expect(view.getByText('<img src=x onerror="window.__hacked=1">')).toBeVisible();
    await expect(view.locator('.plugin-markdown strong')).toHaveText('Strong');
    await expect(view.locator('.plugin-markdown script')).toHaveCount(0);
    await expect(view.locator('.plugin-markdown a')).not.toHaveAttribute('href', /javascript/);
    await expect(view.locator('.plugin-badge[data-theme="info"]')).toHaveText('In Progress');
    await expect(view.locator('dl.plugin-properties dt')).toHaveText('Assignee');
    await expect(view.locator('dl.plugin-properties dd')).toHaveText('Sam Lee');
    await expect(view.locator('webui-alert')).toContainText('Heads up');
    await expect(view.locator('.plugin-empty')).toHaveText('Nothing here');
    await expect(view).toContainText('cannot show "somethingNewer"');
    expect(await page.evaluate(() => window.__hacked)).toBeUndefined();
});

test('the page is titled from the manifest, and gets the address params', async ({ page }) => {
    await openPlugin(page, text('Item page'), { pluginPages: { 'test/item': text('Item page') } }, '/plugin/test/item?key=P-1&view=team');
    await expect(page.locator('header h1')).toHaveText('Test Plugin');
    await expect(page.locator('header h2')).toHaveText('Item');
    expect((await calls(page, 'plugin_render')).at(-1)).toEqual({ id: 'test', page: 'item', params: { key: 'P-1', view: 'team' } });
});

test('a table row runs its action, and navigating opens the plugin page with params', async ({ page }) => {
    await openPlugin(page, {
        type: 'table', columns: ['Key', 'Summary'],
        rows: [{ cells: [text('P-1'), text('Fix login')], action: action('open', 'Open P-1', { params: { key: 'P-1' } }) }],
    }, {
        pluginPages: { 'test/item': text('The item') },
        pluginActions: { 'test/open': { navigate: { page: 'item', params: { key: 'P-1' } } } },
    });
    await page.locator('app-plugin-page tr.plugin-clickable').click();
    await expect(page).toHaveURL(/\/plugin\/test\/item\?key=P-1$/);
    await expect(page.locator('app-plugin-page')).toContainText('The item');
    const [request] = await calls(page, 'plugin_action');
    expect(request).toEqual({ id: 'test', request: { page: 'home', pageParams: {}, action: 'open', params: { key: 'P-1' }, form: {} } });
});

test('navigating to the same page with new params loads it again, and Back returns to the first', async ({ page }) => {
    await openPlugin(page, text('The list'), { pluginActions: { 'test/new': { navigate: { page: 'home', params: { edit: '1' } } } } });
    await onCommand(page, 'plugin_render', ({ params }) => params.edit ? { type: 'heading', text: 'The editor', level: 2 } : {
        type: 'button', action: { id: 'new', label: 'New' }, theme: 'primary',
    });
    await page.evaluate(() => document.querySelector('app-plugin-page').load());
    await page.locator('app-plugin-page webui-button', { hasText: 'New' }).click();
    await expect(page).toHaveURL(/\/plugin\/test\/home\?edit=1$/);
    await expect(page.locator('app-plugin-page')).toContainText('The editor');
    await page.goBack();
    await expect(page).toHaveURL(/\/plugin\/test\/home$/);
    await expect(page.locator('app-plugin-page webui-button', { hasText: 'New' })).toBeVisible();
});

test('a form sends its values, and a required field must be filled first', async ({ page }) => {
    await openPlugin(page, {
        type: 'form',
        fields: [
            { name: 'summary', label: 'Summary', kind: 'text', required: true },
            { name: 'body', label: 'Body', kind: 'textarea', value: 'Hello' },
            { name: 'kind', label: 'Kind', kind: 'select', options: [{ value: 'bug', label: 'Bug' }, { value: 'task', label: 'Task' }], value: 'task' },
            { name: 'mine', label: 'Assign to me', kind: 'checkbox', value: true },
            { name: 'labels', label: 'Labels', kind: 'multiselect', options: [{ value: 'web', label: 'Web' }, { value: 'api', label: 'API' }], value: ['api'] },
            { name: 'project', kind: 'hidden', value: 'P' },
        ],
        submit: action('create', 'Create'),
    }, { pluginActions: { 'test/create': { message: { text: 'Created P-9.', theme: 'success' } } } });
    const form = page.locator('app-plugin-page form');
    await form.locator('webui-button', { hasText: 'Create' }).click();
    await expect.poll(() => alerts(page)).toContainEqual('Summary is required.');
    expect(await calls(page, 'plugin_action')).toEqual([]);
    await form.locator('webui-input-text input').fill('New thing');
    await form.getByLabel('Web').check();
    await form.getByLabel('Assign to me').uncheck();
    await form.locator('webui-button', { hasText: 'Create' }).click();
    await expect.poll(() => alerts(page)).toContainEqual('Created P-9.');
    const [{ request }] = await calls(page, 'plugin_action');
    expect(request.form).toEqual({ summary: 'New thing', body: 'Hello', kind: 'task', mine: false, labels: ['web', 'api'], project: 'P' });
});

test('an action can replace the page, refresh it, or show an error', async ({ page }) => {
    await openPlugin(page, {
        type: 'toolbar', children: [
            { type: 'button', action: action('swap', 'Swap') },
            { type: 'button', action: action('again', 'Again') },
            { type: 'button', action: action('broken', 'Broken') },
        ],
    }, { pluginActions: { 'test/swap': { ui: text('Swapped in') }, 'test/again': { refresh: true } } });
    const view = page.locator('app-plugin-page');
    const renders = (await calls(page, 'plugin_render')).length;
    await view.locator('webui-button', { hasText: 'Again' }).click();
    await expect.poll(async () => (await calls(page, 'plugin_render')).length).toBe(renders + 1);
    await view.locator('webui-button', { hasText: 'Broken' }).click();
    await expect.poll(() => alerts(page)).toContainEqual('test does not know the action broken.');
    await view.locator('webui-button', { hasText: 'Swap' }).click();
    await expect(view).toHaveText('Swapped in');
});

test('an action that asks first only runs when confirmed', async ({ page }) => {
    await openPlugin(page, { type: 'button', action: action('delete', 'Delete', { confirm: 'Delete <b>it</b>?' }) },
        { pluginActions: { 'test/delete': { refresh: true } } });
    const button = page.locator('app-plugin-page webui-button');
    await button.click();
    await expect(page.locator('dialog[open]')).toContainText('Delete <b>it</b>?');
    await dialogButton(page, 'Cancel').click();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    expect(await calls(page, 'plugin_action')).toEqual([]);
    await button.click();
    await dialogButton(page, 'Confirm').click();
    await expect.poll(async () => (await calls(page, 'plugin_action')).length).toBe(1);
});

test('host actions run in Task Proxy, not the plugin', async ({ page }) => {
    await openPlugin(page, {
        type: 'toolbar', children: [
            { type: 'button', action: { id: '', label: 'Create branch', host: { type: 'git.createBranch', name: 'P-1-fix' } } },
            { type: 'button', action: { id: '', label: 'Settings', host: { type: 'openSettings' } } },
        ],
    });
    const view = page.locator('app-plugin-page');
    await view.locator('webui-button', { hasText: 'Create branch' }).click();
    // Alerts are drawn as HTML, so the backend's message is escaped.
    await expect.poll(() => alerts(page)).toContainEqual('Branch &#39;P-1-fix&#39; created.');
    expect(await calls(page, 'plugin_host_action')).toEqual([{ id: 'test', action: { type: 'git.createBranch', name: 'P-1-fix' } }]);
    expect(await calls(page, 'plugin_action')).toEqual([]);
    await view.locator('webui-button', { hasText: 'Settings' }).click();
    // The Plugins drawer opens on this plugin.
    await expect(page.locator('webui-drawer.shared app-plugin-manager [data-plugin="test"]')).toHaveClass(/plugin-highlight/);
});

test('sections remember whether they were opened or closed', async ({ page }) => {
    await openPlugin(page, {
        type: 'stack', children: [
            { type: 'section', key: 'layer-0', title: 'Issue · Task P-3', subtitle: 'Fix login', open: true, children: [text('Own fields')] },
            { type: 'section', key: 'layer-1', title: 'Parent · Story P-2', open: true, children: [text('Parent fields')] },
        ],
    }, { pluginActions: { 'test/again': { refresh: true } } });
    const parent = page.locator('details.plugin-section').nth(1);
    await expect(parent).toHaveAttribute('open', '');
    await parent.locator('summary').click();
    await expect(parent).not.toHaveAttribute('open', '');
    await expect.poll(() => page.evaluate(() => webui.getData('app-plugin-sections'))).toEqual({ test: { 'layer-1': false } });
    await page.evaluate(() => document.querySelector('app-plugin-page').load());
    await expect(page.locator('details.plugin-section').nth(0)).toHaveAttribute('open', '');
    await expect(page.locator('details.plugin-section').nth(1)).not.toHaveAttribute('open', '');
});

test('a page that fails to load shows why, and can be tried again', async ({ page }) => {
    await openApp(page, { plugins, pluginPages: {}, currentPage: '/plugin/test/home' }, '/plugin/test/home');
    const view = page.locator('app-plugin-page');
    await expect(view.locator('webui-alert')).toContainText('test has no page named home.');
    await page.evaluate(() => { window.__backend.handlers.plugin_render = () => ({ type: 'text', text: 'Back again' }); });
    await view.locator('webui-button', { hasText: 'Try again' }).click();
    await expect(view).toHaveText('Back again');
});

test("enabled plugins' pages are in the nav, except hidden ones", async ({ page }) => {
    const other = { ...manifest, id: 'off', name: 'Off Plugin' };
    await openApp(page, { plugins: [...plugins, { id: 'off', version: '1.0.0', enabled: false, signed: false, manifest: other }] });
    const nav = page.locator('webui-nav.plugin-nav');
    await expect(nav).toContainText('Test Plugin');
    await expect(nav).not.toContainText('Off Plugin');
    await expect(nav.locator('[url="/plugin/test/home"]')).toHaveCount(1);
    await expect(nav.locator('[url="/plugin/test/item"]')).toHaveCount(0);
    // Plugins are managed from a header drawer, not a nav link.
    await expect(nav.locator('[url="/plugins"]')).toHaveCount(0);
});

test.describe('editable tables', () => {
    const long = 'A summary that is much too long to fit in a table cell, and keeps going well past the tooltip limit too.';
    const table = {
        type: 'table',
        columns: [
            'Key',
            { label: 'Summary', action: action('sort', 'Sort by Summary', { params: { field: 'summary' } }), sort: 'asc' },
            { label: 'Status', action: action('sort', 'Sort by Status', { params: { field: 'status' } }) },
            'Comment',
        ],
        rows: [{
            cells: [
                { type: 'link', text: 'P-1', action: action('open', 'Open P-1') },
                { type: 'clip', text: long, action: action('cell.open', 'Show Summary', { params: { key: 'P-1' } }) },
                { type: 'select', text: 'To Do', options: action('cell.options', 'Change Status'), action: action('cell.set', 'Change Status', { params: { key: 'P-1' } }) },
                { type: 'clip', text: 'Sam: short', always: true, action: action('cell.comments', 'Comments') },
            ],
        }],
    };
    const lastAction = page => page.evaluate(() => window.__backend.calls.filter(call => call.command === 'plugin_action').at(-1)?.args.request);

    test('titles sort, and show which way the table is sorted', async ({ page }) => {
        await openPlugin(page, table, { pluginActions: { 'test/sort': {} } });
        const titles = page.locator('app-plugin-page th');
        await expect(titles.nth(1)).toHaveAttribute('aria-sort', 'ascending');
        await expect(titles.nth(1)).toContainText('▲');
        await expect(titles.nth(0)).not.toHaveClass(/plugin-sortable/);
        await titles.nth(2).click();
        expect((await lastAction(page)).params).toEqual({ field: 'status' });
    });

    test('long text is cut to 30 characters, with up to 100 in its tooltip, and opens when clicked', async ({ page }) => {
        await openPlugin(page, table, { pluginActions: { 'test/cell.open': {}, 'test/cell.comments': {} } });
        const clip = page.locator('app-plugin-page .plugin-clip').first();
        await expect(clip).toHaveText(`${long.slice(0, 30).trimEnd()}...`);
        await expect(clip).toHaveAttribute('title', `${long.slice(0, 100).trimEnd()}...`);
        await clip.click();
        expect((await lastAction(page)).action).toBe('cell.open');
        // Short text that always opens, as a comment does.
        const comment = page.locator('app-plugin-page .plugin-clip').nth(1);
        await expect(comment).toHaveText('Sam: short');
        await expect(comment).not.toHaveAttribute('title');
        await comment.click();
        expect((await lastAction(page)).action).toBe('cell.comments');
    });

    test('short text that fits is plain, with no tooltip or click', async ({ page }) => {
        await openPlugin(page, { type: 'clip', text: 'Fits fine', action: action('cell.open', 'Show') });
        const clip = page.locator('app-plugin-page .plugin-clip');
        await expect(clip).toHaveText('Fits fine');
        await expect(clip).not.toHaveClass(/plugin-clip-open/);
        await expect(clip).not.toHaveAttribute('role');
    });

    test('a value changes in place: its choices load when clicked, and a pick is sent', async ({ page }) => {
        await openPlugin(page, table, {
            pluginActions: {
                'test/cell.options': { options: [{ value: '21', label: 'In Progress' }, { value: '31', label: 'Done' }] },
                'test/cell.set': { refresh: true, message: { text: 'Status changed on P-1.', theme: 'success' } },
            },
        });
        expect(await calls(page, 'plugin_action')).toEqual([]);
        await page.locator('app-plugin-page .plugin-select').click();
        const menu = page.locator('.plugin-menu');
        await expect(menu.getByRole('option')).toHaveText(['In Progress', 'Done']);
        await menu.getByRole('option', { name: 'Done' }).click();
        await expect(menu).toHaveCount(0);
        await expect.poll(() => lastAction(page)).toMatchObject({ action: 'cell.set', params: { key: 'P-1' }, form: { value: '31' } });
        await expect.poll(() => alerts(page)).toContain('Status changed on P-1.');
    });

    test('a long list of choices can be filtered, and Escape closes it', async ({ page }) => {
        const options = Array.from({ length: 12 }, (_, index) => ({ value: `${index}`, label: `Person ${index}` }));
        await openPlugin(page, table, { pluginActions: { 'test/cell.options': { options } } });
        await page.locator('app-plugin-page .plugin-select').click();
        const filter = page.locator('.plugin-menu input[type="search"]');
        await expect(filter).toBeFocused();
        await filter.fill('son 1');
        await expect(page.locator('.plugin-menu [role="option"]:visible')).toHaveText(['Person 1', 'Person 10', 'Person 11']);
        await page.keyboard.press('Escape');
        await expect(page.locator('.plugin-menu')).toHaveCount(0);
    });
});

test.describe('forms with panels and dialogs', () => {
    const search = {
        type: 'stack', children: [{
            type: 'form', fields: [],
            buttons: [
                { type: 'button', action: { label: 'Filters', host: { type: 'toggle', key: 'filters' } }, theme: 'secondary' },
                { type: 'button', action: { label: 'JQL', host: { type: 'toggle', key: 'jql' } }, theme: 'secondary' },
            ],
            submit: action('search', 'Search'),
            children: [
                { type: 'panel', key: 'filters', children: [{ type: 'inputs', fields: [{ name: 'f.status', label: 'Status', kind: 'multiselect', options: [{ value: 'Done', label: 'Done' }, { value: 'To Do', label: 'To Do' }], value: ['To Do'] }] }] },
                { type: 'panel', key: 'jql', children: [{ type: 'inputs', fields: [{ name: 'jql', label: 'JQL', kind: 'textarea', value: 'project = P' }] }] },
            ],
        }],
    };

    test('buttons beside Search toggle closed panels, whose fields are sent with the form', async ({ page }) => {
        await openPlugin(page, search, { pluginActions: { 'test/search': {} } });
        const view = page.locator('app-plugin-page');
        const buttons = view.locator('.plugin-form-actions > webui-button');
        await expect(buttons).toHaveText(['Filters', 'JQL', 'Search']);
        const jql = view.locator('.plugin-panel[data-panel="jql"]');
        await expect(jql).toBeHidden();
        await expect(view.locator('.plugin-panel[data-panel="filters"]')).toBeHidden();
        await buttons.nth(1).click();
        await expect(jql).toBeVisible();
        await expect(buttons.nth(1)).toHaveAttribute('aria-pressed', 'true');
        expect(await calls(page, 'plugin_action')).toEqual([]);
        await buttons.nth(2).click();
        const [request] = await calls(page, 'plugin_action');
        expect(request.request.form).toEqual({ 'f.status': ['To Do'], jql: 'project = P' });
        // The panel stays as the user left it.
        await page.evaluate(() => document.querySelector('app-plugin-page').load());
        await expect(view.locator('.plugin-panel[data-panel="jql"]')).toBeVisible();
        await expect(view.locator('.plugin-panel[data-panel="filters"]')).toBeHidden();
    });

    test('an action can open a dialog, whose own actions update it, refresh the page, and close it', async ({ page }) => {
        const dialogForm = {
            type: 'stack', children: [
                text('Every comment'),
                { type: 'form', fields: [{ name: 'body', label: 'Add a comment', kind: 'textarea' }], submit: action('comment', 'Comment') },
                { type: 'button', action: action('done', 'Done'), theme: '' },
            ],
        };
        await openPlugin(page, { type: 'button', action: action('show', 'Show comments'), theme: '' }, {
            pluginActions: {
                'test/show': { dialog: { title: 'P-1 · Comments', ui: dialogForm } },
                'test/comment': { ui: text('Updated comments'), refresh: true },
                'test/done': { closeDialog: true },
            },
        });
        await page.locator('app-plugin-page webui-button', { hasText: 'Show comments' }).click();
        const dialog = page.locator('dialog.plugin-dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog.locator('h3')).toHaveText('P-1 · Comments');
        await expect(dialog).toContainText('Every comment');
        const renders = (await calls(page, 'plugin_render')).length;
        await dialog.locator('webui-button', { hasText: 'Comment' }).click();
        await expect(dialog).toContainText('Updated comments');
        await expect.poll(async () => (await calls(page, 'plugin_render')).length).toBe(renders + 1);
        await expect(page.locator('app-plugin-page')).toContainText('Show comments');
        await page.evaluate(ui => document.querySelector('app-plugin-page').openDialog({ title: 'Again', ui }), dialogForm);
        await dialog.locator('webui-button', { hasText: 'Done' }).click();
        await expect(dialog).toHaveCount(0);
        await page.evaluate(ui => document.querySelector('app-plugin-page').openDialog({ title: 'Again', ui }), text('x'));
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
    });

    test('typing @ suggests people to mention, and the form sends who was picked', async ({ page }) => {
        await openPlugin(page, {
            type: 'form',
            fields: [{ name: 'body', label: 'Add a comment', kind: 'textarea', suggest: action('users.suggest', 'Mention someone', { params: { key: 'P-1' } }) }],
            submit: action('comment', 'Comment'),
        }, { pluginActions: { 'test/comment': {} } });
        await onCommand(page, 'plugin_action', ({ request }) => {
            if (request.action !== 'users.suggest') return {};
            const people = [{ value: 'sam-1', label: 'Sam Lee' }, { value: 'sara-2', label: 'Sara Kim' }, { value: 'ray-3', label: 'Ray Ng' }];
            return { options: people.filter(person => person.label.toLowerCase().startsWith(request.params.query.toLowerCase())) };
        });
        const box = page.locator('app-plugin-page textarea[name="body"]');
        await box.click();
        await box.pressSequentially('Thanks @sa');
        const menu = page.locator('.plugin-menu');
        await expect(menu.getByRole('option')).toHaveText(['Sam Lee', 'Sara Kim']);
        // Typing stays in the box, and narrows the suggestions.
        await box.pressSequentially('r');
        await expect(menu.getByRole('option')).toHaveText(['Sara Kim']);
        await page.keyboard.press('Enter');
        await expect(box).toHaveValue('Thanks @Sara Kim ');
        await expect(menu).toHaveCount(0);
        await box.pressSequentially('can you check?');
        const suggests = (await calls(page, 'plugin_action')).filter(call => call.request.action === 'users.suggest');
        expect(suggests.at(-1).request.params).toEqual({ key: 'P-1', query: 'sar' });
        await page.locator('app-plugin-page webui-button', { hasText: 'Comment' }).click();
        const sent = (await calls(page, 'plugin_action')).find(call => call.request.action === 'comment');
        expect(sent.request.form).toEqual({ body: 'Thanks @Sara Kim can you check?', 'body.mentions': { '@Sara Kim': 'sara-2' } });
    });
});

test.describe('spec 0.1.2', () => {
    const items = ['Key', 'Parent key', 'Parent story points'].map((label, index) => ({
        id: `id-${index}`,
        children: [text(label), { type: 'link', text: '✕', action: action('remove', `Remove ${label}`, { params: { index } }) }],
    }));
    const list = { type: 'reorder', items, action: action('order', 'Reorder') };
    const orders = async page => (await calls(page, 'plugin_action')).filter(call => call.request.action === 'order').map(call => call.request.form.order);

    test('a reorder list is put in order by dragging an item, and sends the new order once', async ({ page }) => {
        await openPlugin(page, list, { pluginActions: { 'test/order': { refresh: true }, 'test/remove': {} } });
        const rows = page.locator('app-plugin-page .plugin-reorder-item');
        await expect(rows).toHaveCount(3);
        await expect(rows.first()).toContainText('Key');
        // The app's drag starts once the mouse is held, as on user pages and in the navigation manager.
        const from = await rows.nth(2).boundingBox();
        const to = await rows.nth(0).boundingBox();
        await page.mouse.move(from.x + 10, from.y + from.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(300);
        await page.mouse.move(from.x + 10, to.y + 2, { steps: 8 });
        await page.mouse.up();
        await expect.poll(() => orders(page)).toEqual([['id-2', 'id-0', 'id-1']]);
        // A click on an item's own link still runs it, and is not a move.
        await rows.nth(1).locator('a', { hasText: '✕' }).click();
        await expect.poll(async () => (await calls(page, 'plugin_action')).map(call => call.request.action)).toContain('remove');
        expect(await orders(page)).toHaveLength(1);
    });

    test('Alt+Down moves an item from the keyboard, and keeps focus on it after the plugin redraws', async ({ page }) => {
        await openPlugin(page, list, { pluginActions: { 'test/order': { refresh: true } } });
        const handle = page.locator('app-plugin-page .plugin-reorder-item[data-id="id-0"] .plugin-reorder-handle');
        await expect(handle).toHaveAttribute('aria-label', /Key\. Drag, or press Alt\+Up or Alt\+Down/);
        await handle.focus();
        await page.keyboard.press('Alt+ArrowDown');
        await page.keyboard.press('Alt+ArrowDown');
        // Quick moves are sent together.
        await expect.poll(() => orders(page)).toEqual([['id-1', 'id-2', 'id-0']]);
        await expect.poll(() => page.evaluate(() => document.activeElement?.closest?.('.plugin-reorder-item')?.dataset.id)).toBe('id-0');
    });

    test('an inline form sets its fields and button in one row', async ({ page }) => {
        const choices = [{ value: '', label: 'Choose…' }, { value: 'summary', label: 'Summary' }];
        await openPlugin(page, {
            type: 'form', inline: true, submit: action('add', 'Add'),
            fields: ['Issue', 'Parent', 'Grandparent'].map((label, layer) => ({ name: `layer${layer}`, label, kind: 'select', options: choices, value: '' })),
        }, { pluginActions: { 'test/add': {} } });
        const form = page.locator('app-plugin-page form.plugin-form-row');
        await expect(form.locator('webui-dropdown')).toHaveCount(3);
        const boxes = await form.locator(':scope > *').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
        expect(boxes).toHaveLength(4);
        const overlap = Math.min(...boxes.map(box => box.bottom)) - Math.max(...boxes.map(box => box.top));
        expect(overlap, 'every field and the button share one row').toBeGreaterThan(0);
        const widths = boxes.slice(0, 3).map(box => Math.round(box.width));
        expect(Math.max(...widths) - Math.min(...widths), 'the fields share the row evenly').toBeLessThan(5);
        await form.locator('webui-button', { hasText: 'Add' }).click();
        await expect.poll(async () => (await calls(page, 'plugin_action'))[0]?.request.form).toEqual({ layer0: '', layer1: '', layer2: '' });
    });
});

test.describe('spec 0.1.3', () => {
    // A 1x1 PNG.
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    test("markdown images come only from the node's own data URIs, and the raw text can be shown", async ({ page }) => {
        await openPlugin(page, {
            type: 'markdown', toggle: true,
            text: '**Bold** ![Shot](attachment-1) ![Web](https://tracker.example.com/pixel.png) ![Missing](attachment-2) ![Svg](svg)',
            images: { 'attachment-1': png, svg: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
        });
        const view = page.locator('app-plugin-page');
        const images = view.locator('.plugin-markdown img');
        await expect(images).toHaveCount(1);
        await expect(images.first()).toHaveAttribute('src', png);
        await expect(images.first()).toHaveAttribute('alt', 'Shot');
        await expect(view.locator('.plugin-markdown strong')).toHaveText('Bold');
        const raw = view.locator('.plugin-markdown-raw');
        await expect(raw).toBeHidden();
        await view.getByRole('button', { name: 'Show raw' }).click();
        await expect(raw).toBeVisible();
        await expect(raw).toContainText('**Bold** ![Shot](attachment-1)');
        await expect(view.locator('.plugin-markdown')).toBeHidden();
        await view.getByRole('button', { name: 'Show rendered' }).click();
        await expect(view.locator('.plugin-markdown')).toBeVisible();
    });

    test('markdown without toggle has no switch', async ({ page }) => {
        await openPlugin(page, { type: 'markdown', text: 'Plain' });
        await expect(page.locator('app-plugin-page .plugin-markdown-mode')).toHaveCount(0);
    });

    test('clicking a property label switches it to its editor and back', async ({ page }) => {
        await openPlugin(page, {
            type: 'properties', items: [
                { label: 'Summary', value: text('Fix login'), edit: { type: 'form', fields: [{ name: 'value', kind: 'text', value: 'Fix login' }], submit: action('save', 'Save') } },
                { label: 'Status', value: text('Done') },
            ],
        }, { pluginActions: { 'test/save': { refresh: true } } });
        const view = page.locator('app-plugin-page');
        const label = view.getByRole('button', { name: 'Summary' });
        await expect(view.locator('dt', { hasText: 'Status' }).getByRole('button')).toHaveCount(0);
        await expect(view.locator('.plugin-property-edit')).toBeHidden();
        await label.click();
        await expect(view.locator('.plugin-property-edit')).toBeVisible();
        await expect(view.locator('dd', { hasText: 'Fix login' }).locator('> .plugin-text')).toBeHidden();
        await view.locator('.plugin-property-edit webui-input-text input').fill('Fix the login');
        await view.locator('.plugin-property-edit webui-button', { hasText: 'Save' }).click();
        await expect.poll(async () => (await calls(page, 'plugin_action'))[0]?.request.form).toEqual({ value: 'Fix the login' });
        await expect(view.locator('.plugin-property-edit')).toBeHidden();
    });

    test("a form submitted with a host action fills the action's fields, such as a branch's name", async ({ page }) => {
        await openPlugin(page, {
            type: 'form',
            fields: [{ name: 'name', label: 'Branch name', kind: 'text', value: 'P-1-fix', required: true }, { name: 'other', kind: 'hidden', value: 'x' }],
            submit: { id: '', label: 'Create branch', host: { type: 'git.createBranch', name: 'P-1-fix' } },
        });
        const form = page.locator('app-plugin-page form');
        await form.locator('webui-input-text input').fill('feature/PROJ-1_fix-login');
        await form.locator('webui-button', { hasText: 'Create branch' }).click();
        // Only the host action's own fields are filled, and the plugin is not called.
        await expect.poll(() => calls(page, 'plugin_host_action')).toEqual([{ id: 'test', action: { type: 'git.createBranch', name: 'feature/PROJ-1_fix-login' } }]);
        expect(await calls(page, 'plugin_action')).toEqual([]);
    });
});
