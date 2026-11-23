import { test, expect, openPage, openApp, calls, onCommand, dialogButton, openDialog, goToPage } from '../support/app.mjs';
import { actionNote, alertPopup, spyOnAlerts, alerts } from '../../support/wait.mjs';

const save = page => page.locator('app-page-handler webui-button[title="Save Page"]').first().click();
const saved = async page => {
    await expect.poll(async () => (await calls(page, 'save_project_file')).length).toBeGreaterThan(0);
    return (await calls(page, 'save_project_file')).at(-1);
};
/** Run the page's script, accepting the trust prompt. Returns what would be run. */
async function runScript(page, index = 0) {
    await page.locator('webui-icon.run-script-btn').nth(index).click();
    await page.getByText('Trust Project & Run').click();
    await expect.poll(async () => (await calls(page, 'spawn_script')).length).toBeGreaterThan(0);
    return (await calls(page, 'spawn_script')).at(-1).scriptContent;
}
const scriptPage = script => `# Title\n\nRun this\n\n\`\`\`powershell\n${script}\n\`\`\``;

test.describe('saving', () => {
    test('saving keeps all content, with loose content wrapped in page segments', async ({ page }) => {
        const data = '<webui-data data-page-title="T" data-page-subtitle=""></webui-data>';
        const markdown = `${data}\n\n# Heading\n\nUse List<string> here.\nSecond line.\n\n<webui-page-segment>\n\nInner\n\n</webui-page-segment>\n\n\`\`\`bash\necho hi\n\`\`\``;
        await openPage(page, markdown);
        await save(page);
        expect((await saved(page)).contents).toBe([
            data,
            '# Heading',
            '<webui-page-segment>\n\nUse List<string> here.\nSecond line.\n\n</webui-page-segment>',
            '<webui-page-segment>\n\nInner\n\n</webui-page-segment>',
            '<webui-page-segment>\n\n```bash\necho hi\n```\n\n</webui-page-segment>',
        ].join('\n\n'));
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
        // The page has dealt with the failed load once it says so. Save is refused as it is clicked, before anything is sent.
        await expect(page.locator('app-page-handler webui-alert')).toContainText('This page could not be loaded.');
        const button = page.locator('app-page-handler webui-button[title="Save Page"]').first();
        if (await button.count()) await button.click();
        await expect.poll(() => calls(page, 'save_project_file')).toEqual([]);
    });
    test('a slow page cannot replace the page opened after it', async ({ page }) => {
        await openPage(page, '# First', { pageId: 'first', files: { '.taskproxy/pages/slow.md': '# Slow Page', '.taskproxy/pages/fast.md': '# Fast Page' } });
        // The slow page's file is held back until the test lets it go, after the fast page is showing.
        await page.evaluate(() => {
            const original = window.__backend.handlers.get_project_file;
            const held = new Promise(resolve => { window.__releaseSlow = resolve; });
            window.__backend.handlers.get_project_file = async args => {
                if (args.filePath.includes('slow')) await held;
                return original(args);
            };
            webui.navigateTo('/slow');
        });
        await expect.poll(() => calls(page, 'get_project_file')).toContainEqual({ filePath: '.taskproxy/pages/slow.md' });
        await page.evaluate(() => webui.navigateTo('/fast'));
        await expect(page.getByRole('heading', { name: 'Fast Page' })).toBeVisible();
        // The app deals with the late answer as soon as it is given, before the page answers the test again.
        await page.evaluate(() => window.__releaseSlow());
        await expect(page.getByRole('heading', { name: 'Fast Page' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Slow Page' })).toHaveCount(0);
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
    test('a title that could not be saved says why in the dialog, which stays open, and the title is kept', async ({ page }) => {
        await openPage(page, '<webui-data data-page-title="Old" data-page-subtitle=""></webui-data>\n\n# Heading');
        const title = page.locator('header h1');
        await expect(title).toHaveText('Old');
        await page.evaluate(() => { window.__backend.handlers.save_project_file = () => { throw 'The disk is full.'; }; });
        await title.click();
        await page.locator('webui-input-text[name="pageTitle"] input').fill('New');
        await dialogButton(page, 'Save').click();
        await expect(openDialog(page)).toContainText('The disk is full.');
        await expect(title).toHaveText('Old');
    });
    test('a title saved after its page was left still goes to that page, says so, and the dialog closes', async ({ page }) => {
        await openPage(page, '<webui-data data-page-title="Old" data-page-subtitle=""></webui-data>\n\n# Heading', { pageId: 'first', files: { '.taskproxy/pages/second.md': '# Second' } });
        await page.locator('header h1').click();
        await page.locator('webui-input-text[name="pageTitle"] input').fill('New');
        await page.evaluate(() => {
            const original = window.__backend.handlers.save_project_file;
            const held = new Promise(resolve => { window.__releaseSave = resolve; });
            window.__backend.handlers.save_project_file = async args => { await held; return original(args); };
        });
        await dialogButton(page, 'Save').click();
        await expect.poll(() => calls(page, 'save_project_file')).toHaveLength(1);
        await goToPage(page, '/second');
        await page.evaluate(() => window.__releaseSave());
        await expect(alertPopup(page, 'Saved the title of the page that was shown.')).toHaveCount(1);
        await expect(openDialog(page)).toHaveCount(0);
        const [call] = await calls(page, 'save_project_file');
        expect(call.filePath).toBe('.taskproxy/pages/first.md');
        expect(call.contents).toContain('data-page-title="New"');
    });
    test('a page with no title can be given one from the header', async ({ page }) => {
        await openPage(page, '# Heading');
        const title = page.locator('header h1');
        await expect(title).toBeVisible();
        await title.click();
        await page.locator('webui-input-text[name="pageTitle"] input').fill('Named');
        await dialogButton(page, 'Save').click();
        await expect(title).toHaveText('Named');
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
        await expect(page.locator('app-page-handler > webui-reorder > app-markdown-segment')).toHaveCount(2);
    });
});

test.describe('security', () => {
    test('scripts in a page do not run', async ({ page }) => {
        await openPage(page, `# T\n\n<img src=x onerror="window.__xss='img'">\n\n<template><img src=x onerror="window.__xss='tpl'"></template>\n\n<script>window.__xss='script'</script>\n\n<a id="bad" href="java&#x09;script:window.__xss='href'">x</a>`);
        // The page has been drawn, with the image and link it keeps.
        await expect(page.locator('app-page-handler img').first()).toBeAttached();
        await expect(page.locator('a#bad')).toHaveText('x');
        await expect(page.locator('a#bad')).not.toHaveAttribute('href');
        await expect(page.locator('app-page-handler script')).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => window.__xss)).toBeUndefined();
    });
    test('{GIT_PAT} does not show the token', async ({ page }) => {
        await openPage(page, 'Token: [{GIT_PAT}] [{GITHUB_PAT}]', { data: { git_pat: 'SECRETTOKEN' }, appData: { github_pat: 'OTHERTOKEN' }, appVariables: ['github_pat|secret|'] });
        await expect(page.locator('app-page-handler')).toContainText('Token: [');
        const text = () => page.locator('app-page-handler').evaluate(el => el.innerHTML);
        await expect.poll(text).not.toContain('SECRETTOKEN');
        await expect.poll(text).not.toContain('OTHERTOKEN');
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
        await expect.poll(() => calls(page, 'spawn_script')).toEqual([]);
        await dialogButton(page, 'Cancel').click();
        await expect(openDialog(page)).toHaveCount(0);
        // It asks again the next time, so the cancelled run ended without trusting the project or running anything.
        await page.locator('webui-icon.run-script-btn').click();
        await expect(openDialog(page)).toContainText('Run Script From This Project?');
        await expect.poll(() => calls(page, 'spawn_script')).toEqual([]);
    });
    test('a script whose values can\'t be filled says why under it, and nothing runs', async ({ page }) => {
        await openPage(page, scriptPage('Write-Host a'), { appData: { 'app-trusted-projects': ['/repo'] } });
        await expect(page.locator('webui-icon.run-script-btn')).toHaveCount(1);
        await page.evaluate(() => { window.__backend.handlers.page_script_preview = () => { throw 'The values could not be read.'; }; });
        await page.locator('webui-icon.run-script-btn').click();
        await expect(actionNote(page, 'The values could not be read.')).toHaveCount(1);
        await expect.poll(() => calls(page, 'spawn_script')).toEqual([]);
    });
    test('a trusted project does not ask again', async ({ page }) => {
        await openPage(page, scriptPage('Write-Host a'), { appData: { 'app-trusted-projects': ['/repo'] } });
        await page.locator('webui-icon.run-script-btn').click();
        await expect.poll(async () => (await calls(page, 'spawn_script')).length).toBe(1);
    });
    test('the trust prompt masks injected values', async ({ page }) => {
        await openPage(page, scriptPage("$secret = 'x'"), { data: { secret: 'abcdefghijkl' }, variables: ['secret|text|'] });
        await page.locator('webui-icon.run-script-btn').click();
        await expect(page.getByText('abc***jkl').first()).toBeVisible();
        await expect.poll(() => page.evaluate(() => document.body.innerText)).not.toContain('abcdefghijkl');
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
        const shown = () => page.evaluate(() => Object.values(webui.proxy.terminalHelpers.getState().terminals).filter(term => term.isPageScript).map(term => term.script));
        await expect.poll(async () => (await shown()).length).toBe(1);
        await expect.poll(async () => (await shown())[0]).toContain("$my_var = 'abc***jkl'");
        await expect.poll(async () => (await shown())[0]).not.toContain('abcdefghijkl');
    });
    test('the code preview masks values longer than 6 characters', async ({ page }) => {
        await openPage(page, scriptPage("$my_var = 'default'"), { data: { my_var: 'abcdefghijkl' }, variables: ['my_var|text|'] });
        await expect(page.locator('webui-code').filter({ hasText: 'abc***jkl' })).toBeVisible();
        await expect.poll(() => page.locator('app-page-handler').evaluate(el => el.innerText)).not.toContain('abcdefghijkl');
    });
    test('tokens are not injected', async ({ page }) => {
        await openPage(page, scriptPage("$git_pat = 'placeholder'"), { data: { git_pat: 'SECRETTOKEN' } });
        const script = await runScript(page);
        expect(script).toContain("$git_pat = 'placeholder'");
    });
    // A script's own variables must not pick up framework settings or project fields that share a name.
    for (const name of ['name', 'version', 'path', 'id', 'data', 'docs', 'navigation', 'variables', 'domain', 'api']) {
        test(`$${name} keeps its value unless a variable is set`, async ({ page }) => {
            await openPage(page, scriptPage(`$${name} = 'mine'`));
            const script = await runScript(page);
            expect(script).toContain(`$${name} = 'mine'`);
        });
    }
    test('a variable with one of those names still applies when set', async ({ page }) => {
        await openPage(page, scriptPage("$path = 'mine'"), { data: { path: 'from-variable' }, variables: ['path|text|'] });
        const script = await runScript(page);
        expect(script).toContain("$path = 'from-variable'");
    });
    test('values cannot break out of single quoted strings', async ({ page }) => {
        await openPage(page, scriptPage("$v = 'x'"), { data: { v: "a'b’c; Remove-Item" }, variables: ['v|text|'] });
        const script = await runScript(page);
        expect(script).toContain("$v = 'a''b’’c; Remove-Item'");
    });
    test('values are literal inside double quoted strings', async ({ page }) => {
        await openPage(page, scriptPage('$v = "x"'), { data: { v: 'pa$$word `n $(Get-Date) "q”' }, variables: ['v|text|'] });
        const script = await runScript(page);
        expect(script).toContain('$v = "pa`$`$word ``n `$(Get-Date) `"q`”"');
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
        expect((await calls(page, 'spawn_script')).at(-1).terminalId).toBe('Repo_My Page_Deploy it');
    });
    test('each button runs its own block', async ({ page }) => {
        await openPage(page, '```pwsh\nWrite-Host first\n```\n\n```bash\necho skip\n```\n\n```pwsh\nWrite-Host second\n```', { appData: { 'app-trusted-projects': ['/repo'] } });
        await page.locator('webui-icon.run-script-btn').nth(1).click();
        await expect.poll(async () => (await calls(page, 'spawn_script')).length).toBe(1);
        expect((await calls(page, 'spawn_script'))[0].scriptContent).toContain('second');
    });
    test('a code element written as HTML gets no Run button, and every button still runs the block it is on', async ({ page }) => {
        const markdown = '<webui-code language="pwsh">Write-Host planted</webui-code>\n\n```pwsh\nWrite-Host first\n```\n\n<webui-code lang="ps1">Write-Host also planted</webui-code>\n\n```pwsh\nWrite-Host second\n```';
        await openPage(page, markdown, { appData: { 'app-trusted-projects': ['/repo'] } });
        const codes = page.locator('app-page-handler webui-code');
        await expect(codes).toHaveCount(4);
        await expect(page.locator('webui-icon.run-script-btn')).toHaveCount(2);
        await expect(codes.nth(0).locator('webui-icon.run-script-btn')).toHaveCount(0);
        await expect(codes.nth(1).locator('webui-icon.run-script-btn')).toHaveCount(1);
        await expect(codes.nth(2).locator('webui-icon.run-script-btn')).toHaveCount(0);
        await expect(codes.nth(3).locator('webui-icon.run-script-btn')).toHaveCount(1);
        await codes.nth(1).locator('webui-icon.run-script-btn').click();
        await expect.poll(async () => (await calls(page, 'spawn_script')).map(call => call.scriptContent.trim())).toEqual(['Write-Host first']);
        await codes.nth(3).locator('webui-icon.run-script-btn').click();
        await expect.poll(async () => (await calls(page, 'spawn_script')).map(call => call.scriptContent.trim())).toEqual(['Write-Host first', 'Write-Host second']);
    });
    test('a code element written as HTML cannot take the Run buttons of the blocks before the script it shows', async ({ page }) => {
        const markdown = '<webui-code language="pwsh">Write-Host second</webui-code>\n\n```pwsh\nWrite-Host first\n```\n\n```pwsh\nWrite-Host second\n```';
        await openPage(page, markdown, { appData: { 'app-trusted-projects': ['/repo'] } });
        const codes = page.locator('app-page-handler webui-code');
        await expect(codes).toHaveCount(3);
        await expect(codes.nth(1).locator('webui-icon.run-script-btn')).toHaveCount(1);
        await codes.nth(1).locator('webui-icon.run-script-btn').click();
        await expect.poll(async () => (await calls(page, 'spawn_script')).map(call => call.scriptContent.trim())).toEqual(['Write-Host first']);
    });
    test('an empty script block does not hold back the Run buttons of the others', async ({ page }) => {
        await page.clock.install();
        await openPage(page, 'Empty\n\n```pwsh\n```\n\nReal\n\n```pwsh\nWrite-Host real\n```', { appData: { 'app-trusted-projects': ['/repo'] } });
        // The real block is drawn, with its text.
        await expect.poll(() => page.locator('app-page-handler webui-code').evaluateAll(nodes => {
            const Code = customElements.get('webui-code');
            return nodes.filter(el => Code && el instanceof Code && /Write-Host real/.test(`${el.value ?? ''}${el.textContent}`)).length;
        })).toBe(1);
        // The page's clock stops a moment ahead of where it is, never behind, since the page's time moves on until
        // then. A second is far less than giving up on the empty block would take.
        await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 100);
        await page.clock.runFor(1000);
        await expect(page.locator('webui-icon.run-script-btn')).toHaveCount(1);
        // Running waits a moment before it starts, so time flows again.
        await page.clock.resume();
        await page.locator('webui-icon.run-script-btn').click();
        await expect.poll(async () => (await calls(page, 'spawn_script')).map(call => call.scriptContent.trim())).toEqual(['Write-Host real']);
    });
    test('a block indented under a list item gets a Run button, and runs as written', async ({ page }) => {
        const script = '    $name = \'a & <b>\'\n    if ($name) {\n        Write-Host $name\n    }';
        await openPage(page, `1. Set it up\n\n    \`\`\`pwsh\n${script}\n    \`\`\``, { appData: { 'app-trusted-projects': ['/repo'] } });
        await expect(page.locator('webui-icon.run-script-btn')).toHaveCount(1);
        await page.locator('webui-icon.run-script-btn').click();
        await expect.poll(async () => (await calls(page, 'spawn_script')).length).toBe(1);
        expect((await calls(page, 'spawn_script'))[0].scriptContent).toContain("if ($name) {\n        Write-Host $name");
    });
    test('a script no block shows leaves the other blocks their Run buttons', async ({ page }) => {
        // An example of a page, shown as markdown, holds a fenced script that is never drawn as a script block.
        const markdown = '````md\n```pwsh\nWrite-Host example\n```\n````\n\n```pwsh\nWrite-Host real\n```';
        await openPage(page, markdown, { appData: { 'app-trusted-projects': ['/repo'] } });
        await expect(page.locator('webui-icon.run-script-btn')).toHaveCount(1);
        await page.locator('webui-icon.run-script-btn').click();
        await expect.poll(async () => (await calls(page, 'spawn_script')).map(call => call.scriptContent.trim())).toEqual(['Write-Host real']);
    });
    test('a script with a {VARIABLE} placeholder gets a Run button', async ({ page }) => {
        await openPage(page, scriptPage("Write-Host '{MY_VAR}'"), { data: { my_var: 'shown' }, variables: ['my_var|text|'], appData: { 'app-trusted-projects': ['/repo'] } });
        await expect(page.locator('webui-icon.run-script-btn')).toHaveCount(1);
        await page.locator('webui-icon.run-script-btn').click();
        await expect.poll(async () => (await calls(page, 'run_page_script')).map(call => call.script.trim())).toEqual(["Write-Host '{MY_VAR}'"]);
    });
    test('variables set by page data apply', async ({ page }) => {
        await openPage(page, '<webui-data data-page-title="T" data-page-subtitle="" data-target="prod"></webui-data>\n\n' + scriptPage("$target = 'dev'"));
        const script = await runScript(page);
        expect(script).toContain("$target = 'prod'");
    });
    test('a value typed into a bound input replaces the default in the script', async ({ page }) => {
        // The example in the page help.
        await openPage(page, '<webui-input-text label="Version" data-bind="Version"></webui-input-text>\n\n' + scriptPage("$Version = '1.0.0'"));
        await page.locator('app-page-handler webui-input-text[label="Version"] input').fill('2.1.0');
        const script = await runScript(page);
        expect(script).toContain("$Version = '2.1.0'");
    });
    test('the window sends the script and its page values, never the project\'s or global values', async ({ page }) => {
        await openPage(page, '<webui-input-text label="Version" data-bind="Version"></webui-input-text>\n\n' + scriptPage("$Version = '1.0.0'\n$token = 'x'"),
            { data: { token: 'PROJECT-SECRET-VALUE' }, variables: ['token|secret|'] });
        await page.locator('app-page-handler webui-input-text[label="Version"] input').fill('2.1.0');
        await runScript(page);
        const sent = (await calls(page, 'run_page_script')).at(-1);
        expect(sent.script.trim()).toBe("$Version = '1.0.0'\n$token = 'x'");
        expect(sent.pageValues).toEqual({ Version: '2.1.0' });
        expect(JSON.stringify(sent)).not.toContain('PROJECT-SECRET-VALUE');
        // Rust filled it in.
        expect((await calls(page, 'spawn_script')).at(-1).scriptContent).toContain("$token = 'PROJECT-SECRET-VALUE'");
    });
    test('the backend refuses a project that is not trusted, even when the prompt is skipped', async ({ page }) => {
        await openPage(page, scriptPage('Write-Host a'));
        const error = await page.evaluate(() => webui.proxy.runPageScript('Repo_T_x', 'Write-Host a', {}, err => `${err}`));
        expect(error).toContain('not trusted');
        await expect.poll(() => calls(page, 'spawn_script')).toEqual([]);
    });
    test('trusting a project reaches the backend before the script runs', async ({ page }) => {
        await openPage(page, scriptPage('Write-Host a'));
        await runScript(page);
        await expect.poll(() => page.evaluate(() => window.__backend.appData.data['app-trusted-projects'])).toEqual(['/repo']);
    });
    test.describe('a dropdown of project files', () => {
        // The layout of a page that picks a solution, as in the page help's app-files example.
        const filesPage = (files = 'page-solutions') => [
            '# NuGet',
            '',
            '<webui-page-segment>',
            '',
            `<app-files data-trigger="${files}" display="[parent]/[file].[ext]" filter="*.sln"></app-files>`,
            `<webui-dropdown data-subscribe="${files}:setOptions" data-bind="solution"></webui-dropdown>`,
            '',
            '```PowerShell',
            "$solution = ''",
            'dotnet list $solution package --outdated',
            '```',
            '',
            '</webui-page-segment>',
        ].join('\n');
        const options = [{ value: '/One.sln', display: '/One.sln' }, { value: 'sub/Two.sln', display: 'sub/Two.sln' }];
        const openFilesPage = async (page, found, state = {}) => {
            // Searching a large project takes a while, so the search is held until the page has loaded and shows its
            // dropdown, and the options arrive after that.
            await openApp(page, {
                currentPage: '/abc', projectFiles: found, holdSearch: true,
                ...state, files: { '.taskproxy/pages/abc.md': filesPage() },
            }, '/abc');
            await page.waitForSelector('app-page-handler > webui-reorder > app-markdown-segment');
            await expect(page.locator('app-page-handler webui-dropdown select')).toBeAttached();
            await expect.poll(async () => (await calls(page, 'search_project_files')).length).toBeGreaterThan(0);
            await page.evaluate(() => window.__backend.releaseSearch());
        };
        test('the first file shown is used by the script without choosing it', async ({ page }) => {
            await openFilesPage(page, options);
            await expect.poll(() => page.locator('app-page-handler webui-dropdown select').evaluate(el => el.options.length)).toBe(2);
            const script = await runScript(page);
            expect(script).toContain("$solution = '/One.sln'");
        });
        test('a dropdown with one file sets it', async ({ page }) => {
            // Defining the variable with no default, as the variable manager does, leaves it blank rather than unset.
            await openFilesPage(page, options.slice(0, 1), { variables: ['solution|text|'], data: { solution: '' } });
            await expect.poll(() => page.locator('app-page-handler webui-dropdown select').evaluate(el => el.options.length)).toBe(1);
            const script = await runScript(page);
            expect(script).toContain("$solution = '/One.sln'");
        });
        test('a file chosen before is kept', async ({ page }) => {
            await openFilesPage(page, options, { data: { solution: 'sub/Two.sln' } });
            await expect.poll(() => page.locator('app-page-handler webui-dropdown select').evaluate(el => el.options.length)).toBe(2);
            await expect.poll(() => page.locator('app-page-handler webui-dropdown').evaluate(el => el.value)).toBe('sub/Two.sln');
            const script = await runScript(page);
            expect(script).toContain("$solution = 'sub/Two.sln'");
        });
    });
    for (const filter of ['Running', 'All Running']) {
        test(`a script that finishes before the Terminal Manager shows it is shown with its output each time it runs, in ${filter}`, async ({ page }) => {
            await openPage(page, scriptPage('tokei .'), { appData: { 'app-trusted-projects': ['/repo'], 'app-terminals-filter': filter } });
            await spyOnAlerts(page);
            // Its output and its end arrive before Rust has answered that it started.
            await page.evaluate(() => {
                let count = 0;
                window.__backend.handlers.spawn_script = ({ terminalId }) => {
                    window.__backend.runs.write({ terminalId, data: `REPORT ${++count}\r\n` });
                    window.__backend.runs.end({ terminalId, code: 0 });
                    return { message: 'Script started', interactive: true };
                };
            });
            const view = page.locator('app-terminal-view#term-console');
            for (let run = 1; run <= 3; run++) {
                await page.locator('webui-icon.run-script-btn').click();
                await expect.poll(() => view.evaluate(el => el.getScreenText())).toContain(`REPORT ${run}`);
            }
            await expect.poll(() => page.evaluate(() => document.querySelector('app-terminals')._activeDropdown.value)).toBe('Repo_Page_Run this');
            // A page script's terminal is no file, so none was looked for, and nothing said it was missing.
            expect((await calls(page, 'get_project_file')).map(call => call.filePath)).not.toContain('Repo_Page_Run this');
            expect(await alerts(page)).toEqual([]);
        });
    }
});
test.describe('help', () => {
    const openHelp = async page => {
        const help = page.locator('app-page-handler > webui-page-help');
        await expect(help.locator('button.bubble')).toBeVisible();
        await help.locator('button.bubble').click();
        await expect(help.locator('.panel h2')).toHaveText('Page Help');
        return help;
    };
    test('the page help guides writing pages, and is not saved with the page', async ({ page }) => {
        await openPage(page, '# One');
        const help = await openHelp(page);
        const tabs = help.locator('webui-tabs').first().locator(':scope > webui-button');
        await expect(tabs).toHaveText(['Editing Pages', 'Markdown', 'Scripts & Variables', 'HTML & Components']);
        await tabs.nth(1).click();
        await expect(help.getByText('Segments are written in markdown.')).toBeVisible();
        // The guide's scripts are examples, so they get no run button.
        await tabs.nth(2).click();
        await expect(help.locator('webui-code[language="pwsh"]')).toBeVisible();
        await expect(page.locator('webui-icon.run-script-btn')).toHaveCount(0);
        // The panel can cover the Save button.
        await help.locator('.panel button.close').click();
        await expect(help.locator('.panel')).toBeHidden();
        await save(page);
        expect((await saved(page)).contents).toBe('<webui-data data-page-title="" data-page-subtitle=""></webui-data>\n\n# One');
    });
    test('the help lists the Web UI components a page can use, without changing the url', async ({ page }) => {
        await openPage(page, '# One');
        const help = await openHelp(page);
        await help.locator('webui-tabs').first().locator(':scope > webui-button').nth(3).click();
        const buttons = help.locator('webui-components webui-tabs > webui-button');
        await expect(buttons.first()).toBeVisible();
        const listed = () => buttons.evaluateAll(list => list.map(b => b.textContent.trim()));
        await expect.poll(listed).toContain('webui-alert');
        await expect.poll(listed).toContain('webui-input-text');
        // The list is built in one step, so with those in it, it is complete.
        const names = await listed();
        for (const name of ['webui-app', 'webui-page-help', 'webui-components', 'app-template']) expect(names).not.toContain(name);
        const url = page.url();
        await buttons.nth(names.indexOf('webui-alert')).click();
        await expect(help.locator('webui-components webui-content[src$="/webui-alert.md"]')).toContainText('webui-alert');
        await expect(page).toHaveURL(url);
    });
});

test.describe('segment layout', () => {
    /** The markdown of each segment, as the page splits it. */
    const segmentsOf = page => page.locator('app-page-handler > webui-reorder > app-markdown-segment').evaluateAll(list => list.map(el => el.getMarkdown()));
    // Opening a project reloads its page once more, so wait for the segments to settle.
    const layout = async page => {
        await expect.poll(async () => (await segmentsOf(page)).length).toBeGreaterThan(0);
        return segmentsOf(page);
    };
    const wrap = text => `<webui-page-segment>\n\n${text}\n\n</webui-page-segment>`;
    test('content runs until the next heading, line break, page segment, or the end', async ({ page }) => {
        await openPage(page, 'Intro\n\nMore intro\n## Next\nAfter heading\n<webui-line></webui-line>\nAfter line\n<webui-page-segment elevation="10">\n\nKept\n\n</webui-page-segment>\nLast');
        await expect.poll(() => layout(page)).toEqual([
            wrap('Intro\n\nMore intro'),
            '## Next',
            wrap('After heading'),
            '<webui-line></webui-line>',
            wrap('After line'),
            '<webui-page-segment elevation="10">\n\nKept\n\n</webui-page-segment>',
            wrap('Last'),
        ]);
    });
    test('headings and tags inside code blocks and components do not split them', async ({ page }) => {
        const code = '```pwsh\n# A comment\n<webui-line></webui-line>\n```';
        const tabs = '<webui-tabs>\n## Inside tabs\n</webui-tabs>';
        await openPage(page, `${code}\n${tabs}`);
        await expect.poll(() => layout(page)).toEqual([wrap(`${code}\n${tabs}`)]);
    });
    test('#text with no space is content, not a heading', async ({ page }) => {
        await openPage(page, '#hashtag\n# Real heading');
        await expect.poll(() => layout(page)).toEqual([wrap('#hashtag'), '# Real heading']);
    });
    test('deleting a segment leaves it out of the saved page', async ({ page }) => {
        await openPage(page, '# Keep\n\n# Remove');
        const doomed = page.locator('app-page-handler > webui-reorder > app-markdown-segment').nth(1);
        await doomed.locator('#btn-edit').click();
        await doomed.locator('#btn-delete').click();
        await expect(page.locator('app-page-handler > webui-reorder > app-markdown-segment')).toHaveCount(1);
        await save(page);
        expect((await saved(page)).contents).toBe('<webui-data data-page-title="" data-page-subtitle=""></webui-data>\n\n# Keep');
    });
});


test.describe('importing a markdown file', () => {
    // What import_page_file gives for each file: its markdown as page segments (services/page_import.rs).
    const imported = '## Imported\n\n<webui-page-segment>\n\nFrom the file\n\n</webui-page-segment>';
    const state = { docs: ['docs/guide.md', 'notes/todo.md'], fileImports: { 'docs/guide.md': imported, 'notes/todo.md': '<webui-page-segment>\n\nTodo\n\n</webui-page-segment>' } };
    const data = '<webui-data data-page-title="T" data-page-subtitle=""></webui-data>';
    const importButton = page => page.locator('app-page-handler webui-button.page-import');
    const fileField = page => openDialog(page).locator('webui-select.import-file');
    const position = page => openDialog(page).locator('webui-switch.import-position');
    async function openImport(page) {
        await importButton(page).click();
        // Shown by its name, with its path as the tooltip.
        await expect(fileField(page).locator('.pick-name')).toHaveText('guide.md');
        await expect(fileField(page).locator('.pick')).toHaveAttribute('title', 'docs/guide.md');
    }

    test('adds the file after the page\'s content by default, saves, and shows it', async ({ page }) => {
        await openPage(page, `${data}\n\n# Existing\n\nBody`, state);
        await openImport(page);
        await expect(position(page).getByRole('radio', { name: 'After this page\'s content' })).toHaveAttribute('aria-checked', 'true');
        await dialogButton(page, 'Import').click();
        await expect.poll(() => calls(page, 'import_page_file')).toEqual([{ file: 'docs/guide.md' }]);
        await expect.poll(async () => (await calls(page, 'save_project_file')).at(-1)?.contents).toBe([
            data, '# Existing', '<webui-page-segment>\n\nBody\n\n</webui-page-segment>', imported,
        ].join('\n\n'));
        await expect(page.locator('app-page-handler > webui-reorder > app-markdown-segment')).toHaveText([/Existing/, /Body/, /Imported/, /From the file/]);
        await expect(openDialog(page)).toHaveCount(0);
        await expect(actionNote(page.locator('app-page-handler'), 'Imported the file into this page.')).toHaveCount(1);
    });

    test('can add the file before the page\'s content, choosing which file', async ({ page }) => {
        await openPage(page, `${data}\n\n# Existing`, state);
        await openImport(page);
        await fileField(page).getByRole('button').first().click();
        await fileField(page).locator('.tile[data-value="notes/todo.md"]').click();
        await position(page).getByRole('radio', { name: 'Before this page\'s content' }).click();
        await dialogButton(page, 'Import').click();
        await expect.poll(async () => (await calls(page, 'save_project_file')).at(-1)?.contents).toBe([
            data, '<webui-page-segment>\n\nTodo\n\n</webui-page-segment>', '# Existing',
        ].join('\n\n'));
        await expect(page.locator('app-page-handler > webui-reorder > app-markdown-segment')).toHaveText([/Todo/, /Existing/]);
    });

    test('on an empty page, before or after can\'t be chosen, and the file becomes the page', async ({ page }) => {
        await openApp(page, { currentPage: '/new-page', ...state }, '/new-page');
        await openImport(page);
        await expect(position(page)).toHaveAttribute('inert', '');
        await expect(openDialog(page).getByText('This page is empty, so the file becomes its content.')).toBeVisible();
        await dialogButton(page, 'Import').click();
        await expect.poll(async () => (await calls(page, 'save_project_file')).at(-1)).toEqual({
            filePath: '.taskproxy/pages/new-page.md',
            contents: ['<webui-data data-page-title="" data-page-subtitle=""></webui-data>', imported].join('\n\n'),
        });
    });

    test('a file the backend refuses says why, keeps the dialog open, and saves nothing', async ({ page }) => {
        await openPage(page, `${data}\n\n# Existing`, { ...state, fileImports: {} });
        await openImport(page);
        await dialogButton(page, 'Import').click();
        await expect(openDialog(page)).toContainText("Import Failed: The project has no file 'docs/guide.md'.");
        await expect.poll(() => calls(page, 'save_project_file')).toEqual([]);
    });

    test('a page that could not be saved says why in the dialog, which stays open', async ({ page }) => {
        await openPage(page, `${data}\n\n# Existing`, state);
        await openImport(page);
        await page.evaluate(() => { window.__backend.handlers.save_project_file = () => { throw 'The disk is full.'; }; });
        await dialogButton(page, 'Import').click();
        await expect(openDialog(page)).toContainText('The disk is full.');
        await expect(page.locator('app-page-handler > webui-reorder > app-markdown-segment')).toHaveText([/Existing/]);
    });

    test('a page left while it saves still gets the file, says so, and the dialog closes', async ({ page }) => {
        await openPage(page, `${data}\n\n# Existing`, state);
        await openImport(page);
        await page.evaluate(() => {
            const original = window.__backend.handlers.save_project_file;
            const held = new Promise(resolve => { window.__releaseSave = resolve; });
            window.__backend.handlers.save_project_file = async args => { await held; return original(args); };
        });
        await dialogButton(page, 'Import').click();
        await expect.poll(() => calls(page, 'save_project_file')).toHaveLength(1);
        await goToPage(page, '/');
        await page.evaluate(() => window.__releaseSave());
        await expect(alertPopup(page, 'Imported docs/guide.md into the page that was shown.')).toHaveCount(1);
        await expect(openDialog(page)).toHaveCount(0);
        await expect.poll(async () => (await calls(page, 'save_project_file'))[0].contents).toContain('From the file');
    });

    test('why a file could not be imported is shown as text, never as markup', async ({ page }) => {
        const name = '<img src=q onerror="window.__xss=1">.md';
        await openPage(page, `${data}\n\n# Existing`, { docs: [name], fileImports: {} });
        await importButton(page).click();
        await dialogButton(page, 'Import').click();
        await expect(openDialog(page).locator('webui-alert')).toContainText(`Import Failed: The project has no file '${name}'.`);
        await expect(openDialog(page).locator('webui-alert img')).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => window.__xss)).toBeUndefined();
    });

    test('a project with no markdown files says so', async ({ page }) => {
        await openPage(page, '# Existing', { docs: [] });
        await importButton(page).click();
        await expect(actionNote(page, 'This project has no markdown files to import.')).toHaveCount(1);
        await expect(openDialog(page)).toHaveCount(0);
    });
});

