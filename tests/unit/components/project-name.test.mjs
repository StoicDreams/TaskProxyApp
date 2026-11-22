import { test, expect, openApp, mount, calls } from '../support/app.mjs';
import { alertPopup, actionNote } from '../../support/wait.mjs';

// A project's name that renames it in place (wc/project-name.js), for any saved project, not only the open one.
const PROJECTS = [{ name: 'Repo', path: '/repo' }, { name: 'Docs', path: '/docs' }];

async function nameOf(page, project = PROJECTS[1]) {
    await openApp(page, { projects: PROJECTS });
    const root = await mount(page, `<app-project-name id="n" project="${project.path}" name="${project.name}"></app-project-name>`);
    const el = root.locator('#n');
    await expect(el.locator('.edit-text')).toHaveText(project.name);
    return el;
}
const input = el => el.locator('webui-input-text.edit-field input');
const button = (el, label) => el.locator('.edit-form webui-button', { hasText: label });

test('renaming a project that isn\'t open sends its path, and leaves the open project alone', async ({ page }) => {
    const el = await nameOf(page);
    await el.locator('.edit-text').click();
    await expect(input(el)).toHaveValue('Docs');
    await expect(input(el)).toBeFocused();
    await input(el).fill('Handbook');
    await button(el, 'Save').click();
    await expect.poll(() => calls(page, 'rename_project')).toEqual([{ path: '/docs', newName: 'Handbook' }]);
    await expect(el.locator('.edit-text')).toHaveText('Handbook');
    await expect(el.locator('.edit-form')).toBeHidden();
    await expect.poll(() => page.evaluate(() => webui.getData('app-current-project')?.display)).toBe('Repo');
});

test('a name is saved and shown without the spaces around it, as the backend saves it', async ({ page }) => {
    const el = await nameOf(page, PROJECTS[0]);
    await el.locator('.edit-text').click();
    await input(el).fill('  Main  ');
    await button(el, 'Save').click();
    await expect.poll(() => calls(page, 'rename_project')).toEqual([{ path: '/repo', newName: 'Main' }]);
    await expect(el.locator('.edit-text')).toHaveText('Main');
    await expect(el).toHaveAttribute('name', 'Main');
    await expect.poll(() => page.evaluate(() => webui.getData('app-current-project')?.display)).toBe('Main');
});

test('renaming the open project shows its new name as the current project', async ({ page }) => {
    const el = await nameOf(page, PROJECTS[0]);
    await el.locator('.edit-text').click();
    await input(el).fill('Main');
    await input(el).press('Enter');
    await expect.poll(() => page.evaluate(() => webui.getData('app-current-project')?.display)).toBe('Main');
});

test('Escape and Cancel put the name back without renaming', async ({ page }) => {
    const el = await nameOf(page);
    await el.locator('.edit-text').click();
    await input(el).fill('Typed');
    await input(el).press('Escape');
    await expect(el.locator('.edit-text')).toHaveText('Docs');
    await el.locator('.edit-text').click();
    await input(el).fill('Typed again');
    await button(el, 'Cancel').click();
    await expect(el.locator('.edit-text')).toBeFocused();
    await expect.poll(() => calls(page, 'rename_project')).toEqual([]);
});

test('a blank name is refused, and a name the backend refuses keeps the field open', async ({ page }) => {
    const el = await nameOf(page);
    await page.evaluate(() => { window.__backend.handlers.rename_project = () => { throw 'A project named Repo already exists.'; }; });
    await el.locator('.edit-text').click();
    await input(el).fill('  ');
    await button(el, 'Save').click();
    // Said by the name, not in the app's alerts.
    await expect(actionNote(page, 'Project name cannot be empty.')).toHaveCount(1);
    await expect(alertPopup(page, 'Project name cannot be empty.')).toHaveCount(0);
    await expect(input(el)).toHaveValue('  ');
    await input(el).fill('Repo');
    await button(el, 'Save').click();
    await expect(actionNote(page, 'A project named Repo already exists.')).toHaveCount(1);
    await expect(input(el)).toHaveValue('Repo');
    await expect(el.locator('.edit-text')).toHaveText('Docs');
});

