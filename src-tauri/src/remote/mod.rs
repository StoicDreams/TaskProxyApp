//! Remote Access: using this desktop's Task Proxy from a paired phone or laptop (Docs/RemoteAccess.md).
//!
//! - `app_files.rs` gives a device the app's own files, so it runs the same frontend as the window.
//! - `noise.rs` encrypts the connection, and `protocol.rs` says what crosses it.
//! - `devices.rs` keeps the paired devices, and checks each connection's key and MyFi account.
//! - `dispatch.rs` runs a device's commands at its level, with secrets redacted.
//! - `hub.rs` sends events to the window and to devices.
//! - `audit.rs` logs every command a device sends.
//! - `mailbox.rs` talks to api.myfi.ws, `pairing.rs` pairs a device through it, and `service.rs` turns Remote Access
//!   on and off and reads the mailbox.
//!
//! A device connects through the mailbox (`connect.rs`) and then over WebRTC (`webrtc.rs`): once its data channel
//! opens, the connection calls `Remote::open`, passes each message it decrypts to `receive`, and sends what the
//! returned receiver yields.

pub(crate) mod app_files;
pub(crate) mod audit;
pub(crate) mod awake;
pub(crate) mod connect;
pub(crate) mod devices;
pub(crate) mod dispatch;
pub(crate) mod hub;
pub(crate) mod mailbox;
pub(crate) mod noise;
pub(crate) mod pairing;
pub(crate) mod protocol;
pub(crate) mod service;
pub(crate) mod webrtc;

use crate::prelude::*;
use dispatch::Caller;
use protocol::{DesktopMessage, DeviceMessage, Reply};
use std::sync::atomic::AtomicU64;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// A connected device.
struct Connection {
    caller: Caller,
    sender: UnboundedSender<DesktopMessage>,
    /// Whether the device said hello with this desktop's protocol version. Until then it may only say hello.
    ready: bool,
    /// The last event's number.
    seq: u64,
    /// How it reached the desktop, such as Direct (same network).
    route: String,
}

/// Remote Access's state: the paired devices, the log, and the devices connected now.
#[derive(Default)]
pub(crate) struct Remote {
    pub devices: Mutex<devices::DeviceStore>,
    pub log: Mutex<audit::AuditLog>,
    connections: Mutex<HashMap<u64, Connection>>,
    next: AtomicU64,
    /// The open QR code and the pairings under way.
    pub pairing: Mutex<pairing::Pairing>,
    /// The open QR code as the panel shows it.
    pub invite_status: Mutex<Option<service::InviteStatus>>,
    /// The MyFi session the mailbox is read with, so the keychain isn't read every poll.
    pub session: Mutex<Option<String>>,
    /// Reading the mailbox, while Remote Access is on.
    pub poller: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    pub reachability: Mutex<service::Reachability>,
    /// Held while the computer is kept awake, and why it couldn't be when it failed.
    pub awake: Mutex<Option<awake::Awake>>,
    pub awake_error: Mutex<Option<String>>,
    /// When a device last connected, sent something, or paired, or Remote Access turned on, for turning off when idle.
    last_activity: AtomicU64,
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|time| time.as_millis() as u64)
        .unwrap_or(0)
}

impl Remote {
    pub(crate) fn has_connections(&self) -> bool {
        self.connections
            .lock()
            .is_ok_and(|connections| !connections.is_empty())
    }

    /// Starts serving a device whose handshake finished. Returns the connection's id, and what to send it.
    pub(crate) fn open(&self, caller: Caller) -> (u64, UnboundedReceiver<DesktopMessage>) {
        self.touch();
        let (sender, receiver) = unbounded_channel();
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        if let Ok(mut connections) = self.connections.lock() {
            connections.insert(
                id,
                Connection {
                    caller,
                    sender,
                    ready: false,
                    seq: 0,
                    route: String::new(),
                },
            );
        }
        (id, receiver)
    }

    pub(crate) fn close(&self, id: u64) {
        self.touch();
        if let Ok(mut connections) = self.connections.lock() {
            connections.remove(&id);
        }
    }

    /// Notes activity now, which keeps Remote Access from turning off as idle.
    pub(crate) fn touch(&self) {
        self.last_activity.store(now_ms(), Ordering::SeqCst);
    }

    pub(crate) fn last_activity(&self) -> u64 {
        self.last_activity.load(Ordering::SeqCst)
    }

    /// Notes how a connection reached the desktop, shown with its device.
    pub(crate) fn set_route(&self, id: u64, route: &str) {
        if let Ok(mut connections) = self.connections.lock()
            && let Some(connection) = connections.get_mut(&id)
        {
            connection.route = route.into();
        }
    }

