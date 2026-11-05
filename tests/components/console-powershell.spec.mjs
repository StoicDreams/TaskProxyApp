import { test, expect, openApp, mount } from '../support/app.mjs';

async function terminal(page) {
    await openApp(page, { project: null });
    const root = await mount(page, '<app-console-powershell id="c"></app-console-powershell>');
    return root.locator('#c');
}
const append = (el, lines) => el.evaluate((node, lines) => node.appendLines(lines), lines);
const line = (content, isError = false) => ({ content, isError });

test('starts with a placeholder, which output replaces', async ({ page }) => {
    const el = await terminal(page);
    await expect(el.locator('.placeholder')).toHaveText('No terminal output.');
    await append(el, [line('hello')]);
    await expect(el.locator('.placeholder')).toHaveCount(0);
    await expect(el.locator('.console-container')).toHaveText('hello');
});
test('output is shown as text, never as markup', async ({ page }) => {
    const el = await terminal(page);
    await append(el, [line('<img src=x onerror="window.__xss=1">'), line('<b>err</b>', true)]);
    await expect(el.locator('img, b')).toHaveCount(0);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});
test('ansi colors apply and carry across lines until reset', async ({ page }) => {
    const el = await terminal(page);
    await append(el, [line('\x1B[31mred'), line('still red\x1B[0m plain')]);
    const spans = el.locator('span');
    await expect(spans.first()).toHaveText('red');
    await expect(spans.nth(1)).toHaveText('still red');
    await expect(spans).toHaveCount(2);
});
test('errors are red with any color codes removed', async ({ page }) => {
    const el = await terminal(page);
    await append(el, [line('\x1B[32mfailed\x1B[0m', true)]);
    await expect(el.locator('span')).toHaveText('failed');
    expect(await el.locator('span').getAttribute('style')).toContain('color-danger');
});
test('a clear screen sequence clears earlier output', async ({ page }) => {
    const el = await terminal(page);
    await append(el, [line('old'), line('\x1B[2J\x1B[Hnew')]);
    await expect(el.locator('.console-container')).toHaveText('new');
});
test('old lines are dropped past the limit', async ({ page }) => {
    const el = await terminal(page);
    await append(el, Array.from({ length: 5100 }, (_, index) => line(`l${index}`)));
    expect(await el.locator('.console-container').evaluate(node => [node.childElementCount, node.firstElementChild.textContent])).toEqual([5000, 'l100']);
});
test('empty lines keep their height', async ({ page }) => {
    const el = await terminal(page);
    await append(el, [line('')]);
    expect(await el.locator('.console-container div').evaluate(node => node.textContent)).toBe(' ');
});
test('showPlaceholder replaces output', async ({ page }) => {
    const el = await terminal(page);
    await append(el, [line('x')]);
    await el.evaluate(node => node.showPlaceholder());
    await expect(el.locator('.console-container')).toHaveText('No terminal output.');
});
