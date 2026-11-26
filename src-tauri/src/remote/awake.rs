//! Keeps the computer from sleeping while Remote Connections is on, so browsers can still reach it: systemd's inhibitor
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

/// Whether the computer is kept from going idle as well as from sleeping. On Windows and macOS, that is what keeps
/// it from sleeping when no one uses it (`ES_SYSTEM_REQUIRED`, `PreventUserIdleSystemSleep`), and the screens still
/// turn off. On Linux, systemd's sleep lock alone keeps it from suspending, and an idle lock also keeps the desktop
/// from turning the screens off, so it is not asked for.
const BLOCK_IDLE: bool = !cfg!(target_os = "linux");

/// Asks the system to keep the computer from sleeping. The screens still turn off.
pub(crate) fn hold() -> Result<Awake, String> {
    let (stop, stopped) = mpsc::channel::<()>();
    let (started, result) = mpsc::channel::<Result<(), String>>();
    thread::Builder::new()
        .name("remote-keep-awake".into())
        .spawn(move || {
            let held = keepawake::Builder::default()
                .idle(BLOCK_IDLE)
                .sleep(true)
                .display(false)
                .reason("Remote Connections is on, so your browsers can reach this computer")
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
