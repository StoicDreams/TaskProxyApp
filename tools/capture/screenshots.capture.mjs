import { test, expect, openApp } from '../../tests/support/app.mjs';
import { demoState, PAGE_IDS, testRunOutput } from './demo.mjs';
import { hideOverlays, scriptOutput, shot } from './helpers.mjs';

// Lets component transitions finish before a screenshot.
const settle = page => page.waitForTimeout(1200);
const git = page => page.locator('app-git-manager');
const openGit = async (page, state = {}) => {
    await openApp(page, demoState({ currentPage: '/git-controller', ...state }), '/git-controller');
    await git(page).locator('.files button.file').first().waitFor();
    await settle(page);
};
const gitTab = (page, name) => expect(async () => {
    await git(page).locator('webui-button[slot="tabs"]', { hasText: name }).click();
    await expect(git(page).locator('webui-button[slot="tabs"][theme="active"]', { hasText: name })).toBeVisible({ timeout: 1000 });
}).toPass({ timeout: 10000 });
const openDrawer = async (page, tag) => {
    await page.locator(tag).click();
    await settle(page);
};
/** Opens the Script Manager on the test script, with its parameters filled in. */
export const openScriptManager = async p => {
    await openApp(p, demoState({ currentPage: '/script-manager' }), '/script-manager');
    const params = p.locator('app-script-manager .params-container');
    const preview = p.locator('app-script-manager app-script-runner webui-code').first();
    // The script loads after the page, which rebuilds the inputs, so fill until the command shows the values.
    await expect(async () => {
        await params.locator('[data-param="Suite"] input').fill('e2e', { timeout: 1000 });
        await params.locator('[data-param="Filter"] input').fill('checkout', { timeout: 1000 });
        expect(await preview.evaluate(node => node.value)).toContain('-Filter "checkout"');
    }).toPass({ timeout: 15000 });
    await settle(p);
};
/** Shows a terminal in the open Terminal Manager. */
export const showTerminal = async (p, id) => {
    await expect.poll(() => p.evaluate(id => !!webui.proxy.terminalHelpers.getState().terminals[id], id)).toBe(true);
    await p.evaluate(id => document.querySelector('app-terminals').switchTerminal(id), id);
};
const page = (id, state = {}) => demoState({ currentPage: `/${id}`, ...state });

test('first run asks for a security key', async ({ page: p }) => {
    await openApp(p, { ...demoState(), project: null, projects: [], hasKey: false, newInstall: true }, '/');
    await p.locator('app-security-key-setter').waitFor();
    await settle(p);
    await shot(p, 'first-run-security-key');
});

test('adding the first project', async ({ page: p }) => {
    await openApp(p, { ...demoState(), project: null, projects: [] }, '/');
    await p.locator('app-add-project').waitFor();
    await settle(p);
    await shot(p, 'add-first-project');
});

test('git controller with changes and a diff', async ({ page: p }) => {
    await openGit(p);
    await shot(p, 'git-changes');
});

test('git controller ready to commit', async ({ page: p }) => {
    await openGit(p);
    await git(p).locator('webui-input-message[label="Commit Message"] textarea').fill('Apply cart discounts\nFeature: Discounts lower the cart total, never below zero\nBug: Quantities were left out of the cart total');
    await git(p).locator('.files .file-row[data-path="src/nav.json"] select.include').selectOption({ label: 'Exclude' });
    await git(p).locator('.files button.file[title="README.md"]').click();
    await settle(p);
    await shot(p, 'git-commit-ready');
});

test('git branches', async ({ page: p }) => {
    await openGit(p);
    await gitTab(p, 'Branches');
    await settle(p);
    await shot(p, 'git-branches');
});

test('git authentication', async ({ page: p }) => {
    await openGit(p);
    await gitTab(p, 'Auth');
    await settle(p);
    await shot(p, 'git-auth');
});

test('script manager with parameters', async ({ page: p }) => {
    await openScriptManager(p);
    await shot(p, 'script-manager');
});

