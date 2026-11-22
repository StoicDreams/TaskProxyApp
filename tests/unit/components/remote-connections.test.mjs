import { test, expect, openApp, mount, calls, openDialog, dialogButton } from '../support/app.mjs';
import { spyOnAlerts, alerts } from '../../support/wait.mjs';

const ACCOUNT = { id: 12, displayName: 'Test User' };
const PHONE = { key: 'key-phone', name: 'Firefox on Android', code: 'ABC-DEF' };
const LAPTOP = { key: 'key-laptop', name: 'Chrome on Linux', code: 'XYZ-234' };

async function panel(page, state = {}) {
    await openApp(page, { project: null, myfi: { account: ACCOUNT }, ...state });
    await spyOnAlerts(page);
    const root = await mount(page, '<app-remote-connections id="r"></app-remote-connections>');
    const el = root.locator('#r');
    await expect(el.locator('.remote-state')).toBeVisible();
    return el;
}
const role = (el, name) => el.locator(`[data-role="${name}"]`);
const browser = (el, key) => el.locator(`[data-browser="${key}"]`);
/** Chooses an option in a webui-select by its value: opens its tiles and clicks that one. */
async function pick(select, value) {
    await select.locator('button[aria-haspopup]').click();
    await select.locator(`.tile[data-value="${value}"]`).click();
    await expect(select.locator('.panel')).toBeHidden();
}

test('it starts off, named after the computer, with no browsers', async ({ page }) => {
    const el = await panel(page);
    await expect(el.locator('.remote-state')).toContainText('Remote Connections is off.');
    await expect(role(el, 'computer-name').locator('input')).toHaveValue('Desk PC');
    await expect(role(el, 'turn-on')).toBeVisible();
    await expect(role(el, 'turn-off')).toHaveCount(0);
    await expect(el.locator('.remote-approved .remote-none')).toHaveText('No browser is approved.');
    await expect(el.locator('.remote-waiting .remote-none')).toHaveText('No browser is waiting.');
});

test('signed out, turning it on says to sign in first', async ({ page }) => {
    const el = await panel(page, { myfi: null });
    await role(el, 'turn-on').click();
    await expect.poll(() => alerts(page)).toEqual([expect.stringContaining('Sign in to your Stoic Dreams account first')]);
    await expect(el.locator('.remote-state')).toContainText('Remote Connections is off.');
});

test('turning it on sends the name typed for this computer, and turning it off sends none', async ({ page }) => {
    const el = await panel(page);
    await role(el, 'computer-name').locator('input').fill('Office Tower');
    await role(el, 'turn-on').click();
    await expect(el.locator('.remote-state')).toContainText('Remote Connections is on.');
    await expect(el.locator('.remote-state')).toContainText('Office Tower is listed on www.taskproxy.com');
    await expect.poll(() => calls(page, 'remote_set_enabled')).toEqual([{ enabled: true, name: 'Office Tower' }]);
    await role(el, 'turn-off').click();
    await expect(el.locator('.remote-state')).toContainText('Remote Connections is off.');
    await expect.poll(() => calls(page, 'remote_set_enabled')).toEqual([{ enabled: true, name: 'Office Tower' }, { enabled: false, name: null }]);
});

test('while it is on, the computer can be renamed', async ({ page }) => {
    const el = await panel(page, { remote: { enabled: true } });
    await role(el, 'computer-name').locator('input').fill('Garage');
    await role(el, 'rename').click();
    await expect(el.locator('.remote-state')).toContainText('Garage is listed on www.taskproxy.com');
    await expect.poll(() => calls(page, 'remote_set_enabled')).toEqual([{ enabled: true, name: 'Garage' }]);
});

test('turning on fails with the reason the backend gives', async ({ page }) => {
    const el = await panel(page, { remote: { enableError: 'api.myfi.ws answered with something unexpected.' } });
    await role(el, 'turn-on').click();
    await expect.poll(() => alerts(page)).toEqual([expect.stringContaining('answered with something unexpected')]);
    await expect(el.locator('.remote-state')).toContainText('Remote Connections is off.');
});

test('a browser asking to connect shows with its code, raises a notice, and can be approved', async ({ page }) => {
    const el = await panel(page, { remote: { enabled: true } });
    await page.evaluate(phone => window.__backend.remote.ask(phone), PHONE);
    const waiting = browser(el.locator('.remote-waiting'), PHONE.key);
    await expect(waiting.locator('.remote-browser-name')).toContainText('Firefox on Android');
    await expect(waiting.locator('.remote-code')).toHaveText('ABC-DEF');
    await expect(el.locator('.remote-check')).toContainText('matches the code on that browser\'s screen');
    await expect.poll(() => alerts(page)).toContain('Firefox on Android is asking to connect to this computer. Check its code in Settings, under Remote Connections.');

    await role(waiting, 'approve').click();
    const approved = browser(el.locator('.remote-approved'), PHONE.key);
    await expect(approved.locator('.remote-browser-name')).toContainText('Firefox on Android');
    await expect(approved.locator('.remote-code')).toHaveText('ABC-DEF');
    await expect(approved.locator('.remote-browser-details')).toContainText('Added ');
    await expect(el.locator('.remote-waiting .remote-none')).toBeVisible();
    await expect.poll(() => calls(page, 'remote_browser_approve')).toEqual([{ key: PHONE.key }]);
});

