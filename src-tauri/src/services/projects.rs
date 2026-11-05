use crate::prelude::*;
use std::sync::LazyLock;
use tauri_plugin_dialog::DialogExt;

const NAVIGATION_FILE: &str = "Navigation.json";
const VARIABLES_FILE: &str = "Variables.json";
const EMPTY_LIST: &str = "[]";

/// What the shared project files contained when last loaded or written, per project.
/// These files are committed with the project, so they can change on disk at any time.
static FILE_BASELINES: LazyLock<Mutex<HashMap<String, FileBaselines>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone)]
struct FileBaselines {
    navigation: String,
    variables: String,
}

#[derive(Debug, PartialEq)]
enum DiskFile {
    Missing,
    Parsed(String),
    Unparseable,
}

#[derive(Debug, PartialEq)]
enum SaveAction {
    Skip,
    Write,
    Conflict,
}

fn read_list_file<T: DeserializeOwned + Serialize>(path: &Path) -> (DiskFile, Vec<T>) {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return (DiskFile::Missing, Vec::new());
        }
        Err(_) => return (DiskFile::Unparseable, Vec::new()),
    };
    match serde_json::from_str::<Vec<T>>(&content) {
        Ok(items) => match to_json(&items) {
            Ok(json) => (DiskFile::Parsed(json), items),
            Err(_) => (DiskFile::Unparseable, Vec::new()),
        },
        Err(_) => (DiskFile::Unparseable, Vec::new()),
    }
}

fn plan_file_save(baseline: &str, memory: &str, disk: &DiskFile) -> SaveAction {
    if memory == baseline {
        return SaveAction::Skip;
    }
    match disk {
        DiskFile::Unparseable => SaveAction::Conflict,
        DiskFile::Missing if memory == EMPTY_LIST => SaveAction::Skip,
        DiskFile::Missing => SaveAction::Write,
        DiskFile::Parsed(json) if json == memory => SaveAction::Skip,
        DiskFile::Parsed(json) if json == baseline => SaveAction::Write,
        DiskFile::Parsed(_) => SaveAction::Conflict,
    }
}

fn save_list_file<T: DeserializeOwned + Serialize>(
    path: &Path,
    baseline: &mut String,
    memory: &str,
) -> Result<(), String> {
    let (disk, _) = read_list_file::<T>(path);
    match plan_file_save(baseline, memory, &disk) {
        SaveAction::Skip => {}
        SaveAction::Write => write_atomic(path, memory.as_bytes())
            .map_err(|err| format!("Error saving {}: {}", path.display(), err))?,
        SaveAction::Conflict => {
            return Err(format!(
                "{} was not saved because the file changed on disk or could not be read. Fix the file if needed, then restart Task Proxy to load it.",
                path.display()
            ));
        }
    }
    *baseline = memory.to_string();
    Ok(())
}

fn save_project_files(
    id: &str,
    root: &Path,
    navigation: String,
    variables: String,
) -> Result<(), String> {
    let data_root = root.join(".taskproxy");
    let nav_file = data_root.join(NAVIGATION_FILE);
    let var_file = data_root.join(VARIABLES_FILE);
    let mut baselines = FILE_BASELINES
        .lock()
        .map_err(|err| format!("File baseline failure: {}", err))?;
    let baseline = baselines.entry(id.to_string()).or_insert_with(|| {
        let (_, nav_items) = read_list_file::<ProjectNavItem>(&nav_file);
        let (_, var_items) = read_list_file::<String>(&var_file);
        FileBaselines {
            navigation: to_json(&nav_items).unwrap_or_else(|_| EMPTY_LIST.to_string()),
            variables: to_json(&var_items).unwrap_or_else(|_| EMPTY_LIST.to_string()),
        }
    });
    let nav_result =
        save_list_file::<ProjectNavItem>(&nav_file, &mut baseline.navigation, &navigation);
    let var_result = save_list_file::<String>(&var_file, &mut baseline.variables, &variables);
    match (nav_result, var_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(err), Ok(())) | (Ok(()), Err(err)) => Err(err),
        (Err(nav_err), Err(var_err)) => Err(format!("{}\n{}", nav_err, var_err)),
    }
}

