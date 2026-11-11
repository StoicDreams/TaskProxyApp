use crate::prelude::*;
use tauri_plugin_updater::UpdaterExt;

#[tauri::command]
pub(crate) fn get_version(app: tauri::AppHandle, window: tauri::WebviewWindow) -> String {
    let version = app.package_info().version.to_string();
    let _ = window.set_title(&format!("Task Proxy - v{}", version));
    version
}

#[tauri::command]
pub(crate) async fn check_update(app: tauri::AppHandle) -> Result<bool, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update_check = updater.check().await.map_err(|e| e.to_string())?;
    Ok(update_check.is_some())
}

#[tauri::command]
pub(crate) async fn install_update(app: tauri::AppHandle) -> Result<String, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update_check = updater.check().await.map_err(|e| e.to_string())?;
    if let Some(update) = update_check {
        update
            .download_and_install(
                |chunk_length, content_length| {
                    println!("Downloaded {} of {:?}", chunk_length, content_length);
                },
                || {
                    println!("Download finished");
                },
            )
            .await
            .map_err(|e| e.to_string())?;
        // Restarting skips the save that normally happens when the window closes.
        if let Ok(data) = get_state_data::<TaskProxyData>(&app) {
            _ = save_app_data_to_local_storage(&app, &data).await;
        }
        if let Ok(data) = get_state_data::<ProjectData>(&app) {
            if !data.id.is_empty() {
                _ = persist_project_data(data, &app).await;
            }
        }
        restart_app(&app).await.map_err(|err| {
            format!(
                "The update was installed, but Task Proxy could not restart itself ({}). Close Task Proxy and open it again to finish updating.",
                err
            )
        })?;
        Ok("Update installed and app restarting...".to_string())
    } else {
        Ok("App is up to date.".to_string())
    }
}

/// How long a new copy of the app must keep running before this copy exits.
const RESTART_CHECK: Duration = Duration::from_secs(2);
const RESTART_ATTEMPTS: usize = 3;

/// Starts a new copy of the app and exits this one once the new copy is running.
/// Tauri's restart exits even when the new copy fails to start, which left no app open at all.
/// When the new copy fails every attempt, this copy keeps running and returns the error.
pub(crate) async fn restart_app(app: &AppHandle) -> Result<(), String> {
    let env = app.env();
    let path = tauri::process::current_binary(&env).map_err(|err| err.to_string())?;
    let mut error = String::new();
    for _ in 0..RESTART_ATTEMPTS {
        let mut command = std::process::Command::new(&path);
        command.args(env.args_os.iter().skip(1));
        // AppImageLauncher 3.0.0-beta-3 starts AppImages through an interpreter that hands
        // AppImageLauncher an argument list with no end marker, so a start fails whenever the memory
        // after that list is not empty. This variable makes the interpreter start the AppImage directly.
        #[cfg(target_os = "linux")]
        if env.appimage.is_some() {
            command.env("APPIMAGELAUNCHER_DISABLE", "1");
        }
        match start_and_confirm(command, RESTART_CHECK).await {
            Ok(()) => {
                app.exit(0);
                return Ok(());
            }
            Err(err) => {
                eprintln!("Restart attempt failed: {}", err);
                error = err;
            }
        }
    }
    Err(error)
}

/// Starts a process and waits to see that it is still running after `wait`.
async fn start_and_confirm(
    mut command: std::process::Command,
    wait: Duration,
) -> Result<(), String> {
    let mut child = command.spawn().map_err(|err| err.to_string())?;
    let step = Duration::from_millis(100);
    let mut waited = Duration::ZERO;
    while waited < wait {
        sleep(step).await;
        waited += step;
        if let Some(status) = child.try_wait().map_err(|err| err.to_string())? {
            return Err(format!("the new copy stopped at once with {}", status));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_process_that_keeps_running_counts_as_started() {
        let mut command = std::process::Command::new("sleep");
        command.arg("5");
        assert!(
            start_and_confirm(command, Duration::from_millis(300))
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn a_process_that_stops_at_once_is_an_error() {
        let mut command = std::process::Command::new("sh");
        command.args(["-c", "exit 3"]);
        let err = start_and_confirm(command, Duration::from_millis(300))
            .await
            .unwrap_err();
        assert!(err.contains('3'), "{}", err);
    }

    #[tokio::test]
    async fn a_process_that_cannot_start_is_an_error() {
        let command = std::process::Command::new("/nonexistent/taskproxy");
        assert!(
            start_and_confirm(command, Duration::from_millis(300))
                .await
                .is_err()
        );
    }
}
