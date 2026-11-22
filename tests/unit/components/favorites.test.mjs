import { test, expect, openApp, openPage, calls, dialogButton, openDialog, switchProject } from '../support/app.mjs';
import { alertPopup, actionNote } from '../../support/wait.mjs';

// Favorite scripts (wc/favorites.js), in the bottom drawer. The list is app data; the mock backend finds and runs
// each script as services/favorites.rs does, whose own tests hold how values are filled.
const REPO = { name: 'Repo', path: '/repo' };
const OTHER = { name: 'Other', path: '/other' };
const DEPLOY = 'param(\n    [string]$Env,\n    [switch]$Force\n)\nWrite-Host "Deploying $Env"\n';
const PAGE = '# Steps\n\nInstall the tools\n\n```pwsh\nnpm install\n```\n\nBuild it\n\n```pwsh\n$target = \'debug\'\ncargo build --$target\n```\n';
const favorite = (id, extra = {}) => ({
    id, name: `Fav ${id}`, icon: null, project: '/repo', source: { kind: 'file', path: 'deploy.ps1' },
    params: [], scopes: { page: true, project: true, global: true }, projects: [], preview: 'Write-Host "Deploying $Env"', ...extra,
});
const state = (favorites = [], extra = {}) => ({
    projects: [REPO, OTHER], scripts: ['deploy.ps1', 'tools/build.ps1'],
    files: { 'deploy.ps1': DEPLOY, 'tools/build.ps1': 'Write-Host build\n', '.taskproxy/pages/steps.md': PAGE },
    appData: { 'app-favorite-scripts': favorites, 'app-trusted-projects': ['/repo', '/other'] },
    ...extra,
});
const bar = page => page.locator('app-favorites .fav-bar');
const icons = page => page.locator('app-favorites .fav-icons > .fav-icon');
const saved = page => page.evaluate(() => window.__backend.appData.data['app-favorite-scripts']);
const manage = page => page.locator('app-favorites .fav-manage');
const detail = page => manage(page).locator('.fav-detail');

test('with no favorites, the drawer says how to add one, beside the pencil', async ({ page }) => {
    await openApp(page, state());
    await expect(bar(page).getByRole('button', { name: 'Manage favorite scripts' })).toBeVisible();
    await expect(bar(page)).toContainText('Favorite scripts show here. Add one with the pencil.');
    await expect(icons(page)).toHaveCount(0);
});

test('shows the favorites for the open project, in order, each named with its first line as its tooltip', async ({ page }) => {
    await openApp(page, state([
        favorite('a', { icon: { name: 'rocket' } }),
        favorite('b', { projects: ['/other'] }),
        favorite('c', { projects: ['/repo', '/other'] }),
    ]));
    await expect.poll(() => icons(page).evaluateAll(list => list.map(icon => icon.dataset.id))).toEqual(['a', 'c']);
    // Its name and first line are its tooltip, which Web UI shows from its aria-label, and what screen readers say.
    await expect(icons(page).first()).toHaveAccessibleName('Fav a: Write-Host "Deploying $Env"');
    await expect(icons(page).first().locator('webui-icon')).toHaveAttribute('icon', 'rocket');
});

test('hovering an icon reads its script again for the tooltip', async ({ page }) => {
    await openApp(page, state([favorite('a')]));
    await page.evaluate(() => window.__backend.handlers.favorite_script = () => '# comment\nWrite-Host "Changed"\n');
    await icons(page).first().hover();
    await expect(icons(page).first()).toHaveAccessibleName('Fav a: Write-Host "Changed"');
});

test("a script's comment-based help, attributes, and parameters are left out of its tooltip", async ({ page }) => {
    const script = '<#\n.SYNOPSIS\nRuns the tests.\n#>\n[CmdletBinding()]\nparam(\n    [ValidateSet(\'unit\', \'e2e\')]\n    [string]$Suite = \'unit\',\n    [switch]$Watch\n)\n\nnpm run "test:$Suite"\n';
    await openApp(page, state([favorite('a')]));
    await page.evaluate(script => window.__backend.handlers.favorite_script = () => script, script);
    await icons(page).first().hover();
    await expect(icons(page).first()).toHaveAccessibleName('Fav a: npm run "test:$Suite"');
});

