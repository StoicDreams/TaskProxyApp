use crate::prelude::*;

#[tauri::command]
pub(crate) async fn git_push(
    repo: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let project_path = {
        let project_state = state
            .lock()
            .map_err(|err| format!("get_uncommitted_changes State failure: {}", err))?;
        let project = project_state.to_owned();
        if project.path.is_empty() {
            return Err(String::from(
                "get_uncommitted_changes path failure: Project not loaded.",
            ));
        }
        project.path
    };
    let mut git_path = PathBuf::from(project_path);
    git_path.push(repo);
    let result = task::spawn_blocking(move || {
        let repo_path = &git_path.to_string_lossy();
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(&git_path).arg("push");
        if !has_upstream(repo_path) {
            let branch = Command::new("git")
                .arg("-C")
                .arg(&git_path)
                .arg("rev-parse")
                .arg("--abbrev-ref")
                .arg("HEAD")
                .output()
                .map_err(|err| err.to_string())?;
            let branch_name = String::from_utf8_lossy(&branch.stdout).trim().to_string();
            cmd.arg("--set-upstream").arg("origin").arg(&branch_name);
        } else {
            let current_branch = get_current_branch(repo_path)?;
            cmd.arg("origin").arg(&current_branch);
        }
        let output = cmd.output().map_err(|err| err.to_string())?;
        if output.status.success() {
            let result = String::from_utf8_lossy(&output.stdout).to_string();
            if result.is_empty() {
                Ok(String::from("Push Successful"))
            } else {
                Ok(result)
            }
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        }
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_pull(
    repo: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let project_path = {
        let project_state = state
            .lock()
            .map_err(|err| format!("get_uncommitted_changes State failure: {}", err))?;
        let project = project_state.to_owned();
        if project.path.is_empty() {
            return Err(String::from(
                "get_uncommitted_changes path failure: Project not loaded.",
            ));
        }
        project.path
    };
    let mut git_path = PathBuf::from(project_path);
    git_path.push(repo);
    if !has_upstream(&git_path.to_string_lossy()) {
        return Ok(String::from(
            "Nothing to pull: Branch does not have a remote.",
        ));
    }
    let result = task::spawn_blocking(move || {
        let repo_path = &git_path.to_string_lossy();
        let current_branch = get_current_branch(repo_path)?;
        let output = Command::new("git")
            .arg("-C")
            .arg(&git_path)
            .arg("pull")
            .arg("origin")
            .arg(&current_branch)
            .output()
            .map_err(|e| e.to_string())?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        }
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_sync(
    repo: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let pull = git_pull(repo.clone(), state.clone()).await?;
    let push = git_push(repo.clone(), state.clone()).await?;
    Ok(format!("{}\n{}", pull, push))
}

#[tauri::command]
pub(crate) async fn git_commit(
    repo: String,
    files: Vec<String>,
    message: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let project_path = {
        let project_state = state
            .lock()
            .map_err(|err| format!("get_uncommitted_changes State failure: {}", err))?;
        let project = project_state.to_owned();
        if project.path.is_empty() {
            return Err(String::from(
                "get_uncommitted_changes path failure: Project not loaded.",
            ));
        }
        project.path
    };
    let mut git_path = PathBuf::from(project_path);
    git_path.push(repo);
    let result = task::spawn_blocking(move || {
        for file in &files {
            let output = Command::new("git")
                .arg("-C")
                .arg(&git_path)
                .arg("add")
                .arg(file)
                .output()
                .map_err(|e| e.to_string())?;

            if !output.status.success() {
                return Err(format!(
                    "Failed to add file '{}': {}",
                    file,
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
        }
        let commit = Command::new("git")
            .arg("-C")
            .arg(&git_path)
            .arg("commit")
            .arg("-m")
            .arg(message)
            .output()
            .map_err(|err| err.to_string())?;

        if commit.status.success() {
            Ok(String::from_utf8_lossy(&commit.stdout).to_string())
        } else {
            Err(String::from_utf8_lossy(&commit.stderr).to_string())
        }
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn get_git_repos(state: State<'_, CurrentProject>) -> Result<Vec<String>, String> {
    let project_path = {
        let project_state = state
            .lock()
            .map_err(|err| format!("get_uncommitted_changes State failure: {}", err))?;
        let project = project_state.to_owned();
        if project.path.is_empty() {
            return Err(String::from(
                "get_uncommitted_changes path failure: Project not loaded.",
            ));
        }
        project.path
    };
    Ok(find_git_repos(&project_path))
}

#[tauri::command]
pub(crate) async fn get_git_changes(
    path: String,
    state: State<'_, CurrentProject>,
) -> Result<Vec<String>, String> {
    let project_path = {
        let project_state = state
            .lock()
            .map_err(|err| format!("get_uncommitted_changes State failure: {}", err))?;
        let project = project_state.to_owned();
        if project.path.is_empty() {
            return Err(String::from(
                "get_uncommitted_changes path failure: Project not loaded.",
            ));
        }
        project.path
    };
    let mut git_path = PathBuf::from(project_path);
    git_path.push(path);
    let git_root = git_path.to_string_lossy().into_owned();
    let result = task::spawn_blocking(move || {
        let output = Command::new("git")
            .arg("-C")
            .arg(&git_root)
            .arg("status")
            .arg("--porcelain")
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).into_owned());
        }
        let mut files = vec![];
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let prefix = &line[0..3];
            let file = line[3..].to_owned();
            let mut path = git_path.to_owned();
            path.push(file);
            if path.is_dir() {
                let sub_files = get_files_from_dir(&path);
                for sub_file in sub_files {
                    let sf_path = PathBuf::from(sub_file);
                    if let Ok(sub_file) = sf_path.strip_prefix(&git_path) {
                        let sub_file = sub_file.to_string_lossy().into_owned();
                        files.push(format!("{}{}", prefix, sub_file));
                    }
                }
            } else {
                files.push(line.to_string());
            }
        }
        Ok(files)
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

fn has_upstream(repo_path: &str) -> bool {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .arg("rev-parse")
        .arg("--abbrev-ref")
        .arg("--symbolic-full-name")
        .arg("@{u}")
        .output();

    match output {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}

fn get_current_branch(repo_path: &str) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .arg("branch")
        .arg("--show-current")
        .output()
        .map_err(|err| err.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

fn get_files_from_dir(path: &PathBuf) -> Vec<String> {
    let mut files = vec![];
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            if entry_path.is_dir() {
                for sub_file in get_files_from_dir(&entry_path) {
                    files.push(sub_file);
                }
            }
            if entry_path.is_file() {
                files.push(entry_path.as_path().to_string_lossy().to_string());
            }
        }
    }
    files
}

#[tauri::command]
pub(crate) fn get_git_file_diff(
    repo: String,
    file: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let project_path = {
        let project_state = state
            .lock()
            .map_err(|err| format!("get_uncommitted_changes State failure: {}", err))?;
        let project = project_state.to_owned();
        if project.path.is_empty() {
            return Err(String::from(
                "get_uncommitted_changes path failure: Project not loaded.",
            ));
        }
        project.path
    };
    let mut git_path = PathBuf::from(project_path);
    if !repo.is_empty() {
        git_path.push(repo);
    }
    let git_path = git_path.to_string_lossy().into_owned();
    let output = Command::new("git")
        .arg("-C")
        .arg(git_path)
        .arg("diff")
        .arg("--")
        .arg(file)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn find_git_repos(root: &str) -> Vec<String> {
    let mut results = Vec::new();
    let path = PathBuf::from(root);
    find_git_repos_recursive(root, &path, &mut results);
    results
}

fn find_git_repos_recursive(root: &str, path: &PathBuf, results: &mut Vec<String>) {
    if !path.is_dir() {
        return;
    }
    let git_path = path.join(".git");
    if git_path.is_dir() {
        if let Ok(rel_path) = path.strip_prefix(root) {
            results.push(rel_path.to_string_lossy().to_string());
        }
        return;
    }
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            if entry_path.is_dir() {
                find_git_repos_recursive(root, &entry_path, results);
            }
        }
    }
}
