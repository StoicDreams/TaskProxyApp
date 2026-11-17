import { test, expect, openApp, mount, calls, openDialog, dialogButton } from '../support/app.mjs';

const ACCOUNT = { id: 12, displayName: 'Test User' };
const DEVICE = { id: 'device-1', name: 'Pixel 9', level: 'view', days: 30, pairedAt: 1, lastSeen: null, connected: false };

async function panel(page, state = {}) {
    await openApp(page, { project: null, myfi: { account: ACCOUNT }, ...state });
    // The header's webui-alerts replaces webui.alert once it loads, which would drop a spy put on before it.
    await page.waitForFunction(() => window.webuiAlert === webui.alert);
    await page.evaluate(() => {
        window.__alerts = [];
        const original = webui.alert;
        webui.alert = function (...args) { window.__alerts.push(`${args[0]}`); return original.apply(this, args); };
    });
    const root = await mount(page, '<app-remote-access id="r"></app-remote-access>');
    const el = root.locator('#r');
    await expect(el.locator('.remote-state')).toBeVisible();
    return el;
}
const alerts = page => page.evaluate(() => window.__alerts);
const role = (el, name) => el.locator(`[data-role="${name}"]`);
/** Chooses an option in a webui-dropdown, as picking it from its list does. */
const pick = (dropdown, value) => dropdown.evaluate((d, value) => {
    d._select.value = value;
    d._select.dispatchEvent(new Event('change', { bubbles: true }));
}, value);

test('signed out, it asks to sign in first, and turning on says why it can not', async ({ page }) => {
    const el = await panel(page, { myfi: null });
    await expect(el.locator('.remote-state')).toContainText('Remote Access is off.');
    await expect(el.locator('.remote-signed-out')).toContainText('Sign in to your Stoic Dreams account first');
    await expect(role(el, 'sign-in')).toBeVisible();
    await role(el, 'turn-on').click();
    await expect.poll(() => alerts(page)).toEqual([expect.stringContaining('Sign in to your Stoic Dreams account first')]);
    await expect(el.locator('.remote-state')).toContainText('Remote Access is off.');
    await expect(el.locator('.remote-pairing')).toHaveCount(0);
});

test('turning it on shows the key to check and the pairing form, and turning it off hides them', async ({ page }) => {
    const el = await panel(page);
    await role(el, 'turn-on').click();
    await expect(el.locator('.remote-state')).toContainText('Remote Access is on.');
    await expect(el.locator('.remote-state')).toContainText('Desk PC');
    await expect(el.locator('.remote-fingerprint')).toContainText('a1b2c3d4e5f60718');
    await expect(el.locator('.remote-pairing')).toBeVisible();
    expect(await calls(page, 'remote_set_enabled')).toEqual([{ enabled: true }]);
    await role(el, 'turn-off').click();
    await expect(el.locator('.remote-state')).toContainText('Remote Access is off.');
    await expect(el.locator('.remote-pairing')).toHaveCount(0);
    expect(await calls(page, 'remote_set_enabled')).toEqual([{ enabled: true }, { enabled: false }]);
});

test('a QR code pairs a device at the chosen level, for the chosen time, and can be cancelled', async ({ page }) => {
    const el = await panel(page, { remote: { enabled: true } });
    await role(el, 'device-name').locator('input').fill('Laptop');
    await pick(role(el, 'level'), 'work');
    await pick(role(el, 'days'), '7');
    await role(el, 'show-qr').click();
    await expect(el.locator('img.remote-qr')).toHaveAttribute('src', /^data:image\/svg\+xml/);
    expect(await calls(page, 'remote_invite')).toEqual([{ invite: { name: 'Laptop', level: 'work', days: 7 } }]);
    await expect(el.locator('.remote-pairing')).toContainText('Scan this with Laptop to pair it at the Work level, lasting 7 days without connecting');
    await expect(el.locator('.remote-link')).toHaveText('https://www.taskproxy.com/remote/#pair=eyJ2IjoxfQ');
    await role(el, 'cancel-invite').click();
    await expect(el.locator('img.remote-qr')).toHaveCount(0);
    await expect(role(el, 'show-qr')).toBeVisible();
    expect((await calls(page, 'remote_invite_cancel')).length).toBe(1);
});

test('a device pairing updates the panel and raises a notice', async ({ page }) => {
    const el = await panel(page, { remote: { enabled: true } });
    await role(el, 'show-qr').click();
    await expect(el.locator('img.remote-qr')).toBeVisible();
    await page.evaluate(() => window.__backend.remote.pair('Pixel 9'));
    await expect(el.locator('.remote-device-name')).toContainText('Pixel 9');
    await expect(el.locator('img.remote-qr')).toHaveCount(0);
    await expect.poll(() => alerts(page)).toContain('Pixel 9 is paired, at the View level.');
});

