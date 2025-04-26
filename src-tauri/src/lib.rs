use std::sync::LazyLock;

use crate::prelude::*;
use background::background_tasks;
use tauri::{Emitter, Manager, WindowEvent};
use tracing_subscriber::EnvFilter;

pub mod appdata;
pub mod background;
pub mod common;
pub mod datatypes;
pub mod errors;
pub mod prelude;
pub mod projects;

static DID_SAVE_ON_CLOSE: LazyLock<AtomicBool> = LazyLock::new(|| AtomicBool::new(false));

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
        WindowEvent::CloseRequested { api, .. } => {
            let can_close = DID_SAVE_ON_CLOSE.load(Ordering::SeqCst);
            if can_close {
                return;
            }
            DID_SAVE_ON_CLOSE.store(true, Ordering::SeqCst);
            api.prevent_close();
            let window = window.clone();
            println!("Saving data from window close");
            let app_handle = window.app_handle().clone();
            let main_window = app_handle.get_webview_window("main").unwrap();
            let _ = main_window.emit(
                "webui.isclosing",
                "Closing, please wait while we save your data!",
            );

            let app_data = {
                match app_handle.try_state::<SharedAppData>() {
                    Some(state) => match state.lock() {
                        Ok(data) => Some(data.to_owned()),
                        Err(_) => None,
                    },
                    None => None,
                }
            };
            let project_data = {
                match app_handle.try_state::<CurrentProject>() {
                    Some(state) => match state.lock() {
                        Ok(data) => Some(data.to_owned()),
                        Err(_) => None,
                    },
                    None => None,
                }
            };
            tauri::async_runtime::spawn(async move {
                let save_app_data = async {
                    if let Some(app_data) = app_data {
                        let result = save_app_data_to_local_storage(&app_handle, &app_data).await;
                        println!("{:?}", result);
                    }
                };
                let save_project_data = async {
                    if let Some(project_data) = project_data {
                        let result = save_project_data(project_data, app_handle.clone()).await;
                        println!("{:?}", result);
                    }
                };
                let (_save_app_result, _save_project_result) =
                    join!(save_app_data, save_project_data);

                println!("Saves complete - Closing window.");
                let _ = window.close();
            });
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
            #[cfg(debug_assertions)]
            window.open_devtools();
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
            projects::manager::get_project_data,
            projects::manager::get_project_file,
            projects::manager::get_projects,
            projects::manager::load_projects,
            projects::manager::save_project_data,
            projects::manager::save_project_file,
            projects::manager::sync_project_data
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
