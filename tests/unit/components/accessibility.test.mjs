import { test, expect, openApp, openTool } from '../support/app.mjs';

// The Accessibility tab of Tools (wc/accessibility.js). Its choices are app data, applied across the app as soon as it
// starts, whether or not the tab has been opened.
const saved = page => page.evaluate(() => window.__backend.appData.data['app-accessibility']);
const root = page => page.locator('html');
const textSize = page => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--typography-size').trim());
async function openAccessibility(page, state) {
    await openApp(page, state);
    return openTool(page, 'accessibility');
}

test('the tab offers text size and the other settings, at their defaults', async ({ page }) => {
    const tab = await openAccessibility(page);
    await expect(tab.getByRole('slider', { name: 'Text size' })).toHaveValue('100');
    await expect(tab).toContainText('100%');
    for (const name of ['Reduce motion', 'Underline links', 'Stronger focus outline']) {
        await expect(tab.getByRole('checkbox', { name })).not.toBeChecked();
    }
    await expect(tab.getByRole('checkbox', { name: 'Show tooltips' })).toBeChecked();
});

test('text size scales the text across the app, is saved, and Reset puts it back', async ({ page }) => {
    const tab = await openAccessibility(page);
    const before = await textSize(page);
    const slider = tab.getByRole('slider', { name: 'Text size' });
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(tab).toContainText('110%');
    await expect.poll(() => saved(page)).toMatchObject({ textSize: 110 });
    await expect.poll(() => textSize(page)).toBe('17.60px');
    await tab.getByRole('button', { name: 'Reset' }).click();
    await expect.poll(() => saved(page)).toMatchObject({ textSize: 100 });
    await expect.poll(() => textSize(page)).toBe(before);
});

test('each switch changes the app and is saved', async ({ page }) => {
    const tab = await openAccessibility(page);
    await tab.getByRole('checkbox', { name: 'Reduce motion' }).check();
    await expect(root(page)).toHaveAttribute('data-reduce-motion', '');
    await tab.getByRole('checkbox', { name: 'Underline links' }).check();
    await expect(root(page)).toHaveAttribute('data-underline-links', '');
    await tab.getByRole('checkbox', { name: 'Stronger focus outline' }).check();
    await expect(root(page)).toHaveAttribute('data-strong-focus', '');
    await tab.getByRole('checkbox', { name: 'Show tooltips' }).uncheck();
    await expect.poll(() => page.evaluate(() => window.tooltipsEnabled)).toBe(false);
    await expect.poll(() => saved(page)).toEqual({ textSize: 100, reduceMotion: true, underlineLinks: true, strongFocus: true, tooltips: false });
    await tab.getByRole('checkbox', { name: 'Reduce motion' }).uncheck();
    await expect(root(page)).not.toHaveAttribute('data-reduce-motion');
});

test('saved choices apply when the app starts, before the tab is opened', async ({ page }) => {
    await openApp(page, { appData: { 'app-accessibility': { textSize: 125, reduceMotion: true, underlineLinks: true, strongFocus: false, tooltips: false } } });
    await expect.poll(() => textSize(page)).toBe('20.00px');
    await expect(root(page)).toHaveAttribute('data-reduce-motion', '');
    await expect(root(page)).toHaveAttribute('data-underline-links', '');
    await expect(root(page)).not.toHaveAttribute('data-strong-focus');
    await expect.poll(() => page.evaluate(() => window.tooltipsEnabled)).toBe(false);
    const tab = await openTool(page, 'accessibility');
    await expect(tab.getByRole('slider', { name: 'Text size' })).toHaveValue('125');
});

test('reduce motion follows the system until it is chosen', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const tab = await openAccessibility(page);
    await expect(root(page)).toHaveAttribute('data-reduce-motion', '');
    await expect(tab.getByRole('checkbox', { name: 'Reduce motion' })).toBeChecked();
});
