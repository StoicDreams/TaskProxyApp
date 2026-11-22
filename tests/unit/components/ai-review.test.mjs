import { test, expect, openApp, calls, switchProject, goToPage, openDialog, dialogButton } from '../support/app.mjs';

// AI in the Git Controller: Write with AI fills the commit message from the included files, and the Review tab
// (wc/ai-review.js) reviews those changes or the whole project, between Commit and Branches while reviews are on.
const AI = { providers: [{ id: 'p', name: 'Local', kind: 'openAi', baseUrl: 'http://localhost:11434/v1', models: [{ id: 'm', name: 'Model' }], hidden: [] }] };
// Markup a model could be led to write by the repo: a script, handlers, a javascript: link, and a frame's own page.
const REPORT = '## Findings\n\n1. **a.txt**: <script>window.__ran = 1</script><img src="x.png" onerror="window.__ran = 2">'
    + '<a href="javascript:window.__ran = 3" onclick="window.__ran = 4">link</a><iframe srcdoc="<script>parent.__ran = 5</script>"></iframe>'
    + '<div srcdoc="&lt;b&gt;" onmouseover="window.__ran = 6">Something is wrong.</div>';

async function open(page, { integrations = { git: true, review: true }, state = {} } = {}) {
    await openApp(page, {
        currentPage: '/git-controller', ai: AI,
        git: { changes: ['M  a.txt', '?? b.txt', ' D c.txt'] }, files: { 'a.txt': 'one', 'b.txt': 'two' },
        appData: { 'app-ai-integrations': integrations },
        ...state,
    }, '/git-controller');
    await page.locator('app-git-manager .files button.file').first().waitFor();
}
const manager = page => page.locator('app-git-manager');
const tabs = page => manager(page).locator('webui-button[slot="tabs"]');
const review = page => manager(page).locator('app-ai-review');
const openReview = async page => {
    await expect(tabs(page)).toHaveText(['Commit', 'Review', 'Branches', 'Auth', 'Queue']);
    await tabs(page).filter({ hasText: 'Review' }).click();
    await expect(review(page)).toBeVisible();
};

test('Write with AI puts a commit message for the included files in the message box', async ({ page }) => {
    await open(page, { state: { aiReplies: { git: 'Feature: Thing\nBug: Other thing' } } });
    // c.txt is left out of this commit.
    await manager(page).locator('.file-row', { hasText: 'c.txt' }).locator('select.include').selectOption('0');
    await manager(page).locator('#ai-commit webui-button.ai-run').click();
    await expect(manager(page).locator('webui-input-message[label="Commit Message"] textarea')).toHaveValue('Feature: Thing\nBug: Other thing');
    const sent = (await calls(page, 'ai_write')).at(-1).request;
    expect([sent.integration, sent.repo, sent.files, sent.model]).toEqual(['git', '', ['a.txt', 'b.txt'], { provider: 'p', model: 'm' }]);
    // The draft is kept as the repo's message, as typing it would be.
    await expect.poll(() => page.evaluate(() => webui.projectData.data._gitCommitMessages?.[''])).toBe('Feature: Thing\nBug: Other thing');
    // Once the button is ready again, it has said nothing went wrong.
    await expect(manager(page).locator('#ai-commit webui-button.ai-run')).not.toHaveAttribute('disabled', /.*/);
    await expect(manager(page).locator('#ai-commit webui-alert.ai-problem[show]')).toHaveCount(0);
});

test('with AI off for Git and reviews, there is no Write with AI and no Review tab', async ({ page }) => {
    await open(page, { integrations: {} });
    await expect(manager(page).locator('#ai-commit')).toBeHidden();
    await expect(tabs(page)).toHaveText(['Commit', 'Branches', 'Auth', 'Queue']);
    // Turning reviews on adds the tab in its place, with the tab shown staying shown.
    await tabs(page).filter({ hasText: 'Branches' }).click();
    await expect(tabs(page).filter({ hasText: 'Branches' })).toHaveAttribute('aria-current', 'true');
    await page.evaluate(() => webui.setData('app-ai-integrations', { review: true }));
    await expect(tabs(page)).toHaveText(['Commit', 'Review', 'Branches', 'Auth', 'Queue']);
    await expect(tabs(page).filter({ hasText: 'Branches' })).toHaveAttribute('aria-current', 'true');
    await page.evaluate(() => webui.setData('app-ai-integrations', { review: false }));
    await expect(tabs(page)).toHaveText(['Commit', 'Branches', 'Auth', 'Queue']);
});

