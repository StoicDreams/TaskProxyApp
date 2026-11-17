//! The encrypted connection between the desktop and a device, with Noise (`snow`).
//!
//! - **Pairing** is `Noise_XXpsk3`, with the QR code's one-time secret as the pre-shared key, so only the device
//!   that scanned it can finish. Each side learns the other's static key, which the desktop keeps for the device.
//! - **Later connections** are `Noise_IK`: the device already knows the desktop's key, and the desktop finds the
//!   device by the key in its first message, before it answers.
//! - Both handshakes take a prologue holding each side's WebRTC DTLS fingerprint. A party in the middle, such as
//!   a relay or the API that introduces the devices, would see other fingerprints, so the handshake fails.
//!
//! The device starts both handshakes. The device's side is here too, for tests and as the reference for the
//! browser's implementation.

use super::protocol::{Assembler, split};
use crate::prelude::*;
use snow::{Builder, HandshakeState, TransportState};

pub(crate) const PAIR_PATTERN: &str = "Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s";
pub(crate) const CONNECT_PATTERN: &str = "Noise_IK_25519_ChaChaPoly_BLAKE2s";
/// The size of the pairing secret.
pub(crate) const PSK_LEN: usize = 32;
const MAX_NOISE_MESSAGE: usize = 65535;

/// A static key pair. The desktop has one, and so does each device.
#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct Keys {
    #[serde(with = "hex_bytes")]
    pub private: Vec<u8>,
    #[serde(with = "hex_bytes")]
    pub public: Vec<u8>,
}

impl std::fmt::Debug for Keys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Keys")
            .field("public", &hex::encode(&self.public))
            .finish_non_exhaustive()
    }
}

mod hex_bytes {
    use serde::{Deserialize, Deserializer, Serializer};
    pub(super) fn serialize<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(bytes))
    }
    pub(super) fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        hex::decode(String::deserialize(d)?).map_err(serde::de::Error::custom)
    }
}

fn error(err: impl std::fmt::Display) -> String {
    format!("The secure connection failed: {}", err)
}

fn params(pattern: &str) -> Result<snow::params::NoiseParams, String> {
    pattern.parse().map_err(error)
}

/// A new static key pair.
pub(crate) fn generate_keys() -> Result<Keys, String> {
    let keys = Builder::new(params(CONNECT_PATTERN)?)
        .generate_keypair()
        .map_err(error)?;
    Ok(Keys {
        private: keys.private,
        public: keys.public,
    })
}

/// What both sides bind into a handshake: the protocol and each side's DTLS certificate fingerprint.
pub(crate) fn prologue(desktop_fingerprint: &str, device_fingerprint: &str) -> Vec<u8> {
    format!(
        "TaskProxy remote {}\ndesktop {}\ndevice {}",
        super::protocol::VERSION,
        desktop_fingerprint.trim().to_ascii_uppercase(),
        device_fingerprint.trim().to_ascii_uppercase()
    )
    .into_bytes()
}

/// A handshake in progress.
pub(crate) struct Handshake(HandshakeState);

impl Handshake {
    /// The desktop's side of pairing.
    pub(crate) fn pair_desktop(
        keys: &Keys,
        psk: &[u8; PSK_LEN],
        prologue: &[u8],
    ) -> Result<Self, String> {
        Self::build(PAIR_PATTERN, keys, Some(psk), None, prologue, false)
    }

    /// The desktop's side of a later connection.
    pub(crate) fn connect_desktop(keys: &Keys, prologue: &[u8]) -> Result<Self, String> {
        Self::build(CONNECT_PATTERN, keys, None, None, prologue, false)
    }

    /// A device's side of pairing.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn pair_device(
        keys: &Keys,
        psk: &[u8; PSK_LEN],
        prologue: &[u8],
    ) -> Result<Self, String> {
        Self::build(PAIR_PATTERN, keys, Some(psk), None, prologue, true)
    }

    /// A device's side of a later connection, to the desktop whose key it kept when it paired.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn connect_device(
        keys: &Keys,
        desktop: &[u8],
        prologue: &[u8],
    ) -> Result<Self, String> {
        Self::build(CONNECT_PATTERN, keys, None, Some(desktop), prologue, true)
    }

    fn build(
        pattern: &str,
        keys: &Keys,
        psk: Option<&[u8; PSK_LEN]>,
        remote: Option<&[u8]>,
        prologue: &[u8],
        initiator: bool,
    ) -> Result<Self, String> {
        let mut builder = Builder::new(params(pattern)?)
            .local_private_key(&keys.private)
            .map_err(error)?
            .prologue(prologue)
            .map_err(error)?;
        if let Some(psk) = psk {
            builder = builder.psk(3, psk).map_err(error)?;
        }
        if let Some(remote) = remote {
            builder = builder.remote_public_key(remote).map_err(error)?;
        }
        let state = if initiator {
            builder.build_initiator()
        } else {
            builder.build_responder()
        };
        state.map(Self).map_err(error)
    }

    /// The next handshake message, carrying `payload`.
    pub(crate) fn write(&mut self, payload: &[u8]) -> Result<Vec<u8>, String> {
        let mut message = vec![0u8; MAX_NOISE_MESSAGE];
        let len = self.0.write_message(payload, &mut message).map_err(error)?;
        message.truncate(len);
        Ok(message)
    }

    /// Reads the other side's handshake message, and returns its payload.
    pub(crate) fn read(&mut self, message: &[u8]) -> Result<Vec<u8>, String> {
        let mut payload = vec![0u8; MAX_NOISE_MESSAGE];
        let len = self.0.read_message(message, &mut payload).map_err(error)?;
        payload.truncate(len);
        Ok(payload)
    }

    /// The other side's static key, once a handshake message has carried it.
    pub(crate) fn remote_key(&self) -> Option<Vec<u8>> {
        self.0.get_remote_static().map(<[u8]>::to_vec)
    }

    pub(crate) fn is_finished(&self) -> bool {
        self.0.is_handshake_finished()
    }

    /// The encrypted channel, once the handshake is finished. It refuses a message over `limit` bytes.
    pub(crate) fn finish(self, limit: usize) -> Result<Channel, String> {
        Ok(Channel {
            state: self.0.into_transport_mode().map_err(error)?,
            assembler: Assembler::new(limit),
        })
    }
}

