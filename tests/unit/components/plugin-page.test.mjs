import { actionNote, spyOnAlerts, alerts } from '../../support/wait.mjs';
import { test, expect, openApp, calls, dialogButton, onCommand, openDialog, emit, goToPage } from '../support/app.mjs';

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
    await expect(view.locator('webui-badge.plugin-badge[theme="info"]')).toHaveText('In Progress');
    await expect(view.locator('dl.plugin-properties dt')).toHaveText('Assignee');
    await expect(view.locator('dl.plugin-properties dd')).toHaveText('Sam Lee');
    await expect(view.locator('webui-alert')).toContainText('Heads up');
    await expect(view.locator('.plugin-empty')).toHaveText('Nothing here');
    await expect(view).toContainText('cannot show "somethingNewer"');
    await expect.poll(() => page.evaluate(() => window.__hacked)).toBeUndefined();
});

test('the page is titled from the manifest, and gets the address params', async ({ page }) => {
    await openPlugin(page, text('Item page'), { pluginPages: { 'test/item': text('Item page') } }, '/plugin/test/item?key=P-1&view=team');
    await expect(page.locator('header h1')).toHaveText('Test Plugin');
    await expect(page.locator('header h2')).toHaveText('Item');
    await expect.poll(() => calls(page, 'plugin_render')).toContainEqual({ id: 'test', page: 'item', params: { key: 'P-1', view: 'team' } });
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

test.describe('a page beside another', () => {
    const list = {
        type: 'table', columns: ['Key'],
        rows: ['P-1', 'P-2'].map(key => ({ cells: [{ type: 'link', text: key, action: action('open', `Open ${key}`, { params: { key } }) }] })),
    };
    const state = {
        pluginPages: { 'test/item': text('An item') },
        pluginActions: { 'test/open': { navigate: { page: 'item', params: { key: 'P-1' }, side: true } } },
    };
    const split = page => page.locator('app-plugin-page webui-split-panes.plugin-split');
    const link = (page, key) => page.locator('app-plugin-page .plugin-link', { hasText: key }).first();
    const side = page => split(page).locator('app-plugin-page.plugin-split-page');
    async function openBeside(page, width = 1400) {
        await page.setViewportSize({ width, height: 800 });
        await openPlugin(page, list, state);
        await page.evaluate(list => { window.__list = list; }, list);
        await onCommand(page, 'plugin_render', ({ page, params }) => page === 'item' ? { type: 'text', text: `Item ${params.key}` } : window.__list);
        await onCommand(page, 'plugin_action', ({ request }) => ({ navigate: { page: 'item', params: { key: request.params.key }, side: true } }));
        await link(page, 'P-1').click();
        await expect(side(page)).toContainText('Item P-1');
    }

    test('opens beside the page, which stays where it is, evenly split and as tall as the page', async ({ page }) => {
        await openBeside(page);
        await expect(page).toHaveURL(/\/plugin\/test\/home$/);
        await expect(split(page).locator('[slot="start"] table')).toBeVisible();
        await expect(split(page)).toHaveAttribute('ratio', '0.5');
        await expect(split(page)).toHaveAttribute('start-label', 'Test Home');
        await expect(split(page)).toHaveAttribute('end-label', 'Item');
        await expect.poll(() => calls(page, 'plugin_render')).toContainEqual({ id: 'test', page: 'item', params: { key: 'P-1' } });
        // Another issue from the list replaces the one beside it.
        await link(page, 'P-2').click();
        await expect(side(page)).toContainText('Item P-2');
        await expect(split(page)).toHaveCount(1);
    });

    test('with cover, the page beside covers this one at any width, and a result can switch it back', async ({ page }) => {
        await page.setViewportSize({ width: 1400, height: 800 });
        const withSwitch = { type: 'stack', children: [{ type: 'button', action: action('split', 'Split view'), on: false }, list] };
        await openPlugin(page, withSwitch, state);
        await page.evaluate(node => { window.__list = node; window.__cover = true; }, withSwitch);
        await onCommand(page, 'plugin_render', ({ page, params }) => page === 'item' ? { type: 'text', text: `Item ${params.key}` } : window.__list);
        await onCommand(page, 'plugin_action', ({ request }) => {
            if (request.action === 'split') {
                window.__cover = !window.__cover;
                return { refresh: true, cover: window.__cover };
            }
            return { navigate: { page: 'item', params: { key: request.params.key }, side: true, cover: window.__cover } };
        });
        await link(page, 'P-1').click();
        await expect(side(page)).toContainText('Item P-1');
        // One page at a time, though the window has room for both, with a button on each to switch.
        await expect(split(page)).toHaveAttribute('single', '');
        await expect(split(page)).toHaveAttribute('narrow', '');
        await expect(split(page).locator('.bar')).toBeHidden();
        await split(page).getByRole('button', { name: 'Test Home' }).click();
        await expect(split(page).locator('[slot="start"] table')).toBeVisible();
        await expect(side(page)).toBeHidden();
        await split(page).getByRole('button', { name: 'Item', exact: true }).click();
        await expect(side(page)).toBeVisible();
        const saved = () => page.evaluate(() => webui.getData('app-plugin-sections')?.test?.['side::home'] ?? Object.entries(webui.getData('app-plugin-sections')?.test || {}).find(([key]) => key.startsWith('side:'))?.[1]);
        await expect.poll(saved).toEqual({ page: 'item', params: { key: 'P-1' }, cover: true });
        // Turning it off on the page switches the page already beside it back to side by side.
        await split(page).getByRole('button', { name: 'Test Home' }).click();
        await page.locator('app-plugin-page webui-toggle-icon', { hasText: 'Split view' }).click();
        await expect(split(page)).not.toHaveAttribute('single', '');
        await expect(split(page)).not.toHaveAttribute('narrow', '');
        await expect(side(page)).toContainText('Item P-1');
        await expect.poll(saved).toEqual({ page: 'item', params: { key: 'P-1' } });
        // Another page opened without cover keeps the split as it is.
        await link(page, 'P-2').click();
        await expect(side(page)).toContainText('Item P-2');
        await expect(split(page)).not.toHaveAttribute('single', '');
    });

    test('resizing is remembered, Close puts the page back, and Open as its own page navigates to it', async ({ page }) => {
        await openBeside(page);
        await split(page).locator('.bar').focus();
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => page.evaluate(() => webui.getData('app-plugin-sections')?.test?.['split:ratio'])).toBe(0.55);
        await split(page).getByRole('button', { name: 'Close' }).click();
        await expect(split(page)).toHaveCount(0);
        await expect(page.locator('app-plugin-page table')).toBeVisible();
        await link(page, 'P-1').click();
        await expect(split(page)).toHaveAttribute('ratio', '0.55');
        await split(page).getByRole('button', { name: 'Open as its own page' }).click();
        await expect(page).toHaveURL(/\/plugin\/test\/item\?key=P-1$/);
        await expect(split(page)).toHaveCount(0);
        await expect(page.locator('app-plugin-page')).toContainText('Item P-1');
    });

    test('the page left open beside it opens again when the page is shown again, until it is closed', async ({ page }) => {
        await openBeside(page);
        await link(page, 'P-2').click();
        await expect(side(page)).toContainText('Item P-2');
        const away = async () => {
            await page.evaluate(() => webui.navigateTo('/plugin/test/item?key=P-9'));
            await expect(page.locator('app-plugin-page').first()).toContainText('Item P-9');
            await page.evaluate(() => webui.navigateTo('/plugin/test/home'));
            await expect(page.locator('app-plugin-page .plugin-link').first()).toBeVisible();
        };
        await away();
        await expect(side(page)).toContainText('Item P-2');
        await expect(split(page).locator('[slot="start"] table')).toBeVisible();
        // Closed, it stays closed.
        await split(page).getByRole('button', { name: 'Close' }).click();
        await expect(split(page)).toHaveCount(0);
        await away();
        await expect(page.locator('app-plugin-page table')).toBeVisible();
        await expect(split(page)).toHaveCount(0);
        // Opened as its own page, it is no longer beside the page either.
        await link(page, 'P-1').click();
        await expect(side(page)).toContainText('Item P-1');
        await split(page).getByRole('button', { name: 'Open as its own page' }).click();
        await expect(page).toHaveURL(/\/plugin\/test\/item\?key=P-1$/);
        await page.evaluate(() => webui.navigateTo('/plugin/test/home'));
        await expect(page.locator('app-plugin-page table')).toBeVisible();
        await expect(split(page)).toHaveCount(0);
    });

    test('the side page opens what it navigates to in its place, and the page beside it in the page', async ({ page }) => {
        await openBeside(page);
        await onCommand(page, 'plugin_render', ({ page, params }) => page === 'item'
            ? { type: 'stack', children: [
                { type: 'text', text: `Item ${params.key}` },
                { type: 'button', action: { id: 'next', label: 'Next' } },
                { type: 'button', action: { id: 'list', label: 'To the list' } },
                { type: 'button', action: { id: 'change', label: 'Change' } },
            ] }
            : { type: 'text', text: params.sort ? `Sorted by ${params.sort}` : 'The list' });
        await onCommand(page, 'plugin_action', ({ request }) => ({
            next: { navigate: { page: 'item', params: { key: 'P-9' } } },
            list: { navigate: { page: 'home', params: { sort: 'key' } } },
            change: { refresh: true },
        })[request.action]);
        await page.evaluate(() => document.querySelector('.plugin-split-page').load());
        await side(page).locator('webui-button', { hasText: 'Next' }).click();
        await expect(side(page)).toContainText('Item P-9');
        await expect(page).toHaveURL(/\/plugin\/test\/home$/);
        await side(page).locator('webui-button', { hasText: 'Change' }).click();
        // A change beside the page draws the page again too.
        await expect(split(page).locator('[slot="start"]')).toContainText('The list');
        await side(page).locator('webui-button', { hasText: 'To the list' }).click();
        await expect(page).toHaveURL(/\/plugin\/test\/home\?sort=key$/);
        await expect(split(page).locator('[slot="start"]')).toContainText('Sorted by key');
    });

});

test('a form with changed shows Refresh until a field changes, then Search, and searching unchanged adds no history', async ({ page }) => {
    const form = {
        type: 'form', fields: [{ name: 'jql', label: 'JQL', kind: 'text', value: 'order by key' }],
        buttons: [], children: [{ type: 'inputs', fields: [{ name: 'f.type', label: 'Type', kind: 'multiselect', value: [], options: [{ value: 'Bug', label: 'Bug' }] }] }],
        submit: action('search', 'Refresh', { icon: 'refresh' }),
        changed: action('search', 'Search', { icon: 'magnifying-glass' }),
    };
    await openPlugin(page, form, { pluginActions: { 'test/search': { navigate: { page: 'home', params: {} } } } });
    const view = page.locator('app-plugin-page');
    const button = view.locator('.plugin-form-actions webui-button');
    await expect(button).toHaveText('Refresh');
    await expect(button).toHaveAttribute('start-icon', 'refresh');
    const field = view.locator('webui-input-text input');
    await field.fill('order by rank');
    await expect(button).toHaveText('Search');
    await expect(button).toHaveAttribute('start-icon', 'magnifying-glass');
    await field.fill('order by key');
    await expect(button).toHaveText('Refresh');
    await view.getByLabel('Bug').check();
    await expect(button).toHaveText('Search');
    await view.getByLabel('Bug').uncheck();
    await expect(button).toHaveText('Refresh');
    // Refresh searches again as it is, loading the page without a new history entry.
    const history = await page.evaluate(() => history.length);
    const renders = (await calls(page, 'plugin_render')).length;
    await button.click();
    await expect.poll(async () => (await calls(page, 'plugin_render')).length).toBe(renders + 1);
    await expect.poll(() => page.evaluate(() => history.length)).toBe(history);
    await expect.poll(async () => (await calls(page, 'plugin_action')).map(call => call.request.form)).toEqual([{ jql: 'order by key', 'f.type': [] }]);
});

test('a search or refresh disables its button, which says Loading Content until the results are drawn', async ({ page }) => {
    const form = results => ({
        type: 'stack', children: [
            { type: 'form', fields: [{ name: 'jql', label: 'JQL', kind: 'text', value: 'order by key' }], buttons: [], submit: action('search', 'Refresh', { icon: 'refresh' }) },
            text(results),
        ],
    });
    await openPlugin(page, form('The results'), { pluginActions: { 'test/search': { refresh: true } } });
    const view = page.locator('app-plugin-page');
    await onCommand(page, 'plugin_render', () => new Promise(resolve => { window.__answer = resolve; }));
    const button = view.locator('.plugin-form-actions webui-button');
    await button.click();
    await expect(button).toHaveText('Loading Content');
    await expect(button).toHaveAttribute('disabled', '');
    await expect(button).toHaveAttribute('start-icon', 'hourglass');
    // What was found before stays while the search runs again, and clicking again does nothing.
    await expect(view).toContainText('The results');
    await button.click({ force: true });
    expect((await calls(page, 'plugin_action')).length).toBe(1);
    await expect.poll(() => page.evaluate(() => typeof window.__answer)).toBe('function');
    await page.evaluate(node => window.__answer(node), form('The newer results'));
    await expect(view).toContainText('The newer results');
    await expect(button).toHaveText('Refresh');
    await expect(button).not.toHaveAttribute('disabled', '');
    await expect(button).toHaveAttribute('start-icon', 'refresh');
});

test('a button for something the app does itself, such as a panel, is never made busy', async ({ page }) => {
    await openPlugin(page, {
        type: 'stack', children: [
            { type: 'button', action: { id: 'more', label: 'More', host: { type: 'toggle', key: 'more' } } },
            { type: 'panel', key: 'more', children: [text('The panel')] },
        ],
    });
    const button = page.locator('app-plugin-page webui-button', { hasText: 'More' });
    await page.evaluate(() => {
        window.__labels = [];
        const button = [...document.querySelectorAll('app-plugin-page webui-button')].find(node => node.textContent.includes('More'));
        // A busy button is disabled as soon as it is clicked, before it says it is loading.
        new MutationObserver(() => window.__labels.push(button.hasAttribute('disabled'))).observe(button, { attributes: true });
    });
    const panel = page.locator('app-plugin-page').getByText('The panel');
    await button.click();
    await expect(panel).toBeVisible();
    await button.click();
    await expect(panel).toBeHidden();
    expect(await page.evaluate(() => window.__labels)).not.toContain(true);
    await expect(button).toHaveText('More');
});

test.describe('pages drawn before', () => {
    test('show at once when gone back to, and are drawn again only if the plugin answers differently', async ({ page }) => {
        await openPlugin(page, text('The list'), {
            pluginPages: { 'test/item': text('The item') },
            pluginActions: { 'test/open': { navigate: { page: 'item', params: { key: 'P-1' } } } },
        });
        await page.evaluate(() => webui.navigateTo('/plugin/test/item?key=P-1'));
        await expect(page.locator('app-plugin-page')).toContainText('The item');
        // The plugin is slow from now on, and answers with a newer list.
        await onCommand(page, 'plugin_render', ({ page }) => new Promise(resolve => {
            window.__answer = () => resolve(page === 'home' ? { type: 'text', text: 'The newer list' } : { type: 'text', text: 'The item' });
        }));
        await page.goBack();
        await expect(page).toHaveURL(/\/plugin\/test\/home$/);
        await expect(page.locator('app-plugin-page')).toContainText('The list');
        await expect(page.locator('app-plugin-page')).not.toContainText('Loading');
        await expect.poll(() => page.evaluate(() => typeof window.__answer)).toBe('function');
        await page.evaluate(() => window.__answer());
        await expect(page.locator('app-plugin-page')).toContainText('The newer list');
    });

    test('a page that comes back the same is not drawn again, and one that fails keeps what it showed', async ({ page }) => {
        await openPlugin(page, text('The list'), { pluginPages: { 'test/item': text('The item') } });
        const view = page.locator('app-plugin-page');
        const away = async () => {
            await page.evaluate(() => webui.navigateTo('/plugin/test/item'));
            await expect(view).toContainText('The item');
        };
        await away();
        // The plugin's answer for the list is held until the list has been drawn from the cache and marked.
        const renders = (await calls(page, 'plugin_render')).filter(call => call.page === 'home').length;
        await page.evaluate(() => {
            const render = window.__backend.handlers.plugin_render;
            const held = new Promise(resolve => { window.__answerList = resolve; });
            window.__backend.handlers.plugin_render = async args => {
                if (args.page === 'home') await held;
                return render(args);
            };
        });
        await page.goBack();
        await expect(view).toContainText('The list');
        // Drawing it again would lose the mark.
        await view.locator('.plugin-text').evaluate(node => { node.dataset.drawn = 'cached'; });
        // Going Back can ask for the page more than once. Every answer is held, and each is dealt with as soon as it
        // is given, before the page answers the test again.
        await expect.poll(async () => (await calls(page, 'plugin_render')).filter(call => call.page === 'home').length).toBeGreaterThan(renders);
        await page.evaluate(() => window.__answerList());
        await expect(view.locator('.plugin-text[data-drawn="cached"]')).toHaveText('The list');
        await away();
        await onCommand(page, 'plugin_render', () => { throw 'Jira could not be reached'; });
        await page.goBack();
        await expect.poll(() => alerts(page)).toContain('Jira could not be reached');
        await expect(view).toContainText('The list');
        await expect(view.locator('webui-alert')).toHaveCount(0);
    });
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
    // Said by the button pressed, rather than in a popup.
    await expect(actionNote(form, 'Summary is required.')).toHaveCount(1);
    await expect.poll(() => calls(page, 'plugin_action')).toEqual([]);
    await form.locator('webui-input-text input').fill('New thing');
    await form.getByLabel('Web').check();
    await form.getByLabel('Assign to me').uncheck();
    await form.locator('webui-button', { hasText: 'Create' }).click();
    await expect(actionNote(form, 'Created P-9.')).toHaveCount(1);
    await expect(actionNote(form, 'Summary is required.')).toHaveCount(0);
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
    await expect(actionNote(view, 'test does not know the action broken.')).toHaveCount(1);
    await view.locator('webui-button', { hasText: 'Swap' }).click();
    await expect(view).toHaveText('Swapped in');
});

test('a button with on is a switch that shows its state and runs its action', async ({ page }) => {
    await openPlugin(page, {
        type: 'toolbar', children: [
            { type: 'button', action: action('split', 'Split view'), theme: 'primary', on: true },
            { type: 'button', action: action('wrap', 'Wrap'), theme: 'secondary', on: false },
            { type: 'button', action: action('plain', 'Plain') },
        ],
    }, { pluginActions: { 'test/split': { refresh: true } } });
    const view = page.locator('app-plugin-page');
    const split = view.locator('webui-toggle-icon', { hasText: 'Split view' });
    await expect(split).toHaveAttribute('enabled', /.*/);
    await expect(view.locator('webui-toggle-icon', { hasText: 'Wrap' })).not.toHaveAttribute('enabled', /.*/);
    // A button without on is still a button.
    await expect(view.locator('webui-button', { hasText: 'Plain' })).toBeVisible();
    await expect(view.locator('webui-toggle-icon')).toHaveCount(2);
    const renders = (await calls(page, 'plugin_render')).length;
    await split.click();
    await expect.poll(async () => (await calls(page, 'plugin_action')).map(call => call.request.action)).toEqual(['split']);
    await expect.poll(async () => (await calls(page, 'plugin_render')).length).toBe(renders + 1);
});
test('an action that asks first only runs when confirmed', async ({ page }) => {
    await openPlugin(page, { type: 'button', action: action('delete', 'Delete', { confirm: 'Delete <b>it</b>?' }) },
        { pluginActions: { 'test/delete': { refresh: true } } });
    const button = page.locator('app-plugin-page webui-button');
    await button.click();
    await expect(openDialog(page)).toContainText('Delete <b>it</b>?');
    await dialogButton(page, 'Cancel').click();
    await expect(openDialog(page)).toHaveCount(0);
    await expect.poll(() => calls(page, 'plugin_action')).toEqual([]);
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
    // Said as text by the button, so the backend's message is shown as it is.
    await expect(actionNote(view, "Branch 'P-1-fix' created.")).toHaveCount(1);
    await expect.poll(() => calls(page, 'plugin_host_action')).toEqual([{ id: 'test', action: { type: 'git.createBranch', name: 'P-1-fix' } }]);
    await expect.poll(() => calls(page, 'plugin_action')).toEqual([]);
    await view.locator('webui-button', { hasText: 'Settings' }).click();
    // The Plugins drawer opens on this plugin.
    await expect(page.locator('webui-drawer.shared app-plugin-manager [data-plugin="test"]')).toHaveClass(/plugin-highlight/);
});

test('a host action that failed and then works, saying nothing, no longer shows why it failed', async ({ page }) => {
    await openPlugin(page, {
        type: 'toolbar', children: [
            { type: 'button', action: { id: '', label: 'Switch branch', host: { type: 'git.switchBranch', name: 'P-1-fix' } } },
        ],
    });
    await page.evaluate(() => {
        const original = window.__backend.handlers.plugin_host_action;
        window.__backend.handlers.plugin_host_action = args => {
            window.__backend.handlers.plugin_host_action = original;
            throw 'The branch could not be switched to.';
        };
    });
    const view = page.locator('app-plugin-page');
    const button = view.locator('webui-button', { hasText: 'Switch branch' });
    await button.click();
    await expect(actionNote(view, 'The branch could not be switched to.')).toHaveCount(1);
    await button.click();
    await expect.poll(() => calls(page, 'plugin_host_action')).toHaveLength(2);
    await expect(actionNote(view, 'The branch could not be switched to.')).toHaveCount(0);
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

    test('an angled table leans each title with its sort arrow, and a table that is not angled does not', async ({ page }) => {
        await openPlugin(page, { ...table, angled: true });
        const angled = page.locator('app-plugin-page table');
        await expect(angled).toHaveClass(/angled-headers/);
        // Each title and its arrow are one element in its header, which is what leans.
        const title = page.locator('app-plugin-page th').nth(1).locator(':scope > span');
        await expect(title).toContainText('▲');
        await openPlugin(page, table);
        await expect(page.locator('app-plugin-page table')).not.toHaveClass(/angled-headers/);
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

    test('rows alternate shades, a themed row is tinted over its shade, and clip text takes a theme', async ({ page }) => {
        const row = (kind, rowTheme) => ({
            cells: [{ type: 'clip', text: kind, theme: kind === 'Bug' ? 'danger' : 'success' }],
            theme: rowTheme,
        });
        await openPlugin(page, {
            type: 'table', columns: ['Issue type'],
            rows: [row('Story'), row('Story'), row('Bug', 'danger'), row('Story', 'danger'), row('Story', 'nonsense')],
        });
        const rows = page.locator('app-plugin-page .plugin-table tbody tr');
        await expect(rows).toHaveCount(5);
        // Each row carries the theme the plugin gave it, and a theme the app doesn't know is dropped. How a theme and
        // the alternating shades look is checked by eye.
        await expect.poll(() => rows.evaluateAll(trs => trs.map(tr => tr.getAttribute('data-theme')))).toEqual([null, null, 'danger', 'danger', null]);
        const clips = page.locator('app-plugin-page .plugin-clip');
        await expect(clips.nth(2)).toHaveAttribute('data-theme', 'danger');
        await expect(clips.nth(0)).toHaveAttribute('data-theme', 'success');
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
        await expect.poll(() => calls(page, 'plugin_action')).toEqual([]);
        await page.locator('app-plugin-page .plugin-select').click();
        const menu = page.locator('.plugin-menu');
        await expect(menu.getByRole('option')).toHaveText(['In Progress', 'Done']);
        await menu.getByRole('option', { name: 'Done' }).click();
        await expect(menu).toHaveCount(0);
        await expect.poll(() => lastAction(page)).toMatchObject({ action: 'cell.set', params: { key: 'P-1' }, form: { value: '31' } });
        await expect.poll(() => alerts(page)).toContain('Status changed on P-1.');
    });

    test('what a cell\'s button says goes inside its cell, keeping the table whole', async ({ page }) => {
        await openPlugin(page, table, { pluginActions: { 'test/cell.options': { options: [] } } });
        await page.locator('app-plugin-page .plugin-select').click();
        await expect(actionNote(page.locator('app-plugin-page td'), 'There is nothing to change it to.')).toHaveCount(1);
        await expect(page.locator('app-plugin-page tr > webui-alert')).toHaveCount(0);
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
        await expect.poll(() => calls(page, 'plugin_action')).toEqual([]);
        await buttons.nth(2).click();
        await expect.poll(async () => (await calls(page, 'plugin_action')).map(call => call.request.form)).toEqual([{ 'f.status': ['To Do'], jql: 'project = P' }]);
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
        await expect(box).toHaveValue('Thanks @Sara Kim can you check?');
        await page.locator('app-plugin-page webui-button', { hasText: 'Comment' }).click();
        const sent = async () => (await calls(page, 'plugin_action')).find(call => call.request.action === 'comment')?.request.form;
        await expect.poll(sent).toEqual({ body: 'Thanks @Sara Kim can you check?', 'body.mentions': { '@Sara Kim': 'sara-2' } });
        // The text typed after the mention asked for no more suggestions.
        const suggests = (await calls(page, 'plugin_action')).filter(call => call.request.action === 'users.suggest');
        expect(suggests.at(-1).request.params).toEqual({ key: 'P-1', query: 'sar' });
    });
});

test.describe('spec 0.1.2', () => {
    const items = ['Key', 'Parent key', 'Parent story points'].map((label, index) => ({
        id: `id-${index}`,
        children: [text(label), { type: 'link', text: '✕', action: action('remove', `Remove ${label}`, { params: { index } }) }],
    }));
    const list = { type: 'reorder', items, action: action('order', 'Reorder') };
    const orders = async page => (await calls(page, 'plugin_action')).filter(call => call.request.action === 'order').map(call => call.request.form.order);

    test('Alt+Down moves an item from the keyboard, and keeps focus on it after the plugin redraws', async ({ page }) => {
        await page.clock.install();
        await openPlugin(page, list, { pluginActions: { 'test/order': { refresh: true } } });
        const handle = page.locator('app-plugin-page .plugin-reorder-item[data-id="id-0"] .plugin-reorder-handle');
        await expect(handle).toHaveAttribute('aria-label', /Key\. Drag, or press Alt\+Up or Alt\+Down/);
        await handle.focus();
        // The page's clock stops, so both moves are made within the pause the app waits for, however slow the machine.
        await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
        await page.keyboard.press('Alt+ArrowDown');
        await page.keyboard.press('Alt+ArrowDown');
        await expect(page.locator('app-plugin-page .plugin-reorder-item').last()).toHaveAttribute('data-id', 'id-0');
        await expect.poll(() => orders(page)).toEqual([]);
        // Quick moves are sent together, once the pause has passed.
        await page.clock.runFor(1000);
        await expect.poll(() => orders(page)).toEqual([['id-1', 'id-2', 'id-0']]);
        await page.clock.resume();
        await expect.poll(() => page.evaluate(() => document.activeElement?.closest?.('.plugin-reorder-item')?.dataset.id)).toBe('id-0');
    });

    test('an inline form sets its fields and button in one row', async ({ page }) => {
        const choices = [{ value: '', label: 'Choose…' }, { value: 'summary', label: 'Summary' }];
        await openPlugin(page, {
            type: 'form', inline: true, submit: action('add', 'Add'),
            fields: ['Issue', 'Parent', 'Grandparent'].map((label, layer) => ({ name: `layer${layer}`, label, kind: 'select', options: choices, value: '' })),
        }, { pluginActions: { 'test/add': {} } });
        const form = page.locator('app-plugin-page form.plugin-form-row');
        await expect(form.locator('webui-select')).toHaveCount(3);
        // The three fields and the button are the row's own items, in order. How the row looks is checked by eye.
        await expect.poll(() => form.locator(':scope > *').evaluateAll(nodes => nodes.map(node => node.localName))).toEqual(['webui-select', 'webui-select', 'webui-select', 'webui-flex']);
        await expect(form.locator(':scope > webui-flex webui-button', { hasText: 'Add' })).toHaveCount(1);
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
        await expect.poll(() => calls(page, 'plugin_action')).toEqual([]);
    });
});

test('a message with an answer that draws the page again goes to the app\'s alerts, since its button is gone', async ({ page }) => {
    await openPlugin(page, { type: 'button', action: action('go', 'Go') }, {
        pluginActions: { 'test/go': { ui: text('Drawn again'), message: { text: 'Went there.', theme: 'success' } } },
    });
    await page.locator('app-plugin-page').getByText('Go').click();
    await expect(page.locator('app-plugin-page')).toContainText('Drawn again');
    await expect.poll(() => alerts(page)).toContain('Went there.');
});

test('what a row, a sortable header, a switch or a clipped text\'s action said is shown by it, not in the app\'s alerts', async ({ page }) => {
    await openPlugin(page, {
        type: 'stack', children: [
            {
                type: 'table', columns: [{ label: 'Key', action: action('sort', 'Sort by key') }],
                rows: [{ cells: [text('P-1')], action: action('open', 'Open P-1') }],
            },
            { type: 'button', on: false, action: action('flip', 'Watch') },
            { type: 'clip', text: 'A summary long enough to be cut short here', max: 10, action: action('more', 'Read all') },
        ],
    }, {
        pluginActions: {
            'test/open': { message: { text: 'Row ran.' } },
            'test/sort': { message: { text: 'Header ran.' } },
            'test/flip': { message: { text: 'Switch ran.' } },
            'test/more': { message: { text: 'Clip ran.' } },
        },
    });
    const view = page.locator('app-plugin-page');
    await view.locator('tr.plugin-clickable').click();
    await expect(actionNote(view, 'Row ran.')).toHaveCount(1);
    // Said after the table, never inside a header cell.
    await view.locator('th.plugin-sortable').click();
    await expect(actionNote(view, 'Header ran.')).toHaveCount(1);
    await expect(view.locator('table webui-alert')).toHaveCount(0);
    await view.locator('webui-toggle-icon.plugin-switch').click();
    await expect(actionNote(view, 'Switch ran.')).toHaveCount(1);
    await view.locator('.plugin-clip-open').click();
    await expect(actionNote(view, 'Clip ran.')).toHaveCount(1);
    await expect.poll(() => alerts(page)).toEqual([]);
});

test('what a link\'s or a form\'s Cancel action said is shown by it, not in the app\'s alerts', async ({ page }) => {
    await openPlugin(page, {
        type: 'stack', children: [
            { type: 'link', text: 'P-1', action: action('open', 'Open P-1') },
            { type: 'form', fields: [], submit: action('save', 'Save'), cancel: action('stop', 'Cancel') },
        ],
    }, {
        pluginActions: {
            'test/open': { message: { text: 'Link ran.' } },
            'test/stop': { message: { text: 'Cancel ran.' } },
        },
    });
    const view = page.locator('app-plugin-page');
    await view.locator('.plugin-link').click();
    await expect(actionNote(view, 'Link ran.')).toHaveCount(1);
    await view.locator('form webui-button', { hasText: 'Cancel' }).click();
    await expect(actionNote(view.locator('form'), 'Cancel ran.')).toHaveCount(1);
    await expect.poll(() => alerts(page)).toEqual([]);
});

test('a reordered list is disabled while its new order saves, and what the plugin said is shown by it', async ({ page }) => {
    await page.clock.install();
    const items = ['First', 'Second'].map((label, index) => ({ id: `id-${index}`, children: [text(label)] }));
    await openPlugin(page, { type: 'stack', children: [{ type: 'reorder', items, action: action('order', 'Reorder') }] }, {
        pluginActions: { 'test/order': { message: { text: 'Order saved.', theme: 'success' } } },
    });
    await page.evaluate(() => {
        const original = window.__backend.handlers.plugin_action;
        window.__backend.handlers.plugin_action = args => new Promise(resolve => { window.__release = () => resolve(original(args)); });
    });
    const list = page.locator('app-plugin-page webui-reorder.plugin-reorder');
    await page.locator('app-plugin-page .plugin-reorder-item[data-id="id-0"] .plugin-reorder-handle').focus();
    await page.keyboard.press('Alt+ArrowDown');
    await page.clock.runFor(1000);
    await expect.poll(() => page.evaluate(() => typeof window.__release)).toBe('function');
    await expect(list).toHaveAttribute('disabled', '');
    await page.evaluate(() => window.__release());
    await expect(list).not.toHaveAttribute('disabled', /.*/);
    await expect(actionNote(page.locator('app-plugin-page'), 'Order saved.')).toHaveCount(1);
    await expect.poll(() => alerts(page)).toEqual([]);
});

test('a message from a dialog\'s action that refreshes the page is shown by its button, which stays', async ({ page }) => {
    await openPlugin(page, { type: 'button', action: action('show', 'Show') }, {
        pluginActions: {
            'test/show': { dialog: { title: 'Details', ui: { type: 'button', action: action('save', 'Save it') } } },
            'test/save': { refresh: true, message: { text: 'Saved it.', theme: 'success' } },
        },
    });
    await page.locator('app-plugin-page').getByText('Show').click();
    const dialog = page.locator('dialog.plugin-dialog');
    await dialog.getByText('Save it').click();
    await expect(actionNote(dialog, 'Saved it.')).toHaveCount(1);
    await expect.poll(() => alerts(page)).toEqual([]);
});

test('a message from an action that opens a dialog goes to the app\'s alerts, not behind the dialog', async ({ page }) => {
    await openPlugin(page, { type: 'button', action: action('show', 'Show') }, {
        pluginActions: { 'test/show': { dialog: { title: 'Details', ui: text('In the dialog') }, message: { text: 'Opened it.' } } },
    });
    await page.locator('app-plugin-page').getByText('Show').click();
    await expect(page.getByText('In the dialog')).toBeVisible();
    await expect.poll(() => alerts(page)).toContain('Opened it.');
    await expect(actionNote(page.locator('app-plugin-page'), 'Opened it.')).toHaveCount(0);
});

test('a message from a dialog\'s action that opens another dialog goes to the app\'s alerts, since the dialog is drawn again', async ({ page }) => {
    await openPlugin(page, { type: 'button', action: action('show', 'Show') }, {
        pluginActions: {
            'test/show': { dialog: { title: 'First', ui: { type: 'button', action: action('next', 'Next') } } },
            'test/next': { dialog: { title: 'Second', ui: text('The second dialog') }, message: { text: 'Moved on.' } },
        },
    });
    await page.locator('app-plugin-page').getByText('Show').click();
    const dialog = page.locator('dialog.plugin-dialog');
    await dialog.getByText('Next').click();
    await expect(dialog).toContainText('The second dialog');
    await expect.poll(() => alerts(page)).toContain('Moved on.');
});

test('clicking what a row\'s action said, in its cell, does not run the row\'s action again', async ({ page }) => {
    await openPlugin(page, {
        type: 'table', columns: ['Key', 'Status'],
        rows: [{
            cells: [text('P-1'), { type: 'select', text: 'To Do', options: action('cell.options', 'Change Status'), action: action('cell.set', 'Change Status') }],
            action: action('open', 'Open P-1'),
        }],
    }, { pluginActions: { 'test/cell.options': { options: [] }, 'test/open': {} } });
    const view = page.locator('app-plugin-page');
    await view.locator('.plugin-select').click();
    const note = actionNote(view.locator('td'), 'There is nothing to change it to.');
    await expect(note).toHaveCount(1);
    await note.click();
    await expect.poll(async () => (await calls(page, 'plugin_action')).map(call => call.request.action)).toEqual(['cell.options']);
    // The row itself still runs its action, so a click that would have reached it is seen.
    await view.locator('td').first().click();
    await expect.poll(async () => (await calls(page, 'plugin_action')).map(call => call.request.action)).toEqual(['cell.options', 'open']);
});

test('an open page is drawn again by the plugin as updated, without reloading the app', async ({ page }) => {
    await openPlugin(page, text('Old feature'));
    await page.evaluate(() => { window.__backend.handlers.plugin_render = () => ({ type: 'text', text: 'New feature' }); });
    // As Rust says when the plugin is updated, here or on another screen.
    await emit(page, 'plugins-changed', { id: 'test' });
    await expect(page.locator('app-plugin-page')).toHaveText('New feature');
});

test("an updated plugin's pages drawn before are not shown again from the old code", async ({ page }) => {
    await openPlugin(page, text('Old home'), { pluginPages: { 'test/item': text('Item page') } });
    await goToPage(page, '/plugin/test/item');
    await expect(page.locator('app-plugin-page')).toHaveText('Item page');
    await page.evaluate(() => {
        window.__held = new Promise(resolve => { window.__release = resolve; });
        window.__backend.handlers.plugin_render = async () => { await window.__held; return { type: 'text', text: 'New home' }; };
    });
    await emit(page, 'plugins-changed', { id: 'test' });
    await goToPage(page, '/plugin/test/home');
    // The old home page was cached, and would show at once while the plugin answered.
    await expect(page.locator('app-plugin-page')).toContainText('Loading');
    await expect(page.locator('app-plugin-page')).not.toContainText('Old home');
    await page.evaluate(() => window.__release());
    await expect(page.locator('app-plugin-page')).toHaveText('New home');
});