test('a review of the changes sends the included files and what to look for, and shows the report safely', async ({ page }) => {
    await open(page, { state: { aiReplies: { review: REPORT } } });
    await openReview(page);
    await review(page).locator('textarea.review-focus').fill('error handling');
    await review(page).locator('webui-button.ai-run').click();
    await expect(review(page).locator('.review-report h2')).toHaveText('Findings');
    await expect(review(page).locator('.review-report')).toContainText('Something is wrong.');
    // None of what could run reached the page: no scripts or frames, no handlers, no javascript: or srcdoc values.
    const report = review(page).locator('.review-report');
    await expect(report.locator('a', { hasText: 'link' })).toHaveCount(1);
    await expect(report.locator('script, iframe')).toHaveCount(0);
    await expect.poll(() => report.evaluate(node => [...node.querySelectorAll('*')]
        .flatMap(node => [...node.attributes])
        .filter(attr => /^on/i.test(attr.name) || attr.name.toLowerCase() === 'srcdoc' || /^\s*javascript:/i.test(attr.value))
        .map(attr => `${attr.name}=${attr.value}`))).toEqual([]);
    const sent = (await calls(page, 'ai_review')).at(-1).request;
    expect([sent.scope, sent.files, sent.focus]).toEqual(['changes', ['a.txt', 'b.txt', 'c.txt'], 'error handling']);
});

test('a review of the entire project sends no file list, and a long one shows its progress', async ({ page }) => {
    await open(page, { state: { aiReviewBatches: 3, aiReplies: { review: '## Whole project\n\nLooks fine.' } } });
    await openReview(page);
    await review(page).locator('input[value="project"]').check();
    await page.evaluate(() => {
        // Part way through: the second of three batches is being reviewed, and the review is held there.
        const original = window.__backend.handlers.ai_review;
        window.__backend.handlers.ai_review = args => new Promise(resolve => {
            window.__backend.emit('ai-progress', { requestId: args.request.requestId, done: 1, total: 3 });
            window.__release = () => resolve(original(args));
        });
    });
    await review(page).locator('webui-button.ai-run').click();
    await expect(review(page).locator('.ai-status')).toHaveText('Working on 2 of 3');
    const sent = (await calls(page, 'ai_review'))[0].request;
    expect([sent.scope, sent.files]).toEqual(['project', []]);
    await page.evaluate(() => window.__release());
    await expect(review(page).locator('.review-report')).toContainText('Looks fine.');
});

test('Copy copies the report\'s markdown, and Save as Page saves it under Reviews', async ({ page }) => {
    await open(page, { state: { aiReplies: { review: '## Findings\n\nAll good.' } } });
    await openReview(page);
    await review(page).locator('webui-button.ai-run').click();
    await expect(review(page).locator('.review-report')).toContainText('All good.');
    await review(page).locator('webui-button.review-copy').click();
    await expect.poll(() => calls(page, 'copy_text').then(list => list.at(-1)?.text)).toBe('## Findings\n\nAll good.');
    await expect(review(page).locator('webui-alert.review-done[show]')).toHaveText('Copied the review.');
    await review(page).locator('webui-button.review-save').click();
    await expect(review(page).locator('webui-alert.review-done[show]')).toHaveText(/Saved the review as Change Review .*, under Reviews\./);
    const navigation = await page.evaluate(() => webui.projectData.navigation);
    const folder = navigation.find(item => item.name === 'Reviews');
    expect(folder.children).toHaveLength(1);
    const file = `.taskproxy/pages/${folder.children[0].url.slice(1)}.md`;
    const saved = (await calls(page, 'save_project_file')).find(call => call.filePath === file);
    expect(saved.contents).toContain('data-page-title="Change Review');
    expect(saved.contents).toContain('## Findings\n\nAll good.');
});

