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
    serde_json::from_slice(&body)
        .map_err(|err| format!("The plugin catalog could not be read: {}", err))
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
            api_version: 1,
            description: String::new(),
            category: "testing".into(),
            icon: String::new(),
            permissions: PluginManifest::parse(TEST_MANIFEST).unwrap().permissions,
            manifest: format!("{}test/0.1.0/plugin.json", CATALOG_ROOT),
            manifest_signature: MANIFEST_SIGNATURE.into(),
            wasm: format!("{}test/0.1.0/plugin.wasm", CATALOG_ROOT),
            wasm_signature: WASM_SIGNATURE.into(),
        }
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
        let err = verify_package(&fewer, TEST_MANIFEST.as_bytes(), TEST_WASM, TEST_KEY).unwrap_err();
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
