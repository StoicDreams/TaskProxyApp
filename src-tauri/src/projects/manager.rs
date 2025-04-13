use crate::prelude::*;
use tauri_plugin_dialog::DialogExt;

/// Create or load a project from the given path.
#[tauri::command]
pub fn add_project(app_handle: tauri::AppHandle) -> Option<String> {
    if let Some(file_path) = app_handle.dialog().file().blocking_pick_folder() {
        Some(file_path.to_string())
    } else {
        None
    }
}

/// Example greeting to test interaction from JavaScript to Rust
#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Create or load a project from the given path.
#[tauri::command]
pub fn get_projects(app_handle: AppHandle) -> Option<Vec<Project>> {
    match get_projects_from_local_storage(&app_handle) {
        Ok(projects) => Some(projects),
        Err(err) => {
            log::error!("Failed to load projects: {}", err);
            None
        }
    }
}
