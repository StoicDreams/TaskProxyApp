import { test, expect, openApp, calls, onCommand } from '../support/app.mjs';

const open = async (page, state) => {
    await openApp(page, state);
    await page.locator('app-icon-drawer').click();
    await page.locator('webui-icon-search webui-input-text input').waitFor();
    await page.waitForFunction(() => document.querySelector('webui-icon-search')._emojis?.length > 0);
};
test('emoji search asks the backend, using what the user typed', async ({ page }) => {
    await open(page);
    await onCommand(page, 'search_emojis', () => [{ emoji: 'dog', name: 'dog' }]);
    await page.locator('webui-icon-search webui-toggle-icon[label="Emojis"]').click();
    await page.locator('webui-icon-search webui-input-text input').pressSequentially('dog');
    await expect.poll(async () => (await calls(page, 'search_emojis')).at(-1)?.query).toBe('dog');
    await expect.poll(() => page.evaluate(() => document.querySelector('webui-icon-search')._filteredKeys.map(item => item.name))).toEqual(['emoji-dog']);
});
test('the emoji index is prepared from the supported list', async ({ page }) => {
    await open(page);
    await expect.poll(async () => (await calls(page, 'init_emoji_search')).length).toBe(1);
    expect((await calls(page, 'init_emoji_search'))[0].supportedEmojis.length).toBeGreaterThan(100);
});
