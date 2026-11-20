import { test, expect, openApp, openPage, calls, dialogButton, openDialog } from '../../support/app.mjs';
import { alertPopup } from '../../support/wait.mjs';

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

test('icons are put in order by dragging, which runs nothing, or with Alt+arrows, and the order is saved', async ({ page }) => {
    await openApp(page, state([favorite('a'), favorite('b'), favorite('hidden', { projects: ['/other'] }), favorite('c')]));
    await expect(icons(page)).toHaveCount(3);
    const from = await icons(page).nth(0).boundingBox();
    const to = await icons(page).nth(2).boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2, { steps: 3 });
    await page.mouse.move(to.x + to.width - 2, to.y + to.height - 1, { steps: 6 });
    await page.mouse.up();
    // A favorite that does not show here keeps its place among the others.
    await expect.poll(async () => ((await saved(page)) || []).map(item => item.id)).toEqual(['b', 'c', 'hidden', 'a']);
    await page.locator('app-favorites .fav-icon[data-id="c"]').focus();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect.poll(async () => ((await saved(page)) || []).map(item => item.id)).toEqual(['c', 'b', 'hidden', 'a']);
    expect(await calls(page, 'run_favorite')).toEqual([]);
});

test('more icons than fit show an ellipsis, which shows them all and then one row again', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 800 });
    await openApp(page, state(Array.from({ length: 30 }, (_, i) => favorite(`f${i}`))));
    const more = bar(page).getByRole('button', { name: 'Show every favorite' });
    await expect(more).toBeVisible();
    await more.click();
    await expect(page.locator('app-favorites')).toHaveAttribute('mode', 'all');
    await expect(icons(page).last()).toBeInViewport();
    await bar(page).getByRole('button', { name: 'Show one row' }).click();
    await expect(page.locator('app-favorites')).toHaveAttribute('mode', 'bar');
});

