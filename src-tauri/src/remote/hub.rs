//! Sends an event to the window and to every connected device. Only events listed in `DEVICE_EVENTS` reach a
//! device, and a change to data reaches it with its secrets replaced by the marker.

use super::Remote;
use crate::prelude::*;
use tauri::Emitter;

/// The events a device is sent. Each needs only the View level.
pub(crate) const DEVICE_EVENTS: &[&str] = &[
    "run-changed",
    "terminal-data",
    "commit-jobs-changed",
    "data-changed",
];

/// Whether any device is connected, so work done only for devices can be skipped.
pub(crate) fn has_devices(app: &AppHandle) -> bool {
    app.try_state::<Remote>()
        .is_some_and(|remote| remote.has_connections())
}

/// Sends an event to the window and to every device.
pub(crate) fn broadcast<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    let for_devices = has_devices(app)
        .then(|| serde_json::to_value(&payload).ok())
        .flatten();
    let _ = app.emit(event, payload);
    if let Some(payload) = for_devices {
        to_devices(app, event, payload);
    }
}

/// Sends an event to the window, and `for_devices` in its place to every device, as for a change carrying
/// secrets. `for_devices` is only made when a device is connected.
pub(crate) fn broadcast_redacted<S: Serialize + Clone>(
    app: &AppHandle,
    event: &str,
    payload: S,
    for_devices: impl FnOnce() -> Option<Value>,
) {
    let _ = app.emit(event, payload);
    if has_devices(app)
        && let Some(payload) = for_devices()
    {
        to_devices(app, event, payload);
    }
}

fn to_devices(app: &AppHandle, event: &str, payload: Value) {
    if !DEVICE_EVENTS.contains(&event) {
        return;
    }
    if let Some(remote) = app.try_state::<Remote>() {
        remote.send_event(event, &payload);
    }
}
