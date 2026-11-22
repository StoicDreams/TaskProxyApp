import { test, expect, openApp, calls, openDialog } from '../support/app.mjs';
import { spyOnAlerts, alerts } from '../../support/wait.mjs';

const projects = [{ name: 'One', path: '/one' }, { name: 'Two', path: '/two' }];

test('lists projects and shows the current one', async ({ page }) => {
    await openApp(page, { project: projects[1], projects });
    await expect.poll(() => page.locator('app-project-dropdown webui-select').evaluate(el => el.value)).toBe('/two');
});
test('is hidden with no projects', async ({ page }) => {
    await openApp(page, { project: null, projects: [] });
    await expect(page.locator('app-project-dropdown')).toBeHidden();
});
test('opens the first project when none is current', async ({ page }) => {
    await openApp(page, { project: null, projects });
    await expect.poll(() => page.evaluate(() => webui.getData('app-current-project')?.value)).toBe('/one');
});
test('a saved current project that is no longer listed is replaced with the first listed one', async ({ page }) => {
    // As left after a project was removed and another added for the same repo, whose .git moved to the drive's root.
    const listed = [{ name: 'Backup', path: 'C:/' }, { name: 'Two', path: '/two' }];
    await openApp(page, { project: null, projects: listed, appData: { 'app-current-project': { value: 'C:/Backup', display: 'Backup' } } });
    await expect.poll(() => page.evaluate(() => webui.getData('app-current-project'))).toEqual({ value: 'C:/', display: 'Backup' });
    await expect.poll(() => page.evaluate(() => window.__backend.appData.data['app-current-project'])).toEqual({ value: 'C:/', display: 'Backup' });
    await expect.poll(async () => (await calls(page, 'get_project_data')).at(-1)?.project.path).toBe('C:/');
});
test('a saved current project is kept when its path is listed with other slashes or case', async ({ page }) => {
    await openApp(page, { project: null, projects, appData: { 'app-current-project': { value: '\\TWO', display: 'Two' } } });
    await expect.poll(() => page.locator('app-project-dropdown webui-select').evaluate(el => el.value)).toBe('/two');
    await expect.poll(() => page.evaluate(() => webui.getData('app-current-project'))).toEqual({ value: '\\TWO', display: 'Two' });
});
test('a saved current project with no projects listed at all is closed', async ({ page }) => {
    await openApp(page, { project: null, projects: [], appData: { 'app-current-project': { value: 'C:/Backup', display: 'Backup' } } });
    await expect.poll(() => page.evaluate(() => window.__backend.appData.data)).not.toHaveProperty('app-current-project');
    await expect.poll(async () => (await calls(page, 'clear_current_project')).length).toBeGreaterThan(0);
});
test('removing the last project clears the current project, so the app does not reopen it', async ({ page }) => {
    await openApp(page, { project: projects[0], projects: [projects[0]] });
    await expect.poll(() => page.evaluate(() => window.__backend.appData.data['app-current-project']?.value)).toBe('/one');
    await page.evaluate(async () => {
        await webui.proxy.removeProject('/one');
        webui.setData('app-current-project', null);
    });
    await expect.poll(() => page.evaluate(() => window.__backend.appData.data)).not.toHaveProperty('app-current-project');
    await expect(page.locator('app-project-dropdown')).toBeHidden();
});

