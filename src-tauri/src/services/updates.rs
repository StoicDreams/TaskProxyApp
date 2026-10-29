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
        app.restart();
        Ok("Update installed and app restarting...".to_string())
    } else {
        Ok("App is up to date.".to_string())
    }
}
