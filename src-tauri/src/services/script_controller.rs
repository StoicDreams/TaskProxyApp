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
                // The frontend compares these paths, and joins them with forward slashes.
                scripts.push(relative_path.to_string_lossy().replace('\\', "/"));
            }
        }
    });
    scripts.sort();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripts_are_found_sorted_and_with_forward_slashes() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("sub/deep")).unwrap();
        for file in ["z.ps1", "A.PS1", "sub/deep/b.ps1", "notes.txt"] {
            fs::write(dir.path().join(file), "x").unwrap();
        }
        let mut scripts = Vec::new();
        collect_scripts(dir.path(), &mut scripts);
        assert_eq!(scripts, ["A.PS1", "sub/deep/b.ps1", "z.ps1"]);
    }

    #[test]
    fn temp_scripts_build_output_and_ignored_files_are_left_out() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("target")).unwrap();
        fs::create_dir_all(dir.path().join("generated")).unwrap();
        fs::write(dir.path().join(".gitignore"), "generated/\n").unwrap();
        for file in [
            "keep.ps1",
            "taskproxy_tmp_1_a.ps1",
            "taskproxy_live_1.ps1",
            "target/build.ps1",
            "generated/made.ps1",
        ] {
            fs::write(dir.path().join(file), "x").unwrap();
        }
        let mut scripts = Vec::new();
        collect_scripts(dir.path(), &mut scripts);
        assert_eq!(scripts, ["keep.ps1"]);
    }
}
