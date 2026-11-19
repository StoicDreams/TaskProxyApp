//! A project's icon: an image file in its repo, chosen in Settings and kept in `.taskproxy/Project.json` as
//! `{"icon": "path/in/the/repo.svg"}`, so it is committed and shared with the project like its pages.
//!
//! Icons reach the window as data URIs, which lets the project dropdown show every saved project's icon, not only the
//! open project's that the file server could stream. That is only fit for small files, so an image over
//! `MAX_ICON_BYTES` can't be the icon.

use crate::prelude::*;
use base64::engine::general_purpose::STANDARD;
use serde_json::Map;

const PROJECT_FILE: &str = "Project.json";
/// The largest image a project can use as its icon.
pub(crate) const MAX_ICON_BYTES: u64 = 512 * 1024;
/// The most images the picker lists, so a repo full of images doesn't flood it.
const MAX_LISTED: usize = 500;
const IMAGE_TYPES: &[(&str, &str)] = &[
    ("svg", "image/svg+xml"),
    ("png", "image/png"),
    ("webp", "image/webp"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("ico", "image/x-icon"),
    ("avif", "image/avif"),
];

/// A saved project and its icon, as a data URI, or None when it has none or it can't be read.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectIcon {
    pub path: String,
    pub icon: Option<String>,
}

fn image_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_string_lossy().to_lowercase();
    IMAGE_TYPES
        .iter()
        .find(|(name, _)| *name == extension)
        .map(|(_, mime)| *mime)
}

fn settings_file(root: &Path) -> PathBuf {
    root.join(".taskproxy").join(PROJECT_FILE)
}

