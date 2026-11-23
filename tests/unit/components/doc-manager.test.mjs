import { test, expect, openApp, calls } from '../support/app.mjs';
import { actionNote, alertPopup } from '../../support/wait.mjs';

const open = async (page, state) => {
    await openApp(page, { currentPage: '/docs', ...state }, '/docs');
    await page.locator('app-doc-manager').waitFor();
    await page.waitForFunction(() => document.querySelector('app-doc-manager')._list);
};
const manager = page => page.locator('app-doc-manager');
const docs = { docs: ['docs/guide.md', 'README.md'], files: { 'README.md': '# Read Me', 'docs/guide.md': '# Guide' } };
const row = (page, file) => manager(page).locator(`.file-row[data-file="${file}"]`);
const select = (page, file) => row(page, file).click();

test('file names show as written', async ({ page }) => {
    await open(page, { docs: ['R&D/notes.md'], files: { 'R&D/notes.md': '# Notes' } });
    await expect(manager(page).locator('.file-row')).toHaveText(['R&D/notes.md']);
});
test('the readme is listed first and shown', async ({ page }) => {
    await open(page, docs);
    await expect(manager(page).locator('webui-input-message textarea')).toHaveValue('# Read Me');
    await expect(manager(page).locator('webui-content h1')).toHaveText('Read Me');
});
test('editing updates the preview, and saving writes the file', async ({ page }) => {
    await open(page, docs);
    await expect(manager(page).locator('webui-input-message textarea')).toHaveValue('# Read Me');
    await manager(page).locator('webui-input-message textarea').fill('# Changed');
    await expect(manager(page).locator('webui-content h1')).toHaveText('Changed');
    await manager(page).locator('webui-button[label="Save"]').click();
    await expect.poll(async () => (await calls(page, 'save_project_file')).length).toBe(1);
    expect((await calls(page, 'save_project_file'))[0]).toEqual({ filePath: 'README.md', contents: '# Changed' });
});
test('what saving said goes when another file is shown', async ({ page }) => {
    await open(page, docs);
    await expect(manager(page).locator('webui-input-message textarea')).toHaveValue('# Read Me');
    await manager(page).locator('webui-input-message textarea').fill('# Changed');
    await manager(page).locator('webui-button[label="Save"]').click();
    await expect(manager(page).locator('webui-alert.action-note[show]')).toHaveCount(1);
    await select(page, 'docs/guide.md');
    await expect(manager(page).locator('webui-input-message textarea')).toHaveValue('# Guide');
    await expect(manager(page).locator('webui-alert.action-note[show]')).toHaveCount(0);
});
test('reset goes back to the saved file', async ({ page }) => {
    await open(page, docs);
    await expect(manager(page).locator('webui-input-message textarea')).toHaveValue('# Read Me');
    await manager(page).locator('webui-input-message textarea').fill('# Changed');
    await manager(page).locator('webui-button[label="Reset"]').click();
    await expect(manager(page).locator('webui-input-message textarea')).toHaveValue('# Read Me');
});
test('scripts in a document do not run', async ({ page }) => {
    await open(page, { docs: ['README.md'], files: { 'README.md': '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>' } });
    // The document has been shown, with its image and without its script.
    await expect(manager(page).locator('webui-content img')).toHaveCount(1);
    await expect(manager(page).locator('webui-content img')).not.toHaveAttribute('onerror');
    await expect(manager(page).locator('webui-content script')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__xss)).toBeUndefined();
});
test('a document that fails to load cannot be saved over', async ({ page }) => {
    await open(page, { docs: ['README.md'], files: {} });
    await expect(manager(page).locator('webui-content')).toHaveText(/Failed to load/);
    const save = manager(page).locator('webui-button[label="Save"]');
    await manager(page).locator('webui-input-message textarea').fill('# Typed over nothing');
    await expect(save).toHaveAttribute('disabled');
    await expect(save).toHaveAttribute('title', 'No doc has loaded to edit');
    await expect.poll(() => calls(page, 'save_project_file')).toEqual([]);
});
test('Save and Reset are off until the doc changes, and off again once it is saved', async ({ page }) => {
    await open(page, docs);
    const text = manager(page).locator('webui-input-message textarea');
    const save = manager(page).locator('webui-button[label="Save"]');
    const reset = manager(page).locator('webui-button[label="Reset"]');
    await expect(text).toHaveValue('# Read Me');
    await expect(save).toHaveAttribute('disabled');
    await expect(save).toHaveAttribute('title', 'This doc has no changes to save');
    await expect(reset).toHaveAttribute('disabled');
    await expect(reset).toHaveAttribute('title', 'This doc has no changes to reset');
    await text.fill('# Changed');
    await expect(save).not.toHaveAttribute('disabled');
    await expect(reset).not.toHaveAttribute('disabled');
    // Typed back as it was saved, there is nothing to save.
    await text.fill('# Read Me');
    await expect(save).toHaveAttribute('disabled');
    await text.fill('# Changed');
    await save.click();
    await expect(actionNote(manager(page), 'File saved')).toHaveCount(1);
    await expect(save).toHaveAttribute('disabled');
    await expect(reset).toHaveAttribute('disabled');
    // Another doc starts with nothing to save.
    await text.fill('# Changed again');
    await expect(save).not.toHaveAttribute('disabled');
    await select(page, 'docs/guide.md');
    await expect(text).toHaveValue('# Guide');
    await expect(save).toHaveAttribute('disabled');
});
test('a slow document cannot replace the one selected after it', async ({ page }) => {
    await open(page, docs);
    await expect(manager(page).locator('webui-input-message textarea')).toHaveValue('# Read Me');
    // The guide is held back until the test lets it go, after the readme has been selected and shown.
    await page.evaluate(() => {
        const original = window.__backend.handlers.get_project_file;
        const held = new Promise(resolve => { window.__releaseGuide = resolve; });
        window.__backend.handlers.get_project_file = async args => {
            if (args.filePath === 'docs/guide.md') await held;
            return original(args);
        };
        // Every load the manager starts, so the test can tell when each has been dealt with.
        const el = document.querySelector('app-doc-manager');
        const loadFile = el.loadFile;
        window.__loads = [];
        el.loadFile = function (file) {
            const load = loadFile.call(this, file);
            window.__loads.push(load);
            return load;
        };
    });
    await select(page, 'docs/guide.md');
    await expect.poll(() => calls(page, 'get_project_file')).toContainEqual({ filePath: 'docs/guide.md' });
    await select(page, 'README.md');
    await expect(manager(page).locator('webui-input-message textarea')).toHaveValue('# Read Me');
    await page.evaluate(() => {
        window.__releaseGuide();
        return Promise.all(window.__loads);
    });
    await expect(manager(page).locator('webui-input-message textarea')).toHaveValue('# Read Me');
    await expect(manager(page).locator('webui-content h1')).toHaveText('Read Me');
});
test('markup in a file name is shown as text', async ({ page }) => {
    const name = '<img src=q onerror="window.__xss=1">.md';
    await open(page, { docs: [name], files: { [name]: '# Doc' } });
    await expect(manager(page).locator('webui-input-message textarea')).toHaveValue('# Doc');
    await expect.poll(() => page.evaluate(() => window.__xss)).toBeUndefined();
    await expect(manager(page).locator('.file-list img')).toHaveCount(0);
    await expect(manager(page).locator('.file-row')).toHaveText([name]);
});
test('a save that finishes after another file is picked says nothing under that file', async ({ page }) => {
    await open(page, docs);
    await expect(manager(page).locator('webui-input-message textarea')).toHaveValue('# Read Me');
    // The readme's save is held until the test lets it go, and each save the manager starts is kept, so the test can
    // tell when the manager has dealt with it.
    await page.evaluate(() => {
        const held = new Promise(resolve => { window.__releaseSave = resolve; });
        window.__backend.handlers.save_project_file = async () => { await held; return 'Readme saved.'; };
        const save = webui.proxy.saveProjectFile;
        window.__saves = [];
        webui.proxy.saveProjectFile = function (...args) {
            const saving = save.apply(this, args);
            window.__saves.push(saving);
            return saving;
        };
    });
    await manager(page).locator('webui-input-message textarea').fill('# Changed');
    await manager(page).locator('webui-button[label="Save"]').click();
    await expect.poll(() => calls(page, 'save_project_file')).toHaveLength(1);
    await select(page, 'docs/guide.md');
    await expect(manager(page).locator('webui-input-message textarea')).toHaveValue('# Guide');
    await page.evaluate(() => {
        window.__releaseSave();
        return Promise.all(window.__saves);
    });
    await expect(manager(page).locator('webui-alert.action-note[show]')).toHaveCount(0);
});
test('a save that fails after another file is picked says which file was not saved', async ({ page }) => {
    await open(page, docs);
    await expect(manager(page).locator('webui-input-message textarea')).toHaveValue('# Read Me');
    // The readme's save is held until the test lets it go, then fails.
    await page.evaluate(() => {
        const held = new Promise(resolve => { window.__releaseSave = resolve; });
        window.__backend.handlers.save_project_file = async () => { await held; throw 'The disk is full.'; };
    });
    await manager(page).locator('webui-input-message textarea').fill('# Changed');
    await manager(page).locator('webui-button[label="Save"]').click();
    await expect.poll(() => calls(page, 'save_project_file')).toHaveLength(1);
    await select(page, 'docs/guide.md');
    await expect(manager(page).locator('webui-input-message textarea')).toHaveValue('# Guide');
    await page.evaluate(() => window.__releaseSave());
    await expect(alertPopup(page, "README.md wasn't saved: The disk is full.")).toHaveCount(1);
    // Nothing is said under the guide, which was not what failed.
    await expect(manager(page).locator('webui-alert.action-note[show]')).toHaveCount(0);
});
test('Save and Reset are disabled while a save runs', async ({ page }) => {
    await open(page, docs);
    await expect(manager(page).locator('webui-input-message textarea')).toHaveValue('# Read Me');
    await page.evaluate(() => {
        const held = new Promise(resolve => { window.__releaseSave = resolve; });
        window.__backend.handlers.save_project_file = async () => { await held; return 'Saved.'; };
    });
    const save = manager(page).locator('webui-button[label="Save"]');
    const reset = manager(page).locator('webui-button[label="Reset"]');
    await manager(page).locator('webui-input-message textarea').fill('# Changed');
    await save.click();
    await expect.poll(() => calls(page, 'save_project_file')).toHaveLength(1);
    // Typed while it saves, there is something left to save, but not until this save is done.
    await manager(page).locator('webui-input-message textarea').fill('# Changed again');
    await expect(save).toHaveAttribute('disabled', '');
    await expect(reset).toHaveAttribute('disabled', '');
    await page.evaluate(() => window.__releaseSave());
    await expect(actionNote(manager(page), 'Saved.')).toHaveCount(1);
    await expect(save).not.toHaveAttribute('disabled', /.*/);
    await expect(reset).not.toHaveAttribute('disabled', /.*/);
});
test('going back to a file while it saves shows what was saved', async ({ page }) => {
    await open(page, docs);
    await expect(manager(page).locator('webui-input-message textarea')).toHaveValue('# Read Me');
    // The readme's save is held until the test lets it go, then writes as the backend does.
    await page.evaluate(() => {
        const original = window.__backend.handlers.save_project_file;
        const held = new Promise(resolve => { window.__releaseSave = resolve; });
        window.__backend.handlers.save_project_file = async args => { await held; return original(args); };
    });
    await manager(page).locator('webui-input-message textarea').fill('# Edited');
    await manager(page).locator('webui-button[label="Save"]').click();
    await expect.poll(() => calls(page, 'save_project_file')).toHaveLength(1);
    await select(page, 'docs/guide.md');
    await expect(manager(page).locator('webui-input-message textarea')).toHaveValue('# Guide');
    await select(page, 'README.md');
    await page.evaluate(() => window.__releaseSave());
    await expect(manager(page).locator('webui-input-message textarea')).toHaveValue('# Edited');
    await expect(manager(page).locator('webui-content h1')).toHaveText('Edited');
});
test('each View toggle shows its panes one at a time, and is remembered', async ({ page }) => {
    await open(page, docs);
    await expect(manager(page).locator('webui-input-message textarea')).toHaveValue('# Read Me');
    const files = manager(page).locator('webui-split-panes.files-split');
    const editor = manager(page).locator('webui-split-panes.editor-split');
    await manager(page).locator('webui-toggle-icon.editor-view').click();
    await expect(editor).toHaveAttribute('single', '');
    await expect(files).not.toHaveAttribute('single');
    await expect.poll(() => page.evaluate(() => webui.getData('app-doc-editor-single'))).toBe(true);
    await manager(page).locator('webui-toggle-icon.files-view').click();
    await expect(files).toHaveAttribute('single', '');
    await expect.poll(() => page.evaluate(() => webui.getData('app-doc-manager-single'))).toBe(true);
    // One at a time, picking a doc from the list shows it.
    await files.evaluate(el => el.showPane('start'));
    await select(page, 'docs/guide.md');
    await expect(manager(page).locator('webui-input-message textarea')).toHaveValue('# Guide');
    await expect(files).toHaveAttribute('show', 'end');
    await expect(manager(page).locator('.file-row[aria-selected="true"]')).toHaveText(['docs/guide.md']);
});
test('Views chosen before are kept when the page opens', async ({ page }) => {
    await open(page, { ...docs, appData: { 'app-doc-manager-single': true, 'app-doc-editor-single': true } });
    await expect(manager(page).locator('webui-split-panes.files-split')).toHaveAttribute('single', '');
    await expect(manager(page).locator('webui-split-panes.editor-split')).toHaveAttribute('single', '');
});
