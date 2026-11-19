//! The app's own files for a browser. A browser runs the same frontend as the window, so it always matches this
//! computer's version: www.taskproxy.com asks for each file the app loads, and the browser sends `remote_app_file`
//! over the connection.
//!
//! The files are the ones built into the app. Under `cargo tauri dev` nothing is built in, so they come from the dev
//! server instead.

use crate::prelude::*;
use base64::engine::general_purpose::STANDARD;

/// A file for the browser: its media type and its bytes as base64.
#[derive(Debug, PartialEq, Serialize)]
pub(crate) struct AppFile {
    pub mime: String,
    pub data: String,
}

/// The name a path is built in under: `/` is `index.html`, and the query and leading slashes are dropped. A path that
/// climbs out of the app's folder is refused.
pub(crate) fn asset_name(path: &str) -> Result<String, String> {
    let path = path.split(['?', '#']).next().unwrap_or_default();
    let name = path.trim_start_matches('/');
    if name.split('/').any(|part| part == "..") || name.contains('\\') {
        return Err(String::from("That isn't one of Task Proxy's files."));
    }
    Ok(if name.is_empty() || name.ends_with('/') {
        format!("{}index.html", name)
    } else {
        name.to_string()
    })
}

/// Reads an app file through `read`, which gives a built-in file's bytes and media type.
pub(crate) fn app_file_from(
    path: &str,
    read: impl Fn(&str) -> Option<(Vec<u8>, String)>,
) -> Result<AppFile, String> {
    let name = asset_name(path)?;
    let (bytes, mime) = read(&name).ok_or_else(|| format!("Task Proxy has no file '{}'.", name))?;
    Ok(AppFile {
        mime,
        data: STANDARD.encode(bytes),
    })
}

pub(crate) async fn app_file(app: &AppHandle, path: String) -> Result<AppFile, String> {
    let built_in = app_file_from(&path, |name| {
        app.asset_resolver()
            .get(name.to_string())
            .map(|asset| (asset.bytes, asset.mime_type))
    });
    if built_in.is_ok() || !cfg!(debug_assertions) {
        return built_in;
    }
    // A development build loads the window from the dev server, and builds no files in.
    let Some(dev) = app.config().build.dev_url.clone() else {
        return built_in;
    };
    let url = dev
        .join(&asset_name(&path)?)
        .map_err(|err| err.to_string())?;
    let response = reqwest::get(url)
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|err| err.to_string())?;
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = response.bytes().await.map_err(|err| err.to_string())?;
    Ok(AppFile {
        mime,
        data: STANDARD.encode(bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(name: &str) -> Option<(Vec<u8>, String)> {
        match name {
            "index.html" => Some((b"<html>".to_vec(), "text/html".into())),
            "wc/home.min.js" => Some((b"js".to_vec(), "text/javascript".into())),
            _ => None,
        }
    }

    #[test]
    fn the_root_is_the_index_and_paths_drop_their_query() {
        assert_eq!(asset_name("/").unwrap(), "index.html");
        assert_eq!(asset_name("").unwrap(), "index.html");
        assert_eq!(asset_name("/wc/home.min.js?v=2").unwrap(), "wc/home.min.js");
        assert_eq!(asset_name("/d/").unwrap(), "d/index.html");
    }

    #[test]
    fn a_built_in_file_comes_with_its_type() {
        assert_eq!(
            app_file_from("/wc/home.min.js", files).unwrap(),
            AppFile {
                mime: "text/javascript".into(),
                data: STANDARD.encode(b"js"),
            }
        );
        assert_eq!(app_file_from("/", files).unwrap().mime, "text/html");
    }

    #[test]
    fn missing_files_and_paths_out_of_the_app_are_refused() {
        assert!(
            app_file_from("/nope.js", files)
                .unwrap_err()
                .contains("no file")
        );
        assert!(app_file_from("/../secret", files).is_err());
        assert!(app_file_from("/wc/../../secret", files).is_err());
        assert!(app_file_from("/wc\\..\\secret", files).is_err());
    }
}