/// An encrypted channel. Each message is split into frames, and each frame is one Noise message.
pub(crate) struct Channel {
    state: TransportState,
    assembler: Assembler,
}

impl Channel {
    /// The other side's static key.
    pub(crate) fn remote_key(&self) -> Option<Vec<u8>> {
        self.state.get_remote_static().map(<[u8]>::to_vec)
    }

    /// Encrypts a message, as the packets to send in order.
    pub(crate) fn seal(&mut self, message: &[u8]) -> Result<Vec<Vec<u8>>, String> {
        split(message)
            .into_iter()
            .map(|frame| {
                let mut packet = vec![0u8; frame.len() + 16];
                let len = self
                    .state
                    .write_message(&frame, &mut packet)
                    .map_err(error)?;
                packet.truncate(len);
                Ok(packet)
            })
            .collect()
    }

    /// Decrypts the next packet. Returns the message once its last packet arrives.
    pub(crate) fn open(&mut self, packet: &[u8]) -> Result<Option<Vec<u8>>, String> {
        let mut frame = vec![0u8; packet.len()];
        let len = self.state.read_message(packet, &mut frame).map_err(error)?;
        self.assembler.push(&frame[..len])
    }
}

#[cfg(test)]
mod tests {
    use super::super::protocol::{FRAME_DATA, MAX_DEVICE_MESSAGE};
    use super::*;

    const PSK: [u8; PSK_LEN] = [7; PSK_LEN];

    fn fingerprints() -> Vec<u8> {
        prologue("AA:BB:CC", "dd:ee:ff")
    }

    /// Pairs a device with the desktop, as the QR code does, and returns both channels.
    fn pair(desktop: &Keys, device: &Keys) -> Result<(Channel, Channel), String> {
        let mut desk = Handshake::pair_desktop(desktop, &PSK, &fingerprints())?;
        let mut phone = Handshake::pair_device(device, &PSK, &fingerprints())?;
        desk.read(&phone.write(b"")?)?;
        phone.read(&desk.write(b"")?)?;
        let name = desk.read(&phone.write(b"Pixel")?)?;
        assert_eq!(
            name, b"Pixel",
            "the device's last message can carry its name"
        );
        assert!(desk.is_finished() && phone.is_finished());
        Ok((desk.finish(MAX_DEVICE_MESSAGE)?, phone.finish(usize::MAX)?))
    }

    #[test]
    fn pairing_gives_each_side_the_others_key() {
        let (desktop, device) = (generate_keys().unwrap(), generate_keys().unwrap());
        let (mut desk, mut phone) = pair(&desktop, &device).unwrap();
        assert_eq!(desk.remote_key(), Some(device.public.clone()));
        assert_eq!(phone.remote_key(), Some(desktop.public.clone()));
        let packets = phone.seal(b"{\"ping\":1}").unwrap();
        assert_eq!(
            desk.open(&packets[0]).unwrap(),
            Some(b"{\"ping\":1}".to_vec())
        );
        let packets = desk.seal(b"{\"pong\":1}").unwrap();
        assert_eq!(
            phone.open(&packets[0]).unwrap(),
            Some(b"{\"pong\":1}".to_vec())
        );
    }

    #[test]
    fn pairing_fails_without_the_qr_codes_secret() {
        let (desktop, device) = (generate_keys().unwrap(), generate_keys().unwrap());
        let mut desk = Handshake::pair_desktop(&desktop, &PSK, &fingerprints()).unwrap();
        let mut phone = Handshake::pair_device(&device, &[8; PSK_LEN], &fingerprints()).unwrap();
        desk.read(&phone.write(b"").unwrap()).unwrap();
        phone.read(&desk.write(b"").unwrap()).unwrap();
        assert!(desk.read(&phone.write(b"").unwrap()).is_err());
    }

