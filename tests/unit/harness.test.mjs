import { test, expect, mount } from './support/app.mjs';

// The harness's own matchers: each must fail when what it checks is not so, or every test using it proves nothing.
test('matchers fail when they should', async ({ page }) => {
    const root = await mount(page, '<div><b>A</b></div>');
    const fails = async fn => { try { await fn(); return false; } catch { return true; } };
    expect(await fails(() => expect(root.locator('td')).toHaveText(['A', 'B'], { timeout: 100 }))).toBe(true);
    expect(await fails(() => expect(root.locator('td')).toHaveCount(2, { timeout: 100 }))).toBe(true);
    expect(await fails(() => expect(root.locator('b')).toHaveText('A'))).toBe(false);
    expect(await fails(() => expect(root.locator('b')).not.toHaveText('A', { timeout: 100 }))).toBe(true);
    expect(await fails(() => expect(root.locator('b')).not.toHaveText('Z'))).toBe(false);
    expect(await fails(() => expect(root.locator('b')).toBeHidden({ timeout: 100 }))).toBe(true);
    // expect.poll retries until the assertion holds, and fails once its time is up.
    let calls = 0;
    expect(await fails(() => expect.poll(() => ++calls).toBeGreaterThan(3))).toBe(false);
    expect(await fails(() => expect.poll(() => 1, { timeout: 100 }).toBe(2))).toBe(true);
    expect(await fails(() => expect.poll(() => 1, { timeout: 100 }).not.toBe(1))).toBe(true);
    expect(await fails(() => expect.poll(() => 1).not.toBe(2))).toBe(false);
});
