import { test, expect, openPage, openApp, calls, onCommand, dialogButton } from '../support/app.mjs';

const save = page => page.locator('app-page-handler webui-button[title="Save Page"]').first().click();
const saved = async page => {
    await expect.poll(async () => (await calls(page, 'save_project_file')).length).toBeGreaterThan(0);
    return (await calls(page, 'save_project_file')).at(-1);
};
/** Run the page's script, accepting the trust prompt. Returns what would be run. */
async function runScript(page, index = 0) {
    await page.locator('webui-icon.run-script-btn').nth(index).click();
    await page.getByText('Trust Project & Run').click();
    await expect.poll(async () => (await calls(page, 'start_script')).length).toBeGreaterThan(0);
    return (await calls(page, 'start_script')).at(-1).scriptContent;
}
const scriptPage = script => `# Title\n\nRun this\n\n\`\`\`powershell\n${script}\n\`\`\``;

test.describe('saving', () => {
    test('saving keeps all content', async ({ page }) => {
        const markdown = '<webui-data data-page-title="T" data-page-subtitle=""></webui-data>\n\n# Heading\n\nUse List<string> here.\nSecond line.\n\n<webui-page-segment>\n\nInner\n\n</webui-page-segment>\n\n```bash\necho hi\n```';
        await openPage(page, markdown);
        await save(page);
        expect((await saved(page)).contents).toBe(markdown);
    });
    test('saves to the file for this page', async ({ page }) => {
        await openPage(page, '# Heading', { pageId: 'my-page' });
        await save(page);
        expect((await saved(page)).filePath).toBe('.taskproxy/pages/my-page.md');
    });
    test('a page that does not exist yet starts empty, and can be saved', async ({ page }) => {
        await openApp(page, { currentPage: '/new-page' }, '/new-page');
        await page.locator('app-page-handler webui-button[title="Add Segment"]').first().waitFor();
        await save(page);
        expect((await saved(page)).filePath).toBe('.taskproxy/pages/new-page.md');
    });
    test('a new page does not take the previous page\'s title', async ({ page }) => {
        await openApp(page, { currentPage: '/new-page', appData: { 'page-title': 'Some Other Page' } }, '/new-page');
        await page.locator('app-page-handler webui-button[title="Add Segment"]').first().waitFor();
        await save(page);
        expect((await saved(page)).contents).not.toContain('Some Other Page');
    });
    test('a page that fails to load cannot be saved over', async ({ page }) => {
        await openApp(page, { currentPage: '/x', project: { name: 'Repo', path: '/repo' } });
        await onCommand(page, 'get_project_file', () => { throw 'Failed to load file: stream did not contain valid UTF-8'; });
        await page.evaluate(() => webui.navigateTo('/broken'));
        await page.locator('app-page-handler').waitFor();
        await page.waitForTimeout(300);
        const button = page.locator('app-page-handler webui-button[title="Save Page"]').first();
        if (await button.count()) await button.click();
        await page.waitForTimeout(100);
        expect(await calls(page, 'save_project_file')).toEqual([]);
    });
    test('a slow page cannot replace the page opened after it', async ({ page }) => {
        await openPage(page, '# First', { pageId: 'first', files: { '.taskproxy/pages/slow.md': '# Slow Page', '.taskproxy/pages/fast.md': '# Fast Page' } });
        await page.evaluate(() => {
            const original = window.__backend.handlers.get_project_file;
            window.__backend.handlers.get_project_file = async args => {
                if (args.filePath.includes('slow')) await new Promise(resolve => setTimeout(resolve, 500));
                return original(args);
            };
            webui.navigateTo('/slow');
        });
        await page.waitForTimeout(100);
        await page.evaluate(() => webui.navigateTo('/fast'));
        await page.waitForTimeout(900);
        await save(page);
        const result = await saved(page);
        expect(result.filePath).toBe('.taskproxy/pages/fast.md');
        expect(result.contents).toContain('# Fast Page');
        expect(result.contents).not.toContain('Slow Page');
    });
    test('pages can be saved after moving between them', async ({ page }) => {
        await openPage(page, '# First', { pageId: 'first', files: { '.taskproxy/pages/second.md': '# Second' } });
        await page.evaluate(() => webui.navigateTo('/second'));
        await page.getByRole('heading', { name: 'Second' }).waitFor();
        await save(page);
        expect((await saved(page)).filePath).toBe('.taskproxy/pages/second.md');
    });
    test('the page title can be edited, and saves', async ({ page }) => {
        await openPage(page, '<webui-data data-page-title="Old" data-page-subtitle=""></webui-data>\n\n# Heading');
        await page.locator('header h1').click();
        await page.locator('webui-input-text[name="pageTitle"] input').fill('New "Title"');
        await dialogButton(page, 'Save').click();
        const { contents } = await saved(page);
        expect(contents).toContain('data-page-title="New &quot;Title&quot;"');
        expect(contents).toContain('# Heading');
    });
    test('the title editor shows the current title as written', async ({ page }) => {
        await openPage(page, '<webui-data data-page-title="A &amp; B" data-page-subtitle="Sub"></webui-data>\n\n# Heading');
        await page.locator('header h1').click();
        await expect(page.locator('webui-input-text[name="pageTitle"] input')).toHaveValue('A & B');
        await expect(page.locator('webui-input-text[name="pageSubtitle"] input')).toHaveValue('Sub');
    });
    test('segments can be added', async ({ page }) => {
        await openPage(page, '# Heading');
        await page.locator('app-page-handler webui-button[title="Add Segment"]').first().click();
        await expect(page.locator('app-page-handler > app-markdown-segment')).toHaveCount(2);
    });
});

