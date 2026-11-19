//! The two pieces of text api.myfi.ws passes between a browser and this computer: the browser's signed offer, and
//! this computer's signed answer (the Remote Connections Protocol page).
//!
//! The API and database aren't trusted to vouch for either side. An offer is only read once its signature checks
//! out for this computer's own id, and every answer is signed, whatever its status, so a browser can tell it came
//! from the computer whose key it remembers.

use super::keys::{self, SigningKey};
use crate::prelude::*;

const OFFER_LABEL: &str = "taskproxy-remote-offer-v1";
const ANSWER_LABEL: &str = "taskproxy-remote-answer-v1";
/// How far an offer's time may be from this computer's clock.
pub(crate) const OFFER_TIME_MS: u64 = 2 * 60 * 1000;
/// A browser's name is 1 to 60 characters.
pub(crate) const NAME_CHARS: usize = 60;

/// An offer whose signature and time checked out. Whether its browser is approved is the browser list's to say.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Offer {
    pub sdp: String,
    /// The browser's public key, as it was sent.
    pub key: String,
    /// What the browser calls itself. A label for the person approving it, which proves nothing.
    pub name: String,
    pub time: u64,
}

/// Why an offer was refused, with the hash of its SDP for the answer's signature, when it had one.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Refusal {
    pub reason: &'static str,
    pub sdp_hash: String,
}

impl Offer {
    pub(crate) fn sdp_hash(&self) -> String {
        keys::sha256_hex(&self.sdp)
    }
}

/// The lines a browser signs for its offer.
pub(crate) fn offer_lines(desktop_id: &str, time: u64, sdp: &str) -> [String; 4] {
    [
        OFFER_LABEL.to_string(),
        desktop_id.to_string(),
        time.to_string(),
        keys::sha256_hex(sdp),
    ]
}

/// Reads the `offer` text of a connection request for the computer `desktop_id`, at `now` (milliseconds since
/// 1970). It is accepted only when `v` is 1 and every field is there, its signature verifies with its own key for
/// this computer, and its time is within 2 minutes of this computer's clock.
pub(crate) fn read_offer(text: &str, desktop_id: &str, now: u64) -> Result<Offer, Refusal> {
    let json: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    let text_of = |name: &str| json.get(name).and_then(Value::as_str);
    let sdp = text_of("sdp").filter(|sdp| !sdp.is_empty());
    let refuse = |reason| Refusal {
        reason,
        sdp_hash: sdp.map(keys::sha256_hex).unwrap_or_default(),
    };
    let (Some(version), Some(sdp), Some(key), Some(name), Some(time), Some(signature)) = (
        json.get("v"),
        sdp,
        text_of("browserKey"),
        text_of("browserName"),
        json.get("time").and_then(Value::as_u64),
        text_of("sig"),
    ) else {
        return Err(refuse("The offer is missing something."));
    };
    if version.as_u64() != Some(1) {
        return Err(refuse("The offer is for another version."));
    }
    let name_chars = name.chars().count();
    if !(1..=NAME_CHARS).contains(&name_chars) || name.chars().any(char::is_control) {
        return Err(refuse(
            "The browser's name must be 1 to 60 characters on one line.",
        ));
    }
    let lines = offer_lines(desktop_id, time, sdp);
    if !keys::verify(key, &lines.each_ref().map(String::as_str), signature) {
        return Err(refuse("The offer's signature is not its browser's."));
    }
    if now.abs_diff(time) > OFFER_TIME_MS {
        return Err(refuse(
            "The offer's time is too far from this computer's clock.",
        ));
    }
    Ok(Offer {
        sdp: sdp.to_string(),
        key: key.to_string(),
        name: name.to_string(),
        time,
    })
}

/// What an answer says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Status {
    /// The browser is approved. Connect.
    Ok,
    /// The browser isn't approved yet, and its request was kept for someone to approve.
    Approval,
    /// The offer failed a check, or this browser was refused.
    Refused,
}

