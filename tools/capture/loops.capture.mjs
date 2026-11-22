import { test, expect, openApp, openDialog, dialogButton } from '../../tests/support/app.mjs';
import { existsSync, readFileSync } from 'node:fs';
import {
    AI_APP_DATA, AI_PROVIDERS, AI_REPLIES, IMPORT_DOCS, IMPORT_PLAN, IMPORT_SUGGESTED, OTHER_PROJECTS, PAGE_IDS, PROJECT, PROJECT_LOGOS,
    STOREFRONT_IMAGES, demoState, testRunOutput,
} from './demo.mjs';
import { clickOn, openToolTab, loop, moveTo, parkMouse, prepare, scriptOutput, typeInto } from './helpers.mjs';

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
            await openToolTab(page, 'terminals', { after: 900 });
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
        const segment = page.locator('app-page-handler > webui-reorder > app-markdown-segment').nth(1);
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
        await page.locator('app-page-handler > webui-reorder > app-markdown-segment').first().waitFor();
        await settle(page);
        await loop(page, 'variables-project', async () => {
            await openToolTab(page, 'variables', { after: 1400 });
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
        await page.locator('app-page-handler > webui-reorder > app-markdown-segment').first().waitFor();
        await settle(page);
        await loop(page, 'variables-global', async () => {
            await openToolTab(page, 'variables', { after: 1400 });
            const tab = page.locator('webui-drawer.shared webui-button[slot="tabs"]', { hasText: 'Global' });
            await clickOn(page, tab, { after: 300 });
            await expect(async () => {
                if (!await page.locator('#var-global-list').isVisible()) await tab.click();
                await expect(page.locator('#var-global-list')).toBeVisible({ timeout: 1000 });
            }).toPass({ timeout: 10000 });
            await page.waitForTimeout(1200);
        });
    });

    test('task manager', async ({ page }) => {
        await open(page, '/');
        await loop(page, 'task-manager', async () => {
            // Flat, with the guide closed, so the process chosen and its details both fit.
            const view = await openTaskManager(page);
            // The Storybook server outlived its terminal: Orphaned finds it, and its details say what started it.
            await moveTo(page, view.locator('.tm-filter'));
            await view.locator('.tm-filter').selectOption('orphan');
            await page.waitForTimeout(900);
            await clickOn(page, view.locator('tr.tm-row[data-pid="1300"]'), { after: 1200 });
            await moveTo(page, view.locator('tr.tm-details [data-act="stop-tree"]'));
            await page.waitForTimeout(800);
        });
    });

    /** Opens the Task Manager, on the given preset, flat, with its guide closed unless asked for. */
    const openTaskManager = async (page, { filter = 'all', guide = false, tree = false } = {}) => {
        await openToolTab(page, 'tasks', { after: 1400 });
        const view = page.locator('webui-drawer.shared .task-manager');
        await view.locator('tr.tm-row').first().waitFor();
        await view.locator('.tm-filter').selectOption(filter);
        if (await view.locator('details.tm-guide').evaluate(el => el.open) !== guide) await view.locator('details.tm-guide > summary').click();
        if (await view.locator('.tm-tree').getAttribute('aria-pressed') !== `${tree}`) await view.locator('.tm-tree').click();
        await page.waitForTimeout(600);
        return view;
    };

    test('task manager search', async ({ page }) => {
        await open(page, '/');
        await loop(page, 'task-manager-search', async () => {
            const view = await openTaskManager(page);
            // Something already holds the dev server's port: searching for it finds the server.
            await typeInto(page, view.locator('.tm-search'), '5173', { delay: 140 });
            await page.waitForTimeout(900);
            await clickOn(page, view.locator('tr.tm-row[data-pid="1220"]'), { after: 1600 });
        });
    });

    test('task manager tree', async ({ page }) => {
        await open(page, '/');
        await loop(page, 'task-manager-tree', async () => {
            const view = await openTaskManager(page, { filter: 'projects' });
            await page.waitForTimeout(600);
            await clickOn(page, view.locator('.tm-tree'), { after: 1400 });
            await moveTo(page, view.locator('tr.tm-row[data-pid="1230"]'));
            await page.waitForTimeout(900);
        });
    });

    test('task manager filter rules', async ({ page }) => {
        await open(page, '/');
        await loop(page, 'task-manager-filter', async () => {
            const view = await openTaskManager(page, { filter: 'listening' });
            await clickOn(page, view.locator('details.tm-rules > summary'), { after: 900 });
            await clickOn(page, view.locator('.tm-rules-body [data-do="copy"]'), { after: 800 });
            await clickOn(page, view.locator('.tm-rules-body [data-do="add"]'), { after: 600 });
            const rule = view.locator('.tm-rules-body .tm-rule').nth(1);
            await moveTo(page, rule.locator('[data-part="field"]'));
            await rule.locator('[data-part="field"]').selectOption('project');
            await page.waitForTimeout(500);
            await typeInto(page, view.locator('.tm-rules-body .tm-rule').nth(1).locator('[data-part="value"]'), 'Acme', { delay: 120 });
            await page.waitForTimeout(600);
            await typeInto(page, view.locator('.tm-rules-body [data-part="name"]'), 'Storefront servers', { delay: 60 });
            await clickOn(page, view.locator('.tm-rules-body [data-do="save"]'), { after: 1400 });
        });
    });

    test('task manager stop', async ({ page }) => {
        await open(page, '/');
        await loop(page, 'task-manager-stop', async () => {
            const view = await openTaskManager(page, { filter: 'orphan', guide: true });
            await clickOn(page, view.locator('tr.tm-row[data-pid="1300"]'), { after: 1000 });
            await moveTo(page, view.locator('details.tm-guide dl'));
            await page.waitForTimeout(1200);
            await clickOn(page, view.locator('tr.tm-details [data-act="stop-tree"]'), { after: 1000 });
            await moveTo(page, page.getByRole('dialog', { name: 'Stop Process' }).getByRole('button', { name: 'Stop', exact: true }));
            await page.waitForTimeout(1200);
        });
    });

    test('terminal finished runs', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await open(page, '/script-manager');
        const manager = page.locator('app-script-manager');
        await manager.locator('.params-container [data-param="Suite"] input').fill('unit');
        await scriptOutput(page, testRunOutput);
        await manager.locator('webui-button[label="Run"]').first().click();
        await expect.poll(() => page.evaluate(() => webui.proxy.terminalHelpers.getState().terminals['.taskproxy/scripts/test.ps1']?.status)).toBe('Finished');
        await settle(page);
        await parkMouse(page);
        await loop(page, 'terminal-finished', async () => {
            await openToolTab(page, 'terminals', { after: 1000 });
            const filter = page.locator('#term-filter');
            await filter.waitFor();
            const finished = filter.getByText('Finished', { exact: true });
            await clickOn(page, finished, { after: 1200 });
            await expect(page.locator('#term-status')).toContainText('Finished', { timeout: 10000 });
            await page.waitForTimeout(800);
        });
    });

    test('git file preview', async ({ page }) => {
        await openGit(page);
        await loop(page, 'git-file-preview', async () => {
            await clickOn(page, git(page).locator('.files button.file[title="README.md"]'), { after: 1200 });
            await clickOn(page, git(page).locator('.render-toggle button[data-mode="preview"]'), { after: 1800 });
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

/** Features shown on TaskProxy.com's feature pages, each one action ending on its result. */
test.describe('features', () => {
    const settingsTab = (page, name) => clickOn(page, page.locator(`webui-button.settings-tab-${name}`), { after: 900 });
    /** Makes a backend command take a while to answer, as a real one does, so its busy state shows. */
    const slow = (page, command, ms) => page.evaluate(({ command, ms }) => {
        const answer = window.__backend.handlers[command];
        window.__backend.handlers[command] = async args => {
            await new Promise(resolve => setTimeout(resolve, ms));
            return answer(args);
        };
    }, { command, ms });
    /** AI set up with Ollama and Claude Code, and turned on for everything. */
    const withAi = (extra = {}) => ({
        ai: AI_PROVIDERS, aiReplies: AI_REPLIES,
        appData: { ...demoState().appData, ...AI_APP_DATA },
        ...extra,
    });
    /** Drags a range input's thumb from one value to another, as a person would. */
    const drag = async (page, slider, from, to) => {
        await slider.scrollIntoViewIfNeeded();
        const box = await slider.boundingBox();
        const { min, max } = await slider.evaluate(el => ({ min: Number(el.min), max: Number(el.max) }));
        const at = value => box.x + 8 + (box.width - 16) * (value - min) / (max - min);
        const y = box.y + box.height / 2;
        await page.mouse.move(at(from), y, { steps: 20 });
        await page.waitForTimeout(250);
        await page.mouse.down();
        await page.mouse.move(at(to), y, { steps: 30 });
        await page.waitForTimeout(150);
        await page.mouse.up();
    };
    /** Each project's logo as the project dropdown shows it, from the image the project uses. */
    const showLogos = (page, logos) => page.evaluate(logos => {
        const backend = window.__backend;
        const uri = svg => svg ? `data:image/svg+xml,${encodeURIComponent(svg)}` : null;
        const icons = { ...logos };
        backend.handlers.get_project_icons = () => Object.entries(icons).map(([path, svg]) => ({ path, icon: uri(svg) }));
        backend.setLogo = (path, svg) => { icons[path] = svg; return uri(svg); };
        document.dispatchEvent(new CustomEvent('app-project-icons-changed'));
    }, logos);

    test('the tools drawer', async ({ page }) => {
        const output = testRunOutput.filter(step => typeof step === 'string').join('');
        await open(page, `/${PAGE_IDS.onboarding}`, { runs: [{ terminalId: '.taskproxy/scripts/test.ps1', project: PROJECT.path, output: [output], code: 0 }] });
        await page.locator('app-page-handler > webui-reorder > app-markdown-segment').first().waitFor();
        await loop(page, 'tools-drawer', async () => {
            await clickOn(page, page.locator('header app-tools'), { after: 1000 });
            for (const id of ['terminals', 'tasks', 'variables', 'theme']) {
                await clickOn(page, page.locator(`webui-drawer.shared webui-button.tools-tab-${id}`), { after: 1500 });
            }
        });
    });

    test('adding an AI provider', async ({ page }) => {
        await open(page, '/', { aiModels: { 'provider-1': [{ id: 'qwen2.5-coder:7b', name: '' }, { id: 'llama3.2:3b', name: '' }, { id: 'gemma3:4b', name: '' }] } });
        await loop(page, 'ai-providers', async () => {
            await settingsTab(page, 'ai');
            const ai = page.locator('.settings-ai app-ai-settings');
            await clickOn(page, ai.locator('webui-button.ai-add-provider'), { after: 900 });
            const card = ai.locator('.ai-provider-tabs > .ai-provider-content').first().locator('.ai-provider');
            await moveTo(page, card.locator('.ai-choice-claude'));
            await page.waitForTimeout(500);
            await clickOn(page, card.locator('.ai-choice-ollama input[type="radio"]'), { after: 1000 });
            await moveTo(page, card.locator('.ai-steps > li').first());
            await page.waitForTimeout(700);
            await moveTo(page, card.locator('webui-button.ai-run-command').first());
            await page.waitForTimeout(900);
            await slow(page, 'ai_models', 900);
            await clickOn(page, ai.locator('webui-button.ai-save'), { after: 600 });
            const models = ai.locator('.ai-provider-tabs > .ai-provider-content').first().locator('.ai-server-models .ai-model');
            await expect(models).toHaveCount(3);
            await moveTo(page, models.first());
            await page.waitForTimeout(400);
        });
    });

    test('a commit message written with AI', async ({ page }) => {
        await openGit(page, withAi());
        await slow(page, 'ai_write', 2200);
        await loop(page, 'ai-commit-message', async () => {
            const message = git(page).locator('webui-input-message[label="Commit Message"] textarea');
            await moveTo(page, message);
            await page.waitForTimeout(500);
            await clickOn(page, git(page).locator('#ai-commit webui-button.ai-run'), { after: 400 });
            await expect(message).toHaveValue(AI_REPLIES.git, { timeout: 10000 });
            await page.waitForTimeout(600);
            await moveTo(page, git(page).locator('webui-button[label="Commit"]'));
        });
    });

    test('a code review of the changes', async ({ page }) => {
        await openGit(page, withAi());
        await page.evaluate(report => {
            const backend = window.__backend;
            backend.handlers.ai_review = async ({ request }) => {
                for (let done = 0; done < 3; done++) {
                    backend.emit('ai-progress', { requestId: request.requestId, done, total: 3 });
                    await new Promise(resolve => setTimeout(resolve, 900));
                }
                return report;
            };
        }, AI_REPLIES.review);
        await loop(page, 'git-review', async () => {
            await gitTab(page, 'Review');
            const review = git(page).locator('app-ai-review');
            await page.waitForTimeout(700);
            await typeInto(page, review.locator('textarea.review-focus'), 'edge cases in the cart total', { delay: 40 });
            await clickOn(page, review.locator('webui-button.ai-run'), { after: 400 });
            const report = review.locator('.review-report');
            await expect(report.locator('h2').first()).toHaveText('Summary', { timeout: 15000 });
            await moveTo(page, report.locator('ol li').first());
            await page.waitForTimeout(800);
        });
    });

    test('a page part written with AI', async ({ page }) => {
        await open(page, `/${PAGE_IDS.release}`, withAi());
        const segment = page.locator('app-page-handler > webui-reorder > app-markdown-segment').nth(1);
        await segment.waitFor();
        await slow(page, 'ai_write', 2000);
        await settle(page);
        await loop(page, 'ai-page-draft', async () => {
            await clickOn(page, segment.locator('#btn-edit'), { after: 900 });
            await clickOn(page, segment.locator('#ai-segment webui-button.ai-run'), { after: 700 });
            await typeInto(page, page.locator('textarea[name="ai_request"]'), 'Add the steps to tag and publish the release after these checks', { delay: 30 });
            await clickOn(page, dialogButton(page, 'Write with AI'), { after: 400 });
            await expect(segment.locator('webui-input-message textarea')).toHaveValue(AI_REPLIES.pages, { timeout: 10000 });
            await moveTo(page, segment.locator('webui-input-message textarea'));
            await page.waitForTimeout(600);
        });
    });

    test('importing markdown files as pages', async ({ page }) => {
        const base = demoState();
        const titles = JSON.parse(IMPORT_SUGGESTED);
        await open(page, '/', withAi({
            docs: ['README.md', ...Object.keys(IMPORT_DOCS)],
            files: { ...base.files, ...IMPORT_DOCS },
            importPlan: IMPORT_PLAN, aiReplies: { ...AI_REPLIES, markdown: IMPORT_SUGGESTED },
            folderImport: titles.map(page => ({ name: page.title, content: `<webui-data data-page-title="${page.title}" data-page-subtitle="${page.subtitle}"></webui-data>\n` })),
        }));
        await slow(page, 'ai_write', 2000);
        await loop(page, 'page-import', async () => {
            await settingsTab(page, 'import');
            const importer = page.locator('app-page-import');
            await clickOn(page, importer.locator('webui-select').getByRole('button').first(), { after: 700 });
            await clickOn(page, importer.locator('webui-select').getByRole('option', { name: /^docs \(/ }), { after: 800 });
            await clickOn(page, importer.locator('app-ai-action webui-button.ai-run'), { after: 400 });
            await expect(importer.locator('.page-import-table')).toBeVisible({ timeout: 10000 });
            await moveTo(page, importer.locator('.page-import-table tr').nth(3));
            await page.waitForTimeout(1000);
            await clickOn(page, importer.locator('webui-button', { hasText: 'Import Pages' }), { after: 1200 });
            await expect(importer.locator('webui-alert[show]')).toContainText('Imported');
        });
    });

    test('favorite scripts', async ({ page }) => {
        const favorite = (id, name, icon, path) => ({
            id, name, icon, project: PROJECT.path, source: { kind: 'file', path },
            params: [], scopes: { page: true, project: true, global: true }, projects: [PROJECT.path], preview: '',
        });
        await open(page, `/${PAGE_IDS.onboarding}`, {
            appData: {
                ...demoState().appData, 'app-trusted-projects': [PROJECT.path],
                'app-favorite-scripts': [favorite('tests', 'Run tests', { name: 'test|theme:info|fill|backing' }, '.taskproxy/scripts/test.ps1'), favorite('clean', 'Clean', { name: 'eraser|theme:warning|fill|backing' }, '.taskproxy/scripts/clean.ps1')],
            },
        });
        await page.locator('app-page-handler > webui-reorder > app-markdown-segment').first().waitFor();
        await scriptOutput(page, [
            '\r\n> acme-storefront@1.4.2 dev\r\n> vite\r\n\r\n', { wait: 500 },
            '  \x1b[32m\x1b[1mVITE\x1b[22m v6.0.7\x1b[39m  \x1b[2mready in \x1b[0m\x1b[1m412\x1b[22m\x1b[2m\x1b[0m ms\x1b[22m\r\n\r\n',
            '  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\r\n',
            '  \x1b[32m➜\x1b[39m  \x1b[2mNetwork: use \x1b[22m\x1b[1m--host\x1b[22m\x1b[2m to expose\x1b[22m\r\n',
            { wait: 120000 },
        ]);
        await settle(page);
        await loop(page, 'favorites', async () => {
            const favorites = page.locator('app-favorites');
            await clickOn(page, favorites.locator('.fav-edit'), { after: 1000 });
            await clickOn(page, favorites.locator('webui-button.fav-add'), { after: 1000 });
            await clickOn(page, favorites.locator('.fav-choice[data-block="3"]'), { after: 1200 });
            await moveTo(page, favorites.locator('.fav-editor .fav-name'));
            await page.waitForTimeout(800);
            await clickOn(page, favorites.locator('webui-button.fav-done'), { after: 1000 });
            await clickOn(page, favorites.locator('.fav-icons > .fav-icon').last(), { after: 1200 });
            await expect(page.locator('#term-status')).toContainText('Running', { timeout: 10000 });
            await page.waitForTimeout(1200);
        });
    });

    test('choosing a theme', async ({ page }) => {
        await open(page, `/${PAGE_IDS.onboarding}`);
        await page.locator('app-page-handler > webui-reorder > app-markdown-segment').first().waitFor();
        await loop(page, 'theme', async () => {
            await openToolTab(page, 'theme', { after: 1600 });
            const panel = page.locator('webui-drawer.shared webui-theme-selector[panel]');
            for (const [category, theme] of [['Ocean', 'seafoam'], ['Space', 'nebula'], ['Organic', 'forest']]) {
                await clickOn(page, panel.locator(`.category-tab[data-category="${category}"]`), { after: 700 });
                await clickOn(page, panel.locator(`.tile[data-theme-value="${theme}"]`).first(), { after: 1600 });
            }
        });
    });

    test('accessibility choices', async ({ page }) => {
        await open(page, `/${PAGE_IDS.onboarding}`);
        await page.locator('app-page-handler > webui-reorder > app-markdown-segment').first().waitFor();
        await loop(page, 'accessibility', async () => {
            await openToolTab(page, 'accessibility', { after: 1200 });
            const panel = page.locator('webui-drawer.shared .accessibility-panel');
            await drag(page, panel.locator('.a11y-text-size'), 100, 130);
            await expect(panel.locator('.a11y-text-value')).toHaveText('130%');
            await page.waitForTimeout(1200);
            await clickOn(page, panel.locator('input[data-setting="underlineLinks"]'), { after: 1000 });
            await moveTo(page, page.locator('app-page-handler > webui-reorder > app-markdown-segment').first(), { offsetY: -40 });
        });
    });

    test('project tiles', async ({ page }) => {
        const [mobile, design, payments] = OTHER_PROJECTS;
        await open(page, '/', {
            projects: [PROJECT, ...OTHER_PROJECTS],
            gitStatus: { [PROJECT.path]: { changes: 4, ahead: 2, behind: 1 }, [mobile.path]: { changes: 1 }, [payments.path]: { behind: 3 } },
            ciStatus: {
                [PROJECT.path]: { state: 'success', service: 'GitHub Actions', url: 'https://github.com/acme/storefront/actions' },
                [mobile.path]: { state: 'running', service: 'GitHub Actions', url: 'https://github.com/acme/mobile/actions' },
                [design.path]: { state: 'success', service: 'GitLab CI/CD', url: 'https://gitlab.com/acme/design-system/-/pipelines' },
                [payments.path]: { state: 'failure', service: 'GitHub Actions', url: 'https://github.com/acme/payments-api/actions' },
            },
        });
        await showLogos(page, PROJECT_LOGOS);
        await settle(page);
        await loop(page, 'project-tiles', async () => {
            const dropdown = page.locator('app-project-dropdown');
            await clickOn(page, dropdown.getByRole('button').first(), { after: 900 });
            const tiles = dropdown.locator('.tile');
            for (const index of [1, 2, 3]) {
                await moveTo(page, tiles.nth(index));
                await page.waitForTimeout(700);
            }
        });
    });

    test("choosing the project's icon", async ({ page }) => {
        const base = demoState();
        await open(page, '/', { projectImages: Object.keys(STOREFRONT_IMAGES), files: { ...base.files, ...STOREFRONT_IMAGES } });
        await showLogos(page, { ...PROJECT_LOGOS, [PROJECT.path]: null });
        await page.evaluate(({ images, path }) => {
            const backend = window.__backend;
            const set = backend.handlers.set_project_icon;
            backend.handlers.set_project_icon = args => {
                set(args);
                return backend.setLogo(args.project ?? path, images[args.icon] || null);
            };
        }, { images: STOREFRONT_IMAGES, path: PROJECT.path });
        await settle(page);
        await loop(page, 'project-icon', async () => {
            const icon = page.locator('app-project-manager app-project-icon');
            await clickOn(page, icon.getByRole('button').first(), { after: 900 });
            const tile = name => icon.locator('.tile').filter({ has: page.locator('.name', { hasText: name }) });
            await moveTo(page, tile('storefront-mono.svg'));
            await page.waitForTimeout(500);
            await clickOn(page, tile('storefront-logo.svg'), { after: 1200 });
            await moveTo(page, page.locator('app-project-dropdown'));
        });
    });

    test('script performance', async ({ page }) => {
        await open(page, '/');
        await loop(page, 'script-performance', async () => {
            await settingsTab(page, 'performance');
            const perf = page.locator('app-script-performance');
            await clickOn(page, perf.locator('.perf-priority [role="radio"]', { hasText: /^Low$/ }), { after: 900 });
            await clickOn(page, perf.locator('.perf-priority [role="radio"]', { hasText: 'Lowest' }), { after: 900 });
            await drag(page, perf.locator('.perf-threads'), 12, 6);
            await expect(perf.locator('.perf-threads-label')).toHaveText('6 of 12 threads');
            await page.waitForTimeout(600);
        });
    });

    test('remote connections', async ({ page }) => {
        await open(page, '/', {
            myfi: { account: { id: 'demo-account', displayName: 'Sam Rivera' } },
            remote: { enabled: false, name: 'Sam’s Workstation' },
        });
        await loop(page, 'remote-connections', async () => {
            await settingsTab(page, 'remote');
            const remote = page.locator('.settings-remote app-remote-connections');
            await clickOn(page, remote.locator('[data-role="turn-on"]'), { after: 1200 });
            await page.evaluate(() => window.__backend.remote.ask({ key: 'demo-browser', name: 'Chrome on Pixel 8', code: 'K7Q-42M' }));
            const waiting = remote.locator('.remote-waiting webui-flex.remote-browser');
            await expect(waiting).toBeVisible();
            await moveTo(page, waiting.locator('.remote-code'));
            await page.waitForTimeout(1000);
            await clickOn(page, waiting.locator('[data-role="approve"]'), { after: 1200 });
            const approved = remote.locator('.remote-approved webui-flex.remote-browser');
            await expect(approved).toBeVisible();
            await moveTo(page, approved.locator('.remote-browser-name'));
        });
    });

    test('signing in to a Stoic Dreams account', async ({ page }) => {
        await open(page, `/${PAGE_IDS.onboarding}`);
        await page.locator('app-page-handler > webui-reorder > app-markdown-segment').first().waitFor();
        await loop(page, 'account', async () => {
            await openToolTab(page, 'account', { after: 1200 });
            const account = page.locator('webui-drawer.shared app-account');
            await clickOn(page, account, { after: 800 });
            const code = openDialog(page).locator('.myfi-code');
            await expect(code).toBeVisible();
            await moveTo(page, code);
            await page.waitForTimeout(2200);
            await page.evaluate(() => window.__backend.myfi.approve({ id: 'demo-account', displayName: 'Sam Rivera' }));
            await expect(account).toContainText('Signed in as Sam Rivera');
            await moveTo(page, account);
            // Until the popup saying so has gone, so the poster shows the panel.
            await expect(page.locator('webui-alerts webui-alert[show], webui-alerts .alert')).toHaveCount(0, { timeout: 15000 }).catch(() => { });
            await page.waitForTimeout(600);
        });
    });

    test('git repos with their CI results', async ({ page }) => {
        const base = demoState().git;
        const actions = 'https://github.com/acme/storefront/actions';
        await openGit(page, {
            git: {
                ...base, repos: ['', 'packages/checkout-api', 'packages/ui-kit'],
                repoStatus: { '': { changes: 4, ahead: 2, behind: 1 }, 'packages/checkout-api': { changes: 2, behind: 3 }, 'packages/ui-kit': { ahead: 1 } },
                ciStatus: {
                    '': { state: 'success', service: 'GitHub Actions', url: actions },
                    'packages/checkout-api': { state: 'failure', service: 'GitHub Actions', url: actions },
                    'packages/ui-kit': { state: 'running', service: 'GitHub Actions', url: actions },
                },
            },
        });
        await loop(page, 'git-repos', async () => {
            const repos = git(page).locator('webui-select[label="Repo"]');
            await clickOn(page, repos.getByRole('button').first(), { after: 900 });
            const tiles = repos.locator('.tile');
            for (const index of [1, 2]) {
                await moveTo(page, tiles.nth(index));
                await page.waitForTimeout(800);
            }
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
                    // From a list, an issue opens beside it, as split view is on until the user turns it off.
                    case 'open': return { navigate: { page: 'issue', params: { key: request.params.key }, side: ['issues', 'all'].includes(request.page) } };
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
            await clickOn(page, view(page).first().locator('tbody tr').first().locator('.plugin-link', { hasText: 'ATL-142' }), { after: 1600 });
            const side = page.locator('app-plugin-page.plugin-split-page');
            await expect(side).toContainText('ATL-142 Show CI status on the dashboard');
            await moveTo(page, side.locator('details.plugin-section summary').first());
            await page.waitForTimeout(800);
            // Closed again, so the loop ends on the list it started from.
            await clickOn(page, page.locator('webui-split-panes .plugin-split-tool[aria-label="Close"]'), { after: 600 });
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
            // Each layer holds its own Subtasks section, with another field list, so use the layer's own, which comes first.
            const layer = () => view(page).locator('details.plugin-section')
                .filter({ has: page.locator(':scope > summary strong', { hasText: /^Grandparent$/ }) });
            await layer().scrollIntoViewIfNeeded();
            const field = layer().locator('webui-select').first();
            await moveTo(page, field);
            await page.waitForTimeout(400);
            await field.evaluate(el => { el.value = 'status'; });
            await page.waitForTimeout(500);
            await clickOn(page, layer().locator('webui-button', { hasText: 'Add' }).first(), { after: 1200 });
            await moveTo(page, layer().locator('.plugin-row', { hasText: 'Status' }).first());
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
            await openToolTab(page, 'plugins', { after: 1400 });
            const manager = page.locator('webui-drawer.shared app-plugin-manager');
            const card = manager.locator('.plugin-detail [data-plugin="jira"]');
            await card.waitFor();
            await expect(card.locator('webui-input-text[name="jira_site"]')).toBeVisible();
            await moveTo(page, card.locator('webui-button', { hasText: 'Save settings' }));
            await page.waitForTimeout(1200);
            // The catalog, with what each plugin would reach, is the next tab.
            await clickOn(page, manager.locator('webui-button.plugin-tab-available'), { after: 1200 });
            await expect(manager.locator('.plugin-available .plugin-detail [data-catalog="jira"]')).toBeVisible();
            await clickOn(page, manager.locator('webui-button.plugin-tab-installed'), { after: 800 });
        }, { dir: 'video/loops' });
    });
});
