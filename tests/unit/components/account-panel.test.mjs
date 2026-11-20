import { test, expect, openApp, openTool, mount } from '../support/app.mjs';

// The Account tab of Tools (wc/account-panel.js): the Stoic Dreams sign-in at the top, and the copyright and Powered by
// at the bottom, where the app's footer used to be.
test('the Account tab has the sign-in at the top, and the copyright and Powered by at the bottom', async ({ page }) => {
    await openApp(page);
    const tab = await openTool(page, 'account');
    const panel = tab.locator('app-account-panel');
    await expect(panel.locator('app-account')).toHaveText('Sign in to Stoic Dreams');
    const year = new Date().getFullYear();
    await expect(panel.locator('.account-copyright')).toHaveText(`© 2016-${year} Stoic Dreams All Rights Reserved`);
    await expect(panel.locator('webui-poweredby')).toBeAttached();
    await expect.poll(() => panel.evaluate(el => [...el.children].map(child => child.localName + (child.className ? `.${child.className}` : ''))))
        .toEqual(['app-account', 'div.account-body', 'div.account-footer']);
});

test('a copyright from this year shows only this year', async ({ page }) => {
    await openApp(page, { project: null });
    const year = new Date().getFullYear();
    const root = await mount(page, `<app-account-panel id="f" since="${year}" company="Acme"></app-account-panel>`);
    await expect(root.locator('#f .account-copyright')).toHaveText(`© ${year} Acme All Rights Reserved`);
});

test('the sign-in and copyright are no longer in Settings, and the app has no footer bar', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('main app-account')).toHaveCount(0);
    await expect(page.locator('webui-app > footer[slot="footer"]')).toHaveCount(0);
});