/// Read the shared project files and record them as the new baseline.
fn load_project_files(id: &str, root: &Path) -> (Vec<ProjectNavItem>, Vec<String>) {
    let data_root = root.join(".taskproxy");
    let (_, navigation) = read_list_file::<ProjectNavItem>(&data_root.join(NAVIGATION_FILE));
    let (_, variables) = read_list_file::<String>(&data_root.join(VARIABLES_FILE));
    if let Ok(mut baselines) = FILE_BASELINES.lock() {
        baselines.insert(
            id.to_string(),
            FileBaselines {
                navigation: to_json(&navigation).unwrap_or_else(|_| EMPTY_LIST.to_string()),
                variables: to_json(&variables).unwrap_or_else(|_| EMPTY_LIST.to_string()),
            },
        );
    }
    (navigation, variables)
}

fn reload_files_from_disk(mut data: ProjectData) -> ProjectData {
    let data_root = PathBuf::from(&data.path).join(".taskproxy");
    let memory_nav = to_json(&data.navigation).unwrap_or_default();
    let memory_vars = to_json(&data.variables).unwrap_or_default();
    let Ok(mut baselines) = FILE_BASELINES.lock() else {
        return data;
    };
    let Some(baseline) = baselines.get_mut(&data.id) else {
        return data;
    };
    if memory_nav == baseline.navigation {
        let (disk, items) = read_list_file::<ProjectNavItem>(&data_root.join(NAVIGATION_FILE));
        if disk != DiskFile::Unparseable {
            baseline.navigation = to_json(&items).unwrap_or_else(|_| EMPTY_LIST.to_string());
            data.navigation = items;
        }
    }
    if memory_vars == baseline.variables {
        let (disk, items) = read_list_file::<String>(&data_root.join(VARIABLES_FILE));
        if disk != DiskFile::Unparseable {
            baseline.variables = to_json(&items).unwrap_or_else(|_| EMPTY_LIST.to_string());
            data.variables = items;
        }
    }
    data
}

#[tauri::command]
pub(crate) async fn get_project_data(
    app_handle: AppHandle,
    state: State<'_, CurrentProject>,
    mut project: Project,
) -> Result<ProjectData, String> {
    project.path = project.path.replace('\\', "/");
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
    _ = persist_project_data(current_project, &app_handle).await;
    let mut data = ProjectData::new();
    data.id = project_hash.clone();
    data.path = project.path.clone();
    let (navigation, variables, docs) = {
        let id = project_hash.clone();
        let path = project.path.clone();
        task::spawn_blocking(move || {
            let (navigation, variables) = load_project_files(&id, Path::new(&path));
            (navigation, variables, get_project_docs(&path))
        })
        .await
        .map_err(|err| format!("{}", err))?
    };
    data.navigation = navigation;
    data.variables = variables;
    data.docs = docs;
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
                serde_json::from_slice::<HashMap<String, Value>>(&decrypted)
            {
                data.data = project_variables;
            }
        }
    }
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
    // A late sync from the previous project must not replace the one now open.
    if project_state.id == data.id {
        *project_state = data;
    }
    Ok(String::from("Project data synced"))
}

fn current_project_path(
    state: &State<'_, CurrentProject>,
    context: &str,
) -> Result<PathBuf, String> {
    let project_state = state
        .lock()
        .map_err(|err| format!("{}: State failure: {}", context, err))?;
    if project_state.path.is_empty() {
        return Err(format!("{}: Project not loaded.", context));
    }
    Ok(PathBuf::from(project_state.path.replace('\\', "/")))
}

#[tauri::command]
pub(crate) async fn get_project_file(
    state: State<'_, CurrentProject>,
    file_path: String,
) -> Result<String, String> {
    let root = current_project_path(&state, GET_FILE_CONTEXT)?;
    let result = task::spawn_blocking(move || read_project_file(&root, &file_path)).await;
    result.map_err(|err| format!("{}", err))?
}

const GET_FILE_CONTEXT: &str = "Get Project File";
const SAVE_FILE_CONTEXT: &str = "Save Project File Failed";

