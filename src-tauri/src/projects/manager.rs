use crate::prelude::*;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub(crate) async fn get_project_data(
    app_handle: AppHandle,
    state: State<'_, CurrentProject>,
    project: Project,
) -> Result<ProjectData, String> {
    let project_hash = get_hash_code(&project.path);
    let current_project = {
        let project_state = state
            .lock()
            .map_err(|err| format!("get_project_data State failure: {}", err))?;
        project_state.to_owned()
    };
    if project_hash == current_project.id {
        return Ok(current_project);
    }
    _ = save_project_data(current_project, app_handle.clone()).await;
    let project_root = PathBuf::from(&project.path);
    let data_root = project_root.join(".taskproxy");
    let nav_file = data_root.join("Navigation.json");
    let var_file = data_root.join("Variables.json");
    let project = project.clone();
    let result = task::spawn_blocking(async move || {
        let mut data = ProjectData::new();
        data.id = project_hash.to_owned();
        data.path = project.path.to_owned();
        if nav_file.exists() && nav_file.is_file() {
            if let Ok(content) = fs::read_to_string(nav_file) {
                if let Ok(nav) = serde_json::from_str::<Vec<ProjectNavItem>>(&content) {
                    data.navigation = nav;
                }
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
            get_data_from_local_storage(&app_handle, &format!("{}.cp.enc", project_hash)).await
        {
            if !decrypted.is_empty() {
                if let Ok(current_page) = String::from_utf8(decrypted) {
                    data.current_page = current_page;
                }
            }
        }
        if let Ok(decrypted) =
            get_data_from_local_storage(&app_handle, &format!("{}.enc", project_hash)).await
        {
            if !decrypted.is_empty() {
                if let Ok(project_variables) =
                    serde_json::from_slice::<HashMap<String, String>>(&decrypted)
                {
                    data.data = project_variables;
                }
            }
        }
        {
            data.docs = get_project_docs(&data.path).await;
        }
        data
    })
    .await
    .map_err(|err| format!("{}", err));
    let data = match result {
        Ok(data) => data.await,
        Err(_) => ProjectData::new(),
    };
    {
        let mut project_state = state
            .lock()
            .map_err(|err| format!("get_project_data State failure: {}", err))?;
        *project_state = data.clone();
    };
    Ok(data)
}

#[tauri::command]
pub(crate) fn sync_project_data(
    state: State<CurrentProject>,
    data: ProjectData,
) -> Result<String, String> {
    let mut project_state = state
        .lock()
        .map_err(|err| format!("sync_project_data State failure: {}", err))?;
    *project_state = data;
    Ok(format!("Project data synced"))
}

#[tauri::command]
pub(crate) async fn get_project_file(
    state: State<'_, CurrentProject>,
    file_path: String,
) -> Result<String, String> {
    let mut project_path = String::new();
    {
        for attempt in 1..=100 {
            match state.lock() {
                Ok(project_state) => {
                    if !project_state.path.is_empty() {
                        project_path = project_state.path.to_owned();
                        break;
                    }
                }
                Err(_) => (),
            };
            println!("Waiting for project state - {}", attempt);
            sleep(Duration::from_millis(100)).await;
        }
    }
    if file_path.is_empty() {
        return Err(String::from(
            "Get Project File: Unable to load page data, project not loaded.",
        ));
    }
    println!("Get project file: {} - {}", project_path, file_path);
    if file_path.contains("./") || file_path.contains(".\\") {
        return Err(String::from("Get Project File: Invalid file path."));
    }
    let proj_path = PathBuf::from(project_path);
    let file = proj_path.join(file_path);
    if !file.is_file() {
        return Err(String::from("Get Project File: File not found"));
    }
    let result = task::spawn_blocking(move || fs::read_to_string(file)).await;
    let result = result.map_err(|err| format!("{}", err))?;
    result.map_err(|err| format!("Failed to load file: {}", err))
}

#[tauri::command]
pub(crate) async fn save_project_file(
    state: State<'_, CurrentProject>,
    file_path: String,
    contents: String,
) -> Result<String, String> {
    let mut contents = contents.to_owned();
    if !contents.ends_with('\n') {
        contents = format!("{}\n", contents);
    }
    let project_path = {
        let project_state = state.lock().map_err(|err| {
            format!(
                "Save Project File Failed: get_page_data State failure: {}",
                err
            )
        })?;
        let project = project_state.to_owned();
        if project.path.is_empty() {
            return Err(String::from(
                "Save Project File Failed: Unable to load page data, project not loaded.",
            ));
        }
        project.path
    };
    if file_path.is_empty() {
        return Err(String::from(
            "Save Project File Failed: File path is empty.",
        ));
    }
    if file_path.contains("./") || file_path.contains(".\\") {
        return Err(format!(
            "Save Project File Failed: Invalid file path:{}",
            file_path
        ));
    }
    let proj_path = PathBuf::from(project_path);
    let file = proj_path.join(file_path);
    if file.extension().is_none() {
        return Err(String::from(
            "Save Project File Failed: File path is missing a file extension",
        ));
    }
    let file_clone = file.clone();
    let contents_clone = contents.clone();
    let result = task::spawn_blocking(move || {
        if let Some(dir) = file_clone.parent() {
            _ = fs::create_dir_all(dir);
        }
        fs::write(file_clone, contents_clone)
    })
    .await;
    let result = result.map_err(|err| format!("{}", err))?;
    match result {
        Ok(()) => Ok(String::from("File saved")),
        Err(err) => Err(format!("{}", err)),
    }
}

/// Create or load a project from the given path.
#[tauri::command]
pub(crate) async fn add_project(
    app_handle: tauri::AppHandle,
    state: State<'_, SharedProjects>,
    name: &str,
) -> Result<String, String> {
    let file_path = match app_handle.dialog().file().blocking_pick_folder() {
        Some(file_path) => file_path,
        None => return Err(String::from("Folder selection cancelled")),
    };
    let project_path = file_path.to_string();
    let project = Project::new(name, &file_path.to_string());
    let vec_projects = {
        let mut projects = state
            .lock()
            .map_err(|err| format!("add_project State failure: {}", err))?;
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
        vec_projects
    };
    save_projects_to_local_storage(&app_handle, &vec_projects).await?;
    Ok(String::from("Project Successfully Added"))
}

/// Example greeting to test interaction from JavaScript to Rust
#[tauri::command]
pub(crate) fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
pub(crate) fn get_projects(state: State<SharedProjects>) -> Result<Vec<Project>, String> {
    let projects = state
        .lock()
        .map_err(|err| format!("get_projects State failure: {}", err))?;
    Ok(projects
        .iter()
        .map(|p| Project {
            name: p.name.clone(),
            path: p.path.clone(),
        })
        .collect())
}

/// Create or load a project from the given path.
#[tauri::command]
pub(crate) async fn load_projects(
    state: State<'_, SharedProjects>,
    app_handle: AppHandle,
) -> Result<Vec<Project>, String> {
    let loaded_projects = get_projects_from_local_storage(&app_handle)
        .await
        .map_err(|err| format!("Failed to load projects: {}", err))?;
    let mut projects = state
        .lock()
        .map_err(|err| format!("load_projects State failure: {}", err))?;
    *projects = loaded_projects;
    let projects = projects
        .iter()
        .map(|p| Project {
            name: p.name.clone(),
            path: p.path.clone(),
        })
        .collect();
    Ok(projects)
}

#[tauri::command]
pub(crate) async fn save_project_data(
    data: ProjectData,
    app_handle: AppHandle,
) -> Result<String, String> {
    if data.id.is_empty() {
        return Err(format!("Project data is not associated with any project."));
    }
    if data.path.is_empty() {
        return Err(format!("Project data is missing path."));
    }
    let project_root = PathBuf::from(&data.path);
    let data_root = project_root.join(".taskproxy");
    let nav_file = data_root.join("Navigation.json");
    let var_file = data_root.join("Variables.json");
    match to_json(&data.navigation) {
        Ok(json) => {
            match fs::write(&nav_file, &json) {
                Ok(_) => println!("{} Saved!", nav_file.display()),
                Err(err) => eprintln!("Error saving {}:{}", nav_file.display(), err),
            };
        }
        Err(err) => eprintln!("Error converting navigation to json: {}", err),
    }
    match to_json(&data.variables) {
        Ok(json) => {
            match fs::write(&var_file, json) {
                Ok(_) => println!("{} Saved!", var_file.display()),
                Err(err) => eprintln!("Error saving {}:{}", var_file.display(), err),
            };
        }
        Err(err) => eprintln!("Error converting variables to json: {}", err),
    };
    let secrets_path = format!("{}.cp.enc", data.id);
    match save_json_to_local_storage(
        "Project current page",
        &app_handle,
        data.current_page.clone(),
        &secrets_path,
    )
    .await
    {
        Ok(_) => println!(
            "Current page {} at {} Saved!",
            data.current_page, secrets_path
        ),
        Err(err) => eprintln!("Error saving Current Page {}:{}", secrets_path, err),
    }
    let secrets_path = format!("{}.enc", data.id);
    match serde_json::to_string(&data.data) {
        Ok(json) => {
            match save_json_to_local_storage("Project secrets", &app_handle, json, &secrets_path)
                .await
            {
                Ok(_) => println!("Secrets at {} Saved!", secrets_path),
                Err(err) => eprintln!("Error saving secrets {}:{}", secrets_path, err),
            }
        }
        Err(err) => eprintln!("Error converting variable values to json: {}", err),
    }
    Ok(format!("Project data saved"))
}

async fn get_project_docs(project_path: &str) -> Vec<String> {
    let mut docs = vec![];
    let root = PathBuf::from(project_path);
    collect_md_files(&root, &root, &mut docs);
    docs
}

fn collect_md_files(current_path: &Path, root: &Path, docs: &mut Vec<String>) {
    if let Ok(entries) = fs::read_dir(current_path) {
        for entry in entries.flatten() {
            let path = entry.path();

            if path.is_dir() {
                if path.file_name().map_or(false, |name| name == ".taskproxy") {
                    continue;
                }
                collect_md_files(&path, root, docs);
            } else if path.extension().map_or(false, |ext| ext == "md") {
                if let Ok(relative_path) = path.strip_prefix(root) {
                    docs.push(relative_path.to_string_lossy().into_owned());
                }
            }
        }
    }
}
