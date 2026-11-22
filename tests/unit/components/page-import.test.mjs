import { test, expect, openApp, mount, calls, switchProject } from '../support/app.mjs';
import { actionNote } from '../../support/wait.mjs';

// Settings' page import (wc/page-import.js): a folder of the project's markdown files becomes pages, nested in the
// navigation, under a new folder or at the top. Rust reads the files and writes the pages (services/page_import.rs);
// the mock backend adds one page per entry of folderImport.
const DOCS = ['README.md', 'docs/guide/setup.md', 'docs/index.md', 'notes/todo.md'];
const NAVIGATION = [{ name: 'Existing', icon: 'star', url: '/existing', children: null }];

async function importer(page, state = {}) {
    await openApp(page, { docs: DOCS, navigation: NAVIGATION, ...state });
    const root = await mount(page, '<app-page-import id="i"></app-page-import>');
    return root.locator('#i');
}
const folders = el => el.locator('webui-select .tile .name');
const folderField = el => el.locator('webui-select').getByRole('button').first();
const importButton = el => el.locator('webui-button', { hasText: 'Import Pages' });
const nameInput = el => el.locator('webui-input-text input');
const navigation = page => page.evaluate(() => webui.projectData.navigation);

test("lists the project's folders that hold markdown files, with how many each holds", async ({ page }) => {
    const el = await importer(page);
    await folderField(el).click();
    await expect(folders(el)).toHaveText([
        'The whole project (4 pages)',
        'docs (2 pages)',
        'docs/guide (1 page)',
        'notes (1 page)',
    ]);
});

test('imports into a new folder named after the chosen one, and saves the navigation with it', async ({ page }) => {
    const el = await importer(page, { folderImport: [{ name: 'Setup', content: '# Setup' }, { name: 'Index', content: '# Index' }] });
    await folderField(el).click();
    await el.locator('webui-select').getByRole('option', { name: 'docs (2 pages)' }).click();
    await expect(nameInput(el)).toHaveValue('docs');
    await nameInput(el).fill('Guides');
    await importButton(el).click();
    await expect(actionNote(page, 'Imported 2 pages into Guides.')).toHaveCount(1);
    await expect.poll(() => calls(page, 'import_page_folder')).toEqual([{ folder: 'docs', parent: 'Guides', navigation: NAVIGATION }]);
    const expected = [...NAVIGATION, {
        name: 'Guides', icon: 'folder', url: null, children: [
            { name: 'Setup', icon: 'file', url: '/imported-0', children: null },
            { name: 'Index', icon: 'file', url: '/imported-1', children: null },
        ],
    }];
    await expect.poll(() => navigation(page)).toEqual(expected);
    await expect.poll(async () => (await calls(page, 'save_project_data')).at(-1)?.data.navigation).toEqual(expected);
    await expect.poll(() => page.evaluate(() => webui.getData('app-nav-routes'))).toEqual(expected);
});

test('the whole project is the first choice, with a folder named after the project', async ({ page }) => {
    const el = await importer(page);
    await expect(nameInput(el)).toHaveValue('Repo');
    await importButton(el).click();
    await expect.poll(() => calls(page, 'import_page_folder')).toEqual([{ folder: '', parent: 'Repo', navigation: NAVIGATION }]);
});

test('the pages can go at the top of the navigation, with no folder to name', async ({ page }) => {
    const el = await importer(page);
    await el.getByRole('radio', { name: 'At the top of the navigation' }).click();
    await expect(nameInput(el)).toBeHidden();
    await importButton(el).click();
    await expect(actionNote(page, 'Imported 1 page.')).toHaveCount(1);
    await expect.poll(() => calls(page, 'import_page_folder')).toEqual([{ folder: '', parent: null, navigation: NAVIGATION }]);
    await expect.poll(() => navigation(page)).toEqual([...NAVIGATION, { name: 'Imported', icon: 'file', url: '/imported-0', children: null }]);
});

test('a new folder needs a name', async ({ page }) => {
    const el = await importer(page);
    await nameInput(el).fill('  ');
    await importButton(el).click();
    await expect(actionNote(page, 'Name the folder the pages go in.')).toHaveCount(1);
    await expect.poll(() => calls(page, 'import_page_folder')).toEqual([]);
});

test('files that could not be read are named', async ({ page }) => {
    const el = await importer(page, { importSkipped: ['docs/b.md (not text)'] });
    await importButton(el).click();
    await expect(actionNote(page, 'These files could not be read as text, so they were left out: docs/b.md (not text)')).toHaveCount(1);
});

