import { test, expect, openApp, mount, calls } from '../support/app.mjs';
import { alertPopup } from '../support/wait.mjs';

// A project's name that renames it in place (wc/project-name.js), for any saved project, not only the open one.
const PROJECTS = [{ name: 'Repo', path: '/repo' }, { name: 'Docs', path: '/docs' }];

async function nameOf(page, project = PROJECTS[1]) {
    await openApp(page, { projects: PROJECTS });
    const root = await mount(page, `<app-project-name id="n" project="${project.path}" name="${project.name}"></app-project-name>`);
    const el = root.locator('#n');
    await expect(el.locator('.project-name')).toHaveText(project.name);
    return el;
}
const input = el => el.locator('.project-rename webui-input-text input');
const button = (el, label) => el.locator('.project-rename webui-button', { hasText: label });

test('renaming a project that isn\'t open sends its path, and leaves the open project alone', async ({ page }) => {
    const el = await nameOf(page);
    await el.locator('.project-name').click();
    await expect(input(el)).toHaveValue('Docs');
    await expect(input(el)).toBeFocused();
    await input(el).fill('Handbook');
    await button(el, 'Save').click();
    await expect.poll(() => calls(page, 'rename_project')).toEqual([{ path: '/docs', newName: 'Handbook' }]);
    await expect(el.locator('.project-name')).toHaveText('Handbook');
    await expect(el.locator('.project-rename')).toBeHidden();
    await expect.poll(() => page.evaluate(() => webui.getData('app-current-project')?.display)).toBe('Repo');
});

test('renaming the open project shows its new name as the current project', async ({ page }) => {
    const el = await nameOf(page, PROJECTS[0]);
    await el.locator('.project-name').click();
    await input(el).fill('Main');
    await input(el).press('Enter');
    await expect.poll(() => page.evaluate(() => webui.getData('app-current-project')?.display)).toBe('Main');
});

test('Escape and Cancel put the name back without renaming', async ({ page }) => {
    const el = await nameOf(page);
    await el.locator('.project-name').click();
    await input(el).fill('Typed');
    await input(el).press('Escape');
    await expect(el.locator('.project-name')).toHaveText('Docs');
    await el.locator('.project-name').click();
    await input(el).fill('Typed again');
    await button(el, 'Cancel').click();
    await expect(el.locator('.project-name')).toBeFocused();
    await expect.poll(() => calls(page, 'rename_project')).toEqual([]);
});

test('a blank name is refused, and a name the backend refuses keeps the field open', async ({ page }) => {
    const el = await nameOf(page);
    await page.evaluate(() => { window.__backend.handlers.rename_project = () => { throw 'A project named Repo already exists.'; }; });
    await el.locator('.project-name').click();
    await input(el).fill('  ');
    await button(el, 'Save').click();
    await expect(alertPopup(page, 'Project name cannot be empty.')).toHaveCount(1);
    await input(el).fill('Repo');
    await button(el, 'Save').click();
    await expect(alertPopup(page, 'A project named Repo already exists.')).toHaveCount(1);
    await expect(input(el)).toHaveValue('Repo');
    await expect(el.locator('.project-name')).toHaveText('Docs');
});

test('a name is shown as written, never as markup', async ({ page }) => {
    const name = '"><img src=q onerror="window.__xss=1">';
    await openApp(page, { projects: PROJECTS });
    const root = await mount(page, '<app-project-name id="n" project="/docs"></app-project-name>');
    await page.evaluate(name => document.querySelector('#n').setAttribute('name', name), name);
    await expect(root.locator('#n .project-name')).toHaveText(name);
    await expect(root.locator('#n img')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__xss)).toBeUndefined();
});
