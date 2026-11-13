import { test, expect, openApp } from '../../tests/support/app.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { demoState, PAGE_IDS, testRunOutput } from './demo.mjs';
import { clickOn, loop, moveTo, parkMouse, prepare, scriptOutput, typeInto } from './helpers.mjs';

// Short looping videos for TaskProxy.com, in place of screenshots: each shows one action from start to finish,
// and ends on the result, which is also its poster. Saved as video/loops/<name>.mp4 and .webp.
// The website shows them with webui-loop-video, which plays them muted on a loop while they are on screen.

// Each recording starts from a fresh browser, so several can be captured at once (see playwright.config.mjs).
test.describe.configure({ mode: 'parallel' });

const settle = page => page.waitForTimeout(1200);
const open = async (page, route, state = {}) => {
    await prepare(page);
    await openApp(page, demoState({ currentPage: route, ...state }), route);
    await settle(page);
    await parkMouse(page);
};
const git = page => page.locator('app-git-manager');
const gitTab = async (page, name) => {
    const tab = git(page).locator('webui-button[slot="tabs"]', { hasText: name });
    await clickOn(page, tab, { after: 300 });
    await expect(async () => {
        if (!await git(page).locator('webui-button[slot="tabs"][theme="active"]', { hasText: name }).count()) await tab.click();
        await expect(git(page).locator('webui-button[slot="tabs"][theme="active"]', { hasText: name })).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 10000 });
};
const openGit = async (page, state = {}) => {
    await open(page, '/git-controller', state);
    await git(page).locator('.files button.file').first().waitFor();
    await settle(page);
};

