import { test, expect, openApp, calls } from '../support/app.mjs';

// The header's theme button (webui-theme-selector in index.html, with its themes in css/app.css). The theme and any
// adjusted colors are app state, saved with the app's data.
const drawer = page => page.locator('webui-drawer.shared webui-theme-selector[panel]');
const openThemes = async page => {
    await page.locator('header webui-theme-selector').click();
    await expect(drawer(page)).toBeVisible();
    return drawer(page);
};
const sent = async (page, key) => (await calls(page, 'patch_app_data')).map(call => call.patch?.set?.[key]).filter(value => value !== undefined);

test('the theme button offers light and dark themes, and colors to adjust', async ({ page }) => {
    await openApp(page);
    const panel = await openThemes(page);
    await expect(panel.getByRole('group', { name: 'Light themes' }).getByRole('button')).toHaveText(['Daylight', 'Paper', 'Sky']);
    await expect(panel.getByRole('group', { name: 'Dark themes' }).getByRole('button')).toHaveText(['Task Proxy', 'Midnight', 'Forest']);
    for (const label of ['Background', 'Title', 'Primary', 'Secondary', 'Tertiary', 'Active', 'Button']) {
        await expect(panel.getByLabel(label, { exact: true })).toBeVisible();
    }
});

test('choosing a theme applies it, and saves it with the app\'s data', async ({ page }) => {
    await openApp(page);
    const panel = await openThemes(page);
    await panel.getByRole('button', { name: 'Paper' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
    await expect(panel.getByRole('button', { name: 'Paper' })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => sent(page, 'session-theme')).toContain('paper');
});

test('an adjusted color shows in the app at once, and is saved with the app\'s data', async ({ page }) => {
    await openApp(page);
    const panel = await openThemes(page);
    await panel.getByRole('button', { name: 'Midnight' }).click();
    await panel.getByLabel('Title', { exact: true }).fill('#f0e6a0');
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--color-title'))).toBe('#f0e6a0');
    // Text on the light title switches to black, which reads better on it.
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--color-title-offset'))).toBe('var(--color-black)');
    await expect.poll(() => sent(page, 'session-theme-colors')).toContainEqual({
        midnight: { '--color-title': '#f0e6a0', '--color-title-offset': 'var(--color-black)' },
    });
});

test('the saved theme and its colors are applied when the app starts', async ({ page }) => {
    await openApp(page, {
        appData: {
            'session-theme': 'forest',
            'session-theme-colors': { forest: { '--color-primary': '#224466', '--color-primary-offset': 'var(--color-white)' } },
        },
    });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'forest');
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--color-primary'))).toBe('#224466');
});

test('on a paired device the theme is the device\'s own, and never replaces the desktop\'s', async ({ page }) => {
    await page.addInitScript(() => { window.__taskProxyRemote = { level: 'work', deviceName: 'Phone', desktopName: 'Desk' }; });
    await openApp(page);
    const panel = await openThemes(page);
    await panel.getByRole('button', { name: 'Sky' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'sky');
    // Everything waiting to be sent goes now, so nothing about the theme is still on its way.
    await page.evaluate(() => webui.proxy.syncAppData());
    expect(await sent(page, 'session-theme')).toEqual([]);
});