test('a refused browser leaves the waiting list, and can be allowed to ask again', async ({ page }) => {
    const el = await panel(page, { remote: { enabled: true, waiting: [PHONE, LAPTOP] } });
    await expect(el.locator('.remote-waiting [data-browser]')).toHaveCount(2);
    await role(browser(el.locator('.remote-waiting'), PHONE.key), 'refuse').click();
    await expect(el.locator('.remote-waiting [data-browser]')).toHaveCount(1);
    await expect(browser(el.locator('.remote-waiting'), LAPTOP.key)).toBeVisible();
    await expect(el.locator('.remote-approved .remote-none')).toBeVisible();
    await expect.poll(() => calls(page, 'remote_browser_remove')).toEqual([{ key: PHONE.key }]);

    const refused = browser(el.locator('.remote-refused'), PHONE.key);
    await expect(refused).toContainText('Firefox on Android');
    await role(refused, 'allow').click();
    await expect(el.locator('.remote-refused')).toHaveCount(0);
    await expect.poll(() => calls(page, 'remote_browser_allow')).toEqual([{ key: PHONE.key }]);
});

test('an approved browser lists its name, code and date, and can change level and be removed', async ({ page }) => {
    const added = new Date(2026, 10, 19, 9, 30).getTime();
    const el = await panel(page, { remote: { enabled: true, approved: [{ ...PHONE, added }, LAPTOP] } });
    const phone = browser(el, PHONE.key);
    await expect(phone.locator('.remote-browser-name')).toContainText('Firefox on Android');
    await expect(phone.locator('.remote-code')).toHaveText('ABC-DEF');
    await expect(phone.locator('.remote-browser-details')).toHaveText(`Added ${await page.evaluate(ms => new Date(ms).toLocaleString(), added)}.`);
    await expect(role(phone, 'disconnect')).toHaveCount(0);
    await expect.poll(() => role(phone, 'level').evaluate(d => d.value)).toBe('view');

    await pick(role(phone, 'level'), 'commit');
    await expect.poll(() => calls(page, 'remote_browser_level')).toEqual([{ key: PHONE.key, level: 'commit' }]);
    await expect.poll(() => role(browser(el, PHONE.key), 'level').evaluate(d => d.value)).toBe('commit');

    await role(browser(el, PHONE.key), 'remove').click();
    await expect(openDialog(page)).toContainText('Remove Firefox on Android (ABC-DEF)?');
    await dialogButton(page, 'Remove').click();
    await expect(browser(el, PHONE.key)).toHaveCount(0);
    await expect(browser(el, LAPTOP.key)).toBeVisible();
    await expect.poll(() => calls(page, 'remote_browser_remove')).toEqual([{ key: PHONE.key }]);
});

test('a connected browser says how it connected, and can be disconnected and stay approved', async ({ page }) => {
    const el = await panel(page, { remote: { enabled: true, approved: [{ ...PHONE, connected: true, route: 'Direct (internet)' }] } });
    await expect(browser(el, PHONE.key).locator('.remote-browser-name')).toContainText('(connected now: Direct (internet))');
    await role(browser(el, PHONE.key), 'disconnect').click();
    await expect(browser(el, PHONE.key).locator('.remote-browser-name')).not.toContainText('connected now');
    await expect(browser(el, PHONE.key)).toBeVisible();
    await expect.poll(() => calls(page, 'remote_browser_disconnect')).toEqual([{ key: PHONE.key }]);
});

test('a browser\'s name is shown as text, whatever it calls itself', async ({ page }) => {
    const el = await panel(page, { remote: { enabled: true, waiting: [{ ...PHONE, name: '<img src=x onerror=window.__hit=1>' }] } });
    await expect(browser(el, PHONE.key).locator('.remote-browser-name strong')).toHaveText('<img src=x onerror=window.__hit=1>');
    await expect(el.locator('img')).toHaveCount(0);
    expect(await page.evaluate(() => window.__hit)).toBeUndefined();
});

