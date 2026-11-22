import { test, expect, openApp, mount, calls, openDialog, dialogButton } from '../support/app.mjs';

// The Write with AI button (wc/ai-action.js): shown only while its integration is on, it asks what to write when told
// to, runs the page's action with the model chosen, shows it is busy, and drops an answer after Cancel.
const AI = { providers: [{ id: 'p', name: 'Local', kind: 'command', command: 'x', models: [{ id: 'm', name: 'Model' }], hidden: [] }] };

async function action(page, { on = true, html = '<app-ai-action id="a" integration="pages" ask="What should it say?"></app-ai-action>' } = {}) {
    await openApp(page, { ai: AI, appData: { 'app-ai-integrations': { pages: on } } });
    const root = await mount(page, html);
    return root.locator('#a');
}
const run = el => el.locator('webui-button.ai-run');

test('it shows only while its integration is turned on', async ({ page }) => {
    const el = await action(page, { on: false });
    await expect(el).toBeHidden();
    await page.evaluate(() => webui.setData('app-ai-integrations', { pages: true }));
    await expect(el).toBeVisible();
});

test('it asks what to write, then runs the action with that and the model chosen', async ({ page }) => {
    const el = await action(page);
    await el.evaluate(node => {
        node.askValue = 'Explain setup';
        node.action = async args => { window.__args = { model: args.model, asked: args.asked, current: args.isCurrent() }; };
    });
    await run(el).click();
    const dialog = openDialog(page);
    await expect(dialog.locator('textarea[name="ai_request"]')).toHaveValue('Explain setup');
    await dialog.locator('textarea[name="ai_request"]').fill('Explain installing on Windows');
    await dialogButton(page, 'Write with AI').click();
    await expect.poll(() => page.evaluate(() => window.__args)).toEqual({ model: { provider: 'p', model: 'm' }, asked: 'Explain installing on Windows', current: true });
});

test('cancelling what it asks runs nothing', async ({ page }) => {
    const el = await action(page);
    await el.evaluate(node => { window.__ran = []; node.action = async ({ asked }) => { window.__ran.push(asked); }; });
    await run(el).click();
    await dialogButton(page, 'Cancel').click();
    await expect(openDialog(page)).toBeHidden();
    // Asked again and answered, only that one runs: the one cancelled, which would have run first, never did.
    await run(el).click();
    await openDialog(page).locator('textarea[name="ai_request"]').fill('Second');
    await dialogButton(page, 'Write with AI').click();
    await expect.poll(() => page.evaluate(() => window.__ran)).toEqual(['Second']);
});

test('only spaces asks for nothing: the question stays open, and Cancel then runs nothing', async ({ page }) => {
    const el = await action(page);
    await el.evaluate(node => { window.__ran = []; node.action = async ({ asked }) => { window.__ran.push(asked); }; });
    await run(el).click();
    await openDialog(page).locator('textarea[name="ai_request"]').fill('   ');
    await dialogButton(page, 'Write with AI').click();
    await expect(openDialog(page).locator('textarea[name="ai_request"]')).toBeVisible();
    await dialogButton(page, 'Cancel').click();
    await expect(openDialog(page)).toBeHidden();
    // Asked again and answered, only that one runs.
    await run(el).click();
    await openDialog(page).locator('textarea[name="ai_request"]').fill('Second');
    await dialogButton(page, 'Write with AI').click();
    await expect.poll(() => page.evaluate(() => window.__ran)).toEqual(['Second']);
});

