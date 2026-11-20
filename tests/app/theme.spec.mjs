import { test, expect, openApp, openTool, calls } from '../support/app.mjs';

// The Theme tab of Tools (webui-theme-selector in index.html, with its themes in css/app.css). The theme and any
// adjusted colors are app state, saved with the app's data.
const drawer = page => page.locator('webui-drawer.shared webui-theme-selector[panel]');
const openThemes = async page => {
    await openTool(page, 'theme');
    await expect(drawer(page)).toBeVisible();
    return drawer(page);
};
/** Chooses a theme as a person would: its category's tab, its side when the drawer shows one at a time, its tile. */
async function pick(page, panel, category, scheme, name) {
    await panel.locator('webui-button.category-tab', { hasText: category }).click();
    const content = panel.locator(`.category[data-category="${category}"]`);
    const tile = content.getByRole('listitem', { name, exact: true });
    const strip = content.locator('webui-split-panes').getByRole('button', { name: scheme === 'light' ? 'Light themes' : 'Dark themes' });
    if (await strip.isVisible()) await strip.click();
    await tile.click();
    return tile;
}
const sent = async (page, key) => (await calls(page, 'patch_app_data')).map(call => call.patch?.set?.[key]).filter(value => value !== undefined);

test('the Theme tab offers themes by category, light beside dark, and colors to adjust', async ({ page }) => {
    await openApp(page);
    const panel = await openThemes(page);
    await expect(panel.locator('webui-button.category-tab')).toHaveText(['Classic', 'Colors', 'Organic', 'Electric', 'Earth', 'Sky', 'Space', 'Ocean']);
    // Each category has light and dark themes.
    for (const category of ['Classic', 'Colors', 'Organic', 'Electric', 'Earth', 'Sky', 'Space', 'Ocean']) {
        const content = panel.locator(`.category[data-category="${category}"]`);
        // The tiles sit in each side's webui-tiles, whose list is in its shadow root, so they are found by their side.
        await expect(content.locator('.scheme.light button.tile')).toHaveCount(3);
        await expect(content.locator('.scheme.dark button.tile')).toHaveCount(3);
    }
    await expect(panel.locator('.category[data-category="Classic"] .scheme.dark button.tile .name')).toHaveText(['Task Proxy', 'Graphite', 'Charcoal']);
    for (const label of ['Background', 'Title', 'Primary', 'Secondary', 'Tertiary', 'Active', 'Button']) {
        await expect(panel.getByLabel(label, { exact: true })).toBeVisible();
    }
});

test('choosing a theme applies it, and saves it with the app\'s data', async ({ page }) => {
    await openApp(page);
    const panel = await openThemes(page);
    const tile = await pick(page, panel, 'Earth', 'light', 'Paper');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
    await expect(tile).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => sent(page, 'session-theme')).toContain('paper');
});

test('an adjusted color shows in the app at once, and is saved with the app\'s data', async ({ page }) => {
    await openApp(page);
    const panel = await openThemes(page);
    await pick(page, panel, 'Space', 'dark', 'Midnight');
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

test('in a remote browser the theme is the browser\'s own, and never replaces the computer\'s', async ({ page }) => {
    await page.addInitScript(() => { window.__taskProxyRemote = { deviceName: 'Phone', desktopName: 'Desk' }; });
    await openApp(page);
    const panel = await openThemes(page);
    await pick(page, panel, 'Sky', 'light', 'Sky');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'sky');
    // Everything waiting to be sent goes now, so nothing about the theme is still on its way.
    await page.evaluate(() => webui.proxy.syncAppData());
    expect(await sent(page, 'session-theme')).toEqual([]);
});
