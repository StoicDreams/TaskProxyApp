import { test, expect, openApp, calls } from '../support/app.mjs';
import { alertPopup } from '../support/wait.mjs';

const open = async (page, state) => {
    await openApp(page, { currentPage: '/docs', ...state }, '/docs');
    await page.locator('app-doc-manager').waitFor();
    await page.waitForFunction(() => document.querySelector('app-doc-manager')._fileSelector?.setOptions);
};
const manager = page => page.locator('app-doc-manager');
const docs = { docs: ['docs/guide.md', 'README.md'], files: { 'README.md': '# Read Me', 'docs/guide.md': '# Guide' } };
const select = (page, file) => page.evaluate(file => {
    const el = document.querySelector('app-doc-manager');
    el._fileSelector.value = file;
    el._fileSelector.dispatchEvent(new Event('change'));
}, file);

test('file names show as written', async ({ page }) => {
    await open(page, { docs: ['R&D/notes.md'], files: { 'R&D/notes.md': '# Notes' } });
    await expect.poll(() => manager(page).evaluate(el => el._fileSelector._options[0]?.display)).toBe('R&D/notes.md');
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
    await manager(page).locator('webui-button[label="Save"]').click();
    await expect(alertPopup(page, 'This file has not loaded, so it was not saved.')).toHaveCount(1);
    await expect.poll(() => calls(page, 'save_project_file')).toEqual([]);
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
    await expect(manager(page).locator('webui-select img')).toHaveCount(0);
});