test('an import the backend refuses says why, and changes nothing', async ({ page }) => {
    const el = await importer(page);
    await page.evaluate(() => { window.__backend.handlers.import_page_folder = () => { throw 'Import Failed: There are no markdown files in docs.'; }; });
    await importButton(el).click();
    await expect(actionNote(page, 'Import Failed: There are no markdown files in docs.')).toHaveCount(1);
    await expect.poll(() => navigation(page)).toEqual(NAVIGATION);
    await expect.poll(() => calls(page, 'save_project_data')).toEqual([]);
});

test('a navigation that could not be saved says why, and is not reported as imported', async ({ page }) => {
    const el = await importer(page);
    await page.evaluate(() => { window.__backend.handlers.save_project_data = () => { throw 'The project could not be saved.'; }; });
    await importButton(el).click();
    await expect(actionNote(page, 'The project could not be saved.')).toHaveCount(1);
    await expect(actionNote(page, 'Imported')).toHaveCount(0);
});

test('an import whose navigation could not be saved resolves to nothing, whatever its error handler returns', async ({ page }) => {
    await importer(page);
    await page.evaluate(() => {
        window.__backend.handlers.save_project_data = () => { throw 'The project could not be saved.'; };
        window.__import = { done: false };
        // An error handler that answers with something, as an alert can, is not a save.
        webui.proxy.importPageFolder('docs', null, () => 'Said it.').then(result => { window.__import = { done: true, result: result ?? null }; });
    });
    await expect.poll(() => page.evaluate(() => window.__import)).toEqual({ done: true, result: null });
});

test('a project with no markdown files says so', async ({ page }) => {
    const el = await importer(page, { docs: [] });
    await expect(el.getByText('This project has no markdown files to import.')).toBeVisible();
    await expect(importButton(el)).toBeHidden();
});

test('with no project open, there is nothing to import', async ({ page }) => {
    await openApp(page, { project: null });
    const root = await mount(page, '<app-page-import id="i"></app-page-import>');
    await expect(root.locator('#i')).toBeHidden();
});

test("Settings has an Import tab with the page import, and the current project shows above the tabs", async ({ page }) => {
    await openApp(page, { docs: DOCS });
    await page.locator('webui-button.settings-tab-key').click();
    // The current project stays in view whichever tab is open.
    await expect(page.locator('app-project-manager .edit-text')).toBeVisible();
    await expect(page.locator('app-page-import')).toBeHidden();
    await page.locator('webui-button.settings-tab-import').click();
    await expect(page.locator('app-page-import').getByText(/Turn a folder of markdown files/)).toBeVisible();
    await expect(page.locator('app-page-import webui-button', { hasText: 'Import Pages' })).toBeVisible();
});

