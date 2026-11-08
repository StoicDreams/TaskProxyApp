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
    // connected() waits for every preloaded component, so wait for it to have set the markdown.
    await page.waitForFunction(() => document.querySelector('#seg')._type?.setOptions && document.querySelector('#seg')._markdown !== undefined);
    await page.waitForTimeout(150);
    return root;
}
const getMarkdown = page => page.evaluate(() => document.querySelector('#seg').getMarkdown());
const toggleEdit = page => page.evaluate(() => document.querySelector('#seg')._btnEdit.click());
/** Picks a segment type in the editor's switch, as a click would. */
const setType = (page, type) => page.locator('#seg webui-switch [role="radio"]', { hasText: new RegExp(`^${type}$`) }).click();

test('renders its markdown', async ({ page }) => {
    await segment(page, '# Heading');
    await expect(page.locator('#seg h1, #seg webui-content h1').first()).toHaveText('Heading');
});
for (const markdown of ['# Heading', '## Two', '<webui-page-segment>\n\nBody\n\n</webui-page-segment>', '<webui-page-segment elevation="10">\nBody\n</webui-page-segment>', '<webui-line></webui-line>']) {
    test(`opening and closing the editor leaves ${JSON.stringify(markdown)} unchanged`, async ({ page }) => {
        await segment(page, markdown);
        await toggleEdit(page);
        expect(await getMarkdown(page)).toBe(markdown);
        await toggleEdit(page);
        expect(await getMarkdown(page)).toBe(markdown);
    });
}
test('the switch shows the segment\'s type', async ({ page }) => {
    for (const [markdown, type] of [['## Two', 'h2'], ['<webui-line></webui-line>', 'line break'], ['<webui-page-segment>\n\nBody\n\n</webui-page-segment>', 'segment']]) {
        await segment(page, markdown);
        await expect(page.locator('#seg webui-switch [aria-checked="true"]')).toHaveText(type);
    }
});
test('the switch offers segment, the headings, and line break, with no raw option', async ({ page }) => {
    await segment(page, '# Heading');
    await expect(page.locator('#seg webui-switch [role="radio"]')).toHaveText(['segment', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'line break']);
});
test('a new segment is a page segment', async ({ page }) => {
    await segment(page, '');
    await expect(page.locator('#seg webui-switch [aria-checked="true"]')).toHaveText('segment');
    await toggleEdit(page);
    await page.locator('#seg webui-input-message textarea').fill('Hello');
    expect(await getMarkdown(page)).toBe('<webui-page-segment>\n\nHello\n\n</webui-page-segment>');
});
test('text outside a page segment is wrapped in one once edited', async ({ page }) => {
    await segment(page, 'Plain text\nsecond line');
    await toggleEdit(page);
    await toggleEdit(page);
    expect(await getMarkdown(page)).toBe('<webui-page-segment>\n\nPlain text\nsecond line\n\n</webui-page-segment>');
});
test('text with regex anchors survives editing', async ({ page }) => {
    const markdown = "<webui-page-segment>\n\n```pwsh\n$x -match '^abc$'\n$y = 'cost $$5 $& $`'\n```\n\n</webui-page-segment>";
    await segment(page, markdown);
    await toggleEdit(page);
    expect(await getMarkdown(page)).toBe(markdown);
    await page.locator('#seg webui-input-message textarea').press('End');
    await page.locator('#seg webui-input-message textarea').pressSequentially('!');
    expect(await getMarkdown(page)).toBe(markdown.replace('```\n\n</', '```!\n\n</'));
});
test('headings with dollar signs survive editing', async ({ page }) => {
    await segment(page, "## Costs $$ and $' here");
    await toggleEdit(page);
    await setType(page, 'h3');
    expect(await getMarkdown(page)).toBe("### Costs $$ and $' here");
});
test('text beginning with # but no space is not a heading', async ({ page }) => {
    await segment(page, '<webui-page-segment>\n\n#hashtag text\n\n</webui-page-segment>');
    await expect(page.locator('#seg webui-switch [aria-checked="true"]')).toHaveText('segment');
});
test('changing the segment type keeps the text and attributes', async ({ page }) => {
    await segment(page, '<webui-page-segment elevation="10">\n\nSome text\n\n</webui-page-segment>');
    await toggleEdit(page);
    await setType(page, 'h2');
    expect(await getMarkdown(page)).toBe('## Some text');
    await setType(page, 'line break');
    expect(await getMarkdown(page)).toBe('<webui-line></webui-line>');
    await setType(page, 'segment');
    expect(await getMarkdown(page)).toBe('<webui-page-segment elevation="10">\n\nSome text\n\n</webui-page-segment>');
});
test('several lines become one when changed to a heading', async ({ page }) => {
    await segment(page, '<webui-page-segment>\n\nOne\nTwo\n\n</webui-page-segment>');
    await toggleEdit(page);
    await setType(page, 'h1');
    expect(await getMarkdown(page)).toBe('# One Two');
});
test('delete removes the segment and tells the page', async ({ page }) => {
    await segment(page, '# Heading');
    await page.evaluate(() => document.addEventListener('segment-delete', () => { window.__deleted = true; }));
    await toggleEdit(page);
    await page.locator('#seg webui-button#btn-delete').click();
    await expect(page.locator('#seg')).toHaveCount(0);
    expect(await page.evaluate(() => window.__deleted)).toBe(true);
});
test('undo restores the original markdown', async ({ page }) => {
    const original = '<webui-page-segment>\n\nSome text\n\n</webui-page-segment>';
    await segment(page, original);
    await toggleEdit(page);
    await page.evaluate(() => {
        const el = document.querySelector('#seg');
        el._inputMessage.value = 'Changed';
    });
    expect(await getMarkdown(page)).toBe('<webui-page-segment>\n\nChanged\n\n</webui-page-segment>');
    await page.evaluate(() => document.querySelector('#seg')._btnUndo.click());
    expect(await getMarkdown(page)).toBe(original);
    await expect(page.locator('#seg')).not.toHaveClass(/isEditing/);
});
test('content typed into the editor is sanitized in the preview', async ({ page }) => {
    await segment(page, 'Some text');
    await toggleEdit(page);
    await page.locator('#seg webui-input-message textarea').fill('<img src=x onerror="window.__xss=1">');
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});
