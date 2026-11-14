//! `plugin.json`: what a plugin is, and everything it may reach. Task Proxy refuses any host call the manifest
//! does not declare, and shows these permissions before a plugin is installed.
use crate::prelude::*;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    /// The plugin spec versions it supports, one for each line, each the lowest patch of that line it needs, as
    /// `["0.1.0"]`. See `spec.rs`.
    #[serde(default)]
    pub spec: Vec<String>,
    /// Only for Task Proxy 0.1.121 and earlier, which read no `spec` and run only `apiVersion: 1`, which is spec
    /// 0.1.0. A manifest with no `spec` is read as that.
    #[serde(default)]
    pub api_version: u32,
    #[serde(default)]
    pub description: String,
    /// The category's slug, such as `issue-tracking`.
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub permissions: Permissions,
    #[serde(default)]
    pub pages: Vec<PluginPage>,
    /// Extra places the plugin shows up, such as `gitBranchInfo` for a card in the Git Controller.
    #[serde(default)]
    pub contributes: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Permissions {
    /// Hosts the plugin may send HTTPS requests to: `api.example.com`, or `*.example.com` for its subdomains.
    #[serde(default)]
    pub hosts: Vec<String>,
    /// Variables the plugin may read.
    #[serde(default)]
    pub variables: Vec<PluginVariable>,
    /// What the plugin may do with git: `currentBranch` and `createBranch`.
    #[serde(default)]
    pub git: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginVariable {
    pub key: String,
    #[serde(default)]
    pub label: String,
    /// Shown masked, and only ever sent to the plugin itself.
    #[serde(default)]
    pub secret: bool,
    #[serde(default)]
    pub help: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginPage {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub icon: String,
    /// Left out of the nav, for pages that are only opened from another page, such as one issue.
    #[serde(default)]
    pub hidden: bool,
}

pub(crate) const GIT_PERMISSIONS: [&str; 2] = ["currentBranch", "createBranch"];

/// Lowercase letters, digits, and dashes, starting with a letter, as used in folder names and routes.
pub(crate) fn is_slug(text: &str) -> bool {
    text.len() <= 64
        && text.starts_with(|c: char| c.is_ascii_lowercase())
        && text
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn is_host_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 63
        && !label.starts_with('-')
        && !label.ends_with('-')
        && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// A host pattern needs a domain with at least two parts, so `*` and `*.com` are refused.
fn is_host_pattern(pattern: &str) -> bool {
    let domain = pattern.strip_prefix("*.").unwrap_or(pattern);
    let labels: Vec<&str> = domain.split('.').collect();
    labels.len() >= 2 && labels.iter().all(|label| is_host_label(label))
}

impl PluginManifest {
    pub fn parse(json: &str) -> Result<Self, String> {
        let manifest: PluginManifest = serde_json::from_str(json)
            .map_err(|err| format!("plugin.json is not valid: {}", err))?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn validate(&self) -> Result<(), String> {
        if !is_slug(&self.id) {
            return Err(format!(
                "The plugin id '{}' must be lowercase letters, digits, and dashes.",
                self.id
            ));
        }
        if self.name.trim().is_empty() {
            return Err(String::from("The plugin needs a name."));
        }
        let version_parts: Vec<&str> = self.version.split('.').collect();
        if version_parts.len() != 3
            || version_parts
                .iter()
                .any(|part| part.parse::<u32>().is_err())
        {
            return Err(format!(
                "The version '{}' must look like 1.2.3.",
                self.version
            ));
        }
        self.spec_version()?;
        if !self.category.is_empty() && !is_slug(&self.category) {
            return Err(format!("The category '{}' is not valid.", self.category));
        }
        if let Some(host) = self
            .permissions
            .hosts
            .iter()
            .find(|host| !is_host_pattern(host))
        {
            return Err(format!(
                "The host '{}' is not allowed. Name a domain, or its subdomains as *.example.com.",
                host
            ));
        }
        if let Some(variable) = self.permissions.variables.iter().find(|variable| {
            variable.key.is_empty()
                || !variable
                    .key
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                || variable.key.starts_with("app-")
                || variable.key.starts_with("session-")
        }) {
            return Err(format!(
                "The variable '{}' cannot be used by a plugin.",
                variable.key
            ));
        }
        if let Some(git) = self
            .permissions
            .git
            .iter()
            .find(|git| !GIT_PERMISSIONS.contains(&git.as_str()))
        {
            return Err(format!("The git permission '{}' is not known.", git));
        }
        if let Some(page) = self.pages.iter().find(|page| !is_slug(&page.id)) {
            return Err(format!("The page id '{}' is not valid.", page.id));
        }
        Ok(())
    }

    /// The spec version this app runs the plugin with, or why it cannot run it.
    pub fn spec_version(&self) -> Result<super::spec::SpecVersion, String> {
        super::spec::check(&self.name, &self.spec, self.api_version)
    }

    pub fn allows_host(&self, host: &str) -> bool {
        let host = host.to_ascii_lowercase();
        self.permissions.hosts.iter().any(|pattern| {
            let pattern = pattern.to_ascii_lowercase();
            match pattern.strip_prefix("*.") {
                Some(domain) => host
                    .strip_suffix(domain)
                    .is_some_and(|sub| sub.ends_with('.') && sub.len() > 1),
                None => host == pattern,
            }
        })
    }

    pub fn declares_variable(&self, key: &str) -> bool {
        self.permissions
            .variables
            .iter()
            .any(|variable| variable.key == key)
    }

    pub fn allows_git(&self, permission: &str) -> bool {
        self.permissions.git.iter().any(|git| git == permission)
    }

    pub fn contributes(&self, point: &str) -> bool {
        self.contributes
            .iter()
            .any(|contribution| contribution == point)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest(changes: Value) -> Result<PluginManifest, String> {
        let mut base = json!({
            "id": "jira", "name": "Jira", "version": "0.1.0", "apiVersion": 1,
            "permissions": { "hosts": ["*.atlassian.net"], "variables": [{ "key": "jira_api_token", "secret": true }] },
            "pages": [{ "id": "issues", "name": "My Issues" }]
        });
        for (key, value) in changes.as_object().unwrap() {
            base[key] = value.clone();
        }
        PluginManifest::parse(&base.to_string())
    }

    #[test]
    fn a_valid_manifest_is_read() {
        let read = manifest(json!({})).unwrap();
        assert_eq!(read.id, "jira");
        assert!(read.declares_variable("jira_api_token"));
        assert!(!read.declares_variable("git_pat"));
        assert!(!read.allows_git("createBranch"));
    }

    #[test]
    fn bad_ids_versions_and_api_versions_are_refused() {
        for changes in [
            json!({ "id": "Jira" }),
            json!({ "id": "../jira" }),
            json!({ "id": "" }),
            json!({ "version": "1.0" }),
            json!({ "version": "1.0.x" }),
            json!({ "name": " " }),
            json!({ "pages": [{ "id": "a/b", "name": "x" }] }),
        ] {
            assert!(manifest(changes.clone()).is_err(), "{}", changes);
        }
        // Old manifests name only apiVersion 1. Others need a spec this app supports.
        assert!(manifest(json!({ "apiVersion": 2 })).is_err());
        assert!(manifest(json!({ "apiVersion": 0 })).is_err());
        assert!(manifest(json!({ "spec": ["0.1.0"], "apiVersion": 0 })).is_ok());
        let newer = manifest(json!({ "spec": ["0.9.0"] })).unwrap_err();
        assert!(newer.contains("Update Task Proxy"), "{}", newer);
        assert!(manifest(json!({ "spec": ["0.1"] })).is_err());
    }

    #[test]
    fn hosts_must_name_a_domain() {
        for hosts in [
            json!(["*"]),
            json!(["*.com"]),
            json!(["com"]),
            json!(["https://a.com"]),
            json!(["a..com"]),
        ] {
            assert!(
                manifest(json!({ "permissions": { "hosts": hosts } })).is_err(),
                "{}",
                hosts
            );
        }
    }

    #[test]
    fn app_state_and_unknown_permissions_are_refused() {
        for permissions in [
            json!({ "variables": [{ "key": "app-current-project" }] }),
            json!({ "variables": [{ "key": "session-x" }] }),
            json!({ "variables": [{ "key": "a b" }] }),
            json!({ "git": ["push"] }),
        ] {
            assert!(
                manifest(json!({ "permissions": permissions })).is_err(),
                "{}",
                permissions
            );
        }
    }

    #[test]
    fn wildcards_match_subdomains_only() {
        let read =
            manifest(json!({ "permissions": { "hosts": ["*.atlassian.net", "api.example.com"] } }))
                .unwrap();
        assert!(read.allows_host("team.atlassian.net"));
        assert!(read.allows_host("Team.Atlassian.NET"));
        assert!(read.allows_host("a.b.atlassian.net"));
        assert!(!read.allows_host("atlassian.net"));
        assert!(!read.allows_host("evilatlassian.net"));
        assert!(!read.allows_host("atlassian.net.evil.com"));
        assert!(read.allows_host("api.example.com"));
        assert!(!read.allows_host("www.api.example.com"));
    }
}
