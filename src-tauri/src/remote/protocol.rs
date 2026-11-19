//! What this computer and a browser say to each other on the data channel (the Remote Connections Protocol page).
//! WebRTC encrypts the connection, and the signed offer and answer tie that encryption to the two keys, so nothing
//! more is encrypted on top.
//!
//! - A browser starts with `{"hello": {"version": 2}}`, and is answered `{"hello": {"version": 2}}`. A browser
//!   built for another version is answered `{"reload": true}`, since its app code comes from this computer.
//! - `{id, cmd, args}` gets back `{id, ok: true, value}` or `{id, ok: false, error}`.
//! - Events are `{event, payload, seq}`, numbered from 1 for each connection, so a browser can tell it missed one.
//! - `{"ping": n}` gets back `{"pong": n}`. A browser pings every 15 seconds.
//!
//! Every message is one JSON value in UTF-8, split into binary frames: a flag byte, `0` for more to come or `1` for
//! the last, then up to 16,383 bytes (`split` and `Assembler`).

use crate::prelude::*;

/// The protocol's version. Raise it for any change a browser built for the old one cannot follow.
pub(crate) const VERSION: u32 = 2;
/// The most a frame carries after its flag byte, so a frame is at most 16 KB, which every browser's data channel
/// takes in one message.
pub(crate) const FRAME_DATA: usize = 16 * 1024 - 1;
/// The largest message a browser may send, so a browser cannot fill this computer's memory. Messages from this
/// computer, such as a file's contents, are not limited by this.
pub(crate) const MAX_BROWSER_MESSAGE: usize = 16 * 1024 * 1024;

const MORE: u8 = 0;
const LAST: u8 = 1;

