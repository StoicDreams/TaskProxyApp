//! Pairing a device through api.myfi.ws's mailbox, before any direct connection exists (Docs/RemoteAccess.md, 2.2).
//!
//! The desktop shows a QR code holding its id, its key, and a secret that works once for 10 minutes. The device
//! signed in to the same account on taskproxy.com then runs `Noise_XXpsk3` with the secret through the mailbox:
//!
//! 1. `Pair1`: the device's first message.
//! 2. `Pair2`: the desktop's answer, with its key and name.
//! 3. `Pair3`: the device's key and name, which only a device holding the secret can send.
//! 4. `Paired`: the desktop saves the device, and says so over the finished encryption.
//!
//! Both sides put the desktop's id and the reply mailbox in the prologue, so messages can't be moved between pairings.
//! The API only lets the desktop's own account send, and the desktop checks the sender's account again here.

use super::devices::{Device, DeviceStore, Level};
use super::mailbox::{Inbound, Kind, decode, encode};
use super::noise::{Handshake, Keys, PSK_LEN, prologue};
use crate::prelude::*;

/// How long a QR code works.
pub(crate) const INVITE_MS: u64 = 10 * 60 * 1000;
/// How long a pairing may wait between its messages.
const HANDSHAKE_MS: u64 = 2 * 60 * 1000;
/// How many pairings may be part way at once.
const MAX_PENDING: usize = 4;
/// Where the QR code's link opens.
pub(crate) const PAIR_PAGE: &str = "https://www.taskproxy.com/remote/";

/// An open QR code: its secret, and the level and lifetime the device it pairs gets.
#[derive(Clone)]
pub(crate) struct Invite {
    pub psk: [u8; PSK_LEN],
    pub name: String,
    pub level: Level,
    pub days: u32,
    pub expires_at: u64,
}

impl Invite {
    pub(crate) fn new(name: &str, level: Level, days: u32, now: u64) -> Self {
        use rand::RngExt;
        Self {
            psk: rand::rng().random(),
            name: super::devices::device_name(name),
            level,
            days,
            expires_at: now + INVITE_MS,
        }
    }
}

impl std::fmt::Debug for Invite {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Invite")
            .field("name", &self.name)
            .field("level", &self.level)
            .field("days", &self.days)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

/// The link a QR code holds. The secret is in the fragment, which browsers never send to a server.
pub(crate) fn link(
    desktop_id: &str,
    desktop_key: &[u8],
    desktop_name: &str,
    invite: &Invite,
) -> String {
    let payload = serde_json::json!({
        "v": 1,
        "desktopId": desktop_id,
        "desktopKey": hex::encode(desktop_key),
        "secret": URL_SAFE_NO_PAD.encode(invite.psk),
        "expires": invite.expires_at,
        "name": desktop_name,
    });
    format!(
        "{}#pair={}",
        PAIR_PAGE,
        URL_SAFE_NO_PAD.encode(payload.to_string())
    )
}

/// The QR code for a link, as SVG.
pub(crate) fn qr_svg(link: &str) -> Result<String, String> {
    let code = qrcode::QrCode::new(link.as_bytes()).map_err(|err| err.to_string())?;
    Ok(code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(240, 240)
        .quiet_zone(true)
        .build())
}

/// The start of a key's SHA-256, as api.myfi.ws and taskproxy.com show it, to check the right desktop.
pub(crate) fn fingerprint(key: &[u8]) -> String {
    hex::encode(Sha256::digest(key))[..16].to_string()
}

struct Pending {
    handshake: Handshake,
    started: u64,
}

/// What the desktop knows about itself while answering a message.
pub(crate) struct Desktop<'a> {
    pub keys: &'a Keys,
    pub id: &'a str,
    pub name: &'a str,
    /// The account this desktop is signed in to.
    pub account: &'a str,
}

#[derive(Debug, PartialEq)]
pub(crate) enum Outcome {
    /// Nothing to answer.
    Nothing,
    /// Send this to the message's reply mailbox.
    Answer(String),
    /// A device paired and was saved. Send the answer.
    Paired { device: Device, answer: String },
    /// A device was refused, and why. Send the answer.
    Refused { reason: String, answer: String },
}