test('clicking an icon runs it in its project, with its parameters and the page values it may use, and shows it running', async ({ page }) => {
    const params = [{ name: 'Env', fromData: false, value: 'staging', key: '', switch: false }];
    await openApp(page, state([favorite('a', { params, scopes: { page: true, project: false, global: true } })]));
    await page.evaluate(() => webui.setData('Env', 'from-page'));
    await icons(page).first().click();
    await expect.poll(() => calls(page, 'run_favorite')).toEqual([{
        favorite: {
            id: 'a', name: 'Fav a', project: '/repo', source: { kind: 'file', path: 'deploy.ps1' }, params,
            scopes: { page: true, project: false, global: true }, pageValues: { Env: 'from-page' },
        },
    }]);
    await expect(page.locator('webui-drawer.shared webui-content.tools-terminals')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.querySelector('app-terminals').filter())).toBe('Running');
});

test('a favorite that may not use page data sends no page values', async ({ page }) => {
    await openApp(page, state([favorite('a', { scopes: { page: false, project: true, global: true } })]));
    await page.evaluate(() => webui.setData('Env', 'from-page'));
    await icons(page).first().click();
    await expect.poll(async () => (await calls(page, 'run_favorite'))[0]?.favorite.pageValues).toEqual({});
});

test('the open project asks to be trusted first, and Cancel runs nothing', async ({ page }) => {
    await openApp(page, state([favorite('a')], { appData: { 'app-favorite-scripts': [favorite('a')], 'app-trusted-projects': [] } }));
    await icons(page).first().click();
    await expect(openDialog(page)).toContainText('Run Script From This Project?');
    await dialogButton(page, 'Cancel').click();
    await expect(openDialog(page)).toHaveCount(0);
    await expect.poll(() => calls(page, 'run_favorite')).toEqual([]);
});

test('a favorite whose script is gone says why, and runs nothing', async ({ page }) => {
    const gone = favorite('a', { source: { kind: 'page', page: 'steps', index: 4, text: 'removed\n', count: 5 } });
    await openApp(page, state([gone]));
    await icons(page).first().click();
    // Said after the bar, by the icon, not in the app's alerts.
    const why = "This favorite's script is no longer on its page. Open the page, and choose the script again.";
    await expect(page.locator('app-favorites .fav-bar + webui-alert.action-note[show]')).toHaveText(why);
    await expect(alertPopup(page, why)).toHaveCount(0);
    await expect.poll(() => calls(page, 'run_favorite')).toEqual([]);
    // Running it again clears what was said, until it says so again.
    await page.evaluate(() => {
        window.__releaseScript = null;
        const script = window.__backend.handlers.favorite_script;
        window.__backend.handlers.favorite_script = async args => {
            await new Promise(resolve => window.__releaseScript = resolve);
            return script(args);
        };
    });
    await icons(page).first().click();
    await expect(actionNote(page.locator('app-favorites'), why)).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => typeof window.__releaseScript)).toBe('function');
    await page.evaluate(() => window.__releaseScript());
    await expect(actionNote(page.locator('app-favorites'), why)).toHaveCount(1);
});

test('what an icon said on the bar goes on managing favorites, opening another project, or removing a favorite', async ({ page }) => {
    const gone = favorite('a', { source: { kind: 'page', page: 'steps', index: 4, text: 'removed\n', count: 5 } });
    await openApp(page, state([gone, favorite('b')]));
    const said = page.locator('app-favorites .fav-bar + webui-alert.action-note[show]');
    const failRun = async () => {
        await icons(page).first().click();
        await expect(said).toHaveCount(1);
    };
    await failRun();
    await bar(page).getByRole('button', { name: 'Manage favorite scripts' }).click();
    await expect(manage(page)).toBeVisible();
    await expect(said).toHaveCount(0);
    await failRun();
    await switchProject(page, OTHER);
    await expect(said).toHaveCount(0);
    await failRun();
    await manage(page).locator('.fav-row[data-id="b"]').click();
    await detail(page).locator('webui-button.fav-remove').click();
    await dialogButton(page, 'Confirm').click();
    await expect.poll(async () => (await saved(page)).map(item => item.id)).toEqual(['a']);
    await expect(said).toHaveCount(0);
});

test('a few icons that fit show no ellipsis', async ({ page }) => {
    await openApp(page, state([favorite('a')]));
    await expect(icons(page)).toHaveCount(1);
    await expect(bar(page).locator('.fav-more')).toBeHidden();
});

