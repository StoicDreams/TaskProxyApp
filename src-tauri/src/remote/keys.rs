//! The keys Remote Connections signs with: ECDSA on P-256 with SHA-256, as every browser's Web Crypto has it.
//!
//! - A public key is the 65 byte uncompressed point, as base64url without padding: 87 characters.
//! - A signature is the 64 bytes `r || s`, as base64url without padding: 86 characters.
//! - A hash is SHA-256, as 64 lowercase hex characters.
//! - What is signed is the UTF-8 of lines joined with `\n`, with no line at the end.
//! - A browser code is how people compare a browser across two screens, worked out here from its key.
//!
//! The computer's own key is made once and kept with the app's private data. Only its public half leaves.

use crate::prelude::*;
use ring::rand::SystemRandom;
use ring::signature::{
    ECDSA_P256_SHA256_FIXED, ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair,
    UnparsedPublicKey,
};

/// The length of a public key: the uncompressed point.
pub(crate) const PUBLIC_KEY_BYTES: usize = 65;
pub(crate) const SIGNATURE_BYTES: usize = 64;
const CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// This computer's signing key.
pub(crate) struct SigningKey {
    pair: EcdsaKeyPair,
    /// The key as it is saved: PKCS#8, as base64url.
    saved: String,
}

impl SigningKey {
    /// Makes a new key.
    pub(crate) fn generate() -> Result<Self, String> {
        let document =
            EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new())
                .map_err(|_| String::from("This computer's key could not be made."))?;
        Self::from_saved(&URL_SAFE_NO_PAD.encode(document.as_ref()))
    }

    /// Reads a key as `saved` gives it.
    pub(crate) fn from_saved(saved: &str) -> Result<Self, String> {
        let unreadable = || String::from("This computer's key could not be read.");
        let bytes = URL_SAFE_NO_PAD.decode(saved).map_err(|_| unreadable())?;
        let pair = EcdsaKeyPair::from_pkcs8(
            &ECDSA_P256_SHA256_FIXED_SIGNING,
            &bytes,
            &SystemRandom::new(),
        )
        .map_err(|_| unreadable())?;
        Ok(Self {
            pair,
            saved: saved.to_string(),
        })
    }

    /// A key from its private number and public point, as test vectors give them.
    #[cfg(test)]
    pub(crate) fn from_parts(private: &[u8], public: &[u8]) -> Self {
        let pair = EcdsaKeyPair::from_private_key_and_public_key(
            &ECDSA_P256_SHA256_FIXED_SIGNING,
            private,
            public,
            &SystemRandom::new(),
        )
        .expect("a P-256 key");
        Self {
            pair,
            saved: String::new(),
        }
    }

    /// The key to keep with the app's private data. It is never sent anywhere.
    pub(crate) fn saved(&self) -> &str {
        &self.saved
    }

    /// The public half, as it is sent: 87 characters.
    pub(crate) fn public_key(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.pair.public_key().as_ref())
    }

    /// Signs lines, as 86 characters.
    pub(crate) fn sign(&self, lines: &[&str]) -> Result<String, String> {
        self.pair
            .sign(&SystemRandom::new(), lines.join("\n").as_bytes())
            .map(|signature| URL_SAFE_NO_PAD.encode(signature.as_ref()))
            .map_err(|_| String::from("The answer could not be signed."))
    }
}

/// A public key's 65 bytes, from the 87 characters it is sent as. None for anything else.
pub(crate) fn public_key_bytes(key: &str) -> Option<Vec<u8>> {
    if key.len() != 87 {
        return None;
    }
    URL_SAFE_NO_PAD
        .decode(key)
        .ok()
        .filter(|bytes| bytes.len() == PUBLIC_KEY_BYTES && bytes[0] == 4)
}

/// Whether `signature` is `key`'s signature of `lines`.
pub(crate) fn verify(key: &str, lines: &[&str], signature: &str) -> bool {
    let Some(key) = public_key_bytes(key) else {
        return false;
    };
    let Ok(signature) = URL_SAFE_NO_PAD.decode(signature) else {
        return false;
    };
    signature.len() == SIGNATURE_BYTES
        && UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, key)
            .verify(lines.join("\n").as_bytes(), &signature)
            .is_ok()
}

