use crate::prelude::*;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

/// Create or load a project from the given path.
#[tauri::command]
pub fn add_project(
    app_handle: tauri::AppHandle,
    state: State<SharedProjects>,
    name: &str,
) -> Result<String, String> {
    let file_path = match app_handle.dialog().file().blocking_pick_folder() {
        Some(file_path) => file_path,
        None => return Err(String::from("Folder selection cancelled")),
    };

    let project = ProjectFull::new(name, &file_path.to_string());
    let mut projects = state.lock().unwrap();
    let project_path = file_path.to_string();
    let project_exists = projects
        .iter()
        .any(|item| item.path.eq_ignore_ascii_case(&project_path));
    if project_exists {
        return Err(String::from(
            "The provided path is already in your set of projects.",
        ));
    }
    projects.push(project);
    projects.sort_by_key(|p| p.name.clone());
    let vec_projects = projects.to_vec();
    *projects = vec_projects.clone();
    save_projects_to_local_storage(&app_handle, &vec_projects)?;
    Ok(String::from("Project Successfully Added"))
}

/// Example greeting to test interaction from JavaScript to Rust
#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
pub fn get_projects(state: State<SharedProjects>) -> Vec<Project> {
    let projects = state.lock().unwrap();
    projects
        .iter()
        .map(|p| Project {
            name: p.name.clone(),
            path: p.path.clone(),
        })
        .collect()
}

/// Create or load a project from the given path.
#[tauri::command]
pub fn load_projects(state: State<SharedProjects>, app_handle: AppHandle) -> Option<Vec<Project>> {
    match get_projects_from_local_storage(&app_handle) {
        Ok(loaded_projects) => {
            let mut projects = state.lock().unwrap();
            *projects = loaded_projects;
            let projects = projects
                .iter()
                .map(|p| Project {
                    name: p.name.clone(),
                    path: p.path.clone(),
                })
                .collect();
            Some(projects)
        }
        Err(err) => {
            log::error!("Failed to load projects: {}", err);
            None
        }
    }
}
