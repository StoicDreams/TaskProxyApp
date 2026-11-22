// What tests wait for in place of a pause: something the app shows once it has handled an action.

/**
 * The messages the app has popped up with webui.alert that hold `text`. To check that an action did nothing more,
 * wait for the message it shows, then check: `await expect(alertPopup(page, 'Script is empty.')).toHaveCount(1)`.
 */
export function alertPopup(page, text) {
    return page.locator('.webui-alerts-popup webui-alert').filter({ hasText: text });
}
/** An alert shown by the button an action came from (actionNote in app.js), saying what it did, with this text. */
export function actionNote(scope, text) {
    return scope.locator('webui-alert.action-note[show]').filter({ hasText: text });
}
/**
 * Records the text of each message shown with webui.alert from now on, which alerts() returns. Any markup in a
 * message is read as its text. With `{ variant: true }`, each is recorded as `[text, variant]`.
 */
export async function spyOnAlerts(page, { variant = false } = {}) {
    // The header's webui-alerts replaces webui.alert once it loads (setting window.webuiAlert to it), which would drop
    // a spy put on before it.
    await page.waitForFunction(() => window.webuiAlert === webui.alert);
    await page.evaluate(variant => {
        window.__alerts = [];
        const original = webui.alert;
        webui.alert = function (...args) {
            const shown = document.createElement('template');
            shown.innerHTML = `${args[0]}`;
            window.__alerts.push(variant ? [shown.content.textContent, args[1]] : shown.content.textContent);
            return original.apply(this, args);
        };
    }, variant);
}
/** The text of the messages shown with webui.alert since spyOnAlerts. */
export function alerts(page) {
    return page.evaluate(() => window.__alerts);
}