test.describe('tutorials', () => {
    test('first run asks for a security key', async ({ page }) => {
        await prepare(page);
        await openApp(page, { ...demoState(), project: null, projects: [], hasKey: false, newInstall: true }, '/');
        const setter = page.locator('app-security-key-setter');
        await setter.waitFor();
        await settle(page);
        await parkMouse(page);
        await loop(page, 'first-run-security-key', async () => {
            await clickOn(page, setter.locator('webui-button', { hasText: 'Generate Key' }), { after: 1200 });
            await moveTo(page, setter.locator('webui-button', { hasText: 'Save' }));
        });
    });

    test('adding the first project', async ({ page }) => {
        await prepare(page);
        await openApp(page, { ...demoState(), project: null, projects: [] }, '/');
        const add = page.locator('app-add-project');
        await add.waitFor();
        await settle(page);
        await parkMouse(page);
        await loop(page, 'add-first-project', async () => {
            await typeInto(page, add.locator('webui-input-text[label="Project Name"] input'), 'Acme Storefront', { delay: 70 });
            await page.waitForTimeout(400);
            await moveTo(page, add.locator('webui-button', { hasText: 'Select Project Folder' }));
        });
    });

    test('git controller with changes and a diff', async ({ page }) => {
        await openGit(page);
        await loop(page, 'git-changes', async () => {
            await clickOn(page, git(page).locator('.files button.file[title="README.md"]'), { after: 1200 });
            await clickOn(page, git(page).locator('.files button.file[title="src/cart.js"]'), { after: 1500 });
        });
    });

    test('git controller ready to commit', async ({ page }) => {
        await openGit(page);
        await clickOn(page, git(page).locator('.files button.file[title="README.md"]'), { after: 600 });
        await parkMouse(page);
        await loop(page, 'git-commit-ready', async () => {
            const include = git(page).locator('.files .file-row[data-path="src/nav.json"] select.include');
            await moveTo(page, include);
            await page.waitForTimeout(300);
            await include.selectOption({ label: 'Exclude' });
            await page.waitForTimeout(900);
            await typeInto(page, git(page).locator('webui-input-message[label="Commit Message"] textarea'),
                'Apply cart discounts\nFeature: Discounts lower the cart total, never below zero\nBug: Quantities were left out of the cart total', { delay: 22 });
            await moveTo(page, git(page).locator('webui-button[label="Commit"]'));
        });
    });

    test('git branches', async ({ page }) => {
        await openGit(page);
        await loop(page, 'git-branches', async () => {
            await gitTab(page, 'Branches');
            await page.waitForTimeout(900);
            await moveTo(page, git(page).locator('webui-button.btn-new').first());
            await page.waitForTimeout(600);
            await moveTo(page, git(page).locator('webui-button.btn-switch').first());
        });
    });

    test('git authentication', async ({ page }) => {
        await openGit(page);
        await loop(page, 'git-auth', async () => {
            await gitTab(page, 'Auth');
            await page.waitForTimeout(900);
            const input = git(page).locator('input[type="password"], webui-input-text input').first();
            await typeInto(page, input, 'ghp_example_token_for_this_demo', { delay: 35 });
        });
    });

    test('script manager with parameters', async ({ page }) => {
        await open(page, '/script-manager');
        const params = page.locator('app-script-manager .params-container');
        await params.locator('[data-param="Suite"] input').waitFor();
        await settle(page);
        await loop(page, 'script-manager', async () => {
            await typeInto(page, params.locator('[data-param="Suite"] input'), 'e2e', { delay: 90 });
            await typeInto(page, params.locator('[data-param="Filter"] input'), 'checkout', { delay: 80 });
            await moveTo(page, page.locator('app-script-manager webui-button[label="Run"]').first());
        });
    });

    test('terminal output', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await open(page, '/script-manager');
        const manager = page.locator('app-script-manager');
        await manager.locator('.params-container [data-param="Suite"] input').fill('e2e');
        await scriptOutput(page, testRunOutput);
        await settle(page);
        await loop(page, 'terminal-output', async () => {
            await clickOn(page, manager.locator('webui-button[label="Run"]').first(), { after: 500 });
            await clickOn(page, page.locator('app-terminals'), { after: 900 });
            await expect.poll(() => page.evaluate(() => !!webui.proxy.terminalHelpers.getState().terminals['.taskproxy/scripts/test.ps1'])).toBe(true);
            await page.evaluate(() => document.querySelector('app-terminals').switchTerminal('.taskproxy/scripts/test.ps1'));
            await expect(page.locator('#term-status')).toContainText('Finished', { timeout: 20000 });
        });
    });

    test('a team page with scripts', async ({ page }) => {
        await open(page, `/${PAGE_IDS.onboarding}`);
        await page.locator('webui-icon.run-script-btn').first().waitFor();
        await settle(page);
        await loop(page, 'page-onboarding', async () => {
            await moveTo(page, page.locator('webui-icon.run-script-btn').first());
            await page.waitForTimeout(900);
            await moveTo(page, page.locator('webui-icon.run-script-btn').nth(1));
            await page.waitForTimeout(900);
        });
    });

    test('running a page script asks first', async ({ page }) => {
        await open(page, `/${PAGE_IDS.onboarding}`);
        await page.locator('webui-icon.run-script-btn').nth(1).waitFor();
        await settle(page);
        await loop(page, 'page-script-confirm', async () => {
            await clickOn(page, page.locator('webui-icon.run-script-btn').nth(1), { after: 400 });
            await page.locator('dialog[open]').waitFor();
            await page.waitForTimeout(700);
            await moveTo(page, page.getByText('Trust Project & Run'));
        });
    });

    test('editing a page segment', async ({ page }) => {
        await open(page, `/${PAGE_IDS.release}`);
        const segment = page.locator('app-page-handler > app-markdown-segment').nth(1);
        await segment.waitFor();
        await settle(page);
        await loop(page, 'page-edit-segment', async () => {
            await clickOn(page, segment.locator('#btn-edit'), { after: 900 });
            const input = segment.getByRole('textbox').first();
            await clickOn(page, input, { after: 200 });
            await page.keyboard.press('ControlOrMeta+End');
            await page.keyboard.type('\n\nTag the release once every check passes.', { delay: 30 });
            await page.waitForTimeout(600);
        });
    });

    test('navigation manager', async ({ page }) => {
        await open(page, '/nav-manager');
        const nav = page.locator('app-nav-manager');
        await nav.locator('webui-button[label="Add Page"]').waitFor();
        await page.waitForTimeout(1500);
        await loop(page, 'nav-manager', async () => {
            await clickOn(page, nav.locator('webui-button[label="Add Page"]'), { after: 800 });
            const name = nav.locator('webui-input-text[label="Name"] input');
            await clickOn(page, name, { after: 200 });
            await page.keyboard.press('ControlOrMeta+a');
            await page.keyboard.type('Database Reset', { delay: 60 });
            await page.waitForTimeout(500);
            await moveTo(page, nav.locator('webui-button[label="Save"]'));
        });
    });

    test('docs manager', async ({ page }) => {
        await open(page, '/docs');
        const docs = page.locator('app-doc-manager');
        const editor = docs.locator('webui-input-message textarea');
        await editor.waitFor();
        await page.waitForTimeout(1500);
        await loop(page, 'docs-manager', async () => {
            await clickOn(page, editor, { after: 200 });
            await page.keyboard.press('ControlOrMeta+End');
            await page.keyboard.type('\n\n## Support\n\nAsk in **#storefront** on chat.', { delay: 35 });
            await page.waitForTimeout(800);
        });
    });

    test('project variables and environments', async ({ page }) => {
        await open(page, `/${PAGE_IDS.onboarding}`);
        await page.locator('app-page-handler > app-markdown-segment').first().waitFor();
        await settle(page);
        await loop(page, 'variables-project', async () => {
            await clickOn(page, page.locator('app-var-manager'), { after: 1400 });
            const env = page.locator('#env-selector');
            await env.waitFor({ state: 'attached' });
            await moveTo(page, env);
            await page.waitForTimeout(500);
            await env.evaluate(el => {
                el.value = 'staging';
                el.dispatchEvent(new Event('change', { bubbles: true }));
            });
            await page.waitForTimeout(1500);
            await env.evaluate(el => {
                el.value = 'dev';
                el.dispatchEvent(new Event('change', { bubbles: true }));
            });
            await page.waitForTimeout(800);
        });
    });

    test('global secrets', async ({ page }) => {
        await open(page, `/${PAGE_IDS.onboarding}`);
        await page.locator('app-page-handler > app-markdown-segment').first().waitFor();
        await settle(page);
        await loop(page, 'variables-global', async () => {
            await clickOn(page, page.locator('app-var-manager'), { after: 1400 });
            const tab = page.locator('webui-drawer.shared webui-button[slot="tabs"]', { hasText: 'Global' });
            await clickOn(page, tab, { after: 300 });
            await expect(async () => {
                if (!await page.locator('#var-global-list').isVisible()) await tab.click();
                await expect(page.locator('#var-global-list')).toBeVisible({ timeout: 1000 });
            }).toPass({ timeout: 10000 });
            await page.waitForTimeout(1200);
        });
    });

    test('settings', async ({ page }) => {
        await open(page, '/');
        const updates = page.locator('app-update-manager');
        await updates.waitFor();
        await settle(page);
        await loop(page, 'settings', async () => {
            await updates.scrollIntoViewIfNeeded();
            await clickOn(page, updates.locator('webui-button', { hasText: 'Check for Updates' }), { after: 1500 });
        });
    });
});

