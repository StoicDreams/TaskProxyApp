import { test, expect, openApp, dialogButton, calls } from '../../support/app.mjs';

const source = page => page.evaluate(() => webui.getData('app-home-source'));

test('every update control shows whole in the settings side column', async ({ page }) => {
    // The window size where the buttons once ran out of the card and were cut off.
    await page.setViewportSize({ width: 1297, height: 808 });
    await openApp(page);
    const updates = page.locator('app-update-manager');
    for (const control of [updates.getByText('Check for Updates'), updates.getByText('Install Updates'), updates.getByText('Current Version')]) {
        await expect(control).toBeInViewport({ ratio: 0.95 });
    }
});