test.describe('copying the page', () => {
    const copyButton = page => page.locator('app-page-handler webui-button.page-copy');
    const clipboard = page => page.evaluate(() => window.__backend.clipboard);

    test("copies the page's markdown file as it is saved, not what is being edited", async ({ page }) => {
        const md = '<webui-data data-page-title="T" data-page-subtitle=""></webui-data>\n\n# Saved\n\nBody';
        await openPage(page, md);
        const segment = page.locator('app-page-handler > webui-reorder > app-markdown-segment').nth(1);
        await segment.locator('#btn-edit').click();
        await segment.locator('webui-input-message textarea').fill('Not saved yet');
        await copyButton(page).click();
        await expect(actionNote(page, "Copied this page's markdown.")).toHaveCount(1);
        await expect.poll(() => clipboard(page)).toEqual({ text: md });
        await expect.poll(() => calls(page, 'save_project_file')).toEqual([]);
    });

    test('a file that cannot be read says why, and copies nothing', async ({ page }) => {
        await openPage(page, '# Existing');
        await page.evaluate(() => { window.__backend.handlers.get_project_file = () => { throw 'Failed to load file: denied'; }; });
        await copyButton(page).click();
        await expect(actionNote(page, "This page's file could not be read. Failed to load file: denied")).toHaveCount(1);
        await expect.poll(() => clipboard(page)).toBeUndefined();
    });
});
