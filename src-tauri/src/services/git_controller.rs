use crate::prelude::*;
use git2::{Cred, FetchOptions, PushOptions, RemoteCallbacks, Repository, build::CheckoutBuilder};
use std::path::{Path, PathBuf};

fn get_repo_path(state: &State<'_, CurrentProject>, repo: &str) -> Result<PathBuf, String> {
    let project_state = state
        .lock()
        .map_err(|err| format!("State failure: {}", err))?;
    if project_state.path.is_empty() {
        return Err(String::from("Project not loaded."));
    }
    let mut path = PathBuf::from(&project_state.path);
    if !repo.is_empty() {
        path.push(repo);
    }
    Ok(path)
}

fn get_git_credentials(app_handle: &AppHandle) -> Option<String> {
    let pat_keys = ["git_pat", "github_pat"];
    if let Ok(project_state) = crate::appdata::get_state_data::<ProjectData>(app_handle) {
        for key in &pat_keys {
            if let Some(val) = project_state.data.get(*key) {
                if let Some(token) = val.as_str() {
                    if !token.is_empty() {
                        return Some(token.to_string());
                    }
                }
            }
        }
    }
    if let Ok(global_state) = crate::appdata::get_state_data::<TaskProxyData>(app_handle) {
        for key in &pat_keys {
            if let Some(val) = global_state.data.get(*key) {
                if let Some(token) = val.as_str() {
                    if !token.is_empty() {
                        return Some(token.to_string());
                    }
                }
            }
        }
    }
    None
}

