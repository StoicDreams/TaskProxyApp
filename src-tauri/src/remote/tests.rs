//! A device connecting from start to finish over an in-process pipe, and what a connection is sent.

use super::devices::{DeviceStore, Level};
use super::noise::{Channel, Handshake, generate_keys, prologue};
use super::protocol::{DesktopMessage, DeviceMessage, MAX_DEVICE_MESSAGE, VERSION};
use super::*;
use serde_json::json;

const ME: &str = "account-1";

fn caller(level: Level) -> Caller {
    Caller {
        device_id: "d1".into(),
        name: "Pixel".into(),
        level,
    }
}

fn hello(version: u32) -> DeviceMessage {
    serde_json::from_value(json!({ "hello": { "version": version } })).unwrap()
}

fn request(id: u64, cmd: &str) -> DeviceMessage {
    serde_json::from_value(json!({ "id": id, "cmd": cmd, "args": {} })).unwrap()
}

fn drain(receiver: &mut UnboundedReceiver<DesktopMessage>) -> Vec<DesktopMessage> {
    let mut messages = Vec::new();
    while let Ok(message) = receiver.try_recv() {
        messages.push(message);
    }
    messages
}

fn send(channel: &mut Channel, to: &mut Channel, message: &impl Serialize) -> Vec<u8> {
    let packets = channel.seal(&serde_json::to_vec(message).unwrap()).unwrap();
    packets
        .iter()
        .filter_map(|packet| to.open(packet).unwrap())
        .next()
        .unwrap()
}

#[test]
fn a_paired_device_connects_says_hello_and_sends_a_command() {
    // Pairing has saved the device, and the desktop's key is on the device.
    let mut store = DeviceStore {
        enabled: true,
        ..Default::default()
    };
    let desktop_keys = store.desktop_keys().unwrap();
    let device_keys = generate_keys().unwrap();
    store.pair("Pixel", &device_keys.public, ME, 0);
    let fingerprints = prologue("AA", "BB");

    // The device starts the handshake, and the desktop finds it by its key before answering.
    let mut phone =
        Handshake::connect_device(&device_keys, &desktop_keys.public, &fingerprints).unwrap();
    let mut desk = Handshake::connect_desktop(&desktop_keys, &fingerprints).unwrap();
    desk.read(&phone.write(b"").unwrap()).unwrap();
    let device = store
        .find(&desk.remote_key().unwrap(), ME, Some(ME), 1)
        .unwrap()
        .clone();
    phone.read(&desk.write(b"").unwrap()).unwrap();
    let (mut desk, mut phone) = (
        desk.finish(MAX_DEVICE_MESSAGE).unwrap(),
        phone.finish(usize::MAX).unwrap(),
    );

    let remote = Remote::default();
    let (id, mut outgoing) = remote.open(Caller {
        device_id: device.id.clone(),
        name: device.name.clone(),
        level: device.level,
    });
    let mut deliver = |message: &DeviceMessage| {
        let bytes = send(&mut phone, &mut desk, message);
        remote.handle(id, serde_json::from_slice(&bytes).unwrap())
    };
    assert_eq!(deliver(&hello(VERSION)), None);
    let command = deliver(&request(7, "get_runs")).expect("a command to run");
    assert_eq!(
        (command.request, command.cmd.as_str(), command.caller.level),
        (7, "get_runs", Level::View)
    );
    remote.finish(id, &command, Ok(json!([])));
    let replies: Vec<Value> = drain(&mut outgoing)
        .iter()
        .map(|message| serde_json::from_slice(&send(&mut desk, &mut phone, message)).unwrap())
        .collect();
    assert_eq!(
        replies,
        vec![
            json!({ "welcome": { "version": VERSION, "reload": false } }),
            json!({ "id": 7, "ok": true, "value": [] }),
        ]
    );
    assert_eq!(remote.log.lock().unwrap().latest()[0].cmd, "get_runs");
}

#[test]
fn nothing_runs_before_a_hello_with_this_version() {
    let remote = Remote::default();
    let (id, mut outgoing) = remote.open(caller(Level::Commit));
    assert_eq!(remote.handle(id, request(1, "get_runs")), None);
    assert_eq!(remote.handle(id, hello(VERSION + 1)), None);
    assert_eq!(remote.handle(id, request(2, "get_runs")), None);
    let sent = drain(&mut outgoing);
    assert!(matches!(&sent[0], DesktopMessage::Reply(reply) if !reply.ok && reply.id == 1));
    assert!(matches!(&sent[1], DesktopMessage::Welcome { welcome } if welcome.reload));
    assert!(matches!(&sent[2], DesktopMessage::Reply(reply) if !reply.ok && reply.id == 2));
    remote.handle(id, hello(VERSION));
    assert!(remote.handle(id, request(3, "get_runs")).is_some());
}

#[test]
fn pings_are_answered() {
    let remote = Remote::default();
    let (id, mut outgoing) = remote.open(caller(Level::View));
    remote.handle(id, serde_json::from_value(json!({ "ping": 42 })).unwrap());
    assert_eq!(
        drain(&mut outgoing),
        vec![DesktopMessage::Pong { pong: 42 }]
    );
}

#[test]
fn events_are_numbered_for_each_connection_that_said_hello() {
    let remote = Remote::default();
    let (first, mut first_out) = remote.open(caller(Level::View));
    let (_second, mut second_out) = remote.open(Caller {
        device_id: "d2".into(),
        ..caller(Level::View)
    });
    remote.handle(first, hello(VERSION));
    drain(&mut first_out);
    remote.send_event("run-changed", &json!({ "a": 1 }));
    remote.send_event("terminal-data", &json!({ "b": 2 }));
    let seqs: Vec<u64> = drain(&mut first_out)
        .into_iter()
        .map(|message| match message {
            DesktopMessage::Event { seq, .. } => seq,
            other => panic!("{:?}", other),
        })
        .collect();
    assert_eq!(seqs, vec![1, 2]);
    assert!(
        drain(&mut second_out).is_empty(),
        "a device that has not said hello is sent no events"
    );
    assert!(remote.has_connections());
}

#[test]
fn a_lowered_level_applies_to_the_next_command_and_a_removed_device_is_cut_off() {
    let remote = Remote::default();
    let (id, _outgoing) = remote.open(caller(Level::Commit));
    remote.handle(id, hello(VERSION));
    remote.set_level("d1", Level::View);
    assert_eq!(
        remote
            .handle(id, request(1, "git_push"))
            .unwrap()
            .caller
            .level,
        Level::View
    );
    assert!(dispatch::allowed(Level::View, "git_push").is_err());
    remote.disconnect_device("d1");
    assert_eq!(remote.handle(id, request(2, "get_runs")), None);
    assert!(!remote.has_connections());
}

#[test]
fn the_log_records_failures_with_their_reason() {
    let remote = Remote::default();
    let (id, _outgoing) = remote.open(caller(Level::View));
    remote.handle(id, hello(VERSION));
    let command = remote.handle(id, request(1, "git_push")).unwrap();
    remote.finish(
        id,
        &command,
        dispatch::allowed(Level::View, "git_push").map(|_| Value::Null),
    );
    let entry = &remote.log.lock().unwrap().latest()[0];
    assert!(!entry.ok);
    assert!(entry.error.as_ref().unwrap().contains("Commit"));
    assert_eq!(entry.device_name, "Pixel");
}