test('a name is shown as written, never as markup', async ({ page }) => {
    const name = '"><img src=q onerror="window.__xss=1">';
    await openApp(page, { projects: PROJECTS });
    const root = await mount(page, '<app-project-name id="n" project="/docs"></app-project-name>');
    await page.evaluate(name => document.querySelector('#n').setAttribute('name', name), name);
    await expect(root.locator('#n .edit-text')).toHaveText(name);
    await expect(root.locator('#n img')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__xss)).toBeUndefined();
});

test('what a rename did is said after the heading the name is in, and goes when the name is for another project', async ({ page }) => {
    await openApp(page, { projects: PROJECTS });
    const root = await mount(page, '<h3 id="h">Current project: <app-project-name id="n" project="/docs" name="Docs"></app-project-name></h3>');
    const el = root.locator('#n');
    await el.locator('.edit-text').click();
    await input(el).fill('Handbook');
    await button(el, 'Save').click();
    await expect(actionNote(root, 'Project Successfully Renamed')).toHaveCount(1);
    await expect(root.locator('#h webui-alert')).toHaveCount(0);
    await expect(root.locator('#h + webui-alert.action-note')).toHaveText('Project Successfully Renamed');
    await el.locator('.edit-text').click();
    await expect(input(el)).toBeFocused();
    await page.evaluate(() => {
        const name = document.querySelector('#n');
        name.setAttribute('project', '/repo');
        name.setAttribute('name', 'Repo');
    });
    await expect(actionNote(root, 'Project Successfully Renamed')).toHaveCount(0);
    await expect(el.locator('.edit-form')).toBeHidden();
    await expect(el.locator('.edit-text')).toHaveText('Repo');
});

test('what a rename said goes when the name is taken off the page', async ({ page }) => {
    await openApp(page, { projects: PROJECTS });
    const root = await mount(page, '<div id="box"><h3 id="h">Current project: <app-project-name id="n" project="/docs" name="Docs"></app-project-name></h3></div>');
    const el = root.locator('#n');
    await el.locator('.edit-text').click();
    await input(el).fill('Handbook');
    await button(el, 'Save').click();
    await expect(actionNote(root, 'Project Successfully Renamed')).toHaveCount(1);
    await page.evaluate(() => document.querySelector('#n').remove());
    await expect(actionNote(root, 'Project Successfully Renamed')).toHaveCount(0);
});

test('a blank name\'s warning goes when the edit is cancelled', async ({ page }) => {
    const el = await nameOf(page);
    await el.locator('.edit-text').click();
    await input(el).fill('  ');
    await button(el, 'Save').click();
    await expect(actionNote(page, 'Project name cannot be empty.')).toHaveCount(1);
    await button(el, 'Cancel').click();
    await expect(el.locator('.edit-form')).toBeHidden();
    await expect(actionNote(page, 'Project name cannot be empty.')).toHaveCount(0);
});

test('a project list that can\'t be reloaded after a rename is said, and the list is kept', async ({ page }) => {
    const el = await nameOf(page);
    await expect.poll(() => page.evaluate(() => (webui.getData('app-projects') || []).length)).toBe(2);
    await page.evaluate(() => { window.__backend.handlers.get_projects = () => { throw 'The projects file is locked.'; }; });
    await el.locator('.edit-text').click();
    await input(el).fill('Handbook');
    await button(el, 'Save').click();
    await expect(actionNote(page, "The project was renamed, but the project list couldn't be reloaded: The projects file is locked.")).toHaveCount(1);
    await expect(el.locator('.edit-text')).toHaveText('Handbook');
    await expect.poll(() => page.evaluate(() => (webui.getData('app-projects') || []).length)).toBe(2);
});
