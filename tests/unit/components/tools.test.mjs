import { test, expect, openApp, openTool, runEnds, calls } from '../support/app.mjs';

// The header's Tools button (wc/tools.js): the right drawer with a tab for each tool, and counts of what needs notice.
const drawer = page => page.locator('webui-drawer.shared');
const tabs = page => drawer(page).locator('webui-button.tools-tab');
const toolsCount = page => page.locator('header app-tools webui-icon.tools-icon');
const tabCount = (page, id) => drawer(page).locator(`webui-button.tools-tab-${id} webui-badge`);

test('the header keeps Save and Feedback, and Tools takes the place of the other buttons and the sign-in', async ({ page }) => {
    await openApp(page);
    const header = page.locator('webui-app > header');
    await expect(header.locator('app-save-button')).toBeVisible();
    await expect(header.locator('webui-feedback')).toBeVisible();
    await expect(header.getByRole('button', { name: 'Tools', exact: true })).toBeVisible();
    for (const tool of ['app-terminals', 'app-task-manager', 'app-var-manager', 'webui-alerts', 'app-plugins-drawer', 'app-icon-drawer', 'webui-theme-selector', 'app-accessibility']) {
        await expect(header.locator(tool)).toBeHidden();
    }
    await expect(header.locator('app-account')).toHaveCount(0);
});

test('Tools opens the right drawer with a tab for each tool, on Terminals the first time', async ({ page }) => {
    await openApp(page);
    await page.locator('header app-tools').click();
    await expect(drawer(page)).toHaveClass(/open/);
    await expect(drawer(page).getByRole('heading', { name: 'Tools' })).toHaveCount(1);
    // Each tab is its icon, named by its tooltip.
    const names = ['Terminals', 'Task Manager', 'Variables', 'Alerts', 'Plugins', 'Icons & Emojis', 'Theme', 'Accessibility', 'Account'];
    await expect.poll(() => tabs(page).evaluateAll(list => list.map(tab => tab.getAttribute('title')))).toEqual(names);
    for (const name of names) await expect(drawer(page).getByRole('button', { name, exact: true })).toHaveCount(1);
    await expect(drawer(page).locator('webui-content.tools-terminals #term-content-wrapper, webui-content.tools-terminals #term-install-wrapper').first()).toBeAttached();
});

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
    test(`the ${id} tab shows its tool`, async ({ page }) => {
        await openApp(page);
        await check(await openTool(page, id));
    });
}

test('the tab last shown opens next time', async ({ page }) => {
    await openApp(page);
    await openTool(page, 'plugins');
    await drawer(page).locator('[slot="footer"] .drawer-close').click();
    await expect(drawer(page)).not.toHaveClass(/open/);
    await page.locator('header app-tools').click();
    await expect(drawer(page).locator('webui-content.tools-plugins app-plugin-manager')).toBeVisible();
});

test('the Task Manager reads processes only while its tab shows', async ({ page }) => {
    await openApp(page);
    await openTool(page, 'tasks');
    await expect.poll(async () => (await calls(page, 'list_processes')).length).toBeGreaterThan(0);
    await openTool(page, 'alerts');
    await expect.poll(async () => (await calls(page, 'close_task_manager')).length).toBeGreaterThan(0);
});

test('the button counts running scripts and alerts, and each tab its own', async ({ page }) => {
    await openApp(page);
    await expect(toolsCount(page)).not.toHaveAttribute('count', /\d/);
    await page.evaluate(() => webui.proxy.terminalHelpers.runScript('a.ps1', 'body', [], false, false));
    await expect(toolsCount(page)).toHaveAttribute('count', '1');
    await page.evaluate(() => webui.alert('Look here', 'info'));
    await expect(toolsCount(page)).toHaveAttribute('count', '2');
    await openTool(page, 'alerts');
    await expect(tabCount(page, 'terminals')).toHaveText('1');
    await expect(tabCount(page, 'alerts')).toHaveText('1');
    await expect(tabCount(page, 'tasks')).toBeHidden();
    await runEnds(page, { projectId: 'project-id', terminalId: 'a.ps1', code: 0 });
    await expect(toolsCount(page)).toHaveAttribute('count', '1');
    await expect(tabCount(page, 'terminals')).toBeHidden();
});