    #[test]
    fn a_handshake_fails_when_someone_stands_in_the_middle() {
        // A party between the two has its own DTLS certificate, so each side sees a different fingerprint.
        let (desktop, device) = (generate_keys().unwrap(), generate_keys().unwrap());
        let mut desk =
            Handshake::connect_desktop(&desktop, &prologue("AA:BB:CC", "11:22:33")).unwrap();
        let mut phone =
            Handshake::connect_device(&device, &desktop.public, &fingerprints()).unwrap();
        assert!(desk.read(&phone.write(b"").unwrap()).is_err());
        let mut desk =
            Handshake::pair_desktop(&desktop, &PSK, &prologue("99:99:99", "DD:EE:FF")).unwrap();
        let mut phone = Handshake::pair_device(&device, &PSK, &fingerprints()).unwrap();
        // With the pairing secret, even the first message is encrypted, so it fails there.
        let paired = (|| -> Result<(), String> {
            desk.read(&phone.write(b"")?)?;
            phone.read(&desk.write(b"")?)?;
            desk.read(&phone.write(b"")?)?;
            Ok(())
        })();
        assert!(paired.is_err());
    }

    #[test]
    fn a_later_connection_names_the_device_before_the_desktop_answers() {
        let (desktop, device) = (generate_keys().unwrap(), generate_keys().unwrap());
        let mut desk = Handshake::connect_desktop(&desktop, &fingerprints()).unwrap();
        let mut phone =
            Handshake::connect_device(&device, &desktop.public, &fingerprints()).unwrap();
        let hello = desk
            .read(&phone.write(b"{\"hello\":{\"version\":1}}").unwrap())
            .unwrap();
        assert_eq!(hello, b"{\"hello\":{\"version\":1}}");
        // The desktop looks the device up by this key, and answers only one it paired with.
        assert_eq!(desk.remote_key(), Some(device.public.clone()));
        phone.read(&desk.write(b"").unwrap()).unwrap();
        let (mut desk, mut phone) = (
            desk.finish(MAX_DEVICE_MESSAGE).unwrap(),
            phone.finish(usize::MAX).unwrap(),
        );
        let packets = desk.seal(b"welcome").unwrap();
        assert_eq!(phone.open(&packets[0]).unwrap(), Some(b"welcome".to_vec()));
    }

    #[test]
    fn a_device_that_kept_another_desktops_key_cannot_connect() {
        let (desktop, device, other) = (
            generate_keys().unwrap(),
            generate_keys().unwrap(),
            generate_keys().unwrap(),
        );
        let mut desk = Handshake::connect_desktop(&desktop, &fingerprints()).unwrap();
        let mut phone = Handshake::connect_device(&device, &other.public, &fingerprints()).unwrap();
        assert!(desk.read(&phone.write(b"").unwrap()).is_err());
    }

    #[test]
    fn large_messages_cross_in_several_packets_and_tampering_is_caught() {
        let (desktop, device) = (generate_keys().unwrap(), generate_keys().unwrap());
        let (mut desk, mut phone) = pair(&desktop, &device).unwrap();
        let message = vec![b'x'; FRAME_DATA * 3 + 5];
        let packets = desk.seal(&message).unwrap();
        assert_eq!(packets.len(), 4);
        assert!(
            packets
                .iter()
                .all(|packet| packet.len() <= MAX_NOISE_MESSAGE)
        );
        let received: Vec<_> = packets
            .iter()
            .filter_map(|packet| phone.open(packet).unwrap())
            .collect();
        assert_eq!(received, vec![message]);
        let mut packet = phone.seal(b"hi").unwrap().remove(0);
        packet[0] ^= 1;
        assert!(desk.open(&packet).is_err());
    }

    #[test]
    fn the_desktop_refuses_a_device_message_over_its_limit() {
        let (desktop, device) = (generate_keys().unwrap(), generate_keys().unwrap());
        let mut desk = Handshake::pair_desktop(&desktop, &PSK, &fingerprints()).unwrap();
        let mut phone = Handshake::pair_device(&device, &PSK, &fingerprints()).unwrap();
        desk.read(&phone.write(b"").unwrap()).unwrap();
        phone.read(&desk.write(b"").unwrap()).unwrap();
        desk.read(&phone.write(b"").unwrap()).unwrap();
        let (mut desk, mut phone) = (
            desk.finish(FRAME_DATA).unwrap(),
            phone.finish(usize::MAX).unwrap(),
        );
        let packets = phone.seal(&vec![1u8; FRAME_DATA + 1]).unwrap();
        assert!(desk.open(&packets[0]).unwrap().is_none());
        assert!(desk.open(&packets[1]).is_err());
    }

    #[test]
    fn keys_are_saved_as_hex_and_never_printed_whole() {
        let keys = generate_keys().unwrap();
        let saved = serde_json::to_string(&keys).unwrap();
        assert_eq!(serde_json::from_str::<Keys>(&saved).unwrap(), keys);
        assert!(!format!("{:?}", keys).contains(&hex::encode(&keys.private)));
    }
}
