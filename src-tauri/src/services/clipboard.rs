//! Copies images and text to the system clipboard.
//!
//! WebKitGTK's own Copy Image, and the Clipboard API in the page, report success on Wayland but leave nothing other
//! apps can paste, so the window sends what it copies here on every platform. The clipboard lives on its own thread for the
//! life of the app: on Linux the app that copied serves the image to whoever pastes, so it must stay alive.

use std::borrow::Cow;
use std::sync::mpsc::{Sender, channel};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::ipc::{InvokeBody, Request};

/// The largest image downloaded for copying.
const MAX_DOWNLOAD: usize = 50 * 1024 * 1024;

/// What to put on the clipboard.
enum Content {
    Image(arboard::ImageData<'static>),
    Text(String),
    /// Formatted text, with plain text for apps that can't paste it formatted.
    Html {
        html: String,
        text: String,
    },
    /// Files, pasted as a file manager pastes copied files.
    Files(Vec<std::path::PathBuf>),
}

type Job = (Content, Sender<Result<(), String>>);

static CLIPBOARD: OnceLock<Mutex<Sender<Job>>> = OnceLock::new();

fn clipboard() -> Sender<Job> {
    CLIPBOARD
        .get_or_init(|| {
            let (send, receive) = channel::<Job>();
            std::thread::spawn(move || {
                let mut clipboard = None;
                for (content, reply) in receive {
                    if clipboard.is_none() {
                        clipboard = arboard::Clipboard::new().ok();
                    }
                    let result = match (clipboard.as_mut(), content) {
                        (Some(clipboard), Content::Image(image)) => clipboard
                            .set_image(image)
                            .map_err(|err| format!("The image could not be copied: {err}")),
                        (Some(clipboard), Content::Text(text)) => clipboard
                            .set_text(text)
                            .map_err(|err| format!("The text could not be copied: {err}")),
                        (Some(clipboard), Content::Html { html, text }) => clipboard
                            .set_html(html, Some(text))
                            .map_err(|err| format!("The page could not be copied: {err}")),
                        (Some(clipboard), Content::Files(files)) => clipboard
                            .set()
                            .file_list(&files)
                            .map_err(|err| format!("The file could not be copied: {err}")),
                        (None, _) => Err("The clipboard could not be reached.".to_string()),
                    };
                    let _ = reply.send(result);
                }
            });
            Mutex::new(send)
        })
        .lock()
        .map(|send| send.clone())
        .unwrap_or_else(|poisoned| poisoned.into_inner().clone())
}

/// An image file's pixels, from PNG, JPEG, WebP, or GIF bytes.
pub(crate) fn decode(bytes: &[u8]) -> Result<arboard::ImageData<'static>, String> {
    let image = image::load_from_memory(bytes)
        .map_err(|err| format!("The image could not be read: {err}"))?
        .to_rgba8();
    let (width, height) = image.dimensions();
    Ok(arboard::ImageData {
        width: width as usize,
        height: height as usize,
        bytes: Cow::Owned(image.into_raw()),
    })
}

fn set_image(image: arboard::ImageData<'static>) -> Result<(), String> {
    put(Content::Image(image))
}

fn put(content: Content) -> Result<(), String> {
    let (reply, result) = channel();
    clipboard()
        .send((content, reply))
        .map_err(|_| "The clipboard could not be reached.".to_string())?;
    result
        .recv()
        .map_err(|_| "The clipboard could not be reached.".to_string())?
}

/// Whether an image address may be downloaded for copying: any https site, or a file this app's own file server
/// serves. Nothing else on this computer is asked.
pub(crate) fn may_download(url: &str, file_server_base: Option<&str>) -> bool {
    if url.starts_with("https://") {
        return true;
    }
    file_server_base.is_some_and(|base| url.starts_with(&format!("{base}/")))
}

/// Copies text, such as the sign-in code.
#[tauri::command]
pub async fn copy_text(text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || put(Content::Text(text)))
        .await
        .map_err(|err| err.to_string())?
}

/// Copies formatted text as HTML, with `text` for apps that only paste plain text.
#[tauri::command]
pub async fn copy_html(html: String, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || put(Content::Html { html, text }))
        .await
        .map_err(|err| err.to_string())?
}

/// Puts files on the clipboard, to paste where files go, such as a folder or an email.
pub(crate) fn copy_files(files: Vec<std::path::PathBuf>) -> Result<(), String> {
    put(Content::Files(files))
}

/// Copies an image the window sends as the request's raw bytes.
#[tauri::command]
pub async fn copy_image(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("The image was not sent.".to_string());
    };
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || set_image(decode(&bytes)?))
        .await
        .map_err(|err| err.to_string())?
}

/// Copies an image the window can't read itself, such as one from another website.
#[tauri::command]
pub async fn copy_image_url(url: String) -> Result<(), String> {
    let base = crate::services::file_server::get_file_server_base().ok();
    if !may_download(&url, base.as_deref()) {
        return Err("Only images from https websites or this project can be copied.".to_string());
    }
    let client = reqwest::Client::builder()
        .user_agent("TaskProxy")
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|err| err.to_string())?;
    let mut response = client
        .get(&url)
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|err| format!("The image could not be downloaded: {err}"))?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("The image could not be downloaded: {err}"))?
    {
        if bytes.len() + chunk.len() > MAX_DOWNLOAD {
            return Err("The image is too large to copy.".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    tauri::async_runtime::spawn_blocking(move || set_image(decode(&bytes)?))
        .await
        .map_err(|err| err.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let image = image::RgbaImage::from_pixel(width, height, image::Rgba([200, 30, 30, 255]));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        bytes.into_inner()
    }

    #[test]
    fn decodes_a_png_to_its_pixels() {
        let image = decode(&png(4, 3)).unwrap();
        assert_eq!((image.width, image.height), (4, 3));
        assert_eq!(image.bytes.len(), 4 * 3 * 4);
        assert_eq!(&image.bytes[..4], &[200, 30, 30, 255]);
    }

    #[test]
    fn refuses_bytes_that_are_not_an_image() {
        assert!(decode(b"not an image").is_err());
    }

    #[test]
    fn downloads_only_https_and_this_apps_files() {
        let base = Some("http://127.0.0.1:4000/token");
        assert!(may_download("https://example.com/a.png", base));
        assert!(may_download(
            "http://127.0.0.1:4000/token/img%2Fa.png",
            base
        ));
        assert!(!may_download("http://127.0.0.1:4000/other/a.png", base));
        assert!(!may_download("http://127.0.0.1:4000/tokenx/a.png", base));
        assert!(!may_download("http://example.com/a.png", base));
        assert!(!may_download("file:///etc/passwd", base));
        assert!(!may_download("http://127.0.0.1:4000/token/a.png", None));
    }
}