test("the pencil opens the drawer over the page to manage them, and adds a script from the page shown, with its parameters", async ({ page }) => {
    await openPage(page, PAGE, { ...state(), pageId: 'steps' });
    await bar(page).getByRole('button', { name: 'Manage favorite scripts' }).click();
    await expect(page.locator('app-favorites')).toHaveAttribute('mode', 'manage');
    await expect(manage(page)).toBeVisible();
    await manage(page).locator('webui-button.fav-add').click();
    await expect(detail(page).locator('.fav-choice[data-block]')).toHaveText([/Install the tools\s*npm install/, /Build it\s*\$target = 'debug'/]);
    await expect(detail(page).locator('.fav-choice[data-file]')).toHaveText(['deploy.ps1', 'tools/build.ps1']);
    await detail(page).locator('.fav-choice[data-block="1"]').click();
    await expect.poll(async () => (await saved(page))?.[0]).toMatchObject({
        name: 'Build it', project: '/repo', projects: ['/repo'], preview: "$target = 'debug'",
        source: { kind: 'page', page: 'steps', index: 1, text: "$target = 'debug'\ncargo build --$target\n", count: 2 },
        params: [{ name: 'target', fromData: true, value: '', key: '', switch: false }],
        scopes: { page: true, project: true, global: true },
    });
    await expect(detail(page).locator('.fav-param[data-param="target"]')).toBeVisible();
    await expect(icons(page)).toHaveCount(1);
    // Said under the panel's buttons, since the panes below are drawn again.
    await expect(manage(page).locator('webui-alert.action-note[show]')).toHaveText('Added Build it to your favorites.');
});

test("a script file's parameters can be fixed or come from data, by another key", async ({ page }) => {
    await openApp(page, state());
    await bar(page).getByRole('button', { name: 'Manage favorite scripts' }).click();
    await manage(page).locator('webui-button.fav-add').click();
    await expect(detail(page)).toContainText('Open one of the project\'s pages to add its scripts.');
    await detail(page).locator('.fav-choice[data-file="deploy.ps1"]').click();
    const env = detail(page).locator('.fav-param[data-param="Env"]');
    const force = detail(page).locator('.fav-param[data-param="Force"]');
    await expect(env).toBeVisible();
    await env.locator('.fav-param-value').fill('deploy_env');
    await env.locator('.fav-param-value').press('Tab');
    await force.locator('.fav-param-mode').selectOption('fixed');
    await force.locator('.fav-param-value').check();
    await expect.poll(async () => (await saved(page))?.[0]?.params).toEqual([
        { name: 'Env', fromData: true, value: '', key: 'deploy_env', switch: false },
        { name: 'Force', fromData: false, value: true, key: '', switch: true },
    ]);
    await env.locator('.fav-param-mode').selectOption('fixed');
    await env.locator('.fav-param-value').fill('production');
    await env.locator('.fav-param-value').press('Tab');
    await expect.poll(async () => (await saved(page))?.[0]?.params?.[0]).toEqual({ name: 'Env', fromData: false, value: 'production', key: 'deploy_env', switch: false });
});

test('a favorite is renamed, limited to some data scopes, shown in some projects or all, and removed', async ({ page }) => {
    await openApp(page, state([favorite('a')]));
    await bar(page).getByRole('button', { name: 'Manage favorite scripts' }).click();
    const editor = detail(page).locator('.fav-editor');
    await expect(editor.locator('.fav-script')).toHaveText(DEPLOY);
    await editor.locator('webui-input-text.fav-name input').fill('Deploy');
    await editor.locator('webui-input-text.fav-name input').press('Tab');
    await expect.poll(async () => (await saved(page))?.[0]?.name).toBe('Deploy');
    await editor.locator('input[data-scope="global"]').uncheck();
    await expect.poll(async () => (await saved(page))?.[0]?.scopes).toEqual({ page: true, project: true, global: false });
    await editor.locator('input[data-show="some"]').check();
    await expect.poll(async () => (await saved(page))?.[0]?.projects).toEqual(['/repo']);
    await detail(page).locator('input[data-project="/other"]').check();
    await expect.poll(async () => (await saved(page))?.[0]?.projects).toEqual(['/repo', '/other']);
    await detail(page).locator('input[data-show="all"]').check();
    await expect.poll(async () => (await saved(page))?.[0]?.projects).toEqual([]);
    await detail(page).locator('webui-button.fav-remove').click();
    await expect(openDialog(page)).toContainText('The script itself stays as it is.');
    await dialogButton(page, 'Confirm').click();
    await expect.poll(() => saved(page)).toEqual([]);
    await expect(icons(page)).toHaveCount(0);
});

