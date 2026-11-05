use crate::prelude::*;

#[tauri::command]
pub(crate) async fn get_scripts(state: State<'_, CurrentProject>) -> Result<Vec<String>, String> {
    let project_path = {
        let project_state = state
            .lock()
            .map_err(|err| format!("get_scripts State failure: {}", err))?;
        if project_state.path.is_empty() {
            return Err(String::from("Project not loaded."));
        }
        project_state.path.clone()
    };
    let root = PathBuf::from(&project_path);
    let mut scripts = Vec::new();
    let result = task::spawn_blocking(move || {
        collect_scripts(&root, &mut scripts);
        scripts
    })
    .await;
    result.map_err(|err| format!("Failed to scan scripts: {}", err))
}

fn collect_scripts(root: &Path, scripts: &mut Vec<String>) {
    walk_project_files(root, COMMON_SKIP_DIRS, |path| {
        let is_script = path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("ps1"));
        let is_temp = path.file_name().is_some_and(|name| {
            let name = name.to_string_lossy();
            name.starts_with("taskproxy_tmp_") || name.starts_with("taskproxy_live_")
        });
        if is_script && !is_temp {
            if let Ok(relative_path) = path.strip_prefix(root) {
                scripts.push(relative_path.to_string_lossy().into_owned());
            }
        }
    });
    scripts.sort();
}
