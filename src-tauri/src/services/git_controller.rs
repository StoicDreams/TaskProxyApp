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
        if files.is_empty() {
            return Err(String::from("No files provided to commit."));
        }
        let output = Command::new("git")
            .arg("-C")
            .arg(&git_path)
            .arg("add")
            .args(&files)
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            return Err(format!(
                "Failed to add files: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
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
            .arg("-uall")
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).into_owned());
        }
        let mut files = vec![];
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            files.push(line.to_string());
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
    // TODO: Make this extendable through a config file setting.
    const IGNORED_DIRS: &[&str] = &[
        "node_modules",
        "target",
        "dist",
        "build",
        ".taskproxy",
        ".vscode",
        ".git",
        ".github"
    ];
    if let Some(dir_name) = path.file_name().and_then(|n| n.to_str()) {
        if IGNORED_DIRS.contains(&dir_name) {
            return;
        }
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
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitBranchInfo {
    pub branches: Vec<String>,
    pub current_branch: String,
}

#[tauri::command]
pub(crate) async fn get_git_branches(
    repo: String,
    state: State<'_, CurrentProject>,
) -> Result<GitBranchInfo, String> {
    let project_path = {
        let project_state = state
            .lock()
            .map_err(|err| format!("get_git_branches State failure: {}", err))?;
        let project = project_state.to_owned();
        if project.path.is_empty() {
            return Err(String::from("get_git_branches path failure: Project not loaded."));
        }
        project.path
    };
    let mut git_path = PathBuf::from(project_path);
    if !repo.is_empty() { git_path.push(repo); }
    let result = task::spawn_blocking(move || {
        let output = Command::new("git")
            .arg("-C").arg(&git_path)
            .arg("branch")
            .output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).into_owned());
        }
        let mut branches = Vec::new();
        let mut current_branch = String::new();
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let trimmed = line.trim();
            if trimmed.starts_with('*') {
                let b = trimmed[1..].trim().to_string();
                current_branch = b.clone();
                branches.push(b);
            } else {
                branches.push(trimmed.to_string());
            }
        }
        Ok(GitBranchInfo { branches, current_branch })
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_switch_branch(
    repo: String,
    branch: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let project_path = {
        let project_state = state.lock().map_err(|err| format!("git_switch_branch State failure: {}", err))?;
        if project_state.path.is_empty() { return Err(String::from("Project not loaded.")); }
        project_state.path.clone()
    };
    let mut git_path = PathBuf::from(project_path);
    if !repo.is_empty() { git_path.push(repo); }
    let result = task::spawn_blocking(move || {
        let output = Command::new("git")
            .arg("-C").arg(&git_path)
            .arg("switch").arg(&branch)
            .output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).into_owned());
        }
        Ok(String::from("Branch switched successfully."))
    }).await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_create_branch(
    repo: String,
    branch: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let project_path = {
        let project_state = state.lock().map_err(|err| format!("git_create_branch State failure: {}", err))?;
        if project_state.path.is_empty() { return Err(String::from("Project not loaded.")); }
        project_state.path.clone()
    };
    let mut git_path = PathBuf::from(project_path);
    if !repo.is_empty() { git_path.push(repo); }
    let result = task::spawn_blocking(move || {
        let output = Command::new("git")
            .arg("-C").arg(&git_path)
            .arg("checkout").arg("-b").arg(&branch)
            .output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).into_owned());
        }
        Ok(format!("Branch '{}' created.", branch))
    }).await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_delete_branch(
    repo: String,
    branch: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let project_path = {
        let project_state = state.lock().map_err(|err| format!("git_delete_branch State failure: {}", err))?;
        if project_state.path.is_empty() { return Err(String::from("Project not loaded.")); }
        project_state.path.clone()
    };
    let mut git_path = PathBuf::from(project_path);
    if !repo.is_empty() { git_path.push(repo); }
    let result = task::spawn_blocking(move || {
        let output = Command::new("git")
            .arg("-C").arg(&git_path)
            .arg("branch").arg("-D").arg(&branch)
            .output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).into_owned());
        }
        Ok(format!("Branch '{}' deleted.", branch))
    }).await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_merge_branch(
    repo: String,
    branch: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let project_path = {
        let project_state = state.lock().map_err(|err| format!("git_merge_branch State failure: {}", err))?;
        if project_state.path.is_empty() { return Err(String::from("Project not loaded.")); }
        project_state.path.clone()
    };
    let mut git_path = PathBuf::from(project_path);
    if !repo.is_empty() { git_path.push(repo); }
    let result = task::spawn_blocking(move || {
        let output = Command::new("git")
            .arg("-C").arg(&git_path)
            .arg("merge").arg(&branch)
            .output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).into_owned());
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }).await;
    result.map_err(|err| format!("{}", err))?
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitRemoteStatus {
    pub has_upstream: bool,
    pub upstream_name: String,
    pub ahead: u32,
    pub behind: u32,
    pub remote_url: String,
}

