import { test, expect, openApp, calls, openDialog, dialogButton } from '../support/app.mjs';

const ACCOUNT = { id: 1, displayName: 'Test User' };
const SIGN_IN_URL = 'https://www.stoicdreams.com/signin?app=taskproxy&request=3160d8e4-e8dd-43c7-a397-43b17ef46cbc';
// The sign-in sits at the bottom of Settings, which the app opens on with a project.
const button = page => page.locator('.settings-footer app-account');

/** Records the messages shown with webui.alert, which alerts() returns. */
function spyOnAlerts(page) {
    return page.evaluate(() => {
        window.__alerts = [];
        const original = webui.alert;
        webui.alert = function (...args) { window.__alerts.push(`${args[0]}`); return original.apply(this, args); };
    });
}
const alerts = page => page.evaluate(() => window.__alerts);

async function startSignIn(page, state = {}) {
    await openApp(page, state);
    await spyOnAlerts(page);
    await expect(button(page)).toHaveAttribute('data-state', 'signed-out');
    await button(page).click();
    await expect(openDialog(page)).toContainText('M7A-JQF');
}

test('signed out, it offers to sign in', async ({ page }) => {
    await openApp(page);
    await expect(button(page)).toHaveAttribute('data-state', 'signed-out');
    await expect(button(page)).toHaveAttribute('title', 'Sign in to your Stoic Dreams account');
    await expect(button(page).locator('webui-icon')).toHaveAttribute('icon', /^user\|/);
});

test('signed in, it names the account', async ({ page }) => {
    await openApp(page, { myfi: { account: ACCOUNT } });
    await expect(button(page)).toHaveAttribute('data-state', 'signed-in');
    await expect(button(page)).toHaveAttribute('title', 'Signed in as Test User');
    await expect(button(page).locator('webui-icon')).toHaveAttribute('icon', /^user-check\|theme:success/);
});

test('while Stoic Dreams cannot be reached, it shows the saved account and says so', async ({ page }) => {
    await openApp(page, { myfi: { account: { ...ACCOUNT, offline: true } } });
    await expect(button(page)).toHaveAttribute('data-state', 'offline');
    await expect(button(page)).toHaveAttribute('title', "Signed in as Test User (Stoic Dreams can't be reached right now)");
    await button(page).click();
    await expect(openDialog(page)).toContainText("Stoic Dreams can't be reached right now");
});

test('signing in shows the code to check, and finishes once it is approved in the browser', async ({ page }) => {
    await startSignIn(page);
    await expect.poll(() => calls(page, 'myfi_sign_in_start')).toHaveLength(1);
    await expect.poll(async () => (await calls(page, 'myfi_sign_in_wait')).length).toBe(1);
    await page.evaluate(account => window.__backend.myfi.approve(account), ACCOUNT);
    await expect(openDialog(page)).toHaveCount(0);
    await expect(button(page)).toHaveAttribute('data-state', 'signed-in');
    await expect.poll(() => alerts(page)).toContain('Signed in as Test User.');
    await expect.poll(() => calls(page, 'myfi_sign_in_cancel')).toEqual([]);
});

test('the approval page can be opened again while it waits', async ({ page }) => {
    await startSignIn(page);
    await dialogButton(page, 'Open the Page Again').click();
    // Rust opens it, with the computer's own environment rather than an AppImage's.
    await expect.poll(() => calls(page, 'open_url')).toEqual([{ url: SIGN_IN_URL }]);
    await expect(openDialog(page)).toContainText('M7A-JQF');
});

test('the code is a button that copies it', async ({ page }) => {
    await startSignIn(page);
    await openDialog(page).getByRole('button', { name: 'Copy the code M7A-JQF' }).click();
    await expect(openDialog(page)).toContainText('Copied the code.');
    await expect.poll(() => page.evaluate(() => window.__backend.clipboard)).toEqual({ text: 'M7A-JQF' });
    // Copying leaves the sign-in waiting.
    await expect(openDialog(page)).toContainText('M7A-JQF');
});

test('when the browser didn\'t open, the dialog says so and gives the address to open or copy', async ({ page }) => {
    await startSignIn(page, { myfiOpened: false });
    await expect(openDialog(page)).toContainText('Your browser didn\'t open');
    await expect(openDialog(page).locator('code')).toHaveText(SIGN_IN_URL);
    await openDialog(page).getByRole('button', { name: 'Copy Link' }).click();
    await expect.poll(() => page.evaluate(() => window.__backend.clipboard)).toEqual({ text: SIGN_IN_URL });
    await dialogButton(page, 'Open the Page').click();
    await expect.poll(() => calls(page, 'open_url')).toEqual([{ url: SIGN_IN_URL }]);
});

test('cancelling stops waiting and stays signed out', async ({ page }) => {
    await startSignIn(page);
    await dialogButton(page, 'Cancel').click();
    await expect.poll(async () => (await calls(page, 'myfi_sign_in_cancel')).length).toBe(1);
    await expect(openDialog(page)).toHaveCount(0);
    await expect(button(page)).toHaveAttribute('data-state', 'signed-out');
    // Signing in can only start again once the cancelled one has ended, which it did without a message.
    await button(page).click();
    await expect.poll(async () => (await calls(page, 'myfi_sign_in_start')).length).toBe(2);
    await expect(openDialog(page)).toContainText('M7A-JQF');
    await expect.poll(() => alerts(page)).toEqual([]);
});

test('a refused or expired sign-in says why, and its reason is never markup', async ({ page }) => {
    await startSignIn(page);
    await expect.poll(async () => (await calls(page, 'myfi_sign_in_wait')).length).toBe(1);
    await page.evaluate(() => window.__backend.myfi.end('Refused <img src=x onerror="window.__hacked=1">'));
    await expect(openDialog(page)).toHaveCount(0);
    await expect.poll(() => alerts(page)).toContain('Refused &lt;img src=x onerror=&quot;window.__hacked=1&quot;&gt;');
    await expect(button(page)).toHaveAttribute('data-state', 'signed-out');
    await expect.poll(() => page.evaluate(() => window.__hacked)).toBeUndefined();
});

test('a sign-in that cannot start says why, with nothing to wait for', async ({ page }) => {
    await openApp(page, { myfiStartError: 'Could not reach api.myfi.ws' });
    await spyOnAlerts(page);
    await button(page).click();
    await expect.poll(() => alerts(page)).toContain('Could not reach api.myfi.ws');
    await expect.poll(() => calls(page, 'myfi_sign_in_wait')).toEqual([]);
    await expect(openDialog(page)).toHaveCount(0);
});

test('signed in, it shows the account and signs out', async ({ page }) => {
    await openApp(page, { myfi: { account: ACCOUNT } });
    await spyOnAlerts(page);
    await button(page).click();
    await expect(openDialog(page)).toContainText('Task Proxy is signed in as Test User.');
    await dialogButton(page, 'Sign Out').click();
    await expect.poll(async () => (await calls(page, 'myfi_sign_out')).length).toBe(1);
    await expect(button(page)).toHaveAttribute('data-state', 'signed-out');
    await expect.poll(() => alerts(page)).toContain('Task Proxy is signed out of your Stoic Dreams account.');
});

test("the account's name is shown as text, never markup", async ({ page }) => {
    await openApp(page, { myfi: { account: { id: 2, displayName: '<img src=x onerror="window.__hacked=1">' } } });
    await button(page).click();
    await expect(openDialog(page)).toContainText('<img src=x onerror="window.__hacked=1">');
    await expect(openDialog(page).locator('.myfi-account img')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__hacked)).toBeUndefined();
});