/// SHA-256 as 64 lowercase hex characters.
pub(crate) fn sha256_hex(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

/// The code people compare a browser by, such as `ABC-DEF`: SHA-256 of the key's 65 bytes, the first 6 bytes each
/// taken modulo 32 into the alphabet. None when `key` isn't a public key.
pub(crate) fn browser_code(key: &str) -> Option<String> {
    let hash = Sha256::digest(public_key_bytes(key)?);
    let letters: Vec<char> = hash[..6]
        .iter()
        .map(|byte| CODE_ALPHABET[(byte % 32) as usize] as char)
        .collect();
    Some(format!(
        "{}-{}",
        letters[..3].iter().collect::<String>(),
        letters[3..].iter().collect::<String>()
    ))
}

/// Fixed values the website's tests assert too, so both sides agree on every format.
#[cfg(test)]
pub(crate) mod fixed {
    /// The P-256 key from RFC 6979, A.2.5: its private number, and its public point's x and y.
    pub(crate) const PRIVATE_HEX: &str =
        "c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721";
    pub(crate) const X_HEX: &str =
        "60fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb6";
    pub(crate) const Y_HEX: &str =
        "7903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299";
    /// The public key as it is sent.
    pub(crate) const PUBLIC_KEY: &str =
        "BGD-1LolWp0xyWHrdMY1bWjASbiSO2H6bOZpYi5g8p-2eQP-EAi4vJmkGunpVii8ZPLxsgwtfp9Rd6PClNRGIpk";
    pub(crate) const CODE: &str = "TMG-QVK";
    /// RFC 6979's signature of "sample" with SHA-256, as `r || s`.
    pub(crate) const SAMPLE_SIGNATURE: &str =
        "79SLKqy2qP0RQN2c1F6B1p0sh3tWqvmRw00OqE6vNxb3yxyULWV8QdQ2x6G24p9l8-kA27mv9AZNxKsvhDrNqA";

    pub(crate) fn key() -> super::SigningKey {
        let public = hex::decode(format!("04{}{}", X_HEX, Y_HEX)).unwrap();
        super::SigningKey::from_parts(&hex::decode(PRIVATE_HEX).unwrap(), &public)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fixed_key_has_the_formats_the_website_uses() {
        let key = fixed::key();
        let public = key.public_key();
        assert_eq!(public, fixed::PUBLIC_KEY);
        assert_eq!(public.len(), 87);
        assert!(!public.contains('=') && !public.contains('+') && !public.contains('/'));
        assert_eq!(public_key_bytes(&public).unwrap().len(), 65);
        assert_eq!(browser_code(&public).unwrap(), fixed::CODE);

        let signature = key.sign(&["line one", "line two"]).unwrap();
        assert_eq!(signature.len(), 86);
        assert_eq!(URL_SAFE_NO_PAD.decode(&signature).unwrap().len(), 64);
        assert!(verify(&public, &["line one", "line two"], &signature));
        // What is signed is the lines joined with a newline, with none at the end.
        assert!(verify(&public, &["line one\nline two"], &signature));
        assert!(!verify(&public, &["line one", "line two", ""], &signature));
    }

    #[test]
    fn a_signature_made_elsewhere_verifies() {
        // RFC 6979, A.2.5: "sample" signed with SHA-256, which Web Crypto verifies the same way.
        assert_eq!(fixed::SAMPLE_SIGNATURE.len(), 86);
        assert!(verify(
            fixed::PUBLIC_KEY,
            &["sample"],
            fixed::SAMPLE_SIGNATURE
        ));
        assert!(!verify(
            fixed::PUBLIC_KEY,
            &["samples"],
            fixed::SAMPLE_SIGNATURE
        ));
    }

    /// The vector the website's tests assert too: a test-only key, its code, and a signature Web Crypto made.
    #[test]
    fn the_websites_shared_vector_verifies() {
        const PRIVATE: &str = "nwalgP8RCxNyKT03cWpwENG4f51KzAIVYb_-xrGjPvw";
        const PUBLIC: &str = "BDQklSCQV2O_sD6Q3SzG9W2MHIsh1ujx6LVXDiQ_CIuyQc5EFRX2eOd0P6WPbcA-apvXKZ0ZWyvOAS2NuCxn0yY";
        const SIGNATURE: &str = "2wiT06nzIQdBaAR-vbS_1YHNntD1dplyl4TEwaD6RtUusFF5HU7yXqG55CDKU-Mi7K-_xSaq_H66ZEWkEPEtug";
        let lines = [
            "taskproxy-remote-offer-v1",
            "11111111-2222-3333-4444-555555555555",
            "1795000000000",
            "4cf57627095fbc4886de378fcb3407917caca20bf078ca3f0fac3e5ca9b192d8",
        ];
        assert_eq!(sha256_hex("v=0\r\n"), lines[3]);
        assert_eq!(PUBLIC.len(), 87);
        assert_eq!(SIGNATURE.len(), 86);
        assert_eq!(browser_code(PUBLIC).unwrap(), "C4P-SCS");
        assert!(
            hex::encode(Sha256::digest(public_key_bytes(PUBLIC).unwrap()))
                .starts_with("423acd50e270")
        );
        assert!(
            verify(PUBLIC, &lines, SIGNATURE),
            "what Web Crypto signs verifies here"
        );
        // The key pair is only accepted when the public key is the private number's own.
        let key = SigningKey::from_parts(
            &URL_SAFE_NO_PAD.decode(PRIVATE).unwrap(),
            &public_key_bytes(PUBLIC).unwrap(),
        );
        assert_eq!(key.public_key(), PUBLIC);
        assert!(verify(PUBLIC, &lines, &key.sign(&lines).unwrap()));
    }

    #[test]
    fn a_changed_message_key_or_signature_does_not_verify() {
        let key = SigningKey::generate().unwrap();
        let other = SigningKey::generate().unwrap();
        let signature = key.sign(&["a", "b"]).unwrap();
        assert!(verify(&key.public_key(), &["a", "b"], &signature));
        assert!(!verify(&key.public_key(), &["a", "c"], &signature));
        assert!(!verify(&other.public_key(), &["a", "b"], &signature));
        let mut changed = URL_SAFE_NO_PAD.decode(&signature).unwrap();
        changed[10] ^= 1;
        assert!(!verify(
            &key.public_key(),
            &["a", "b"],
            &URL_SAFE_NO_PAD.encode(changed)
        ));
        assert!(!verify(&key.public_key(), &["a", "b"], "not a signature"));
        assert!(!verify("not a key", &["a", "b"], &signature));
        // A DER signature, as other libraries give by default, is not the 64 bytes this takes.
        assert!(!verify(
            &key.public_key(),
            &["a", "b"],
            &URL_SAFE_NO_PAD.encode([0x30u8; 70])
        ));
    }

    #[test]
    fn a_saved_key_is_the_same_key_when_read_again() {
        let key = SigningKey::generate().unwrap();
        let read = SigningKey::from_saved(key.saved()).unwrap();
        assert_eq!(read.public_key(), key.public_key());
        assert!(verify(
            &key.public_key(),
            &["x"],
            &read.sign(&["x"]).unwrap()
        ));
        assert!(SigningKey::from_saved("nonsense").is_err());
        assert_ne!(
            SigningKey::generate().unwrap().public_key(),
            key.public_key()
        );
    }

    #[test]
    fn only_a_65_byte_point_in_87_characters_is_a_public_key() {
        assert!(public_key_bytes(fixed::PUBLIC_KEY).is_some());
        assert!(public_key_bytes(&format!("{}=", fixed::PUBLIC_KEY)).is_none());
        assert!(public_key_bytes(&fixed::PUBLIC_KEY[..86]).is_none());
        // A compressed point, or 65 bytes that don't start as a point does.
        assert!(public_key_bytes(&URL_SAFE_NO_PAD.encode([2u8; 33])).is_none());
        assert!(public_key_bytes(&URL_SAFE_NO_PAD.encode([9u8; 65])).is_none());
        assert!(browser_code("short").is_none());
    }

    #[test]
    fn a_code_is_six_characters_people_can_tell_apart() {
        let code = browser_code(&SigningKey::generate().unwrap().public_key()).unwrap();
        assert_eq!(code.len(), 7);
        assert_eq!(code.as_bytes()[3], b'-');
        assert!(
            code.replace('-', "")
                .bytes()
                .all(|letter| CODE_ALPHABET.contains(&letter))
        );
        for confusing in ['I', 'O', '0', '1'] {
            assert!(!CODE_ALPHABET.contains(&(confusing as u8)));
        }
    }

    #[test]
    fn hashes_are_lowercase_hex() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
