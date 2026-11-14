//! The plugin catalog Stoic Dreams publishes beside the app's updates, and checking the signatures of what it lists.
//!
//! Each plugin's `plugin.json` and `plugin.wasm` are signed with the same key as app updates (`cargo tauri signer
//! sign`), and the app checks both against the updater's public key before installing, so a changed file on the
//! CDN cannot be installed.
use super::manifest::{Permissions, PluginManifest};
use crate::prelude::*;
use minisign_verify::{PublicKey, Signature};
use std::sync::LazyLock;

pub(crate) const CATALOG_URL: &str = "https://cdn.myfi.ws/apps/task-proxy/plugins/catalog.json";
/// Catalog files may only come from here.
const CATALOG_ROOT: &str = "https://cdn.myfi.ws/apps/task-proxy/plugins/";
const DOWNLOAD_MAX_BYTES: usize = 20 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    /// The plugin spec versions this version supports. Entries from before spec versions only have `apiVersion`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub spec: Vec<String>,
    /// Kept for Task Proxy 0.1.121 and earlier, which require it.
    #[serde(default)]
    pub api_version: u32,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub icon: String,
    /// What the plugin may reach, shown before installing. The signed plugin.json must ask for exactly this.
    pub permissions: Permissions,
    /// Where plugin.json is, and its signature as `cargo tauri signer sign` writes it.
    pub manifest: String,
    pub manifest_signature: String,
    pub wasm: String,
    pub wasm_signature: String,
    /// Older versions that support spec lines this one dropped, so an app that is not updated can still install
    /// the newest version it can run.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub versions: Vec<CatalogEntry>,
    /// Set by Task Proxy, not the catalog: why no listed version runs in this app.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub incompatible: Option<String>,
}

fn version_key(version: &str) -> Vec<u32> {
    version
        .split('.')
        .map(|part| part.parse().unwrap_or(0))
        .collect()
}

impl CatalogEntry {
    /// The newest listed version this app can run, or the newest listed with why it cannot.
    pub fn for_this_app(self) -> CatalogEntry {
        let mut candidates: Vec<CatalogEntry> = Vec::with_capacity(self.versions.len() + 1);
        let mut newest = self;
        candidates.append(&mut newest.versions);
        candidates.push(newest);
        candidates.sort_by_key(|entry| std::cmp::Reverse(version_key(&entry.version)));
        let mut refusal = None;
        for candidate in &candidates {
            match super::spec::check(&candidate.name, &candidate.spec, candidate.api_version) {
                Ok(_) => {
                    let mut chosen = candidate.clone();
                    chosen.versions.clear();
                    chosen.incompatible = None;
                    return chosen;
                }
                Err(err) if refusal.is_none() => refusal = Some(err),
                Err(_) => {}
            }
        }
        let mut chosen = candidates.swap_remove(0);
        chosen.versions.clear();
        chosen.incompatible = refusal;
        chosen
    }
}

/// Reads the catalog, skipping entries this app cannot read, so a new kind of entry never hides the others.
pub(crate) fn read_catalog(body: &[u8]) -> Result<Vec<CatalogEntry>, String> {
    let entries: Vec<Value> = serde_json::from_slice(body)
        .map_err(|err| format!("The plugin catalog could not be read: {}", err))?;
    Ok(entries
        .into_iter()
        .filter_map(|entry| serde_json::from_value::<CatalogEntry>(entry).ok())
        .map(CatalogEntry::for_this_app)
        .collect())
}

fn decode_base64(text: &str) -> Result<String, String> {
    let bytes = general_purpose::STANDARD
        .decode(text.trim())
        .map_err(|_| String::from("The signature is not valid base64."))?;
    String::from_utf8(bytes).map_err(|_| String::from("The signature is not text."))
}

/// Checks a file against a signature, both as base64 the way Tauri's signer writes them.
pub(crate) fn verify(data: &[u8], signature: &str, public_key: &str) -> Result<(), String> {
    let key = PublicKey::decode(&decode_base64(public_key)?)
        .map_err(|err| format!("The signing key could not be read: {}", err))?;
    let signature = Signature::decode(&decode_base64(signature)?)
        .map_err(|err| format!("The signature could not be read: {}", err))?;
    key.verify(data, &signature, false)
        .map_err(|_| String::from("The signature does not match, so the plugin was not installed."))
}

