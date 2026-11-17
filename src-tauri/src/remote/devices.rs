//! The devices paired with this desktop, and the desktop's own key, kept in `remote-devices.enc`.
//!
//! A device is found by the static key it paired with, and only while its pairing lasts (30 days, renewed on each
//! connection). The API tells the desktop which MyFi account sent each connection, and it must be the account the
//! desktop is signed in to, and the one the device paired under. Signing out of MyFi forgets every device.

use super::noise::{Keys, generate_keys};
use crate::prelude::*;

const FILE: &str = "remote-devices.enc";
/// How long a pairing lasts without a connection.
pub(crate) const PAIRING_MS: u64 = 30 * 24 * 60 * 60 * 1000;

/// What a device may do. Each level allows everything the ones before it do.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Level {
    /// Look at projects, pages, changes, runs and their output.
    View,
    /// Also edit, set variables, run trusted scripts, and stop runs and processes.
    Work,
    /// Also commit, pull, push, and change branches and files.
    Commit,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Device {
    pub id: String,
    pub name: String,
    /// The device's static Noise key, as hex.
    pub public_key: String,
    /// The MyFi account the device paired under.
    pub account_id: String,
    pub level: Level,
    pub paired_at: u64,
    pub expires_at: u64,
    #[serde(default)]
    pub last_seen: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceStore {
    /// Whether Remote Access is on.
    #[serde(default)]
    pub enabled: bool,
    /// The desktop's static key, made when first needed.
    #[serde(default)]
    pub desktop_keys: Option<Keys>,
    #[serde(default)]
    pub devices: Vec<Device>,
}

impl DeviceStore {
    /// The desktop's static key, made the first time.
    pub(crate) fn desktop_keys(&mut self) -> Result<Keys, String> {
        if self.desktop_keys.is_none() {
            self.desktop_keys = Some(generate_keys()?);
        }
        Ok(self.desktop_keys.clone().unwrap_or_else(|| unreachable!()))
    }

    /// Saves a device that finished pairing, at the View level. Pairing again with the same key replaces it.
    pub(crate) fn pair(
        &mut self,
        name: &str,
        public_key: &[u8],
        account_id: &str,
        now: u64,
    ) -> Device {
        let public_key = hex::encode(public_key);
        self.devices
            .retain(|device| device.public_key != public_key);
        let name = name.trim().chars().take(60).collect::<String>();
        let device = Device {
            id: Uuid::now_v7().to_string(),
            name: if name.is_empty() {
                String::from("Device")
            } else {
                name
            },
            public_key,
            account_id: account_id.into(),
            level: Level::View,
            paired_at: now,
            expires_at: now + PAIRING_MS,
            last_seen: None,
        };
        self.devices.push(device.clone());
        device
    }

    /// The device a connection comes from, found by its key. `sender` is the account the API says sent it, and
    /// `signed_in` the account this desktop is signed in to.
    pub(crate) fn find(
        &self,
        public_key: &[u8],
        sender: &str,
        signed_in: Option<&str>,
        now: u64,
    ) -> Result<&Device, String> {
        let signed_in =
            signed_in.ok_or_else(|| String::from("This desktop is not signed in to MyFi."))?;
        if sender.is_empty() || sender != signed_in {
            return Err(String::from("The device is signed in to another account."));
        }
        if !self.enabled {
            return Err(String::from("Remote Access is off."));
        }
        let key = hex::encode(public_key);
        let device = self
            .devices
            .iter()
            .find(|device| device.public_key == key)
            .ok_or_else(|| {
                String::from("This device is not paired. Pair it again from the desktop.")
            })?;
        if device.account_id != signed_in {
            return Err(String::from("The device paired under another account."));
        }
        if device.expires_at <= now {
            return Err(String::from(
                "The pairing has expired. Pair the device again from the desktop.",
            ));
        }
        Ok(device)
    }

    /// Notes a connection, which renews the pairing.
    pub(crate) fn connected(&mut self, id: &str, now: u64) {
        if let Some(device) = self.devices.iter_mut().find(|device| device.id == id) {
            device.last_seen = Some(now);
            device.expires_at = now + PAIRING_MS;
        }
    }

    pub(crate) fn set_level(&mut self, id: &str, level: Level) -> Result<(), String> {
        let device = self
            .devices
            .iter_mut()
            .find(|device| device.id == id)
            .ok_or_else(|| String::from("No such device."))?;
        device.level = level;
        Ok(())
    }

    pub(crate) fn remove(&mut self, id: &str) -> bool {
        let before = self.devices.len();
        self.devices.retain(|device| device.id != id);
        self.devices.len() != before
    }

    /// Drops pairings that have expired. Returns how many.
    pub(crate) fn prune(&mut self, now: u64) -> usize {
        let before = self.devices.len();
        self.devices.retain(|device| device.expires_at > now);
        before - self.devices.len()
    }

    /// Turns Remote Access off and forgets every device and the desktop's key, as signing out does. A device
    /// that kept the old key can no longer reach this desktop.
    pub(crate) fn forget_all(&mut self) {
        *self = Self::default();
    }
}

pub(crate) async fn load(app: &AppHandle) -> Result<DeviceStore, String> {
    let bytes = get_data_from_local_storage(app, FILE).await?;
    if bytes.is_empty() {
        return Ok(DeviceStore::default());
    }
    serde_json::from_slice(&bytes)
        .map_err(|err| format!("The paired devices could not be read: {}", err))
}

pub(crate) async fn save(app: &AppHandle, store: &DeviceStore) -> Result<(), String> {
    let json = serde_json::to_string(store).map_err(|err| err.to_string())?;
    save_json_to_local_storage("Paired devices", app, json, FILE)
        .await
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "account-1";

    fn store() -> DeviceStore {
        DeviceStore {
            enabled: true,
            ..Default::default()
        }
    }

    #[test]
    fn a_new_device_can_view_and_stays_paired_for_30_days() {
        let mut store = store();
        let device = store.pair("  Pixel  ", &[1, 2], ME, 1000);
        assert_eq!(device.name, "Pixel");
        assert_eq!(device.level, Level::View);
        assert_eq!(device.expires_at, 1000 + PAIRING_MS);
        assert_eq!(
            store.find(&[1, 2], ME, Some(ME), 2000).unwrap().id,
            device.id
        );
        assert!(
            store
                .find(&[1, 2], ME, Some(ME), 1000 + PAIRING_MS)
                .unwrap_err()
                .contains("expired")
        );
    }

    #[test]
    fn connecting_renews_the_pairing() {
        let mut store = store();
        let device = store.pair("Pixel", &[1], ME, 0);
        store.connected(&device.id, PAIRING_MS - 1);
        assert!(store.find(&[1], ME, Some(ME), PAIRING_MS + 5).is_ok());
        assert_eq!(store.devices[0].last_seen, Some(PAIRING_MS - 1));
    }

    #[test]
    fn only_the_desktops_own_account_reaches_it() {
        let mut store = store();
        store.pair("Pixel", &[1], ME, 0);
        assert!(
            store
                .find(&[1], "account-2", Some(ME), 1)
                .unwrap_err()
                .contains("another account")
        );
        assert!(store.find(&[1], "", Some(ME), 1).is_err());
        assert!(
            store
                .find(&[1], ME, None, 1)
                .unwrap_err()
                .contains("not signed in")
        );
        // A device paired under an account the desktop has since left cannot connect under the new one.
        store.pair("Old", &[2], "account-2", 0);
        assert!(
            store
                .find(&[2], ME, Some(ME), 1)
                .unwrap_err()
                .contains("another account")
        );
        assert!(
            store
                .find(&[3], ME, Some(ME), 1)
                .unwrap_err()
                .contains("not paired")
        );
    }

    #[test]
    fn nothing_connects_while_remote_access_is_off() {
        let mut store = DeviceStore::default();
        store.pair("Pixel", &[1], ME, 0);
        assert!(
            store
                .find(&[1], ME, Some(ME), 1)
                .unwrap_err()
                .contains("off")
        );
    }

    #[test]
    fn pairing_again_replaces_the_device_and_levels_change() {
        let mut store = store();
        let first = store.pair("Pixel", &[1], ME, 0);
        store.set_level(&first.id, Level::Commit).unwrap();
        let second = store.pair("Pixel 9", &[1], ME, 5);
        assert_eq!(store.devices.len(), 1);
        assert_eq!(
            store.devices[0].level,
            Level::View,
            "a new pairing starts at View again"
        );
        assert!(store.set_level(&first.id, Level::Work).is_err());
        assert!(store.remove(&second.id));
        assert!(!store.remove(&second.id));
        assert!(Level::View < Level::Work && Level::Work < Level::Commit);
    }

    #[test]
    fn expired_pairings_are_dropped_and_signing_out_forgets_everything() {
        let mut store = store();
        store.pair("Old", &[1], ME, 0);
        store.pair("New", &[2], ME, PAIRING_MS);
        assert_eq!(store.prune(PAIRING_MS + 1), 1);
        let key = store.desktop_keys().unwrap();
        assert_eq!(
            store.desktop_keys().unwrap(),
            key,
            "the desktop keeps its key"
        );
        store.forget_all();
        assert!(!store.enabled && store.devices.is_empty() && store.desktop_keys.is_none());
    }

    #[test]
    fn the_store_round_trips_through_json() {
        let mut store = store();
        store.desktop_keys().unwrap();
        store.pair("Pixel", &[9], ME, 3);
        let read: DeviceStore =
            serde_json::from_str(&serde_json::to_string(&store).unwrap()).unwrap();
        assert_eq!(read.devices, store.devices);
        assert_eq!(read.desktop_keys, store.desktop_keys);
        assert!(
            serde_json::to_string(&store)
                .unwrap()
                .contains("\"level\":\"view\"")
        );
    }
}
