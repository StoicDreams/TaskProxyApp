//! What a connection is sent, and a browser's request from its offer to its first command.

use super::browsers::{Decision, Level, Store, Waiting};
use super::keys::{self, SigningKey, fixed};
use super::protocol::{
    Assembler, BrowserMessage, DesktopMessage, MAX_BROWSER_MESSAGE, VERSION, split,
};
use super::signal::{self, Status};
use super::*;
use serde_json::json;

fn caller(level: Level) -> Caller {
    Caller {
        key: fixed::PUBLIC_KEY.into(),
        name: "Firefox".into(),
        level,
    }
}

fn hello(version: u32) -> BrowserMessage {
    serde_json::from_value(json!({ "hello": { "version": version } })).unwrap()
}

fn request(id: u64, cmd: &str) -> BrowserMessage {
    serde_json::from_value(json!({ "id": id, "cmd": cmd, "args": {} })).unwrap()
}

fn drain(receiver: &mut UnboundedReceiver<DesktopMessage>) -> Vec<DesktopMessage> {
    let mut messages = Vec::new();
    while let Ok(message) = receiver.try_recv() {
        messages.push(message);
    }
    messages
}

/// A message as it crosses the data channel: split into frames, and put back together.
fn over_the_channel(message: &impl Serialize) -> Value {
    let mut assembler = Assembler::new(MAX_BROWSER_MESSAGE);
    let bytes = split(&serde_json::to_vec(message).unwrap())
        .iter()
        .filter_map(|frame| assembler.push(frame).unwrap())
        .next()
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[test]
fn a_new_browser_is_approved_then_connects_says_hello_and_sends_a_command() {
    const DESK: &str = "3160d8e4-e8dd-43c7-a397-43b17ef46cbc";
    let mut store = Store::default();
    let mut waiting = Waiting::default();
    let computer = store.signing_key().unwrap();
    let browser = SigningKey::generate().unwrap();
    let now = 1_795_000_000_000;
    let text = signal::tests::signed_offer(&browser, DESK, "Firefox on Android", now, "v=0\r\n")
        .to_string();

    // The first offer is kept for approval, and answered with a signed `approval` and no SDP.
    let offer = signal::read_offer(&text, DESK, now).unwrap();
    assert_eq!(
        waiting.decide(&store, &offer, now),
        Decision::Approval { new: true }
    );
    let answer: Value = serde_json::from_str(
        &signal::answer(&computer, "c-1", Status::Approval, &offer.sdp_hash(), None).unwrap(),
    )
    .unwrap();
    assert_eq!(answer["status"], "approval");
    assert!(answer.get("sdp").is_none());
    let lines = signal::answer_lines("c-1", Status::Approval, &offer.sdp_hash(), None);
    assert!(keys::verify(
        &computer.public_key(),
        &lines.each_ref().map(String::as_str),
        answer["sig"].as_str().unwrap()
    ));

    // Someone checks the code against the browser's screen and approves it. Its next offer connects.
    let request_waiting = waiting.take(&browser.public_key(), now).unwrap();
    store.approve(&request_waiting.key, &request_waiting.name, now);
    let Decision::Connect(level) = waiting.decide(&store, &offer, now + 3000) else {
        panic!("an approved browser connects");
    };

    let remote = Remote::default();
    let (id, mut outgoing) = remote.open(Caller {
        key: offer.key.clone(),
        name: offer.name.clone(),
        level,
    });
    let deliver = |message: &BrowserMessage| {
        remote.handle(
            id,
            serde_json::from_value(over_the_channel(message)).unwrap(),
        )
    };
    assert_eq!(deliver(&hello(VERSION)), None);
    let command = deliver(&request(7, "get_runs")).expect("a command to run");
    assert_eq!(
        (&command.request, command.cmd.as_str(), command.caller.level),
        (&json!(7), "get_runs", Level::View)
    );
    remote.finish(id, &command, Ok(json!([])));
    let replies: Vec<Value> = drain(&mut outgoing).iter().map(over_the_channel).collect();
    assert_eq!(
        replies,
        vec![
            json!({ "hello": { "version": 2 } }),
            json!({ "id": 7, "ok": true, "value": [] }),
        ]
    );
    let logged = remote.log.lock().unwrap().latest();
    assert_eq!(logged[0].cmd, "get_runs");
    assert_eq!(
        logged[0].browser,
        keys::browser_code(&browser.public_key()).unwrap()
    );
}

#[test]
fn nothing_runs_before_a_hello_with_this_version() {
    let remote = Remote::default();
    let (id, mut outgoing) = remote.open(caller(Level::Commit));
    assert_eq!(remote.handle(id, request(1, "get_runs")), None);
    assert_eq!(remote.handle(id, hello(VERSION + 1)), None);
    assert_eq!(remote.handle(id, hello(1)), None);
    assert_eq!(remote.handle(id, request(2, "get_runs")), None);
    let sent = drain(&mut outgoing);
    assert!(matches!(&sent[0], DesktopMessage::Reply(reply) if !reply.ok && reply.id == json!(1)));
    assert_eq!(sent[1], DesktopMessage::Reload { reload: true });
    assert_eq!(sent[2], DesktopMessage::Reload { reload: true });
    assert!(matches!(&sent[3], DesktopMessage::Reply(reply) if !reply.ok && reply.id == json!(2)));
    remote.handle(id, hello(VERSION));
    assert!(remote.handle(id, request(3, "get_runs")).is_some());
}

#[test]
fn pings_are_answered_and_ids_come_back_as_they_were_sent() {
    let remote = Remote::default();
    let (id, mut outgoing) = remote.open(caller(Level::View));
    remote.handle(id, serde_json::from_value(json!({ "ping": 42 })).unwrap());
    assert_eq!(
        drain(&mut outgoing),
        vec![DesktopMessage::Pong { pong: json!(42) }]
    );
    remote.handle(id, hello(VERSION));
    let command = remote
        .handle(
            id,
            serde_json::from_value(json!({ "id": "r-1", "cmd": "get_runs" })).unwrap(),
        )
        .unwrap();
    remote.finish(id, &command, Err("No.".into()));
    assert_eq!(
        over_the_channel(&drain(&mut outgoing)[1]),
        json!({ "id": "r-1", "ok": false, "error": "No." })
    );
}

#[test]
fn events_are_numbered_from_1_for_each_connection_that_said_hello() {
    let remote = Remote::default();
    let (first, mut first_out) = remote.open(caller(Level::View));
    let (_second, mut second_out) = remote.open(Caller {
        key: "another".into(),
        ..caller(Level::View)
    });
    remote.handle(first, hello(VERSION));
    drain(&mut first_out);
    remote.send_event("run-changed", &json!({ "a": 1 }));
    remote.send_event("terminal-data", &json!({ "b": 2 }));
    let sent: Vec<Value> = drain(&mut first_out).iter().map(over_the_channel).collect();
    assert_eq!(
        sent,
        vec![
            json!({ "event": "run-changed", "payload": { "a": 1 }, "seq": 1 }),
            json!({ "event": "terminal-data", "payload": { "b": 2 }, "seq": 2 }),
        ]
    );
    assert!(
        drain(&mut second_out).is_empty(),
        "a browser that has not said hello is sent no events"
    );
    assert!(remote.has_connections());
}

#[test]
fn a_lowered_level_applies_to_the_next_command_and_a_removed_browser_is_cut_off() {
    let remote = Remote::default();
    let (id, mut outgoing) = remote.open(caller(Level::Commit));
    let (other, _other_out) = remote.open(Caller {
        key: "another".into(),
        ..caller(Level::View)
    });
    remote.handle(id, hello(VERSION));
    remote.set_level(fixed::PUBLIC_KEY, Level::View);
    assert_eq!(
        remote
            .handle(id, request(1, "git_push"))
            .unwrap()
            .caller
            .level,
        Level::View
    );
    assert!(dispatch::allowed(Level::View, "git_push").is_err());
    drain(&mut outgoing);
    remote.disconnect_browser(fixed::PUBLIC_KEY);
    assert_eq!(remote.handle(id, request(2, "get_runs")), None);
    // What it is sent has ended, which is what ends its connection.
    assert!(matches!(
        outgoing.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Disconnected)
    ));
    assert!(remote.has_connections(), "other browsers stay connected");
    remote.close(other);
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
    assert_eq!(entry.browser_name, "Firefox");
    assert_eq!(entry.browser, fixed::CODE);
}
