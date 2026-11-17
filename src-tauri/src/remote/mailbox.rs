//! The desktop's side of api.myfi.ws's Remote Access endpoints (Docs/RemoteAccess.md, 2.1): registering this
//! desktop, reading the messages devices leave for it, and answering them.
//!
//! Each message is a kind byte and a Noise message, as base64url. The API checks that only this desktop's account
//! sends to it, and says which account sent each message, but it can't read them.

use crate::prelude::*;
use crate::services::myfi::MyFiApi;
use reqwest::Method;

/// What each mailbox message is, as its first byte.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum Kind {
    /// A device's first pairing message.
    Pair1 = 1,
    /// The desktop's answer, with its key.
    Pair2 = 2,
    /// The device's last pairing message, with its key and the QR code's secret.
    Pair3 = 3,
    /// The desktop's word that the device is paired, or why not, encrypted.
    Paired = 4,
    /// The desktop refusing a message before any encryption, as plain text.
    Refused = 5,
    /// A paired device's first connection message, with its WebRTC offer (`connect.rs`).
    Connect1 = 6,
    /// The desktop's answer, with its WebRTC answer.
    Connect2 = 7,
}

impl Kind {
    fn from_byte(byte: u8) -> Option<Self> {
        Some(match byte {
            1 => Self::Pair1,
            2 => Self::Pair2,
            3 => Self::Pair3,
            4 => Self::Paired,
            5 => Self::Refused,
            6 => Self::Connect1,
            7 => Self::Connect2,
            _ => return None,
        })
    }
}

/// A message's body as the API carries it.
pub(crate) fn encode(kind: Kind, data: &[u8]) -> String {
    let mut bytes = Vec::with_capacity(data.len() + 1);
    bytes.push(kind as u8);
    bytes.extend_from_slice(data);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// A message's kind and data, or None when it isn't one.
pub(crate) fn decode(body: &str) -> Option<(Kind, Vec<u8>)> {
    let bytes = URL_SAFE_NO_PAD.decode(body.trim_end_matches('=')).ok()?;
    let (&kind, data) = bytes.split_first()?;
    Some((Kind::from_byte(kind)?, data.to_vec()))
}

/// A message a device left for this desktop.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(crate) struct Inbound {
    /// The mailbox to answer in.
    pub reply: String,
    /// The account that sent it.
    pub from: i64,
    pub message: String,
}

#[derive(Debug, PartialEq)]
pub(crate) enum MailboxError {
    /// api.myfi.ws couldn't be reached. Worth trying again.
    Unreachable(String),
    /// The session is no longer signed in.
    SignedOut,
    /// The API doesn't know this desktop, as after it was removed on taskproxy.com. Registering again fixes it.
    NotRegistered,
    /// Anything else the API refused, with its reason.
    Refused(String),
}

impl std::fmt::Display for MailboxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreachable(reason) | Self::Refused(reason) => f.write_str(reason),
            Self::SignedOut => {
                f.write_str("Task Proxy is no longer signed in to your Stoic Dreams account.")
            }
            Self::NotRegistered => f.write_str("api.myfi.ws no longer has this desktop."),
        }
    }
}

fn refused(status: u16, text: &str, general: &str) -> MailboxError {
    match status {
        401 => MailboxError::SignedOut,
        404 => MailboxError::NotRegistered,
        _ => {
            let text = text.trim();
            MailboxError::Refused(if text.is_empty() || text.len() > 300 {
                format!("{} ({})", general, status)
            } else {
                text.to_string()
            })
        }
    }
}

impl MyFiApi {
    async fn call(
        &self,
        method: Method,
        path: &str,
        body: Value,
        session: &str,
    ) -> Result<(u16, String), MailboxError> {
        self.send(method, path, Some(body), Some(session))
            .await
            .map_err(MailboxError::Unreachable)
    }

