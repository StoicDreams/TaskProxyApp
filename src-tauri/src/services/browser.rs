//! Opening web pages in the computer's own browser, for sign-in, plugins, and the window's links.

use crate::prelude::*;

/// Opens a web address in the computer's own browser. On Linux this runs `xdg-open` with the computer's own
/// environment (`host_env`), since an AppImage's would make it fail without a word. Says when it couldn't.
pub(crate) async fn open_in_browser(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| format!("'{}' isn't a web address.", url))?;
    if !matches!(parsed.scheme(), "https" | "http" | "mailto") {
        return Err(format!(
            "Task Proxy doesn't open '{}' addresses.",
            parsed.scheme()
        ));
    }
    let url = parsed.to_string();
    #[cfg(target_os = "linux")]
    {
        let url = url.clone();
        let opened = tokio::task::spawn_blocking(move || {
            let mut child = create_command("xdg-open")
                .arg(&url)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(|err| format!("xdg-open couldn't start: {}", err))?;
            // xdg-open hands the address to the browser and ends. One still running has started the browser itself.
            for _ in 0..50 {
                match child.try_wait() {
                    Ok(Some(status)) if status.success() => return Ok(()),
                    Ok(Some(status)) => {
                        return Err(format!("xdg-open couldn't open it ({}).", status));
                    }
                    Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                    Err(err) => return Err(err.to_string()),
                }
            }
            // Reaped in the background, so it never lingers as a zombie.
            std::thread::spawn(move || child.wait());
            Ok(())
        })
        .await
        .map_err(|err| err.to_string())?;
        if opened.is_ok() {
            return opened;
        }
    }
    tauri_plugin_opener::open_url(&url, None::<&str>)
        .map_err(|err| format!("Your browser couldn't be opened: {}", err))
}

/// Opens a web address in the computer's own browser, for the window's links.
#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    open_in_browser(&url).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn only_web_and_mail_addresses_are_opened() {
        assert!(
            open_in_browser("file:///etc/passwd")
                .await
                .unwrap_err()
                .contains("doesn't open")
        );
        assert!(
            open_in_browser("javascript:alert(1)")
                .await
                .unwrap_err()
                .contains("doesn't open")
        );
        assert!(
            open_in_browser("not an address")
                .await
                .unwrap_err()
                .contains("isn't a web address")
        );
    }
}
