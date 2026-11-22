import { test, expect, openApp, calls, dialogButton } from '../support/app.mjs';
import { alertPopup } from '../../support/wait.mjs';

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

test.describe('Write with AI', () => {
    const AI = { providers: [{ id: 'p', name: 'Local', kind: 'openAi', baseUrl: 'http://localhost:11434/v1', models: [{ id: 'm', name: 'Model' }], hidden: [] }] };
    async function twoSegments(page, on = true) {
        await openApp(page, { project: null, ai: AI, appData: { 'app-ai-integrations': { pages: on } }, aiReplies: { pages: 'Run **Install.ps1** as an administrator.' } });
        await page.evaluate(async () => {
            const list = webui.create('div', { id: 'list' });
            list.append(
                webui.create('app-markdown-segment', { 'data-markdown': '## Installing', id: 'first' }),
                webui.create('app-markdown-segment', { 'data-markdown': '<webui-page-segment>\n\nOld steps.\n\n</webui-page-segment>', id: 'seg' }),
            );
            document.body.appendChild(list);
            await customElements.whenDefined('app-markdown-segment');
        });
        await page.waitForFunction(() => document.querySelector('#seg')._markdown !== undefined && document.querySelector('#seg')._ai);
        await toggleEdit(page);
    }
    const ai = page => page.locator('#seg #ai-segment');

    test('it writes the part from what is asked, with the page as context, and Undo puts it back', async ({ page }) => {
        await twoSegments(page);
        await ai(page).locator('webui-button.ai-run').click();
        await page.locator('textarea[name="ai_request"]').fill('Explain installing on Windows');
        await dialogButton(page, 'Write with AI').click();
        await expect(page.locator('#seg webui-input-message textarea')).toHaveValue('Run **Install.ps1** as an administrator.');
        await expect(page.locator('#seg webui-content strong')).toHaveText('Install.ps1');
        const sent = (await calls(page, 'ai_write')).at(-1).request;
        expect(sent.integration).toBe('pages');
        expect(sent.context).toContain('## Installing\n\n[THE PART TO WRITE]');
        expect(sent.request).toContain('Explain installing on Windows');
        expect(sent.request).toContain('Old steps.');
        await page.evaluate(() => document.querySelector('#seg')._btnUndo.click());
        await expect.poll(() => getMarkdown(page)).toContain('Old steps.');
    });

    const ask = async page => {
        await ai(page).locator('webui-button.ai-run').click();
        await page.locator('textarea[name="ai_request"]').fill('Explain installing on Windows');
        await dialogButton(page, 'Write with AI').click();
    };

    test('text typed while it writes is kept, and the draft is not used', async ({ page }) => {
        await twoSegments(page);
        await page.evaluate(() => {
            const original = window.__backend.handlers.ai_write;
            window.__backend.handlers.ai_write = args => new Promise(resolve => { window.__release = () => resolve(original(args)); });
        });
        await ask(page);
        await expect.poll(() => page.evaluate(() => typeof window.__release)).toBe('function');
        await page.locator('#seg webui-input-message textarea').fill('My own steps.');
        await page.evaluate(() => window.__release());
        await expect(ai(page).locator('webui-alert.ai-problem[show]')).toHaveText(/changed while AI was writing, so the draft wasn't used/);
        await expect(page.locator('#seg webui-input-message textarea')).toHaveValue('My own steps.');
    });

    test('an answer wrapped in segment tags is used without them, so segments never nest', async ({ page }) => {
        await twoSegments(page);
        await page.evaluate(() => { window.__backend.handlers.ai_write = () => '<webui-page-segment>\n\nNew steps.\n\n</webui-page-segment>'; });
        await ask(page);
        await expect(page.locator('#seg webui-input-message textarea')).toHaveValue('New steps.');
        await expect.poll(() => calls(page, 'ai_write').then(list => list.at(-1)?.request.request)).toContain('without the <webui-page-segment> tags');
    });

    for (const [kind, reply] of [
        ['two segments', '<webui-page-segment>\n\nOne.\n\n</webui-page-segment>\n\n<webui-page-segment>\n\nTwo.\n\n</webui-page-segment>'],
        ['a closing tag', 'New steps.\n\n</webui-page-segment>\n\n# Added'],
    ]) {
        test(`an answer still holding segment tags after unwrapping, ${kind}, says so and leaves the part as it was`, async ({ page }) => {
            await twoSegments(page);
            await page.evaluate(reply => { window.__backend.handlers.ai_write = () => reply; }, reply);
            await ask(page);
            await expect(ai(page).locator('webui-alert.ai-problem[show]')).toHaveText(/held page segment tags, which would break the page/);
            await expect(page.locator('#seg webui-input-message textarea')).toHaveValue('Old steps.');
        });
    }

    test('an answer that comes after the editor closed says it wasn\'t used', async ({ page }) => {
        await twoSegments(page);
        await page.evaluate(() => {
            const original = window.__backend.handlers.ai_write;
            window.__backend.handlers.ai_write = args => new Promise(resolve => { window.__release = () => resolve(original(args)); });
        });
        await ask(page);
        await expect.poll(() => page.evaluate(() => typeof window.__release)).toBe('function');
        await page.evaluate(() => document.querySelector('#seg').remove());
        await page.evaluate(() => window.__release());
        await expect(alertPopup(page, "The editor was closed before AI finished, so the draft wasn't used.")).toHaveCount(1);
    });

    for (const [how, button] of [['Undo', '_btnUndo'], ['Save', '_btnEdit']]) {
        test(`an answer that comes after ${how} closed the editor says it wasn't used, where it can be seen`, async ({ page }) => {
            await twoSegments(page);
            await page.evaluate(() => {
                const original = window.__backend.handlers.ai_write;
                window.__backend.handlers.ai_write = args => new Promise(resolve => { window.__release = () => resolve(original(args)); });
            });
            await ask(page);
            await expect.poll(() => page.evaluate(() => typeof window.__release)).toBe('function');
            // The editor closes, and its Write with AI button stays, hidden with it.
            await page.evaluate(button => document.querySelector('#seg')[button].click(), button);
            await expect(page.locator('#seg')).not.toHaveClass(/isEditing/);
            await page.evaluate(() => window.__release());
            await expect(alertPopup(page, "The editor was closed before AI finished, so the draft wasn't used.")).toHaveCount(1);
        });
    }

    test('an empty answer says so, and leaves the part as it was', async ({ page }) => {
        await twoSegments(page);
        await page.evaluate(() => { window.__backend.handlers.ai_write = () => '  \n '; });
        await ask(page);
        await expect(ai(page).locator('webui-alert.ai-problem[show]')).toHaveText(/The AI answer was empty/);
        await expect(page.locator('#seg webui-input-message textarea')).toHaveValue('Old steps.');
    });

    test('a heading answered with no heading text says so, and keeps the heading', async ({ page }) => {
        await twoSegments(page);
        await setType(page, 'h2');
        await page.locator('#seg webui-input-text input').fill('Installing');
        await page.evaluate(() => { window.__backend.handlers.ai_write = () => '##\n\n'; });
        await ask(page);
        await expect(ai(page).locator('webui-alert.ai-problem[show]')).toHaveText(/The AI answer was empty/);
        await expect(page.locator('#seg webui-input-text input')).toHaveValue('Installing');
    });

    test('a line break has no Write with AI, and gets it back as another type', async ({ page }) => {
        await twoSegments(page);
        await expect(ai(page)).toBeVisible();
        await setType(page, 'line break');
        await expect(ai(page)).toBeHidden();
        await setType(page, 'segment');
        await expect(ai(page)).toBeVisible();
    });

    test('with AI off for pages, there is no Write with AI', async ({ page }) => {
        await twoSegments(page, false);
        await expect(ai(page)).toBeHidden();
    });
});
