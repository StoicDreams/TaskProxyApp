import { test, expect, openApp, mount, calls, dialogButton, openDialog } from '../support/app.mjs';

async function setter(page, state = {}) {
    await openApp(page, { project: null, ...state });
    const root = await mount(page, '<app-security-key-setter id="s"></app-security-key-setter>');
    const el = root.locator('#s');
    await expect.poll(async () => (await calls(page, 'has_securitykey')).length).toBeGreaterThan(0);
    return el;
}
test('Save is off until the key is long enough, saying so, and on once it is', async ({ page }) => {
    const el = await setter(page);
    const save = el.locator('webui-button[theme="primary"]');
    await expect(save).toHaveAttribute('disabled');
    await expect(save).toHaveAttribute('title', /at least 20 characters/);
    await el.locator('webui-input-message textarea').fill('too short');
    await expect(save).toHaveAttribute('disabled');
    await el.locator('webui-input-message textarea').fill('a key that is long enough');
    await expect(save).not.toHaveAttribute('disabled');
    await el.locator('webui-input-message textarea').fill('');
    await expect(save).toHaveAttribute('disabled');
    await expect.poll(() => calls(page, 'set_securitykey')).toEqual([]);
});
test('a generated key can be saved', async ({ page }) => {
    const el = await setter(page);
    const save = el.locator('webui-button[theme="primary"]');
    await expect(save).toHaveAttribute('disabled');
    await el.locator('webui-button[theme="secondary"]').click();
    await expect(save).not.toHaveAttribute('disabled');
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
    await expect.poll(async () => (await value()).length).toBeGreaterThanOrEqual(20);
    const first = await value();
    await el.locator('webui-button[theme="secondary"]').click();
    await expect.poll(value).not.toBe(first);
});
test('delete is hidden when there is no key', async ({ page }) => {
    const el = await setter(page, { hasKey: false });
    await expect(el.locator('webui-button[theme="danger"]')).toBeHidden();
});
test('delete asks first, because saved data depends on the key', async ({ page }) => {
    const el = await setter(page);
    await el.locator('webui-button[theme="danger"]').click();
    // It has asked, and deletes nothing until that is answered.
    await expect(dialogButton(page, 'Confirm')).toBeVisible();
    await expect.poll(() => calls(page, 'delete_securitykey')).toEqual([]);
    await dialogButton(page, 'Confirm').click();
    await expect.poll(async () => (await calls(page, 'delete_securitykey')).length).toBe(1);
});
test('cancelling a delete keeps the key', async ({ page }) => {
    const el = await setter(page);
    await el.locator('webui-button[theme="danger"]').click();
    await dialogButton(page, 'Cancel').click();
    await expect(openDialog(page)).toHaveCount(0);
    await expect.poll(() => calls(page, 'delete_securitykey')).toEqual([]);
    // The button is still there to ask again, which it would not be had the key gone.
    await expect(el.locator('webui-button[theme="danger"]')).toBeVisible();
});
