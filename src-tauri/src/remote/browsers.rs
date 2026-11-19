//! The browsers that may connect to this computer, and the ones waiting to be approved.
//!
//! A browser is known by its public key. The approved list is kept only on this computer, in
//! `remote-connections.enc` with this computer's own signing key, and never sent to api.myfi.ws. A browser that
//! isn't on it is kept as a waiting request for 10 minutes, at most 10 at a time, until someone approves it here or
//! from a browser that is already connected, after checking its code matches the one on the new browser's screen.

use super::keys::{self, SigningKey};
use super::signal::Offer;
use crate::prelude::*;

const FILE: &str = "remote-connections.enc";
/// How long a waiting request is kept, and how long a refused browser stays refused.
pub(crate) const WAITING_MS: u64 = 10 * 60 * 1000;
pub(crate) const MAX_WAITING: usize = 10;
/// How many refused browsers are remembered. The oldest is forgotten first.
const MAX_REFUSED: usize = 50;

/// What a browser may do. Each level allows everything the ones before it do.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Level {
    /// Look at projects, pages, changes, runs and their output, and approve other browsers.
    #[default]
    View,
    /// Also edit, set variables, run trusted scripts, and stop runs and processes.
    Work,
    /// Also commit, pull, push, and change branches and files.
    Commit,
}

/// A browser that may connect.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Approved {
    /// Its public key, as it is sent.
    pub key: String,
    pub name: String,
    /// When it was approved, in milliseconds since 1970.
    pub added: u64,
    #[serde(default)]
    pub level: Level,
}

/// What is kept on this computer for Remote Connections.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Store {
    /// Whether Remote Connections is on.
    #[serde(default)]
    pub enabled: bool,
    /// What the user called this computer.
    #[serde(default)]
    pub name: String,
    /// The id api.myfi.ws gave this computer when Remote Connections was turned on.
    #[serde(default)]
    pub desktop_id: Option<String>,
    /// This computer's signing key, made the first time Remote Connections is turned on. Never sent anywhere.
    #[serde(default)]
    signing_key: Option<String>,
    #[serde(default)]
    pub approved: Vec<Approved>,
    /// Whether the computer may sleep while Remote Connections is on. It is kept awake unless this is set.
    #[serde(default)]
    pub allow_sleep: bool,
}

impl Store {
    /// This computer's signing key, made the first time.
    pub(crate) fn signing_key(&mut self) -> Result<SigningKey, String> {
        match &self.signing_key {
            Some(saved) => SigningKey::from_saved(saved),
            None => {
                let key = SigningKey::generate()?;
                self.signing_key = Some(key.saved().to_string());
                Ok(key)
            }
        }
    }

    pub(crate) fn find(&self, key: &str) -> Option<&Approved> {
        self.approved.iter().find(|browser| browser.key == key)
    }

    /// Adds a browser to the approved list, at the View level. Approving it again keeps its level and date.
    pub(crate) fn approve(&mut self, key: &str, name: &str, now: u64) {
        match self.approved.iter_mut().find(|browser| browser.key == key) {
            Some(browser) => browser.name = name.to_string(),
            None => self.approved.push(Approved {
                key: key.to_string(),
                name: name.to_string(),
                added: now,
                level: Level::View,
            }),
        }
    }

    /// Removes an approved browser. Returns whether it was there.
    pub(crate) fn remove(&mut self, key: &str) -> bool {
        let before = self.approved.len();
        self.approved.retain(|browser| browser.key != key);
        self.approved.len() != before
    }

    pub(crate) fn set_level(&mut self, key: &str, level: Level) -> Result<(), String> {
        let browser = self
            .approved
            .iter_mut()
            .find(|browser| browser.key == key)
            .ok_or_else(no_such_browser)?;
        browser.level = level;
        Ok(())
    }
}

pub(crate) fn no_such_browser() -> String {
    String::from("No such browser.")
}

/// A browser waiting to be approved.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Request {
    pub key: String,
    pub name: String,
    /// When it first asked, in milliseconds since 1970.
    pub asked: u64,
    /// When it last asked. The request is kept for 10 minutes after that.
    last_asked: u64,
}

/// A browser someone refused. It is answered `refused` for 10 minutes, unless it is allowed to ask again.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Refused {
    pub key: String,
    pub name: String,
    pub refused: u64,
}

