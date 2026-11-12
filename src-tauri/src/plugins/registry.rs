//! Installed plugins, in the app-local data folder:
//!
//! ```text
//! plugins/plugins.json               which plugins are installed and enabled
//! plugins/<id>/<version>/plugin.json the manifest
//! plugins/<id>/<version>/plugin.wasm the plugin
//! ```
//!
//! Plugins are installed per user and never from a project, so opening a repo cannot install one.
use super::manifest::PluginManifest;
use super::runtime;
use crate::prelude::*;

const REGISTRY_FILE: &str = "plugins.json";
const MANIFEST_FILE: &str = "plugin.json";
const WASM_FILE: &str = "plugin.wasm";
/// The largest plugin Task Proxy installs.
const WASM_MAX_BYTES: usize = 20 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstalledPlugin {
    pub id: String,
    pub version: String,
    pub enabled: bool,
    /// Installed from the catalog with a valid signature, rather than from a folder.
    pub signed: bool,
}

pub(crate) struct Registry {
    pub dir: PathBuf,
}

impl Registry {
    pub fn new(dir: PathBuf) -> Self {
        Registry { dir }
    }

    pub fn list(&self) -> Vec<InstalledPlugin> {
        fs::read_to_string(self.dir.join(REGISTRY_FILE))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn save(&self, list: &[InstalledPlugin]) -> Result<(), String> {
        let json = serde_json::to_string_pretty(list).map_err(|err| err.to_string())?;
        write_atomic(&self.dir.join(REGISTRY_FILE), json.as_bytes())
            .map_err(|err| format!("Could not save the plugin list: {}", err))
    }

    fn version_dir(&self, id: &str, version: &str) -> PathBuf {
        self.dir.join(id).join(version)
    }

    /// Installs a plugin, replacing any other version of it. The plugin must load before it is installed.
    pub fn install(
        &self,
        manifest_json: &str,
        wasm: &[u8],
        signed: bool,
    ) -> Result<PluginManifest, String> {
        let manifest = PluginManifest::parse(manifest_json)?;
        if wasm.len() > WASM_MAX_BYTES {
            return Err(String::from("The plugin is larger than 20 MB."));
        }
        runtime::compile(wasm)?;
        let target = self.version_dir(&manifest.id, &manifest.version);
        write_atomic(&target.join(WASM_FILE), wasm).map_err(|err| err.to_string())?;
        write_atomic(&target.join(MANIFEST_FILE), manifest_json.as_bytes())
            .map_err(|err| err.to_string())?;
        let mut list = self.list();
        let enabled = list
            .iter()
            .find(|installed| installed.id == manifest.id)
            .is_none_or(|installed| installed.enabled);
        list.retain(|installed| installed.id != manifest.id);
        list.push(InstalledPlugin {
            id: manifest.id.clone(),
            version: manifest.version.clone(),
            enabled,
            signed,
        });
        list.sort_by(|a, b| a.id.cmp(&b.id));
        self.save(&list)?;
        self.remove_other_versions(&manifest.id, &manifest.version);
        Ok(manifest)
    }

    /// Installs a plugin from a folder holding plugin.json and plugin.wasm, as a plugin's build writes them.
    pub fn install_folder(&self, folder: &Path) -> Result<PluginManifest, String> {
        let manifest = fs::read_to_string(folder.join(MANIFEST_FILE))
            .map_err(|_| format!("{} has no {}.", folder.display(), MANIFEST_FILE))?;
        let wasm = fs::read(folder.join(WASM_FILE))
            .map_err(|_| format!("{} has no {}.", folder.display(), WASM_FILE))?;
        self.install(&manifest, &wasm, false)
    }

    fn remove_other_versions(&self, id: &str, keep: &str) {
        if let Ok(entries) = fs::read_dir(self.dir.join(id)) {
            for entry in entries.flatten() {
                if entry.file_name() != keep {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let mut list = self.list();
        list.retain(|installed| installed.id != id);
        self.save(&list)?;
        if super::manifest::is_slug(id) {
            let _ = fs::remove_dir_all(self.dir.join(id));
        }
        Ok(())
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        let mut list = self.list();
        let installed = list
            .iter_mut()
            .find(|installed| installed.id == id)
            .ok_or_else(|| format!("The plugin {} is not installed.", id))?;
        installed.enabled = enabled;
        self.save(&list)
    }

    pub fn manifest(&self, installed: &InstalledPlugin) -> Result<PluginManifest, String> {
        let text = fs::read_to_string(
            self.version_dir(&installed.id, &installed.version)
                .join(MANIFEST_FILE),
        )
        .map_err(|err| {
            format!(
                "The plugin {} is missing its manifest: {}",
                installed.id, err
            )
        })?;
        PluginManifest::parse(&text)
    }

    pub fn wasm(&self, installed: &InstalledPlugin) -> Result<Vec<u8>, String> {
        fs::read(
            self.version_dir(&installed.id, &installed.version)
                .join(WASM_FILE),
        )
        .map_err(|err| format!("The plugin {} is missing its code: {}", installed.id, err))
    }

    /// An enabled plugin, by id.
    pub fn enabled(&self, id: &str) -> Result<InstalledPlugin, String> {
        let installed = self
            .list()
            .into_iter()
            .find(|installed| installed.id == id)
            .ok_or_else(|| format!("The plugin {} is not installed.", id))?;
        if !installed.enabled {
            return Err(format!("The plugin {} is turned off.", id));
        }
        Ok(installed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::runtime::tests::{TEST_MANIFEST, TEST_WASM};

    fn with_version(version: &str) -> String {
        TEST_MANIFEST.replace("\"0.1.0\"", &format!("\"{}\"", version))
    }

    #[test]
    fn installing_replaces_the_old_version_and_keeps_it_turned_off() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::new(dir.path().to_path_buf());
        assert!(registry.list().is_empty());
        registry
            .install(&with_version("0.1.0"), TEST_WASM, false)
            .unwrap();
        registry.set_enabled("test", false).unwrap();
        registry
            .install(&with_version("0.2.0"), TEST_WASM, true)
            .unwrap();
        assert_eq!(
            registry.list(),
            vec![InstalledPlugin {
                id: "test".into(),
                version: "0.2.0".into(),
                enabled: false,
                signed: true
            }]
        );
        assert!(!dir.path().join("test/0.1.0").exists());
        assert_eq!(registry.wasm(&registry.list()[0]).unwrap(), TEST_WASM);
        assert!(registry.enabled("test").unwrap_err().contains("turned off"));
        registry.set_enabled("test", true).unwrap();
        assert_eq!(
            registry
                .manifest(&registry.enabled("test").unwrap())
                .unwrap()
                .version,
            "0.2.0"
        );
    }

    #[test]
    fn a_plugin_that_does_not_load_or_has_a_bad_manifest_is_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::new(dir.path().to_path_buf());
        assert!(registry.install(TEST_MANIFEST, b"not wasm", false).is_err());
        assert!(registry.install("{}", TEST_WASM, false).is_err());
        assert!(registry.list().is_empty());
        assert!(!dir.path().join("test").exists());
    }

    #[test]
    fn folders_install_and_removing_deletes_the_files() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("build");
        fs::create_dir_all(&source).unwrap();
        let registry = Registry::new(dir.path().join("plugins"));
        assert!(
            registry
                .install_folder(&source)
                .unwrap_err()
                .contains("plugin.json")
        );
        fs::write(source.join("plugin.json"), TEST_MANIFEST).unwrap();
        fs::write(source.join("plugin.wasm"), TEST_WASM).unwrap();
        assert_eq!(registry.install_folder(&source).unwrap().id, "test");
        assert!(!registry.list()[0].signed);
        registry.remove("test").unwrap();
        assert!(registry.list().is_empty());
        assert!(!dir.path().join("plugins/test").exists());
    }
}
