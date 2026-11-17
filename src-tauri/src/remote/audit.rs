//! The log of every command a remote device sent: when, which device, which command, and whether it worked.
//! Arguments are never logged, since they can carry values a device set, such as a secret. The last 1000 are
//! kept, in `remote-log.enc`.

use crate::prelude::*;
use std::collections::VecDeque;

const FILE: &str = "remote-log.enc";
pub(crate) const KEEP: usize = 1000;
/// Errors are cut to this many characters.
const ERROR_CHARS: usize = 300;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    pub at: u64,
    pub device_id: String,
    pub device_name: String,
    pub cmd: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub(crate) struct AuditLog {
    entries: VecDeque<Entry>,
    /// Whether there are entries not saved yet.
    #[serde(skip)]
    dirty: bool,
}

impl AuditLog {
    pub(crate) fn record(&mut self, mut entry: Entry) {
        if let Some(error) = &entry.error
            && error.chars().count() > ERROR_CHARS
        {
            entry.error = Some(error.chars().take(ERROR_CHARS).collect::<String>() + "…");
        }
        self.entries.push_back(entry);
        while self.entries.len() > KEEP {
            self.entries.pop_front();
        }
        self.dirty = true;
    }

    /// The entries, the latest first.
    pub(crate) fn latest(&self) -> Vec<Entry> {
        self.entries.iter().rev().cloned().collect()
    }

    /// The log as JSON to save, when it changed since it was last saved.
    fn take_changes(&mut self) -> Option<String> {
        if !self.dirty {
            return None;
        }
        self.dirty = false;
        serde_json::to_string(self).ok()
    }
}

pub(crate) async fn load(app: &AppHandle) -> Result<AuditLog, String> {
    let bytes = get_data_from_local_storage(app, FILE).await?;
    if bytes.is_empty() {
        return Ok(AuditLog::default());
    }
    serde_json::from_slice(&bytes)
        .map_err(|err| format!("The remote log could not be read: {}", err))
}

/// Saves the log if it changed. Called on the autosave interval and on close, not after every command.
pub(crate) async fn save(app: &AppHandle, log: &Mutex<AuditLog>) -> Result<(), String> {
    let json = log.lock().map_err(|err| err.to_string())?.take_changes();
    match json {
        Some(json) => save_json_to_local_storage("Remote log", app, json, FILE)
            .await
            .map(|_| ()),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(n: u64) -> Entry {
        Entry {
            at: n,
            device_id: "d1".into(),
            device_name: "Pixel".into(),
            cmd: "get_runs".into(),
            ok: true,
            error: None,
        }
    }

    #[test]
    fn keeps_the_last_1000_the_latest_first() {
        let mut log = AuditLog::default();
        for n in 0..(KEEP as u64 + 5) {
            log.record(entry(n));
        }
        let latest = log.latest();
        assert_eq!(latest.len(), KEEP);
        assert_eq!(latest[0].at, KEEP as u64 + 4);
        assert_eq!(latest[KEEP - 1].at, 5);
    }

    #[test]
    fn long_errors_are_cut() {
        let mut log = AuditLog::default();
        log.record(Entry {
            ok: false,
            error: Some("x".repeat(1000)),
            ..entry(1)
        });
        assert_eq!(
            log.latest()[0].error.as_ref().unwrap().chars().count(),
            ERROR_CHARS + 1
        );
    }

    #[test]
    fn saves_only_what_changed() {
        let mut log = AuditLog::default();
        assert!(log.take_changes().is_none());
        log.record(entry(1));
        let json = log.take_changes().unwrap();
        assert!(log.take_changes().is_none());
        let read: AuditLog = serde_json::from_str(&json).unwrap();
        assert_eq!(read.latest(), vec![entry(1)]);
    }
}