/// The frontend treats this exact error as a page that has not been created yet.
fn read_project_file(root: &Path, file_path: &str) -> Result<String, String> {
    let relative =
        safe_relative_path(file_path).map_err(|err| format!("{}: {}", GET_FILE_CONTEXT, err))?;
    let file = root.join(relative);
    if !file.is_file() {
        return Err(format!("{}: File not found", GET_FILE_CONTEXT));
    }
    ensure_inside_root(root, &file).map_err(|err| format!("{}: {}", GET_FILE_CONTEXT, err))?;
    fs::read_to_string(file).map_err(|err| format!("Failed to load file: {}", err))
}

fn write_project_file(root: &Path, file_path: &str, contents: &str) -> Result<(), String> {
    let error = |err: String| format!("{}: {}", SAVE_FILE_CONTEXT, err);
    let relative = safe_relative_path(file_path).map_err(error)?;
    if targets_git_dir(&relative) {
        return Err(error(String::from("Cannot write inside a .git folder.")));
    }
    if relative.extension().is_none() {
        return Err(error(String::from("File path is missing a file extension")));
    }
    let file = root.join(relative);
    ensure_inside_root(root, &file).map_err(error)?;
    let mut contents = contents.to_string();
    if !contents.ends_with('\n') {
        contents.push('\n');
    }
    // A crash during a plain write would leave the file cut short.
    write_atomic(&file, contents.as_bytes()).map_err(|err| error(err.to_string()))
}

#[tauri::command]
pub(crate) async fn save_project_file(
    state: State<'_, CurrentProject>,
    file_path: String,
    contents: String,
) -> Result<String, String> {
    let root = current_project_path(&state, SAVE_FILE_CONTEXT)?;
    let result =
        task::spawn_blocking(move || write_project_file(&root, &file_path, &contents)).await;
    result.map_err(|err| format!("{}", err))??;
    Ok(String::from("File saved"))
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
    let project_path = file_path.to_string().replace('\\', "/");
    let mut project_name = name.trim().to_string();
    if project_name.is_empty() {
        let path = PathBuf::from(&project_path);
        if let Some(folder_name) = path.file_name().and_then(|n| n.to_str()) {
            project_name = folder_name.to_string();
        } else {
            return Err(String::from(
                "Could not determine project name from folder.",
            ));
        }
    }
    let project = Project::new(&project_name, &project_path);
    let vec_projects = {
        let mut projects = state
            .lock()
            .map_err(|err| format!("add_project State failure: {}", err))?;
        let path_exists = projects
            .iter()
            .any(|item| item.path.eq_ignore_ascii_case(&project_path));
        if path_exists {
            return Err(String::from(
                "The selected folder is already used by an existing project.",
            ));
        }
        let name_exists = projects
            .iter()
            .any(|item| item.name.eq_ignore_ascii_case(&project_name));
        if name_exists {
            return Err(String::from(
                "A project with this name already exists. Please choose a different name or folder.",
            ));
        }
        projects.push(project);
        sort_projects(&mut projects);
        projects.to_vec()
    };
    save_projects_to_local_storage(&app_handle, &vec_projects).await?;
    Ok(String::from("Project Successfully Added"))
}

#[tauri::command]
pub(crate) async fn add_projects_multi(
    app_handle: tauri::AppHandle,
    state: State<'_, SharedProjects>,
) -> Result<Vec<String>, String> {
    let file_paths = match app_handle.dialog().file().blocking_pick_folders() {
        Some(paths) => paths,
        None => return Err(String::from("Folder selection cancelled")),
    };
    let mut results = Vec::new();
    let mut vec_projects_to_save = None;
    {
        let mut projects = state
            .lock()
            .map_err(|err| format!("add_projects_multi State failure: {}", err))?;
        let mut added_any = false;
        for file_path in file_paths {
            let project_path = file_path.to_string().replace('\\', "/");
            let path_buf = PathBuf::from(&project_path);
            let project_name =
                if let Some(folder_name) = path_buf.file_name().and_then(|n| n.to_str()) {
                    folder_name.to_string()
                } else {
                    results.push(format!(
                        "Error: Could not determine project name from folder {}",
                        project_path
                    ));
                    continue;
                };
            let path_exists = projects
                .iter()
                .any(|item| item.path.eq_ignore_ascii_case(&project_path));
            if path_exists {
                results.push(format!("Skipped '{}': Folder already used.", project_name));
                continue;
            }
            let name_exists = projects
                .iter()
                .any(|item| item.name.eq_ignore_ascii_case(&project_name));
            if name_exists {
                results.push(format!("Skipped '{}': Name already exists.", project_name));
                continue;
            }
            projects.push(Project::new(&project_name, &project_path));
            added_any = true;
            results.push(format!("Added '{}'", project_name));
        }
        if added_any {
            sort_projects(&mut projects);
            vec_projects_to_save = Some(projects.to_vec());
        }
    }
    if let Some(vec_projects) = vec_projects_to_save {
        save_projects_to_local_storage(&app_handle, &vec_projects).await?;
    }
    Ok(results)
}