/// A message from a browser.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub(crate) enum BrowserMessage {
    Hello {
        hello: Hello,
    },
    /// The number is sent back as it came.
    Ping {
        ping: Value,
    },
    /// The id is the browser's to choose, and is sent back as it came.
    Request {
        id: Value,
        cmd: String,
        #[serde(default)]
        args: Value,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Hello {
    pub version: u32,
}

/// A message from the desktop.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub(crate) enum DesktopMessage {
    /// The answer to a hello with this computer's version.
    Hello {
        hello: Hello,
    },
    /// The answer to a hello with another version: the browser must reload to match this computer's.
    Reload {
        reload: bool,
    },
    Pong {
        pong: Value,
    },
    Reply(Reply),
    Event {
        event: String,
        payload: Value,
        seq: u64,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Reply {
    pub id: Value,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Reply {
    pub(crate) fn new(id: Value, result: Result<Value, String>) -> Self {
        match result {
            Ok(value) => Self {
                id,
                ok: true,
                value: Some(value),
                error: None,
            },
            Err(error) => Self {
                id,
                ok: false,
                value: None,
                error: Some(error),
            },
        }
    }
}

/// This computer's answer to a browser's hello.
pub(crate) fn answer_hello(hello: &Hello) -> DesktopMessage {
    if hello.version == VERSION {
        DesktopMessage::Hello {
            hello: Hello { version: VERSION },
        }
    } else {
        DesktopMessage::Reload { reload: true }
    }
}

/// Splits a message into frames: a flag byte, which says whether more follow, and up to `FRAME_DATA` bytes.
pub(crate) fn split(message: &[u8]) -> Vec<Vec<u8>> {
    if message.is_empty() {
        return vec![vec![LAST]];
    }
    let count = message.len().div_ceil(FRAME_DATA);
    message
        .chunks(FRAME_DATA)
        .enumerate()
        .map(|(index, data)| {
            let mut frame = Vec::with_capacity(data.len() + 1);
            frame.push(if index + 1 == count { LAST } else { MORE });
            frame.extend_from_slice(data);
            frame
        })
        .collect()
}

/// Puts frames back together into messages.
pub(crate) struct Assembler {
    limit: usize,
    partial: Vec<u8>,
}

impl Assembler {
    /// An assembler that refuses a message longer than `limit` bytes.
    pub(crate) fn new(limit: usize) -> Self {
        Self {
            limit,
            partial: Vec::new(),
        }
    }

    /// Takes the next frame. Returns the message once its last frame arrives.
    pub(crate) fn push(&mut self, frame: &[u8]) -> Result<Option<Vec<u8>>, String> {
        let (&flag, data) = frame
            .split_first()
            .ok_or_else(|| String::from("An empty frame."))?;
        if flag != MORE && flag != LAST {
            return Err(String::from("A frame with an unknown flag."));
        }
        if self.partial.len() + data.len() > self.limit {
            self.partial = Vec::new();
            return Err(String::from("The message is too large."));
        }
        self.partial.extend_from_slice(data);
        Ok((flag == LAST).then(|| std::mem::take(&mut self.partial)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn browser_messages_are_read_from_their_shapes() {
        let read = |value: Value| serde_json::from_value::<BrowserMessage>(value).unwrap();
        assert_eq!(
            read(json!({ "hello": { "version": 1 } })),
            BrowserMessage::Hello {
                hello: Hello { version: 1 }
            }
        );
        assert_eq!(
            read(json!({ "hello": { "version": 2 } })),
            BrowserMessage::Hello {
                hello: Hello { version: 2 }
            }
        );
        assert_eq!(
            read(json!({ "ping": 7 })),
            BrowserMessage::Ping { ping: json!(7) }
        );
        assert_eq!(
            read(json!({ "id": 3, "cmd": "get_runs", "args": { "a": 1 } })),
            BrowserMessage::Request {
                id: json!(3),
                cmd: "get_runs".into(),
                args: json!({ "a": 1 })
            }
        );
        assert_eq!(
            read(json!({ "id": 4, "cmd": "get_runs" })),
            BrowserMessage::Request {
                id: json!(4),
                cmd: "get_runs".into(),
                args: Value::Null
            },
            "a command may have no arguments"
        );
        assert!(serde_json::from_value::<BrowserMessage>(json!({ "other": 1 })).is_err());
    }

    #[test]
    fn desktop_messages_have_the_shapes_a_browser_reads() {
        let write = |message: DesktopMessage| serde_json::to_value(message).unwrap();
        assert_eq!(
            write(DesktopMessage::Reply(Reply::new(json!(1), Ok(json!([1]))))),
            json!({ "id": 1, "ok": true, "value": [1] })
        );
        assert_eq!(
            write(DesktopMessage::Reply(Reply::new(
                json!("b-2"),
                Err("No.".into())
            ))),
            json!({ "id": "b-2", "ok": false, "error": "No." })
        );
        assert_eq!(
            write(DesktopMessage::Event {
                event: "run-changed".into(),
                payload: json!({}),
                seq: 5
            }),
            json!({ "event": "run-changed", "payload": {}, "seq": 5 })
        );
        assert_eq!(
            write(DesktopMessage::Pong { pong: json!(9) }),
            json!({ "pong": 9 })
        );
    }

    #[test]
    fn a_hello_is_answered_with_version_2_and_another_version_is_told_to_reload() {
        assert_eq!(VERSION, 2);
        let write =
            |hello: u32| serde_json::to_value(answer_hello(&Hello { version: hello })).unwrap();
        assert_eq!(write(2), json!({ "hello": { "version": 2 } }));
        assert_eq!(write(1), json!({ "reload": true }));
        assert_eq!(write(3), json!({ "reload": true }));
        assert_eq!(write(0), json!({ "reload": true }));
    }

    #[test]
    fn a_large_message_is_split_and_put_back_together() {
        let message: Vec<u8> = (0..FRAME_DATA * 2 + 100).map(|n| (n % 251) as u8).collect();
        let frames = split(&message);
        assert_eq!(frames.len(), 3);
        // A flag byte, then up to 16,383 bytes.
        assert_eq!(FRAME_DATA, 16_383);
        assert_eq!(
            frames.iter().map(Vec::len).collect::<Vec<_>>(),
            vec![16_384, 16_384, 101]
        );
        assert_eq!(
            frames.iter().map(|frame| frame[0]).collect::<Vec<_>>(),
            vec![MORE, MORE, LAST]
        );
        let mut assembler = Assembler::new(usize::MAX);
        assert_eq!(assembler.push(&frames[0]).unwrap(), None);
        assert_eq!(assembler.push(&frames[1]).unwrap(), None);
        assert_eq!(assembler.push(&frames[2]).unwrap(), Some(message));
        // The next message starts fresh.
        assert_eq!(
            assembler.push(&split(b"hi")[0]).unwrap(),
            Some(b"hi".to_vec())
        );
    }

    #[test]
    fn a_message_that_exactly_fills_its_frames_ends_with_a_full_last_frame() {
        let message = vec![7u8; FRAME_DATA * 2];
        let frames = split(&message);
        assert_eq!(frames.len(), 2);
        assert_eq!((frames[0][0], frames[1][0]), (MORE, LAST));
        let mut assembler = Assembler::new(usize::MAX);
        assert_eq!(assembler.push(&frames[0]).unwrap(), None);
        assert_eq!(assembler.push(&frames[1]).unwrap(), Some(message));
    }

    #[test]
    fn frames_joined_are_one_json_value_in_utf8() {
        // A character split between two frames is whole again once they are joined.
        let text = "é".repeat(FRAME_DATA);
        let message = serde_json::to_vec(&json!({ "id": 1, "ok": true, "value": text })).unwrap();
        let mut assembler = Assembler::new(usize::MAX);
        let joined = split(&message)
            .iter()
            .filter_map(|frame| assembler.push(frame).unwrap())
            .next()
            .unwrap();
        let value: Value = serde_json::from_slice(&joined).unwrap();
        assert_eq!(value["value"].as_str().unwrap().chars().count(), FRAME_DATA);
    }

    #[test]
    fn small_and_empty_messages_are_one_frame() {
        assert_eq!(split(b"x"), vec![vec![LAST, b'x']]);
        assert_eq!(split(b""), vec![vec![LAST]]);
        assert_eq!(Assembler::new(10).push(&[LAST]).unwrap(), Some(vec![]));
    }

    #[test]
    fn a_message_over_the_limit_or_a_bad_frame_is_refused() {
        let mut assembler = Assembler::new(FRAME_DATA + 10);
        let frames = split(&vec![1u8; FRAME_DATA * 2]);
        assert!(assembler.push(&frames[0]).unwrap().is_none());
        assert!(assembler.push(&frames[1]).is_err());
        // What was kept of the refused message is dropped.
        assert_eq!(
            assembler.push(&split(b"ok")[0]).unwrap(),
            Some(b"ok".to_vec())
        );
        assert!(assembler.push(&[]).is_err());
        assert!(assembler.push(&[7, 1, 2]).is_err());
    }
}
