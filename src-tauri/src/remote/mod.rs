//! Remote Access: using this desktop's Task Proxy from a paired phone or laptop (Docs/RemoteAccess.md).
//!
//! - `noise.rs` encrypts the connection, and `protocol.rs` says what crosses it.
//! - `devices.rs` keeps the paired devices, and checks each connection's key and MyFi account.
//! - `dispatch.rs` runs a device's commands at its level, with secrets redacted.
//! - `hub.rs` sends events to the window and to devices.
//! - `audit.rs` logs every command a device sends.
//!
//! Nothing listens for connections yet. Phase 2 carries a connection over WebRTC: once its handshake finishes and
//! `devices.rs` has found the device, it calls `Remote::open`, passes each message it decrypts to `receive`, and
//! sends what the returned receiver yields.

// Phase 2 connects devices, and calls what nothing calls yet. Remove this then.
#![allow(dead_code)]

pub(crate) mod audit;
pub(crate) mod devices;
pub(crate) mod dispatch;
pub(crate) mod hub;
pub(crate) mod noise;
pub(crate) mod protocol;

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
}

/// Remote Access's state: the paired devices, the log, and the devices connected now.
#[derive(Default)]
pub(crate) struct Remote {
    pub devices: Mutex<devices::DeviceStore>,
    pub log: Mutex<audit::AuditLog>,
    connections: Mutex<HashMap<u64, Connection>>,
    next: AtomicU64,
}

fn now_ms() -> u64 {
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
                },
            );
        }
        (id, receiver)
    }

    pub(crate) fn close(&self, id: u64) {
        if let Ok(mut connections) = self.connections.lock() {
            connections.remove(&id);
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
    let store = {
        let mut devices = remote.devices.lock().map_err(|err| err.to_string())?;
        devices.forget_all();
        devices.clone()
    };
    if let Ok(mut connections) = remote.connections.lock() {
        connections.clear();
    }
    devices::save(app, &store).await
}

#[cfg(test)]
mod tests;