test.describe('changed files and commits', () => {
    const dropdown = page => page.locator('app-project-dropdown webui-select');
    // The projects are tiles in the select's dialog, which is opened from the field.
    const openList = async page => {
        await expect(dropdown(page).locator('.picked .pick-name')).not.toHaveText('');
        await dropdown(page).locator('button').click();
        await expect(dropdown(page).locator('[role="option"]').first()).toBeVisible();
    };
    const option = (page, name) => dropdown(page).locator('[role="option"]')
        .filter({ has: page.locator('.name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
    const counts = { '/one': { changes: 3 }, '/two': {} };

    test('a project with changed files shows an icon and how many', async ({ page }) => {
        await openApp(page, { project: projects[1], projects, gitStatus: counts });
        await openList(page);
        await expect(option(page, 'One').locator('.git-changes webui-icon')).toHaveAttribute('count', '3');
        await expect(option(page, 'One').locator('.git-changes')).toHaveAttribute('title', '3 changed files');
        await expect(option(page, 'One').locator('webui-icon[icon="code-commit"]')).toHaveCount(1);
        await expect(option(page, 'Two').locator('.git-changes')).toHaveCount(0);
        await expect(option(page, 'Two').locator('.git-status')).toHaveCount(0);
    });
    test('the current project shows its count in the picker too', async ({ page }) => {
        await openApp(page, { project: projects[0], projects, gitStatus: { '/one': { changes: 1 } } });
        const picked = dropdown(page).locator('.picked .git-changes');
        await expect(picked.locator('webui-icon')).toHaveAttribute('count', '1');
        await expect(picked).toHaveAttribute('title', '1 changed file');
    });
    test('a project name is shown as text, not markup', async ({ page }) => {
        const odd = [{ name: '<img src=x onerror="window.__xss=1">Odd', path: '/odd' }];
        await openApp(page, { project: odd[0], projects: odd, gitStatus: { '/odd': { changes: 2 } } });
        await openList(page);
        await expect(dropdown(page).locator('[role="option"] .name')).toHaveText(odd[0].name);
        await expect(dropdown(page).locator('img')).toHaveCount(0);
        await expect(dropdown(page).locator('.panel img')).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => window.__xss)).toBeUndefined();
    });
    test('each project shows the result of the CI runs for its last push', async ({ page }) => {
        const ciStatus = {
            '/one': { state: 'failure', service: 'GitHub Actions', url: 'https://github.com/o/one/actions/runs/1' },
            '/two': { state: 'running', service: 'GitHub Actions', url: '' },
        };
        await openApp(page, { project: projects[1], projects, gitStatus: counts, ciStatus });
        await openList(page);
        const failed = option(page, 'One').locator('.git-ci-failure');
        await expect(failed).toHaveAttribute('title', 'GitHub Actions failed for the last push');
        await expect(failed.locator('webui-icon')).toHaveAttribute('icon', 'xmark');
        await expect(failed.locator('webui-icon')).toHaveAttribute('theme', 'danger');
        // The CI icon comes first, and the counts still show.
        await expect(option(page, 'One').locator('.git-status > span').first()).toHaveClass(/git-ci/);
        await expect(option(page, 'One').locator('.git-changes webui-icon')).toHaveAttribute('count', '3');
        await expect(option(page, 'Two').locator('.git-ci-running webui-icon')).toHaveAttribute('theme', 'info');
        await page.evaluate(() => {
            window.__backend.handlers.get_project_ci_status = () => ({ '/one': { state: 'success', service: 'GitHub Actions', url: '' } });
            document.dispatchEvent(new CustomEvent('app-git-changes'));
        });
        await expect(option(page, 'One').locator('.git-ci-success webui-icon')).toHaveAttribute('theme', 'success');
        await expect(option(page, 'Two').locator('.git-ci')).toHaveCount(0);
        await expect(option(page, 'Two').locator('.git-status')).toHaveCount(0);
    });
    test('a project with no CI result shows no CI icon', async ({ page }) => {
        await openApp(page, { project: projects[1], projects, gitStatus: counts, ciStatus: { '/one': { state: 'unknown' } } });
        await openList(page);
        await expect(option(page, 'One').locator('.git-changes webui-icon')).toHaveAttribute('count', '3');
        await expect.poll(async () => (await calls(page, 'get_project_ci_status')).length).toBeGreaterThan(0);
        await expect(dropdown(page).locator('.git-ci')).toHaveCount(0);
    });
    test('counts update when the Git Controller loads changes', async ({ page }) => {
        await openApp(page, { project: projects[1], projects, gitStatus: counts });
        await openList(page);
        await expect(option(page, 'One').locator('.git-changes webui-icon')).toHaveAttribute('count', '3');
        await page.evaluate(() => {
            window.__backend.handlers.get_project_git_status = () => ({ '/one': { changes: 0, ahead: 0, behind: 0 }, '/two': { changes: 5, ahead: 0, behind: 0 } });
            document.dispatchEvent(new CustomEvent('app-git-changes'));
        });
        await expect(option(page, 'Two').locator('.git-changes webui-icon')).toHaveAttribute('count', '5');
        await expect(option(page, 'One').locator('.git-changes')).toHaveCount(0);
    });
    test('choosing a project from the list opens it, and stores only its name and path', async ({ page }) => {
        await openApp(page, { project: projects[1], projects, gitStatus: counts });
        await openList(page);
        await expect(option(page, 'One').locator('.git-changes webui-icon')).toHaveAttribute('count', '3');
        await option(page, 'One').click();
        await expect.poll(() => page.evaluate(() => webui.projectData.path)).toBe('/one');
        await expect.poll(() => page.evaluate(() => webui.getData('app-current-project').display)).toBe('One');
    });
    test('commits behind and ahead of the remote show their own icon and number', async ({ page }) => {
        await openApp(page, { project: projects[1], projects, gitStatus: { '/one': { changes: 2, behind: 4, ahead: 1 }, '/two': { ahead: 3 } } });
        await openList(page);
        const one = option(page, 'One');
        await expect(one.locator('.git-behind webui-icon')).toHaveAttribute('count', '4');
        await expect(one.locator('.git-behind')).toHaveAttribute('title', '4 commits behind the remote');
        await expect(one.locator('.git-behind webui-icon[icon="download"]')).toHaveCount(1);
        await expect(one.locator('.git-ahead webui-icon')).toHaveAttribute('count', '1');
        await expect(one.locator('.git-ahead')).toHaveAttribute('title', '1 commit ahead of the remote');
        await expect(one.locator('.git-ahead webui-icon[icon="upload"]')).toHaveCount(1);
        // Changed files come first, then behind, then ahead.
        await expect.poll(() => one.locator('.git-status > span').evaluateAll(els => els.map(el => el.className))).toEqual(['git-changes', 'git-behind', 'git-ahead']);
        const two = option(page, 'Two');
        await expect(two.locator('.git-ahead webui-icon')).toHaveAttribute('count', '3');
        await expect(two.locator('.git-changes, .git-behind')).toHaveCount(0);
    });
    test('each kind shows its own icon with its own number', async ({ page }) => {
        await openApp(page, { project: projects[1], projects, gitStatus: { '/one': { changes: 2, behind: 4, ahead: 1 } } });
        await openList(page);
        const one = option(page, 'One');
        await expect(one.locator('.git-changes webui-icon')).toHaveAttribute('count', '2');
        await expect(one.locator('.git-behind webui-icon')).toHaveAttribute('count', '4');
        await expect(one.locator('.git-ahead webui-icon')).toHaveAttribute('count', '1');
        // Three kinds, three different icons. Their colors are checked by eye.
        const icons = await one.locator('.git-status webui-icon').evaluateAll(els => els.map(el => el.getAttribute('icon')));
        expect(new Set(icons).size).toBe(3);
    });
    test('the open project\'s counts are for the repo chosen in its Git Controller', async ({ page }) => {
        await openApp(page, { project: projects[1], projects, gitStatus: counts, data: { selectedGitRepo: 'libs/second' } });
        const requests = () => calls(page, 'get_project_git_status');
        await expect.poll(requests).toContainEqual({ currentRepo: 'libs/second' });
        // Choosing another repo is sent straight away, before it is synced to the backend.
        await page.evaluate(() => {
            webui.setProjectData('selectedGitRepo', 'third');
            document.dispatchEvent(new CustomEvent('app-git-changes'));
        });
        await expect.poll(requests).toContainEqual({ currentRepo: 'third' });
    });
    test('with no repo chosen, the backend picks the first repo', async ({ page }) => {
        await openApp(page, { project: projects[1], projects, gitStatus: counts });
        await openList(page);
        await expect(option(page, 'One').locator('.git-changes webui-icon')).toHaveAttribute('count', '3');
        const requests = await calls(page, 'get_project_git_status');
        expect(requests.length).toBeGreaterThan(0);
        expect(requests.filter(request => 'currentRepo' in request)).toEqual([]);
    });
    test('every project is fetched when the app starts, and the counts are loaded again after', async ({ page }) => {
        await openApp(page, { project: projects[1], projects, gitStatus: counts });
        await expect.poll(async () => (await calls(page, 'fetch_project_remotes')).length).toBe(1);
        await expect.poll(async () => (await calls(page, 'get_project_git_status')).length).toBeGreaterThanOrEqual(2);
    });
    test('a failed fetch is quiet', async ({ page }) => {
        await openApp(page, { project: projects[0], projects, gitStatus: counts });
        await spyOnAlerts(page);
        await page.evaluate(() => {
            window.__backend.handlers.fetch_project_remotes = () => { throw 'Credentials Missing/Invalid'; };
        });
        await page.locator('app-project-dropdown').evaluate(el => el.fetchRemotes());
        await expect(dropdown(page).locator('.picked .git-changes webui-icon')).toHaveAttribute('count', '3');
        await expect.poll(() => alerts(page)).toEqual([]);
        await expect(openDialog(page)).toHaveCount(0);
    });
});
