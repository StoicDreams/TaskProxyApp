import { test, expect, openApp } from '../support/app.mjs';

async function segment(page, markdown) {
    await openApp(page, { project: null });
    await page.evaluate(() => { window.__markdown = undefined; });
    const root = await page.evaluate(async markdown => {
        const el = webui.create('app-markdown-segment', { 'data-markdown': markdown, id: 'seg' });
        document.body.appendChild(el);
        await customElements.whenDefined('app-markdown-segment');
        await customElements.whenDefined('webui-content');
    }, markdown);
    await page.waitForFunction(() => document.querySelector('#seg')._options?.setOptions);
    await page.waitForTimeout(150);
    return root;
}
const getMarkdown = page => page.evaluate(() => document.querySelector('#seg').getMarkdown());
const toggleEdit = page => page.evaluate(() => document.querySelector('#seg')._btnEdit.click());
const setOption = (page, value) => page.evaluate(value => {
    const el = document.querySelector('#seg');
    el._options.value = value;
    el._options.dispatchEvent(new Event('change'));
}, value);
const SEGMENT = '<webui-page-segment>\n\n{}\n\n</webui-page-segment>';

test('renders its markdown', async ({ page }) => {
    await segment(page, '# Heading');
    await expect(page.locator('#seg h1, #seg webui-content h1').first()).toHaveText('Heading');
});
for (const markdown of ['# Heading', '## Two', 'Plain text\nsecond line', '<webui-page-segment>\n\nBody\n\n</webui-page-segment>', '<webui-line></webui-line>', '```pwsh\nWrite-Host a\n```']) {
    test(`opening and closing the editor leaves ${JSON.stringify(markdown)} unchanged`, async ({ page }) => {
        await segment(page, markdown);
        await toggleEdit(page);
        expect(await getMarkdown(page)).toBe(markdown);
        await toggleEdit(page);
        expect(await getMarkdown(page)).toBe(markdown);
    });
}
test('text with regex anchors survives editing', async ({ page }) => {
    const markdown = "<webui-page-segment>\n\n```pwsh\n$x -match '^abc$'\n$y = 'cost $$5 $& $`'\n```\n\n</webui-page-segment>";
    await segment(page, markdown);
    await toggleEdit(page);
    expect(await getMarkdown(page)).toBe(markdown);
    await toggleEdit(page);
    expect(await getMarkdown(page)).toBe(markdown);
});
test('headings with dollar signs survive editing', async ({ page }) => {
    await segment(page, "## Costs $$ and $' here");
    await toggleEdit(page);
    await toggleEdit(page);
    expect(await getMarkdown(page)).toBe("## Costs $$ and $' here");
});
test('several lines that begin with a heading stay together', async ({ page }) => {
    const markdown = '# Title\nSecond line\nThird line';
    await segment(page, markdown);
    await toggleEdit(page);
    await toggleEdit(page);
    expect(await getMarkdown(page)).toBe(markdown);
});
test('text beginning with # but no space is not rewritten as a heading', async ({ page }) => {
    await segment(page, '#hashtag text');
    await toggleEdit(page);
    await toggleEdit(page);
    expect(await getMarkdown(page)).toBe('#hashtag text');
});
test('changing the segment type keeps the text', async ({ page }) => {
    await segment(page, 'Some text');
    await toggleEdit(page);
    await setOption(page, '## {}');
    expect(await getMarkdown(page)).toBe('## Some text');
    await setOption(page, SEGMENT);
    expect(await getMarkdown(page)).toBe('<webui-page-segment>\n\nSome text\n\n</webui-page-segment>');
});
test('a deleted segment is left out while editing', async ({ page }) => {
    await segment(page, 'Some text');
    await toggleEdit(page);
    await setOption(page, '***DELETING CONTENT***');
    expect(await getMarkdown(page)).toBeNull();
});
test('a deleted segment stays deleted after closing the editor', async ({ page }) => {
    await segment(page, 'Some text');
    await toggleEdit(page);
    await setOption(page, '***DELETING CONTENT***');
    await toggleEdit(page);
    expect(await getMarkdown(page)).toBeNull();
});
test('undo restores the original markdown', async ({ page }) => {
    await segment(page, 'Some text');
    await toggleEdit(page);
    await page.evaluate(() => {
        const el = document.querySelector('#seg');
        el._inputMessage.value = 'Changed';
    });
    expect(await getMarkdown(page)).toBe('Changed');
    await page.evaluate(() => document.querySelector('#seg')._btnUndo.click());
    expect(await getMarkdown(page)).toBe('Some text');
    await expect(page.locator('#seg')).not.toHaveClass(/isEditing/);
});
test('content typed into the editor is sanitized in the preview', async ({ page }) => {
    await segment(page, 'Some text');
    await toggleEdit(page);
    await page.locator('#seg webui-input-message textarea').fill('<img src=x onerror="window.__xss=1">');
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});
