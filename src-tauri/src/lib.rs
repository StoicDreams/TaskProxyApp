use crate::prelude::*;
use background::background_tasks;
use std::sync::{Arc, Mutex};
use tauri::{Manager, WindowEvent};
use tracing_subscriber::EnvFilter;

pub mod appdata;
pub mod background;
pub mod common;
pub mod datatypes;
pub mod errors;
pub mod prelude;
pub mod projects;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::new("info").add_directive("keyring=off".parse().unwrap()))
        .init();

    // Setup plugins
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init());

    // Setup states
    builder = builder
        .manage(Arc::new(Mutex::new(Vec::<Project>::new())))
        .manage(Arc::new(Mutex::new(TaskProxyData::new())))
        .manage(Arc::new(Mutex::new(ProjectData::new())));

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

    // Save data on close
    builder = builder.on_window_event(|window, event| match event {
        WindowEvent::CloseRequested { .. } => {
            let app_handle = window.app_handle();
            println!("Saving data from window close");
            match app_handle.try_state::<SharedAppData>() {
                Some(state) => {
                    if let Ok(app_data) = state.lock() {
                        let data = app_data.to_owned();
                        let result = save_app_data_to_local_storage(app_handle, &data);
                        println!("{:?}", result);
                    }
                }
                None => {}
            }
            match app_handle.try_state::<CurrentProject>() {
                Some(state) => {
                    if let Ok(project) = state.lock() {
                        let data = project.to_owned();
                        let result = save_project_data(data, app_handle.clone());
                        println!("{:?}", result);
                    }
                }
                None => {}
            }
        }
        _ => {}
    });

    // App setup
    builder = builder.setup(|app| {
        // Fix for bug in initial page loading
        if let Some(window) = app.get_webview_window("taskproxy") {
            // Explicit nav required because Tauri initially tries loading page before assets are available.
            let url_to_load = "/";
            let nav_script = format!("window.location.replace('{}')", url_to_load);
            //std::thread::sleep(std::time::Duration::from_millis(100));
            let _ = window.eval(&nav_script);
        } else {
            println!("Could not get main window handle");
        }
        // Spawn background task
        let app_handle = app.handle().clone();
        tauri::async_runtime::spawn(background_tasks(app_handle));
        Ok(())
    });

    // Set commands accessible from JavaScript
    builder
        .invoke_handler(tauri::generate_handler![
            appdata::delete_securitykey,
            appdata::get_app_data,
            appdata::has_securitykey,
            appdata::save_app_data,
            appdata::set_securitykey,
            appdata::sync_app_data,
            projects::manager::greet,
            projects::manager::add_project,
            projects::manager::get_projects,
            projects::manager::get_project_data,
            projects::manager::load_projects,
            projects::manager::save_project_data,
            projects::manager::sync_project_data
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
