//! App and project data as patches.
//!
//! A screen sends only what it changed (`patch_app_data`, `patch_project_data`), rather than its whole copy, so two
//! screens changing different values do not undo each other. Rust applies the patch to its copy, which is what
//! saving writes, raises the revision, and sends the patch to every screen as `data-changed`. The screen that sent
//! it ignores its own. Which keys each screen keeps for itself, such as the page it shows, is decided in `app.js`.

use crate::prelude::*;
use serde_json::Map;
use std::sync::atomic::AtomicU64;
use tauri::Emitter;

/// Project fields a patch may not change, since they say which project it is.
const FIXED_PROJECT_FIELDS: [&str; 2] = ["id", "path"];

/// What a screen changed: values set and removed in `data`, and other fields, such as `variables` or
/// `navigation`, given whole.
#[derive(Clone, Serialize, Deserialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DataPatch {
    #[serde(default)]
    pub set: HashMap<String, Value>,
    #[serde(default)]
    pub remove: Vec<String>,
    #[serde(default)]
    pub fields: Map<String, Value>,
}

/// A patch every screen applies. `screen` names the one that sent it.
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct DataChanged {
    scope: &'static str,
    /// The project's id, for project data.
    id: String,
    rev: u64,
    screen: String,
    #[serde(flatten)]
    patch: DataPatch,
}

/// Revisions of app data and of the open project's data, raised by each patch.
#[derive(Default)]
pub(crate) struct DataRevs {
    app: AtomicU64,
    project: AtomicU64,
}

/// Applies a patch to `target`, whose `data` holds the values. Fields it does not have, and `fixed` ones, are
/// ignored, and a field of the wrong type is refused, leaving `target` unchanged.
pub(crate) fn apply_patch<T: Serialize + DeserializeOwned>(
    target: &mut T,
    patch: &DataPatch,
    fixed: &[&str],
) -> Result<(), String> {
    let mut value = serde_json::to_value(&*target).map_err(|err| err.to_string())?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| String::from("Data is not an object."))?;
    for (key, field) in &patch.fields {
        if key != "data" && !fixed.contains(&key.as_str()) && object.contains_key(key) {
            object.insert(key.clone(), field.clone());
        }
    }
    let data = object
        .get_mut("data")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| String::from("Data has no values."))?;
    for key in &patch.remove {
        data.remove(key);
    }
    for (key, item) in &patch.set {
        data.insert(key.clone(), item.clone());
    }
    *target = serde_json::from_value(value)
        .map_err(|err| format!("The change could not be applied: {}", err))?;
    Ok(())
}

/// Applies a screen's change to app data, and sends it to every other screen. Returns the new revision.
#[tauri::command]
pub(crate) fn patch_app_data(
    app_handle: AppHandle,
    state: State<'_, SharedAppData>,
    revs: State<'_, DataRevs>,
    patch: DataPatch,
    screen: String,
) -> Result<u64, String> {
    let rev = {
        let mut app_data = state
            .lock()
            .map_err(|err| format!("State failure: {}", err))?;
        apply_patch(&mut *app_data, &patch, &[])?;
        revs.app.fetch_add(1, Ordering::SeqCst) + 1
    };
    let _ = app_handle.emit(
        "data-changed",
        DataChanged {
            scope: "app",
            id: String::new(),
            rev,
            screen,
            patch,
        },
    );
    Ok(rev)
}

/// Applies a screen's change to the open project's data, and sends it to every other screen. A change for a
/// project that is no longer open is dropped, and returns 0. Returns the new revision.
#[tauri::command]
pub(crate) fn patch_project_data(
    app_handle: AppHandle,
    state: State<'_, CurrentProject>,
    revs: State<'_, DataRevs>,
    id: String,
    patch: DataPatch,
    screen: String,
) -> Result<u64, String> {
    let rev = {
        let mut project = state
            .lock()
            .map_err(|err| format!("State failure: {}", err))?;
        if id.is_empty() || project.id != id {
            return Ok(0);
        }
        apply_patch(&mut *project, &patch, &FIXED_PROJECT_FIELDS)?;
        revs.project.fetch_add(1, Ordering::SeqCst) + 1
    };
    let _ = app_handle.emit(
        "data-changed",
        DataChanged {
            scope: "project",
            id,
            rev,
            screen,
            patch,
        },
    );
    Ok(rev)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn project() -> ProjectData {
        serde_json::from_value(json!({
            "id": "p1", "path": "/repo", "currentPage": "/", "docs": [], "navigation": [], "variables": ["one|text|"],
            "data": { "one": "1", "two": 2, "gone": true }
        }))
        .unwrap()
    }

    fn patch(value: Value) -> DataPatch {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn a_patch_sets_and_removes_only_the_values_it_names() {
        let mut data = project();
        apply_patch(
            &mut data,
            &patch(json!({ "set": { "one": "changed", "new": [1, 2] }, "remove": ["gone"] })),
            &[],
        )
        .unwrap();
        assert_eq!(data.data.get("one"), Some(&json!("changed")));
        assert_eq!(
            data.data.get("two"),
            Some(&json!(2)),
            "values it does not name stay"
        );
        assert_eq!(data.data.get("new"), Some(&json!([1, 2])));
        assert!(!data.data.contains_key("gone"));
    }

    #[test]
    fn two_screens_changing_different_values_keep_both() {
        let mut data = project();
        apply_patch(
            &mut data,
            &patch(json!({ "set": { "one": "from the desk" } })),
            &[],
        )
        .unwrap();
        apply_patch(
            &mut data,
            &patch(json!({ "set": { "two": "from the phone" } })),
            &[],
        )
        .unwrap();
        assert_eq!(data.data.get("one"), Some(&json!("from the desk")));
        assert_eq!(data.data.get("two"), Some(&json!("from the phone")));
    }

    #[test]
    fn fields_are_replaced_whole_except_fixed_and_unknown_ones() {
        let mut data = project();
        let change = patch(json!({ "fields": {
            "currentPage": "/docs", "variables": ["a|text|", "b|secret|"], "id": "other", "path": "/elsewhere",
            "unknown": 1, "data": { "replaced": true }
        } }));
        apply_patch(&mut data, &change, &FIXED_PROJECT_FIELDS).unwrap();
        assert_eq!(data.current_page, "/docs");
        assert_eq!(data.variables, ["a|text|", "b|secret|"]);
        assert_eq!((data.id.as_str(), data.path.as_str()), ("p1", "/repo"));
        assert!(
            !data.data.contains_key("replaced"),
            "values only change through set and remove"
        );
        assert_eq!(data.data.len(), 3);
    }

    #[test]
    fn a_field_of_the_wrong_type_is_refused_and_nothing_changes() {
        let mut data = project();
        let change =
            patch(json!({ "set": { "one": "x" }, "fields": { "variables": "not a list" } }));
        assert!(apply_patch(&mut data, &change, &[]).is_err());
        assert_eq!(data.data.get("one"), Some(&json!("1")));
        assert_eq!(data.variables, ["one|text|"]);
    }

    #[test]
    fn app_data_takes_patches_too() {
        let mut data = TaskProxyData::new();
        apply_patch(&mut data, &patch(json!({ "set": { "app-current-project": { "value": "/repo" } }, "fields": { "variables": ["x|text|"] } })), &[]).unwrap();
        assert_eq!(
            data.data.get("app-current-project"),
            Some(&json!({ "value": "/repo" }))
        );
        assert_eq!(data.variables, ["x|text|"]);
    }
}
