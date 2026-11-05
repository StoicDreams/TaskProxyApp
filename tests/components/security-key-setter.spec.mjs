import { test, expect, openApp, mount, calls, dialogButton } from '../support/app.mjs';

async function setter(page, state = {}) {
    await openApp(page, { project: null, ...state });
    const root = await mount(page, '<app-security-key-setter id="s"></app-security-key-setter>');
    const el = root.locator('#s');
    await expect.poll(async () => (await calls(page, 'has_securitykey')).length).toBeGreaterThan(0);
    await page.waitForTimeout(100);
    return el;
}
test('a short key is refused', async ({ page }) => {
    const el = await setter(page);
    await el.locator('webui-input-message textarea').fill('too short');
    await el.locator('webui-button[theme="primary"]').click();
    await expect(el.locator('webui-alert')).toContainText('at least 20');
    expect(await calls(page, 'set_securitykey')).toEqual([]);
});
test('a long enough key is saved', async ({ page }) => {
    const el = await setter(page);
    await el.locator('webui-input-message textarea').fill('a key that is long enough');
    await el.locator('webui-button[theme="primary"]').click();
    await expect.poll(async () => (await calls(page, 'set_securitykey')).length).toBe(1);
    expect((await calls(page, 'set_securitykey'))[0]).toEqual({ securityKey: 'a key that is long enough' });
});
test('generate fills in a long enough key, different each time', async ({ page }) => {
    const el = await setter(page);
    const value = () => el.locator('webui-input-message').evaluate(node => node.value);
    await el.locator('webui-button[theme="secondary"]').click();
    const first = await value();
    expect(first.length).toBeGreaterThanOrEqual(20);
    await el.locator('webui-button[theme="secondary"]').click();
    expect(await value()).not.toBe(first);
});
test('delete is hidden when there is no key', async ({ page }) => {
    const el = await setter(page, { hasKey: false });
    await expect(el.locator('webui-button[theme="danger"]')).toBeHidden();
});
test('delete asks first, because saved data depends on the key', async ({ page }) => {
    const el = await setter(page);
    await el.locator('webui-button[theme="danger"]').click();
    await page.waitForTimeout(150);
    expect(await calls(page, 'delete_securitykey')).toEqual([]);
    await dialogButton(page, 'Confirm').click();
    await expect.poll(async () => (await calls(page, 'delete_securitykey')).length).toBe(1);
});
test('cancelling a delete keeps the key', async ({ page }) => {
    const el = await setter(page);
    await el.locator('webui-button[theme="danger"]').click();
    await dialogButton(page, 'Cancel').click();
    await page.waitForTimeout(100);
    expect(await calls(page, 'delete_securitykey')).toEqual([]);
});
