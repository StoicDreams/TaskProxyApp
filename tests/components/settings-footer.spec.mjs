import { test, expect, openApp, mount } from '../support/app.mjs';

// The bottom of Settings (wc/settings-footer.js): the Stoic Dreams sign-in above the copyright and Powered by.
test('shows the sign-in, labeled, above the copyright and Powered by', async ({ page }) => {
    await openApp(page);
    const footer = page.locator('.settings-footer');
    await footer.scrollIntoViewIfNeeded();
    await expect(footer.locator('app-account')).toHaveText('Sign in to Stoic Dreams');
    const year = new Date().getFullYear();
    await expect(footer.locator('.settings-copyright')).toHaveText(`© 2016-${year} Stoic Dreams All Rights Reserved`);
    await expect(footer.locator('webui-poweredby')).toBeAttached();
    await expect.poll(() => footer.evaluate(el => [...el.children].map(child => child.localName))).toEqual(['app-account', 'div']);
});

test('a copyright from this year shows only this year', async ({ page }) => {
    await openApp(page, { project: null });
    const year = new Date().getFullYear();
    const root = await mount(page, `<app-settings-footer id="f" since="${year}" company="Acme"></app-settings-footer>`);
    await expect(root.locator('#f .settings-copyright')).toHaveText(`© ${year} Acme All Rights Reserved`);
});

test('the app itself has no footer bar any more', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('webui-app > footer[slot="footer"]')).toHaveCount(0);
});
