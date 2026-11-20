import { test, expect, openApp, openTool, runEnds, calls } from '../../support/app.mjs';

// The header's Tools button (wc/tools.js): the right drawer with a tab for each tool, and counts of what needs notice.
const drawer = page => page.locator('webui-drawer.shared');
const tabs = page => drawer(page).locator('webui-button.tools-tab');
const toolsCount = page => page.locator('header app-tools webui-icon.tools-icon');
const tabCount = (page, id) => drawer(page).locator(`webui-button.tools-tab-${id} webui-badge`);

// One test for each tab, so a busy machine opening the app for each one never runs a single test past its time.
const TOOL_CHECKS = {
    tasks: tab => expect(tab.locator('.task-manager-body')).toBeAttached(),
    variables: tab => expect(tab.locator('#env-selector')).toBeAttached(),
    alerts: tab => expect(tab.locator('webui-alerts[panel]')).toContainText('You have no alerts at this time.'),
    plugins: tab => expect(tab.locator('app-plugin-manager')).toBeAttached(),
    icons: tab => expect(tab.locator('webui-icon-search')).toBeAttached(),
    theme: tab => expect(tab.locator('webui-theme-selector[panel] button[data-theme-value="midnight"]')).toHaveText(/Midnight/),
    accessibility: tab => expect(tab.locator('.accessibility-panel')).toBeAttached(),
    account: tab => expect(tab.locator('app-account-panel app-account')).toBeAttached(),
};
for (const [id, check] of Object.entries(TOOL_CHECKS)) {
}

test('the tabs can be dragged into the user\'s own order, which is kept, and the tool shown stays shown', async ({ page }) => {
    await openApp(page);
    await openTool(page, 'plugins');
    const from = await drawer(page).locator('webui-button.tools-tab-theme').boundingBox();
    const to = await drawer(page).locator('webui-button.tools-tab-terminals').boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 - 10, from.y + from.height / 2, { steps: 3 });
    await page.mouse.move(to.x + 3, to.y + to.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => tabs(page).evaluateAll(list => list.map(tab => tab.dataset.tool))).toEqual(['theme', 'terminals', 'tasks', 'variables', 'alerts', 'plugins', 'icons', 'accessibility', 'account']);
    await expect(drawer(page).locator('webui-content.tools-plugins app-plugin-manager')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__backend.appData.data['app-tools-order'])).toEqual(['theme', 'terminals', 'tasks', 'variables', 'alerts', 'plugins', 'icons', 'accessibility', 'account']);
    // Each tab still opens its own tool where it is now, and the order is the same when Tools is built again.
    await drawer(page).locator('webui-button.tools-tab-theme').click();
    await expect(drawer(page).locator('webui-content.tools-theme webui-theme-selector[panel]')).toBeVisible();
    // An order saved before the Accessibility and Account tabs existed gets them at its end.
    await openApp(page, { appData: { 'app-tools-order': ['theme', 'terminals', 'tasks', 'variables', 'alerts', 'plugins', 'icons'] } });
    await page.locator('header app-tools').click();
    await expect.poll(() => tabs(page).evaluateAll(list => list.map(tab => tab.dataset.tool))).toEqual(['theme', 'terminals', 'tasks', 'variables', 'alerts', 'plugins', 'icons', 'accessibility', 'account']);
});