/**
 * The Jira plugin draws its own screens for made-up data, which its publish script writes into the TaskProxyPlugins
 * checkout beside this repo (or TASKPROXY_PLUGINS_ROOT). They are read from there, so publishing a plugin never
 * changes this repo.
 */
const pluginsRoot = process.env.TASKPROXY_PLUGINS_ROOT
    ? new URL(`file://${process.env.TASKPROXY_PLUGINS_ROOT.replace(/\/?$/, '/')}`)
    : new URL('../../../TaskProxyPlugins/', import.meta.url);
const jiraRoot = new URL('plugins/jira/', pluginsRoot);
const hasJira = existsSync(new URL('demo/issues.json', jiraRoot));

test.describe('plugins', () => {
    test.skip(!hasJira, `The Jira demo screens were not found in ${jiraRoot.pathname}demo. Run scripts/publish.ps1 in TaskProxyPlugins, or set TASKPROXY_PLUGINS_ROOT.`);
    const read = url => JSON.parse(readFileSync(url, 'utf8'));
    const fixture = name => hasJira ? read(new URL(`demo/${name}.json`, jiraRoot)) : {};
    const jira = hasJira ? read(new URL('plugin.json', jiraRoot)) : {};
    const plugins = [{ id: 'jira', version: jira.version, enabled: true, signed: true, manifest: jira }];
    const dir = 'video/loops/jira';
    /** Opens a Jira page, whose screens come from the plugin's demo, chosen by page and params. */
    const openJira = async (page, path, extra = {}) => {
        const screens = {
            issues: fixture('issues'), all: fixture('all'), issue: fixture('issue'), views: fixture('views'), editor: fixture('view-editor'),
            added: fixture('view-editor-added'), create: fixture('create'), statusOptions: fixture('status-options'),
            comments: fixture('comments'), mentions: fixture('mentions'),
        };
        await open(page, path, { plugins, ...extra });
        await page.evaluate(screens => {
            const backend = window.__backend;
            backend.handlers.plugin_render = ({ page, params }) => {
                if (page === 'views') return params?.edit ? screens.editor : screens.views;
                return screens[page];
            };
            backend.handlers.plugin_action = ({ request }) => {
                const go = (page, params = {}) => ({ navigate: { page, params } });
                switch (request.action) {
                    case 'open': return go('issue', { key: request.params.key });
                    case 'list.search':
                    case 'list.sort': return go(request.page, {});
                    case 'cell.options': return screens.statusOptions;
                    case 'cell.comments': return screens.comments;
                    case 'users.suggest': return screens.mentions;
                    case 'views.edit': return go('views', { edit: '1' });
                    case 'draft.add': return { ui: screens.added };
                    default: return {};
                }
            };
        }, screens);
        await page.evaluate(() => document.querySelector('app-plugin-page')?.load());
        await expect(page.locator('app-plugin-page')).not.toContainText('Loading');
        await settle(page);
    };
    const view = page => page.locator('app-plugin-page');

    test('my issues', async ({ page }) => {
        await openJira(page, '/plugin/jira/issues');
        await loop(page, 'my-issues', async () => {
            const filters = view(page).locator('.plugin-form-actions webui-button', { hasText: 'Filters' });
            await clickOn(page, filters, { after: 1400 });
            await moveTo(page, view(page).locator('.plugin-panel[data-panel="list-filters"] .plugin-choices').nth(2));
            await page.waitForTimeout(600);
            await clickOn(page, filters, { after: 600 });
            await moveTo(page, view(page).locator('th.plugin-sortable', { hasText: 'Priority' }));
            await page.waitForTimeout(500);
            await moveTo(page, view(page).locator('tbody tr').nth(2).locator('.plugin-clip').first());
            await page.waitForTimeout(700);
        }, { dir });
    });

    test('change an issue in place', async ({ page }) => {
        await openJira(page, '/plugin/jira/issues');
        await loop(page, 'change-in-place', async () => {
            await clickOn(page, view(page).locator('tbody tr').first().locator('.plugin-select').first(), { after: 900 });
            await moveTo(page, page.locator('.plugin-menu [role="option"]').first());
            await page.waitForTimeout(400);
            await moveTo(page, page.locator('.plugin-menu [role="option"]').nth(1));
            await page.waitForTimeout(500);
            await page.keyboard.press('Escape');
            await page.waitForTimeout(400);
        }, { dir });
    });

    test('comments with mentions', async ({ page }) => {
        await openJira(page, '/plugin/jira/issues');
        await loop(page, 'comments', async () => {
            await clickOn(page, view(page).locator('tbody tr').first().locator('.plugin-clip-open').last(), { after: 1000 });
            const dialog = page.locator('dialog.plugin-dialog');
            await expect(dialog).toContainText('Design is in the Release Visibility doc');
            const box = dialog.locator('textarea[name="body"]');
            await typeInto(page, box, 'Ready for review @pr');
            await expect(page.locator('.plugin-menu [role="option"]').first()).toBeVisible();
            await page.waitForTimeout(700);
            await page.keyboard.press('Enter');
            await typeInto(page, box, 'can you take a look?');
            await page.waitForTimeout(900);
            await clickOn(page, dialog.locator('.plugin-dialog-close'), { after: 500 });
        }, { dir });
    });

    test('all issues', async ({ page }) => {
        await openJira(page, '/plugin/jira/all');
        await loop(page, 'all-issues', async () => {
            await clickOn(page, view(page).locator('.plugin-form-actions webui-button', { hasText: 'Filters' }), { after: 1200 });
            await moveTo(page, view(page).locator('.plugin-panel[data-panel="list-filters"] .plugin-choices').first());
            await page.waitForTimeout(800);
            await clickOn(page, view(page).locator('.plugin-form-actions webui-button', { hasText: 'Filters' }), { after: 600 });
        }, { dir });
    });

    test('an issue with its parents', async ({ page }) => {
        await openJira(page, '/plugin/jira/issues');
        await loop(page, 'issue', async () => {
            await clickOn(page, view(page).locator('tbody tr').first().locator('.plugin-link', { hasText: 'ATL-142' }), { after: 1600 });
            await expect(view(page)).toContainText('ATL-142 Show CI status on the dashboard');
            await moveTo(page, view(page).locator('details.plugin-section summary').first());
        }, { dir });
    });

    test('the parent and grandparent', async ({ page }) => {
        await openJira(page, '/plugin/jira/issue?key=ATL-142');
        await loop(page, 'issue-parents', async () => {
            await clickOn(page, view(page).locator('details.plugin-section summary').first(), { after: 900 });
            await moveTo(page, view(page).locator('details.plugin-section summary').nth(1));
            await page.waitForTimeout(600);
            await moveTo(page, view(page).locator('details.plugin-section summary').nth(2));
        }, { dir });
    });

    test('views', async ({ page }) => {
        await openJira(page, '/plugin/jira/views');
        await loop(page, 'views', async () => {
            await moveTo(page, view(page).locator('tr').filter({ hasText: 'Team view' }));
            await page.waitForTimeout(500);
            await moveTo(page, view(page).locator('tr').filter({ hasText: 'Team view' }).locator('.plugin-link', { hasText: 'Edit' }));
        }, { dir });
    });

    test('the view editor', async ({ page }) => {
        await openJira(page, '/plugin/jira/views?edit=1');
        await loop(page, 'view-editor', async () => {
            const layer = view(page).locator('details.plugin-section').nth(2);
            await layer.scrollIntoViewIfNeeded();
            const field = layer.locator('webui-dropdown');
            await moveTo(page, field);
            await page.waitForTimeout(400);
            await field.evaluate(el => { el.value = 'status'; });
            await page.waitForTimeout(500);
            await clickOn(page, layer.locator('webui-button', { hasText: 'Add' }), { after: 1200 });
            await moveTo(page, view(page).locator('details.plugin-section').nth(2).locator('.plugin-row', { hasText: 'Status' }));
        }, { dir });
    });

    test('create an issue', async ({ page }) => {
        await openJira(page, '/plugin/jira/create?project=ATL');
        await loop(page, 'create-issue', async () => {
            const form = view(page).locator('form').nth(1);
            await typeInto(page, form.locator('webui-input-text[name="summary"] input'), 'Show deploy status beside CI', { delay: 45 });
            await typeInto(page, form.locator('webui-input-message textarea'), 'Teams want to see **deploys** next to builds.', { delay: 30 });
            await moveTo(page, form.locator('webui-button', { hasText: 'Create issue' }));
        }, { dir });
    });

    test("the branch's issue in the git controller", async ({ page }) => {
        const branch = 'ATL-142-show-ci-status-on-the-dashboard';
        // Nothing uncommitted, since the Git Controller will not switch branches over uncommitted work.
        await open(page, '/git-controller', {
            plugins,
            git: { ...demoState().git, changes: [], lineStats: [], currentBranch: 'main', branches: [
                { name: 'main', isCurrent: true, updatedDate: '2026-11-10' },
                { name: branch, isCurrent: false, updatedDate: '2026-11-11' },
            ] },
        });
        await page.evaluate(({ branch, card }) => {
            const backend = window.__backend;
            backend.handlers.git_switch_branch = () => {
                backend.git.currentBranch = branch;
                backend.git.branches = backend.git.branches.map(item => ({ ...item, isCurrent: item.name === branch }));
                backend.handlers.plugin_branch_info = () => [{ id: 'jira', name: 'Jira', card }];
                return 'Branch switched successfully.';
            };
        }, { branch, card: fixture('branch-card') });
        await git(page).locator('webui-button[slot="tabs"]').first().waitFor();
        await settle(page);
        await loop(page, 'git-controller-card', async () => {
            await gitTab(page, 'Branches');
            await page.waitForTimeout(600);
            await clickOn(page, git(page).locator('webui-button.btn-switch').first(), { after: 1500 });
            await expect(page.locator('#plugin-branch-cards app-plugin-page')).toContainText('ATL-142');
            await moveTo(page, page.locator('#plugin-branch-cards .plugin-link').first());
        }, { dir });
    });

    test('the plugins drawer', async ({ page }) => {
        await openJira(page, '/plugin/jira/issues', {
            catalog: [{ ...jira, apiVersion: 1 }],
            pluginSettings: { jira: [
                { key: 'jira_site', label: 'Jira site', help: 'Your Jira address, such as https://your-team.atlassian.net', secret: false, isSet: true, value: 'https://atlas-team.atlassian.net' },
                { key: 'jira_email', label: 'Email', help: 'The email you sign in to Jira with', secret: false, isSet: true, value: 'sam@atlas.test' },
                { key: 'jira_api_token', label: 'API token', help: '', secret: true, isSet: true, value: null },
            ] },
        });
        await loop(page, 'plugins-drawer', async () => {
            await clickOn(page, page.locator('app-plugins-drawer'), { after: 1400 });
            const card = page.locator('webui-drawer.shared [data-plugin="jira"]');
            await card.waitFor();
            await clickOn(page, card.locator('details summary'), { after: 1200 });
            await expect(card.locator('webui-input-text[name="jira_site"]')).toBeVisible();
            await moveTo(page, card.locator('webui-button', { hasText: 'Save settings' }));
        }, { dir: 'video/loops' });
    });
});
