import { test, expect, openApp, openTool, calls, goToPage } from '../../support/app.mjs';

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

// An accessibility check (WCAG AA, 4.5:1): the current page's nav link draws its name and icon on Web UI's shade, and
// its icon once took the colors meant for the active color around it, which hid it in most themes.
test('in every theme, the current page\'s nav link has a readable name and icon', async ({ page }) => {
    await openApp(page, { navigation: [{ name: 'Setup', icon: 'gear', url: '/setup', children: null }] });
    await goToPage(page, '/setup');
    const link = page.locator('webui-nav-link.theme-active', { hasText: 'Setup' }).locator('a');
    await expect(link.locator('webui-icon')).toBeVisible();
    const themes = await page.evaluate(() => [...document.querySelectorAll('webui-theme-selector option')].map(option => option.value));
    expect(themes.length).toBeGreaterThan(40);
    const faint = [];
    for (const theme of themes) {
        // Colors ease from the last theme's into this one's, so the transitions are finished before any is read.
        // Reading the animations brings the styles up to date first, which starts them.
        await page.evaluate(value => {
            document.documentElement.setAttribute('data-theme', value);
            document.getAnimations().filter(animation => animation instanceof CSSTransition).forEach(animation => animation.finish());
        }, theme);
        const [text, icon] = await link.evaluate(a => {
            const icon = a.querySelector('webui-icon');
            const probe = document.createElement('span');
            a.append(probe);
            // Each color is drawn on a 1x1 canvas and read back as sRGB, so oklch, lab and display-p3 colors are
            // converted rather than read as if their numbers were RGB, and alpha is kept.
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            const rgba = color => {
                probe.style.color = '';
                probe.style.color = color;
                context.clearRect(0, 0, 1, 1);
                context.fillStyle = '#000';
                context.fillStyle = getComputedStyle(probe).color;
                context.fillRect(0, 0, 1, 1);
                const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
                return [r / 255, g / 255, b / 255, alpha / 255];
            };
            /** A color with alpha drawn over a solid one. */
            const over = (top, under) => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
            // A background that is not solid shows what is behind it: its ancestors' backgrounds, out to the
            // nearest solid one (through shadow roots), or the white of a page with none.
            const layers = [];
            for (let node = a; node; node = node.parentElement || node.getRootNode().host) {
                const color = rgba(getComputedStyle(node).backgroundColor);
                if (color[3] > 0) layers.push(color);
                if (color[3] >= 1) break;
            }
            const background = layers.reduceRight((under, layer) => over(layer, under), [1, 1, 1, 1]);
            const luminance = solid => solid.slice(0, 3)
                .map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
                .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
            // A color with alpha is read as it shows, over the background.
            const ratio = color => {
                const [hi, lo] = [luminance(over(rgba(color), background)), luminance(background)].sort((p, q) => q - p);
                return (hi + 0.05) / (lo + 0.05);
            };
            const result = [ratio(getComputedStyle(a).color), ratio(getComputedStyle(icon).getPropertyValue('--ico-color-primary').trim())];
            probe.remove();
            return result;
        });
        if (text < 4.5 || icon < 4.5) faint.push(`${theme || 'default'}: text ${text.toFixed(2)}, icon ${icon.toFixed(2)}`);
    }
    expect(faint).toEqual([]);
});