test('a paired device can change level, be renamed, and be unpaired', async ({ page }) => {
    const el = await panel(page, { remote: { enabled: true, devices: [DEVICE] } });
    const device = el.locator('[data-device="device-1"]');
    await expect(device).toContainText('Pixel 9');
    await expect(device.locator('.remote-device-details')).toContainText('Last connected never');
    await expect(role(device, 'disconnect')).toHaveCount(0);

    await pick(role(device, 'device-level'), 'commit');
    await expect.poll(() => calls(page, 'remote_device_update')).toEqual([{ id: 'device-1', change: { level: 'commit' } }]);

    await role(el.locator('[data-device="device-1"]'), 'rename').click();
    await openDialog(page).locator('webui-input-text[name="name"] input').fill('Work Phone');
    await dialogButton(page, 'Rename').click();
    await expect(el.locator('[data-device="device-1"] .remote-device-name')).toContainText('Work Phone');

    await role(el.locator('[data-device="device-1"]'), 'remove').click();
    await expect(openDialog(page)).toContainText('Unpair Work Phone?');
    await dialogButton(page, 'Unpair').click();
    await expect(el.locator('.remote-none')).toHaveText('No devices are paired.');
    expect(await calls(page, 'remote_device_remove')).toEqual([{ id: 'device-1' }]);
});

test('a connected device can be disconnected and stays paired', async ({ page }) => {
    const el = await panel(page, { remote: { enabled: true, devices: [{ ...DEVICE, connected: true }] } });
    const device = el.locator('[data-device="device-1"]');
    await expect(device.locator('.remote-device-name')).toContainText('(connected now)');
    await role(device, 'disconnect').click();
    await expect(el.locator('[data-device="device-1"] .remote-device-name')).not.toContainText('connected now');
    await expect(el.locator('[data-device="device-1"]')).toBeVisible();
    expect(await calls(page, 'remote_device_disconnect')).toEqual([{ id: 'device-1' }]);
});

test('a pairing that lasts for good says so', async ({ page }) => {
    const el = await panel(page, { remote: { enabled: true, devices: [{ ...DEVICE, days: 0 }] } });
    await expect(el.locator('.remote-device-details')).toContainText('Stays paired for good.');
});

test('activity lists what devices sent and what was refused', async ({ page }) => {
    const el = await panel(page, {
        remote: {
            enabled: true,
            log: [
                { at: 2, deviceId: 'device-1', deviceName: 'Pixel 9', cmd: 'git_push', ok: false, error: 'This needs the Commit level.' },
                { at: 1, deviceId: 'device-1', deviceName: 'Pixel 9', cmd: 'get_runs', ok: true, error: null },
            ],
        },
    });
    await role(el, 'show-activity').click();
    await expect(el.locator('.remote-log-failed')).toContainText('Pixel 9 git_push, refused: This needs the Commit level.');
    await expect(el.locator('.remote-log-ok')).toContainText('Pixel 9 get_runs');
});

test('when api.myfi.ws can not be reached, it says devices can not reach the desktop', async ({ page }) => {
    const el = await panel(page, { remote: { enabled: true, reachability: { reachable: false, error: 'Could not reach api.myfi.ws' } } });
    await expect(el.locator('.remote-error')).toContainText("devices can't reach this desktop: Could not reach api.myfi.ws");
});

test('names from devices are shown as text', async ({ page }) => {
    const name = '<img src=x onerror="window.__xss=1">';
    const el = await panel(page, { remote: { enabled: true, devices: [{ ...DEVICE, name }] } });
    await expect(el.locator('.remote-device-name strong')).toHaveText(name);
    await role(el, 'remove').click();
    await expect(openDialog(page)).toContainText(`Unpair ${name}?`);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('the header shows which devices are connected, and opens the panel', async ({ page }) => {
    await openApp(page, { project: null, myfi: { account: ACCOUNT }, remote: { enabled: true, devices: [DEVICE] } });
    const indicator = page.locator('header app-remote-access[indicator]');
    await expect(indicator).toBeHidden();
    await page.evaluate(() => {
        window.__backend.remote.devices[0].connected = true;
        window.__backend.remote.changed(null);
    });
    await expect(indicator).toBeVisible();
    await expect(indicator).toHaveAttribute('title', 'Remote Access: Pixel 9 connected');
    await indicator.click();
    await expect(openDialog(page).locator('app-remote-access .remote-device-name')).toContainText('Pixel 9 (connected now)');
});

test('turning on fails with the reason the backend gives', async ({ page }) => {
    const el = await panel(page, { remote: { enableError: 'api.myfi.ws answered with something unexpected.' } });
    await role(el, 'turn-on').click();
    await expect.poll(() => alerts(page)).toEqual([expect.stringContaining('answered with something unexpected')]);
    await expect(el.locator('.remote-state')).toContainText('Remote Access is off.');
});