test("a page's variables are counted on the Variables tab", async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('app-page-variables', { detail: 3 })));
    await openTool(page, 'variables');
    await expect(tabCount(page, 'variables')).toHaveText('3');
    // Page variables are not something to notice, so the button does not count them.
    await expect(toolsCount(page)).not.toHaveAttribute('count', /\d/);
});

test('a script started elsewhere opens Terminals on its running scripts, and a plugin link opens Plugins on that plugin', async ({ page }) => {
    const jira = { id: 'jira', name: 'Jira', version: '0.1.0', apiVersion: 1, permissions: { variables: [{ key: 'jira_site', label: 'Jira site' }] }, pages: [] };
    await openApp(page, { plugins: [{ id: 'jira', version: '0.1.0', enabled: true, signed: true, manifest: jira }] });
    await page.evaluate(() => document.querySelector('app-terminals').openDrawer({ run: true }));
    await expect(drawer(page).locator('webui-content.tools-terminals')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.querySelector('app-terminals').filter())).toBe('Running');
    await page.evaluate(() => document.querySelector('app-plugins-drawer').open('jira'));
    await expect(drawer(page).locator('webui-content.tools-plugins .plugin-detail [data-plugin="jira"]')).toHaveClass(/plugin-highlight/);
});

test('the drawers can move between left and right, but not to the top or bottom', async ({ page }) => {
    await openApp(page);
    for (const name of ['nav', 'shared']) {
        await expect.poll(() => page.locator(`webui-drawer.${name} [slot="footer"] button[data-setattr]`).evaluateAll(list => list.map(b => b.className))).toEqual(['toggle-pos-left', 'toggle-pos-right']);
    }
});

test('docked, the drawer stays docked on Tools after the app reloads', async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await openApp(page);
    await openTool(page, 'variables');
    await drawer(page).locator('[slot="footer"] webui-toggle-icon').click();
    await expect(drawer(page)).toHaveAttribute('docked', 'true');
    await page.reload();
    await page.waitForFunction(() => typeof webui === 'object' && webui.proxy && webui.proxy.projects?.isLoaded);
    await expect(drawer(page)).toHaveAttribute('docked', 'true');
    // It comes back showing Tools on the tab last shown, rather than empty.
    await expect(drawer(page).locator('webui-content.tools-variables #env-selector')).toBeVisible();
});
test('the Theme tab is drawn once and kept, so it shows at once when opened again', async ({ page }) => {
    await openApp(page);
    const theme = await openTool(page, 'theme');
    await expect(theme.locator('webui-theme-selector[panel] button[data-theme-value="midnight"]')).toHaveText(/Midnight/);
    await theme.locator('webui-theme-selector[panel]').evaluate(el => { el.dataset.first = 'true'; });
    await openTool(page, 'account');
    await openTool(page, 'theme');
    await expect(theme.locator('webui-theme-selector[panel]')).toHaveCount(1);
    await expect(theme.locator('webui-theme-selector[panel][data-first]')).toHaveCount(1);
});

test('a tool opened before its component has loaded draws once it loads', async ({ page }) => {
    // The Task Manager's file is held, as on a slow machine where the tab is opened before the loader has it.
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await page.route('**/wc/task-manager.min.js', async route => {
        await held;
        await route.continue();
    });
    await openApp(page);
    await openTool(page, 'tasks');
    const table = drawer(page).locator('webui-content.tools-tasks .task-manager tbody');
    await expect(table).toHaveCount(0);
    release();
    await expect(table).toBeAttached();
    await expect.poll(async () => (await calls(page, 'list_processes')).length).toBeGreaterThan(0);
});
