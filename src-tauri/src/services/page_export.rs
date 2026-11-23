//! Saves a page exported in the window (wc/page-export.js) to a file the user chooses, or copies it as a file.
//!
//! The window sends the file's bytes as the request's body, with the page's title and the kind of file in headers, so
//! the path is only ever chosen here, in the desktop's own save dialog.

use std::fs;
use std::path::{Path, PathBuf};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

/// The folder in the app-local data dir that holds the one file last copied, which stays there for pasting.
const COPY_DIR: &str = "exports";
/// The most characters of a page's title used in a file's name.
const MAX_NAME: usize = 100;

/// A kind of file's extension and the name its save dialog filter shows.
fn kind(name: &str) -> Result<(&'static str, &'static str), String> {
    match name {
        "pdf" => Ok(("pdf", "PDF document")),
        "html" => Ok(("html", "Web page")),
        "md" => Ok(("md", "Markdown")),
        "txt" => Ok(("txt", "Text")),
        _ => Err(format!("A page can't be exported as {name}.")),
    }
}

/// A file name from a page's title, with what no system allows in a name replaced. Never empty.
pub(crate) fn file_name(title: &str, extension: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| {
            if c.is_control() || r#"<>:"/\|?*"#.contains(c) {
                '-'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let base: String = if trimmed.is_empty() { "Page" } else { trimmed }
        .chars()
        .take(MAX_NAME)
        .collect();
    format!("{}.{extension}", base.trim_end())
}

/// Text the window sent through encodeURIComponent, since a header holds only ASCII.
pub(crate) fn decode_component(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let hex = bytes
            .get(index + 1..index + 3)
            .and_then(|pair| std::str::from_utf8(pair).ok())
            .and_then(|pair| u8::from_str_radix(pair, 16).ok());
        match (bytes[index], hex) {
            (b'%', Some(byte)) => {
                out.push(byte);
                index += 3;
            }
            (byte, _) => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The file's bytes, the page's title, and the kind of file, from the request.
fn read(request: &Request<'_>) -> Result<(Vec<u8>, String, String), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("The page was not sent.".to_string());
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(decode_component)
            .unwrap_or_default()
    };
    Ok((
        bytes.clone(),
        header("x-export-title"),
        header("x-export-kind"),
    ))
}

/// Writes the file to copy in `dir`, removing any copied before, since only the last one copied can be pasted.
pub(crate) fn store_copy(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|err| format!("The file could not be copied: {err}"))?;
    }
    fs::create_dir_all(dir).map_err(|err| format!("The file could not be copied: {err}"))?;
    let path = dir.join(name);
    fs::write(&path, bytes).map_err(|err| format!("The file could not be copied: {err}"))?;
    Ok(path)
}

/// Asks where to save the page and saves it there. Resolves to the file's name, or nothing when no file was chosen.
#[tauri::command]
pub async fn export_save(app: AppHandle, request: Request<'_>) -> Result<Option<String>, String> {
    let (bytes, title, kind_name) = read(&request)?;
    let (extension, label) = kind(&kind_name)?;
    let name = file_name(&title, extension);
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Export the page")
            .set_file_name(&name)
            .add_filter(label, &[extension])
            .blocking_save_file()
    })
    .await
    .map_err(|err| err.to_string())?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|err| format!("The page could not be saved there: {err}"))?;
    fs::write(&path, &bytes).map_err(|err| format!("The page could not be saved: {err}"))?;
    Ok(Some(
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
    ))
}

/// Copies the page as a file, to paste where files go, such as a folder, an email, or a chat.
#[tauri::command]
pub async fn export_copy_file(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let (bytes, title, kind_name) = read(&request)?;
    let (extension, _) = kind(&kind_name)?;
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|err| err.to_string())?
        .join(COPY_DIR);
    let name = file_name(&title, extension);
    tauri::async_runtime::spawn_blocking(move || {
        let path = store_copy(&dir, &name, &bytes)?;
        crate::services::clipboard::copy_files(vec![path])
    })
    .await
    .map_err(|err| err.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_a_file_after_the_page_title() {
        assert_eq!(file_name("Release Notes", "pdf"), "Release Notes.pdf");
        assert_eq!(file_name("A/B: what? <now>", "md"), "A-B- what- -now-.md");
        assert_eq!(file_name("  ..  ", "html"), "Page.html");
        assert_eq!(file_name("", "txt"), "Page.txt");
        assert_eq!(file_name(&"x".repeat(300), "pdf").len(), MAX_NAME + 4);
    }

    #[test]
    fn decodes_what_encode_uri_component_wrote() {
        assert_eq!(decode_component("Caf%C3%A9%20%2F%20Notes"), "Café / Notes");
        assert_eq!(decode_component("100%"), "100%");
        assert_eq!(decode_component("%zz"), "%zz");
    }

    #[test]
    fn keeps_only_the_last_file_copied() {
        let dir = std::env::temp_dir().join(format!("tp-export-{}", uuid::Uuid::now_v7()));
        let first = store_copy(&dir, "One.pdf", b"one").unwrap();
        let second = store_copy(&dir, "Two.md", b"two").unwrap();
        assert!(!first.exists());
        assert_eq!(fs::read(&second).unwrap(), b"two");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn exports_only_known_kinds() {
        assert_eq!(kind("pdf").unwrap().0, "pdf");
        assert!(kind("exe").is_err());
    }
}
