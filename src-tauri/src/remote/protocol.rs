//! What the desktop and a device say to each other, once the connection is encrypted (`noise.rs`).
//!
//! - A device starts with `{"hello": {"version": N}}`. A device built for another version is told to reload,
//!   since its app code comes from the desktop.
//! - `{id, cmd, args}` gets back `{id, ok: true, value}` or `{id, ok: false, error}`.
//! - Events are `{event, payload, seq}`, numbered from 1 for each connection, so a device can tell it missed one.
//! - `{"ping": n}` gets back `{"pong": n}`. A device pings every 15 seconds.
//!
//! Every message is JSON, split into frames that each fit one Noise message (`split` and `Assembler`).

use crate::prelude::*;

/// The protocol's version. Raise it for any change a device built for the old one cannot follow.
pub(crate) const VERSION: u32 = 1;
/// The most a frame carries, leaving room for its flag byte and Noise's 16 byte tag in a 64 KB message.
pub(crate) const FRAME_DATA: usize = 64 * 1024 - 32;
/// The largest message a device may send, so a device cannot fill the desktop's memory. Messages from the
/// desktop, such as a file's contents, are not limited by this.
pub(crate) const MAX_DEVICE_MESSAGE: usize = 16 * 1024 * 1024;

const MORE: u8 = 0;
const LAST: u8 = 1;

/// A message from a device.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub(crate) enum DeviceMessage {
    Hello {
        hello: Hello,
    },
    Ping {
        ping: u64,
    },
    Request {
        id: u64,
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
    /// The answer to a hello: the desktop's version, and whether the device must reload to match it.
    Welcome {
        welcome: Welcome,
    },
    Pong {
        pong: u64,
    },
    Reply(Reply),
    Event {
        event: String,
        payload: Value,
        seq: u64,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Welcome {
    pub version: u32,
    pub reload: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Reply {
    pub id: u64,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Reply {
    pub(crate) fn new(id: u64, result: Result<Value, String>) -> Self {
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

/// The desktop's answer to a device's hello.
pub(crate) fn welcome(hello: &Hello) -> Welcome {
    Welcome {
        version: VERSION,
        reload: hello.version != VERSION,
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
    fn device_messages_are_read_from_their_shapes() {
        let read = |value: Value| serde_json::from_value::<DeviceMessage>(value).unwrap();
        assert_eq!(
            read(json!({ "hello": { "version": 1 } })),
            DeviceMessage::Hello {
                hello: Hello { version: 1 }
            }
        );
        assert_eq!(read(json!({ "ping": 7 })), DeviceMessage::Ping { ping: 7 });
        assert_eq!(
            read(json!({ "id": 3, "cmd": "get_runs", "args": { "a": 1 } })),
            DeviceMessage::Request {
                id: 3,
                cmd: "get_runs".into(),
                args: json!({ "a": 1 })
            }
        );
        assert_eq!(
            read(json!({ "id": 4, "cmd": "get_runs" })),
            DeviceMessage::Request {
                id: 4,
                cmd: "get_runs".into(),
                args: Value::Null
            },
            "a command may have no arguments"
        );
        assert!(serde_json::from_value::<DeviceMessage>(json!({ "other": 1 })).is_err());
    }

    #[test]
    fn desktop_messages_have_the_shapes_a_device_reads() {
        let write = |message: DesktopMessage| serde_json::to_value(message).unwrap();
        assert_eq!(
            write(DesktopMessage::Reply(Reply::new(1, Ok(json!([1]))))),
            json!({ "id": 1, "ok": true, "value": [1] })
        );
        assert_eq!(
            write(DesktopMessage::Reply(Reply::new(2, Err("No.".into())))),
            json!({ "id": 2, "ok": false, "error": "No." })
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
            write(DesktopMessage::Pong { pong: 9 }),
            json!({ "pong": 9 })
        );
    }

    #[test]
    fn a_device_for_another_version_is_told_to_reload() {
        assert!(!welcome(&Hello { version: VERSION }).reload);
        assert!(
            welcome(&Hello {
                version: VERSION + 1
            })
            .reload
        );
        assert!(welcome(&Hello { version: 0 }).reload);
        assert_eq!(welcome(&Hello { version: 0 }).version, VERSION);
    }

    #[test]
    fn a_large_message_is_split_and_put_back_together() {
        let message: Vec<u8> = (0..FRAME_DATA * 2 + 100).map(|n| (n % 251) as u8).collect();
        let frames = split(&message);
        assert_eq!(frames.len(), 3);
        assert!(frames.iter().all(|frame| frame.len() <= FRAME_DATA + 1));
        // Each frame still fits one Noise message with its tag.
        assert!(frames.iter().all(|frame| frame.len() + 16 <= 65535));
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