fn sort_projects(projects: &mut [Project]) {
    projects.sort_by_cached_key(|project| project.name.to_lowercase());
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
    Ok(projects.to_vec())
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
    *projects = loaded_projects.clone();
    Ok(loaded_projects)
}

#[tauri::command]
pub(crate) async fn save_project_data(
    data: ProjectData,
    app_handle: AppHandle,
) -> Result<String, String> {
    if let Some(state) = app_handle.try_state::<CurrentProject>() {
        if let Ok(mut project_state) = state.lock() {
            // A save for a project that is no longer current must not replace the current one.
            if project_state.id == data.id {
                *project_state = data.clone();
            }
        }
    }
    persist_project_data(data, &app_handle).await
}

/// Write project data to disk without changing the in-memory project.
pub(crate) async fn persist_project_data(
    data: ProjectData,
    app_handle: &AppHandle,
) -> Result<String, String> {
    if data.id.is_empty() {
        return Err(String::from(
            "Project data is not associated with any project.",
        ));
    }
    if data.path.is_empty() {
        return Err(String::from("Project data is missing path."));
    }
    let mut errors = Vec::new();
    let id = data.id.clone();
    let root = PathBuf::from(&data.path);
    let navigation = to_json(&data.navigation)?;
    let variables = to_json(&data.variables)?;
    let file_result =
        task::spawn_blocking(move || save_project_files(&id, &root, navigation, variables))
            .await
            .map_err(|err| format!("{}", err))?;
    if let Err(err) = file_result {
        errors.push(err);
    }
    if let Err(err) = save_json_to_local_storage(
        "Project current page",
        app_handle,
        data.current_page.clone(),
        &format!("{}.cp.enc", data.id),
    )
    .await
    {
        errors.push(err);
    }
    let secrets = serde_json::to_string(&data.data).map_err(|err| err.to_string())?;
    if let Err(err) = save_json_to_local_storage(
        "Project secrets",
        app_handle,
        secrets,
        &format!("{}.enc", data.id),
    )
    .await
    {
        errors.push(err);
    }
    if errors.is_empty() {
        Ok(String::from("Project data saved"))
    } else {
        Err(errors.join("\n"))
    }
}

/// Forget the current project, after saving it.
#[tauri::command]
pub(crate) async fn clear_current_project(
    app_handle: AppHandle,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let current = {
        let mut project_state = state
            .lock()
            .map_err(|err| format!("clear_current_project State failure: {}", err))?;
        std::mem::replace(&mut *project_state, ProjectData::new())
    };
    if !current.id.is_empty() {
        _ = persist_project_data(current, &app_handle).await;
    }
    Ok(String::from("Project closed"))
}

/// Pick up changes to shared project files, such as those made by a git pull.
/// Files with unsaved edits in memory are left alone.
#[tauri::command]
pub(crate) async fn reload_project_files(
    state: State<'_, CurrentProject>,
) -> Result<ProjectData, String> {
    let data = {
        let project_state = state
            .lock()
            .map_err(|err| format!("reload_project_files State failure: {}", err))?;
        project_state.clone()
    };
    if data.id.is_empty() {
        return Ok(data);
    }
    let reloaded = task::spawn_blocking(move || reload_files_from_disk(data))
        .await
        .map_err(|err| format!("{}", err))?;
    let mut project_state = state
        .lock()
        .map_err(|err| format!("reload_project_files State failure: {}", err))?;
    if project_state.id == reloaded.id {
        project_state.navigation = reloaded.navigation.clone();
        project_state.variables = reloaded.variables.clone();
    }
    Ok(reloaded)
}

