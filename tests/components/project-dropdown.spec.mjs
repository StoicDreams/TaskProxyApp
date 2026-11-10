import { test, expect, openApp, calls } from '../support/app.mjs';

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

test.describe('changed files and commits', () => {
    const dropdown = page => page.locator('app-project-dropdown webui-dropdown');
    const option = (page, name) => dropdown(page).locator('[role="option"]').filter({ hasText: name });
    const counts = { '/one': { changes: 3 }, '/two': {} };

    test('a project with changed files shows an icon and how many', async ({ page }) => {
        await openApp(page, { project: projects[1], projects, gitStatus: counts });
        await expect(option(page, 'One').locator('.project-changes')).toHaveText('3');
        await expect(option(page, 'One').locator('.project-changes')).toHaveAttribute('title', '3 changed files');
        await expect(option(page, 'One').locator('webui-icon[icon="code-commit"]')).toHaveCount(1);
        await expect(option(page, 'Two').locator('.project-changes')).toHaveCount(0);
        await expect(option(page, 'Two')).toHaveText('Two');
    });
    test('the current project shows its count in the picker too', async ({ page }) => {
        await openApp(page, { project: projects[0], projects, gitStatus: { '/one': { changes: 1 } } });
        const picked = dropdown(page).locator('button .project-changes');
        await expect(picked).toHaveText('1');
        await expect(picked).toHaveAttribute('title', '1 changed file');
    });
    test('a project name is shown as text, not markup', async ({ page }) => {
        const odd = [{ name: '<img src=x onerror="window.__xss=1">Odd', path: '/odd' }];
        await openApp(page, { project: odd[0], projects: odd, gitStatus: { '/odd': { changes: 2 } } });
        await expect(option(page, 'Odd')).toContainText('<img src=x');
        await expect(dropdown(page).locator('img')).toHaveCount(0);
        expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    });
    test('counts update when the Git Controller loads changes', async ({ page }) => {
        await openApp(page, { project: projects[1], projects, gitStatus: counts });
        await expect(option(page, 'One').locator('.project-changes')).toHaveText('3');
        await page.evaluate(() => {
            window.__backend.handlers.get_project_git_status = () => ({ '/one': { changes: 0, ahead: 0, behind: 0 }, '/two': { changes: 5, ahead: 0, behind: 0 } });
            document.dispatchEvent(new CustomEvent('app-git-changes'));
        });
        await expect(option(page, 'Two').locator('.project-changes')).toHaveText('5');
        await expect(option(page, 'One').locator('.project-changes')).toHaveCount(0);
    });
    test('choosing a project from the list opens it, and stores only its name and path', async ({ page }) => {
        await openApp(page, { project: projects[1], projects, gitStatus: counts });
        await expect(option(page, 'One').locator('.project-changes')).toHaveText('3');
        await dropdown(page).locator('button').click();
        await option(page, 'One').click();
        await expect.poll(() => page.evaluate(() => webui.projectData.path)).toBe('/one');
        expect(await page.evaluate(() => webui.getData('app-current-project').display)).toBe('One');
    });
    test('commits behind and ahead of the remote show their own icon and number', async ({ page }) => {
        await openApp(page, { project: projects[1], projects, gitStatus: { '/one': { changes: 2, behind: 4, ahead: 1 }, '/two': { ahead: 3 } } });
        const one = option(page, 'One');
        await expect(one.locator('.project-behind')).toHaveText('4');
        await expect(one.locator('.project-behind')).toHaveAttribute('title', '4 commits behind the remote');
        await expect(one.locator('.project-behind webui-icon[icon="download"]')).toHaveCount(1);
        await expect(one.locator('.project-ahead')).toHaveText('1');
        await expect(one.locator('.project-ahead')).toHaveAttribute('title', '1 commit ahead of the remote');
        await expect(one.locator('.project-ahead webui-icon[icon="upload"]')).toHaveCount(1);
        // Changed files come first, then behind, then ahead.
        expect(await one.locator('.project-status > span').evaluateAll(els => els.map(el => el.className))).toEqual(['project-changes', 'project-behind', 'project-ahead']);
        const two = option(page, 'Two');
        await expect(two.locator('.project-ahead')).toHaveText('3');
        await expect(two.locator('.project-changes, .project-behind')).toHaveCount(0);
    });
    test('each kind has its own color, and its number matches its icon', async ({ page }) => {
        await openApp(page, { project: projects[1], projects, gitStatus: { '/one': { changes: 2, behind: 4, ahead: 1 } } });
        await expect(option(page, 'One').locator('.project-ahead')).toHaveText('1');
        const colors = await option(page, 'One').locator('.project-status > span').evaluateAll(els => els.map(el => {
            const icon = el.querySelector('webui-icon');
            // The icon draws with its theme color, so resolve that color the same way.
            const probe = document.createElement('span');
            probe.style.color = getComputedStyle(icon).getPropertyValue('--theme-color-offset');
            document.body.appendChild(probe);
            const iconColor = getComputedStyle(probe).color;
            probe.remove();
            return { text: getComputedStyle(el).color, icon: iconColor };
        }));
        for (const color of colors) expect(color.text).toBe(color.icon);
        expect(new Set(colors.map(color => color.text)).size).toBe(3);
    });
    test('every project is fetched when the app starts, and the counts are loaded again after', async ({ page }) => {
        await openApp(page, { project: projects[1], projects, gitStatus: counts });
        await expect.poll(async () => (await calls(page, 'fetch_project_remotes')).length).toBe(1);
        await expect.poll(async () => (await calls(page, 'get_project_git_status')).length).toBeGreaterThanOrEqual(2);
    });
    test('a failed fetch is quiet', async ({ page }) => {
        await openApp(page, { project: projects[1], projects, gitStatus: counts });
        await page.evaluate(() => {
            window.__alerts = [];
            const original = webui.alert;
            webui.alert = function (...args) { window.__alerts.push(args); return original.apply(this, args); };
            window.__backend.handlers.fetch_project_remotes = () => { throw 'Credentials Missing/Invalid'; };
        });
        await page.locator('app-project-dropdown').evaluate(el => el.fetchRemotes());
        await expect(option(page, 'One').locator('.project-changes')).toHaveText('3');
        expect(await page.evaluate(() => window.__alerts)).toEqual([]);
        await expect(page.locator('dialog[open]')).toHaveCount(0);
    });
});