test.describe('Suggest with AI', () => {
    const AI = { providers: [{ id: 'p', name: 'Local', kind: 'openAi', baseUrl: 'http://localhost:11434/v1', models: [{ id: 'm', name: 'Model' }], hidden: [] }] };
    const PLAN = [
        { file: 'docs/guide/setup.md', title: 'Setup', subtitle: '', navPath: ['guide'], excerpt: 'Install the app.' },
        { file: 'docs/index.md', title: 'Index', subtitle: '', navPath: [], excerpt: 'Welcome.' },
    ];
    const SUGGESTED = 'Here they are:\n[{"file":"docs/guide/setup.md","title":"Installing","subtitle":"From download to first run","navPath":["Guides"]},'
        + '{"file":"docs/index.md","title":"Overview","subtitle":"What is here","navPath":[]}]';
    const state = { ai: AI, appData: { 'app-ai-integrations': { markdown: true } }, importPlan: PLAN, aiReplies: { markdown: SUGGESTED } };
    const row = (el, file) => el.locator(`tr[data-file="${file}"]`);

    test('suggestions fill a table to change, and the import uses what it holds', async ({ page }) => {
        const el = await importer(page, state);
        await el.locator('app-ai-action webui-button.ai-run').click();
        await expect(row(el, 'docs/guide/setup.md').locator('input[data-field="title"]')).toHaveValue('Installing');
        await expect(row(el, 'docs/guide/setup.md').locator('input[data-field="navPath"]')).toHaveValue('Guides');
        await expect(row(el, 'docs/index.md').locator('input[data-field="subtitle"]')).toHaveValue('What is here');
        await expect.poll(() => calls(page, 'ai_write').then(list => list.at(-1)?.request.integration)).toBe('markdown');
        await expect.poll(() => calls(page, 'ai_write').then(list => list.at(-1)?.request.context)).toContain('Install the app.');
        // A change before importing is kept.
        await row(el, 'docs/guide/setup.md').locator('input[data-field="navPath"]').fill('Guides / Setup');
        await importButton(el).click();
        await expect.poll(() => calls(page, 'import_page_folder').then(list => list.map(call => call.overrides))).toEqual([{
            'docs/guide/setup.md': { title: 'Installing', subtitle: 'From download to first run', navPath: ['Guides', 'Setup'] },
            'docs/index.md': { title: 'Overview', subtitle: 'What is here', navPath: [] },
        }]);
        await expect(el.locator('.page-import-table')).toHaveCount(0);
    });

    test('suggestions, with changes made to them, are back after switching projects, and another project has none', async ({ page }) => {
        const el = await importer(page, state);
        await el.locator('app-ai-action webui-button.ai-run').click();
        await expect(el.locator('.page-import-table')).toHaveCount(1);
        await row(el, 'docs/guide/setup.md').locator('input[data-field="title"]').fill('Install');
        await switchProject(page, { name: 'Other', path: '/other' });
        await expect(el.locator('.page-import-table')).toHaveCount(0);
        await switchProject(page, { name: 'Repo', path: '/repo' });
        await expect(row(el, 'docs/guide/setup.md').locator('input[data-field="title"]')).toHaveValue('Install');
        await importButton(el).click();
        await expect.poll(() => calls(page, 'import_page_folder').then(list => list.map(call => call.overrides?.['docs/guide/setup.md']?.title))).toEqual(['Install']);
    });

    test('suggestions that arrive after switching projects are kept for the project they were asked in', async ({ page }) => {
        const el = await importer(page, state);
        await page.evaluate(() => {
            const original = window.__backend.handlers.ai_write;
            window.__backend.handlers.ai_write = args => new Promise(resolve => { window.__release = () => resolve(original(args)); });
        });
        await el.locator('app-ai-action webui-button.ai-run').click();
        await expect.poll(() => page.evaluate(() => typeof window.__release)).toBe('function');
        // Import waits while suggestions are coming.
        await expect(importButton(el)).toHaveAttribute('disabled', '');
        await switchProject(page, { name: 'Other', path: '/other' });
        await page.evaluate(() => window.__release());
        await switchProject(page, { name: 'Repo', path: '/repo' });
        await expect(importButton(el)).not.toHaveAttribute('disabled', '');
        await expect(row(el, 'docs/guide/setup.md').locator('input[data-field="title"]')).toHaveValue('Installing');
        // Handled now, they are still only for the project they were asked in.
        await switchProject(page, { name: 'Other', path: '/other' });
        await expect(el.locator('.page-import-table')).toHaveCount(0);
    });

    test('suggestions are found in an answer with other brackets before them, and only text names a folder', async ({ page }) => {
        const reply = 'See [the docs] below.\n```json\n[{"file":"docs/guide/setup.md","title":"Installing","subtitle":"","navPath":["Guides",{"x":1}]}]\n```';
        const el = await importer(page, { ...state, aiReplies: { markdown: reply } });
        await el.locator('app-ai-action webui-button.ai-run').click();
        await expect(row(el, 'docs/guide/setup.md').locator('input[data-field="title"]')).toHaveValue('Installing');
        await expect(row(el, 'docs/guide/setup.md').locator('input[data-field="navPath"]')).toHaveValue('Guides');
    });

    test('Clear Suggestions removes them, and the import sends none', async ({ page }) => {
        const el = await importer(page, state);
        await el.locator('app-ai-action webui-button.ai-run').click();
        await expect(el.locator('.page-import-table')).toHaveCount(1);
        await el.locator('webui-button.page-import-clear').click();
        await expect(el.locator('.page-import-table')).toHaveCount(0);
        await importButton(el).click();
        await expect.poll(() => calls(page, 'import_page_folder').then(list => list.map(call => 'overrides' in call))).toEqual([false]);
    });

    test('a folder with nothing readable to suggest for says so', async ({ page }) => {
        const el = await importer(page, { ...state, importPlan: [] });
        await el.locator('app-ai-action webui-button.ai-run').click();
        await expect(el.locator('app-ai-action webui-alert.ai-problem[show]')).toHaveText('This folder has no markdown files that could be read as text.');
        await expect.poll(() => calls(page, 'ai_write')).toEqual([]);
    });

    test('suggestions are found with brackets after them too', async ({ page }) => {
        const reply = '[{"file":"docs/index.md","title":"Overview","subtitle":"","navPath":[]}] (see [notes])';
        const el = await importer(page, { ...state, aiReplies: { markdown: reply } });
        await el.locator('app-ai-action webui-button.ai-run').click();
        await expect(row(el, 'docs/index.md').locator('input[data-field="title"]')).toHaveValue('Overview');
    });

    test('Suggest with AI waits while an import runs', async ({ page }) => {
        const el = await importer(page, state);
        await page.evaluate(() => {
            const original = window.__backend.handlers.import_page_folder;
            window.__backend.handlers.import_page_folder = args => new Promise(resolve => { window.__release = () => resolve(original(args)); });
        });
        await importButton(el).click();
        await expect.poll(() => page.evaluate(() => typeof window.__release)).toBe('function');
        await el.locator('app-ai-action').evaluate(node => node.run());
        await expect(el.locator('app-ai-action webui-alert.ai-problem[show]')).toHaveText(/Wait for the import to finish/);
        await page.evaluate(() => window.__release());
        await expect(actionNote(page, 'Imported')).toHaveCount(1);
        await expect.poll(() => calls(page, 'ai_write')).toEqual([]);
    });

    test('Suggest with AI stays disabled through an import, even when it is drawn again meanwhile', async ({ page }) => {
        const el = await importer(page, state);
        await page.evaluate(() => {
            const original = window.__backend.handlers.import_page_folder;
            window.__backend.handlers.import_page_folder = args => new Promise(resolve => { window.__release = () => resolve(original(args)); });
        });
        const suggest = el.locator('app-ai-action webui-button.ai-run');
        await expect(suggest).not.toHaveAttribute('disabled', /.*/);
        await importButton(el).click();
        await expect.poll(() => page.evaluate(() => typeof window.__release)).toBe('function');
        await expect(suggest).toHaveAttribute('disabled', /.*/);
        // Drawn again, as when its job is shown afresh, it is still disabled.
        await el.locator('app-ai-action').evaluate(node => node.refresh());
        await expect(suggest).toHaveAttribute('disabled', /.*/);
        await page.evaluate(() => window.__release());
        await expect(actionNote(page, 'Imported')).toHaveCount(1);
        await expect(suggest).not.toHaveAttribute('disabled', /.*/);
    });

    test('an answer full of other brackets is read quickly, and the list in it is found', async ({ page }) => {
        // Markdown links and checkboxes, thousands of '[' and ']', before the list.
        const noise = Array.from({ length: 400 }, (_, i) => `- [ ] See [item ${i}](#a) and [x]`).join('\n');
        const reply = `${noise}\n[{"file":"docs/index.md","title":"Overview","subtitle":"Has [brackets] and \\"quotes]\\"","navPath":[]}]\n${noise}`;
        const el = await importer(page, { ...state, aiReplies: { markdown: reply } });
        await el.locator('app-ai-action webui-button.ai-run').click();
        await expect(row(el, 'docs/index.md').locator('input[data-field="title"]')).toHaveValue('Overview');
        await expect(row(el, 'docs/index.md').locator('input[data-field="subtitle"]')).toHaveValue('Has [brackets] and "quotes]"');
    });

    test('an import moved elsewhere on the page and back still shows suggestions that come later', async ({ page }) => {
        const el = await importer(page, state);
        await page.evaluate(() => {
            const original = window.__backend.handlers.ai_write;
            window.__backend.handlers.ai_write = args => new Promise(resolve => { window.__release = () => resolve(original(args)); });
        });
        await el.locator('app-ai-action webui-button.ai-run').click();
        await expect.poll(() => page.evaluate(() => typeof window.__release)).toBe('function');
        await el.evaluate(node => { const holder = document.createElement('div'); node.parentNode.append(holder); holder.append(node); });
        await page.evaluate(() => window.__release());
        await expect(row(el, 'docs/guide/setup.md').locator('input[data-field="title"]')).toHaveValue('Installing');
    });

    test('an answer that isn\'t the list asked for says so, and nothing is filled in', async ({ page }) => {
        const el = await importer(page, { ...state, aiReplies: { markdown: 'I cannot help with that.' } });
        await el.locator('app-ai-action webui-button.ai-run').click();
        await expect(el.locator('app-ai-action webui-alert.ai-problem[show]')).toHaveText(/wasn't the list of pages asked for/);
        await expect(el.locator('.page-import-table')).toHaveCount(0);
    });

    test('with AI off for importing, there is no Suggest with AI and the import sends no overrides', async ({ page }) => {
        const el = await importer(page);
        await expect(el.locator('app-ai-action')).toBeHidden();
        await importButton(el).click();
        await expect.poll(() => calls(page, 'import_page_folder').then(list => list.map(call => 'overrides' in call))).toEqual([false]);
    });
});