#[tauri::command]
pub(crate) async fn rename_project(
    app_handle: tauri::AppHandle,
    state: State<'_, SharedProjects>,
    path: &str,
    new_name: &str,
) -> Result<String, String> {
    let path = path.replace('\\', "/");
    let new_name_trimmed = new_name.trim().to_string();
    if new_name_trimmed.is_empty() {
        return Err(String::from("Project name cannot be empty."));
    }
    let vec_projects = {
        let mut projects = state
            .lock()
            .map_err(|err| format!("rename_project State failure: {}", err))?;
        let name_exists = projects.iter().any(|item| {
            item.name.eq_ignore_ascii_case(&new_name_trimmed)
                && !item.path.eq_ignore_ascii_case(&path)
        });
        if name_exists {
            return Err(String::from(
                "A project with this name already exists. Please choose a different name.",
            ));
        }
        if let Some(project) = projects
            .iter_mut()
            .find(|item| item.path.eq_ignore_ascii_case(&path))
        {
            project.name = new_name_trimmed;
        } else {
            return Err(String::from("Project not found."));
        }
        sort_projects(&mut projects);
        projects.to_vec()
    };
    save_projects_to_local_storage(&app_handle, &vec_projects).await?;
    Ok(String::from("Project Successfully Renamed"))
}

#[tauri::command]
pub(crate) async fn remove_project(
    app_handle: tauri::AppHandle,
    state: State<'_, SharedProjects>,
    path: &str,
) -> Result<String, String> {
    let path = path.replace('\\', "/");
    let vec_projects = {
        let mut projects = state
            .lock()
            .map_err(|err| format!("remove_project State failure: {}", err))?;
        let initial_len = projects.len();
        projects.retain(|item| !item.path.eq_ignore_ascii_case(&path));
        if projects.len() == initial_len {
            return Err(String::from("Project not found."));
        }
        projects.to_vec()
    };
    save_projects_to_local_storage(&app_handle, &vec_projects).await?;
    Ok(String::from("Project Successfully Removed"))
}

fn get_project_docs(project_path: &str) -> Vec<String> {
    const SKIP_DIRS: &[&str] = &[
        ".taskproxy",
        "target",
        "dist",
        "build",
        "node_modules",
        ".git",
    ];
    let root = PathBuf::from(project_path);
    let mut docs = Vec::new();
    walk_project_files(&root, SKIP_DIRS, |path| {
        if path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        {
            if let Ok(relative_path) = path.strip_prefix(&root) {
                // The frontend compares these paths, and joins them with forward slashes.
                docs.push(relative_path.to_string_lossy().replace('\\', "/"));
            }
        }
    });
    docs.sort();
    docs
}

#[tauri::command]
pub(crate) async fn search_project_files(
    state: State<'_, CurrentProject>,
    filter: String,
    display: Option<String>,
) -> Result<Vec<DropdownOption>, String> {
    let project_path = {
        let project_state = state
            .lock()
            .map_err(|err| format!("search_project_files State failure: {}", err))?;
        if project_state.path.is_empty() {
            return Err(String::from("Project not loaded."));
        }
        project_state.path.clone()
    };
    let display_format = display.unwrap_or_default();
    let patterns: Vec<String> = filter
        .split('|')
        .map(|s| s.trim().replace('\\', "/").to_lowercase())
        .filter(|s| !s.is_empty() && !s.contains("..") && !s.starts_with('/') && !s.contains(':'))
        .collect();
    if patterns.is_empty() {
        return Ok(Vec::new());
    }
    let result = task::spawn_blocking(move || {
        let root = fs::canonicalize(&project_path).unwrap_or_else(|_| PathBuf::from(&project_path));
        let mut matches = Vec::new();
        collect_filtered_files(&root, &patterns, &display_format, &mut matches);
        matches.sort_by_cached_key(|item| item.display.to_lowercase());
        matches
    })
    .await
    .map_err(|err| format!("Search task failed: {}", err))?;
    Ok(result)
}

