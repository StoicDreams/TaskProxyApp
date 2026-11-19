import { test, expect, openApp, mount, calls } from '../support/app.mjs';

// Settings' project list (wc/projects-report.js): every saved project as icon | name | git status, with the icon and
// name edited in place.
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
const row = (el, path) => el.locator(`tr[data-project="${path}"]`);

test('lists every project with its icon, name, and git status', async ({ page }) => {
    const el = await report(page);
    await expect(el.locator('th')).toHaveText(['Icon', 'Name', 'Git status']);
    await expect(el.locator('tbody tr app-project-name .project-name')).toHaveText(['Repo', 'Docs', 'Site']);
    await expect(row(el, '/repo').locator('.project-status-cell [title="3 changed files"]')).toHaveCount(1);
    await expect(row(el, '/docs').locator('.project-status-cell [title="2 commits ahead of the remote"]')).toHaveCount(1);
    await expect(row(el, '/docs').locator('.project-status-cell [title="1 commit behind the remote"]')).toHaveCount(1);
    await expect(row(el, '/docs').locator('.project-status-cell [title="GitHub Actions failed for the last push"]')).toHaveCount(1);
    await expect(row(el, '/site').locator('.project-status-cell')).toHaveText('Up to date');
    await expect(row(el, '/repo').locator('app-project-icon')).toHaveAttribute('project', '/repo');
});

test("clicking a project's name renames that project", async ({ page }) => {
    const el = await report(page);
    await row(el, '/site').locator('.project-name').click();
    await row(el, '/site').locator('.project-rename webui-input-text input').fill('Website');
    await row(el, '/site').locator('.project-rename webui-button', { hasText: 'Save' }).click();
    await expect.poll(() => calls(page, 'rename_project')).toEqual([{ path: '/site', newName: 'Website' }]);
    await expect(row(el, '/site').locator('.project-name')).toHaveText('Website');
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
    await row(el, '/repo').locator('.project-name').click();
    await row(el, '/repo').locator('.project-rename webui-input-text input').fill('Typing');
    await page.evaluate(() => webui.setData('app-projects', [
        { name: 'Repo', path: '/repo' }, { name: 'Docs', path: '/docs' }, { name: 'New', path: '/new' },
    ]));
    await expect(el.locator('tbody tr')).toHaveCount(3);
    await expect(row(el, '/site')).toHaveCount(0);
    await expect(row(el, '/new').locator('.project-name')).toHaveText('New');
    await expect(row(el, '/repo').locator('.project-rename webui-input-text input')).toHaveValue('Typing');
});

test('with no projects, it says so', async ({ page }) => {
    await openApp(page, { project: null, projects: [] });
    const root = await mount(page, '<app-projects-report id="r"></app-projects-report>');
    await expect(root.locator('#r').getByText('No projects yet. Add one below.')).toBeVisible();
    await expect(root.locator('#r table')).toBeHidden();
});

test('Settings shows it in the Projects tab', async ({ page }) => {
    await openApp(page, { projects: PROJECTS });
    await page.locator('webui-button.settings-tab-projects').click();
    await expect(page.locator('.settings-projects app-projects-report tbody tr')).toHaveCount(3);
});
