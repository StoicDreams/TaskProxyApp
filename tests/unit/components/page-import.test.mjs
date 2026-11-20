import { test, expect, openApp, mount, calls } from '../support/app.mjs';
import { alertPopup } from '../../support/wait.mjs';

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
    await expect(alertPopup(page, 'Imported 2 pages into Guides.')).toHaveCount(1);
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
    await expect(alertPopup(page, 'Imported 1 page.')).toHaveCount(1);
    await expect.poll(() => calls(page, 'import_page_folder')).toEqual([{ folder: '', parent: null, navigation: NAVIGATION }]);
    await expect.poll(() => navigation(page)).toEqual([...NAVIGATION, { name: 'Imported', icon: 'file', url: '/imported-0', children: null }]);
});

test('a new folder needs a name', async ({ page }) => {
    const el = await importer(page);
    await nameInput(el).fill('  ');
    await importButton(el).click();
    await expect(alertPopup(page, 'Name the folder the pages go in.')).toHaveCount(1);
    await expect.poll(() => calls(page, 'import_page_folder')).toEqual([]);
});

test('files that could not be read are named', async ({ page }) => {
    const el = await importer(page, { importSkipped: ['docs/b.md (not text)'] });
    await importButton(el).click();
    await expect(alertPopup(page, 'These files could not be read as text, so they were left out: docs/b.md (not text)')).toHaveCount(1);
});

test('an import the backend refuses says why, and changes nothing', async ({ page }) => {
    const el = await importer(page);
    await page.evaluate(() => { window.__backend.handlers.import_page_folder = () => { throw 'Import Failed: There are no markdown files in docs.'; }; });
    await importButton(el).click();
    await expect(alertPopup(page, 'Import Failed: There are no markdown files in docs.')).toHaveCount(1);
    await expect.poll(() => navigation(page)).toEqual(NAVIGATION);
    await expect.poll(() => calls(page, 'save_project_data')).toEqual([]);
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