/// The key app updates are signed with, from tauri.conf.json.
pub(crate) fn app_public_key(app: &AppHandle) -> Result<String, String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| String::from("This build of Task Proxy has no signing key, so it cannot install plugins from the catalog."))
}

/// Checks a downloaded plugin against its catalog entry and signatures. Returns the manifest's text.
pub(crate) fn verify_package(
    entry: &CatalogEntry,
    manifest: &[u8],
    wasm: &[u8],
    public_key: &str,
) -> Result<String, String> {
    verify(manifest, &entry.manifest_signature, public_key)?;
    verify(wasm, &entry.wasm_signature, public_key)?;
    let text = String::from_utf8(manifest.to_vec())
        .map_err(|_| String::from("plugin.json is not text."))?;
    let parsed = PluginManifest::parse(&text)?;
    if parsed.permissions != entry.permissions {
        return Err(format!(
            "{} asks for other permissions than the catalog shows, so it was not installed.",
            parsed.name
        ));
    }
    if parsed.id != entry.id || parsed.version != entry.version {
        return Err(format!(
            "The catalog lists {} {}, but the download is {} {}.",
            entry.id, entry.version, parsed.id, parsed.version
        ));
    }
    Ok(text)
}

static CLIENT: LazyLock<Option<reqwest::Client>> = LazyLock::new(|| {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .user_agent("TaskProxy")
        .timeout(Duration::from_secs(60))
        .https_only(true)
        .build()
        .ok()
});

