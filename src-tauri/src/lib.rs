use crate::prelude::*;
use std::sync::{Arc, Mutex};
use tauri::Manager;

pub mod appdata;
pub mod datatypes;
pub mod errors;
pub mod prelude;
pub mod projects;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Setup plugins
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .manage(Arc::new(Mutex::new(Vec::<ProjectFull>::new())))
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init());

    // Setup window positioner
    builder = builder.setup(|app| {
        #[cfg(desktop)]
        {
            let _ = app.handle().plugin(tauri_plugin_positioner::init());
            tauri::tray::TrayIconBuilder::new()
                .on_tray_icon_event(|tray_handle, event| {
                    tauri_plugin_positioner::on_tray_event(tray_handle.app_handle(), &event);
                })
                .build(app)?;
        }
        Ok(())
    });

    // Fix for bug in initial page loading
    builder = builder.setup(|app| {
        // Get a handle to your main window using its label
        if let Some(window) = app.get_webview_window("taskproxy") {
            // Explicit nav required because Tauri initially tries loading page before assets are available.
            let url_to_load = "/";
            let nav_script = format!("window.location.replace('{}')", url_to_load);
            //std::thread::sleep(std::time::Duration::from_millis(100));
            let _ = window.eval(&nav_script);
        } else {
            log::error!("Could not get main window handle");
        }
        Ok(())
    });

    // Set commands accessible from JavaScript
    builder
        .invoke_handler(tauri::generate_handler![
            appdata::has_securitykey,
            appdata::set_securitykey,
            appdata::delete_securitykey,
            projects::manager::greet,
            projects::manager::add_project,
            projects::manager::get_projects,
            projects::manager::load_projects
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
