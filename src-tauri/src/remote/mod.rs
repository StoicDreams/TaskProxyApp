//! Remote Connections: using this computer's Task Proxy from a browser on www.taskproxy.com, signed in to the same
//! MyFi account. The two talk directly over WebRTC, and api.myfi.ws only passes one offer and one answer between
//! them. The contract with the website is the Remote Connections Protocol page in the Api repository.
//!
//! - `keys.rs` signs and verifies, and `signal.rs` reads a browser's signed offer and writes this computer's signed
//!   answer.
//! - `browsers.rs` keeps the approved browsers and the ones waiting, only on this computer.
//! - `stun.rs` asks the STUN server for this computer's public address, and `webrtc.rs` answers an offer and runs
//!   the connection with `str0m`.
//! - `protocol.rs` says what crosses the data channel, and how messages are split into frames.
//! - `dispatch.rs` runs a browser's commands at its level, with secrets redacted.
//! - `app_files.rs` gives a browser the app's own files, so it runs the same frontend as the window.
//! - `hub.rs` sends events to the window and to browsers, and `audit.rs` logs every command a browser sends.
//! - `awake.rs` keeps the computer from sleeping while Remote Connections is on.
//! - `service.rs` talks to api.myfi.ws, turns Remote Connections on and off, and has the Settings panel's commands.
//!
//! Once a browser's data channel opens, its connection calls `Remote::open`, passes each message to `receive`, and
//! sends what the returned receiver yields.

pub(crate) mod app_files;
pub(crate) mod audit;
pub(crate) mod awake;
pub(crate) mod browsers;
pub(crate) mod dispatch;
pub(crate) mod hub;
pub(crate) mod keys;
pub(crate) mod protocol;
pub(crate) mod service;
pub(crate) mod signal;
pub(crate) mod stun;
pub(crate) mod webrtc;

use crate::prelude::*;
use browsers::Level;
use dispatch::Caller;
use protocol::{BrowserMessage, DesktopMessage, Reply};
use std::sync::atomic::AtomicU64;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// A connected browser.
struct Connection {
    caller: Caller,
    sender: UnboundedSender<DesktopMessage>,
    /// Whether the browser said hello with this computer's protocol version. Until then it may only say hello.
    ready: bool,
    /// The last event's number.
    seq: u64,
    /// How it reached this computer, such as Direct (same network).
    route: String,
}

/// Remote Connections' state: the approved and waiting browsers, the log, and the browsers connected now.
#[derive(Default)]
pub(crate) struct Remote {
    pub store: Mutex<browsers::Store>,
    pub waiting: Mutex<browsers::Waiting>,
    pub log: Mutex<audit::AuditLog>,
    connections: Mutex<HashMap<u64, Connection>>,
    next: AtomicU64,
    /// Asking api.myfi.ws for connection requests, while Remote Connections is on.
    pub poller: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    pub reachability: Mutex<service::Reachability>,
    /// Held while the computer is kept awake, and why it couldn't be when it failed.
    pub awake: Mutex<Option<awake::Awake>>,
    pub awake_error: Mutex<Option<String>>,
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

    /// Starts serving a browser whose data channel opened. Returns the connection's id, and what to send it.
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
                    route: String::new(),
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

    /// Notes how a connection reached this computer, shown with its browser.
    pub(crate) fn set_route(&self, id: u64, route: &str) {
        if let Ok(mut connections) = self.connections.lock()
            && let Some(connection) = connections.get_mut(&id)
        {
            connection.route = route.into();
        }
    }

    /// How each connected browser reached this computer, by its key.
    pub(crate) fn routes(&self) -> HashMap<String, String> {
        self.connections
            .lock()
            .map(|connections| {
                connections
                    .values()
                    .map(|connection| (connection.caller.key.clone(), connection.route.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(crate) fn disconnect_all(&self) {
        if let Ok(mut connections) = self.connections.lock() {
            connections.clear();
        }
    }

    /// Ends every connection of a browser, as when it is removed. Dropping what it is sent ends its WebRTC loop.
    pub(crate) fn disconnect_browser(&self, key: &str) {
        if let Ok(mut connections) = self.connections.lock() {
            connections.retain(|_, connection| connection.caller.key != key);
        }
    }

    /// Changes a connected browser's level at once, so a lowered level applies to its next command.
    pub(crate) fn set_level(&self, key: &str, level: Level) {
        if let Ok(mut connections) = self.connections.lock() {
            for connection in connections
                .values_mut()
                .filter(|connection| connection.caller.key == key)
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

    /// The connection's browser as it is now, and whether it said hello.
    fn caller(&self, id: u64) -> Option<(Caller, bool)> {
        let connections = self.connections.lock().ok()?;
        connections
            .get(&id)
            .map(|connection| (connection.caller.clone(), connection.ready))
    }

    /// Adds a line to the log of what browsers did.
    pub(crate) fn record(&self, key: &str, name: &str, cmd: &str, result: Result<(), String>) {
        if let Ok(mut log) = self.log.lock() {
            log.record(audit::Entry {
                at: now_ms(),
                browser: keys::browser_code(key).unwrap_or_default(),
                browser_name: name.into(),
                cmd: cmd.into(),
                ok: result.is_ok(),
                error: result.err(),
            });
        }
    }
}

/// A command a browser may run: the browser as it is now, and the request.
#[derive(Debug, PartialEq)]
pub(crate) struct Command {
    pub caller: Caller,
    pub request: Value,
    pub cmd: String,
    pub args: Value,
}

impl Remote {
    /// Answers what needs no command, such as a hello or a ping, and returns a request to run.
    pub(crate) fn handle(&self, id: u64, message: BrowserMessage) -> Option<Command> {
        let (caller, ready) = self.caller(id)?;
        match message {
            BrowserMessage::Hello { hello } => {
                let answer = protocol::answer_hello(&hello);
                if let Ok(mut connections) = self.connections.lock()
                    && let Some(connection) = connections.get_mut(&id)
                {
                    connection.ready = matches!(answer, DesktopMessage::Hello { .. });
                }
                self.send(id, answer);
                None
            }
            BrowserMessage::Ping { ping } => {
                self.send(id, DesktopMessage::Pong { pong: ping });
                None
            }
            BrowserMessage::Request {
                id: request,
                cmd,
                args,
            } => {
                if !ready {
                    let refused = Err(String::from(
                        "Say hello with this computer's version first.",
                    ));
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

    /// Logs a command's result and sends it to the browser.
    pub(crate) fn finish(&self, id: u64, command: &Command, result: Result<Value, String>) {
        self.record(
            &command.caller.key,
            &command.caller.name,
            &command.cmd,
            result.as_ref().map(|_| ()).map_err(String::clone),
        );
        self.send(
            id,
            DesktopMessage::Reply(Reply::new(command.request.clone(), result)),
        );
    }
}

/// Handles a message from a connected browser. A command runs in the background, and its reply is sent when it
/// finishes, so a slow one, such as a pull, doesn't hold up the rest.
pub(crate) fn receive(app: &AppHandle, id: u64, message: BrowserMessage) {
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

/// Loads the approved browsers and the log, at startup, and carries on if Remote Connections was on.
pub(crate) async fn load(app: AppHandle) {
    match browsers::load(&app).await {
        Ok(store) => {
            if let Ok(mut current) = app.state::<Remote>().store.lock() {
                *current = store;
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

#[cfg(test)]
mod tests;
