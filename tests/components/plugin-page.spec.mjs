import { test, expect, openApp, calls, dialogButton } from '../support/app.mjs';

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
    await expect(page).toHaveURL(/\/plugins\?plugin=test$/);
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
    await expect(nav.locator('[url="/plugins"]')).toHaveCount(1);
});