fn collect_filtered_files(
    root: &Path,
    patterns: &[String],
    display_format: &str,
    results: &mut Vec<DropdownOption>,
) {
    const SKIP_DIRS: &[&str] = &[
        ".taskproxy",
        "target",
        "dist",
        "build",
        "node_modules",
        ".git",
        "bin",
        "obj",
        ".vs",
        ".vscode",
    ];
    walk_project_files(root, SKIP_DIRS, |path| {
        let Ok(relative_path) = path.strip_prefix(root) else {
            return;
        };
        let rel_str = relative_path.to_string_lossy().replace('\\', "/");
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let rel_lower = rel_str.to_lowercase();
        let is_match = patterns.iter().any(|pat| {
            if pat.contains('/') {
                wildcard_match(pat, &rel_lower)
            } else {
                wildcard_match(pat, &file_name)
            }
        });
        if is_match {
            let display = format_option_display(relative_path, &rel_str, display_format);
            results.push(DropdownOption {
                value: rel_str,
                display,
            });
        }
    });
}

fn wildcard_match(pattern: &str, text: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == text;
    }
    let mut pos = 0;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        if i == 0 {
            if !text.starts_with(part) {
                return false;
            }
            pos = part.len();
        } else if i == parts.len() - 1 {
            if !text[pos..].ends_with(part) {
                return false;
            }
            pos = text.len();
        } else if let Some(found) = text[pos..].find(part) {
            pos += found + part.len();
        } else {
            return false;
        }
    }
    true
}