test('terminal output', async ({ page: p }) => {
    await p.setViewportSize({ width: 1440, height: 1300 });
    await openScriptManager(p);
    await scriptOutput(p, testRunOutput);
    await p.locator('app-script-manager webui-button[label="Run"]').first().click();
    await openDrawer(p, 'app-terminals');
    await showTerminal(p, '.taskproxy/scripts/test.ps1');
    await p.waitForTimeout(3000);
    // The run's time would differ on every capture, so it is set to one that suits the output, to keep the image the same.
    await p.evaluate(id => {
        const term = webui.proxy.terminalHelpers.getState().terminals[id];
        term.startedAt = term.endedAt - 4627;
        document.querySelector('app-terminals').renderStatus();
    }, '.taskproxy/scripts/test.ps1');
    await expect(p.locator('#term-status')).toHaveText('Finished 00:00:04.627');
    await hideOverlays(p);
    await shot(p, 'terminal-output', { locator: p.locator('webui-drawer.shared') });
});

test('a team page with scripts', async ({ page: p }) => {
    await openApp(p, page(PAGE_IDS.onboarding), `/${PAGE_IDS.onboarding}`);
    await p.locator('app-page-handler > app-markdown-segment').first().waitFor();
    await settle(p);
    await shot(p, 'page-onboarding');
});

test('running a page script asks first', async ({ page: p }) => {
    await openApp(p, page(PAGE_IDS.onboarding), `/${PAGE_IDS.onboarding}`);
    await p.locator('webui-icon.run-script-btn').nth(1).waitFor();
    await settle(p);
    await p.locator('webui-icon.run-script-btn').nth(1).click();
    await p.locator('dialog[open]').waitFor();
    await settle(p);
    await shot(p, 'page-script-confirm');
});

test('editing a page segment', async ({ page: p }) => {
    await openApp(p, page(PAGE_IDS.release), `/${PAGE_IDS.release}`);
    const segment = p.locator('app-page-handler > app-markdown-segment').nth(1);
    await segment.waitFor();
    await settle(p);
    await segment.locator('webui-button, button, webui-icon').first().click();
    await settle(p);
    await shot(p, 'page-edit-segment');
});

test('navigation manager', async ({ page: p }) => {
    await openApp(p, demoState({ currentPage: '/nav-manager' }), '/nav-manager');
    await p.locator('app-nav-manager').waitFor();
    await p.waitForTimeout(2500);
    await shot(p, 'nav-manager');
});

test('docs manager', async ({ page: p }) => {
    await openApp(p, demoState({ currentPage: '/docs' }), '/docs');
    await p.locator('app-doc-manager').waitFor();
    await p.waitForTimeout(2000);
    await shot(p, 'docs-manager');
});

test('project variables and environments', async ({ page: p }) => {
    await openApp(p, page(PAGE_IDS.onboarding), `/${PAGE_IDS.onboarding}`);
    await p.locator('app-page-handler > app-markdown-segment').first().waitFor();
    await openDrawer(p, 'app-var-manager');
    await p.locator('#var-project-list').waitFor({ state: 'attached' });
    await settle(p);
    await shot(p, 'variables-project');
});

test('global secrets', async ({ page: p }) => {
    await openApp(p, page(PAGE_IDS.onboarding), `/${PAGE_IDS.onboarding}`);
    await p.locator('app-page-handler > app-markdown-segment').first().waitFor();
    await openDrawer(p, 'app-var-manager');
    await expect(async () => {
        await p.locator('webui-drawer.shared webui-button[slot="tabs"]', { hasText: 'Global' }).click();
        await expect(p.locator('#var-global-list')).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 10000 });
    await settle(p);
    await shot(p, 'variables-global');
});

test('settings', async ({ page: p }) => {
    await openApp(p, demoState(), '/');
    await p.locator('app-update-manager').waitFor();
    await settle(p);
    await shot(p, 'settings');
});