/// Helper to construct Git2 remote callbacks for authentication injections.
fn create_remote_callbacks<'a>(app_handle: AppHandle) -> RemoteCallbacks<'a> {
    let mut callbacks = RemoteCallbacks::new();
    callbacks.credentials(move |_url, username_from_url, _allowed_types| {
        if let Some(token) = get_git_credentials(&app_handle) {
            Cred::userpass_plaintext(username_from_url.unwrap_or("git"), &token)
        } else {
            Err(git2::Error::from_str(
                "Credentials Missing/Invalid: No PAT stored",
            ))
        }
    });
    callbacks
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitBranchDetail {
    pub name: String,
    pub is_current: bool,
    pub created_date: String,
    pub updated_date: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitBranchInfo {
    pub branches: Vec<GitBranchDetail>,
    pub current_branch: String,
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
pub(crate) async fn git_push(
    repo: String,
    state: State<'_, CurrentProject>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let app_handle_clone = app_handle.clone();
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        let mut remote = repository
            .find_remote("origin")
            .map_err(|e| e.to_string())?;
        let head = repository.head().map_err(|e| e.to_string())?;
        let branch_name = head.shorthand().ok_or("Invalid branch name")?;
        let refspec = format!("refs/heads/{}:refs/heads/{}", branch_name, branch_name);
        let callbacks = create_remote_callbacks(app_handle_clone);
        let mut push_options = PushOptions::new();
        push_options.remote_callbacks(callbacks);
        remote
            .push(&[&refspec], Some(&mut push_options))
            .map_err(|e| {
                if e.message().contains("Credentials Missing/Invalid") {
                    String::from("Credentials Missing/Invalid")
                } else {
                    e.to_string()
                }
            })?;
        Ok(String::from("Push Successful"))
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_pull(
    repo: String,
    state: State<'_, CurrentProject>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let app_handle_clone = app_handle.clone();
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        let mut remote = repository
            .find_remote("origin")
            .map_err(|e| e.to_string())?;
        let head = repository.head().map_err(|e| e.to_string())?;
        let branch_name = head.shorthand().ok_or("Invalid branch name")?;
        let callbacks = create_remote_callbacks(app_handle_clone);
        let mut fetch_options = FetchOptions::new();
        fetch_options.remote_callbacks(callbacks);
        remote
            .fetch(&[branch_name], Some(&mut fetch_options), None)
            .map_err(|e| {
                if e.message().contains("Credentials Missing/Invalid") {
                    String::from("Credentials Missing/Invalid")
                } else {
                    e.to_string()
                }
            })?;
        let fetch_head = repository
            .find_reference("FETCH_HEAD")
            .map_err(|e| e.to_string())?;
        let fetch_commit = repository
            .reference_to_annotated_commit(&fetch_head)
            .map_err(|e| e.to_string())?;
        let analysis = repository
            .merge_analysis(&[&fetch_commit])
            .map_err(|e| e.to_string())?;
        if analysis.0.is_up_to_date() {
            Ok(String::from("Already up to date."))
        } else if analysis.0.is_fast_forward() {
            let mut reference = repository
                .find_reference(&format!("refs/heads/{}", branch_name))
                .map_err(|e| e.to_string())?;
            reference
                .set_target(fetch_commit.id(), "Fast-Forward")
                .map_err(|e| e.to_string())?;
            repository
                .set_head(&format!("refs/heads/{}", branch_name))
                .map_err(|e| e.to_string())?;
            repository
                .checkout_head(Some(CheckoutBuilder::default().force()))
                .map_err(|e| e.to_string())?;
            Ok(String::from("Fast-forward pull successful."))
        } else {
            Err(String::from(
                "Normal merge required, fast-forward not possible. (Not implemented in basic pull)",
            ))
        }
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_pull_overwrite(
    repo: String,
    state: State<'_, CurrentProject>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let app_handle_clone = app_handle.clone();
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        let mut remote = repository
            .find_remote("origin")
            .map_err(|e| e.to_string())?;
        let head = repository.head().map_err(|e| e.to_string())?;
        let branch_name = head.shorthand().ok_or("Invalid branch name")?;
        let callbacks = create_remote_callbacks(app_handle_clone);
        let mut fetch_options = FetchOptions::new();
        fetch_options.remote_callbacks(callbacks);
        remote
            .fetch(&[branch_name], Some(&mut fetch_options), None)
            .map_err(|e| {
                if e.message().contains("Credentials Missing/Invalid") {
                    String::from("Credentials Missing/Invalid")
                } else {
                    e.to_string()
                }
            })?;
        let fetch_head_name = format!("refs/remotes/origin/{}", branch_name);
        let fetch_commit = repository
            .find_reference(&fetch_head_name)
            .map_err(|e| e.to_string())?
            .peel_to_commit()
            .map_err(|e| e.to_string())?;
        let mut checkout_builder = git2::build::CheckoutBuilder::new();
        checkout_builder.force();
        repository
            .reset(
                fetch_commit.as_object(),
                git2::ResetType::Hard,
                Some(&mut checkout_builder),
            )
            .map_err(|e| e.to_string())?;

        Ok(format!(
            "Successfully pulled and overwrote local branch '{}'",
            branch_name
        ))
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_sync(
    repo: String,
    state: State<'_, CurrentProject>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let pull = git_pull(repo.clone(), state.clone(), app_handle.clone()).await?;
    let push = git_push(repo.clone(), state.clone(), app_handle.clone()).await?;
    Ok(format!("{}\n{}", pull, push))
}

#[tauri::command]
pub(crate) async fn git_commit(
    repo: String,
    files: Vec<String>,
    message: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let result = task::spawn_blocking(move || {
        if files.is_empty() {
            return Err(String::from("No files provided to commit."));
        }
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        let mut index = repository.index().map_err(|e| e.to_string())?;
        for file in files {
            let file_path = Path::new(&file);
            if git_path.join(file_path).exists() {
                index
                    .add_path(file_path)
                    .map_err(|e| format!("Failed to add file: {}", e))?;
            } else {
                index
                    .remove_path(file_path)
                    .map_err(|e| format!("Failed to remove file: {}", e))?;
            }
        }
        index.write().map_err(|e| e.to_string())?;
        let oid = index.write_tree().map_err(|e| e.to_string())?;
        let signature = repository
            .signature()
            .or_else(|_| git2::Signature::now("Task Proxy User", "user@taskproxy.local"))
            .map_err(|e| e.to_string())?;
        let parent_commit = match repository.head() {
            Ok(head) => Some(head.peel_to_commit().map_err(|e| e.to_string())?),
            Err(_) => None,
        };
        let tree = repository.find_tree(oid).map_err(|e| e.to_string())?;
        let mut parents = Vec::new();
        if let Some(ref parent) = parent_commit {
            parents.push(parent);
        }
        repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                &message,
                &tree,
                &parents,
            )
            .map_err(|e| e.to_string())?;
        Ok(String::from("Commit successful."))
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn get_git_repos(state: State<'_, CurrentProject>) -> Result<Vec<String>, String> {
    let project_path = get_repo_path(&state, "")?;
    Ok(find_git_repos(&project_path.to_string_lossy()))
}

#[tauri::command]
pub(crate) async fn get_git_changes(
    path: String,
    state: State<'_, CurrentProject>,
) -> Result<Vec<String>, String> {
    let git_path = get_repo_path(&state, &path)?;
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        let mut options = git2::StatusOptions::new();
        options.include_untracked(true).recurse_untracked_dirs(true);
        let statuses = repository
            .statuses(Some(&mut options))
            .map_err(|e| e.to_string())?;
        let mut files = Vec::new();
        for entry in statuses.iter() {
            let status = entry.status();
            if status.is_ignored() {
                continue;
            }
            let mut status_str = String::with_capacity(2);
            if status.contains(git2::Status::INDEX_NEW) {
                status_str.push('A');
            } else if status.contains(git2::Status::INDEX_MODIFIED) {
                status_str.push('M');
            } else if status.contains(git2::Status::INDEX_DELETED) {
                status_str.push('D');
            } else if status.contains(git2::Status::INDEX_RENAMED) {
                status_str.push('R');
            } else {
                status_str.push(' ');
            }
            if status.contains(git2::Status::WT_NEW) {
                if status_str == " " {
                    status_str = "??".to_string();
                } else {
                    status_str.push('?');
                }
            } else if status.contains(git2::Status::WT_MODIFIED) {
                status_str.push('M');
            } else if status.contains(git2::Status::WT_DELETED) {
                status_str.push('D');
            } else if status.contains(git2::Status::WT_RENAMED) {
                status_str.push('R');
            } else if status_str != "??" {
                status_str.push(' ');
            }
            let path_val = if status.contains(git2::Status::INDEX_RENAMED)
                || status.contains(git2::Status::WT_RENAMED)
            {
                let old_path = entry
                    .head_to_index()
                    .and_then(|d| d.old_file().path().and_then(|p| p.to_str()))
                    .unwrap_or("");
                let new_path = entry.path().unwrap_or("");
                format!("{} -> {}", old_path, new_path)
            } else {
                entry.path().unwrap_or("").to_string()
            };
            files.push(format!("{} {}", status_str, path_val));
        }
        Ok(files)
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) fn get_git_file_diff(
    repo: String,
    file: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
    let tree = match repository.head() {
        Ok(head) => Some(head.peel_to_tree().map_err(|e| e.to_string())?),
        Err(_) => None,
    };
    let mut diff_opts = git2::DiffOptions::new();
    diff_opts.pathspec(&file);
    let diff = repository
        .diff_tree_to_workdir(tree.as_ref(), Some(&mut diff_opts))
        .map_err(|e| e.to_string())?;
    let mut diff_text = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        let origin = line.origin();
        if origin == '+' || origin == '-' || origin == ' ' {
            diff_text.push(origin);
        }
        if let Ok(content) = std::str::from_utf8(line.content()) {
            diff_text.push_str(content);
        }
        true
    })
    .map_err(|e| e.to_string())?;
    Ok(diff_text)
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
        ".github",
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

#[tauri::command]
pub(crate) async fn get_git_branches(
    repo: String,
    state: State<'_, CurrentProject>,
) -> Result<GitBranchInfo, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        let mut branches = Vec::new();
        let mut current_branch = String::new();
        let head = repository.head().ok();
        let head_name = head.as_ref().and_then(|h| h.name());
        let iterator = repository.branches(None).map_err(|e| e.to_string())?;
        for branch_res in iterator {
            if let Ok((branch, _branch_type)) = branch_res {
                if let Ok(Some(name)) = branch.name() {
                    let is_current = head_name == branch.get().name();
                    if is_current {
                        current_branch = name.to_string();
                    }
                    let mut created_date = String::new();
                    let mut updated_date = String::new();
                    if let Ok(commit) = branch.get().peel_to_commit() {
                        let time = commit.time();
                        if let Some(dt) = chrono::DateTime::from_timestamp(time.seconds(), 0) {
                            created_date = dt.format("%Y-%m-%d").to_string();
                            updated_date = created_date.clone();
                        }
                    }
                    branches.push(GitBranchDetail {
                        name: name.to_string(),
                        is_current,
                        created_date,
                        updated_date,
                    });
                }
            }
        }
        Ok(GitBranchInfo {
            branches,
            current_branch,
        })
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
    let git_path = get_repo_path(&state, &repo)?;
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        let mut checkout_builder = git2::build::CheckoutBuilder::default();
        checkout_builder.force();
        if let Ok(branch_obj) = repository.find_branch(&branch, git2::BranchType::Local) {
            let refname = branch_obj.get().name().unwrap();
            repository.set_head(refname).map_err(|e| e.to_string())?;
            repository
                .checkout_head(Some(&mut checkout_builder))
                .map_err(|e| e.to_string())?;
        } else if let Ok(branch_obj) = repository.find_branch(&branch, git2::BranchType::Remote) {
            let commit = branch_obj
                .get()
                .peel_to_commit()
                .map_err(|e| e.to_string())?;
            let local_name = branch.split('/').last().unwrap_or(&branch);
            let mut local_branch = repository
                .branch(local_name, &commit, false)
                .map_err(|e| e.to_string())?;
            if let Some(remote_name) = branch_obj.get().name() {
                let _ = local_branch.set_upstream(Some(remote_name));
            }
            let refname = local_branch.get().name().unwrap();
            repository.set_head(refname).map_err(|e| e.to_string())?;
            repository
                .checkout_head(Some(&mut checkout_builder))
                .map_err(|e| e.to_string())?;
        } else {
            return Err(format!("Branch not found: {}", branch));
        }
        Ok(String::from("Branch switched successfully."))
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_create_branch(
    repo: String,
    branch: String,
    base_branch: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        let target_commit = if !base_branch.is_empty() {
            let reference = repository
                .resolve_reference_from_short_name(&base_branch)
                .map_err(|e| format!("Base branch not found: {}", e))?;
            reference.peel_to_commit().map_err(|e| e.to_string())?
        } else {
            let head = repository.head().map_err(|e| e.to_string())?;
            head.peel_to_commit().map_err(|e| e.to_string())?
        };
        let new_branch = repository
            .branch(&branch, &target_commit, false)
            .map_err(|e| format!("Failed to create branch: {}", e))?;
        if let Some(name) = new_branch.get().name() {
            repository.set_head(name).map_err(|e| e.to_string())?;
            repository
                .checkout_head(Some(git2::build::CheckoutBuilder::default().force()))
                .map_err(|e| e.to_string())?;
        }
        Ok(format!("Branch '{}' created.", branch))
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_delete_branch(
    repo: String,
    branch: String,
    state: State<'_, CurrentProject>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let app_handle_clone = app_handle.clone();
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        if let Ok(mut local_branch) = repository.find_branch(&branch, git2::BranchType::Local) {
            local_branch
                .delete()
                .map_err(|e| format!("Failed to delete local branch: {}", e))?;
            return Ok(format!("Branch '{}' deleted.", branch));
        }
        if branch.contains('/') {
            let parts: Vec<&str> = branch.splitn(2, '/').collect();
            if parts.len() == 2 {
                let remote_name = parts[0];
                let remote_branch = parts[1];
                let mut remote = repository
                    .find_remote(remote_name)
                    .map_err(|e| e.to_string())?;
                let callbacks = create_remote_callbacks(app_handle_clone);
                let mut push_options = PushOptions::new();
                push_options.remote_callbacks(callbacks);
                remote
                    .push(
                        &[&format!(":refs/heads/{}", remote_branch)],
                        Some(&mut push_options),
                    )
                    .map_err(|e| e.to_string())?;
                return Ok(format!("Remote branch '{}' deleted.", branch));
            }
        }
        Err(format!(
            "Branch '{}' not found or could not be deleted.",
            branch
        ))
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_merge_branch(
    repo: String,
    branch: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        let reference = repository.resolve_reference_from_short_name(&branch).map_err(|e| e.to_string())?;
        let fetch_commit = reference.peel_to_commit().map_err(|e| e.to_string())?;
        let annotated_commit = repository.reference_to_annotated_commit(&reference).map_err(|e| e.to_string())?;
        let analysis = repository.merge_analysis(&[&annotated_commit]).map_err(|e| e.to_string())?;
        if analysis.0.is_up_to_date() {
            Ok(String::from("Already up to date."))
        } else if analysis.0.is_fast_forward() {
            let mut head_ref = repository.head().map_err(|e| e.to_string())?;
            head_ref.set_target(fetch_commit.id(), "Fast-Forward").map_err(|e| e.to_string())?;
            repository.checkout_head(Some(git2::build::CheckoutBuilder::default().force())).map_err(|e| e.to_string())?;
            Ok(String::from("Fast-forward merge successful."))
        } else {
            Err(String::from("Normal merge required, fast-forward not possible. (Not implemented in basic merge)"))
        }
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn get_git_remote_status(
    repo: String,
    state: State<'_, CurrentProject>,
    app_handle: AppHandle,
) -> Result<GitRemoteStatus, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let app_handle_clone = app_handle.clone();
    let result = task::spawn_blocking(move || -> Result<GitRemoteStatus, String> {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        let mut remote_url = String::new();
        let mut upstream_name = String::new();
        let mut has_upstream = false;
        let mut ahead = 0;
        let mut behind = 0;
        if let Ok(mut remote) = repository.find_remote("origin") {
            remote_url = remote.url().unwrap_or("").to_string();
            let callbacks = create_remote_callbacks(app_handle_clone);
            let mut fetch_options = FetchOptions::new();
            fetch_options.remote_callbacks(callbacks);
            let _ = remote.fetch(
                &["+refs/heads/*:refs/remotes/origin/*"],
                Some(&mut fetch_options),
                None,
            );
        }
        if let Ok(head) = repository.head() {
            if head.is_branch() {
                if let Some(branch_name) = head.shorthand() {
                    if let Ok(local_branch) =
                        repository.find_branch(branch_name, git2::BranchType::Local)
                    {
                        if let Ok(upstream) = local_branch.upstream() {
                            has_upstream = true;
                            upstream_name = upstream
                                .name()
                                .unwrap_or(Some(""))
                                .unwrap_or("")
                                .to_string();
                            let local_oid = local_branch.get().target().unwrap();
                            let upstream_oid = upstream.get().target().unwrap();
                            if let Ok((a, b)) =
                                repository.graph_ahead_behind(local_oid, upstream_oid)
                            {
                                ahead = a as u32;
                                behind = b as u32;
                            }
                        }
                    }
                }
            }
        }
        Ok(GitRemoteStatus {
            has_upstream,
            upstream_name,
            ahead,
            behind,
            remote_url,
        })
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_fetch(
    repo: String,
    state: State<'_, CurrentProject>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let app_handle_clone = app_handle.clone();
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        let mut remote = repository
            .find_remote("origin")
            .map_err(|e| e.to_string())?;
        let callbacks = create_remote_callbacks(app_handle_clone);
        let mut fetch_options = FetchOptions::new();
        fetch_options.remote_callbacks(callbacks);
        remote
            .fetch(
                &["+refs/heads/*:refs/remotes/origin/*"],
                Some(&mut fetch_options),
                None,
            )
            .map_err(|e| {
                if e.message().contains("Credentials Missing/Invalid") {
                    String::from("Credentials Missing/Invalid")
                } else {
                    e.to_string()
                }
            })?;
        Ok(String::from("Fetch successful. Remote data is up to date."))
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_stash(
    repo: String,
    message: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let result = task::spawn_blocking(move || {
        let mut repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        let signature = repository
            .signature()
            .or_else(|_| git2::Signature::now("Task Proxy User", "user@taskproxy.local"))
            .map_err(|e| e.to_string())?;
        let msg = if message.is_empty() {
            None
        } else {
            Some(message.as_str())
        };
        repository
            .stash_save2(&signature, msg, Some(git2::StashFlags::DEFAULT))
            .map_err(|e| e.to_string())?;
        Ok(String::from("Changes stashed successfully."))
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_stash_pop(
    repo: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let result = task::spawn_blocking(move || {
        let mut repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        let mut options = git2::StashApplyOptions::new();
        repository
            .stash_pop(0, Some(&mut options))
            .map_err(|e| e.to_string())?;
        Ok(String::from("Stash popped successfully."))
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_restore_file(
    repo: String,
    file: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        let mut checkout_builder = git2::build::CheckoutBuilder::new();
        checkout_builder.path(&file).force();
        repository
            .checkout_head(Some(&mut checkout_builder))
            .map_err(|e| e.to_string())?;
        if let Ok(head) = repository.head().and_then(|h| h.peel_to_commit()) {
            let _ = repository.reset_default(Some(head.as_object()), [file.as_str()]);
        }
        Ok(format!("Successfully reverted {}", file))
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_delete_file(
    repo: String,
    file: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        let mut index = repository.index().map_err(|e| e.to_string())?;
        let path = Path::new(&file);
        let _ = index.remove_path(path);
        index.write().map_err(|e| e.to_string())?;
        let target_path = git_path.join(path);
        if target_path.exists() {
            fs::remove_file(&target_path)
                .map_err(|e| format!("Failed to delete file {}: {}", file, e))?;
        } else {
            return Err(format!("File {} does not exist", file));
        }
        Ok(format!("Successfully deleted {}", file))
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_restore_all(
    repo: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        let mut checkout_builder = git2::build::CheckoutBuilder::new();
        checkout_builder.force();
        repository
            .checkout_head(Some(&mut checkout_builder))
            .map_err(|e| e.to_string())?;
        let mut status_opts = git2::StatusOptions::new();
        status_opts
            .include_untracked(true)
            .recurse_untracked_dirs(true);
        if let Ok(statuses) = repository.statuses(Some(&mut status_opts)) {
            for entry in statuses.iter() {
                if entry.status().contains(git2::Status::WT_NEW) {
                    if let Some(path_str) = entry.path() {
                        let target_path = git_path.join(path_str);
                        if target_path.is_dir() {
                            let _ = fs::remove_dir_all(&target_path);
                        } else {
                            let _ = fs::remove_file(&target_path);
                        }
                    }
                }
            }
        }
        Ok(String::from("All changes have been successfully reverted."))
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}
