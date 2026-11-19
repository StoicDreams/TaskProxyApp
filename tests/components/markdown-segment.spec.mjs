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
        await expect(page.locator('#seg')).toHaveClass(/isEditing/);
        await expect.poll(() => getMarkdown(page)).toBe(markdown);
        await toggleEdit(page);
        await expect(page.locator('#seg')).not.toHaveClass(/isEditing/);
        await expect.poll(() => getMarkdown(page)).toBe(markdown);
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
    await expect.poll(() => getMarkdown(page)).toBe('<webui-page-segment>\n\nHello\n\n</webui-page-segment>');
});
test('text outside a page segment is wrapped in one once edited', async ({ page }) => {
    await segment(page, 'Plain text\nsecond line');
    await toggleEdit(page);
    await toggleEdit(page);
    await expect.poll(() => getMarkdown(page)).toBe('<webui-page-segment>\n\nPlain text\nsecond line\n\n</webui-page-segment>');
});
test('text with regex anchors survives editing', async ({ page }) => {
    const markdown = "<webui-page-segment>\n\n```pwsh\n$x -match '^abc$'\n$y = 'cost $$5 $& $`'\n```\n\n</webui-page-segment>";
    await segment(page, markdown);
    await toggleEdit(page);
    await expect.poll(() => getMarkdown(page)).toBe(markdown);
    await page.locator('#seg webui-input-message textarea').press('End');
    await page.locator('#seg webui-input-message textarea').pressSequentially('!');
    await expect.poll(() => getMarkdown(page)).toBe(markdown.replace('```\n\n</', '```!\n\n</'));
});
test('headings with dollar signs survive editing', async ({ page }) => {
    await segment(page, "## Costs $$ and $' here");
    await toggleEdit(page);
    await setType(page, 'h3');
    await expect.poll(() => getMarkdown(page)).toBe("### Costs $$ and $' here");
});
test('text beginning with # but no space is not a heading', async ({ page }) => {
    await segment(page, '<webui-page-segment>\n\n#hashtag text\n\n</webui-page-segment>');
    await expect(page.locator('#seg webui-switch [aria-checked="true"]')).toHaveText('segment');
});
test('changing the segment type keeps the text and attributes', async ({ page }) => {
    await segment(page, '<webui-page-segment elevation="10">\n\nSome text\n\n</webui-page-segment>');
    await toggleEdit(page);
    await setType(page, 'h2');
    await expect.poll(() => getMarkdown(page)).toBe('## Some text');
    await setType(page, 'line break');
    await expect.poll(() => getMarkdown(page)).toBe('<webui-line></webui-line>');
    await setType(page, 'segment');
    await expect.poll(() => getMarkdown(page)).toBe('<webui-page-segment elevation="10">\n\nSome text\n\n</webui-page-segment>');
});
test('several lines become one when changed to a heading', async ({ page }) => {
    await segment(page, '<webui-page-segment>\n\nOne\nTwo\n\n</webui-page-segment>');
    await toggleEdit(page);
    await setType(page, 'h1');
    await expect.poll(() => getMarkdown(page)).toBe('# One Two');
});
test('delete removes the segment and tells the page', async ({ page }) => {
    await segment(page, '# Heading');
    await page.evaluate(() => document.addEventListener('segment-delete', () => { window.__deleted = true; }));
    await toggleEdit(page);
    await page.locator('#seg webui-button#btn-delete').click();
    await expect(page.locator('#seg')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__deleted)).toBe(true);
});
test('undo restores the original markdown', async ({ page }) => {
    const original = '<webui-page-segment>\n\nSome text\n\n</webui-page-segment>';
    await segment(page, original);
    await toggleEdit(page);
    await page.evaluate(() => {
        const el = document.querySelector('#seg');
        el._inputMessage.value = 'Changed';
    });
    await expect.poll(() => getMarkdown(page)).toBe('<webui-page-segment>\n\nChanged\n\n</webui-page-segment>');
    await page.evaluate(() => document.querySelector('#seg')._btnUndo.click());
    await expect.poll(() => getMarkdown(page)).toBe(original);
    await expect(page.locator('#seg')).not.toHaveClass(/isEditing/);
});
test('content typed into the editor is sanitized in the preview', async ({ page }) => {
    await segment(page, 'Some text');
    await toggleEdit(page);
    await page.locator('#seg webui-input-message textarea').fill('<img src=x onerror="window.__xss=1">');
    // The preview shows the image, without what would run.
    await expect(page.locator('#seg webui-content img')).toHaveCount(1);
    await expect(page.locator('#seg webui-content img')).not.toHaveAttribute('onerror');
    await expect.poll(() => page.evaluate(() => window.__xss)).toBeUndefined();
});
test("images and videos with relative addresses load the project's files, from beside the page's file", async ({ page }) => {
    // Pages are saved in .taskproxy/pages, so ../../ is the project's root, as imported pages write it.
    await segment(page, [
        '![logo](../../docs/logo%20big.svg)',
        '<video src="../../media/demo.mp4" poster="../../media/poster.png"></video>',
        '![web](https://example.com/a.png)',
        '![outside](../../../outside.png)',
        '```md\n![code](../../docs/logo.svg)\n```',
    ].join('\n\n'));
    const content = page.locator('#seg webui-content');
    await expect(content.locator('img[alt="logo"]')).toHaveAttribute('src', 'http://files.localhost/token/docs%2Flogo%20big.svg');
    await expect(content.locator('video')).toHaveAttribute('src', 'http://files.localhost/token/media%2Fdemo.mp4');
    await expect(content.locator('video')).toHaveAttribute('poster', 'http://files.localhost/token/media%2Fposter.png');
    // Websites, and paths that leave the project, are left as written, and code shows what was written.
    await expect(content.locator('img[alt="web"]')).toHaveAttribute('src', 'https://example.com/a.png');
    await expect(content.locator('img[alt="outside"]')).toHaveAttribute('src', '../../../outside.png');
    await expect(content.locator('code')).toContainText('![code](../../docs/logo.svg)');
});
