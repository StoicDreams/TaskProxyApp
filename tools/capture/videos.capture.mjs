import { test, expect, openApp } from '../../tests/support/app.mjs';
import { demoState, PAGE_IDS } from './demo.mjs';
import { caption, clickOn, moveTo, parkMouse, prepare, record, scriptOutput, typeInto } from './helpers.mjs';

const settle = page => page.waitForTimeout(1200);
const open = async (page, route, state = {}) => {
    await prepare(page);
    await openApp(page, demoState({ currentPage: route, ...state }), route);
    await settle(page);
    await parkMouse(page);
};

test('commit and sync with the Git Controller', async ({ page }) => {
    await open(page, '/git-controller');
    const git = page.locator('app-git-manager');
    await git.locator('.files button.file').first().waitFor();
    // What the backend reports once the commit and sync are done.
    await page.evaluate(() => {
        const backend = window.__backend;
        backend.handlers.git_commit = () => {
            backend.git.changes = ['M  src/nav.json'];
            backend.git.lineStats = backend.git.lineStats.filter(stat => stat.path === 'src/nav.json');
            backend.git.status = { ...backend.git.status, ahead: 3 };
            return 'Commit successful.';
        };
        backend.handlers.git_sync = () => {
            backend.git.status = { ...backend.git.status, ahead: 0, behind: 0 };
            return 'Pulled 1 commit.\nPush Successful';
        };
    });
    await record(page, 'git-commit-sync', async () => {
        await caption(page, 'Every changed file is listed, with its changes beside it', 2200);
        await clickOn(page, git.locator('.files button.file[title="README.md"]'), { after: 1400 });
        await caption(page, 'Use the arrow keys to step through the files');
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(1200);
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(1600);
        await caption(page, 'Leave a file out of this commit with Exclude');
        const include = git.locator('.files .file-row[data-path="src/nav.json"] select.include');
        await moveTo(page, include);
        await page.waitForTimeout(300);
        await include.selectOption({ label: 'Exclude' });
        await page.waitForTimeout(1500);
        await caption(page, 'Write a message, then Commit');
        await typeInto(page, git.locator('webui-input-message[label="Commit Message"] textarea'),
            'Apply cart discounts\nFeature: Discounts lower the cart total\nBug: Quantities were left out of the total', { delay: 28 });
        await page.waitForTimeout(500);
        await caption(page, 'With Sync after commit on, your commit is pulled and pushed straight away');
        await moveTo(page, git.locator('webui-toggle-icon').filter({ hasText: 'Sync after commit' }));
        await page.waitForTimeout(1500);
        await clickOn(page, git.locator('webui-button[label="Commit"]'), { after: 2500 });
        await caption(page, 'Committed and synced. Only the excluded file is left', 3000);
    });
});