test('the header shows browsers waiting and connected, and opens the panel', async ({ page }) => {
    await openApp(page, { project: null, myfi: { account: ACCOUNT }, remote: { enabled: true, approved: [LAPTOP] } });
    const indicator = page.locator('header app-remote-connections[indicator]');
    await expect(indicator).toBeHidden();
    await page.evaluate(phone => window.__backend.remote.ask(phone), PHONE);
    await expect(indicator).toBeVisible();
    await expect(indicator).toHaveAttribute('title', 'Remote Connections: Firefox on Android waiting to be approved');
    await page.evaluate(() => {
        window.__backend.remote.waiting = [];
        window.__backend.remote.approved[0].connected = true;
        window.__backend.remote.changed(null);
    });
    await expect(indicator).toHaveAttribute('title', 'Remote Connections: Chrome on Linux connected');
    await indicator.click();
    await expect(openDialog(page).locator('app-remote-connections .remote-browser-name')).toContainText('Chrome on Linux');
});

test('while on, the computer is kept awake, and letting it sleep is saved', async ({ page }) => {
    const el = await panel(page, { remote: { enabled: true } });
    await expect(el.locator('.remote-awake')).toContainText('This computer is kept awake');
    await pick(role(el, 'keep-awake'), 'sleep');
    await expect.poll(() => calls(page, 'remote_settings')).toEqual([{ settings: { keepAwake: false } }]);
    await expect(el.locator('.remote-awake')).toHaveCount(0);
});

test('when the computer can not be kept awake, or the API can not be reached, it says so', async ({ page }) => {
    const el = await panel(page, { remote: {
        enabled: true, awakeError: 'This computer could not be kept awake: no login manager.',
        reachability: { reachable: false, error: 'Could not reach api.myfi.ws: timed out' },
    } });
    await expect(el.locator('.remote-awake-error')).toContainText("no login manager. It may sleep, and browsers can't reach it while it does.");
    await expect(el.locator('.remote-error')).toContainText("browsers can't ask to connect: Could not reach api.myfi.ws: timed out");
});

test('activity lists what browsers did, with why anything was refused', async ({ page }) => {
    const el = await panel(page, { remote: { enabled: true, log: [
        { at: 2000, browser: 'ABC-DEF', browserName: 'Firefox on Android', cmd: 'git_push', ok: false, error: 'This browser can\'t do that.' },
        { at: 1000, browser: 'ABC-DEF', browserName: 'Firefox on Android', cmd: 'connect', ok: true },
    ] } });
    await role(el, 'show-activity').click();
    const entries = el.locator('.remote-log-entries li');
    await expect(entries).toHaveCount(2);
    await expect(entries.nth(0)).toContainText('Firefox on Android (ABC-DEF) git_push, refused: This browser can\'t do that.');
    await expect(entries.nth(1)).toContainText('Firefox on Android (ABC-DEF) connect');
});

test('in a connected browser it shows the two lists, marks this browser, and approves another', async ({ page }) => {
    await page.addInitScript(() => { window.__taskProxyRemote = { deviceName: 'Chrome on Linux', desktopName: 'Desk PC' }; });
    await openApp(page, { project: null, remote: { enabled: true, approved: [LAPTOP], waiting: [PHONE], current: LAPTOP.key } });
    const root = await mount(page, '<app-remote-connections id="r"></app-remote-connections>');
    const el = root.locator('#r');
    await expect(el.locator('.remote-state')).toContainText('browsers that may connect to Desk PC');
    await expect(browser(el, LAPTOP.key).locator('.remote-browser-name')).toContainText('Chrome on Linux XYZ-234 (this browser)');
    // What only the computer may do is not offered, and its status is never asked for.
    await expect(role(el, 'turn-off')).toHaveCount(0);
    await expect(role(el, 'level')).toHaveCount(0);
    await expect(el.locator('.remote-activity')).toHaveCount(0);

    await role(browser(el, PHONE.key), 'approve').click();
    await expect(browser(el.locator('.remote-approved'), PHONE.key)).toContainText('Firefox on Android');
    await expect(el.locator('.remote-waiting .remote-none')).toBeVisible();
    await expect.poll(() => calls(page, 'remote_browser_approve')).toEqual([{ key: PHONE.key }]);
    expect(await calls(page, 'remote_status')).toEqual([]);
});

test('Settings has a Remote Connections tab', async ({ page }) => {
    await openApp(page, { myfi: { account: ACCOUNT } });
    await expect(page.locator('.settings-remote app-remote-connections .remote-state')).toBeHidden();
    await page.locator('webui-button.settings-tab-remote').click();
    await expect(page.locator('.settings-remote app-remote-connections .remote-state')).toBeVisible();
    await expect(page.locator('.settings-remote app-remote-connections .remote-state')).toContainText('Remote Connections is off.');
});
test('it says where to connect from, and the page opens in the browser', async ({ page }) => {
    const el = await panel(page);
    const link = el.locator('.remote-where a');
    await expect(link).toHaveText('www.taskproxy.com/remote/');
    await link.click();
    await expect.poll(() => calls(page, 'open_url')).toEqual([{ url: 'https://www.taskproxy.com/remote/' }]);
});
