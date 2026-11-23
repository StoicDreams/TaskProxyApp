import { test, expect, openPage, calls } from '../support/app.mjs';
import { actionNote } from '../../support/wait.mjs';

const DATA = '<webui-data data-page-title="Release Notes" data-page-subtitle="What changed"></webui-data>';
const PAGE = `${DATA}

# Changes

<webui-page-segment>

Some **bold** text with a [link](https://example.com) and {GIT_PAT}.

- One
- Two

<webui-alert show>Watch out</webui-alert>

<webui-input-text label="Name" data-bind="name"></webui-input-text>

</webui-page-segment>

<webui-line></webui-line>

\`\`\`pwsh
Write-Host "<webui-alert>kept</webui-alert>"
\`\`\``;

const exporter = page => page.locator('app-page-handler app-page-export webui-select').first();
// A webui-select opens its options as tiles, so an option is picked by opening it and clicking that tile.
async function choose(page, value) {
    await exporter(page).locator('button[aria-haspopup]').click();
    await exporter(page).locator(`.tile[data-value="${value}"]`).click();
}
const exported = page => page.evaluate(() => window.__backend.exported);
const clipboard = page => page.evaluate(() => window.__backend.clipboard);

test('lists saving and copying for each format in place of Copy', async ({ page }) => {
    await openPage(page, PAGE);
    await expect(page.locator('app-page-handler webui-button.page-copy')).toHaveCount(0);
    await exporter(page).locator('button[aria-haspopup]').click();
    await expect(exporter(page).locator('.tile')).toHaveText(['Export', 'Save PDF', 'Copy PDF', 'Save HTML', 'Copy HTML', 'Save Markdown', 'Copy Markdown', 'Save Web UI Markdown', 'Copy Web UI Markdown', 'Save Plain Text', 'Copy Plain Text']);
});

test('saves Markdown without components or page data, with fenced code as written, and placeholders unfilled', async ({ page }) => {
    await openPage(page, PAGE);
    await choose(page, 'save:md');
    await expect(actionNote(page, 'Saved the page as Release Notes.md.')).toHaveCount(1);
    expect(await exported(page)).toEqual({
        title: 'Release Notes',
        kind: 'md',
        text: '# Release Notes\n\nWhat changed\n\n# Changes\n\nSome **bold** text with a [link](https://example.com) and {GIT_PAT}.\n\n- One\n- Two\n\nWatch out\n\n---\n\n```pwsh\nWrite-Host "<webui-alert>kept</webui-alert>"\n```\n',
    });
});

test('Web UI Markdown is the page\'s file as saved, not what is being edited', async ({ page }) => {
    await openPage(page, PAGE);
    const segment = page.locator('app-page-handler > webui-reorder > app-markdown-segment').first();
    await segment.locator('#btn-edit').click();
    await segment.locator('webui-input-text input').fill('Not saved');
    await choose(page, 'copy:webui');
    await expect(actionNote(page, 'Copied the page as Web UI Markdown.')).toHaveCount(1);
    expect(await clipboard(page)).toEqual({ text: PAGE });
    // Other formats export the page as it is shown.
    await choose(page, 'copy:md');
    await expect.poll(async () => (await clipboard(page)).text).toContain('# Not saved');
});

test('HTML is a page on its own, copied formatted with its source as the text', async ({ page }) => {
    await openPage(page, PAGE);
    await choose(page, 'copy:html');
    await expect(actionNote(page, 'Copied the page as HTML.')).toHaveCount(1);
    const { html, text } = await clipboard(page);
    expect(text).toBe(html);
    expect(html).toContain('<title>Release Notes</title>');
    expect(html).toContain('<h1>Release Notes</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<a href="https://example.com">link</a>');
    expect(html).toContain('<hr>');
    expect(html).toContain('<pre><code class="language-pwsh">Write-Host "&lt;webui-alert&gt;kept&lt;/webui-alert&gt;"</code></pre>');
    expect(html).not.toMatch(/<\/?(webui|app)-/);
    expect(html).not.toContain('<script');
});

test('plain text keeps the words, lists, and code, without markup', async ({ page }) => {
    await openPage(page, PAGE);
    await choose(page, 'save:txt');
    await expect(actionNote(page, 'Saved the page as Release Notes.txt.')).toHaveCount(1);
    expect((await exported(page)).text).toBe('Release Notes\nWhat changed\n\nChanges\n\nSome bold text with a link (https://example.com) and {GIT_PAT}.\n\n- One\n- Two\n\nWatch out\n\n----------\n\nWrite-Host "<webui-alert>kept</webui-alert>"\n');
});

test('a save dialog closed without a file says nothing', async ({ page }) => {
    await openPage(page, PAGE);
    await page.evaluate(() => { window.__backend.exportSaveAnswer = null; });
    await choose(page, 'save:html');
    await expect.poll(async () => (await calls(page, 'export_save')).length).toBe(1);
    await expect(exporter(page)).toHaveJSProperty('value', '');
    await expect(page.locator('app-page-handler webui-alert.action-note[show]')).toHaveCount(0);
});

test('why a page couldn\'t be saved is said by the menu', async ({ page }) => {
    await openPage(page, PAGE);
    await page.evaluate(() => { window.__backend.handlers.export_save = () => { throw 'Permission denied'; }; });
    await choose(page, 'save:md');
    await expect(actionNote(page, 'The page couldn\'t be exported: Permission denied')).toHaveCount(1);
});