test('a review that fails says why', async ({ page }) => {
    await open(page, { state: { aiErrors: { review: 'Local failed (exit code 1): not signed in' } } });
    await openReview(page);
    await review(page).locator('webui-button.ai-run').click();
    await expect(review(page).locator('app-ai-action webui-alert.ai-problem[show]')).toHaveText('Local failed (exit code 1): not signed in');
    await expect(review(page).locator('.review-report')).toHaveText('');
});

test('a saved review can\'t end its page\'s segment, add page data, or carry a script to run', async ({ page }) => {
    const reply = '## Findings\n\n</webui-page-segment><webui-data data-x="1"></webui-data>\n\n```pwsh\nRemove-Item $Target\n```\n\n~~~ PowerShell\nGet-Item\n~~~';
    await open(page, { state: { aiReplies: { review: reply } } });
    await openReview(page);
    await review(page).locator('webui-button.ai-run').click();
    await expect(review(page).locator('.review-report')).toContainText('Findings');
    await review(page).locator('webui-button.review-save').click();
    await expect(review(page).locator('webui-alert.review-done[show]')).toHaveText(/Saved the review/);
    const saved = (await calls(page, 'save_project_file')).find(call => call.filePath.startsWith('.taskproxy/pages/'));
    expect(saved.contents.match(/<\/webui-page-segment>/g)).toHaveLength(1);
    expect(saved.contents.match(/<webui-data/g)).toHaveLength(1);
    expect(saved.contents).toContain('<\u200b/webui-page-segment><\u200bwebui-data data-x="1"><\u200b/webui-data>');
    expect(saved.contents).toContain('```text\nRemove-Item $Target');
    expect(saved.contents).toContain('~~~ text\nGet-Item');
    expect(saved.contents).not.toMatch(/(```|~~~)\s*(pwsh|powershell|ps1)/i);
});

test('a review whose navigation could not be saved says so, and not that it was saved', async ({ page }) => {
    await open(page, { state: { aiReplies: { review: '## Findings\n\nAll good.' } } });
    await openReview(page);
    await review(page).locator('webui-button.ai-run').click();
    await expect(review(page).locator('.review-report')).toContainText('All good.');
    const navigation = await page.evaluate(() => JSON.stringify(webui.projectData.navigation));
    await page.evaluate(() => { window.__backend.handlers.save_project_data = () => { throw 'The disk is full.'; }; });
    await review(page).locator('webui-button.review-save').click();
    await expect(review(page).locator('webui-alert.review-done[show]')).toHaveText(/^The review couldn't be added to the navigation: The disk is full\. The page itself was saved as \.taskproxy\/pages\/.*\.md\.$/);
    // The navigation is as it was, so a later save doesn't write the entry.
    await expect.poll(() => page.evaluate(() => JSON.stringify(webui.projectData.navigation))).toBe(navigation);
    await expect.poll(() => page.evaluate(() => JSON.stringify(webui.getData('app-nav-routes')))).toBe(navigation);
});

test('a review that finishes after switching projects is kept with the project it reviewed', async ({ page }) => {
    await open(page, { state: { aiReplies: { review: '## Findings\n\nFrom the first project.' } } });
    await openReview(page);
    await page.evaluate(() => {
        const original = window.__backend.handlers.ai_review;
        window.__backend.handlers.ai_review = args => new Promise(resolve => { window.__release = () => resolve(original(args)); });
    });
    await review(page).locator('webui-button.ai-run').click();
    await expect.poll(() => page.evaluate(() => typeof window.__release)).toBe('function');
    await switchProject(page, { name: 'Other', path: '/other' });
    await page.evaluate(() => window.__release());
    // Held until its project is open, never put in the one that is.
    await expect.poll(() => page.evaluate(() => webui.getData('app-ai-pending-reviews')?.['/repo|']?.markdown)).toBe('## Findings\n\nFrom the first project.');
    await switchProject(page, { name: 'Repo', path: '/repo' });
    await goToPage(page, '/git-controller');
    await page.locator('app-git-manager .files button.file').first().waitFor();
    await openReview(page);
    await expect(review(page).locator('.review-report')).toContainText('From the first project.');
    await expect.poll(() => page.evaluate(() => webui.projectData.data._aiReviews?.['']?.markdown)).toBe('## Findings\n\nFrom the first project.');
    expect(await page.evaluate(() => window.__backend.savedProjects['/other'].data._aiReviews ?? null)).toBeNull();
});

test('a review still running after switching projects and back shows it is working, then its report', async ({ page }) => {
    await open(page, { state: { aiReviewBatches: 3, aiReplies: { review: '## Findings\n\nStill the first project.' } } });
    await openReview(page);
    await page.evaluate(() => {
        const original = window.__backend.handlers.ai_review;
        window.__backend.handlers.ai_review = args => new Promise(resolve => {
            window.__backend.emit('ai-progress', { requestId: args.request.requestId, done: 1, total: 3 });
            window.__release = () => resolve(original(args));
        });
    });
    await review(page).locator('webui-button.ai-run').click();
    await expect(review(page).locator('.ai-status')).toHaveText('Working on 2 of 3');
    await switchProject(page, { name: 'Other', path: '/other' });
    await switchProject(page, { name: 'Repo', path: '/repo' });
    await goToPage(page, '/git-controller');
    await page.locator('app-git-manager .files button.file').first().waitFor();
    await openReview(page);
    await expect(review(page).locator('webui-button.ai-run')).toHaveAttribute('label', 'Reviewing');
    await expect(review(page).locator('webui-button.ai-cancel')).toBeVisible();
    await expect(review(page).locator('.ai-status')).toHaveText('Working on 2 of 3');
    await page.evaluate(() => window.__release());
    await expect(review(page).locator('.review-report')).toContainText('Still the first project.');
    await expect(review(page).locator('webui-button.ai-run')).toHaveAttribute('label', 'Review');
    await expect(review(page).locator('webui-button.ai-cancel')).toBeHidden();
});

test('a review left running on another page can be cancelled when it is shown again', async ({ page }) => {
    await open(page);
    await openReview(page);
    await page.evaluate(() => {
        window.__backend.handlers.ai_review = () => new Promise(() => { });
    });
    await review(page).locator('webui-button.ai-run').click();
    await expect(review(page).locator('webui-button.ai-cancel')).toBeVisible();
    await goToPage(page, '/');
    await goToPage(page, '/git-controller');
    await page.locator('app-git-manager .files button.file').first().waitFor();
    await openReview(page);
    await review(page).locator('webui-button.ai-cancel').click();
    await expect(review(page).locator('webui-button.ai-run')).toHaveAttribute('label', 'Review');
    await expect.poll(() => calls(page, 'ai_cancel').then(list => list.length)).toBe(1);
});

test('a report is kept with the project until Clear, and a new review replaces it', async ({ page }) => {
    await open(page, { state: { aiReplies: { review: '## Findings\n\nFirst.' } } });
    await openReview(page);
    await review(page).locator('webui-button.ai-run').click();
    await expect(review(page).locator('.review-report')).toContainText('First.');
    await expect.poll(() => page.evaluate(() => webui.projectData.data._aiReviews?.['']?.markdown)).toBe('## Findings\n\nFirst.');
    // Leaving the page and coming back shows it again.
    await goToPage(page, '/');
    await goToPage(page, '/git-controller');
    await page.locator('app-git-manager .files button.file').first().waitFor();
    await openReview(page);
    await expect(review(page).locator('.review-report')).toContainText('First.');
    await page.evaluate(() => { window.__backend.handlers.ai_review = () => '## Findings\n\nSecond.'; });
    await review(page).locator('webui-button.ai-run').click();
    await expect(review(page).locator('.review-report')).toContainText('Second.');
    await expect(review(page).locator('.review-report')).not.toContainText('First.');
    await review(page).locator('webui-button.review-clear').click();
    await expect(review(page).locator('.review-report')).toHaveText('');
    await expect(review(page).locator('webui-button.review-copy')).toBeHidden();
    await expect.poll(() => page.evaluate(() => webui.projectData.data._aiReviews?.[''])).toBeUndefined();
});

test('a report saved with the project is shown when the project is opened', async ({ page }) => {
    await open(page, { state: { data: { _aiReviews: { '': { markdown: '## Findings\n\nFrom before.', scope: 'changes', focus: '', at: '2026-11-20T10:00:00.000Z' } } } } });
    await openReview(page);
    await expect(review(page).locator('.review-report')).toContainText('From before.');
    await expect(review(page).locator('.review-heading')).toContainText('Review of the changes');
});

test('a commit message written after switching projects is in its repo\'s box on coming back', async ({ page }) => {
    await open(page, { state: { aiReplies: { git: 'Feature: Written while away' } } });
    await page.evaluate(() => {
        const original = window.__backend.handlers.ai_write;
        window.__backend.handlers.ai_write = args => new Promise(resolve => { window.__release = () => resolve(original(args)); });
    });
    await manager(page).locator('#ai-commit webui-button.ai-run').click();
    await expect.poll(() => page.evaluate(() => typeof window.__release)).toBe('function');
    await switchProject(page, { name: 'Other', path: '/other' });
    await page.evaluate(() => window.__release());
    await switchProject(page, { name: 'Repo', path: '/repo' });
    await goToPage(page, '/git-controller');
    await page.locator('app-git-manager .files button.file').first().waitFor();
    await expect(manager(page).locator('webui-input-message[label="Commit Message"] textarea')).toHaveValue('Feature: Written while away');
    await expect.poll(() => page.evaluate(() => webui.projectData.data._gitCommitMessages?.[''])).toBe('Feature: Written while away');
    expect(await page.evaluate(() => window.__backend.savedProjects['/other'].data._gitCommitMessages ?? null)).toBeNull();
});

test('a commit message typed while AI writes is kept, and the draft is not used', async ({ page }) => {
    await open(page, { state: { aiReplies: { git: 'Feature: From AI' } } });
    await page.evaluate(() => {
        const original = window.__backend.handlers.ai_write;
        window.__backend.handlers.ai_write = args => new Promise(resolve => { window.__release = () => resolve(original(args)); });
    });
    await manager(page).locator('#ai-commit webui-button.ai-run').click();
    await expect.poll(() => page.evaluate(() => typeof window.__release)).toBe('function');
    const box = manager(page).locator('webui-input-message[label="Commit Message"] textarea');
    await box.fill('Bug: Typed by hand');
    await page.evaluate(() => window.__release());
    await expect(manager(page).locator('#ai-commit webui-alert.ai-problem[show]')).toHaveText(/changed while AI was writing/);
    await expect(box).toHaveValue('Bug: Typed by hand');
    await expect.poll(() => page.evaluate(() => webui.projectData.data._gitCommitMessages?.[''])).toBe('Bug: Typed by hand');
});

test('a saved review keeps tags from being tags the same way in text, code blocks, and inline code, so each shows as typed', async ({ page }) => {
    const reply = '## Findings\n\nUse `<webui-code>` here, not </webui-page-segment>.\n\n~~~~\n```\n~~~\n<webui-data data-x="1">\n~~~~~';
    await open(page, { state: { aiReplies: { review: reply } } });
    await openReview(page);
    await review(page).locator('webui-button.ai-run').click();
    await expect(review(page).locator('.review-report')).toContainText('Findings');
    await review(page).locator('webui-button.review-save').click();
    await expect(review(page).locator('webui-alert.review-done[show]')).toHaveText(/Saved the review/);
    const saved = (await calls(page, 'save_project_file')).find(call => call.filePath.startsWith('.taskproxy/pages/'));
    // An entity in inline code or a code block would show as &lt; on the page, so none is used.
    expect(saved.contents).not.toContain('&lt;');
    expect(saved.contents).toContain('Use `<\u200bwebui-code>` here, not <\u200b/webui-page-segment>.');
    expect(saved.contents).toContain('\n<\u200bwebui-data data-x="1">\n');
    expect(saved.contents.match(/<\/webui-page-segment>/g)).toHaveLength(1);
});

test('Save as Page clicked again while it saves writes one page', async ({ page }) => {
    await open(page, { state: { aiReplies: { review: '## Findings\n\nAll good.' } } });
    await openReview(page);
    await review(page).locator('webui-button.ai-run').click();
    await expect(review(page).locator('.review-report')).toContainText('All good.');
    await page.evaluate(() => {
        const original = window.__backend.handlers.save_project_file;
        window.__backend.handlers.save_project_file = args => new Promise(resolve => { window.__release = () => resolve(original(args)); });
    });
    await review(page).locator('webui-button.review-save').click();
    await expect.poll(() => page.evaluate(() => typeof window.__release)).toBe('function');
    await page.evaluate(() => { window.__firstRelease = window.__release; });
    await review(page).locator('webui-button.review-save').click();
    await page.evaluate(() => window.__firstRelease());
    await expect(review(page).locator('webui-alert.review-done[show]')).toHaveText(/Saved the review as Change Review/);
    const pages = (await calls(page, 'save_project_file')).filter(call => call.filePath.startsWith('.taskproxy/pages/'));
    expect(pages).toHaveLength(1);
    expect(await page.evaluate(() => webui.projectData.navigation.find(item => item.name === 'Reviews').children.length)).toBe(1);
});

test('a saved review turns code elements into text, so they get no Run button', async ({ page }) => {
    await open(page, { state: { aiReplies: { review: '## Findings\n\n<webui-code language="pwsh">Remove-Item x</webui-code>\n\n<WEBUI-CODE lang="ps1">y</webui-code>' } } });
    await openReview(page);
    await review(page).locator('webui-button.ai-run').click();
    await expect(review(page).locator('.review-report')).toContainText('Findings');
    await review(page).locator('webui-button.review-save').click();
    await expect(review(page).locator('webui-alert.review-done[show]')).toHaveText(/Saved the review/);
    const saved = (await calls(page, 'save_project_file')).find(call => call.filePath.startsWith('.taskproxy/pages/'));
    expect(saved.contents).not.toMatch(/<webui-code/i);
    expect(saved.contents).toContain('<\u200bwebui-code language="pwsh">Remove-Item x<\u200b/webui-code>');
});

test.describe('a command provider, such as Claude Code', () => {
    const COMMAND = { providers: [{ id: 'c', name: 'Claude Code', kind: 'command', command: 'claude -p --model {model}', models: [{ id: 'sonnet', name: 'Sonnet' }], hidden: [] }] };

    test('asks to trust the project first, and Cancel sends nothing', async ({ page }) => {
        await open(page, { state: { ai: COMMAND } });
        await manager(page).locator('#ai-commit webui-button.ai-run').click();
        await expect(openDialog(page)).toContainText('Let Claude Code Work in This Project?');
        // Busy while it asks, so the button being ready again below means the request has ended.
        await expect(manager(page).locator('#ai-commit webui-button.ai-run')).toHaveAttribute('label', 'Writing the message');
        await dialogButton(page, 'Cancel').click();
        await expect(openDialog(page)).toHaveCount(0);
        await expect(manager(page).locator('#ai-commit webui-button.ai-run')).toHaveAttribute('label', 'Write with AI');
        await expect(manager(page).locator('#ai-commit webui-alert.ai-problem[show]')).toHaveCount(0);
        await expect.poll(() => calls(page, 'ai_write')).toEqual([]);
    });

    test('providers that can\'t be read to check say so, and send nothing', async ({ page }) => {
        await open(page, { state: { ai: COMMAND } });
        await expect(manager(page).locator('#ai-commit select.ai-model-select')).toHaveValue(/.+/);
        await page.evaluate(() => { window.__backend.handlers.ai_settings = () => { throw 'The settings file is locked.'; }; });
        await manager(page).locator('#ai-commit webui-button.ai-run').click();
        await expect(manager(page).locator('#ai-commit webui-alert.ai-problem[show]')).toHaveText('Your AI providers couldn\'t be read, so nothing was sent: The settings file is locked.');
        await expect(openDialog(page)).toHaveCount(0);
        expect(await calls(page, 'ai_write')).toEqual([]);
    });

    test('once trusted, it writes, and doesn\'t ask again', async ({ page }) => {
        await open(page, { state: { ai: COMMAND, aiReplies: { git: 'Feature: Trusted' } } });
        await manager(page).locator('#ai-commit webui-button.ai-run').click();
        await dialogButton(page, 'Trust Project & Continue').click();
        const box = manager(page).locator('webui-input-message[label="Commit Message"] textarea');
        await expect(box).toHaveValue('Feature: Trusted');
        await expect.poll(() => page.evaluate(() => webui.taskProxyData.data['app-trusted-projects'])).toEqual(['/repo']);
        await box.fill('');
        await manager(page).locator('#ai-commit webui-button.ai-run').click();
        await expect.poll(() => calls(page, 'ai_write').then(list => list.length)).toBe(2);
        await expect(openDialog(page)).toHaveCount(0);
    });
});
