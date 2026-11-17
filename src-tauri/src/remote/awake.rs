//! Keeps the computer from sleeping while Remote Access is on, so devices can still reach it: systemd's inhibitor
//! locks on Linux, a power assertion on macOS, and `SetThreadExecutionState` on Windows (`keepawake`).
//!
//! Windows keeps a computer awake only for the thread that asked, so the request is held on a thread of its own,
//! which lets go when this is dropped.

use std::sync::mpsc;
use std::thread;

/// Held while the computer is kept awake.
pub(crate) struct Awake {
    stop: Option<mpsc::Sender<()>>,
}

impl Drop for Awake {
    fn drop(&mut self) {
        // The thread lets go once the sender is gone.
        self.stop.take();
    }
}

/// Asks the system to keep the computer from sleeping or going idle. The screen may still turn off.
pub(crate) fn hold() -> Result<Awake, String> {
    let (stop, stopped) = mpsc::channel::<()>();
    let (started, result) = mpsc::channel::<Result<(), String>>();
    thread::Builder::new()
        .name("remote-keep-awake".into())
        .spawn(move || {
            let held = keepawake::Builder::default()
                .idle(true)
                .sleep(true)
                .display(false)
                .reason("Remote Access is on, so your devices can reach this computer")
                .app_name("Task Proxy")
                .app_reverse_domain("com.task-proxy.app")
                .create();
            match held {
                Ok(guard) => {
                    let _ = started.send(Ok(()));
                    // Waits until the Awake is dropped, then lets go.
                    let _ = stopped.recv();
                    drop(guard);
                }
                Err(err) => {
                    let _ = started.send(Err(format!(
                        "This computer could not be kept awake: {}",
                        err
                    )));
                }
            }
        })
        .map_err(|err| err.to_string())?;
    result
        .recv()
        .map_err(|err| err.to_string())?
        .map(|_| Awake { stop: Some(stop) })
}