fn format_option_display(rel_path: &Path, rel_str: &str, format: &str) -> String {
    if format.trim().is_empty() {
        return rel_str.to_string();
    }
    let file_stem = rel_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = rel_path
        .extension()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let parent = rel_path
        .parent()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let path_no_ext = if parent.is_empty() {
        file_stem.clone()
    } else {
        format!("{}/{}", parent, file_stem)
    };
    format
        .replace("[path]", &path_no_ext)
        .replace("[file]", &file_stem)
        .replace("[parent]", &parent)
        .replace("[ext]", &ext)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(json: &str) -> DiskFile {
        DiskFile::Parsed(json.to_string())
    }

    #[test]
    fn unchanged_memory_never_overwrites_the_file() {
        // A teammate's change arrived through git pull while memory is unchanged.
        assert_eq!(
            plan_file_save("old", "old", &parsed("pulled")),
            SaveAction::Skip
        );
        // The file has merge conflicts, which load as an empty list.
        assert_eq!(
            plan_file_save(EMPTY_LIST, EMPTY_LIST, &DiskFile::Unparseable),
            SaveAction::Skip
        );
    }

    #[test]
    fn edits_are_written_only_over_the_version_they_started_from() {
        assert_eq!(
            plan_file_save("old", "edit", &parsed("old")),
            SaveAction::Write
        );
        assert_eq!(
            plan_file_save("old", "edit", &parsed("edit")),
            SaveAction::Skip
        );
        assert_eq!(
            plan_file_save("old", "edit", &parsed("pulled")),
            SaveAction::Conflict
        );
        assert_eq!(
            plan_file_save("old", "edit", &DiskFile::Unparseable),
            SaveAction::Conflict
        );
    }

    #[test]
    fn empty_lists_do_not_create_files_in_untouched_projects() {
        assert_eq!(
            plan_file_save("old", EMPTY_LIST, &DiskFile::Missing),
            SaveAction::Skip
        );
        assert_eq!(
            plan_file_save(EMPTY_LIST, "edit", &DiskFile::Missing),
            SaveAction::Write
        );
    }

    #[test]
    fn new_project_files_are_written_and_the_folder_is_created() {
        let dir = tempfile::tempdir().unwrap();
        let variables = to_json(&vec!["a|text|".to_string()]).unwrap();
        save_project_files(
            "new-project",
            dir.path(),
            EMPTY_LIST.to_string(),
            variables.clone(),
        )
        .unwrap();
        let data_root = dir.path().join(".taskproxy");
        assert_eq!(
            fs::read_to_string(data_root.join(VARIABLES_FILE)).unwrap(),
            variables
        );
        assert!(!data_root.join(NAVIGATION_FILE).exists());
    }

    #[test]
    fn untouched_project_gets_no_taskproxy_folder() {
        let dir = tempfile::tempdir().unwrap();
        save_project_files(
            "untouched",
            dir.path(),
            EMPTY_LIST.to_string(),
            EMPTY_LIST.to_string(),
        )
        .unwrap();
        assert!(!dir.path().join(".taskproxy").exists());
    }

    #[test]
    fn conflicted_file_is_left_untouched_and_reports_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let data_root = dir.path().join(".taskproxy");
        fs::create_dir_all(&data_root).unwrap();
        let conflicted = "<<<<<<< HEAD\n[]\n=======\n[]\n>>>>>>> other\n";
        fs::write(data_root.join(VARIABLES_FILE), conflicted).unwrap();
        let (_, variables) = load_project_files("conflicted", dir.path());
        assert!(variables.is_empty());
        save_project_files(
            "conflicted",
            dir.path(),
            EMPTY_LIST.to_string(),
            EMPTY_LIST.to_string(),
        )
        .unwrap();
        let edited = to_json(&vec!["a|text|".to_string()]).unwrap();
        assert!(
            save_project_files("conflicted", dir.path(), EMPTY_LIST.to_string(), edited).is_err()
        );
        assert_eq!(
            fs::read_to_string(data_root.join(VARIABLES_FILE)).unwrap(),
            conflicted
        );
    }

    #[test]
    fn reload_picks_up_pulled_changes_but_keeps_unsaved_edits() {
        let dir = tempfile::tempdir().unwrap();
        let data_root = dir.path().join(".taskproxy");
        fs::create_dir_all(&data_root).unwrap();
        fs::write(data_root.join(VARIABLES_FILE), r#"["a|text|"]"#).unwrap();
        let (_, variables) = load_project_files("reload", dir.path());
        let mut data = ProjectData::new();
        data.id = "reload".to_string();
        data.path = dir.path().to_string_lossy().into_owned();
        data.variables = variables;
        fs::write(data_root.join(VARIABLES_FILE), r#"["pulled|text|"]"#).unwrap();
        let reloaded = reload_files_from_disk(data.clone());
        assert_eq!(reloaded.variables, ["pulled|text|"]);
        let mut edited = reloaded;
        edited.variables = vec!["edit|text|".to_string()];
        fs::write(data_root.join(VARIABLES_FILE), r#"["again|text|"]"#).unwrap();
        assert_eq!(reload_files_from_disk(edited).variables, ["edit|text|"]);
    }

    #[test]
    fn project_files_are_read_from_inside_the_project() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".taskproxy/pages")).unwrap();
        fs::write(dir.path().join(".taskproxy/pages/a.md"), "# A").unwrap();
        assert_eq!(
            read_project_file(dir.path(), ".taskproxy/pages/a.md").unwrap(),
            "# A"
        );
        assert_eq!(
            read_project_file(dir.path(), ".taskproxy\\pages\\a.md").unwrap(),
            "# A"
        );
    }

    #[test]
    fn a_missing_file_reports_the_error_the_frontend_expects() {
        let dir = tempfile::tempdir().unwrap();
        let err = read_project_file(dir.path(), "missing.md").unwrap_err();
        assert!(err.ends_with("File not found"));
        fs::create_dir_all(dir.path().join("folder.md")).unwrap();
        assert!(
            read_project_file(dir.path(), "folder.md")
                .unwrap_err()
                .ends_with("File not found")
        );
    }

    #[test]
    fn a_file_that_is_not_text_reports_a_different_error() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("bin.md"), b"\xFF\xFE").unwrap();
        let err = read_project_file(dir.path(), "bin.md").unwrap_err();
        assert!(!err.contains("File not found"));
    }

    #[test]
    fn paths_that_leave_the_project_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        fs::create_dir_all(&root).unwrap();
        fs::write(dir.path().join("secret.md"), "x").unwrap();
        for path in ["../secret.md", "/etc/passwd", "a/../../secret.md", ""] {
            assert!(read_project_file(&root, path).is_err(), "{}", path);
            assert!(write_project_file(&root, path, "x").is_err(), "{}", path);
        }
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_links_cannot_reach_outside_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(dir.path().join("outside")).unwrap();
        fs::write(dir.path().join("outside/secret.md"), "x").unwrap();
        std::os::unix::fs::symlink(dir.path().join("outside"), root.join("link")).unwrap();
        assert!(read_project_file(&root, "link/secret.md").is_err());
        assert!(write_project_file(&root, "link/new.md", "x").is_err());
        assert!(!dir.path().join("outside/new.md").exists());
    }

    #[test]
    fn saving_creates_folders_and_ends_with_a_newline() {
        let dir = tempfile::tempdir().unwrap();
        write_project_file(dir.path(), ".taskproxy/pages/new.md", "# New").unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join(".taskproxy/pages/new.md")).unwrap(),
            "# New\n"
        );
        write_project_file(dir.path(), "kept.md", "line\n").unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("kept.md")).unwrap(),
            "line\n"
        );
    }

    #[test]
    fn saving_replaces_the_whole_file_and_leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "a much longer original file\n").unwrap();
        write_project_file(dir.path(), "a.md", "short").unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("a.md")).unwrap(),
            "short\n"
        );
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(names, ["a.md"]);
    }

    #[test]
    fn saving_inside_git_or_without_an_extension_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        for path in [
            ".git/hooks/pre-commit.sh",
            "sub/.GIT/config.txt",
            "no_extension",
        ] {
            assert!(
                write_project_file(dir.path(), path, "x").is_err(),
                "{}",
                path
            );
        }
        assert!(!dir.path().join(".git").exists());
    }

    #[test]
    fn docs_are_found_sorted_and_with_forward_slashes() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("docs/deep")).unwrap();
        fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        fs::create_dir_all(dir.path().join(".taskproxy/pages")).unwrap();
        for file in [
            "README.md",
            "docs/deep/b.MD",
            "docs/a.md",
            "notes.txt",
            "node_modules/pkg/x.md",
            ".taskproxy/pages/p.md",
        ] {
            fs::write(dir.path().join(file), "x").unwrap();
        }
        assert_eq!(
            get_project_docs(dir.path().to_str().unwrap()),
            ["README.md", "docs/a.md", "docs/deep/b.MD"]
        );
    }

    #[test]
    fn wildcards_match_names() {
        for (pattern, text, expected) in [
            ("*", "anything", true),
            ("*.ps1", "build.ps1", true),
            ("*.ps1", "build.ps1.bak", false),
            ("build*", "build.ps1", true),
            ("b*d*.ps1", "build.ps1", true),
            ("b*x*", "build", false),
            ("exact.txt", "exact.txt", true),
            ("exact.txt", "other.txt", false),
            ("a*a", "a", false),
            ("*é*", "café.txt", true),
        ] {
            assert_eq!(
                wildcard_match(pattern, text),
                expected,
                "{} {}",
                pattern,
                text
            );
        }
    }

    #[test]
    fn searches_match_file_names_or_paths_and_skip_build_output() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("scripts")).unwrap();
        fs::create_dir_all(dir.path().join("bin")).unwrap();
        for file in ["scripts/a.ps1", "b.ps1", "bin/c.ps1", "d.txt"] {
            fs::write(dir.path().join(file), "x").unwrap();
        }
        let search = |patterns: &[&str]| {
            let patterns: Vec<String> = patterns.iter().map(|p| p.to_string()).collect();
            let mut results = Vec::new();
            collect_filtered_files(dir.path(), &patterns, "", &mut results);
            let mut values: Vec<String> = results.into_iter().map(|r| r.value).collect();
            values.sort();
            values
        };
        assert_eq!(search(&["*.ps1"]), ["b.ps1", "scripts/a.ps1"]);
        assert_eq!(search(&["scripts/*"]), ["scripts/a.ps1"]);
        assert_eq!(search(&["*.txt", "b.*"]), ["b.ps1", "d.txt"]);
    }

    #[test]
    fn display_formats_fill_in_parts_of_the_path() {
        let path = Path::new("scripts/deploy.ps1");
        assert_eq!(
            format_option_display(path, "scripts/deploy.ps1", ""),
            "scripts/deploy.ps1"
        );
        assert_eq!(
            format_option_display(
                path,
                "scripts/deploy.ps1",
                "[file] ([ext]) in [parent] = [path]"
            ),
            "deploy (ps1) in scripts = scripts/deploy"
        );
        assert_eq!(
            format_option_display(Path::new("top.ps1"), "top.ps1", "[path]"),
            "top"
        );
    }

    #[test]
    fn projects_sort_by_name_ignoring_case() {
        let mut projects = vec![
            Project::new("beta", "/b"),
            Project::new("Alpha", "/a"),
            Project::new("gamma", "/g"),
        ];
        sort_projects(&mut projects);
        let names: Vec<&str> = projects.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["Alpha", "beta", "gamma"]);
    }
}