    /// How each connected device reached the desktop, by device id.
    pub(crate) fn routes(&self) -> HashMap<String, String> {
        self.connections
            .lock()
            .map(|connections| {
                connections
                    .values()
                    .map(|connection| {
                        (
                            connection.caller.device_id.clone(),
                            connection.route.clone(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The ids of the devices connected now.
    pub(crate) fn connected_devices(&self) -> Vec<String> {
        self.connections
            .lock()
            .map(|connections| {
                connections
                    .values()
                    .map(|connection| connection.caller.device_id.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(crate) fn disconnect_all(&self) {
        if let Ok(mut connections) = self.connections.lock() {
            connections.clear();
        }
    }

    /// Ends every connection of a device, as when it is removed.
    pub(crate) fn disconnect_device(&self, device_id: &str) {
        if let Ok(mut connections) = self.connections.lock() {
            connections.retain(|_, connection| connection.caller.device_id != device_id);
        }
    }

    /// Changes a connected device's level at once, so a lowered level applies to its next command.
    pub(crate) fn set_level(&self, device_id: &str, level: devices::Level) {
        if let Ok(mut connections) = self.connections.lock() {
            for connection in connections
                .values_mut()
                .filter(|connection| connection.caller.device_id == device_id)
            {
                connection.caller.level = level;
            }
        }
    }

    /// Sends an event to every connection that said hello.
    pub(crate) fn send_event(&self, event: &str, payload: &Value) {
        if let Ok(mut connections) = self.connections.lock() {
            for connection in connections
                .values_mut()
                .filter(|connection| connection.ready)
            {
                connection.seq += 1;
                let _ = connection.sender.send(DesktopMessage::Event {
                    event: event.into(),
                    payload: payload.clone(),
                    seq: connection.seq,
                });
            }
        }
    }

    fn send(&self, id: u64, message: DesktopMessage) {
        if let Ok(connections) = self.connections.lock()
            && let Some(connection) = connections.get(&id)
        {
            let _ = connection.sender.send(message);
        }
    }

    /// The connection's device as it is now, and whether it said hello.
    fn caller(&self, id: u64) -> Option<(Caller, bool)> {
        let connections = self.connections.lock().ok()?;
        connections
            .get(&id)
            .map(|connection| (connection.caller.clone(), connection.ready))
    }

    fn record(&self, caller: &Caller, cmd: &str, result: &Result<Value, String>) {
        if let Ok(mut log) = self.log.lock() {
            log.record(audit::Entry {
                at: now_ms(),
                device_id: caller.device_id.clone(),
                device_name: caller.name.clone(),
                cmd: cmd.into(),
                ok: result.is_ok(),
                error: result.as_ref().err().cloned(),
            });
        }
    }
}

/// A command a device may run: its connection, the device as it is now, and the request.
#[derive(Debug, PartialEq)]
pub(crate) struct Command {
    pub caller: Caller,
    pub request: u64,
    pub cmd: String,
    pub args: Value,
}

impl Remote {
    /// Answers what needs no command, such as a hello or a ping, and returns a request to run.
    pub(crate) fn handle(&self, id: u64, message: DeviceMessage) -> Option<Command> {
        let (caller, ready) = self.caller(id)?;
        self.touch();
        match message {
            DeviceMessage::Hello { hello } => {
                let welcome = protocol::welcome(&hello);
                if let Ok(mut connections) = self.connections.lock()
                    && let Some(connection) = connections.get_mut(&id)
                {
                    connection.ready = !welcome.reload;
                }
                self.send(id, DesktopMessage::Welcome { welcome });
                None
            }
            DeviceMessage::Ping { ping } => {
                self.send(id, DesktopMessage::Pong { pong: ping });
                None
            }
            DeviceMessage::Request {
                id: request,
                cmd,
                args,
            } => {
                if !ready {
                    let refused = Err(String::from("Say hello with this desktop's version first."));
                    self.send(id, DesktopMessage::Reply(Reply::new(request, refused)));
                    return None;
                }
                Some(Command {
                    caller,
                    request,
                    cmd,
                    args,
                })
            }
        }
    }

    /// Logs a command's result and sends it to the device.
    pub(crate) fn finish(&self, id: u64, command: &Command, result: Result<Value, String>) {
        self.record(&command.caller, &command.cmd, &result);
        self.send(
            id,
            DesktopMessage::Reply(Reply::new(command.request, result)),
        );
    }
}

/// Handles a message from a connected device. A command runs in the background, and its reply is sent when it
/// finishes, so a slow one, such as a pull, doesn't hold up the rest.
pub(crate) fn receive(app: &AppHandle, id: u64, message: DeviceMessage) {
    let Some(command) = app.state::<Remote>().handle(id, message) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result =
            dispatch::dispatch(&app, &command.caller, &command.cmd, command.args.clone()).await;
        app.state::<Remote>().finish(id, &command, result);
    });
}

/// Loads the paired devices and the log, at startup. Pairings that expired are dropped.
pub(crate) async fn load(app: AppHandle) {
    match devices::load(&app).await {
        Ok(mut store) => {
            if store.prune(now_ms()) > 0 {
                let _ = devices::save(&app, &store).await;
            }
            if let Ok(mut devices) = app.state::<Remote>().devices.lock() {
                *devices = store;
            }
        }
        Err(err) => eprintln!("{}", err),
    }
    match audit::load(&app).await {
        Ok(log) => {
            if let Ok(mut current) = app.state::<Remote>().log.lock() {
                *current = log;
            }
        }
        Err(err) => eprintln!("{}", err),
    }
    service::resume(app).await;
}

/// Saves the log of remote commands, if it changed.
pub(crate) async fn save_log(app: &AppHandle) -> Result<(), String> {
    match app.try_state::<Remote>() {
        Some(remote) => audit::save(app, &remote.log).await,
        None => Ok(()),
    }
}

/// Turns Remote Access off, ends every connection, and forgets every device and the desktop's key, as signing out
/// of MyFi does.
pub(crate) async fn forget_all(app: &AppHandle) -> Result<(), String> {
    let Some(remote) = app.try_state::<Remote>() else {
        return Ok(());
    };
    service::unregister(app).await;
    let store = {
        let mut devices = remote.devices.lock().map_err(|err| err.to_string())?;
        devices.forget_all();
        devices.clone()
    };
    remote.disconnect_all();
    devices::save(app, &store).await?;
    let _ = tauri::Emitter::emit(app, service::CHANGED, serde_json::json!({ "notice": null }));
    Ok(())
}

#[cfg(test)]
mod tests;