test.describe('security', () => {
    test('scripts in a page do not run', async ({ page }) => {
        await openPage(page, `# T\n\n<img src=x onerror="window.__xss='img'">\n\n<template><img src=x onerror="window.__xss='tpl'"></template>\n\n<script>window.__xss='script'</script>\n\n<a id="bad" href="java&#x09;script:window.__xss='href'">x</a>`);
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => window.__xss)).toBeUndefined();
        await expect(page.locator('a#bad')).not.toHaveAttribute('href');
    });
    test('{GIT_PAT} does not show the token', async ({ page }) => {
        await openPage(page, 'Token: [{GIT_PAT}] [{GITHUB_PAT}]', { data: { git_pat: 'SECRETTOKEN' }, appData: { github_pat: 'OTHERTOKEN' }, appVariables: ['github_pat|secret|'] });
        await page.waitForTimeout(200);
        const text = await page.locator('app-page-handler').evaluate(el => el.innerHTML);
        expect(text).not.toContain('SECRETTOKEN');
        expect(text).not.toContain('OTHERTOKEN');
    });
    test('{VARIABLE} shows a variable\'s value', async ({ page }) => {
        await openPage(page, 'Value: {MY_VAR}', { data: { my_var: 'shown' }, variables: ['my_var|text|'] });
        await expect(page.locator('app-page-handler').getByText('Value: shown')).toBeVisible();
    });
});