test('what was typed while another button started the same job is not dropped unsaid, and is asked with again', async ({ page }) => {
    const el = await action(page, { html: '<app-ai-action id="a" integration="pages"></app-ai-action><app-ai-action id="b" integration="pages" ask="What should it say?"></app-ai-action>' });
    const other = page.locator('#b');
    await page.evaluate(() => {
        window.__ran = [];
        document.querySelectorAll('app-ai-action').forEach(node => {
            node.job = () => 'repo-a';
            node.action = ({ asked }) => new Promise(resolve => { window.__ran.push(asked); window.__finish = resolve; });
        });
    });
    await run(other).click();
    await openDialog(page).locator('textarea[name="ai_request"]').fill('Explain setup');
    // The other button starts the same job while this one asks.
    await run(el).click();
    await expect(el.locator('webui-button.ai-cancel')).toBeVisible();
    await dialogButton(page, 'Write with AI').click();
    await expect(other.locator('webui-alert.ai-problem[show]')).toHaveText(/already being written when you asked, so your request wasn't sent/);
    await expect.poll(() => page.evaluate(() => window.__ran)).toEqual(['']);
    await page.evaluate(() => window.__finish());
    await expect(run(other)).not.toHaveAttribute('disabled', /.*/);
    await run(other).click();
    await expect(openDialog(page).locator('textarea[name="ai_request"]')).toHaveValue('Explain setup');
});

test('while blocked it stays disabled, whether or not it is busy', async ({ page }) => {
    const el = await action(page, { html: '<app-ai-action id="a" integration="pages"></app-ai-action>' });
    await el.evaluate(node => { node.action = () => new Promise(resolve => { window.__finish = resolve; }); });
    await el.evaluate(node => { node.blocked = true; });
    await expect(run(el)).toHaveAttribute('disabled', /.*/);
    // A request ending, which draws it as not busy, leaves it disabled.
    await el.evaluate(node => { node.blocked = false; });
    await run(el).click();
    await expect(el.locator('webui-button.ai-cancel')).toBeVisible();
    await el.evaluate(node => { node.blocked = true; });
    await page.evaluate(() => window.__finish());
    await expect(el.locator('webui-button.ai-cancel')).toBeHidden();
    await expect(run(el)).toHaveAttribute('disabled', /.*/);
    await el.evaluate(node => { node.blocked = false; });
    await expect(run(el)).not.toHaveAttribute('disabled', /.*/);
});

test('blocked set before it is drawn is kept', async ({ page }) => {
    await openApp(page, { ai: AI, appData: { 'app-ai-integrations': { pages: true } } });
    await page.evaluate(() => {
        const node = document.createElement('app-ai-action');
        node.id = 'a';
        node.setAttribute('integration', 'pages');
        node.blocked = true;
        document.body.appendChild(node);
    });
    await expect(page.locator('#a webui-button.ai-run')).toHaveAttribute('disabled', /.*/);
});

test('while it runs it is busy with Cancel, and Cancel drops the answer and stops the request', async ({ page }) => {
    const el = await action(page, { html: '<app-ai-action id="a" integration="pages"></app-ai-action>' });
    await el.evaluate(node => {
        node.action = args => new Promise(resolve => { window.__finish = () => { window.__stale = !args.isCurrent(); window.__id = args.requestId; resolve(); }; });
    });
    await run(el).click();
    await expect(el.locator('webui-button.ai-cancel')).toBeVisible();
    await expect(run(el)).toHaveAttribute('disabled', /.*/);
    await el.locator('webui-button.ai-cancel').click();
    await expect(el.locator('webui-button.ai-cancel')).toBeHidden();
    await expect(run(el)).not.toHaveAttribute('disabled', /.*/);
    await page.evaluate(() => window.__finish());
    await expect.poll(() => page.evaluate(() => window.__stale)).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__id)).toBeTruthy();
    const id = await page.evaluate(() => window.__id);
    await expect.poll(() => calls(page, 'ai_cancel')).toEqual([{ requestId: id }]);
});

test('a failure is shown, and the button is ready again', async ({ page }) => {
    const el = await action(page, { html: '<app-ai-action id="a" integration="pages"></app-ai-action>' });
    await el.evaluate(node => { node.action = async () => { throw 'Ollama can\'t be reached: connection refused'; }; });
    await run(el).click();
    // Said under the button, rather than in a popup.
    await expect(el.locator('webui-alert.ai-problem[show]')).toHaveText("Ollama can't be reached: connection refused");
    await expect(run(el)).not.toHaveAttribute('disabled', /.*/);
});

test('what it last said stays when the question is cancelled, and goes once something is asked', async ({ page }) => {
    const el = await action(page);
    await el.evaluate(node => { node.action = async () => { throw 'Ollama can\'t be reached: connection refused'; }; });
    await run(el).click();
    await openDialog(page).locator('textarea[name="ai_request"]').fill('First');
    await dialogButton(page, 'Write with AI').click();
    await expect(el.locator('webui-alert.ai-problem[show]')).toHaveText("Ollama can't be reached: connection refused");
    await run(el).click();
    await dialogButton(page, 'Cancel').click();
    await expect(openDialog(page)).toBeHidden();
    await expect(el.locator('webui-alert.ai-problem[show]')).toHaveText("Ollama can't be reached: connection refused");
    await el.evaluate(node => { node.action = () => new Promise(resolve => { window.__finish = resolve; }); });
    await run(el).click();
    await openDialog(page).locator('textarea[name="ai_request"]').fill('Second');
    await dialogButton(page, 'Write with AI').click();
    await expect.poll(() => page.evaluate(() => typeof window.__finish)).toBe('function');
    await expect(el.locator('webui-alert.ai-problem[show]')).toHaveCount(0);
    await page.evaluate(() => window.__finish());
});

test('Instructions opens that integration\'s instructions', async ({ page }) => {
    const el = await action(page);
    await el.locator('webui-button.ai-instructions').click();
    await expect(openDialog(page).locator('app-ai-instructions[integration="pages"] webui-button[slot="tabs"]')).toHaveText(['Shared', 'Pages']);
});

