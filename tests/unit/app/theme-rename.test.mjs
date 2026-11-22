import { test, expect, openApp } from '../support/app.mjs';

// Themes renamed so their names are Task Proxy's own (renamedThemes in root_files/app.js): a choice saved under the
// old name, and the colors adjusted for it, follow the rename when the app starts.
test('a theme saved under its old name starts as the renamed theme, with its adjusted colors', async ({ page }) => {
    await openApp(page, {
        appData: {
            'session-theme': 'mocha',
            'session-theme-colors': { mocha: { '--color-primary': '#224466' }, forest: { '--color-primary': '#113355' } },
        },
    });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'velvet');
    await expect.poll(() => page.evaluate(() => webui.getData('session-theme-colors'))).toEqual({
        velvet: { '--color-primary': '#224466' },
        forest: { '--color-primary': '#113355' },
    });
});
