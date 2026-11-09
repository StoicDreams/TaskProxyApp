import { test, expect, openApp } from '../support/app.mjs';

const projects = [{ name: 'One', path: '/one' }, { name: 'Two', path: '/two' }];

test('lists projects and shows the current one', async ({ page }) => {
    await openApp(page, { project: projects[1], projects });
    await expect.poll(() => page.locator('app-project-dropdown webui-dropdown').evaluate(el => el.value)).toBe('/two');
});
test('is hidden with no projects', async ({ page }) => {
    await openApp(page, { project: null, projects: [] });
    await expect(page.locator('app-project-dropdown')).toBeHidden();
});
test('opens the first project when none is current', async ({ page }) => {
    await openApp(page, { project: null, projects });
    await expect.poll(() => page.evaluate(() => webui.getData('app-current-project')?.value)).toBe('/one');
});

test.describe('changed files', () => {
    const dropdown = page => page.locator('app-project-dropdown webui-dropdown');
    const option = (page, name) => dropdown(page).locator('[role="option"]').filter({ hasText: name });
    const counts = { '/one': 3, '/two': 0 };

    test('a project with changed files shows an icon and how many', async ({ page }) => {
        await openApp(page, { project: projects[1], projects, changeCounts: counts });
        await expect(option(page, 'One').locator('.project-changes')).toHaveText('3');
        await expect(option(page, 'One').locator('.project-changes')).toHaveAttribute('title', '3 changed files');
        await expect(option(page, 'One').locator('webui-icon[icon="code-commit"]')).toHaveCount(1);
        await expect(option(page, 'Two').locator('.project-changes')).toHaveCount(0);
        await expect(option(page, 'Two')).toHaveText('Two');
    });
    test('the current project shows its count in the picker too', async ({ page }) => {
        await openApp(page, { project: projects[0], projects, changeCounts: { '/one': 1 } });
        const picked = dropdown(page).locator('button .project-changes');
        await expect(picked).toHaveText('1');
        await expect(picked).toHaveAttribute('title', '1 changed file');
    });
    test('a project name is shown as text, not markup', async ({ page }) => {
        const odd = [{ name: '<img src=x onerror="window.__xss=1">Odd', path: '/odd' }];
        await openApp(page, { project: odd[0], projects: odd, changeCounts: { '/odd': 2 } });
        await expect(option(page, 'Odd')).toContainText('<img src=x');
        await expect(dropdown(page).locator('img')).toHaveCount(0);
        expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    });
    test('counts update when the Git Controller loads changes', async ({ page }) => {
        await openApp(page, { project: projects[1], projects, changeCounts: counts });
        await expect(option(page, 'One').locator('.project-changes')).toHaveText('3');
        await page.evaluate(() => {
            window.__backend.handlers.get_project_change_counts = () => ({ '/one': 0, '/two': 5 });
            document.dispatchEvent(new CustomEvent('app-git-changes'));
        });
        await expect(option(page, 'Two').locator('.project-changes')).toHaveText('5');
        await expect(option(page, 'One').locator('.project-changes')).toHaveCount(0);
    });
    test('choosing a project from the list opens it, and stores only its name and path', async ({ page }) => {
        await openApp(page, { project: projects[1], projects, changeCounts: counts });
        await expect(option(page, 'One').locator('.project-changes')).toHaveText('3');
        await dropdown(page).locator('button').click();
        await option(page, 'One').click();
        await expect.poll(() => page.evaluate(() => webui.projectData.path)).toBe('/one');
        expect(await page.evaluate(() => webui.getData('app-current-project').display)).toBe('One');
    });
});