fn refuse(reason: &str) -> Outcome {
    Outcome::Refused {
        reason: reason.into(),
        answer: encode(Kind::Refused, reason.as_bytes()),
    }
}

/// The open QR code and the pairings part way.
#[derive(Default)]
pub(crate) struct Pairing {
    invite: Option<Invite>,
    pending: HashMap<String, Pending>,
}

impl Pairing {
    /// Opens a QR code, replacing any open one and the pairings it started.
    pub(crate) fn open(&mut self, invite: Invite) {
        self.invite = Some(invite);
        self.pending.clear();
    }

    pub(crate) fn close(&mut self) {
        self.invite = None;
        self.pending.clear();
    }

    /// The open QR code, if it still works.
    pub(crate) fn invite(&mut self, now: u64) -> Option<&Invite> {
        self.expire(now);
        self.invite.as_ref()
    }

    /// Whether a pairing could be under way, so the mailbox is read often.
    pub(crate) fn is_active(&mut self, now: u64) -> bool {
        self.expire(now);
        self.invite.is_some() || !self.pending.is_empty()
    }

    fn expire(&mut self, now: u64) {
        if self
            .invite
            .as_ref()
            .is_some_and(|invite| invite.expires_at <= now)
        {
            self.invite = None;
        }
        self.pending
            .retain(|_, pending| pending.started + HANDSHAKE_MS > now);
    }

    /// Answers a message from the mailbox. A device that pairs is saved in `store`.
    pub(crate) fn receive(
        &mut self,
        desktop: &Desktop,
        inbound: &Inbound,
        store: &mut DeviceStore,
        now: u64,
    ) -> Outcome {
        self.expire(now);
        let Some((kind, data)) = decode(&inbound.message) else {
            return Outcome::Nothing;
        };
        // The API already refuses other accounts. This is in case the desktop's sign-in changed since.
        if inbound.from.to_string() != desktop.account {
            return refuse(
                "This desktop is signed in to another account. Sign in to the same account on both.",
            );
        }
        match kind {
            Kind::Pair1 => self.first(desktop, inbound, &data, now),
            Kind::Pair3 => self.last(desktop, inbound, &data, store, now),
            _ => Outcome::Nothing,
        }
    }

    fn first(&mut self, desktop: &Desktop, inbound: &Inbound, data: &[u8], now: u64) -> Outcome {
        let Some(invite) = self.invite.as_ref() else {
            return refuse(
                "This pairing code has expired or was used. Show a new QR code on the desktop.",
            );
        };
        if self.pending.len() >= MAX_PENDING && !self.pending.contains_key(&inbound.reply) {
            return refuse("Too many devices are pairing at once. Try again in a minute.");
        }
        let started = (|| {
            let mut handshake = Handshake::pair_desktop(
                desktop.keys,
                &invite.psk,
                &prologue(desktop.id, &inbound.reply),
            )?;
            handshake.read(data)?;
            let answer = handshake.write(
                serde_json::json!({ "name": desktop.name })
                    .to_string()
                    .as_bytes(),
            )?;
            Ok::<_, String>((handshake, answer))
        })();
        match started {
            Ok((handshake, answer)) => {
                self.pending.insert(
                    inbound.reply.clone(),
                    Pending {
                        handshake,
                        started: now,
                    },
                );
                Outcome::Answer(encode(Kind::Pair2, &answer))
            }
            Err(_) => Outcome::Nothing,
        }
    }

