import { test, expect, openApp, calls, dialogButton, onCommand, openDialog } from '../../support/app.mjs';

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

    test('another page opened beside leaves, says Loading Content in the middle of its side, and comes in once loaded', async ({ page }) => {
        await openBeside(page);
        // The next item is slow to load.
        await onCommand(page, 'plugin_render', ({ page, params }) => page !== 'item' ? window.__list
            : params.key === 'P-1' ? { type: 'text', text: 'Item P-1' }
                : new Promise(resolve => { window.__answer = () => resolve({ type: 'text', text: `Item ${params.key}` }); }));
        await side(page).evaluate(node => {
            window.__classes = new Set();
            new MutationObserver(() => node.classList.forEach(name => window.__classes.add(name))).observe(node, { attributeFilter: ['class'] });
        });
        await link(page, 'P-2').click();
        const loading = side(page).locator('.plugin-loading');
        await expect(loading).toHaveText(/^Loading Content/);
        await expect(side(page)).not.toContainText('Item P-1');
        await expect(loading).toHaveAttribute('role', 'status');
        // Centered in the side, below its tools.
        const box = await loading.boundingBox();
        const pane = await split(page).locator('[slot="end"]').boundingBox();
        expect(box.height).toBeGreaterThan(pane.height / 2);
        expect(Math.abs((box.x + box.width / 2) - (pane.x + pane.width / 2))).toBeLessThan(pane.width * 0.1);
        await expect.poll(() => page.evaluate(() => typeof window.__answer)).toBe('function');
        await page.evaluate(() => window.__answer());
        await expect(side(page)).toContainText('Item P-2');
        await expect(loading).toHaveCount(0);
        // It left and came in as Web UI pages do.
        expect(await page.evaluate(() => [...window.__classes].sort())).toEqual(expect.arrayContaining(['plugin-entering', 'plugin-leaving']));
        // The list it is beside stayed as it was.
        await expect(split(page).locator('[slot="start"] table')).toBeVisible();
    });

    test('too narrow for both, the side page covers the page, with a button back to each', async ({ page }) => {
        await openBeside(page, 900);
        await expect(split(page)).toHaveAttribute('narrow', '');
        await split(page).getByRole('button', { name: 'Test Home' }).click();
        await expect(split(page)).toHaveAttribute('show', 'start');
        await expect(side(page)).toBeHidden();
        await link(page, 'P-2').click();
        await expect(split(page)).toHaveAttribute('show', 'end');
        await expect(side(page)).toContainText('Item P-2');
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
        // The order is sent a moment after it settles, so the test moves the page's clock past that.
        await page.clock.install();
        await openPlugin(page, list, { pluginActions: { 'test/order': { refresh: true }, 'test/remove': {} } });
        const rows = page.locator('app-plugin-page .plugin-reorder-item');
        await expect(rows).toHaveCount(3);
        await expect(rows.first()).toContainText('Key');
        // The drag starts once the mouse moves, as on user pages and in the navigation manager.
        const from = await rows.nth(2).boundingBox();
        const to = await rows.nth(0).boundingBox();
        await page.mouse.move(from.x + 10, from.y + from.height / 2);
        await page.mouse.down();
        await page.mouse.move(from.x + 10, to.y + 2, { steps: 8 });
        await page.mouse.up();
        await expect(rows.first()).toContainText('Parent story points');
        await page.clock.runFor(1000);
        await expect.poll(() => orders(page)).toEqual([['id-2', 'id-0', 'id-1']]);
        // A click on an item's own link still runs it, and is not a move.
        await rows.nth(1).locator('a', { hasText: '✕' }).click();
        await expect.poll(async () => (await calls(page, 'plugin_action')).map(call => call.request.action)).toContain('remove');
        // Had the click moved anything, its order would be sent by now.
        await page.clock.runFor(1000);
        await expect.poll(() => orders(page)).toHaveLength(1);
    });

});

test.describe('spec 0.1.3', () => {
    // A 1x1 PNG.
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    test('markdown images show a larger copy while hovered, and open in a dialog to copy', async ({ page, context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.setViewportSize({ width: 1400, height: 900 });
        // A wide screenshot, as Jira descriptions have.
        await openPlugin(page, text('Description'));
        const shot = await page.evaluate(() => {
            const canvas = document.createElement('canvas');
            canvas.width = 1200;
            canvas.height = 700;
            canvas.getContext('2d').fillRect(0, 0, 1200, 700);
            return canvas.toDataURL('image/jpeg');
        });
        await page.evaluate(shot => document.querySelector('app-plugin-page').draw({ type: 'markdown', text: 'Steps\n\n1. ![Shot](attachment-1)', images: { 'attachment-1': shot } }), shot);
        const image = page.locator('app-plugin-page .plugin-markdown img');
        await expect(image).toBeVisible();
        await image.hover();
        const hover = page.locator('.plugin-image-hover');
        await expect(hover).toBeVisible();
        await expect(hover).toHaveAttribute('src', shot);
        // All of it shows inside the window. How large it is, is checked by eye.
        await expect(hover).toBeInViewport({ ratio: 1 });
        // Something else scrolling, such as a terminal's output, leaves the preview showing.
        await page.evaluate(() => {
            const other = document.createElement('div');
            other.id = 'other-scroller';
            other.style.cssText = 'position:fixed;bottom:0;right:0;width:100px;height:50px;overflow:auto';
            other.innerHTML = '<div style="height:500px"></div>';
            document.body.appendChild(other);
            other.scrollTop = 200;
        });
        await expect.poll(() => page.evaluate(() => document.querySelector('#other-scroller').scrollTop)).toBe(200);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expect(hover).toBeVisible();
        await page.mouse.move(0, 0);
        await expect(hover).toHaveCount(0);
        await image.click();
        const full = page.locator('.plugin-image-full');
        await expect(full).toBeVisible();
        await expect(full).toHaveAttribute('src', /^blob:/);
        await expect(full).toBeInViewport();
        await expect(hover).toHaveCount(0);
        // Copied through Rust, which puts it on the system clipboard.
        await page.locator('.plugin-image-copy').click();
        await expect.poll(() => alerts(page)).toContain('Copied the image.');
        const copied = await page.evaluate(async () => {
            const bitmap = await createImageBitmap(new Blob([new Uint8Array(window.__backend.clipboard.bytes)]));
            return { width: bitmap.width, height: bitmap.height };
        });
        expect(copied).toEqual({ width: 1200, height: 700 });
        await expect(openDialog(page)).toBeVisible();
    });

});
