import { test, expect, openApp } from '../support/app.mjs';

// actionNote (root_files/app.js) says what a button's action did in an alert by the button.
test('buttons placed straight in the page each keep their own message', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => {
        const first = webui.create('button', { id: 'first-button', text: 'First' });
        const second = webui.create('button', { id: 'second-button', text: 'Second' });
        document.body.append(first, second);
        actionNote(first, 'First worked.', 'success');
        actionNote(second, 'Second worked.', 'success');
    });
    await expect(page.locator('#first-button + .action-note')).toHaveText('First worked.');
    await expect(page.locator('#second-button + .action-note')).toHaveText('Second worked.');
    await page.evaluate(() => clearActionNote(document.getElementById('first-button')));
    await expect(page.locator('.action-note', { hasText: 'First worked.' })).toHaveCount(0);
    await expect(page.locator('#second-button + .action-note')).toHaveText('Second worked.');
});
