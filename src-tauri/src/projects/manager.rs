use crate::prelude::*;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub(crate) fn get_project_data(
    app_handle: AppHandle,
    state: State<CurrentProject>,
    project: Project,
) -> ProjectData {
    let project_hash = get_hash_code(&project.path);
    let mut project_state = state.lock().unwrap();
    let current_project = project_state.to_owned();
    if project_hash == current_project.id {
        return current_project;
    }
    _ = save_project_data(current_project, &app_handle);
    let project_root = PathBuf::from(&project.path);
    let data_root = project_root.join(".taskproxy");
    let nav_file = data_root.join("Navigation.json");
    let var_file = data_root.join("Variables.json");
    let mut data = ProjectData::new();
    data.id = project_hash.to_owned();
    data.path = project.path.to_owned();
    if nav_file.exists() && nav_file.is_file() {
        if let Ok(content) = fs::read_to_string(nav_file) {
            data.navigation = content;
        }
    }
    if var_file.exists() && var_file.is_file() {
        if let Ok(content) = fs::read_to_string(var_file) {
            if let Ok(variables) = serde_json::from_str::<Vec<String>>(&content) {
                data.variables = variables;
            }
        }
    }
    if let Ok(decrypted) =
        get_data_from_local_storage(&app_handle, &format!("{}.enc", project_hash))
    {
        if !decrypted.is_empty() {
            if let Ok(project_variables) =
                serde_json::from_slice::<HashMap<String, String>>(&decrypted)
            {
                data.data = project_variables;
            }
        }
    }
    *project_state = data.clone();
    data
}

#[tauri::command]
pub(crate) fn sync_project_data(
    state: State<CurrentProject>,
    data: ProjectData,
) -> Result<String, String> {
    let mut project_state = state.lock().unwrap();
    *project_state = data;
    Ok(format!("Project data synced"))
}

/// Create or load a project from the given path.
#[tauri::command]
pub(crate) fn add_project(
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
pub(crate) fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
pub(crate) fn get_projects(state: State<SharedProjects>) -> Vec<Project> {
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
pub(crate) fn load_projects(
    state: State<SharedProjects>,
    app_handle: AppHandle,
) -> Option<Vec<Project>> {
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
            eprintln!("Failed to load projects: {}", err);
            None
        }
    }
}

pub(crate) fn save_project_data(
    project: ProjectData,
    app_handle: &AppHandle,
) -> Result<String, String> {
    if project.id.is_empty() {
        return Err(format!("Project data is not associated with any project."));
    }
    if project.path.is_empty() {
        return Err(format!("Project data is missing path."));
    }
    let project_root = PathBuf::from(&project.path);
    let data_root = project_root.join(".taskproxy");
    let nav_file = data_root.join("Navigation.json");
    let var_file = data_root.join("Variables.json");
    match fs::write(&nav_file, &project.navigation) {
        Ok(_) => println!("{} Saved!", nav_file.display()),
        Err(err) => eprintln!("Error saving {}:{}", nav_file.display(), err),
    };
    match to_json(&project.variables) {
        Ok(json) => {
            match fs::write(&var_file, json) {
                Ok(_) => println!("{} Saved!", var_file.display()),
                Err(err) => eprintln!("Error saving {}:{}", var_file.display(), err),
            };
        }
        Err(err) => eprintln!("Error converting variables to json: {}", err),
    };
    let secrets_path = format!("{}.enc", project.id);
    match serde_json::to_string(&project.data) {
        Ok(json) => {
            match save_json_to_local_storage("Project secrets", app_handle, json, &secrets_path) {
                Ok(_) => println!("{} Saved!", secrets_path),
                Err(err) => eprintln!("Error saving {}:{}", secrets_path, err),
            }
        }
        Err(err) => eprintln!("Error converting variable values to json: {}", err),
    }
    Err(format!("Not Implemented"))
}