/// The browsers waiting to be approved, and the ones refused in the last 10 minutes. Kept in memory only.
#[derive(Debug, Default)]
pub(crate) struct Waiting {
    requests: Vec<Request>,
    /// Refused browsers, with when each was refused.
    refused: Vec<Refused>,
}

/// What this computer does with an offer whose signature and time checked out.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Decision {
    /// The browser is approved: connect it, at its level.
    Connect(Level),
    /// The browser's request is kept for someone to approve. `new` when it wasn't already waiting.
    Approval { new: bool },
    /// The browser was refused in the last 10 minutes, or too many are waiting already.
    Refused,
}

impl Waiting {
    fn prune(&mut self, now: u64) {
        self.requests
            .retain(|request| now.saturating_sub(request.last_asked) < WAITING_MS);
        self.refused
            .retain(|browser| now.saturating_sub(browser.refused) < WAITING_MS);
    }

    /// The requests still waiting at `now`, oldest first.
    pub(crate) fn list(&mut self, now: u64) -> Vec<Request> {
        self.prune(now);
        self.requests.clone()
    }

    /// Decides what to answer an offer: connect an approved browser, refuse one refused lately, and keep any other
    /// as a waiting request.
    pub(crate) fn decide(&mut self, store: &Store, offer: &Offer, now: u64) -> Decision {
        self.prune(now);
        if let Some(browser) = store.find(&offer.key) {
            return Decision::Connect(browser.level);
        }
        if self.refused.iter().any(|browser| browser.key == offer.key) {
            return Decision::Refused;
        }
        if let Some(request) = self
            .requests
            .iter_mut()
            .find(|request| request.key == offer.key)
        {
            request.name = offer.name.clone();
            request.last_asked = now;
            return Decision::Approval { new: false };
        }
        if self.requests.len() >= MAX_WAITING {
            return Decision::Refused;
        }
        self.requests.push(Request {
            key: offer.key.clone(),
            name: offer.name.clone(),
            asked: now,
            last_asked: now,
        });
        Decision::Approval { new: true }
    }

    /// Takes a waiting request to approve it.
    pub(crate) fn take(&mut self, key: &str, now: u64) -> Option<Request> {
        self.prune(now);
        let index = self
            .requests
            .iter()
            .position(|request| request.key == key)?;
        Some(self.requests.remove(index))
    }

    /// Refuses a waiting request: it is dropped, and its browser is answered `refused` for the next 10 minutes.
    /// Returns whether it was waiting.
    pub(crate) fn refuse(&mut self, key: &str, now: u64) -> bool {
        let Some(request) = self.take(key, now) else {
            return false;
        };
        self.refused.push(Refused {
            key: request.key,
            name: request.name,
            refused: now,
        });
        if self.refused.len() > MAX_REFUSED {
            self.refused.remove(0);
        }
        true
    }

    /// The browsers refused in the last 10 minutes, oldest first.
    pub(crate) fn refused(&mut self, now: u64) -> Vec<Refused> {
        self.prune(now);
        self.refused.clone()
    }

    /// Lets a refused browser ask again, so its next offer waits for approval. Returns whether it was refused.
    pub(crate) fn allow(&mut self, key: &str) -> bool {
        let before = self.refused.len();
        self.refused.retain(|browser| browser.key != key);
        self.refused.len() != before
    }

    pub(crate) fn clear(&mut self) {
        *self = Self::default();
    }
}

/// The lists as a connected browser is sent them by `remote_browsers`: `{"approved": [{key, name, code, added,
/// current}], "waiting": [{key, name, code, asked}]}`. `current` marks the browser asking. Each code is worked out
/// here from the key.
pub(crate) fn lists(store: &Store, waiting: &[Request], current: Option<&str>) -> Value {
    let code = |key: &str| keys::browser_code(key).unwrap_or_default();
    serde_json::json!({
        "approved": store.approved.iter().map(|browser| serde_json::json!({
            "key": browser.key,
            "name": browser.name,
            "code": code(&browser.key),
            "added": browser.added,
            "current": current == Some(browser.key.as_str()),
        })).collect::<Vec<_>>(),
        "waiting": waiting.iter().map(|request| serde_json::json!({
            "key": request.key,
            "name": request.name,
            "code": code(&request.key),
            "asked": request.asked,
        })).collect::<Vec<_>>(),
    })
}