impl Status {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Status::Ok => "ok",
            Status::Approval => "approval",
            Status::Refused => "refused",
        }
    }
}

/// The lines this computer signs for its answer. A missing SDP's hash is an empty line.
pub(crate) fn answer_lines(
    connection_id: &str,
    status: Status,
    offer_sdp_hash: &str,
    sdp: Option<&str>,
) -> [String; 5] {
    [
        ANSWER_LABEL.to_string(),
        connection_id.to_string(),
        status.as_str().to_string(),
        offer_sdp_hash.to_string(),
        sdp.map(keys::sha256_hex).unwrap_or_default(),
    ]
}

/// The `answer` text for a connection request, signed with this computer's key. Only `ok` carries an SDP.
pub(crate) fn answer(
    key: &SigningKey,
    connection_id: &str,
    status: Status,
    offer_sdp_hash: &str,
    sdp: Option<&str>,
) -> Result<String, String> {
    let sdp = sdp.filter(|_| status == Status::Ok);
    let lines = answer_lines(connection_id, status, offer_sdp_hash, sdp);
    let signature = key.sign(&lines.each_ref().map(String::as_str))?;
    let mut json = serde_json::json!({ "v": 1, "status": status.as_str(), "sig": signature });
    if let Some(sdp) = sdp {
        json["sdp"] = Value::String(sdp.to_string());
    }
    Ok(json.to_string())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::remote::keys::fixed;
    use serde_json::json;

    pub(crate) const DESK: &str = "3160d8e4-e8dd-43c7-a397-43b17ef46cbc";
    const CONNECTION: &str = "9b2e1c64-5a0f-4c8e-b7d1-0e6f3a2c4d58";
    const SDP: &str = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n";
    const ANSWER_SDP: &str = "v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\ns=-\r\n";
    const TIME: u64 = 1_795_000_000_000;
    /// The fixed key's signature of the offer below, made outside the app, as a browser's Web Crypto would.
    const OFFER_SIGNATURE: &str =
        "7jjSoaG2ic-UaBnY3ue9ZBmshKaC75arxVUlddh3K4K30g3FAkezaybTBhSVInKoqMjQfdou46Dfz2W6A0tNZw";
    /// The fixed key's signatures of the answers below, made outside the app.
    const ANSWER_OK_SIGNATURE: &str =
        "oebqkqwjjSk9ehFp_C9KbcLDjrEXz_4KZblcLzSfcouN5OxN4zBe2t5G9BDYNIlnWM_iprcMhxmpu_tB8zsnKA";
    const ANSWER_APPROVAL_SIGNATURE: &str =
        "xQP9Zi0yKFfV7G1CS2eISlCK_S8Jq-eHoqIYus4nPpjHpWbLJEbiF2yN9H85epqvxLJa3HrR5PZOBkYAY6zKaQ";

    /// An offer as a browser makes it, signed by `key` for the computer `desk`.
    pub(crate) fn signed_offer(
        key: &SigningKey,
        desk: &str,
        name: &str,
        time: u64,
        sdp: &str,
    ) -> Value {
        let lines = offer_lines(desk, time, sdp);
        json!({
            "v": 1, "sdp": sdp, "browserKey": key.public_key(), "browserName": name, "time": time,
            "sig": key.sign(&lines.each_ref().map(String::as_str)).unwrap(),
        })
    }

    fn offer() -> Value {
        signed_offer(&fixed::key(), DESK, "Firefox on Android", TIME, SDP)
    }

    fn reason(offer: &Value, now: u64) -> &'static str {
        read_offer(&offer.to_string(), DESK, now)
            .unwrap_err()
            .reason
    }

    #[test]
    fn an_offer_signed_elsewhere_is_read() {
        assert_eq!(
            offer_lines(DESK, TIME, SDP).join("\n"),
            "taskproxy-remote-offer-v1\n3160d8e4-e8dd-43c7-a397-43b17ef46cbc\n1795000000000\n\
             066176ee87286bc91fa7b752089675f4578632895d3ef602ba780dc1719c770f"
        );
        let text = json!({
            "v": 1, "sdp": SDP, "browserKey": fixed::PUBLIC_KEY, "browserName": "Firefox on Android",
            "time": TIME, "sig": OFFER_SIGNATURE,
        })
        .to_string();
        let offer = read_offer(&text, DESK, TIME + 5000).unwrap();
        assert_eq!(
            offer,
            Offer {
                sdp: SDP.into(),
                key: fixed::PUBLIC_KEY.into(),
                name: "Firefox on Android".into(),
                time: TIME,
            }
        );
        assert_eq!(
            offer.sdp_hash(),
            "066176ee87286bc91fa7b752089675f4578632895d3ef602ba780dc1719c770f"
        );
    }

    #[test]
    fn an_offer_this_app_signs_is_read_the_same_way() {
        assert!(read_offer(&offer().to_string(), DESK, TIME).is_ok());
    }

    #[test]
    fn an_offer_needs_version_1_and_every_field() {
        for field in ["v", "sdp", "browserKey", "browserName", "time", "sig"] {
            let mut offer = offer();
            offer.as_object_mut().unwrap().remove(field);
            assert_eq!(
                reason(&offer, TIME),
                "The offer is missing something.",
                "{}",
                field
            );
        }
        let mut other = offer();
        other["v"] = json!(2);
        assert_eq!(reason(&other, TIME), "The offer is for another version.");
        let mut text_time = offer();
        text_time["time"] = json!(TIME.to_string());
        assert_eq!(reason(&text_time, TIME), "The offer is missing something.");
        for text in ["", "not json", "[]", "{}"] {
            let refused = read_offer(text, DESK, TIME).unwrap_err();
            assert_eq!(refused.sdp_hash, "", "{:?}", text);
        }
    }

    #[test]
    fn a_refusal_carries_the_hash_of_the_sdp_it_was_given() {
        let mut offer = offer();
        offer["sig"] = json!("x");
        let refused = read_offer(&offer.to_string(), DESK, TIME).unwrap_err();
        assert_eq!(refused.sdp_hash, keys::sha256_hex(SDP));
    }

    #[test]
    fn an_offer_must_be_signed_by_its_own_key_for_this_computer() {
        let wrong = "The offer's signature is not its browser's.";
        // Signed for another computer on the account.
        let elsewhere = signed_offer(
            &fixed::key(),
            "00000000-0000-4000-8000-000000000001",
            "Firefox",
            TIME,
            SDP,
        );
        assert_eq!(reason(&elsewhere, TIME), wrong);
        // Someone swaps the SDP for their own, the time, or the key, and keeps the signature.
        let mut swapped = offer();
        swapped["sdp"] = json!(SDP.replace("127.0.0.1", "10.0.0.9"));
        assert_eq!(reason(&swapped, TIME), wrong);
        let mut later = offer();
        later["time"] = json!(TIME + 1);
        assert_eq!(reason(&later, TIME), wrong);
        let mut other_key = offer();
        other_key["browserKey"] = json!(SigningKey::generate().unwrap().public_key());
        assert_eq!(reason(&other_key, TIME), wrong);
        let mut no_key = offer();
        no_key["browserKey"] = json!("AAAA");
        assert_eq!(reason(&no_key, TIME), wrong);
    }

    #[test]
    fn an_offer_is_good_for_2_minutes_either_side_of_this_computers_clock() {
        let offer = offer();
        let late = "The offer's time is too far from this computer's clock.";
        assert!(read_offer(&offer.to_string(), DESK, TIME + OFFER_TIME_MS).is_ok());
        assert!(read_offer(&offer.to_string(), DESK, TIME - OFFER_TIME_MS).is_ok());
        assert_eq!(reason(&offer, TIME + OFFER_TIME_MS + 1), late);
        assert_eq!(reason(&offer, TIME - OFFER_TIME_MS - 1), late);
    }

    #[test]
    fn a_browsers_name_is_1_to_60_characters_on_one_line() {
        let named = |name: &str| signed_offer(&fixed::key(), DESK, name, TIME, SDP);
        let bad = "The browser's name must be 1 to 60 characters on one line.";
        assert!(read_offer(&named(&"é".repeat(60)).to_string(), DESK, TIME).is_ok());
        assert_eq!(reason(&named(&"x".repeat(61)), TIME), bad);
        assert_eq!(reason(&named(""), TIME), bad);
        assert_eq!(reason(&named("Fire\nfox"), TIME), bad);
    }

    #[test]
    fn answers_are_signed_whatever_their_status() {
        let key = fixed::key();
        let offer_hash = keys::sha256_hex(SDP);
        assert_eq!(
            answer_lines(CONNECTION, Status::Ok, &offer_hash, Some(ANSWER_SDP)).join("\n"),
            "taskproxy-remote-answer-v1\n9b2e1c64-5a0f-4c8e-b7d1-0e6f3a2c4d58\nok\n\
             066176ee87286bc91fa7b752089675f4578632895d3ef602ba780dc1719c770f\n\
             9e2e120df876719229e4a8df14eaaa3f3be266fe9382f32799fefaf18ac46176"
        );
        assert_eq!(
            answer_lines(CONNECTION, Status::Approval, &offer_hash, None).join("\n"),
            "taskproxy-remote-answer-v1\n9b2e1c64-5a0f-4c8e-b7d1-0e6f3a2c4d58\napproval\n\
             066176ee87286bc91fa7b752089675f4578632895d3ef602ba780dc1719c770f\n"
        );
        // Signatures of the same lines made outside the app verify, so both sides sign the same bytes.
        let ok_lines = answer_lines(CONNECTION, Status::Ok, &offer_hash, Some(ANSWER_SDP));
        assert!(keys::verify(
            fixed::PUBLIC_KEY,
            &ok_lines.each_ref().map(String::as_str),
            ANSWER_OK_SIGNATURE
        ));
        let approval_lines = answer_lines(CONNECTION, Status::Approval, &offer_hash, None);
        assert!(keys::verify(
            fixed::PUBLIC_KEY,
            &approval_lines.each_ref().map(String::as_str),
            ANSWER_APPROVAL_SIGNATURE
        ));

        for (status, sdp) in [
            (Status::Ok, Some(ANSWER_SDP)),
            (Status::Approval, None),
            (Status::Refused, None),
        ] {
            let text = answer(&key, CONNECTION, status, &offer_hash, sdp).unwrap();
            let json: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(json["v"], 1);
            assert_eq!(json["status"], status.as_str());
            assert_eq!(json.get("sdp").and_then(Value::as_str), sdp);
            let lines = answer_lines(CONNECTION, status, &offer_hash, sdp);
            assert!(
                keys::verify(
                    &key.public_key(),
                    &lines.each_ref().map(String::as_str),
                    json["sig"].as_str().unwrap()
                ),
                "{:?}",
                status
            );
            // An answer is for one connection, and its status can't be changed.
            let other = answer_lines("another-connection", status, &offer_hash, sdp);
            assert!(!keys::verify(
                &key.public_key(),
                &other.each_ref().map(String::as_str),
                json["sig"].as_str().unwrap()
            ));
        }
    }

    #[test]
    fn only_an_ok_answer_carries_an_sdp() {
        let text = answer(
            &fixed::key(),
            CONNECTION,
            Status::Refused,
            "",
            Some(ANSWER_SDP),
        )
        .unwrap();
        let json: Value = serde_json::from_str(&text).unwrap();
        assert!(json.get("sdp").is_none());
        let lines = answer_lines(CONNECTION, Status::Refused, "", None);
        assert!(keys::verify(
            fixed::PUBLIC_KEY,
            &lines.each_ref().map(String::as_str),
            json["sig"].as_str().unwrap()
        ));
    }
}