test.describe('page scripts', () => {
    test('only PowerShell blocks get a run button', async ({ page }) => {
        await openPage(page, '```bash\necho a\n```\n\n```pwsh\nWrite-Host a\n```\n\n```ps1\nWrite-Host b\n```');
        await expect(page.locator('webui-icon.run-script-btn')).toHaveCount(2);
    });
    test('nothing runs until the project is trusted', async ({ page }) => {
        await openPage(page, scriptPage('Write-Host a'));
        await page.locator('webui-icon.run-script-btn').click();
        await expect(page.getByText('Run Script From This Project?')).toBeVisible();
        expect(await calls(page, 'start_script')).toEqual([]);
        await dialogButton(page, 'Cancel').click();
        await page.waitForTimeout(100);
        expect(await calls(page, 'start_script')).toEqual([]);
    });
    test('a trusted project does not ask again', async ({ page }) => {
        await openPage(page, scriptPage('Write-Host a'), { appData: { 'app-trusted-projects': ['/repo'] } });
        await page.locator('webui-icon.run-script-btn').click();
        await expect.poll(async () => (await calls(page, 'start_script')).length).toBe(1);
    });
    test('the trust prompt masks injected values', async ({ page }) => {
        await openPage(page, scriptPage("$secret = 'x'"), { data: { secret: 'abcdefghijkl' }, variables: ['secret|text|'] });
        await page.locator('webui-icon.run-script-btn').click();
        await expect(page.getByText('abc***jkl').first()).toBeVisible();
        expect(await page.evaluate(() => document.body.innerText)).not.toContain('abcdefghijkl');
    });
    test('variables are injected into the script that runs', async ({ page }) => {
        await openPage(page, scriptPage("$my_var = 'default'\n$other = 'kept'"), { data: { my_var: 'abcdefghijkl' }, variables: ['my_var|text|'] });
        const script = await runScript(page);
        expect(script).toContain("$my_var = 'abcdefghijkl'");
        expect(script).toContain("$other = 'kept'");
    });
    test('the Terminal Manager gets the masked script', async ({ page }) => {
        await openPage(page, scriptPage("$my_var = 'default'"), { data: { my_var: 'abcdefghijkl' }, variables: ['my_var|text|'] });
        await runScript(page);
        const terminals = await page.evaluate(() => Object.values(webui.proxy.terminalHelpers.getState().terminals).filter(term => term.isPageScript));
        expect(terminals).toHaveLength(1);
        expect(terminals[0].script).toContain("$my_var = 'abc***jkl'");
        expect(terminals[0].script).not.toContain('abcdefghijkl');
    });
    test('the code preview masks values longer than 6 characters', async ({ page }) => {
        await openPage(page, scriptPage("$my_var = 'default'"), { data: { my_var: 'abcdefghijkl' }, variables: ['my_var|text|'] });
        await expect(page.locator('webui-code').filter({ hasText: 'abc***jkl' })).toBeVisible();
        expect(await page.locator('app-page-handler').evaluate(el => el.innerText)).not.toContain('abcdefghijkl');
    });
    test('tokens are not injected', async ({ page }) => {
        await openPage(page, scriptPage("$git_pat = 'placeholder'"), { data: { git_pat: 'SECRETTOKEN' } });
        expect(await runScript(page)).toContain("$git_pat = 'placeholder'");
    });
    // A script's own variables must not pick up framework settings or project fields that share a name.
    for (const name of ['name', 'version', 'path', 'id', 'data', 'docs', 'navigation', 'variables', 'domain', 'api']) {
        test(`$${name} keeps its value unless a variable is set`, async ({ page }) => {
            await openPage(page, scriptPage(`$${name} = 'mine'`));
            expect(await runScript(page)).toContain(`$${name} = 'mine'`);
        });
    }
    test('a variable with one of those names still applies when set', async ({ page }) => {
        await openPage(page, scriptPage("$path = 'mine'"), { data: { path: 'from-variable' }, variables: ['path|text|'] });
        expect(await runScript(page)).toContain("$path = 'from-variable'");
    });
    test('values cannot break out of single quoted strings', async ({ page }) => {
        await openPage(page, scriptPage("$v = 'x'"), { data: { v: "a'b’c; Remove-Item" }, variables: ['v|text|'] });
        expect(await runScript(page)).toContain("$v = 'a''b’’c; Remove-Item'");
    });
    test('values are literal inside double quoted strings', async ({ page }) => {
        await openPage(page, scriptPage('$v = "x"'), { data: { v: 'pa$$word `n $(Get-Date) "q”' }, variables: ['v|text|'] });
        expect(await runScript(page)).toContain('$v = "pa`$`$word ``n `$(Get-Date) `"q`”"');
    });
    test('strings with escaped quotes are fully replaced', async ({ page }) => {
        await openPage(page, scriptPage("$a = 'it''s old'\n$b = \"say `\"old`\" now\""), { data: { a: 'new', b: 'new' }, variables: ['a|text|', 'b|text|'] });
        const script = await runScript(page);
        expect(script).toContain("$a = 'new'\n");
        expect(script).toContain('$b = "new"');
    });
    test('numbers and booleans replace unquoted values', async ({ page }) => {
        await openPage(page, scriptPage('$count = 1\n$flag = $false\n$text = 5'), { data: { count: '42', flag: 'true', text: 'not a number' }, variables: ['count|text|', 'flag|text|', 'text|text|'] });
        const script = await runScript(page);
        expect(script).toContain('$count = 42');
        expect(script).toContain('$flag = $true');
        expect(script).toContain('$text = 5');
    });
    test('a project script runs with its own terminal name', async ({ page }) => {
        await openPage(page, '<webui-data data-page-title="My Page" data-page-subtitle=""></webui-data>\n\nDeploy it\n\n```pwsh\nWrite-Host a\n```');
        await runScript(page);
        expect((await calls(page, 'start_script')).at(-1).terminalId).toBe('Repo_My Page_Deploy it');
    });
    test('each button runs its own block', async ({ page }) => {
        await openPage(page, '```pwsh\nWrite-Host first\n```\n\n```bash\necho skip\n```\n\n```pwsh\nWrite-Host second\n```', { appData: { 'app-trusted-projects': ['/repo'] } });
        await page.locator('webui-icon.run-script-btn').nth(1).click();
        await expect.poll(async () => (await calls(page, 'start_script')).length).toBe(1);
        expect((await calls(page, 'start_script'))[0].scriptContent).toContain('second');
    });
    test('variables set by page data apply', async ({ page }) => {
        await openPage(page, '<webui-data data-page-title="T" data-page-subtitle="" data-target="prod"></webui-data>\n\n' + scriptPage("$target = 'dev'"));
        expect(await runScript(page)).toContain("$target = 'prod'");
    });
});
