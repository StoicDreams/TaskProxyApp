//! Sends an event to the window and to every connected browser. Only events listed in `BROWSER_EVENTS` reach a
//! browser, and a change to data reaches it with its secrets replaced by the marker.

use super::Remote;
use crate::prelude::*;
use tauri::Emitter;

/// The events a browser is sent. Each needs only the View level.
pub(crate) const BROWSER_EVENTS: &[&str] = &[
    "run-changed",
    "terminal-data",
    "commit-jobs-changed",
    "data-changed",
];

/// Whether any browser is connected, so work done only for browsers can be skipped.
pub(crate) fn has_browsers(app: &AppHandle) -> bool {
    app.try_state::<Remote>()
        .is_some_and(|remote| remote.has_connections())
}

/// Sends an event to the window and to every browser.
pub(crate) fn broadcast<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    let for_browsers = has_browsers(app)
        .then(|| serde_json::to_value(&payload).ok())
        .flatten();
    let _ = app.emit(event, payload);
    if let Some(payload) = for_browsers {
        to_browsers(app, event, payload);
    }
}

/// Sends an event to the window, and `for_browsers` in its place to every browser, as for a change carrying
/// secrets. `for_browsers` is only made when a browser is connected.
pub(crate) fn broadcast_redacted<S: Serialize + Clone>(
    app: &AppHandle,
    event: &str,
    payload: S,
    for_browsers: impl FnOnce() -> Option<Value>,
) {
    let _ = app.emit(event, payload);
    if has_browsers(app)
        && let Some(payload) = for_browsers()
    {
        to_browsers(app, event, payload);
    }
}

fn to_browsers(app: &AppHandle, event: &str, payload: Value) {
    if !BROWSER_EVENTS.contains(&event) {
        return;
    }
    if let Some(remote) = app.try_state::<Remote>() {
        remote.send_event(event, &payload);
    }
}