test('one listener for progress serves every button, however often pages draw them', async ({ page }) => {
    await openApp(page, { ai: AI, appData: { 'app-ai-integrations': { pages: true } } });
    await mount(page, '<app-ai-action id="a" integration="pages"></app-ai-action>');
    await expect(page.locator('#a webui-button.ai-run')).toHaveCount(1);
    // Only the buttons listen for progress, so the window's listeners for it are theirs, whenever they were drawn.
    await expect.poll(() => page.evaluate(() => window.__backend.listening('ai-progress'))).toBe(1);
    // A page visited again draws a new button in place of the old one.
    await mount(page, '<app-ai-action id="b" integration="pages"></app-ai-action>');
    const last = await mount(page, '<app-ai-action id="c" integration="pages"></app-ai-action>');
    const button = last.locator('#c');
    await expect(button.locator('webui-button.ai-run')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => window.__backend.listening('ai-progress'))).toBe(1);
    // That one listener brings progress to the button drawn last.
    await button.evaluate(node => {
        node.job = () => 'repo-a';
        node.action = ({ requestId }) => new Promise(() => { window.__id = requestId; });
    });
    await button.locator('webui-button.ai-run').click();
    await expect.poll(() => page.evaluate(() => window.__id)).toBeTruthy();
    await page.evaluate(() => window.__backend.emit('ai-progress', { requestId: window.__id, done: 1, total: 3 }));
    await expect(button.locator('.ai-status')).toHaveText('Working on 2 of 3');
});

test('buttons for the same job share its request: each shows it running, and Cancel on either stops it', async ({ page }) => {
    const el = await action(page);
    await el.evaluate(node => {
        node.job = () => 'repo-a';
        node.action = ({ requestId }) => new Promise(() => { window.__id = requestId; });
    });
    await run(el).click();
    await openDialog(page).locator('textarea[name="ai_request"]').fill('Something');
    await dialogButton(page, 'Write with AI').click();
    await expect(el.locator('webui-button.ai-cancel')).toBeVisible();
    // Drawn again, as a page left and visited again is, it shows the same request.
    await el.evaluate(node => {
        const other = document.createElement('app-ai-action');
        other.id = 'b';
        other.setAttribute('integration', 'pages');
        other.job = () => 'repo-a';
        node.after(other);
    });
    const other = page.locator('#b');
    await expect(other.locator('webui-button.ai-cancel')).toBeVisible();
    await expect(run(other)).toHaveAttribute('disabled', '');
    await other.locator('webui-button.ai-cancel').click();
    await expect(el.locator('webui-button.ai-cancel')).toBeHidden();
    await expect(other.locator('webui-button.ai-cancel')).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.__id)).toBeTruthy();
    const id = await page.evaluate(() => window.__id);
    await expect.poll(() => calls(page, 'ai_cancel')).toEqual([{ requestId: id }]);
});

test('a second click while it asks opens no second question', async ({ page }) => {
    const el = await action(page);
    await el.evaluate(node => { node.action = async () => { }; });
    await run(el).click();
    await expect(openDialog(page).locator('textarea[name="ai_request"]')).toHaveCount(1);
    // The second is done once it returns, which it would only do after its own question if it asked one.
    await el.evaluate(node => { node.run().then(() => { window.__secondDone = true; }); });
    await expect.poll(() => page.evaluate(() => window.__secondDone)).toBe(true);
    await expect(page.locator('dialog[open]')).toHaveCount(1);
});

test('a job running shows on its button only while the button is for that job\'s integration', async ({ page }) => {
    const el = await action(page, { html: '<app-ai-action id="a" integration="pages"></app-ai-action>' });
    await el.evaluate(node => {
        node.job = () => 'repo-a';
        node.action = () => new Promise(() => { });
    });
    await run(el).click();
    await expect(run(el)).toHaveAttribute('disabled', /.*/);
    await el.evaluate(node => node.setAttribute('integration', 'git'));
    await expect(run(el)).not.toHaveAttribute('disabled', /.*/);
    await expect(run(el)).toHaveAttribute('label', 'Write with AI');
    await el.evaluate(node => node.setAttribute('integration', 'pages'));
    await expect(run(el)).toHaveAttribute('disabled', /.*/);
    await expect(run(el)).toHaveAttribute('label', 'Writing');
});

test('its label and icon follow changes to them', async ({ page }) => {
    const el = await action(page);
    await expect(run(el)).toHaveAttribute('label', 'Write with AI');
    await el.evaluate(node => { node.setAttribute('label', 'Suggest'); node.setAttribute('icon', 'star'); });
    await expect(run(el)).toHaveAttribute('label', 'Suggest');
    await expect(run(el)).toHaveAttribute('start-icon', 'star');
});

test('its style is added once to the page, and once to each shadow root it is drawn in', async ({ page }) => {
    await action(page, { html: '<app-ai-action id="a" integration="pages"></app-ai-action><app-ai-action id="b" integration="pages"></app-ai-action><div id="host"></div>' });
    await expect(page.locator('#b webui-button.ai-run')).toHaveCount(1);
    await page.evaluate(() => {
        const root = document.querySelector('#host').attachShadow({ mode: 'open' });
        root.innerHTML = '<app-ai-action integration="pages"></app-ai-action><app-ai-action integration="pages"></app-ai-action>';
        window.__shadow = root;
    });
    await expect.poll(() => page.evaluate(() => window.__shadow.querySelectorAll('webui-button.ai-run').length)).toBe(2);
    expect(await page.evaluate(() => [document.querySelectorAll('style.ai-action-style').length, window.__shadow.querySelectorAll('style.ai-action-style').length])).toEqual([1, 1]);
});