    fn last(
        &mut self,
        desktop: &Desktop,
        inbound: &Inbound,
        data: &[u8],
        store: &mut DeviceStore,
        now: u64,
    ) -> Outcome {
        let Some(Pending { mut handshake, .. }) = self.pending.remove(&inbound.reply) else {
            return Outcome::Nothing;
        };
        // Reading fails when the device doesn't hold the QR code's secret.
        let Ok(payload) = handshake.read(data) else {
            return refuse("The pairing code didn't match. Scan the QR code on the desktop again.");
        };
        let (Some(key), true) = (handshake.remote_key(), handshake.is_finished()) else {
            return Outcome::Nothing;
        };
        let Some(invite) = self.invite.take() else {
            return refuse(
                "This pairing code has expired or was used. Show a new QR code on the desktop.",
            );
        };
        self.pending.clear();
        let name = serde_json::from_slice::<Value>(&payload)
            .ok()
            .and_then(|json| json.get("name")?.as_str().map(String::from))
            .unwrap_or_else(|| invite.name.clone());
        let name = if name.trim().is_empty() {
            invite.name.clone()
        } else {
            name
        };
        let device = store.pair_as(&name, &key, desktop.account, invite.level, invite.days, now);
        let sealed = handshake.finish(usize::MAX).and_then(|mut channel| {
            let done = serde_json::json!({
                "ok": true,
                "deviceId": device.id,
                "name": device.name,
                "level": device.level,
                "days": device.days,
                "desktopName": desktop.name,
            });
            channel.seal(done.to_string().as_bytes())
        });
        match sealed {
            Ok(packets) if packets.len() == 1 => Outcome::Paired {
                answer: encode(Kind::Paired, &packets[0]),
                device,
            },
            _ => {
                store.remove(&device.id);
                refuse("Pairing could not finish. Try again.")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::noise::generate_keys;

    const ME: &str = "12";
    const DESKTOP_ID: &str = "desk-1";

    struct Setup {
        keys: Keys,
        store: DeviceStore,
        pairing: Pairing,
        invite: Invite,
    }

    fn setup(level: Level, days: u32) -> Setup {
        let mut pairing = Pairing::default();
        let invite = Invite::new("Phone", level, days, 0);
        pairing.open(invite.clone());
        Setup {
            keys: generate_keys().unwrap(),
            store: DeviceStore {
                enabled: true,
                ..Default::default()
            },
            pairing,
            invite,
        }
    }

    fn inbound(reply: &str, from: &str, kind: Kind, data: &[u8]) -> Inbound {
        Inbound {
            reply: reply.into(),
            from: from.parse().unwrap(),
            message: encode(kind, data),
        }
    }

    fn answer_of(outcome: &Outcome) -> (Kind, Vec<u8>) {
        let answer = match outcome {
            Outcome::Answer(answer)
            | Outcome::Paired { answer, .. }
            | Outcome::Refused { answer, .. } => answer,
            Outcome::Nothing => panic!("no answer"),
        };
        decode(answer).unwrap()
    }

    /// Runs a device's side of pairing against the desktop, with `psk` as the secret it read from the QR code.
    fn pair(s: &mut Setup, psk: &[u8; PSK_LEN], reply: &str, now: u64) -> Outcome {
        let desktop = Desktop {
            keys: &s.keys,
            id: DESKTOP_ID,
            name: "Desk PC",
            account: ME,
        };
        let device_keys = generate_keys().unwrap();
        let mut phone =
            Handshake::pair_device(&device_keys, psk, &prologue(DESKTOP_ID, reply)).unwrap();
        let first = phone.write(b"").unwrap();
        let outcome = s.pairing.receive(
            &desktop,
            &inbound(reply, ME, Kind::Pair1, &first),
            &mut s.store,
            now,
        );
        let (kind, second) = answer_of(&outcome);
        if kind != Kind::Pair2 {
            return outcome;
        }
        let payload: Value = serde_json::from_slice(&phone.read(&second).unwrap()).unwrap();
        assert_eq!(
            payload["name"], "Desk PC",
            "the device learns the desktop's name"
        );
        assert_eq!(
            phone.remote_key(),
            Some(s.keys.public.clone()),
            "and its key, to check against the QR code"
        );
        let third = phone.write(br#"{"name":"Pixel 9"}"#).unwrap();
        let outcome = s.pairing.receive(
            &desktop,
            &inbound(reply, ME, Kind::Pair3, &third),
            &mut s.store,
            now,
        );
        if let Outcome::Paired { answer, .. } = &outcome {
            let (kind, sealed) = decode(answer).unwrap();
            assert_eq!(kind, Kind::Paired);
            let mut channel = phone.finish(usize::MAX).unwrap();
            let done: Value =
                serde_json::from_slice(&channel.open(&sealed).unwrap().unwrap()).unwrap();
            assert_eq!(done["ok"], true);
            assert_eq!(done["name"], "Pixel 9");
            assert_eq!(
                s.store.devices.last().unwrap().public_key,
                hex::encode(&device_keys.public)
            );
        }
        outcome
    }

    #[test]
    fn a_device_with_the_qr_codes_secret_pairs_at_the_chosen_level() {
        let mut s = setup(Level::Work, 7);
        let psk = s.invite.psk;
        let Outcome::Paired { device, .. } = pair(&mut s, &psk, "r-1", 5) else {
            panic!("did not pair");
        };
        assert_eq!(
            (device.name.as_str(), device.level, device.days),
            ("Pixel 9", Level::Work, 7)
        );
        assert_eq!(device.account_id, ME);
        assert_eq!(s.store.devices, vec![device]);
        assert!(s.pairing.invite(6).is_none(), "the QR code works once");
        assert!(!s.pairing.is_active(6));
    }

    #[test]
    fn a_device_without_the_secret_is_refused_and_not_saved() {
        let mut s = setup(Level::Commit, 30);
        let outcome = pair(&mut s, &[9; PSK_LEN], "r-1", 5);
        assert!(
            matches!(&outcome, Outcome::Refused { reason, .. } if reason.contains("didn't match")),
            "{:?}",
            outcome
        );
        assert!(s.store.devices.is_empty());
        let psk = s.invite.psk;
        assert!(
            matches!(pair(&mut s, &psk, "r-2", 6), Outcome::Paired { .. }),
            "a wrong guess doesn't use up the QR code"
        );
    }

    #[test]
    fn a_used_or_expired_qr_code_pairs_nothing() {
        let mut s = setup(Level::View, 30);
        let psk = s.invite.psk;
        assert!(matches!(
            pair(&mut s, &psk, "r-1", 5),
            Outcome::Paired { .. }
        ));
        let outcome = pair(&mut s, &psk, "r-2", 6);
        assert!(
            matches!(&outcome, Outcome::Refused { reason, .. } if reason.contains("expired or was used"))
        );
        assert_eq!(answer_of(&outcome).0, Kind::Refused);

        let mut s = setup(Level::View, 30);
        let psk = s.invite.psk;
        assert!(matches!(
            pair(&mut s, &psk, "r-1", INVITE_MS),
            Outcome::Refused { .. }
        ));
        assert!(s.store.devices.is_empty());
    }

    #[test]
    fn another_account_is_refused() {
        let mut s = setup(Level::View, 30);
        let desktop = Desktop {
            keys: &s.keys,
            id: DESKTOP_ID,
            name: "Desk",
            account: ME,
        };
        let outcome = s.pairing.receive(
            &desktop,
            &inbound("r", "99", Kind::Pair1, b"x"),
            &mut s.store,
            1,
        );
        assert!(
            matches!(&outcome, Outcome::Refused { reason, .. } if reason.contains("another account"))
        );
        assert_eq!(
            answer_of(&outcome).1,
            b"This desktop is signed in to another account. Sign in to the same account on both."
        );
    }

    #[test]
    fn a_message_moved_to_another_mailbox_fails() {
        let mut s = setup(Level::View, 30);
        let desktop = Desktop {
            keys: &s.keys,
            id: DESKTOP_ID,
            name: "Desk",
            account: ME,
        };
        // The device builds its handshake for mailbox r-1, but the message arrives as if for r-2.
        let mut phone = Handshake::pair_device(
            &generate_keys().unwrap(),
            &s.invite.psk,
            &prologue(DESKTOP_ID, "r-1"),
        )
        .unwrap();
        let first = phone.write(b"").unwrap();
        let outcome = s.pairing.receive(
            &desktop,
            &inbound("r-2", ME, Kind::Pair1, &first),
            &mut s.store,
            1,
        );
        // In psk mode even the first message's payload is encrypted, so the desktop reads the moved message as wrong.
        assert_eq!(
            outcome,
            Outcome::Nothing,
            "the prologues differ, so the desktop ignores it"
        );
        assert!(!s.pairing.pending.contains_key("r-2"));
    }

    #[test]
    fn a_last_message_without_a_first_or_after_two_minutes_is_ignored() {
        let mut s = setup(Level::View, 30);
        let desktop = Desktop {
            keys: &s.keys,
            id: DESKTOP_ID,
            name: "Desk",
            account: ME,
        };
        assert_eq!(
            s.pairing.receive(
                &desktop,
                &inbound("r", ME, Kind::Pair3, b"x"),
                &mut s.store,
                1
            ),
            Outcome::Nothing
        );
        let mut phone = Handshake::pair_device(
            &generate_keys().unwrap(),
            &s.invite.psk,
            &prologue(DESKTOP_ID, "r"),
        )
        .unwrap();
        let first = phone.write(b"").unwrap();
        let (_, second) = answer_of(&s.pairing.receive(
            &desktop,
            &inbound("r", ME, Kind::Pair1, &first),
            &mut s.store,
            1,
        ));
        phone.read(&second).unwrap();
        let third = phone.write(b"{}").unwrap();
        let late = s.pairing.receive(
            &desktop,
            &inbound("r", ME, Kind::Pair3, &third),
            &mut s.store,
            1 + HANDSHAKE_MS,
        );
        assert_eq!(late, Outcome::Nothing);
        assert!(s.store.devices.is_empty());
        assert_eq!(
            s.pairing.receive(
                &desktop,
                &Inbound {
                    reply: "r".into(),
                    from: 12,
                    message: "!!".into()
                },
                &mut s.store,
                2
            ),
            Outcome::Nothing
        );
    }

    #[test]
    fn only_a_few_pairings_wait_at_once_and_a_new_qr_code_ends_them() {
        let mut s = setup(Level::View, 30);
        let desktop = Desktop {
            keys: &s.keys,
            id: DESKTOP_ID,
            name: "Desk",
            account: ME,
        };
        for n in 0..=MAX_PENDING {
            let reply = format!("r-{}", n);
            let mut phone = Handshake::pair_device(
                &generate_keys().unwrap(),
                &s.invite.psk,
                &prologue(DESKTOP_ID, &reply),
            )
            .unwrap();
            let first = phone.write(b"").unwrap();
            let outcome = s.pairing.receive(
                &desktop,
                &inbound(&reply, ME, Kind::Pair1, &first),
                &mut s.store,
                1,
            );
            if n < MAX_PENDING {
                assert_eq!(answer_of(&outcome).0, Kind::Pair2);
            } else {
                assert!(
                    matches!(outcome, Outcome::Refused { reason, .. } if reason.contains("Too many"))
                );
            }
        }
        s.pairing.open(Invite::new("Next", Level::View, 30, 2));
        assert_eq!(s.pairing.pending.len(), 0);
    }

    #[test]
    fn the_link_holds_what_the_device_needs_and_draws_as_a_qr_code() {
        let invite = Invite::new("Phone", Level::View, 30, 1000);
        let link = link("desk-1", &[0xab; 32], "Desk PC", &invite);
        let payload = link
            .strip_prefix("https://www.taskproxy.com/remote/#pair=")
            .unwrap();
        let json: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap();
        assert_eq!(json["v"], 1);
        assert_eq!(json["desktopId"], "desk-1");
        assert_eq!(json["desktopKey"], "ab".repeat(32));
        assert_eq!(
            URL_SAFE_NO_PAD
                .decode(json["secret"].as_str().unwrap())
                .unwrap(),
            invite.psk
        );
        assert_eq!(json["expires"], 1000 + INVITE_MS);
        let svg = qr_svg(&link).unwrap();
        assert!(svg.starts_with("<?xml") && svg.contains("<svg"));
        assert!(
            !format!("{:?}", invite).contains(&format!("{:?}", invite.psk)),
            "Debug never shows the secret"
        );
        assert_eq!(fingerprint(&[1]).len(), 16);
    }
}