#[tauri::command]
pub(crate) async fn get_git_remote_status(
    repo: String,
    state: State<'_, CurrentProject>,
) -> Result<GitRemoteStatus, String> {
    let project_path = {
        let project_state = state.lock().map_err(|err| format!("State failure: {}", err))?;
        if project_state.path.is_empty() { return Err(String::from("Project not loaded.")); }
        project_state.path.clone()
    };
    let mut git_path = PathBuf::from(project_path);
    if !repo.is_empty() { git_path.push(repo); }
    let result = task::spawn_blocking(move || -> Result<GitRemoteStatus, String> {
        let git_path_str = git_path.to_string_lossy().into_owned();
        let mut remote_url = String::new();
        if let Ok(output) = Command::new("git").arg("-C").arg(&git_path_str).arg("config").arg("--get").arg("remote.origin.url").output() {
            remote_url = String::from_utf8_lossy(&output.stdout).trim().to_string();
        }
        let mut upstream_name = String::new();
        if let Ok(output) = Command::new("git").arg("-C").arg(&git_path_str).arg("rev-parse").arg("--abbrev-ref").arg("--symbolic-full-name").arg("@{u}").output() {
            if output.status.success() {
                upstream_name = String::from_utf8_lossy(&output.stdout).trim().to_string();
            }
        }
        let has_upstream = !upstream_name.is_empty();
        let mut ahead = 0;
        let mut behind = 0;
        if has_upstream {
            if let Ok(output) = Command::new("git").arg("-C").arg(&git_path_str).arg("rev-list").arg("--left-right").arg("--count").arg("HEAD...@{u}").output() {
                if output.status.success() {
                    let counts = String::from_utf8_lossy(&output.stdout);
                    let parts: Vec<&str> = counts.trim().split_whitespace().collect();
                    if parts.len() == 2 {
                        ahead = parts[0].parse().unwrap_or(0);
                        behind = parts[1].parse().unwrap_or(0);
                    }
                }
            }
        }
        Ok(GitRemoteStatus { has_upstream, upstream_name, ahead, behind, remote_url })
    }).await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_fetch(
    repo: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let project_path = {
        let project_state = state.lock().map_err(|err| format!("State failure: {}", err))?;
        if project_state.path.is_empty() { return Err(String::from("Project not loaded.")); }
        project_state.path.clone()
    };
    let mut git_path = PathBuf::from(project_path);
    if !repo.is_empty() { git_path.push(repo); }
    let result = task::spawn_blocking(move || {
        let output = Command::new("git")
            .arg("-C").arg(&git_path)
            .arg("fetch")
            .output().map_err(|e| e.to_string())?;
        if output.status.success() {
            Ok(String::from("Fetch successful. Remote data is up to date."))
        } else {
            Err(String::from_utf8_lossy(&output.stderr).into_owned())
        }
    }).await;
    result.map_err(|err| format!("{}", err))?
}