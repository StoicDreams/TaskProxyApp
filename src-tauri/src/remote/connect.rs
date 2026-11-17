//! A paired device connecting, through api.myfi.ws's mailbox (Docs/RemoteAccess.md, 2.3).
//!
//! The device runs `Noise_IK` with the desktop key it kept when it paired:
//!
//! 1. `Connect1`: the device's first message, which names it by its key, carrying `{offer}`: its WebRTC offer.
//! 2. `Connect2`: the desktop's answer, carrying `{answer}`: its WebRTC answer.
//!
//! Each offer and answer holds its side's DTLS fingerprint, and travels inside the Noise handshake, which
//! authenticates it, so neither the API nor anyone else can swap a fingerprint for their own. WebRTC then refuses a
//! DTLS peer whose certificate doesn't match. Both sides put the desktop's id and the reply mailbox in the prologue.
//!
//! Candidates aren't trickled: each side sends all of its addresses in its offer or answer, so a connection takes
//! one message each way. The finished handshake's channel then encrypts every message over the data channel too.

use super::devices::{Device, DeviceStore};
use super::mailbox::{Inbound, Kind, decode, encode};
use super::noise::{Channel, Handshake, prologue};
use super::pairing::{Desktop, Outcome, refuse};
use super::protocol::MAX_DEVICE_MESSAGE;
use crate::prelude::*;
use std::net::{IpAddr, SocketAddr};

/// A device's connection the desktop accepted: who it is and its offer, waiting for the desktop's answer.
pub(crate) struct Accepted {
    pub device: Device,
    pub offer: String,
    handshake: Handshake,
}

impl std::fmt::Debug for Accepted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Accepted")
            .field("device", &self.device.name)
            .finish_non_exhaustive()
    }
}

/// Reads a device's first connection message. Refuses a device that isn't paired, whose pairing expired, or whose
/// account isn't this desktop's, saying why. A message that isn't one, or that fails to decrypt, gets no answer.
// The refusal shares pairing's Outcome, which can hold a whole device. It runs once per connection, so size is fine.
#[allow(clippy::result_large_err)]
pub(crate) fn accept(
    desktop: &Desktop,
    inbound: &Inbound,
    store: &DeviceStore,
    now: u64,
) -> Result<Accepted, Outcome> {
    let Some((Kind::Connect1, data)) = decode(&inbound.message) else {
        return Err(Outcome::Nothing);
    };
    let sender = inbound.from.to_string();
    if sender != desktop.account {
        return Err(refuse(
            "This desktop is signed in to another account. Sign in to the same account on both.",
        ));
    }
    let mut handshake =
        Handshake::connect_desktop(desktop.keys, &prologue(desktop.id, &inbound.reply))
            .map_err(|_| Outcome::Nothing)?;
    let payload = handshake.read(&data).map_err(|_| Outcome::Nothing)?;
    let key = handshake.remote_key().ok_or(Outcome::Nothing)?;
    let device = store
        .find(&key, &sender, Some(desktop.account), now)
        .map_err(|reason| refuse(&reason))?
        .clone();
    let offer = serde_json::from_slice::<Value>(&payload)
        .ok()
        .and_then(|json| json.get("offer")?.as_str().map(String::from))
        .filter(|offer| !offer.trim().is_empty())
        .ok_or_else(|| {
            refuse("The connection carried no offer. Update the page on the device and try again.")
        })?;
    Ok(Accepted {
        device,
        offer,
        handshake,
    })
}

impl Accepted {
    /// The desktop's answer for the mailbox, and the channel that encrypts the connection's messages.
    pub(crate) fn answer(mut self, answer: &str) -> Result<(String, Channel), String> {
        let message = self.handshake.write(
            serde_json::json!({ "answer": answer })
                .to_string()
                .as_bytes(),
        )?;
        let channel = self.handshake.finish(MAX_DEVICE_MESSAGE)?;
        Ok((encode(Kind::Connect2, &message), channel))
    }
}

/// How a connection reached the desktop, shown on both sides.
pub(crate) fn route(local: SocketAddr, remote: SocketAddr) -> &'static str {
    if is_local(local.ip()) && is_local(remote.ip()) {
        "Direct (same network)"
    } else {
        "Direct (internet)"
    }
}