/// The settings in Project.json, as an object. Fields Task Proxy doesn't know yet are kept as they are.
fn read_settings(root: &Path) -> Map<String, Value> {
    fs::read_to_string(settings_file(root))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

/// A project file that can be the icon: an image inside the project, small enough, and not inside `.git`.
fn checked_image(root: &Path, icon: &str) -> Result<PathBuf, String> {
    let relative = safe_relative_path(icon)?;
    if targets_git_dir(&relative) {
        return Err(String::from(
            "A file inside .git can't be the project's icon.",
        ));
    }
    let path = root.join(&relative);
    ensure_inside_root(root, &path)?;
    if image_type(&path).is_none() {
        return Err(format!(
            "'{}' isn't an image Task Proxy can show. Choose an SVG, PNG, WebP, JPEG, GIF, ICO, or AVIF file.",
            icon
        ));
    }
    let size = fs::metadata(&path)
        .map_err(|_| format!("The project has no file '{}'.", icon))?
        .len();
    if size > MAX_ICON_BYTES {
        return Err(format!(
            "'{}' is too large for an icon. Choose an image under {} KB.",
            icon,
            MAX_ICON_BYTES / 1024
        ));
    }
    Ok(path)
}

/// The icon a project chose, as its path in the repo.
pub(crate) fn icon_path(root: &Path) -> Option<String> {
    read_settings(root)
        .get("icon")
        .and_then(Value::as_str)
        .map(String::from)
        .filter(|icon| !icon.trim().is_empty())
}

/// A project's icon as a data URI, or None when it has none, or the file is gone or no longer fit to be one.
pub(crate) fn icon_data_uri(root: &Path) -> Option<String> {
    let icon = icon_path(root)?;
    let path = checked_image(root, &icon).ok()?;
    let bytes = fs::read(&path).ok()?;
    Some(format!(
        "data:{};base64,{}",
        image_type(&path)?,
        STANDARD.encode(bytes)
    ))
}

/// Sets a project's icon, or clears it with None, keeping anything else in Project.json. Writes nothing when a
/// project with no Project.json clears an icon it never had.
pub(crate) fn set_icon(root: &Path, icon: Option<&str>) -> Result<(), String> {
    let icon = icon.map(str::trim).filter(|icon| !icon.is_empty());
    if let Some(icon) = icon {
        checked_image(root, icon)?;
    }
    let file = settings_file(root);
    let mut settings = read_settings(root);
    match icon {
        Some(icon) => {
            settings.insert(String::from("icon"), Value::String(icon.replace('\\', "/")));
        }
        None => {
            if settings.remove("icon").is_none() && !file.exists() {
                return Ok(());
            }
        }
    }
    let mut text =
        serde_json::to_string_pretty(&Value::Object(settings)).map_err(|err| err.to_string())?;
    text.push('\n');
    write_atomic(&file, text.as_bytes())
        .map_err(|err| format!("Error saving {}: {}", file.display(), err))
}

/// The images in a project that could be its icon, as paths in the repo, sorted.
pub(crate) fn image_files(root: &Path) -> Vec<String> {
    let mut images = Vec::new();
    walk_project_files(root, COMMON_SKIP_DIRS, |path| {
        if images.len() >= MAX_LISTED || image_type(path).is_none() {
            return;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            return;
        };
        if targets_git_dir(relative) {
            return;
        }
        if fs::metadata(path).is_ok_and(|meta| meta.len() <= MAX_ICON_BYTES) {
            images.push(relative.to_string_lossy().replace('\\', "/"));
        }
    });
    images.sort_by_key(|path| path.to_lowercase());
    images
}

fn open_project_root(state: &State<'_, CurrentProject>) -> Result<PathBuf, String> {
    let project = state
        .lock()
        .map_err(|err| format!("Project state failure: {}", err))?;
    if project.path.is_empty() {
        return Err(String::from("Project not loaded."));
    }
    Ok(PathBuf::from(&project.path))
}

/// The root of `path` when it is one of the saved projects, never any other folder.
pub(crate) fn saved_project_root(projects: &[Project], path: &str) -> Option<PathBuf> {
    let path = path.replace('\\', "/");
    projects
        .iter()
        .find(|project| project.path.replace('\\', "/") == path)
        .map(|project| PathBuf::from(&project.path))
}

/// The saved project at `project`, or the open project when none is named.
fn project_root(
    open: &State<'_, CurrentProject>,
    saved: &State<'_, SharedProjects>,
    project: Option<String>,
) -> Result<PathBuf, String> {
    let Some(path) = project else {
        return open_project_root(open);
    };
    let projects = saved
        .lock()
        .map_err(|err| format!("Projects state failure: {}", err))?;
    saved_project_root(&projects, &path)
        .ok_or_else(|| String::from("That project isn't one of your projects."))
}

/// Whether `file`, relative to `root`, is an image that could be the project's icon. Only these are served from
/// projects that aren't open (see file_server.rs).
pub(crate) fn is_icon_image(root: &Path, file: &str) -> bool {
    checked_image(root, file).is_ok()
}

/// Every saved project's icon, for the project dropdown.
#[tauri::command]
pub(crate) async fn get_project_icons(
    state: State<'_, SharedProjects>,
) -> Result<Vec<ProjectIcon>, String> {
    let projects = state
        .lock()
        .map_err(|err| format!("Projects state failure: {}", err))?
        .clone();
    task::spawn_blocking(move || {
        projects
            .into_iter()
            .map(|project| ProjectIcon {
                icon: icon_data_uri(Path::new(&project.path)),
                path: project.path,
            })
            .collect()
    })
    .await
    .map_err(|err| err.to_string())
}

/// A project's images that could be its icon, and the one it uses now: the saved project at `project`, or the open
/// project.
#[tauri::command]
pub(crate) async fn get_project_images(
    state: State<'_, CurrentProject>,
    projects: State<'_, SharedProjects>,
    project: Option<String>,
) -> Result<Value, String> {
    let root = project_root(&state, &projects, project)?;
    task::spawn_blocking(
        move || serde_json::json!({ "images": image_files(&root), "icon": icon_path(&root) }),
    )
    .await
    .map_err(|err| err.to_string())
}

/// Sets or clears a project's icon, the saved project at `project` or the open project, and returns it as a data URI.
#[tauri::command]
pub(crate) async fn set_project_icon(
    state: State<'_, CurrentProject>,
    projects: State<'_, SharedProjects>,
    project: Option<String>,
    icon: Option<String>,
) -> Result<Option<String>, String> {
    let root = project_root(&state, &projects, project)?;
    task::spawn_blocking(move || {
        set_icon(&root, icon.as_deref())?;
        Ok(icon_data_uri(&root))
    })
    .await
    .map_err(|err| err.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("img")).unwrap();
        fs::write(
            dir.path().join("img/logo.svg"),
            r#"<svg xmlns="http://www.w3.org/2000/svg"/>"#,
        )
        .unwrap();
        fs::write(dir.path().join("readme.md"), "# Readme").unwrap();
        dir
    }

    #[test]
    fn a_chosen_icon_is_saved_in_project_json_and_read_back_as_a_data_uri() {
        let dir = project();
        set_icon(dir.path(), Some("img/logo.svg")).unwrap();
        assert_eq!(icon_path(dir.path()).as_deref(), Some("img/logo.svg"));
        let text = fs::read_to_string(dir.path().join(".taskproxy/Project.json")).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&text).unwrap(),
            serde_json::json!({ "icon": "img/logo.svg" })
        );
        assert!(text.ends_with('\n'));
        let uri = icon_data_uri(dir.path()).unwrap();
        assert!(uri.starts_with("data:image/svg+xml;base64,"), "{}", uri);
    }

    #[test]
    fn clearing_the_icon_keeps_other_settings_and_writes_nothing_for_a_project_without_one() {
        let dir = project();
        set_icon(dir.path(), None).unwrap();
        assert!(
            !dir.path().join(".taskproxy").exists(),
            "nothing to clear, so no file"
        );
        fs::create_dir_all(dir.path().join(".taskproxy")).unwrap();
        fs::write(
            dir.path().join(".taskproxy/Project.json"),
            r#"{"icon":"img/logo.svg","later":1}"#,
        )
        .unwrap();
        set_icon(dir.path(), None).unwrap();
        let saved: Value = serde_json::from_str(
            &fs::read_to_string(dir.path().join(".taskproxy/Project.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(saved, serde_json::json!({ "later": 1 }));
        assert_eq!(icon_data_uri(dir.path()), None);
    }

    #[test]
    fn only_small_images_inside_the_project_can_be_the_icon() {
        let dir = project();
        assert!(
            set_icon(dir.path(), Some("readme.md"))
                .unwrap_err()
                .contains("isn't an image")
        );
        assert!(
            set_icon(dir.path(), Some("missing.png"))
                .unwrap_err()
                .contains("no file")
        );
        assert!(set_icon(dir.path(), Some("../outside.png")).is_err());
        assert!(set_icon(dir.path(), Some("/etc/logo.png")).is_err());
        fs::write(
            dir.path().join("big.png"),
            vec![0u8; MAX_ICON_BYTES as usize + 1],
        )
        .unwrap();
        assert!(
            set_icon(dir.path(), Some("big.png"))
                .unwrap_err()
                .contains("too large")
        );
        assert!(
            !dir.path().join(".taskproxy/Project.json").exists(),
            "a refused icon saves nothing"
        );
    }

    #[test]
    fn an_icon_whose_file_is_gone_shows_none() {
        let dir = project();
        set_icon(dir.path(), Some("img/logo.svg")).unwrap();
        fs::remove_file(dir.path().join("img/logo.svg")).unwrap();
        assert_eq!(icon_data_uri(dir.path()), None);
    }

    #[test]
    fn the_picker_lists_the_projects_small_images_and_skips_build_folders() {
        let dir = project();
        fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        fs::write(dir.path().join("node_modules/pkg/icon.png"), "x").unwrap();
        fs::write(dir.path().join("Banner.PNG"), "x").unwrap();
        fs::write(
            dir.path().join("huge.webp"),
            vec![0u8; MAX_ICON_BYTES as usize + 1],
        )
        .unwrap();
        assert_eq!(image_files(dir.path()), vec!["Banner.PNG", "img/logo.svg"]);
    }
}