pub(crate) async fn load(app: &AppHandle) -> Result<Store, String> {
    let bytes = get_data_from_local_storage(app, FILE).await?;
    if bytes.is_empty() {
        return Ok(Store::default());
    }
    serde_json::from_slice(&bytes)
        .map_err(|err| format!("The approved browsers could not be read: {}", err))
}

pub(crate) async fn save(app: &AppHandle, store: &Store) -> Result<(), String> {
    let json = serde_json::to_string(store).map_err(|err| err.to_string())?;
    save_json_to_local_storage("Remote Connections", app, json, FILE)
        .await
        .map(|_| ())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::remote::keys::fixed;

    pub(crate) fn offer_from(key: &str, name: &str) -> Offer {
        Offer {
            sdp: "v=0\r\n".into(),
            key: key.into(),
            name: name.into(),
            time: 0,
        }
    }

    fn new_key() -> String {
        SigningKey::generate().unwrap().public_key()
    }

    #[test]
    fn an_unknown_browser_waits_and_an_approved_one_connects() {
        let mut store = Store::default();
        let mut waiting = Waiting::default();
        let offer = offer_from(fixed::PUBLIC_KEY, "Firefox on Android");
        assert_eq!(
            waiting.decide(&store, &offer, 1000),
            Decision::Approval { new: true }
        );
        assert_eq!(
            waiting.decide(&store, &offer, 4000),
            Decision::Approval { new: false },
            "asking again every few seconds keeps one request"
        );
        let listed = waiting.list(4000);
        assert_eq!(listed.len(), 1);
        assert_eq!(
            (listed[0].name.as_str(), listed[0].asked),
            ("Firefox on Android", 1000)
        );

        let request = waiting.take(fixed::PUBLIC_KEY, 5000).unwrap();
        store.approve(&request.key, &request.name, 5000);
        assert!(waiting.list(5000).is_empty());
        assert_eq!(
            waiting.decide(&store, &offer, 6000),
            Decision::Connect(Level::View),
            "a newly approved browser may look, until its level is raised"
        );
        assert_eq!(
            store.approved,
            vec![Approved {
                key: fixed::PUBLIC_KEY.into(),
                name: "Firefox on Android".into(),
                added: 5000,
                level: Level::View,
            }]
        );
    }

    #[test]
    fn a_request_is_kept_for_10_minutes_after_the_browser_last_asked() {
        let store = Store::default();
        let mut waiting = Waiting::default();
        let offer = offer_from(fixed::PUBLIC_KEY, "Firefox");
        waiting.decide(&store, &offer, 0);
        assert_eq!(waiting.list(WAITING_MS - 1).len(), 1);
        assert!(waiting.list(WAITING_MS).is_empty());
        assert!(waiting.take(fixed::PUBLIC_KEY, WAITING_MS).is_none());
        // A browser still asking keeps its request, with the time it first asked.
        waiting.decide(&store, &offer, 0);
        waiting.decide(&store, &offer, WAITING_MS - 1);
        let listed = waiting.list(WAITING_MS + 5);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].asked, 0);
    }

    #[test]
    fn at_most_10_browsers_wait_at_a_time() {
        let store = Store::default();
        let mut waiting = Waiting::default();
        for n in 0..MAX_WAITING {
            let offer = offer_from(&new_key(), &format!("Browser {}", n));
            assert_eq!(
                waiting.decide(&store, &offer, n as u64),
                Decision::Approval { new: true }
            );
        }
        let extra = offer_from(&new_key(), "One too many");
        assert_eq!(waiting.decide(&store, &extra, 100), Decision::Refused);
        assert_eq!(waiting.list(100).len(), MAX_WAITING);
        // Once the oldest has gone, there is room again.
        assert_eq!(
            waiting.decide(&store, &extra, WAITING_MS),
            Decision::Approval { new: true }
        );
        assert_eq!(waiting.list(WAITING_MS).len(), MAX_WAITING);
    }

    #[test]
    fn a_refused_browser_is_refused_for_10_minutes() {
        let store = Store::default();
        let mut waiting = Waiting::default();
        let offer = offer_from(fixed::PUBLIC_KEY, "Firefox");
        waiting.decide(&store, &offer, 0);
        assert!(waiting.refuse(fixed::PUBLIC_KEY, 1000));
        assert!(
            !waiting.refuse(fixed::PUBLIC_KEY, 1000),
            "it is no longer waiting"
        );
        assert!(waiting.list(1000).is_empty());
        assert_eq!(waiting.decide(&store, &offer, 2000), Decision::Refused);
        assert_eq!(
            waiting.refused(2000),
            vec![Refused {
                key: fixed::PUBLIC_KEY.into(),
                name: "Firefox".into(),
                refused: 1000
            }]
        );
        // Allowed again, its next offer waits for approval.
        assert!(waiting.allow(fixed::PUBLIC_KEY));
        assert!(!waiting.allow(fixed::PUBLIC_KEY));
        assert_eq!(
            waiting.decide(&store, &offer, 2500),
            Decision::Approval { new: true }
        );
        assert!(waiting.refuse(fixed::PUBLIC_KEY, 1000));
        assert!(waiting.refused(1000 + WAITING_MS).is_empty());
        assert_eq!(
            waiting.decide(&store, &offer, 1000 + WAITING_MS),
            Decision::Approval { new: true }
        );
    }

    #[test]
    fn approved_browsers_are_removed_and_their_level_changed_by_key() {
        let mut store = Store::default();
        let other = new_key();
        store.approve(fixed::PUBLIC_KEY, "Firefox", 1);
        store.approve(&other, "Safari", 2);
        store.set_level(&other, Level::Commit).unwrap();
        assert_eq!(store.find(&other).unwrap().level, Level::Commit);
        // Approving a browser again renames it, and keeps its level and date.
        store.approve(&other, "Safari on iPad", 9);
        assert_eq!(
            store.find(&other),
            Some(&Approved {
                key: other.clone(),
                name: "Safari on iPad".into(),
                added: 2,
                level: Level::Commit
            })
        );
        assert!(store.remove(fixed::PUBLIC_KEY));
        assert!(!store.remove(fixed::PUBLIC_KEY));
        assert_eq!(
            store.set_level(fixed::PUBLIC_KEY, Level::Work).unwrap_err(),
            "No such browser."
        );
        assert!(Level::View < Level::Work && Level::Work < Level::Commit);
    }

    #[test]
    fn the_lists_show_each_browsers_code_and_mark_the_one_asking() {
        let mut store = Store::default();
        let mut waiting = Waiting::default();
        let other = new_key();
        store.approve(fixed::PUBLIC_KEY, "Firefox", 5);
        waiting.decide(&store, &offer_from(&other, "Safari"), 7);
        let lists = lists(&store, &waiting.list(8), Some(fixed::PUBLIC_KEY));
        assert_eq!(
            lists,
            serde_json::json!({
                "approved": [{ "key": fixed::PUBLIC_KEY, "name": "Firefox", "code": fixed::CODE, "added": 5, "current": true }],
                "waiting": [{ "key": other, "name": "Safari", "code": keys::browser_code(&other).unwrap(), "asked": 7 }],
            })
        );
        assert_eq!(
            super::lists(&store, &[], None)["approved"][0]["current"],
            false
        );
    }

    #[test]
    fn the_signing_key_is_made_once_and_saved_with_the_store() {
        let mut store = Store::default();
        assert!(store.signing_key.is_none());
        let key = store.signing_key().unwrap().public_key();
        assert!(store.signing_key.is_some());
        assert_eq!(store.signing_key().unwrap().public_key(), key);
        store.approve(fixed::PUBLIC_KEY, "Firefox", 3);
        store.enabled = true;
        store.name = "Desk".into();
        store.desktop_id = Some("d1".into());
        let json = serde_json::to_string(&store).unwrap();
        let mut read: Store = serde_json::from_str(&json).unwrap();
        assert_eq!(read.signing_key().unwrap().public_key(), key);
        assert_eq!(read.approved, store.approved);
        assert!(read.enabled);
        assert!(
            json.contains("\"level\":\"view\""),
            "levels are saved by name"
        );
        // A store saved by an older version, with fields missing, still reads.
        let old: Store = serde_json::from_str(
            &serde_json::json!({ "approved": [{ "key": "k", "name": "n", "added": 1 }] })
                .to_string(),
        )
        .unwrap();
        assert_eq!(old.approved[0].level, Level::View);
    }
}
