// What tests wait for in place of a pause: something the app shows once it has handled an action.

/**
 * The messages the app has popped up with webui.alert that hold `text`. To check that an action did nothing more,
 * wait for the message it shows, then check: `await expect(alertPopup(page, 'Script is empty.')).toHaveCount(1)`.
 */
export function alertPopup(page, text) {
    return page.locator('.webui-alerts-popup webui-alert').filter({ hasText: text });
}
