import { test, expect, openApp, mount, calls } from '../support/app.mjs';

// Settings' project list (wc/projects-report.js): every saved project as a tile of its icon, name, folder, and git
// status, with the icon and name edited in place, and a field to find one.
const PROJECTS = [{ name: 'Repo', path: '/repo' }, { name: 'Docs', path: '/docs' }, { name: 'Site', path: '/site' }];
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function report(page, state = {}) {
    await openApp(page, {
        projects: PROJECTS,
        gitStatus: { '/repo': { changes: 3 }, '/docs': { ahead: 2, behind: 1 }, '/site': {} },
        ciStatus: { '/docs': { state: 'failure', service: 'GitHub Actions' } },
        projectImagesByPath: { '/docs': ['img/docs.png'] },
        binaryFiles: { 'img/docs.png': PNG },
        ...state,
    });
    const root = await mount(page, '<app-projects-report id="r"></app-projects-report>');
    return root.locator('#r');
}
const row = (el, path) => el.locator(`.project-tile[data-project="${path}"]`);
const tiles = el => el.locator('.project-tile');
const find = el => el.locator('webui-tiles .find input');

test('lists every project with its icon, name, folder, and git status', async ({ page }) => {
    const el = await report(page);
    await expect(el.getByRole('listitem')).toHaveCount(3);
    await expect(tiles(el).locator('app-project-name .edit-text')).toHaveText(['Repo', 'Docs', 'Site']);
    await expect(tiles(el).locator('.project-tile-path')).toHaveText(['/repo', '/docs', '/site']);
    await expect(el.locator('webui-tiles .count')).toHaveText('3 projects');
    await expect(row(el, '/repo').locator('.project-status-cell [title="3 changed files"]')).toHaveCount(1);
    await expect(row(el, '/docs').locator('.project-status-cell [title="2 commits ahead of the remote"]')).toHaveCount(1);
    await expect(row(el, '/docs').locator('.project-status-cell [title="1 commit behind the remote"]')).toHaveCount(1);
    await expect(row(el, '/docs').locator('.project-status-cell [title="GitHub Actions failed for the last push"]')).toHaveCount(1);
    await expect(row(el, '/site').locator('.project-status-cell')).toHaveText('Up to date');
    await expect(row(el, '/repo').locator('app-project-icon')).toHaveAttribute('project', '/repo');
});

test("clicking a project's name renames that project", async ({ page }) => {
    const el = await report(page);
    await row(el, '/site').locator('.edit-text').click();
    await row(el, '/site').locator('webui-input-text.edit-field input').fill('Website');
    await row(el, '/site').locator('.edit-form webui-button', { hasText: 'Save' }).click();
    await expect.poll(() => calls(page, 'rename_project')).toEqual([{ path: '/site', newName: 'Website' }]);
    await expect(row(el, '/site').locator('.edit-text')).toHaveText('Website');
});

test("choosing a project's icon saves it to that project, from its own images", async ({ page }) => {
    const el = await report(page);
    const picker = row(el, '/docs').locator('app-project-icon webui-select');
    await picker.getByRole('button').click();
    const tile = picker.getByRole('option', { name: 'docs.png', exact: true });
    // A project that isn't open shows its images through the file server's address for other projects.
    await expect(tile.locator('img')).toHaveAttribute('src', 'http://files.localhost/token/~project/%2Fdocs/img%2Fdocs.png');
    await tile.click();
    await expect.poll(() => calls(page, 'set_project_icon')).toEqual([{ icon: 'img/docs.png', project: '/docs' }]);
});

test('a project added or removed shows in the list, and a rename in progress elsewhere is kept', async ({ page }) => {
    const el = await report(page);
    await row(el, '/repo').locator('.edit-text').click();
    await row(el, '/repo').locator('webui-input-text.edit-field input').fill('Typing');
    await page.evaluate(() => webui.setData('app-projects', [
        { name: 'Repo', path: '/repo' }, { name: 'Docs', path: '/docs' }, { name: 'New', path: '/new' },
    ]));
    await expect(tiles(el)).toHaveCount(3);
    await expect(row(el, '/site')).toHaveCount(0);
    await expect(row(el, '/new').locator('.edit-text')).toHaveText('New');
    await expect(row(el, '/repo').locator('webui-input-text.edit-field input')).toHaveValue('Typing');
});

test('with no projects, it says so', async ({ page }) => {
    await openApp(page, { project: null, projects: [] });
    const root = await mount(page, '<app-projects-report id="r"></app-projects-report>');
    await expect(root.locator('#r').getByText('No projects yet. Add one below.')).toBeVisible();
    await expect(root.locator('#r webui-tiles')).toBeHidden();
    await expect(root.locator('#r .project-tile')).toHaveCount(0);
});

test('Settings shows it in the Projects tab', async ({ page }) => {
    await openApp(page, { projects: PROJECTS });
    await page.locator('webui-button.settings-tab-projects').click();
    await expect(page.locator('.settings-projects app-projects-report .project-tile')).toHaveCount(3);
});

test('typing finds projects by any part of their name or folder, ignoring case, and says how many match', async ({ page }) => {
    const el = await report(page, { projects: [...PROJECTS, { name: 'Api', path: '/work/apis/api' }, { name: 'Databases', path: '/work/apis/databases' }] });
    await find(el).fill('APIS');
    await expect(tiles(el).filter({ visible: true }).locator('.edit-text')).toHaveText(['Api', 'Databases']);
    await expect(el.locator('webui-tiles .count')).toHaveText('2 of 5 projects');
    await find(el).fill('do');
    await expect(tiles(el).filter({ visible: true }).locator('.edit-text')).toHaveText(['Docs']);
    await find(el).fill('nothing like it');
    await expect(tiles(el).filter({ visible: true })).toHaveCount(0);
    await expect(el.getByText('No project matches that.')).toBeVisible();
    await find(el).fill('');
    await expect(tiles(el).filter({ visible: true })).toHaveCount(5);
    await expect(el.getByText('No project matches that.')).toBeHidden();
    await expect(el.locator('webui-tiles .count')).toHaveText('5 projects');
});

test('a renamed project is found by its new name', async ({ page }) => {
    const el = await report(page);
    await row(el, '/site').locator('.edit-text').click();
    await row(el, '/site').locator('webui-input-text.edit-field input').fill('Website');
    await row(el, '/site').locator('.edit-form webui-button', { hasText: 'Save' }).click();
    await expect.poll(() => calls(page, 'rename_project')).toHaveLength(1);
    await page.evaluate(() => webui.setData('app-projects', [
        { name: 'Repo', path: '/repo' }, { name: 'Docs', path: '/docs' }, { name: 'Website', path: '/site' },
    ]));
    await find(el).fill('website');
    await expect(tiles(el).filter({ visible: true }).locator('.edit-text')).toHaveText(['Website']);
});

test('the open project is marked, and the mark moves when another opens', async ({ page }) => {
    const el = await report(page);
    await expect(row(el, '/repo')).toHaveAttribute('aria-current', 'true');
    await expect(el.locator('[aria-current]')).toHaveCount(1);
    await page.evaluate(() => webui.setData('app-current-project', { value: '/docs', display: 'Docs' }));
    await expect(row(el, '/docs')).toHaveAttribute('aria-current', 'true');
    await expect(row(el, '/repo')).not.toHaveAttribute('aria-current');
});