test('run a page script against another environment', async ({ page }) => {
    await open(page, `/${PAGE_IDS.onboarding}`);
    await page.locator('webui-icon.run-script-btn').nth(1).waitFor();
    await scriptOutput(page, [
        { wait: 400 },
        '\x1b[32mUsing https://staging.api.acme.test\x1b[0m\r\n',
    ]);
    await record(page, 'page-script-environment', async () => {
        await caption(page, 'Team pages hold the steps, and the scripts that do them', 2400);
        await moveTo(page, page.locator('webui-icon.run-script-btn').nth(1), { offsetY: 40 });
        await caption(page, 'This script uses the apiBaseUrl variable', 2200);
        await caption(page, 'Open Manage Variables to choose an environment');
        await clickOn(page, page.locator('app-var-manager'), { after: 1500 });
        const env = page.locator('#env-selector');
        await env.waitFor({ state: 'attached' });
        await moveTo(page, env);
        await page.waitForTimeout(400);
        await env.evaluate(el => {
            el.value = 'staging';
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await caption(page, 'Switching to staging changes every value at once', 2600);
        await clickOn(page, page.locator('app-var-manager'), { after: 1200 });
        await caption(page, 'Run the script from the page');
        await clickOn(page, page.locator('webui-icon.run-script-btn').nth(1), { after: 1000 });
        await caption(page, 'Task Proxy shows what will run, with secrets masked, before it runs', 2400);
        await clickOn(page, page.getByText('Trust Project & Run'), { after: 2500 });
        await caption(page, 'The script ran with the staging address', 3000);
    });
});

test('answer a script\'s prompt in the terminal', async ({ page }) => {
    await open(page, '/script-manager');
    const manager = page.locator('app-script-manager');
    await manager.locator('.params-container [data-param="Suite"]').waitFor();
    await scriptOutput(page, [
        { wait: 300 },
        { prompt: 'Deploy the current branch to staging? [y/N]: ' },
        '\x1b[36mDeploying to staging\x1b[0m\r\n',
        { wait: 500 },
        'Uploading build 1.4.3 ',
        ...Array.from({ length: 12 }, () => ['\x1b[32m█\x1b[0m', { wait: 120 }]).flat(),
        ' done\r\n',
        '\x1b[32m✔ Published to https://staging.acme.test\x1b[0m\r\n',
    ]);
    await record(page, 'script-prompt', async () => {
        await caption(page, 'The Script Manager runs the scripts saved in your project', 2200);
        await moveTo(page, manager.locator('webui-dropdown').first());
        await page.evaluate(() => {
            const el = document.querySelector('app-script-manager');
            el._fileSelector.value = '.taskproxy/scripts/deploy.ps1';
            el._fileSelector.dispatchEvent(new Event('change'));
        });
        const environment = manager.locator('.params-container [data-param="Environment"] input');
        await environment.waitFor();
        await page.waitForTimeout(800);
        await caption(page, 'Each parameter gets its own input');
        await typeInto(page, environment, 'staging', { delay: 70 });
        await clickOn(page, manager.locator('.params-container [data-param="SkipBuild"]'), { after: 1200 });
        await caption(page, 'Run it, then open the Terminal Manager');
        await clickOn(page, manager.locator('webui-button[label="Run"]').first(), { after: 600 });
        await clickOn(page, page.locator('app-terminals'), { after: 800 });
        await expect.poll(() => page.evaluate(() => !!webui.proxy.terminalHelpers.getState().terminals['.taskproxy/scripts/deploy.ps1'])).toBe(true);
        await page.evaluate(() => document.querySelector('app-terminals').switchTerminal('.taskproxy/scripts/deploy.ps1'));
        await page.waitForTimeout(1500);
        await caption(page, 'When a script asks a question, click the terminal and type your answer');
        await clickOn(page, page.locator('#term-console'), { after: 600 });
        await page.keyboard.type('y', { delay: 200 });
        await page.waitForTimeout(500);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(3500);
        await caption(page, 'Colors and progress bars show just as they do in your own terminal', 3000);
    });
});

test('build a team page', async ({ page }) => {
    await open(page, '/nav-manager');
    const nav = page.locator('app-nav-manager');
    const button = label => nav.locator(`webui-button[label="${label}"]`);
    await button('Add Page').waitFor();
    await record(page, 'build-a-page', async () => {
        await caption(page, 'Add a page to the project\'s navigation');
        await clickOn(page, button('Add Page'), { after: 900 });
        await caption(page, 'Name it, pick an icon, and save');
        const name = nav.locator('webui-input-text[label="Name"] input');
        await clickOn(page, name, { after: 200 });
        await page.keyboard.press('ControlOrMeta+a');
        await page.keyboard.type('Database Reset', { delay: 60 });
        await page.waitForTimeout(400);
        const search = nav.locator('webui-input-text').filter({ hasText: 'Search' }).locator('input').first();
        if (await search.count()) {
            await typeInto(page, search, 'database', { delay: 70 });
            await page.waitForTimeout(1500);
            const result = nav.locator('webui-icon-search a, webui-icon-search button').first();
            if (await result.count()) await clickOn(page, result, { after: 800 });
        }
        await clickOn(page, button('Save'), { after: 1500 });
        await caption(page, 'Open the new page and add content');
        await clickOn(page, page.locator('webui-drawer.nav webui-nav-link', { hasText: 'Database Reset' }).first(), { after: 1800 });
        await caption(page, 'Click the header to give the page a title');
        await clickOn(page, page.locator('header h1'), { after: 700 });
        await typeInto(page, page.locator('webui-input-text[name="pageTitle"] input'), 'Database Reset', { delay: 60 });
        await clickOn(page, page.locator('dialog[open]').last().getByText('Save', { exact: true }).last(), { after: 900 });
        await caption(page, 'Add segments for headings and steps');
        // The bottom Add appends. Found by text, since Web UI moves a hovered element's title into aria-label.
        const add = page.locator('app-page-handler webui-button').filter({ hasText: 'Add' }).last();
        await clickOn(page, add, { after: 900 });
        const segments = page.locator('app-page-handler > app-markdown-segment');
        await expect(segments).toHaveCount(1);
        await editSegment(page, segments.nth(0), '### {}', 'Reset your local database');
        await clickOn(page, add, { after: 900 });
        await caption(page, 'Write steps in markdown. A pwsh block becomes a script with a Run button');
        await editSegment(page, segments.nth(1), '<webui-page-segment>\n\n{}\n\n</webui-page-segment>',
            'Drops and reseeds the local database. Your data is lost.\n\n```pwsh\n$databaseName = \'acme_dev\'\nnpm run db:reset -- --database $databaseName\n```');
        await caption(page, 'Save, and commit the page to share it with your team');
        await clickOn(page, page.locator('app-page-handler webui-button').filter({ hasText: 'Save' }).first(), { after: 2500 });
        await caption(page, '');
    });
});

/** Opens a segment's editor, sets its type and text, and closes it again. */
async function editSegment(page, segment, type, text) {
    await clickOn(page, segment.locator('aside webui-button').first(), { after: 700 });
    // The segment types are the templates offered in its dropdown.
    await segment.evaluate((el, value) => {
        el._options.value = value;
        el._options.dispatchEvent(new Event('change'));
    }, type);
    await page.waitForTimeout(500);
    const input = segment.getByRole('textbox').first();
    await clickOn(page, input, { after: 200 });
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type(text, { delay: 22 });
    await page.waitForTimeout(700);
    await clickOn(page, segment.locator('aside webui-button').first(), { after: 1200 });
}
