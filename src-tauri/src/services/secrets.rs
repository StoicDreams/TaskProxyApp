//! Secret values stay on the desktop. What a remote device is sent has each secret replaced by a marker,
//! `{"$secret": true}`, which says a value is set without showing it.
//!
//! Secret values are:
//! - every global variable, as the Variables panel treats them, and the git tokens wherever they are set
//! - project variables defined as `key|secret|...`, in the project's values and in each of its environments
//! - plugin settings marked secret, which `plugin_settings` already never sends
//!
//! A device can set a secret, but never read it back. A patch that carries the marker, as a device sending back
//! what it was shown does, keeps the real value (`restore_markers`).

use crate::prelude::*;
use std::collections::HashSet;

/// The key of the marker that stands in for a secret value.
pub(crate) const MARKER_KEY: &str = "$secret";
/// Variables that hold git tokens.
pub(crate) const TOKEN_KEYS: [&str; 2] = ["git_pat", "github_pat"];
/// Where the Variables panel keeps each environment's project values.
const ENVIRONMENTS_KEY: &str = "_environments";

/// The marker sent in place of a secret value.
pub(crate) fn marker() -> Value {
    serde_json::json!({ MARKER_KEY: true })
}

/// Whether a value is the marker, as a device sends back a secret it was never shown.
pub(crate) fn is_marker(value: &Value) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == 1 && object.get(MARKER_KEY) == Some(&Value::Bool(true))
    })
}

/// App state, rather than a variable: what the app keeps for itself in app data.
fn is_app_key(key: &str) -> bool {
    key.starts_with("app-")
        || key.starts_with("session-")
        || key.starts_with("page-")
        || key == "webui-version"
}

/// The keys defined as secret in variable definitions, `key|type|default`.
fn secret_definitions(definitions: &[String]) -> HashSet<String> {
    definitions
        .iter()
        .filter_map(|definition| {
            let mut parts = definition.split('|');
            let key = parts.next()?.trim();
            (parts.next()?.trim() == "secret" && !key.is_empty()).then(|| key.to_string())
        })
        .collect()
}

/// App data as a remote device is sent it: every global variable's value replaced by the marker.
// Called by the remote gateway, for every device (Docs/RemoteAccess.md, 1.4).
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn redact_app_data(app: &TaskProxyData) -> TaskProxyData {
    let mut redacted = app.clone();
    for (key, value) in redacted.data.iter_mut() {
        if !is_app_key(key) {
            *value = marker();
        }
    }
    redacted
}

/// A project's data as a remote device is sent it: its secret variables, any variable that is also a global one,
/// and the tokens replaced by the marker, in its values and in each environment's.
// Called by the remote gateway, for every device (Docs/RemoteAccess.md, 1.4).
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn redact_project_data(
    project: &ProjectData,
    global_definitions: &[String],
) -> ProjectData {
    let mut secret = secret_definitions(&project.variables);
    secret.extend(
        global_definitions
            .iter()
            .filter_map(|definition| definition.split('|').next())
            .map(|key| key.trim().to_string()),
    );
    secret.extend(TOKEN_KEYS.iter().map(|key| key.to_string()));
    let mut redacted = project.clone();
    for (key, value) in redacted.data.iter_mut() {
        if secret.contains(key) {
            *value = marker();
        }
    }
    if let Some(environments) = redacted
        .data
        .get_mut(ENVIRONMENTS_KEY)
        .and_then(Value::as_array_mut)
    {
        for environment in environments {
            if let Some(values) = environment
                .get_mut("variables")
                .and_then(Value::as_object_mut)
            {
                for (key, value) in values.iter_mut() {
                    if secret.contains(key) {
                        *value = marker();
                    }
                }
            }
        }
    }
    redacted
}