    /// Registers this desktop under the session's account, and returns its id. The same key keeps its id.
    pub(crate) async fn register_desktop(
        &self,
        session: &str,
        name: &str,
        public_key: &[u8],
    ) -> Result<String, MailboxError> {
        let body = serde_json::json!({ "name": name, "publicKey": hex::encode(public_key) });
        let (status, text) = self
            .call(Method::POST, "remote/desktop/register", body, session)
            .await?;
        if status != 200 {
            return Err(refused(
                status,
                &text,
                "Remote Access could not be turned on.",
            ));
        }
        serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|json| json.get("desktopId")?.as_str().map(String::from))
            .ok_or_else(|| {
                MailboxError::Refused(String::from(
                    "api.myfi.ws answered with something unexpected.",
                ))
            })
    }

    /// Removes this desktop, so devices can't reach it. One the API no longer has counts as removed.
    pub(crate) async fn remove_desktop(
        &self,
        session: &str,
        desktop_id: &str,
    ) -> Result<(), MailboxError> {
        let body = serde_json::json!({ "desktopId": desktop_id });
        let (status, text) = self
            .call(Method::DELETE, "remote/desktop", body, session)
            .await?;
        match status {
            200 | 404 => Ok(()),
            _ => Err(refused(status, &text, "The desktop could not be removed.")),
        }
    }

    /// Takes the messages waiting for this desktop. Also shows it online on taskproxy.com.
    pub(crate) async fn take_messages(
        &self,
        session: &str,
        desktop_id: &str,
    ) -> Result<Vec<Inbound>, MailboxError> {
        let body = serde_json::json!({ "desktopId": desktop_id });
        let (status, text) = self
            .call(Method::POST, "remote/messages", body, session)
            .await?;
        if status != 200 {
            return Err(refused(
                status,
                &text,
                "Messages for this desktop could not be read.",
            ));
        }
        #[derive(Deserialize)]
        struct Messages {
            messages: Vec<Inbound>,
        }
        serde_json::from_str::<Messages>(&text)
            .map(|messages| messages.messages)
            .map_err(|_| {
                MailboxError::Refused(String::from(
                    "api.myfi.ws answered with something unexpected.",
                ))
            })
    }

    /// Answers a message in the mailbox it named.
    pub(crate) async fn send_reply(
        &self,
        session: &str,
        desktop_id: &str,
        reply: &str,
        message: &str,
    ) -> Result<(), MailboxError> {
        let body =
            serde_json::json!({ "desktopId": desktop_id, "reply": reply, "message": message });
        let (status, text) = self
            .call(Method::POST, "remote/reply/send", body, session)
            .await?;
        if status == 200 {
            Ok(())
        } else {
            Err(refused(status, &text, "The answer could not be sent."))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_message_is_its_kind_and_data_as_base64url() {
        let body = encode(Kind::Pair2, &[0xfb, 0xff, 7]);
        assert!(
            body.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );
        assert_eq!(decode(&body), Some((Kind::Pair2, vec![0xfb, 0xff, 7])));
        assert_eq!(
            decode(&encode(Kind::Refused, b"")),
            Some((Kind::Refused, vec![]))
        );
        assert_eq!(decode(""), None);
        assert_eq!(decode("not base64!"), None);
        assert_eq!(
            decode(&URL_SAFE_NO_PAD.encode([99u8, 1])),
            None,
            "an unknown kind"
        );
    }

    use crate::services::myfi::tests::{body_of, fake_api};

    #[tokio::test]
    async fn the_desktop_registers_reads_and_answers_with_its_session() {
        let (base, received) = fake_api(vec![
            (200, r#"{"desktopId":"d-1"}"#),
            (
                200,
                r#"{"messages":[{"reply":"r-1","from":12,"message":"AQ"}]}"#,
            ),
            (200, ""),
            (200, "The desktop was removed."),
        ]);
        let api = MyFiApi::new(&base).unwrap();
        assert_eq!(
            api.register_desktop("s", "Desk", &[0xab, 1]).await.unwrap(),
            "d-1"
        );
        let request = received.recv().unwrap();
        assert_eq!(request.line, "POST /remote/desktop/register HTTP/1.1");
        assert_eq!(request.headers["x-auth"], "s");
        assert_eq!(
            body_of(&request),
            serde_json::json!({ "name": "Desk", "publicKey": "ab01" })
        );

        let messages = api.take_messages("s", "d-1").await.unwrap();
        assert_eq!(
            messages,
            vec![Inbound {
                reply: "r-1".into(),
                from: 12,
                message: "AQ".into()
            }]
        );
        let request = received.recv().unwrap();
        assert_eq!(request.line, "POST /remote/messages HTTP/1.1");
        assert_eq!(body_of(&request), serde_json::json!({ "desktopId": "d-1" }));

        api.send_reply("s", "d-1", "r-1", "Ag").await.unwrap();
        assert_eq!(
            body_of(&received.recv().unwrap()),
            serde_json::json!({ "desktopId": "d-1", "reply": "r-1", "message": "Ag" })
        );

        api.remove_desktop("s", "d-1").await.unwrap();
        assert_eq!(
            received.recv().unwrap().line,
            "DELETE /remote/desktop HTTP/1.1"
        );
    }

    #[tokio::test]
    async fn the_apis_refusals_become_what_to_do_next() {
        let (base, _received) = fake_api(vec![
            (401, ""),
            (404, "This desktop isn't registered."),
            (404, ""),
            (429, "Too many"),
        ]);
        let api = MyFiApi::new(&base).unwrap();
        assert_eq!(
            api.take_messages("s", "d").await,
            Err(MailboxError::SignedOut)
        );
        assert_eq!(
            api.take_messages("s", "d").await,
            Err(MailboxError::NotRegistered)
        );
        assert_eq!(
            api.remove_desktop("s", "d").await,
            Ok(()),
            "a desktop already gone is removed"
        );
        assert_eq!(
            api.send_reply("s", "d", "r", "m").await,
            Err(MailboxError::Refused("Too many".into()))
        );
    }

    #[test]
    fn refusals_say_what_to_do_next() {
        assert_eq!(refused(401, "", "x"), MailboxError::SignedOut);
        assert_eq!(refused(404, "gone", "x"), MailboxError::NotRegistered);
        assert_eq!(
            refused(429, "Too many", "x"),
            MailboxError::Refused("Too many".into())
        );
        assert_eq!(
            refused(500, "", "Failed."),
            MailboxError::Refused("Failed. (500)".into())
        );
    }
}