async fn download(url: &str) -> Result<Vec<u8>, String> {
    if !url.starts_with(CATALOG_ROOT) {
        return Err(format!(
            "The catalog points outside the plugin catalog: {}",
            url
        ));
    }
    let client = CLIENT
        .as_ref()
        .ok_or_else(|| String::from("HTTP is not available."))?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|err| format!("Could not reach the plugin catalog: {}", err))?;
    if !response.status().is_success() {
        return Err(format!(
            "The plugin catalog answered {} for {}.",
            response.status(),
            url
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|err| err.to_string())? {
        if body.len() + chunk.len() > DOWNLOAD_MAX_BYTES {
            return Err(String::from("The download is larger than 20 MB."));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

pub(crate) async fn fetch_catalog() -> Result<Vec<CatalogEntry>, String> {
    let body = download(CATALOG_URL).await?;
    read_catalog(&body)
}

/// Downloads a plugin from the catalog and checks it. Returns its manifest text and code.
pub(crate) async fn download_package(
    entry: &CatalogEntry,
    public_key: &str,
) -> Result<(String, Vec<u8>), String> {
    let manifest = download(&entry.manifest).await?;
    let wasm = download(&entry.wasm).await?;
    let text = verify_package(entry, &manifest, &wasm, public_key)?;
    Ok((text, wasm))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::runtime::tests::{TEST_MANIFEST, TEST_WASM};
    use serde_json::json;

    /// A key made only for these tests. Its private half is not kept anywhere.
    const TEST_KEY: &str = include_str!("../../tests/fixtures/plugins/test-signing.key.pub");
    const WASM_SIGNATURE: &str = include_str!("../../tests/fixtures/plugins/test/plugin.wasm.sig");
    const MANIFEST_SIGNATURE: &str =
        include_str!("../../tests/fixtures/plugins/test/plugin.json.sig");

    fn entry() -> CatalogEntry {
        CatalogEntry {
            id: "test".into(),
            name: "Test Plugin".into(),
            version: "0.1.0".into(),
            spec: Vec::new(),
            api_version: 1,
            description: String::new(),
            category: "testing".into(),
            icon: String::new(),
            permissions: PluginManifest::parse(TEST_MANIFEST).unwrap().permissions,
            manifest: format!("{}test/0.1.0/plugin.json", CATALOG_ROOT),
            manifest_signature: MANIFEST_SIGNATURE.into(),
            wasm: format!("{}test/0.1.0/plugin.wasm", CATALOG_ROOT),
            wasm_signature: WASM_SIGNATURE.into(),
            versions: Vec::new(),
            incompatible: None,
        }
    }

    fn listed(version: &str, spec: &[&str]) -> CatalogEntry {
        CatalogEntry {
            version: version.into(),
            spec: spec.iter().map(|spec| spec.to_string()).collect(),
            api_version: 0,
            ..entry()
        }
    }

    #[test]
    fn the_newest_version_this_app_runs_is_offered() {
        let mut newest = listed("0.3.0", &["9.0.0"]);
        newest.versions = vec![listed("0.1.4", &["0.1.0"]), listed("0.2.0", &["0.0.1"])];
        let chosen = newest.for_this_app();
        assert_eq!(chosen.version, "0.1.4");
        assert!(chosen.incompatible.is_none());
        assert!(chosen.versions.is_empty());
        // When none run, the newest is shown with why.
        let mut none = listed("0.3.0", &["9.0.0"]);
        none.versions = vec![listed("0.2.0", &["0.0.1"])];
        let shown = none.for_this_app();
        assert_eq!(shown.version, "0.3.0");
        assert!(shown.incompatible.unwrap().contains("Update Task Proxy"));
        // Old entries name only apiVersion 1.
        assert!(entry().for_this_app().incompatible.is_none());
    }

    #[test]
    fn unreadable_entries_are_skipped() {
        let good = serde_json::to_value(entry()).unwrap();
        let body = serde_json::to_vec(&json!([{ "id": "future", "shape": "new" }, good])).unwrap();
        let read = read_catalog(&body).unwrap();
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].id, "test");
        assert!(read_catalog(b"{").is_err());
    }

    #[test]
    fn a_signed_plugin_passes() {
        let text = verify_package(&entry(), TEST_MANIFEST.as_bytes(), TEST_WASM, TEST_KEY).unwrap();
        assert_eq!(text, TEST_MANIFEST);
    }

    #[test]
    fn changed_files_and_swapped_signatures_fail() {
        let mut changed = TEST_WASM.to_vec();
        changed[100] ^= 1;
        let err =
            verify_package(&entry(), TEST_MANIFEST.as_bytes(), &changed, TEST_KEY).unwrap_err();
        assert!(err.contains("does not match"), "{}", err);
        let more_permissions = TEST_MANIFEST.replace("*.example.com", "*.evil.com");
        assert!(
            verify_package(&entry(), more_permissions.as_bytes(), TEST_WASM, TEST_KEY).is_err()
        );
        let mut swapped = entry();
        swapped.wasm_signature = MANIFEST_SIGNATURE.into();
        assert!(verify_package(&swapped, TEST_MANIFEST.as_bytes(), TEST_WASM, TEST_KEY).is_err());
    }

    #[test]
    fn another_key_fails() {
        let app_key = include_str!("../../tauri.conf.json");
        let app_key: Value = serde_json::from_str(app_key).unwrap();
        let app_key = app_key["plugins"]["updater"]["pubkey"].as_str().unwrap();
        assert!(verify_package(&entry(), TEST_MANIFEST.as_bytes(), TEST_WASM, app_key).is_err());
    }

    #[test]
    fn the_permissions_shown_must_be_the_signed_ones() {
        let mut fewer = entry();
        fewer.permissions.hosts.clear();
        let err =
            verify_package(&fewer, TEST_MANIFEST.as_bytes(), TEST_WASM, TEST_KEY).unwrap_err();
        assert!(err.contains("other permissions"), "{}", err);
    }

    #[test]
    fn the_download_must_be_the_listed_version() {
        let mut newer = entry();
        newer.version = "0.2.0".into();
        let err =
            verify_package(&newer, TEST_MANIFEST.as_bytes(), TEST_WASM, TEST_KEY).unwrap_err();
        assert!(err.contains("lists test 0.2.0"), "{}", err);
    }

    #[tokio::test]
    async fn downloads_only_come_from_the_catalog() {
        let err = download("https://example.com/plugin.wasm")
            .await
            .unwrap_err();
        assert!(err.contains("outside the plugin catalog"), "{}", err);
    }
}