test('an icon is chosen from the project\'s images, and Default goes back to the play icon', async ({ page }) => {
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    await openApp(page, state([favorite('a')], { projectImagesByPath: { '/repo': ['img/rocket.png'] }, images: ['img/rocket.png'], binaryFiles: { 'img/rocket.png': PNG } }));
    await bar(page).getByRole('button', { name: 'Manage favorite scripts' }).click();
    await detail(page).locator('webui-button.fav-pick-image').click();
    await openDialog(page).locator('.fav-image-tile[data-image="img/rocket.png"]').click();
    await dialogButton(page, 'Use This Image').click();
    await expect.poll(async () => (await saved(page))?.[0]?.icon).toEqual({ image: 'img/rocket.png' });
    await expect(icons(page).first().locator('img')).toHaveAttribute('src', /rocket\.png$/);
    await detail(page).locator('webui-button.fav-clear-icon').click();
    await expect.poll(async () => (await saved(page))?.[0]?.icon).toBeNull();
});

test('a script file that can\'t be read says why under the files, and what was said goes once the manager closes', async ({ page }) => {
    await openPage(page, PAGE, { ...state(), pageId: 'steps' });
    await bar(page).getByRole('button', { name: 'Manage favorite scripts' }).click();
    await manage(page).locator('webui-button.fav-add').click();
    await page.evaluate(() => { window.__backend.handlers.favorite_script = () => { throw 'deploy.ps1 could not be read.'; }; });
    await detail(page).locator('.fav-choice[data-file="deploy.ps1"]').click();
    await expect(detail(page).locator('.fav-file-choices + webui-alert.action-note[show]')).toHaveText('deploy.ps1 could not be read.');
    await detail(page).locator('.fav-choice[data-block="0"]').click();
    await expect(manage(page).locator('.fav-manage-head + webui-alert.action-note[show]')).toHaveText('Added Install the tools to your favorites.');
    await manage(page).locator('webui-button.fav-done').click();
    await bar(page).getByRole('button', { name: 'Manage favorite scripts' }).click();
    await expect(manage(page)).toBeVisible();
    await expect(manage(page).locator('.fav-manage-head + webui-alert.action-note[show]')).toHaveCount(0);
});

test('Done closes the manager back to one row of icons', async ({ page }) => {
    await openApp(page, state([favorite('a')]));
    await bar(page).getByRole('button', { name: 'Manage favorite scripts' }).click();
    await manage(page).locator('webui-button.fav-done').click();
    await expect(page.locator('app-favorites')).toHaveAttribute('mode', 'bar');
    await expect(manage(page)).toBeHidden();
});

test('a favorite from another project, shown in every project, runs in its own project', async ({ page }) => {
    const fromOther = favorite('o', { project: '/other', source: { kind: 'file', path: 'ship.ps1' } });
    await openApp(page, state([fromOther], { otherProjectFiles: { '/other': { 'ship.ps1': 'Write-Host ship\n' } } }));
    await icons(page).first().click();
    await expect.poll(async () => (await calls(page, 'run_favorite'))[0]?.favorite.project).toBe('/other');
    // The open project is a different one, so it is not asked about.
    await expect(openDialog(page)).toHaveCount(0);
});

test('what adding a favorite said goes on picking another favorite, or Add Script again', async ({ page }) => {
    await openPage(page, PAGE, { ...state([favorite('a')]), pageId: 'steps' });
    await bar(page).getByRole('button', { name: 'Manage favorite scripts' }).click();
    const added = manage(page).locator('.fav-manage-head + webui-alert.action-note[show]');
    const addBuild = async () => {
        await manage(page).locator('webui-button.fav-add').click();
        await detail(page).locator('.fav-choice[data-block="1"]').click();
        await expect(added).toHaveText('Added Build it to your favorites.');
    };
    await addBuild();
    await manage(page).locator('.fav-row[data-id="a"]').click();
    await expect(detail(page).locator('.fav-editor[data-id="a"]')).toBeVisible();
    await expect(added).toHaveCount(0);
    await addBuild();
    await manage(page).locator('webui-button.fav-add').click();
    await expect(detail(page).locator('.fav-choice[data-block]')).toHaveCount(2);
    await expect(added).toHaveCount(0);
});
