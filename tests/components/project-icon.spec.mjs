import { test, expect, openApp, calls } from '../support/app.mjs';

// The open project's icon in Settings (wc/project-icon.js), saved in its .taskproxy/Project.json by Rust
// (services/project_icons.rs). The mock backend keeps icons in projectIcons and the project's images in projectImages.
const IMAGES = ['assets/logo.svg', 'img/banner.png', 'docs/logo.svg'];
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';
// The images, served by the mock's file server, so the tiles can show them.
const imageFiles = { files: { 'assets/logo.svg': SVG, 'docs/logo.svg': SVG }, binaryFiles: { 'img/banner.png': PNG } };
const picker = page => page.locator('app-project-icon webui-select');
const tile = (page, name) => picker(page).getByRole('option', { name, exact: true });
const names = page => picker(page).locator('.tile .name');
// The open project's icon, as the dropdown shows it in its picked value.
const dropdownIcon = (page, path) => page.locator('app-project-dropdown webui-select .picked').locator(`img[src*="${encodeURIComponent(`data-path="${path}"`)}"]`);

test("Settings lists the project's images to choose its icon from, with the one it uses chosen", async ({ page }) => {
    await openApp(page, { ...imageFiles, projectImages: IMAGES, projectIcons: { '/repo': 'img/banner.png' } });
    await expect(picker(page).locator('.pick-name')).toHaveText(['banner.png']);
    await picker(page).getByRole('button').click();
    // Images that share a name are told apart by their path.
    await expect(names(page)).toHaveText(['No icon', 'assets/logo.svg', 'banner.png', 'docs/logo.svg']);
    await expect(tile(page, 'banner.png')).toHaveAttribute('aria-selected', 'true');
    // Each tile shows its image, from the project's files.
    await expect(tile(page, 'banner.png').locator('img')).toHaveAttribute('src', 'http://files.localhost/token/img%2Fbanner.png');
});

test("choosing an image saves it as the project's icon, and the project dropdown shows it", async ({ page }) => {
    await openApp(page, { ...imageFiles, projectImages: IMAGES });
    await expect(picker(page).locator('.pick-name')).toHaveText(['No icon']);
    await expect(dropdownIcon(page, 'assets/logo.svg')).toHaveCount(0);
    await picker(page).getByRole('button').click();
    await tile(page, 'assets/logo.svg').click();
    await expect.poll(() => calls(page, 'set_project_icon')).toEqual([{ icon: 'assets/logo.svg' }]);
    await expect(picker(page).locator('.pick-name')).toHaveText(['assets/logo.svg']);
    await expect(dropdownIcon(page, 'assets/logo.svg')).toHaveCount(1);
});

test('No icon clears it', async ({ page }) => {
    await openApp(page, { ...imageFiles, projectImages: IMAGES, projectIcons: { '/repo': 'img/banner.png' } });
    await expect(dropdownIcon(page, 'img/banner.png')).toHaveCount(1);
    await picker(page).getByRole('button').click();
    await tile(page, 'No icon').click();
    await expect.poll(() => calls(page, 'set_project_icon')).toEqual([{ icon: null }]);
    await expect(dropdownIcon(page, 'img/banner.png')).toHaveCount(0);
});

test('a refused icon says why, and the field goes back to the icon in use', async ({ page }) => {
    await openApp(page, { ...imageFiles, projectImages: IMAGES, projectIcons: { '/repo': 'img/banner.png' } });
    await page.evaluate(() => {
        window.__backend.handlers.set_project_icon = () => { throw "'docs/logo.svg' is too large for an icon. Choose an image under 512 KB."; };
        window.__alerts = [];
        const alert = webui.alert;
        webui.alert = (...args) => { window.__alerts.push(`${args[0]}`); return alert(...args); };
    });
    await picker(page).getByRole('button').click();
    await tile(page, 'docs/logo.svg').click();
    await expect.poll(() => page.evaluate(() => window.__alerts)).toContain("'docs/logo.svg' is too large for an icon. Choose an image under 512 KB.");
    await expect(picker(page).locator('.pick-name')).toHaveText(['banner.png']);
});

test('a project with no images says how to add one', async ({ page }) => {
    await openApp(page, { projectImages: [] });
    await expect(page.locator('app-project-icon .project-icon-note')).toContainText('Add an image file');
});

test('with no project open, there is no icon to choose', async ({ page }) => {
    await openApp(page, { project: null });
    await expect(page.locator('app-project-icon')).toBeHidden();
});