/// An address on a private network: a home or office network, a VPN such as Tailscale, or this computer.
pub(crate) fn is_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, ..] = ip.octets();
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                // 100.64.0.0/10, which Tailscale and carrier-grade NAT use.
                || (a == 100 && (64..128).contains(&b))
        }
        IpAddr::V6(ip) => {
            let first = ip.segments()[0];
            ip.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::devices::Level;
    use crate::remote::noise::{Keys, generate_keys};

    const ME: &str = "12";

    struct Setup {
        desktop: Keys,
        device: Keys,
        store: DeviceStore,
    }

    fn setup() -> Setup {
        let desktop = generate_keys().unwrap();
        let device = generate_keys().unwrap();
        let mut store = DeviceStore {
            enabled: true,
            ..Default::default()
        };
        store.pair_as("Pixel", &device.public, ME, Level::Work, 30, 0);
        Setup {
            desktop,
            device,
            store,
        }
    }

    fn first(s: &Setup, keys: &Keys, offer: &str, reply: &str) -> (Handshake, Inbound) {
        let mut phone =
            Handshake::connect_device(keys, &s.desktop.public, &prologue("desk-1", reply)).unwrap();
        let message = phone
            .write(serde_json::json!({ "offer": offer }).to_string().as_bytes())
            .unwrap();
        let inbound = Inbound {
            reply: reply.into(),
            from: ME.parse().unwrap(),
            message: encode(Kind::Connect1, &message),
        };
        (phone, inbound)
    }

    fn desktop(s: &Setup) -> Desktop<'_> {
        Desktop {
            keys: &s.desktop,
            id: "desk-1",
            name: "Desk",
            account: ME,
        }
    }

    fn reason(result: Result<Accepted, Outcome>) -> String {
        match result {
            Err(Outcome::Refused { reason, .. }) => reason,
            other => panic!("not refused: {:?}", other.map(|_| ())),
        }
    }

    #[test]
    fn a_paired_device_connects_and_each_side_gets_the_others_session_description() {
        let s = setup();
        let (mut phone, inbound) = first(&s, &s.device, "v=0 offer", "r-1");
        let accepted = accept(&desktop(&s), &inbound, &s.store, 1).unwrap();
        assert_eq!(
            (accepted.device.name.as_str(), accepted.offer.as_str()),
            ("Pixel", "v=0 offer")
        );
        let (body, mut desk) = accepted.answer("v=0 answer").unwrap();
        let (kind, second) = decode(&body).unwrap();
        assert_eq!(kind, Kind::Connect2);
        let payload: Value = serde_json::from_slice(&phone.read(&second).unwrap()).unwrap();
        assert_eq!(payload["answer"], "v=0 answer");
        // Both sides now share the channel that carries the protocol.
        let mut phone = phone.finish(usize::MAX).unwrap();
        let sealed = desk.seal(b"welcome").unwrap();
        assert_eq!(phone.open(&sealed[0]).unwrap(), Some(b"welcome".to_vec()));
    }

    #[test]
    fn an_unpaired_device_or_another_account_is_refused() {
        let s = setup();
        let stranger = generate_keys().unwrap();
        let (_, inbound) = first(&s, &stranger, "v=0", "r");
        assert!(reason(accept(&desktop(&s), &inbound, &s.store, 1)).contains("not paired"));
        let (_, mut inbound) = first(&s, &s.device, "v=0", "r");
        inbound.from = 99;
        assert!(reason(accept(&desktop(&s), &inbound, &s.store, 1)).contains("another account"));
    }

    #[test]
    fn an_expired_pairing_or_remote_access_turned_off_refuses_the_device() {
        let mut s = setup();
        let (_, inbound) = first(&s, &s.device, "v=0", "r");
        assert!(
            reason(accept(
                &desktop(&s),
                &inbound,
                &s.store,
                31 * 24 * 60 * 60 * 1000
            ))
            .contains("expired")
        );
        s.store.enabled = false;
        assert!(reason(accept(&desktop(&s), &inbound, &s.store, 1)).contains("off"));
    }

    #[test]
    fn a_message_for_another_desktop_or_mailbox_or_without_an_offer_is_not_accepted() {
        let s = setup();
        let other_desktop = generate_keys().unwrap();
        let mut phone =
            Handshake::connect_device(&s.device, &other_desktop.public, &prologue("desk-1", "r"))
                .unwrap();
        let message = phone.write(br#"{"offer":"v=0"}"#).unwrap();
        let inbound = Inbound {
            reply: "r".into(),
            from: 12,
            message: encode(Kind::Connect1, &message),
        };
        assert!(matches!(
            accept(&desktop(&s), &inbound, &s.store, 1),
            Err(Outcome::Nothing)
        ));

        let (_, mut moved) = first(&s, &s.device, "v=0", "r-1");
        moved.reply = "r-2".into();
        assert!(
            matches!(
                accept(&desktop(&s), &moved, &s.store, 1),
                Err(Outcome::Nothing)
            ),
            "the prologues differ"
        );

        let (_, empty) = first(&s, &s.device, "  ", "r");
        assert!(reason(accept(&desktop(&s), &empty, &s.store, 1)).contains("no offer"));
        let pairing = Inbound {
            reply: "r".into(),
            from: 12,
            message: encode(Kind::Pair1, b"x"),
        };
        assert!(matches!(
            accept(&desktop(&s), &pairing, &s.store, 1),
            Err(Outcome::Nothing)
        ));
    }

    #[test]
    fn a_route_is_direct_on_the_same_network_or_across_the_internet() {
        let at = |text: &str| text.parse::<SocketAddr>().unwrap();
        assert_eq!(
            route(at("192.168.1.5:5000"), at("192.168.1.9:6000")),
            "Direct (same network)"
        );
        assert_eq!(
            route(at("100.101.1.2:5000"), at("100.90.3.4:6000")),
            "Direct (same network)",
            "Tailscale"
        );
        assert_eq!(
            route(at("[fd7a:115c::1]:5000"), at("[fe80::2]:6000")),
            "Direct (same network)"
        );
        assert_eq!(
            route(at("192.168.1.5:5000"), at("203.0.113.9:6000")),
            "Direct (internet)"
        );
        assert!(!is_local("8.8.8.8".parse().unwrap()));
    }
}
