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
        collect_scripts(&root, &root, &mut scripts);
        scripts
    })
    .await;
    result.map_err(|err| format!("Failed to scan scripts: {}", err))
}

fn collect_scripts(current_path: &Path, root: &Path, scripts: &mut Vec<String>) {
    const IGNORED_DIRS: &[&str] = &["target", "dist", "build", "node_modules", ".git"];
    if let Ok(entries) = fs::read_dir(current_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if path.file_name().map_or(false, |name| {
                    let name_str = name.to_string_lossy();
                    IGNORED_DIRS.contains(&name_str.as_ref())
                }) {
                    continue;
                }
                collect_scripts(&path, root, scripts);
            } else if path
                .extension()
                .map_or(false, |ext| ext.eq_ignore_ascii_case("ps1"))
            {
                if let Ok(relative_path) = path.strip_prefix(root) {
                    scripts.push(relative_path.to_string_lossy().into_owned());
                }
            }
        }
    }
}
