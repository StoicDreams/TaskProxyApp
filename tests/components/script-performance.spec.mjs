import { test, expect, openApp } from '../support/app.mjs';

// Settings' Performance tab (wc/script-performance.js). The choices are app data, which the backend reads as each
// script starts (services/performance.rs, whose own tests check that a script is limited).
const panel = page => page.locator('app-script-performance');
const priority = page => panel(page).locator('webui-switch.perf-priority');
const choosePriority = (page, name) => priority(page).locator('button', { hasText: new RegExp(`^${name}$`) }).click();
const threads = page => panel(page).locator('input.perf-threads');
const saved = page => page.evaluate(() => window.__backend.appData.data['app-script-performance']);
async function openPerformance(page, state = {}) {
    await openApp(page, state);
    await page.locator('webui-button.settings-tab-performance').click();
    await expect(panel(page)).toBeVisible();
}
/** Moves the slider to a value as the keyboard does, which ends with the change a person letting go makes. */
async function slideTo(page, value) {
    await threads(page).focus();
    await page.keyboard.press('End');
    const max = Number(await threads(page).getAttribute('max'));
    for (let at = max; at > value; at--) await page.keyboard.press('ArrowLeft');
}

test('Settings has a Performance tab, starting at Normal with every thread', async ({ page }) => {
    await openPerformance(page);
    await expect(priority(page).locator('button')).toHaveText(['Normal', 'Low', 'Lowest']);
    await expect(priority(page).locator('button[aria-checked="true"]')).toHaveText('Normal');
    await expect(threads(page)).toHaveValue('12');
    await expect(panel(page)).toContainText('All 12 threads');
});

test('a priority chosen is saved, and says what it does', async ({ page }) => {
    await openPerformance(page);
    await choosePriority(page, 'Lowest');
    await expect.poll(() => saved(page)).toEqual({ priority: 'lowest', threads: 0 });
    await expect(panel(page)).toContainText('only use CPU time nothing else wants');
    await choosePriority(page, 'Low');
    await expect.poll(() => saved(page)).toEqual({ priority: 'low', threads: 0 });
});

test('the threads chosen are saved, and every thread is saved as no limit', async ({ page }) => {
    await openPerformance(page);
    await slideTo(page, 6);
    await expect(panel(page)).toContainText('6 of 12 threads');
    await expect.poll(() => saved(page)).toEqual({ priority: 'normal', threads: 6 });
    await page.keyboard.press('End');
    await expect(panel(page)).toContainText('All 12 threads');
    await expect.poll(() => saved(page)).toEqual({ priority: 'normal', threads: 0 });
});

test('saved choices show when the tab opens', async ({ page }) => {
    await openPerformance(page, { appData: { 'app-script-performance': { priority: 'low', threads: 4 } } });
    await expect(priority(page).locator('button[aria-checked="true"]')).toHaveText('Low');
    await expect(threads(page)).toHaveValue('4');
    await expect(panel(page)).toContainText('4 of 12 threads');
});

test('a computer that cannot keep scripts to some threads only offers priority', async ({ page }) => {
    await openPerformance(page, { performance: { threads: 8, canLimitThreads: false, hasIdlePriority: false } });
    await expect(threads(page)).toBeDisabled();
    await expect(panel(page)).toContainText("This computer can't keep scripts to some CPU threads");
    await choosePriority(page, 'Lowest');
    await expect(panel(page)).toContainText('the lowest priority this computer offers');
});
