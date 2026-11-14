//! The plugin spec versions this app supports, and whether a plugin's match. The spec itself, with its versioning
//! rules, is in TaskProxyPlugins' `spec/` folder.
//!
//! A spec version is `major.minor.patch`. A new patch only adds, so it never breaks a plugin. A breaking change
//! starts a new minor version with patch 0, and each `major.minor` is its own line. The app lists the newest patch
//! of each line it supports, and a plugin lists, for each line it supports, the lowest patch it needs. They match
//! on a line both list when the app's patch is at least the plugin's.

/// The newest patch of each spec line this version of Task Proxy supports. Add a line, or raise a patch, only
/// after the app does everything that version of the spec describes, and record it in Docs/Plugins.md.
pub(crate) const SPEC_VERSIONS: [&str; 1] = ["0.1.2"];

/// A manifest without `spec`, written before spec versions existed, declares `apiVersion: 1`, which is spec 0.1.0.
pub(crate) const LEGACY_API_VERSION: u32 = 1;
const LEGACY_SPEC: SpecVersion = SpecVersion {
    major: 0,
    minor: 1,
    patch: 0,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct SpecVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl std::fmt::Display for SpecVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

impl SpecVersion {
    pub fn parse(text: &str) -> Result<Self, String> {
        let parts: Vec<u32> = text
            .trim()
            .split('.')
            .map(|part| part.parse::<u32>())
            .collect::<Result<_, _>>()
            .map_err(|_| format!("The spec version '{}' must look like 0.1.0.", text))?;
        match parts.as_slice() {
            [major, minor, patch] => Ok(SpecVersion {
                major: *major,
                minor: *minor,
                patch: *patch,
            }),
            _ => Err(format!("The spec version '{}' must look like 0.1.0.", text)),
        }
    }

    fn line(&self) -> (u32, u32) {
        (self.major, self.minor)
    }
}

/// The spec versions this app supports.
pub(crate) fn supported() -> Vec<SpecVersion> {
    SPEC_VERSIONS
        .iter()
        .filter_map(|version| SpecVersion::parse(version).ok())
        .collect()
}

/// What a manifest or catalog entry declares: its `spec` list, or spec 0.1.0 for the old `apiVersion: 1`.
pub(crate) fn declared(spec: &[String], api_version: u32) -> Result<Vec<SpecVersion>, String> {
    if !spec.is_empty() {
        return spec
            .iter()
            .map(|version| SpecVersion::parse(version))
            .collect();
    }
    if api_version == LEGACY_API_VERSION {
        return Ok(vec![LEGACY_SPEC]);
    }
    Err(String::from(
        "The plugin does not say which plugin spec versions it supports.",
    ))
}

/// The newest spec version both sides can use, as the app speaks it, or none.
pub(crate) fn negotiate(app: &[SpecVersion], plugin: &[SpecVersion]) -> Option<SpecVersion> {
    app.iter()
        .filter(|ours| {
            plugin
                .iter()
                .any(|theirs| theirs.line() == ours.line() && ours.patch >= theirs.patch)
        })
        .max()
        .copied()
}

fn list(versions: &[SpecVersion]) -> String {
    versions
        .iter()
        .map(|version| version.to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

/// The spec version this app runs a plugin with, or why it cannot.
pub(crate) fn check(name: &str, spec: &[String], api_version: u32) -> Result<SpecVersion, String> {
    let plugin = declared(spec, api_version).map_err(|err| format!("{} {}", name, err))?;
    let app = supported();
    if let Some(version) = negotiate(&app, &plugin) {
        return Ok(version);
    }
    // The plugin is ahead when it needs a newer patch of a line the app has, or only a newer line.
    let app_newest = app.iter().max().copied();
    let ahead = plugin.iter().any(|theirs| {
        app.iter()
            .any(|ours| ours.line() == theirs.line() && ours.patch < theirs.patch)
            || app_newest.is_some_and(|newest| theirs.line() > newest.line())
    });
    Err(format!(
        "{} supports plugin spec {}, and this version of Task Proxy supports {}. {}",
        name,
        list(&plugin),
        list(&app),
        if ahead {
            "Update Task Proxy to use it."
        } else {
            "Install a newer version of the plugin."
        }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(text: &str) -> SpecVersion {
        SpecVersion::parse(text).unwrap()
    }

    fn versions(list: &[&str]) -> Vec<SpecVersion> {
        list.iter().map(|text| v(text)).collect()
    }

    #[test]
    fn versions_read_as_three_numbers() {
        assert_eq!(
            v("0.1.2"),
            SpecVersion {
                major: 0,
                minor: 1,
                patch: 2
            }
        );
        assert_eq!(v("0.12.0").to_string(), "0.12.0");
        for bad in ["0.1", "0.1.x", "", "1.2.3.4", "v0.1.0"] {
            assert!(SpecVersion::parse(bad).is_err(), "{}", bad);
        }
        assert!(
            SPEC_VERSIONS
                .iter()
                .all(|version| SpecVersion::parse(version).is_ok())
        );
    }

    #[test]
    fn a_plugin_matches_when_the_app_has_its_patch_or_newer() {
        let app = versions(&["0.1.3"]);
        assert_eq!(negotiate(&app, &versions(&["0.1.0"])), Some(v("0.1.3")));
        assert_eq!(negotiate(&app, &versions(&["0.1.3"])), Some(v("0.1.3")));
        assert_eq!(negotiate(&app, &versions(&["0.1.4"])), None);
        // Lines never mix: a breaking change starts a new minor version.
        assert_eq!(negotiate(&app, &versions(&["0.2.0"])), None);
        assert_eq!(
            negotiate(&versions(&["0.2.0"]), &versions(&["0.1.0"])),
            None
        );
        // With two lines in common, the newest wins.
        assert_eq!(
            negotiate(
                &versions(&["0.1.5", "0.2.1"]),
                &versions(&["0.1.0", "0.2.0"])
            ),
            Some(v("0.2.1"))
        );
        assert_eq!(
            negotiate(
                &versions(&["0.1.5", "0.2.1"]),
                &versions(&["0.1.0", "0.2.2"])
            ),
            Some(v("0.1.5"))
        );
    }

    #[test]
    fn old_manifests_are_spec_0_1_0() {
        assert_eq!(declared(&[], 1).unwrap(), versions(&["0.1.0"]));
        assert!(declared(&[], 0).is_err());
        assert!(declared(&[], 2).is_err());
        // A declared spec wins over apiVersion, which is only kept for older apps.
        assert_eq!(
            declared(&["0.1.1".to_string()], 1).unwrap(),
            versions(&["0.1.1"])
        );
        assert_eq!(check("Jira", &[], 1).unwrap(), supported()[0]);
    }

    #[test]
    fn refusals_say_which_side_to_update() {
        let ahead = check("Jira", &["9.0.0".to_string()], 0).unwrap_err();
        assert!(ahead.contains("Update Task Proxy"), "{}", ahead);
        assert!(ahead.contains("supports plugin spec 9.0.0"), "{}", ahead);
        let newer_patch = check("Jira", &["0.1.99".to_string()], 0).unwrap_err();
        assert!(newer_patch.contains("Update Task Proxy"), "{}", newer_patch);
        let behind = check("Jira", &["0.0.4".to_string()], 0).unwrap_err();
        assert!(behind.contains("newer version of the plugin"), "{}", behind);
        let none = check("Jira", &[], 0).unwrap_err();
        assert!(none.contains("does not say which"), "{}", none);
        assert!(check("Jira", &["0.1".to_string()], 1).is_err());
    }
}