/// Puts back the real values wherever `incoming` holds the marker, from the same place in `current`. A marker with
/// nothing real behind it is left out. Returns None when `incoming` is itself the marker, which keeps the value.
pub(crate) fn restore_markers(incoming: &Value, current: Option<&Value>) -> Option<Value> {
    if is_marker(incoming) {
        return current.cloned();
    }
    match incoming {
        Value::Object(object) => Some(Value::Object(
            object
                .iter()
                .filter_map(|(key, value)| {
                    let real = current.and_then(|current| current.get(key));
                    restore_markers(value, real).map(|value| (key.clone(), value))
                })
                .collect(),
        )),
        Value::Array(items) => {
            // Environments are matched by name, since a device can add or reorder them.
            let current_items = current.and_then(Value::as_array);
            Some(Value::Array(
                items
                    .iter()
                    .enumerate()
                    .filter_map(|(index, item)| {
                        let real = current_items.and_then(|current| match item.get("name") {
                            Some(name) => {
                                current.iter().find(|other| other.get("name") == Some(name))
                            }
                            None => current.get(index),
                        });
                        restore_markers(item, real)
                    })
                    .collect(),
            ))
        }
        other => Some(other.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SECRETS: [&str; 5] = [
        "GLOBAL-TOKEN-1",
        "PROJECT-PAT-2",
        "DB-PASSWORD-3",
        "DEV-PASSWORD-4",
        "GLOBAL-KEY-5",
    ];

    fn app() -> TaskProxyData {
        let mut app = TaskProxyData::new();
        app.variables = vec![
            "github_pat|secret|".into(),
            "api_key|secret|".into(),
            "region|text|".into(),
        ];
        app.data = serde_json::from_value(json!({
            "github_pat": "GLOBAL-TOKEN-1", "api_key": "GLOBAL-KEY-5", "region": "us-east",
            "app-current-project": { "value": "/repo", "display": "Repo" }, "app-trusted-projects": ["/repo"],
            "page-path": "/docs", "session-x": 1, "webui-version": "1",
        }))
        .unwrap();
        app
    }

    fn project() -> ProjectData {
        let mut project = ProjectData::new();
        project.id = "p1".into();
        project.path = "/repo".into();
        project.variables = vec!["db_password|secret|".into(), "server|text|localhost".into()];
        project.data = serde_json::from_value(json!({
            "git_pat": "PROJECT-PAT-2", "db_password": "DB-PASSWORD-3", "server": "db.local", "api_key": "GLOBAL-KEY-5",
            "_gitCommitMessages": { "": "work in progress" },
            "_environments": [
                { "name": "dev", "variables": { "db_password": "DEV-PASSWORD-4", "server": "dev.local" } },
                { "name": "prod", "variables": { "server": "prod.local" } },
            ],
        }))
        .unwrap();
        project
    }

    #[test]
    fn only_the_marker_is_the_marker() {
        assert!(is_marker(&marker()));
        assert!(!is_marker(&json!({ "$secret": true, "other": 1 })));
        assert!(!is_marker(&json!({ "$secret": "yes" })));
        assert!(!is_marker(&json!("$secret")));
    }

    #[test]
    fn no_secret_reaches_a_device() {
        let sent = format!(
            "{}{}",
            serde_json::to_string(&redact_app_data(&app())).unwrap(),
            serde_json::to_string(&redact_project_data(&project(), &app().variables)).unwrap()
        );
        for secret in SECRETS {
            assert!(!sent.contains(secret), "{} was sent", secret);
        }
    }

    #[test]
    fn global_variables_are_hidden_and_app_state_is_not() {
        let redacted = redact_app_data(&app());
        for key in ["github_pat", "api_key", "region"] {
            assert!(is_marker(&redacted.data[key]), "{}", key);
        }
        assert_eq!(redacted.data["app-trusted-projects"], json!(["/repo"]));
        assert_eq!(redacted.data["page-path"], json!("/docs"));
        assert_eq!(
            redacted.variables,
            app().variables,
            "which variables exist is not secret"
        );
    }

    #[test]
    fn a_projects_secrets_are_hidden_and_its_other_values_are_not() {
        let redacted = redact_project_data(&project(), &app().variables);
        for key in ["git_pat", "db_password", "api_key"] {
            assert!(is_marker(&redacted.data[key]), "{}", key);
        }
        assert_eq!(redacted.data["server"], json!("db.local"));
        assert_eq!(
            redacted.data["_gitCommitMessages"],
            json!({ "": "work in progress" })
        );
        let environments = &redacted.data["_environments"];
        assert!(is_marker(&environments[0]["variables"]["db_password"]));
        assert_eq!(environments[0]["variables"]["server"], json!("dev.local"));
        assert_eq!(environments[1]["variables"]["server"], json!("prod.local"));
    }

    #[test]
    fn sending_back_the_marker_keeps_the_real_value() {
        let current = project().data["_environments"].clone();
        let mut incoming = redact_project_data(&project(), &[]).data["_environments"].clone();
        // The device changed another value, and added an environment with a secret it set itself.
        incoming[0]["variables"]["server"] = json!("changed.local");
        incoming
            .as_array_mut()
            .unwrap()
            .push(json!({ "name": "test", "variables": { "db_password": "TYPED" } }));
        let restored = restore_markers(&incoming, Some(&current)).unwrap();
        assert_eq!(
            restored[0]["variables"]["db_password"],
            json!("DEV-PASSWORD-4")
        );
        assert_eq!(restored[0]["variables"]["server"], json!("changed.local"));
        assert_eq!(restored[2]["variables"]["db_password"], json!("TYPED"));
        assert_eq!(
            restore_markers(&marker(), Some(&json!("real"))),
            Some(json!("real"))
        );
        // A marker with no value behind it is left out, rather than saved as the marker.
        assert_eq!(restore_markers(&marker(), None), None);
        assert_eq!(
            restore_markers(&json!({ "a": marker(), "b": 1 }), None),
            Some(json!({ "b": 1 }))
        );
    }

    #[test]
    fn environments_are_matched_by_name_when_reordered() {
        let current = json!([{ "name": "dev", "variables": { "k": "DEV" } }, { "name": "prod", "variables": { "k": "PROD" } }]);
        let incoming = json!([{ "name": "prod", "variables": { "k": marker() } }, { "name": "dev", "variables": { "k": marker() } }]);
        let restored = restore_markers(&incoming, Some(&current)).unwrap();
        assert_eq!(restored[0]["variables"]["k"], json!("PROD"));
        assert_eq!(restored[1]["variables"]["k"], json!("DEV"));
    }
}
